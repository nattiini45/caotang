/**
 * The HTTP transport — [provider-gateway.md §3–§4](docs/architecture/provider-gateway.md).
 *
 * This is the only file that calls `fetch`, which is the spec's rule that the gateway
 * "is the only module that makes network calls" made structural. Every request passes
 * `assertEgress` first, so a request for any other origin is refused before a socket
 * opens. Every redirect is refused rather than followed, because a followed POST would
 * carry the manuscript to wherever the redirect points.
 *
 * Timing has three phases, and each is a deadline measured on the injected clock:
 *  - **connect**: until headers arrive, 10s after the attempt starts;
 *  - **first token**: until the first output, 30s after the attempt starts;
 *  - **idle**: between chunks once output has started, 60s;
 * with the whole request capped at 5 minutes, across retries. A call may carry its own
 * deadlines (`CallSpec.timeouts`): a model server on this computer loads its model first.
 *
 * Retry is allowed only while nothing has been delivered to the caller. Once a single
 * delta has been yielded, a failure is final, because a second attempt would repeat
 * text the caller already holds.
 */

import type { Clock } from './clock.js';
import { abortError, EgressDeniedError, ProviderError, providerMessages } from './errors.js';
import { backoffMs, isRetryable, parseRetryAfter, type RetryPolicy, type TransportTimeouts } from './retry.js';
import type { RequestLog, RequestLogEntry, RequestOutcome } from './request-log.js';
import { redact } from './redact.js';
import { createSseParser, type SseEvent } from './sse.js';
import { CallerCancelled, DeadlineReached, guard, sleep } from './timing.js';
import { classifyLocalFailure, loopbackPermission, supportsTargetAddressSpace, type LocalHint } from './local.js';
import { estimateTokens } from './tokens.js';
import type { StreamParser } from './adapters/types.js';
import type { ChatChunk, FinishReason, ReasoningBlock, ToolCall, Usage } from './types.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface TransportDeps {
  readonly fetch: FetchLike;
  readonly clock: Clock;
  readonly random: () => number;
  readonly timeouts: TransportTimeouts;
  readonly retry: RetryPolicy;
  readonly log: RequestLog;
  /**
   * The egress pin: the origin of the profile a request resolved to, read live from
   * the store. A request may only reach its own profile's origin — the key enters
   * the headers and the URL is checked before a socket opens, so a key can never
   * travel to an origin it was not entered for.
   */
  readonly profileOrigin: (profileId: string) => string | undefined;
  /** Whether `fetch` takes `targetAddressSpace`. Defaults to detecting it; tests say so. */
  readonly supportsAddressSpace?: () => boolean;
  /** The browser's `loopback-network` permission state, to tell a denial from a refused connection. Defaults to asking the browser. */
  readonly loopbackPermission?: () => Promise<string | undefined>;
}

/** One logical call: everything a request needs, with the secrets attached for this call only. */
export interface CallSpec {
  readonly profileId: string;
  readonly model: string;
  /** the host, for messages a person reads */
  readonly host: string;
  /** the normalised base, for the endpoint message */
  readonly baseUrl: string;
  /** the route's endpoint path — the adapter chooses it, per model where routes differ */
  readonly path: string;
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly accept: string;
  readonly body?: string;
  /** The output cap the body carries (`max_tokens` after any raise for thinking), recorded on the request log line. */
  readonly maxTokens?: number;
  /** The request headers the adapter built — auth, protocol versions, preset extras. */
  readonly headers: Record<string, string>;
  /** Every secret value in `headers` (key, custom header values). Scrubbed from excerpts; never stored on an error or a log entry. */
  readonly secrets: readonly string[];
  /**
   * A factory for the stream dialect, for calls that read SSE (`streamChat`). A parser holds
   * the route's per-stream state — an open tool call and its arguments — so every attempt
   * builds its own: a retry starts from nothing, not from the dropped attempt's state.
   */
  readonly createParser?: () => StreamParser;
  /** the prompt's estimated size, the fallback when a provider sends no usage */
  readonly promptTokens: number;
  readonly signal?: AbortSignal;
  /** overrides the policy's retry count. The §5 probe makes exactly one attempt. */
  readonly maxRetries?: number;
  /** Declares the target a local-network-aware browser should expect (Chrome's Local Network Access). Sent only where fetch supports it. */
  readonly addressSpace?: 'loopback';
  /** Deadlines for this call, over the transport's own. */
  readonly timeouts?: Partial<TransportTimeouts>;
  /** Set for a model server on this computer: a failed call is explained with the preset's own fix. */
  readonly local?: LocalHint;
  /** Told of each attempt as it is logged, with the line the request log gets. The gateway's trace observer listens here; it must not throw. */
  readonly onAttempt?: (entry: RequestLogEntry) => void;
}

