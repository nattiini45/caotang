/**
 * Mock provider gateway — [provider-gateway.md §8](docs/architecture/provider-gateway.md).
 *
 * A deterministic, scriptable implementation of `ProviderGateway` used by Vitest
 * headless tests and Playwright runs. It meets the requirement
 * "mock provider importable headless".
 *
 * Guarantees:
 *  - same script + same request + same call index = same bytes (no clock, no
 *    randomness); `complete()` numbers its own calls so `nativeCall` ids are stable;
 *  - every stream that answers ends with exactly one terminal chunk carrying `finishReason`
 *    and `usage`, on normal completion, on a declared error finish, and on abort;
 *  - a native-mode response (`MockResponse.toolCalls`, which `nativeCall` produces)
 *    rides that terminal chunk with finishReason 'tool_calls', and its `reasoning` as a
 *    replayable block; `reasoning` without calls streams as a `reasoningDelta` first;
 *  - a scripted failure (`MockResponse.error`, which `fail(mode)` uses) raises a
 *    `ProviderError` of the §4 kind it names, before any output, as the real gateway does;
 *  - usage = ceil(chars/4) of the prompt and of the completion actually delivered, so
 *    an aborted stream reports only the tokens the consumer received (§3);
 *  - streaming yields with a real async gap, so consumers' async logic is exercised
 *    identically to live SSE;
 *  - `completeOnce` throws on an error finish rather than returning a truncated message.
 */

import { MOCK_BASE_URL } from '../base-url.js';
import { createManualClock } from '../clock.js';
import { providerMessages, ProviderError } from '../errors.js';
import { collectOnce } from '../once.js';
import { UsageLedger } from '../ledger.js';
import type {
  ChatChunk,
  ChatRequest,
  ChatMessage,
  ModelCaps,
  ModelInfo,
  ProviderGateway,
  Usage,
  UsageAttribution,
} from '../types.js';
import { usageFor } from '../tokens.js';
import { MOCK_MODELS, defaultScripts, type MockError, type MockResponse, type MockScript } from './scripts.js';

function isAsyncIterable(value: unknown): value is AsyncIterable<ChatChunk> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

/**
 * The message a scripted failure carries: the gateway's own text for its kind, so the
 * harness sees what a real failure would show. The host is the mock's base URL.
 */
function scriptedMessage(req: ChatRequest, error: MockError): string {
  if (error.message !== undefined) return error.message;
  const host = MOCK_BASE_URL;
  switch (error.kind) {
    case 'network':
      return providerMessages.network(host, error.detail);
    case 'auth':
      return providerMessages.auth(host);
    case 'endpoint':
      return providerMessages.endpoint('/chat/completions', host);
    case 'rate_limit':
      return providerMessages.rateLimit(host);
    case 'provider':
      return providerMessages.provider(host, error.status ?? 500, error.detail ?? '');
    case 'protocol':
      return providerMessages.protocol(host, error.detail ?? '');
    case 'context_length': {
      const model = MOCK_MODELS.find((m) => m.id === req.model) ?? MOCK_MODELS[0];
      return providerMessages.contextLength(usageFor(req.messages, '').promptTokens, model?.contextWindow ?? 'unknown');
    }
  }
}

/** A plain response as a stream: its text as one delta, then its terminal reason. A scripted error raises first. */
async function* responseChunks(req: ChatRequest, response: MockResponse): AsyncGenerator<ChatChunk> {
  if (response.error !== undefined) {
    const { error } = response;
    throw new ProviderError(error.kind, scriptedMessage(req, error), {
      status: error.status,
      detail: error.detail,
      retryAfterMs: error.retryAfterMs,
    });
  }
  if (response.content.length > 0) yield { delta: response.content };
  const calls = response.toolCalls;
  if (calls !== undefined && calls.length > 0) {
    // A native-mode reply ends on the calls it asked for; scripted reasoning becomes a
    // replayable block on the same chunk, as the adapters' terminal chunks carry it.
    yield {
      finishReason: response.finishReason ?? 'tool_calls',
      toolCalls: calls,
      ...(response.reasoning !== undefined
        ? { reasoning: [{ text: response.reasoning, raw: { type: 'mock-reasoning', text: response.reasoning } }] }
        : {}),
    };
    return;
  }
  if (response.reasoning !== undefined) yield { reasoningDelta: response.reasoning };
  yield { finishReason: response.finishReason ?? 'stop' };
}

export interface MockProviderOptions {
  /** Replaces the default library. Order is match order; first match wins. */
  scripts?: MockScript[];
  /** Profile id reported by `listModels`; matches nothing about the request. */
  profileId?: string;
  /** `modelCaps()` reports the native-tools row `{tools: true}` when set. Default false: the conservative empty row. */
  capsTools?: boolean;
}

