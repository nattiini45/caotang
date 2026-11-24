/**
 * What a native host may fetch on the app's behalf — [provider-gateway.md §9](../../../docs/architecture/provider-gateway.md),
 * [desktop.md](../../../docs/architecture/desktop.md).
 *
 * The desktop app makes provider and MCP calls in its main process, where no CORS preflight exists and no page origin
 * applies. That port is deliberately not a general fetcher: it reaches https origins the writer has configured, and
 * nothing else. This module is that rule, in one place, with no Electron and no network in it, so the rule is tested by
 * the repository's own gate rather than only by a launched app.
 *
 * **This computer is reached only as a `local` entry.** A profile or MCP server whose address is a loopback literal is
 * published as `local`, because a credential the keychain holds cannot be attached by the page and a server on this machine is
 * where one most often lives; such an entry is the only kind allowed plain http, and `local` is not a licence to reach any
 * other address — an https origin elsewhere is still https-only, and a plain-http one is dropped whether or not an entry calls
 * it local (issue #867).
 *
 * **A key is a handle until it arrives here.** The page's key store never holds a provider key or an MCP token: it holds
 * `caotang-key:<id>`, and the adapter that would have written the key writes the handle where the key goes — in a header, in
 * the URL, wherever its own protocol puts it. The host swaps the handle for the secret of that id ({@link attachKeys}), but only
 * when the address is one the id belongs to, and then scrubs the secret out of the answer before the page sees it
 * ({@link createSecretScrubber}), so a provider that echoes a key cannot put one in the request log.
 *
 * The refusal kind is what the host tells the writer: `denied` means the address or the key is not one the app configured,
 * `invalid` means the request itself is malformed, and `too-large` means it would spend more memory than the port allows.
 */

import { isLoopbackHost, isLoopbackLiteral } from './loopback.js';
import { REDACTED_SECRET, redactLiterals } from './redact.js';

/** A request the native side may make: exactly what the port accepts and hands to a network stack. */
export interface NativeEgressRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** The key-vault ids this request names as handles. Empty when it carries no credential. */
  readonly keys: readonly string[];
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

/** One address the app may reach, and the keys whose secrets may be sent to it. */
export interface NativeEgressTarget {
  readonly origin: string;
  /** The vault ids (a profile id, or an `mcp:` reference) whose secret this address may carry. */
  readonly keys?: readonly string[];
  /** A server on this computer: the only kind that may be plain http, and only to a loopback literal. */
  readonly local?: boolean;
}

/** What one configured address allows, as the rule reads it. */
export interface NativeEgressAllowance {
  readonly keys: ReadonlySet<string>;
  readonly local: boolean;
}

/** A vault id: a provider profile, or an MCP token reference. Never a secret. */
const KEY_ID = /^[A-Za-z0-9:_.-]{1,128}$/u;

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

/** Where a key would have gone, the host puts this instead until it has checked the address it is going to. */
export const KEY_HANDLE_PREFIX = 'caotang-key:';

/** The handle for a vault id: what the page may hold and what the host swaps for the secret. */
export function keyHandle(id: string): string {
  return `${KEY_HANDLE_PREFIX}${id}`;
}

const HANDLE = new RegExp(`${KEY_HANDLE_PREFIX}([A-Za-z0-9:_.-]{1,128})`, 'gu');

/** The vault ids a piece of text names, in order, without repeats. */
export function handleIds(text: string): readonly string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(HANDLE)) {
    const id = match[1];
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
}

/** Whether a header value carries a control character: a line break would split one header into two, and nothing here sends one. */
function hasControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The addresses a host may reach, from the entries the app configured. An entry that is not a bare origin, or is this
 * computer without being a `local` entry, is dropped rather than repaired: the app's own profile and server records are what
 * produce these, so a malformed entry is a bug, and accepting a truncated address would widen the allowlist instead of
 * narrowing it.
 */