/** Counts attempts and records the usage the ledger should see, whatever the outcome. */
export interface StreamStats {
  attempts: number;
  usage: Usage | undefined;
  /** Whether `usage` is what the provider reported or the `ceil(chars/4)` estimate used when it reported none. Set with `usage`. */
  usageSource?: 'provider' | 'estimate';
}

/**
 * Shared across attempts, so a retry knows whether anything has reached the caller yet.
 * A retry only happens while `sawDelta` is false, and the delivered text and the flag are
 * set together, so a retried attempt starts with nothing delivered either.
 */
interface StreamState {
  delivered: string;
  sawDelta: boolean;
}

interface Deadline {
  readonly attemptStart: number;
  readonly totalAt: number;
}

interface Limit {
  readonly ms: number;
  /** what to tell the person if this limit is the one that fires */
  readonly reason: string;
}

interface WireAccumulator {
  done: boolean;
  /**
   * Set by the first parsed event, whether or not it carries text. The first-token deadline
   * is about a provider that has gone silent, and a reasoning model streaming its thinking
   * is not silent, so the deadline ends at the first event and not the first visible token.
   */
  alive: boolean;
  finish: FinishReason | undefined;
  usage: Usage | undefined;
}

interface StreamOutcome {
  readonly finish: FinishReason;
  readonly usage: Usage | undefined;
  /** The assembled tool calls and replay blocks the adapter collected across the stream. */
  readonly terminal: { toolCalls?: readonly ToolCall[]; reasoning?: readonly ReasoningBlock[] };
}

