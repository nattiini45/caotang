/**
 * Secret scrubbing for anything the gateway writes out — error details, request-log
 * notes, excerpts quoted from a provider's body.
 *
 * Two layers, because either alone leaks. The first is the literal key: a provider that
 * echoes the caller's key in an error body (several do, and quote its prefix in their
 * "invalid key" messages) is caught by replacing every occurrence. The second is the
 * shape of a credential, for a key the gateway does not hold, such as one a provider
 * quotes from some other request. The literal match catches what we know about; the
 * pattern catches what we do not.
 */

const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SK_TOKEN = /\bsk-[A-Za-z0-9_-]{8,}/g;

/** What every redaction puts in a secret's place, here and in an answer's bytes. */
export const REDACTED_SECRET = '[redacted]';

/**
 * `text` with every one of `secrets` replaced once, in one pass.
 *
 * What a replacement writes is never looked at again. A key may be one character — a generic profile's `checkKey` accepts any
 * text, and so does the vault — and a one-character key sits inside `REDACTED_SECRET` itself, so a pass that read its own output
 * as candidate text would never finish (#870). The longest secret wins where several start at the same character, because a
 * profile's key and a header value can both hold the same text, and redacting the shorter one first would leave the rest of the
 * longer one in place.
 */
export function redactLiterals(text: string, secrets: readonly (string | undefined)[]): string {
  const ordered = [...new Set(secrets.filter((secret): secret is string => secret !== undefined && secret.length > 0))]
    .sort((one, other) => other.length - one.length);
  if (ordered.length === 0) return text;
  let out = '';
  let at = 0;
  while (at < text.length) {
    const found = ordered.find((secret) => text.startsWith(secret, at));
    if (found === undefined) {
      out += text.charAt(at);
      at += 1;
      continue;
    }
    out += REDACTED_SECRET;
    at += found.length;
  }
  return out;
}

export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  return redactLiterals(text, secrets).replace(BEARER, `Bearer ${REDACTED_SECRET}`).replace(SK_TOKEN, REDACTED_SECRET);
}

/**
 * `redact` applied to every string in a plain value: arrays and plain objects are copied, a string is scrubbed, anything else
 * (numbers, booleans, null, a class instance) is returned as it is. The trace observer's events pass through here so no
 * consumer ever sees the call's secrets.
 */
export function redactDeep<T>(value: T, secrets: readonly (string | undefined)[] = []): T {
  if (typeof value === 'string') return redact(value, secrets) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => redactDeep(item, secrets)) as T;
  const proto: unknown = value !== null && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (value !== null && typeof value === 'object' && (proto === Object.prototype || proto === null)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item, secrets);
    return out as T;
  }
  return value;
}