export function nativeEgressTargets(entries: readonly unknown[]): ReadonlyMap<string, NativeEgressAllowance> {
  const targets = new Map<string, NativeEgressAllowance>();
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const candidate = entry as { origin?: unknown; keys?: unknown; local?: unknown };
    if (typeof candidate.origin !== 'string') continue;
    const local = candidate.local === true;
    const origin = normalizeOrigin(candidate.origin, local);
    if (origin === undefined) continue;
    const keys = Array.isArray(candidate.keys)
      ? candidate.keys.filter((key): key is string => typeof key === 'string' && KEY_ID.test(key))
      : [];
    const known = targets.get(origin);
    targets.set(origin, { keys: new Set([...(known?.keys ?? []), ...keys]), local: known?.local === true || local });
  }
  return targets;
}

/**
 * A bare origin, or undefined for anything else (a path, a query, a credential, another scheme). A `local` address may be
 * plain http, and must then be a loopback literal; an address on this computer that is not `local` is never an origin the
 * port reaches.
 */
export function normalizeOrigin(raw: string, local = false): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.username !== '' || url.password !== '') return undefined;
  // An origin carries no path, query or fragment: `https://api.example.com/v1` is a base URL, not an origin.
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined;
  if (local) {
    if (url.protocol === 'https:' && !isLoopbackHost(url.hostname)) return undefined;
    if (url.protocol === 'http:' && !isLoopbackLiteral(url.hostname)) return undefined;
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  if (isLoopbackHost(url.hostname)) return undefined;
  return url.origin;
}

/**
 * Whether one request may be made, and with which key. Every field is checked here and not in the host that runs the network
 * call, so the rule is the same in a test as in the app, and a request that passes is exactly the one the host sends.
 */
export function checkNativeEgress(
  targets: ReadonlyMap<string, NativeEgressAllowance>,
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
  if (url.username !== '' || url.password !== '') return { ok: false, refusal: 'invalid' };
  // Only a local entry may be plain http, and only to a loopback literal: anywhere else a non-https address is a shape this port
  // does not carry, which is a malformed request rather than an address the writer did not configure.
  const plain = url.protocol === 'http:';
  if (!plain && url.protocol !== 'https:') return { ok: false, refusal: 'invalid' };
  const target = targets.get(url.origin);
  if (target === undefined) return { ok: false, refusal: plain ? 'invalid' : 'denied' };
  if (plain && !(target.local && isLoopbackLiteral(url.hostname))) return { ok: false, refusal: 'invalid' };

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
    // A GET carries no body: the network stack refuses one outright, and a request that fails inside it would reach the page
    // as a dead network rather than as the malformed request it is.
    if (method === 'GET') return { ok: false, refusal: 'invalid' };
    if (byteLength(spec.body) > limits.maxBodyBytes) return { ok: false, refusal: 'too-large' };
    body = spec.body;
  }

  // A handle is only a request to attach a secret where that secret belongs: an address this key was not configured for is
  // refused outright rather than sent with the handle, which the provider would report as a bad key.
  const keys = new Set<string>();
  for (const text of [url.href, ...Object.values(headers)]) {
    for (const id of handleIds(text)) {
      if (!target.keys.has(id)) return { ok: false, refusal: 'denied' };
      keys.add(id);
    }
  }

  return { ok: true, request: { url: url.href, method, headers, ...(body === undefined ? {} : { body }), keys: [...keys] } };
}

/**
 * A request with its handles replaced by the secrets they name: raw in a header value, percent-encoded where it stood in a URL,
 * because a key in a query parameter is a key a URL grammar has to carry.
 */