const EXCERPT_LIMIT = 300;
/** How much of an error body is read. Enough for any provider message; not a page dump. */
const ERROR_BODY_LIMIT = 2_048;
/** How much of a successful body is kept, so a protocol excerpt can show what arrived. */
const HEAD_LIMIT = 2_048;
const CONTEXT_OVERFLOW = /context[_ ]length|maximum context|context window|too many tokens|reduce the length/i;
const REJECTS_RESPONSE_FORMAT = /response_format|json_object|json_schema/i;

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message}: ${cause.message}` : err.message;
  }
  return String(err);
}

/** Redacts, collapses whitespace, and bounds. Every excerpt that leaves this file passes through here. */
function clean(text: string, spec: CallSpec): string {
  return redact(text, spec.secrets).replace(/\s+/g, ' ').trim().slice(0, EXCERPT_LIMIT);
}

/** Appends `text` to the kept head of a body, up to `HEAD_LIMIT`, and no further. */
function keepHead(head: string, text: string): string {
  return head.length >= HEAD_LIMIT ? head : head + text.slice(0, HEAD_LIMIT - head.length);
}

/** The deadlines one call runs under: the transport's, with the call's own laid over them. */
function scoped(deps: TransportDeps, spec: CallSpec): TransportDeps {
  return spec.timeouts === undefined ? deps : { ...deps, timeouts: { ...deps.timeouts, ...spec.timeouts } };
}

function networkError(spec: CallSpec, reason: string, rejected = false): ProviderError {
  const detail = clean(reason, spec);
  return new ProviderError('network', providerMessages.network(spec.host, detail), { detail, ...(rejected ? { rejected } : {}) });
}

function protocolError(spec: CallSpec, raw: string): ProviderError {
  const excerpt = clean(raw, spec);
  return new ProviderError('protocol', providerMessages.protocol(spec.host, excerpt), { detail: excerpt });
}

/**
 * True when a request that needs no CORS reaches the server at all: any HTTP answer, however opaque, resolves it. It is a bare
 * GET with no headers, body or credentials, so it carries nothing of the writer's. A no-cors request must follow redirects
 * (the browser refuses `manual` for that mode), which is why this one does, unlike the real call.
 */
async function serverAnswers(deps: TransportDeps, spec: CallSpec): Promise<boolean> {
  const controller = new AbortController();
  try {
    const pending = deps.fetch(spec.url, { method: 'GET', mode: 'no-cors', signal: controller.signal });
    const response = await guard(pending, Math.min(deps.timeouts.connectMs, 5_000), deps.clock, spec.signal, () => {
      controller.abort();
      pending.then(
        (late) => void late.body?.cancel().catch(() => undefined),
        () => undefined,
      );
    });
    void response.body?.cancel().catch(() => undefined);
    return true;
  } catch (err) {
    if (err instanceof CallerCancelled) throw err;
    return false;
  }
}

/**
 * A rejected fetch to a model server on this computer, explained. A browser reports a CORS refusal, a refused
 * connection and a Local Network Access denial identically, so an opaque failure is told apart by asking whether the
 * server answers a request that needs no CORS (it does: the browser blocked the real one), and failing that, whether the
 * browser's loopback permission was denied. None of these changes on a second try, so none is retried.
 */
async function localFailure(deps: TransportDeps, spec: CallSpec, err: unknown): Promise<ProviderError | undefined> {
  if (spec.local === undefined) return undefined;
  const found = classifyLocalFailure(err);
  if (found === undefined) return undefined;
  let kind: 'cors' | 'refused' | 'denied';
  if (found !== 'opaque') kind = found;
  else if (await serverAnswers(deps, spec)) kind = 'cors';
  else kind = (await (deps.loopbackPermission ?? loopbackPermission)()) === 'denied' ? 'denied' : 'refused';
  const { product, corsFix } = spec.local;
  const message =
    kind === 'cors'
      ? providerMessages.localCors(product, corsFix)
      : kind === 'denied'
        ? providerMessages.localDenied(product)
        : providerMessages.localRefused(product, spec.host);
  return new ProviderError('network', message, { detail: clean(describe(err), spec), permanent: true });
}

/**
 * The limit for one phase, capped by the whole-request deadline. When the cap is what
 * fires, the reason says so, because "request exceeded 5 minutes" is the true cause and
 * "no first token within 30s" would be a lie.
 */
function limitAt(deps: TransportDeps, deadline: Deadline, phaseEnd: number, phaseReason: string): Limit {
  const now = deps.clock.now();
  if (phaseEnd <= deadline.totalAt) return { ms: phaseEnd - now, reason: phaseReason };
  return {
    ms: deadline.totalAt - now,
    reason: `request exceeded ${Math.round(deps.timeouts.totalMs / 60_000)} minutes`,
  };
}

/**
 * The egress guard. A request whose origin is not the origin of the profile it resolved
 * to is refused — the pin is the resolved profile, so one profile's key can never ride
 * to another profile's endpoint. Checked in the transport, before a socket opens, and
 * in the gateway before any key is decrypted, so a refused request never touches key
 * material.
 */
export function assertEgress(deps: TransportDeps, url: string, profileId: string): void {
  const requested = new URL(url).origin;
  const allowed = deps.profileOrigin(profileId);
  if (allowed === undefined) {
    throw new EgressDeniedError(`Refused a request to ${requested}: the profile has no endpoint to pin to.`);
  }
  if (requested !== allowed) {
    throw new EgressDeniedError(
      `Refused a request to ${requested}: only the profile's own endpoint (${allowed}) may be contacted.`,
    );
  }
}

function logAttempt(
  deps: TransportDeps,
  spec: CallSpec,
  attempt: number,
  outcome: RequestOutcome,
  extra: { status?: number; error?: unknown } = {},
): void {
  const error = extra.error instanceof ProviderError ? extra.error : undefined;
  const status = extra.status ?? error?.status;
  const entry: RequestLogEntry = {
    at: deps.clock.now(),
    profileId: spec.profileId,
    model: spec.model,
    attempt,
    url: spec.url,
    ...(spec.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens }),
    outcome,
    ...(status !== undefined ? { status } : {}),
    ...(error !== undefined ? { errorKind: error.kind } : {}),
    ...(error?.detail !== undefined ? { note: error.detail } : {}),
  };
  deps.log.append(entry);
  spec.onAttempt?.(entry);
}

/** Maps a failed attempt to the outcome the log should record for it. */
function outcomeOf(err: unknown): RequestOutcome {
  if (err instanceof EgressDeniedError) return 'refused';
  if (err instanceof CallerCancelled) return 'cancelled';
  return 'failed';
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already closed or errored: there is nothing left to release.
  }
}

