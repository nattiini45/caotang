/**
 * Mock script library — [provider-gateway.md §8](docs/architecture/provider-gateway.md).
 *
 * Contract, verbatim from the spec:
 *  - Deterministic: same script + same request + same position in the provider's call
 *    sequence = same response bytes. No clock, no randomness (temperature ignored).
 *    `nativeCall` ids count the provider's `complete()` calls, which is itself
 *    deterministic — replay a sequence and the same ids come out.
 *  - Scriptable: `echo`, `toolJson`, `stream(words)`, `fail(mode)` ship by default;
 *    `nativeCall(name, args)` scripts a native function-call reply for requests that
 *    carry `tools`, and `MockResponse.toolCalls`/`reasoning` let any script do the same.
 *  - Usage accounting: fake token counts = `ceil(chars/4)` so ledger assertions
 *    work unchanged.
 */

import type { ProviderErrorKind } from '../errors.js';
import { textOf } from '../parts.js';
import type { ChatChunk, ChatRequest, FinishReason, ModelInfo, ToolCall } from '../types.js';

// The token rule lives in one module so the mock and the real gateway agree on it.
// Re-exported here so the `./mock` subpath keeps the names the desktop app and the tests use.
export { estimateTokens, usageFor } from '../tokens.js';

/** A scripted failure: the §4 kind the stream raises, with what the gateway would carry for it. */
export interface MockError {
  kind: ProviderErrorKind;
  /** the HTTP status the failure stands for, when it has one */
  status?: number;
  /** the wait the provider asked for, in milliseconds */
  retryAfterMs?: number;
  /** diagnostic text; also the excerpt the message quotes, for the kinds that quote one */
  detail?: string;
  /**
   * The words the failure carries, when the script words it itself (a demo refusal). The gateway's own text for the kind is used
   * when this is absent, so a script that names no words gets the same message a real provider failure would show.
   */
  message?: string;
}

export interface MockResponse {
  content: string;
  finishReason?: FinishReason;
  /** raises a `ProviderError` of this kind before any output, instead of answering */
  error?: MockError;
  /**
   * Native-mode calls the reply asks for. When present the reply is a request to run
   * tools, not an answer: the terminal chunk carries them with finishReason
   * 'tool_calls' (which is the reason to declare, when one is declared).
   */
  toolCalls?: readonly ToolCall[];
  /**
   * Reasoning text the reply produced. With `toolCalls` it rides the terminal chunk as
   * a replayable block (`raw` = `{type:'mock-reasoning', text}`); without them it
   * streams as one `reasoningDelta` chunk before the terminal.
   */
  reasoning?: string;
}

/** Picks the response for a request. First match wins — order is the script's order. */
export interface MockScript {
  match: (req: ChatRequest) => boolean;
  /**
   * `callIndex` is the request's 1-based position in the provider's `complete()`
   * sequence — how `nativeCall` numbers its `call_mock_<n>` ids.
   */
  respond: (req: ChatRequest, callIndex?: number) => MockResponse | AsyncIterable<ChatChunk>;
}

/** Yield control without advancing wall-clock time, so consumers' async logic runs. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Last user message, or the last message of any role — the mock's "the prompt". Image parts read as their placeholder, never their bytes. */
function promptOf(req: ChatRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    const m = req.messages[i];
    if (m && m.role === 'user') return textOf(m.content);
  }
  const last = req.messages.at(-1)?.content ?? '';
  return typeof last === 'string' ? last : textOf(last);
}

const always = () => true;

/** `echo` — returns the user message. The default happy-path script. */
export const echo: MockScript = {
  match: always,
  respond: (req) => ({ content: promptOf(req) }),
};

/** `toolJson` — emits a canned JSON tool call for the harness protocol. */
export const toolJson: MockScript = {
  match: (req) => req.responseFormat !== undefined && req.responseFormat !== 'text',
  respond: (req) => {
    const hint = req.responseFormat && req.responseFormat !== 'text' ? req.responseFormat : undefined;
    return {
      content: JSON.stringify({
        tool: 'binder.create',
        arguments: { parentId: 'root', type: 'text', title: 'Mock Scene' },
        ...(hint ? { schemaHint: hint } : {}),
      }),
    };
  },
};

/**
 * `nativeCall(name, args)` — a native-mode reply: the model asks for the tool `name`
 * with `args` and says nothing else. Matches any request that carries `tools`, which
 * is what marks the caller as native-mode. The call id is `call_mock_<n>` where `n` is
 * the request's index in the provider's call sequence.
 */
export function nativeCall(name: string, args: unknown): MockScript {
  return {
    match: (req) => req.tools !== undefined && req.tools.length > 0,
    respond: (_req, callIndex) => ({
      content: '',
      toolCalls: [{ id: `call_mock_${callIndex ?? 1}`, name, argumentsJson: JSON.stringify(args) }],
      finishReason: 'tool_calls',
    }),
  };
}

/** `stream(words)` — chunks a string into word-sized deltas, exercising async consumers. */
export function stream(text: string): MockScript {
  return {
    match: always,
    async *respond(): AsyncIterable<ChatChunk> {
      for (const word of text.split(/(?<=\s)/)) {
        await tick();
        if (word.length > 0) yield { delta: word };
      }
    },
  };
}

export type FailMode = 'network' | 'auth' | 'rate-limit' | 'context-length';

/** The §4 error each spec fail mode stands for. */
const FAIL_ERRORS: Record<FailMode, MockError> = {
  network: { kind: 'network', detail: 'simulated' },
  auth: { kind: 'auth', status: 401 },
  'rate-limit': { kind: 'rate_limit', status: 429 },
  'context-length': { kind: 'context_length', status: 400 },
};

/** `fail(mode)` — simulates error paths for harness error tests: each mode raises the §4 error it names. */
export function fail(mode: FailMode): MockScript {
  return {
    match: always,
    respond: () => ({ content: '', error: { ...FAIL_ERRORS[mode] } }),
  };
}

/** Model list the mock reports. Fixed — determinism applies here too. */
export const MOCK_MODELS: ModelInfo[] = [
  { id: 'mock/echo-1', contextWindow: 128_000 },
  { id: 'mock/tool-json-1', contextWindow: 128_000 },
  { id: 'mock/stream-1', contextWindow: 32_000 },
];

/** The default script library, in match order. `echo` is the fallback. */
export const defaultScripts: MockScript[] = [toolJson, echo];