export function attachKeys(
  request: { readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly keys: readonly string[] },
  secrets: ReadonlyMap<string, string>,
): { readonly url: string; readonly headers: Record<string, string>; readonly values: readonly string[] } {
  let url = request.url;
  const headers: Record<string, string> = { ...request.headers };
  const values: string[] = [];
  for (const id of request.keys) {
    const secret = secrets.get(id);
    if (secret === undefined) continue;
    values.push(secret);
    const handle = keyHandle(id);
    if (url.includes(handle)) {
      // A key in an address goes in percent-encoded, so that is the form a provider echoes back from the URL it received. Both
      // forms are scrubbed, because an answer may carry either: the encoded one it read from the query, the raw one from anywhere.
      const inUrl = encodeURIComponent(secret);
      url = url.split(handle).join(inUrl);
      if (inUrl !== secret) values.push(inUrl);
    }
    for (const [name, value] of Object.entries(headers)) {
      if (value.includes(handle)) headers[name] = value.split(handle).join(secret);
    }
  }
  return { url, headers, values };
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

const REDACTED = new TextEncoder().encode(REDACTED_SECRET);

/** The redaction, as text: the same word {@link createSecretScrubber} puts in a body, for a header value or a reason phrase. */
export { REDACTED_SECRET };

/**
 * `text` with every one of `secrets` replaced by {@link REDACTED_SECRET}, once each, longest first and without reading what it
 * wrote. The answer's body goes through {@link createSecretScrubber}, which holds a chunk boundary together; a header value and
 * the reason phrase are strings already read whole, so this is their form of the same rule — a provider that echoes a key in a
 * header must not reach the page with it.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  return redactLiterals(text, secrets);
}

/**
 * A sink that never lets one of `secrets` through, even across a chunk boundary. The host attaches a key it holds, so the
 * page's own redaction — which scrubs the values it sent, and it sent a handle — cannot see the secret a provider echoes
 * back; this is what keeps "a key never reaches a log" true once the key lives here.
 *
 * Bytes are matched as bytes, so a multi-byte character split across two chunks is unaffected. The tail of each chunk is held
 * back by one byte less than the longest secret, because a secret can start there and finish in the next chunk — and what is
 * held is the provider's own bytes, never a replacement this pass wrote. A replacement goes straight to the sink: kept in the
 * buffer, the next chunk would read the marker as candidate text, redact it into itself and pass on an answer nobody sent
 * (#870, #877).
 */
export function createSecretScrubber(secrets: readonly string[], sink: EgressSink): { write(bytes: Uint8Array): void; end(): void } {
  // Longest first, so a secret that carries a shorter one's text goes as a whole.
  const encoded = [...new Set(secrets.filter((secret) => secret.length > 0))]
    .map((secret) => new TextEncoder().encode(secret))
    .sort((one, other) => other.byteLength - one.byteLength);
  if (encoded.length === 0) return { write: sink, end: () => undefined };
  const hold = Math.max(...encoded.map((secret) => secret.byteLength)) - 1;
  /** The provider's own bytes that are not decided yet, and nothing else. */
  let pending = new Uint8Array(0);

  const startsAt = (buffer: Uint8Array, needle: Uint8Array, at: number): boolean => {
    if (at + needle.byteLength > buffer.byteLength) return false;
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (buffer[at + offset] !== needle[offset]) return false;
    }
    return true;
  };

  /**
   * The answer up to `upTo`, each secret replaced once in one left-to-right pass, and the position a later chunk picks up at.
   * `upTo` is the last place a secret can start and still finish inside `buffer`, so nothing before it is waiting for the next
   * chunk; a secret that starts earlier and reaches past it is complete and is answered here.
   */
  const decide = (buffer: Uint8Array, upTo: number): { parts: Uint8Array[]; at: number } => {
    const parts: Uint8Array[] = [];
    let from = 0;
    let at = 0;
    while (at < upTo) {
      const secret = encoded.find((candidate) => startsAt(buffer, candidate, at));
      if (secret === undefined) {
        at += 1;
        continue;
      }
      parts.push(buffer.subarray(from, at), REDACTED);
      at += secret.byteLength;
      from = at;
    }
    if (from < at) parts.push(buffer.subarray(from, at));
    return { parts, at };
  };

  /** One message per chunk for the page, whatever number of pieces the pass made of it. */
  const emit = (parts: readonly Uint8Array[]): void => {
    const only = parts.length === 1 ? parts[0] : undefined;
    if (only !== undefined) {
      sink(only);
      return;
    }
    if (parts.length === 0) return;
    const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    sink(out);
  };

  return {
    write(bytes) {
      const joined = new Uint8Array(pending.byteLength + bytes.byteLength);
      joined.set(pending);
      joined.set(bytes, pending.byteLength);
      const decided = decide(joined, Math.max(0, joined.byteLength - hold));
      pending = joined.slice(decided.at);
      emit(decided.parts);
    },
    end() {
      const decided = decide(pending, pending.byteLength);
      pending = new Uint8Array(0);
      emit(decided.parts);
    },
  };
}