async function readExcerpt(deps: TransportDeps, spec: CallSpec, response: Response): Promise<string> {
  try {
    const text = await guard(response.text(), deps.timeouts.connectMs, deps.clock, spec.signal);
    return text.slice(0, ERROR_BODY_LIMIT);
  } catch (err) {
    if (err instanceof CallerCancelled) throw err;
    await discard(response);
    return '';
  }
}

/**
 * Recognises a context-window refusal in a 400 body and extracts the two numbers the
 * user needs. Providers phrase this differently, so the regexes take what they can and
 * fall back to the local estimate of the prompt.
 */
export function contextOverflow(body: string, estimate: number): { prompt: number; window: number | undefined } | undefined {
  if (!CONTEXT_OVERFLOW.test(body)) return undefined;
  const window = /maximum context length is ([\d,]+)/i.exec(body)?.[1];
  const prompt = /resulted in ([\d,]+) tokens/i.exec(body)?.[1];
  return {
    prompt: prompt === undefined ? estimate : Number(prompt.replace(/,/g, '')),
    window: window === undefined ? undefined : Number(window.replace(/,/g, '')),
  };
}

/** Turns a non-2xx response into the §4 error for its status. Never copies the key. */
async function statusError(deps: TransportDeps, spec: CallSpec, response: Response): Promise<ProviderError> {
  const raw = await readExcerpt(deps, spec, response);
  const excerpt = clean(raw, spec);
  const status = response.status;

  if (status === 401 || status === 403) {
    return new ProviderError('auth', providerMessages.auth(spec.host), { status });
  }
  if (status === 404) {
    // A local server answers 404 for a model it has not pulled; "no endpoint at ..." would send the writer to the wrong setting.
    if (spec.local !== undefined && excerpt.toLowerCase().includes('model')) {
      return new ProviderError('provider', providerMessages.provider(spec.host, status, excerpt), { status, detail: excerpt });
    }
    return new ProviderError('endpoint', providerMessages.endpoint(spec.path, spec.baseUrl), { status, detail: excerpt });
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), deps.clock.now());
    return new ProviderError('rate_limit', providerMessages.rateLimit(spec.host), { status, detail: excerpt, retryAfterMs });
  }
  if (status === 400) {
    const overflow = contextOverflow(raw, spec.promptTokens);
    if (overflow !== undefined) {
      return new ProviderError(
        'context_length',
        providerMessages.contextLength(overflow.prompt, overflow.window ?? 'unknown'),
        { status, detail: excerpt },
      );
    }
  }
  return new ProviderError('provider', providerMessages.provider(spec.host, status, excerpt), { status, detail: excerpt });
}

/**
 * One connection attempt: egress check, fetch, the connect deadline, and the status
 * mapping. Returns the response only for a 2xx. Everything else throws.
 */
async function connect(deps: TransportDeps, spec: CallSpec, deadline: Deadline, controller: AbortController): Promise<Response> {
  assertEgress(deps, spec.url, spec.profileId);

  const headers: Record<string, string> = { accept: spec.accept, ...spec.headers };
  if (spec.body !== undefined && headers['content-type'] === undefined) headers['content-type'] = 'application/json';

  let pending: Promise<Response>;
  try {
    pending = deps.fetch(spec.url, {
      method: spec.method,
      headers,
      body: spec.body,
      redirect: 'manual',
      signal: controller.signal,
      ...(spec.addressSpace !== undefined && (deps.supportsAddressSpace ?? supportsTargetAddressSpace)()
        ? { targetAddressSpace: spec.addressSpace }
        : {}),
    });
  } catch (err) {
    // A fetch that throws rather than rejecting is still a failure to reach the provider.
    throw (await localFailure(deps, spec, err)) ?? networkError(spec, describe(err), true);
  }
  const limit = limitAt(
    deps,
    deadline,
    deadline.attemptStart + deps.timeouts.connectMs,
    `no response within ${seconds(deps.timeouts.connectMs)}`,
  );

  let response: Response;
  try {
    response = await guard(pending, limit.ms, deps.clock, spec.signal, () => {
      // The race is lost, so stop the fetch, and release a response that still arrives.
      controller.abort();
      pending.then(
        (late) => void late.body?.cancel().catch(() => undefined),
        () => undefined,
      );
    });
  } catch (err) {
    if (err instanceof DeadlineReached) throw networkError(spec, limit.reason);
    if (err instanceof CallerCancelled) throw err;
    throw (await localFailure(deps, spec, err)) ?? networkError(spec, describe(err), true);
  }

  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    await discard(response);
    throw new EgressDeniedError(
      `${spec.host} redirected the request. Caotang does not follow redirects, so set the base URL to the final address in Settings.`,
    );
  }
  if (!response.ok) throw await statusError(deps, spec, response);
  return response;
}

