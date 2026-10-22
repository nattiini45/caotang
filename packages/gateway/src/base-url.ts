/**
 * Base URL validation and normalisation — [provider-gateway.md §2](docs/architecture/provider-gateway.md).
 *
 * The gateway always POSTs `{baseUrl}/chat/completions`, so the base must be the part
 * of the URL that precedes the endpoint: pathless (`https://api.openai.com`) or carrying
 * a version (`https://openrouter.ai/api/v1`). A base that already names an endpoint is
 * rejected, because appending another one produces a URL that cannot work.
 *
 * Where the spec's wording is narrower than the providers it has to serve, this file
 * follows the intent and not the literal words. The spec says a base must *end* in a
 * version or be pathless. Google's documented OpenAI-compatible base is
 * `…/v1beta/openai`, which ends in neither, and it is a real endpoint. So a base is
 * accepted when it is pathless or carries a version segment, and only the endpoint
 * suffixes are refused.
 */

import { ProfileError } from './errors.js';
import { isLoopbackHost, isLoopbackLiteral } from './loopback.js';

/** The only baseUrl a MOCK profile carries. Nothing reads it as an address. */
export const MOCK_BASE_URL = 'mock://caotang';

/** Endpoint paths a base must not end in: the gateway appends the endpoint itself. */
const ENDPOINT_SUFFIX = /\/(chat\/completions|completions|responses|embeddings|models)$/i;

/** A path segment that is an API version: `v1`, `v1beta`, `v2alpha`. */
const VERSION_SEGMENT = /^v\d+[a-z0-9.]*$/i;

export { isLoopbackHost, isLoopbackLiteral };

/** True when a normalised base points at this machine. */
export function isLoopbackBase(baseUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/** True when a base points at this computer by a literal address (`localhost`, 127.0.0.0/8, `[::1]`): the only hosts a local model preset accepts. */
export function isLocalBase(baseUrl: string): boolean {
  try {
    return isLoopbackLiteral(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

function invalid(reason: string, example = 'https://api.openai.com/v1'): ProfileError {
  return new ProfileError('invalid', `The base URL ${reason}. For example ${example}.`, 'baseUrl');
}

/** The path without its trailing slashes, by a scan: a regex over untrusted text is avoided. */
function trimSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47) end -= 1;
  return path.slice(0, end);
}

/** What both normalisers share: parse, refuse credentials, query and fragment, and check the path. The scheme and host are the caller's. */
function parsePath(input: string, example: string): { url: URL; path: string } {
  const raw = input.trim();
  if (raw.length === 0) throw invalid('is empty', example);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('is not a URL', example);
  }
  return { url, path: trimSlashes(url.pathname) };
}

function checkPath(url: URL, path: string, example: string): void {
  if (url.username !== '' || url.password !== '') throw invalid('must not contain a username or password', example);
  if (url.search !== '' || url.hash !== '') throw invalid('must not contain a query string or fragment', example);
  if (ENDPOINT_SUFFIX.test(path)) {
    throw invalid('is a full endpoint path. Enter the base only, usually ending in /v1', example);
  }
  if (path !== '' && !path.split('/').some((segment) => VERSION_SEGMENT.test(segment))) {
    throw invalid('must be pathless or carry a version, such as /v1', example);
  }
}

/**
 * Validates and normalises a base URL for an `endpoint` profile.
 *
 * HTTPS only — a key is never sent in plain text. A server on this computer is reached through a
 * local model preset and `normalizeLocalBaseUrl`, never through this.
 *
 * Returns the origin plus the path with trailing slashes removed, so `https://x.io/v1/`
 * and `https://x.io/v1` store the same string. Throws a `ProfileError` naming the
 * problem; the message is written for the settings form to show as-is.
 */
export function normalizeBaseUrl(input: string): string {
  const example = 'https://api.openai.com/v1';
  const { url, path } = parsePath(input, example);
  if (url.protocol !== 'https:') throw invalid('must start with https://, so the key is never sent in plain text', example);
  checkPath(url, path, example);
  return `${url.origin}${path}`;
}

/**
 * The base URL rule for a local model preset (Ollama, LM Studio, llama.cpp). `http://` or `https://`, but only to a
 * literal address of this computer: `localhost`, 127.0.0.0/8 or `[::1]`. A LAN address, a `*.local` or `*.localhost`
 * name, a look-alike such as `127.evil.example` and a URL with credentials are refused. The hostname is parsed from the
 * URL and judged by its text; DNS is never consulted. Otherwise the shape rules of `normalizeBaseUrl` apply.
 */
export function normalizeLocalBaseUrl(input: string): string {
  const example = 'http://127.0.0.1:11434/v1';
  const { url, path } = parsePath(input, example);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('must start with http:// or https://', example);
  if (url.username !== '' || url.password !== '') throw invalid('must not contain a username or password', example);
  if (!isLoopbackLiteral(url.hostname)) {
    throw invalid(
      'must point at this computer (127.0.0.1, localhost or [::1]): plain http is allowed only to this computer, so a key or manuscript is never sent unencrypted over a network. For another server, use the OpenAI-compatible endpoint with an https:// address',
      example,
    );
  }
  checkPath(url, path, example);
  return `${url.origin}${path}`;
}

/** The origin the egress guard compares request URLs against. */
export function originOf(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

/** The host a user recognises, for messages. Never includes credentials. */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
