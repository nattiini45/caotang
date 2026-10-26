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

export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== undefined && secret.length > 0) out = out.split(secret).join('[redacted]');
  }
  return out.replace(BEARER, 'Bearer [redacted]').replace(SK_TOKEN, '[redacted]');
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