/** The wait before the next attempt: the provider's `Retry-After` if it sent one, else the backoff. */
function retryWait(deps: TransportDeps, err: ProviderError, retries: number, maxRetries: number, totalAt: number): number | undefined {
  if (!isRetryable(err) || retries >= maxRetries) return undefined;
  const wait = err.retryAfterMs ?? backoffMs(retries, deps.random, deps.retry);
  return deps.clock.now() + wait < totalAt ? wait : undefined;
}

function* chunksOf(
  spec: CallSpec,
  parser: StreamParser | undefined,
  events: readonly SseEvent[],
  acc: WireAccumulator,
  state: StreamState,
): Generator<ChatChunk, void, undefined> {
  if (parser === undefined) throw protocolError(spec, 'no stream parser for this call');
  for (const ev of events) {
    if (acc.done) return;
    for (const piece of parser.push(ev)) {
      if (piece.malformed !== undefined) throw protocolError(spec, piece.malformed);
      if (piece.error !== undefined) {
        const detail = clean(piece.error, spec);
        throw new ProviderError('provider', providerMessages.providerStream(spec.host, detail), { detail });
      }
      if (piece.usage !== undefined) acc.usage = piece.usage;
      if (piece.finish !== undefined) acc.finish = piece.finish;
      if (piece.done === true) acc.done = true;
      if (piece.text !== undefined && piece.text !== '') {
        state.delivered += piece.text;
        state.sawDelta = true;
        yield { delta: piece.text };
      }
      if (piece.reasoning !== undefined && piece.reasoning !== '') {
        // Reasoning is delivered too: a retry after it would duplicate the Thinking block.
        state.sawDelta = true;
        yield { reasoningDelta: piece.reasoning };
      }
    }
    // A parsed event — even a keep-alive like Anthropic's `ping` — means the provider is talking.
    acc.alive = true;
    if (acc.done) return;
  }
}

/**
 * Reads the SSE body, yielding each delta as it arrives. The stream ends at `[DONE]`,
 * at end of body, or, once a finish reason has been seen, at the idle deadline (some
 * providers keep the connection open after the answer is complete).
 */
