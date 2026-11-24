/**
 * What a page may put in the keychain — desktop.md §The keychain.
 *
 * The page is untrusted, so the host parses what arrives on the vault channels before it seals anything: every value is text,
 * every bound is one the vault already keeps, and a payload that holds nothing at all is not a payload. A payload may carry an
 * **empty key** when it also carries at least one header, because a profile that authenticates with its own headers alone has no
 * bearer key to store, and the empty key is what tells the page that later (#868).
 *
 * Parsing answers `undefined` for anything the vault may not hold; the shell answers the page's one refusal with that.
 */

import type { KeyPayload } from './key-store.js';

/** The most headers one entry may hold, the same ceiling a generic profile's custom headers have. */
const MAX_HEADERS = 64;
/** The longest key or header value the vault accepts. */
const MAX_VALUE = 8192;
/** The longest header name the vault accepts. */
const MAX_HEADER_NAME = 256;

/** The headers a page may hand back, under their names, or undefined when the shape is not one the vault may hold. */
export function parseVaultHeaders(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_HEADERS) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, header] of entries) {
    if (typeof header !== 'string' || header.length > MAX_VALUE || name === '' || name.length > MAX_HEADER_NAME) return undefined;
    headers[name] = header;
  }
  return headers;
}

/**
 * A payload the page may store: a key, and a generic endpoint's extra headers, all text and all bounded. An empty key is stored
 * as an empty key when headers come with it, and refused when they do not — there would be nothing to seal.
 */
export function parseVaultPayload(value: unknown): KeyPayload | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const candidate = value as { apiKey?: unknown; customHeaders?: unknown };
  const apiKey = candidate.apiKey;
  if (typeof apiKey !== 'string' || apiKey.length > MAX_VALUE) return undefined;
  const headers = candidate.customHeaders === undefined ? {} : parseVaultHeaders(candidate.customHeaders);
  if (headers === undefined) return undefined;
  // Nothing to seal is not an entry: a payload with neither a key nor a header would answer every question about it with nothing.
  if (apiKey === '' && Object.keys(headers).length === 0) return undefined;
  return { apiKey, ...(Object.keys(headers).length === 0 ? {} : { customHeaders: headers }) };
}
