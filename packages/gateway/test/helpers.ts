/**
 * Shared test kit for the gateway. Not a test file: vitest collects `*.test.ts` only.
 *
 * Time is never real here. The harness hands the gateway a manual clock, so every
 * timeout and backoff fires when a test advances the clock, which keeps the suite
 * deterministic and fast. The network is never real either: `ScriptedFetch` answers
 * each call with a responder the test wrote for it, and records the call for assertions.
 */

import { effectiveOutput } from '../src/adapters/effort.js';
import type { AdapterContext, BodyInput } from '../src/adapters/types.js';
import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore, type FetchLike, type ManualClock } from '../src/index.js';
import type { MockProvider } from '../src/mock/index.js';
import type { ChatChunk, ChatRequest, NewProfile } from '../src/types.js';

/** What a test may change about the input an adapter's `buildBody` is given. */
export interface BodyOver {
  readonly ctx?: AdapterContext;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly jsonObject?: boolean;
}

/** A `BodyInput` the way the gateway builds one: the cap and thinking settled by `effectiveOutput` from the request and the row. */
export function bodyInput(req: ChatRequest, ctx: AdapterContext, over: BodyOver = {}): BodyInput {
  return {
    req,
    ctx,
    temperature: over.temperature ?? 0.7,
    jsonObject: over.jsonObject ?? false,
    effective: effectiveOutput({
      cap: over.maxTokens ?? 4096,
      ...(req.thinking === undefined ? {} : { level: req.thinking }),
      ...(req.reasoningBudget === undefined ? {} : { budget: req.reasoningBudget }),
      caps: ctx.caps,
      ...(ctx.modelMaxOutput === undefined ? {} : { modelMaxOutput: ctx.modelMaxOutput }),
    }),
  };
}

/** A key with the shape of a real one, so the `sk-` pattern scrubber has something to catch. */
export const KEY = 'sk-test-CAOTANG-SECRET-0123456789abcdef';

/** Local noon, so the local calendar day is 2026-10-08 in every time zone. */
export const START = new Date(2026, 9, 8, 12, 0, 0).getTime();

/** Lets every pending promise continuation run before the test looks at state. */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * A WebCrypto stand-in whose promises settle in microtasks.
 *
 * Real AES-GCM runs on libuv's thread pool, and its completion is not ordered against
 * `setImmediate`. A timing test that awaited a real decrypt would therefore see the fetch
 * happen one event-loop turn earlier or later from run to run. The gateway tests are about
 * routing and timing, so they use this. The real cipher, with its tag and additional-data
 * checks, is exercised in key-store.test.ts against `globalThis.crypto.subtle`.
 */
export function microtaskSubtle(): SubtleCrypto {
  const xor = (data: BufferSource): ArrayBuffer => {
    const source = new Uint8Array(data as ArrayBuffer);
    const out = new Uint8Array(source.length);
    for (let i = 0; i < source.length; i += 1) out[i] = (source[i] ?? 0) ^ 0x5a;
    return out.buffer;
  };
  return {
    generateKey: async () => ({ type: 'secret', extractable: false, algorithm: { name: 'AES-GCM' }, usages: ['encrypt', 'decrypt'] }),
    encrypt: async (_alg: unknown, _key: unknown, data: BufferSource) => xor(data),
    decrypt: async (_alg: unknown, _key: unknown, data: BufferSource) => xor(data),
  } as unknown as SubtleCrypto;
}

export interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

export type Responder = (call: FetchCall) => Response | Promise<Response>;

/** Answers each fetch with the next queued responder. Calling past the queue is a test failure. */
export class ScriptedFetch {
  readonly calls: FetchCall[] = [];
  private readonly queue: Responder[] = [];

  push(...responders: Responder[]): this {
    this.queue.push(...responders);
    return this;
  }

  readonly fn: FetchLike = (url, init) => {
    const call: FetchCall = { url, init };
    this.calls.push(call);
    const responder = this.queue.shift();
    if (responder === undefined) return Promise.reject(new Error(`unexpected fetch to ${url}`));
    return Promise.resolve().then(() => responder(call));
  };

  bodyOf(index: number): Record<string, unknown> {
    const call = this.calls[index];
    if (call === undefined || typeof call.init.body !== 'string') throw new Error(`no body on call ${index}`);
    return JSON.parse(call.init.body) as Record<string, unknown>;
  }

  headerOf(index: number, name: string): string | undefined {
    const headers = this.calls[index]?.init.headers as Record<string, string> | undefined;
    return headers?.[name];
  }
}