async function* readStream(
  deps: TransportDeps,
  spec: CallSpec,
  response: Response,
  deadline: Deadline,
  state: StreamState,
): AsyncGenerator<ChatChunk, StreamOutcome, undefined> {
  const { clock } = deps;
  if (response.body === null) throw protocolError(spec, 'the response had no body');

  // The adapter's parser for this attempt. It is built here, not once per call, because a
  // parser carries the stream's own state: a retried attempt must not inherit the tool call
  // the dropped attempt had already started. It is built before a reader locks the body,
  // and a factory that throws releases the body and fails as a protocol error, so it can
  // neither strand the response nor escape the ProviderError contract.
  let parser: StreamParser | undefined;
  try {
    parser = spec.createParser?.();
  } catch (err) {
    void response.body.cancel().catch(() => undefined);
    throw protocolError(spec, describe(err));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const sse = createSseParser();
  const acc: WireAccumulator = { done: false, alive: false, finish: undefined, usage: undefined };
  // The start of what the body said, kept for the excerpt if no event ever parses.
  let head = '';

  try {
    for (;;) {
      // Before the provider has said anything, the first-token window applies. After it,
      // the gap between events is what counts.
      const limit = acc.alive
        ? limitAt(deps, deadline, clock.now() + deps.timeouts.idleMs, `stream idle for ${seconds(deps.timeouts.idleMs)}`)
        : limitAt(
            deps,
            deadline,
            deadline.attemptStart + deps.timeouts.firstTokenMs,
            `no first token within ${seconds(deps.timeouts.firstTokenMs)}`,
          );

      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await guard(reader.read(), limit.ms, clock, spec.signal);
      } catch (err) {
        if (err instanceof CallerCancelled) throw err;
        if (err instanceof DeadlineReached) {
          // The provider finished and then went quiet. The answer is whole, so end it.
          if (acc.finish !== undefined) break;
          throw networkError(spec, limit.reason);
        }
        throw networkError(spec, describe(err));
      }

      if (read.done) {
        const tail = decoder.decode();
        head = keepHead(head, tail);
        for (const chunk of chunksOf(spec, parser, [...sse.push(tail), ...sse.end()], acc, state)) yield chunk;
        break;
      }

      const text = decoder.decode(read.value, { stream: true });
      head = keepHead(head, text);
      for (const chunk of chunksOf(spec, parser, sse.push(text), acc, state)) yield chunk;
      if (acc.done) break;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }

  // The body closed without [DONE] and without a finish reason: the answer is cut short.
  if (!acc.done && acc.finish === undefined) {
    // No event ever parsed, so this was never a stream: a plain completion from a server that
    // ignored `stream: true`, or a proxy's page. Asking again gets the same answer, so it is one
    // protocol failure with no retry, not a network failure to repeat.
    if (!acc.alive) throw protocolError(spec, head.trim() === '' ? 'the response was empty' : head);
    throw networkError(spec, 'the stream ended before the response finished');
  }
  return { finish: acc.finish ?? 'stop', usage: acc.usage, terminal: parser?.finish() ?? {} };
}

/**
 * A streaming chat call, with the whole retry and timeout policy.
 *
 * The contract for the caller is: yields deltas as they arrive, then exactly one
 * terminal chunk carrying `finishReason` and `usage`. A caller abort is not thrown. It
 * becomes a terminal `finishReason: 'error'`, with usage counting the deltas actually
 * delivered (§3: "resolves the iterator with what arrived"). Every other failure is
 * thrown as a `ProviderError`, or as an `EgressDeniedError` for a refused request.
 */
export async function* streamChat(
  base: TransportDeps,
  spec: CallSpec,
  stats: StreamStats,
): AsyncGenerator<ChatChunk, void, undefined> {
  const deps = scoped(base, spec);
  const { clock } = deps;
  const maxRetries = spec.maxRetries ?? deps.retry.maxRetries;
  const totalAt = clock.now() + deps.timeouts.totalMs;
  const state: StreamState = { delivered: '', sawDelta: false };
  const estimated = (): Usage => ({ promptTokens: spec.promptTokens, completionTokens: estimateTokens(state.delivered) });
  let retries = 0;

  // The controller of the attempt in flight. Aborting it on the way out means a fetch never
  // outlives the generator that started it, whichever branch ends the stream.
  let controller: AbortController | undefined;
  try {
    for (;;) {
      const attempt = stats.attempts;
      stats.attempts += 1;
      const deadline: Deadline = { attemptStart: clock.now(), totalAt };
      let status: number | undefined;
      controller = new AbortController();

      try {
        const response = await connect(deps, spec, deadline, controller);
        status = response.status;
        const outcome = yield* readStream(deps, spec, response, deadline, state);
        const usage = outcome.usage ?? estimated();
        stats.usage = usage;
        stats.usageSource = outcome.usage === undefined ? 'estimate' : 'provider';
        logAttempt(deps, spec, attempt, 'ok', { status });
        yield { finishReason: outcome.finish, usage, ...outcome.terminal };
        return;
      } catch (err) {
        if (err instanceof CallerCancelled) {
          logAttempt(deps, spec, attempt, 'cancelled', { status });
          stats.usage = estimated();
          stats.usageSource = 'estimate';
          yield { finishReason: 'error', usage: stats.usage };
          return;
        }

        if (state.sawDelta) {
          stats.usage = estimated();
          stats.usageSource = 'estimate';
        }
        const wait =
          err instanceof ProviderError && !state.sawDelta ? retryWait(deps, err, retries, maxRetries, totalAt) : undefined;

        if (wait !== undefined && err instanceof ProviderError) {
          logAttempt(deps, spec, attempt, 'retrying', { status, error: err });
          retries += 1;
          try {
            await sleep(wait, clock, spec.signal);
          } catch (cancel) {
            if (cancel instanceof CallerCancelled) {
              stats.usage = estimated();
              stats.usageSource = 'estimate';
              yield { finishReason: 'error', usage: stats.usage };
              return;
            }
            throw cancel;
          }
          continue;
        }

        logAttempt(deps, spec, attempt, outcomeOf(err), { status, error: err });
        throw err;
      }
    }
  } finally {
    // A consumer that stops reading part-way (`return()` on the iterator) skips every
    // branch above. The provider still generated the deltas that were delivered, so they
    // are counted, as an estimate, rather than dropped from the ledger.
    if (stats.usage === undefined && state.sawDelta) {
      stats.usage = estimated();
      stats.usageSource = 'estimate';
    }
    controller?.abort();
  }
}

/**
 * A non-streaming GET (the model list), with the same retry and timeout policy. The body
 * is read whole, under the whole-request deadline. Returns the parsed JSON.
 */
export async function requestJson(base: TransportDeps, spec: CallSpec): Promise<unknown> {
  const deps = scoped(base, spec);
  const { clock } = deps;
  const maxRetries = spec.maxRetries ?? deps.retry.maxRetries;
  const totalAt = clock.now() + deps.timeouts.totalMs;
  let retries = 0;

  for (let attempt = 0; ; attempt += 1) {
    const deadline: Deadline = { attemptStart: clock.now(), totalAt };
    const controller = new AbortController();
    let status: number | undefined;
    try {
      const response = await connect(deps, spec, deadline, controller);
      status = response.status;
      const text = await readWhole(deps, spec, response, deadline);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw protocolError(spec, text);
      }
      logAttempt(deps, spec, attempt, 'ok', { status });
      return json;
    } catch (err) {
      if (err instanceof CallerCancelled) throw abortError();
      const wait = err instanceof ProviderError ? retryWait(deps, err, retries, maxRetries, totalAt) : undefined;
      if (wait !== undefined && err instanceof ProviderError) {
        logAttempt(deps, spec, attempt, 'retrying', { status, error: err });
        retries += 1;
        try {
          await sleep(wait, clock, spec.signal);
        } catch {
          throw abortError();
        }
        continue;
      }
      logAttempt(deps, spec, attempt, outcomeOf(err), { status, error: err });
      throw err;
    }
  }
}

