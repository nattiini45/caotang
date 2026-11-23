/**
 * What a native host may fetch on the app's behalf — [provider-gateway.md §9](../../../docs/architecture/provider-gateway.md),
 * [desktop.md](../../../docs/architecture/desktop.md).
 *
 * The desktop app makes provider and MCP calls in its main process, where no CORS preflight exists and no page origin
 * applies. That port is deliberately not a general fetcher: it reaches https origins the writer has configured, and
 * nothing else. This module is that rule, in one place, with no Electron and no network in it, so the rule is tested by
 * the repository's own gate rather than only by a launched app.
 *
 * **No loopback.** A local model server and a local MCP server are reached from the page as they are today
 * (decisions.md: provider calls are made natively, https only, to the configured profiles' origins and connected MCP
 * URLs, no loopback). Everything here therefore refuses a request whose origin is this computer.
 *
 * The refusal kind is what the host tells the writer: `denied` means the address is not one they configured, `invalid`
 * means the request itself is malformed, and `too-large` means it would spend more memory than the port allows.
 */

import { isLoopbackHost } from './loopback.js';

/** A request the native side may make: exactly what the port accepts and hands to a network stack. */
export interface NativeEgressRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export type NativeEgressRefusal = 'invalid' | 'denied' | 'too-large';

export type NativeEgressCheck =
  | { readonly ok: true; readonly request: NativeEgressRequest }
  | { readonly ok: false; readonly refusal: NativeEgressRefusal };

/**
 * The port's caps. A provider request carries a prompt, which can be large, so the request body cap sits well above any
 * real one; an answer is streamed and counted as it goes, so the response cap stops a runaway body without holding it.
 */
export interface NativeEgressLimits {
  /** A request body is text (JSON), so this is a byte count of its UTF-8 form. */
  readonly maxBodyBytes: number;
  /** The sum of header names and values. */
  readonly maxHeaderBytes: number;
  readonly maxHeaders: number;
  /** Counted as the stream is read; past this the host stops the response rather than buffering it. */
  readonly maxResponseBytes: number;
}

export const NATIVE_EGRESS_LIMITS: NativeEgressLimits = {
  maxBodyBytes: 24 * 1024 * 1024,
  maxHeaderBytes: 32 * 1024,
  maxHeaders: 32,
  maxResponseBytes: 64 * 1024 * 1024,
};

/** The methods a model call, a model listing and an MCP session use. Anything else is not a shape this app sends. */
const METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** An RFC 9110 token: what a header name may be. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

/**
 * Headers Chromium derives or would refuse, and which a request that names them is trying to smuggle. `authorization`
 * and `x-api-key` are the app's own to send, so they are absent here.
 */
const REFUSED_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'content-length',
  'host',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Whether a header value carries a control character: a line break would split one header into two, and nothing here sends one. */
function hasControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The origins a host may reach, from the entries the app configured. An entry that is not a bare `https` origin is
 * dropped rather than repaired: the app's own profile and server records are what produce these, so a malformed entry is
 * a bug, and accepting a truncated address would widen the allowlist instead of narrowing it.
 */
export function nativeEgressOrigins(entries: readonly unknown[]): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const entry of entries) {
    const origin = typeof entry === 'string' ? normalizeOrigin(entry) : undefined;
    if (origin !== undefined) origins.add(origin);
  }
  return origins;
}

/** A bare `https` origin, or undefined for anything else (a path, a query, a credential, another scheme). */
export function normalizeOrigin(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
  // An origin carries no path, query or fragment: `https://api.example.com/v1` is a base URL, not an origin.
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined;
  if (isLoopbackHost(url.hostname)) return undefined;
  return url.origin;
}

/**
 * Whether one request may be made. Every field is checked here and not in the host that runs the network call, so the
 * rule is the same in a test as in the app, and a request that passes is exactly the one the host sends.
 */
export function checkNativeEgress(
  origins: ReadonlySet<string>,
  candidate: unknown,
  limits: NativeEgressLimits = NATIVE_EGRESS_LIMITS,
): NativeEgressCheck {
  if (candidate === null || typeof candidate !== 'object') return { ok: false, refusal: 'invalid' };
  const spec = candidate as { url?: unknown; method?: unknown; headers?: unknown; body?: unknown };
  if (typeof spec.url !== 'string' || spec.url.length > 2048) return { ok: false, refusal: 'invalid' };
  let url: URL;
  try {
    url = new URL(spec.url);
  } catch {
    return { ok: false, refusal: 'invalid' };
  }
  // The scheme is decided before the allowlist is consulted, so a non-https address is refused as invalid wherever it
  // points and never merely as unconfigured.
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return { ok: false, refusal: 'invalid' };
  if (isLoopbackHost(url.hostname)) return { ok: false, refusal: 'denied' };
  if (!origins.has(url.origin)) return { ok: false, refusal: 'denied' };

  if (typeof spec.method !== 'string' || !METHODS.has(spec.method)) return { ok: false, refusal: 'invalid' };
  const method = spec.method as NativeEgressRequest['method'];

  if (spec.headers === null || typeof spec.headers !== 'object' || Array.isArray(spec.headers)) return { ok: false, refusal: 'invalid' };
  const headers: Record<string, string> = {};
  let headerBytes = 0;
  const entries = Object.entries(spec.headers as Record<string, unknown>);
  if (entries.length > limits.maxHeaders) return { ok: false, refusal: 'too-large' };
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(name) || REFUSED_HEADERS.has(lower)) return { ok: false, refusal: 'invalid' };
    if (typeof value !== 'string' || hasControl(value)) return { ok: false, refusal: 'invalid' };
    headerBytes += name.length + value.length;
    if (headerBytes > limits.maxHeaderBytes) return { ok: false, refusal: 'too-large' };
    headers[lower] = value;
  }

  let body: string | undefined;
  if (spec.body !== undefined && spec.body !== null) {
    if (typeof spec.body !== 'string') return { ok: false, refusal: 'invalid' };
    if (byteLength(spec.body) > limits.maxBodyBytes) return { ok: false, refusal: 'too-large' };
    body = spec.body;
  }

  return { ok: true, request: { url: url.href, method, headers, ...(body === undefined ? {} : { body }) } };
}

/** UTF-8 length without building the bytes twice: what the cap is measured against. */
function byteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Where a response's bytes go as they arrive: the host forwards them to the page it is answering. */
export type EgressSink = (bytes: Uint8Array) => void;

export type EgressPump = 'ended' | 'too-large' | 'unavailable';

/**
 * Reads a response body to its end, handing each chunk to `sink`, and answers how it went. The cap is counted as the body
 * arrives rather than against a declared length, because a stream declares nothing and a runaway one must be stopped
 * mid-flight; the chunk that would pass the cap is not handed on, so `sink` never sees more than the limit.
 *
 * A body that fails part-way is `unavailable`: the caller has already sent the status and headers, so the end of the body
 * is the only place its failure can be reported.
 */
export async function pumpResponse(response: Response, sink: EgressSink, limits: NativeEgressLimits = NATIVE_EGRESS_LIMITS): Promise<EgressPump> {
  const body = response.body;
  if (body === null) return 'ended';
  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return 'ended';
      total += value.byteLength;
      if (total > limits.maxResponseBytes) {
        void reader.cancel().catch(() => undefined);
        return 'too-large';
      }
      sink(value);
    }
  } catch {
    return 'unavailable';
  }
}