const encoder = new TextEncoder();

/** A complete SSE response whose body is already closed: every event is available at once. */
export function sseResponse(payloads: readonly unknown[], init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const text = payloads.map((p) => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`).join('');
  return new Response(text, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/event-stream', ...init.headers },
  });
}

/** An SSE body the test writes into and closes by hand, for timing and abort tests. */
export interface OpenSse {
  readonly response: Response;
  /** writes one `data:` event */
  event(payload: unknown): void;
  /** writes raw text, for framing and malformed-input tests */
  raw(text: string): void;
  close(): void;
  fail(error: Error): void;
}

export function openSse(init: { status?: number; headers?: Record<string, string> } = {}): OpenSse {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const response = new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/event-stream', ...init.headers },
  });
  return {
    response,
    event: (payload) => controller.enqueue(encoder.encode(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)),
    raw: (text) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    fail: (error) => controller.error(error),
  };
}

/** The OpenAI chunk shape for one content delta. */
export const delta = (content: string): unknown => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
});

/** The OpenAI chunk shape for a finish reason, optionally with usage. */
export const finish = (reason: string, usage?: { prompt_tokens: number; completion_tokens: number }): unknown => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
  ...(usage ? { usage } : {}),
});

export interface Harness {
  readonly clock: ManualClock;
  readonly keys: ReturnType<typeof createKeyStore>;
  readonly profiles: ReturnType<typeof createProfileStore>;
  readonly net: ScriptedFetch;
  readonly gateway: ReturnType<typeof createGateway>;
}

export interface HarnessOptions {
  net?: ScriptedFetch;
  timeouts?: Parameters<typeof createGateway>[0]['timeouts'];
  retry?: Parameters<typeof createGateway>[0]['retry'];
  random?: () => number;
  supportsAddressSpace?: () => boolean;
  loopbackPermission?: () => Promise<string | undefined>;
  /** the mock provider that answers mock profiles; defaults to the shipped script library */
  mock?: MockProvider;
  /** the trace observer, as `GatewayOptions.observe` */
  observe?: Parameters<typeof createGateway>[0]['observe'];
}

/**
 * A complete gateway over in-memory stores, a manual clock, and a scripted network.
 * `random` defaults to 0.5, which makes the jitter factor exactly 1, so backoff delays
 * are the round numbers the spec states (1s, 4s).
 */
export function harness(options: HarnessOptions = {}): Harness {
  const clock = createManualClock(START);
  const keys = createKeyStore(createMemoryVaultPort(), { subtle: microtaskSubtle() });
  const profiles = createProfileStore({ keys });
  const net = options.net ?? new ScriptedFetch();
  const gateway = createGateway({
    profiles,
    keys,
    clock,
    fetch: net.fn,
    random: options.random ?? (() => 0.5),
    timeouts: options.timeouts,
    retry: options.retry,
    // Off unless a test says so: Node's fetch has no Local Network Access, and the permission query must not reach a real browser.
    supportsAddressSpace: options.supportsAddressSpace ?? (() => false),
    loopbackPermission: options.loopbackPermission ?? (async () => undefined),
    ...(options.mock === undefined ? {} : { mock: options.mock }),
    ...(options.observe === undefined ? {} : { observe: options.observe }),
  });
  return { clock, keys, profiles, net, gateway };
}

/** An endpoint profile on `a.example`, active by default because it is the first created. */
export async function addEndpoint(h: Harness, overrides: Partial<NewProfile> = {}) {
  return h.profiles.create({
    name: 'Test endpoint',
    kind: 'endpoint',
    baseUrl: 'https://a.example/v1',
    apiKey: KEY,
    defaultModel: 'model-x',
    ...overrides,
  });
}

/** Consumes a stream to the end, keeping whatever arrived before any error. */
export async function collect(source: AsyncIterable<ChatChunk>): Promise<{ chunks: ChatChunk[]; error?: unknown }> {
  const chunks: ChatChunk[] = [];
  try {
    for await (const chunk of source) chunks.push(chunk);
    return { chunks };
  } catch (error) {
    return { chunks, error };
  }
}

export function deltasOf(chunks: readonly ChatChunk[]): string {
  return chunks.map((c) => c.delta ?? '').join('');
}

export const userMessage = (content: string) => ({ messages: [{ role: 'user' as const, content }] });

/** A deterministic PRNG, for the property-style invariant test. */
export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