export class MockProvider implements ProviderGateway {
  private readonly scripts: MockScript[];
  private readonly profileId: string;
  private readonly capsTools: boolean;
  /** The count of `complete()` calls served — the `callIndex` scripts see. */
  private sequence = 0;
  /** Every request this provider has seen — lets evals assert on call history. */
  readonly calls: ChatRequest[] = [];
  /**
   * Usage recorded through `accountTokens`. Dated from a manual clock at zero unless the
   * caller supplies `at`, because the mock must not read real time.
   */
  readonly ledger = new UsageLedger(createManualClock(0));

  constructor(options: MockProviderOptions = {}) {
    this.scripts = options.scripts ?? defaultScripts;
    this.profileId = options.profileId ?? 'mock';
    this.capsTools = options.capsTools ?? false;
  }

  private pick(req: ChatRequest): MockScript {
    const found = this.scripts.find((s) => s.match(req));
    if (!found) {
      // No script matched. §8 says first-match-wins with `echo` as the shipped
      // fallback; if a caller removed `echo` we still answer rather than hang.
      return { match: () => true, respond: () => ({ content: '' }) };
    }
    return found;
  }

  async *complete(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    this.calls.push(req);
    this.sequence += 1;
    const result = this.pick(req).respond(req, this.sequence);
    const source = isAsyncIterable(result) ? result : responseChunks(req, result as MockResponse);
    yield* settle(req, source, signal);
  }

  completeOnce(req: ChatRequest, signal?: AbortSignal): Promise<ChatMessage> {
    return collectOnce(this.complete(req, signal), signal);
  }

  async listModels(_profileId: string): Promise<ModelInfo[]> {
    return MOCK_MODELS;
  }

  accountTokens(usage: Usage, by: UsageAttribution): void {
    this.ledger.record(by, usage, 1);
  }

  /**
   * The capability row a caller reads to pick native-vs-fallback mode. The mock reports
   * the conservative empty row unless `capsTools` was set, in which case `{tools: true}`.
   * The gateway reads this for a mock profile; `ProviderGateway` itself has no `modelCaps`.
   */
  modelCaps(_profileId?: string, _model?: string): ModelCaps {
    return this.capsTools ? { tools: true } : {};
  }

  /** Test affordance: which profile id this provider answers for. */
  get id(): string {
    return this.profileId;
  }
}

/**
 * The one place a mock stream is finished off. It forwards the script's deltas and
 * reasoning deltas as they are yielded, and remembers what was actually handed to the
 * consumer — the usage, the declared finish reason, and the native-mode fields
 * (`toolCalls`, `reasoning`) a script put on its last chunk. The terminal chunk is
 * produced here, once, so every path (normal, script-declared finish, abort) ends the
 * same way.
 */
async function* settle(req: ChatRequest, source: AsyncIterable<ChatChunk>, signal?: AbortSignal): AsyncGenerator<ChatChunk> {
  let delivered = '';
  let scriptUsage: Usage | undefined;
  let scriptFinish: ChatChunk['finishReason'];
  let scriptToolCalls: ChatChunk['toolCalls'];
  let scriptReasoning: ChatChunk['reasoning'];
  let interrupted = false;

  try {
    for await (const chunk of source) {
      if (signal?.aborted) {
        interrupted = true;
        break;
      }
      if (chunk.usage !== undefined) scriptUsage = chunk.usage;
      if (chunk.finishReason !== undefined) scriptFinish = chunk.finishReason;
      if (chunk.toolCalls !== undefined) scriptToolCalls = chunk.toolCalls;
      if (chunk.reasoning !== undefined) scriptReasoning = chunk.reasoning;
      if (chunk.reasoningDelta !== undefined) yield { reasoningDelta: chunk.reasoningDelta };
      if (chunk.delta) {
        delivered += chunk.delta;
        yield { delta: chunk.delta };
      }
    }
  } catch (error) {
    // A failure that lands after the caller aborted is the caller's stop, not the provider's error.
    if (!signal?.aborted) throw error;
    interrupted = true;
  }

  if (interrupted || signal?.aborted) {
    yield { finishReason: 'error', usage: usageFor(req.messages, delivered) };
    return;
  }
  yield {
    finishReason: scriptFinish ?? 'stop',
    usage: scriptUsage ?? usageFor(req.messages, delivered),
    ...(scriptToolCalls !== undefined ? { toolCalls: scriptToolCalls } : {}),
    ...(scriptReasoning !== undefined ? { reasoning: scriptReasoning } : {}),
  };
}

/** Convenience factory — `createMockProvider()` is the import used across the test kit. */
export function createMockProvider(options?: MockProviderOptions): MockProvider {
  return new MockProvider(options);
}