/**
 * The body of a non-streaming response, read whole under the request deadline. The body is
 * read through a reader, so the deadline can cancel it the way the streaming path cancels
 * its reader: a `response.text()` that is still pulling cannot be stopped.
 */
async function readWhole(deps: TransportDeps, spec: CallSpec, response: Response, deadline: Deadline): Promise<string> {
  const limit = { ms: deadline.totalAt - deps.clock.now(), reason: `request exceeded ${Math.round(deps.timeouts.totalMs / 60_000)} minutes` };
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const read = (async () => {
    let text = '';
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  })();
  // When the deadline or the caller wins, nothing awaits `read` any more; its late
  // settling (a cancelled reader) must not surface as an unhandled rejection.
  read.catch(() => undefined);
  try {
    return await guard(read, limit.ms, deps.clock, spec.signal, () => {
      // The deadline won, or the caller hung up: stop pulling the body.
      void reader.cancel().catch(() => undefined);
    });
  } catch (err) {
    if (err instanceof CallerCancelled) throw err;
    if (err instanceof DeadlineReached) throw networkError(spec, limit.reason);
    throw networkError(spec, describe(err));
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/**
 * The §5 probe: one request with `response_format: json_object`, and the answer about
 * whether the endpoint accepted it. An acceptance is a 2xx. A refusal is a 400 or 422
 * whose body names `response_format`. A 400 about anything else, such as a bad model
 * name, is not an answer about the format, so it is thrown and not cached.
 */
export async function probeJsonObject(base: TransportDeps, spec: CallSpec): Promise<boolean> {
  const deps = scoped(base, spec);
  const deadline: Deadline = { attemptStart: deps.clock.now(), totalAt: deps.clock.now() + deps.timeouts.totalMs };
  const controller = new AbortController();
  try {
    const response = await connect(deps, { ...spec, maxRetries: 0 }, deadline, controller);
    await discard(response);
    logAttempt(deps, spec, 0, 'ok', { status: response.status });
    return true;
  } catch (err) {
    if (err instanceof CallerCancelled) throw abortError();
    if (
      err instanceof ProviderError &&
      err.kind === 'provider' &&
      (err.status === 400 || err.status === 422) &&
      REJECTS_RESPONSE_FORMAT.test(err.detail ?? '')
    ) {
      logAttempt(deps, spec, 0, 'ok', { status: err.status, error: err });
      return false;
    }
    logAttempt(deps, spec, 0, outcomeOf(err), { error: err });
    throw err;
  }
}
