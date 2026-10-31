/**
 * Gateway errors — [provider-gateway.md §4](docs/architecture/provider-gateway.md).
 *
 * The taxonomy is closed: seven kinds, each with one user-facing message written for
 * the person or the model to act on. The messages name the corrective surface
 * (Settings, the activity log) rather than a bare status, per §4.
 *
 * **Secrets.** No template in this file takes the API key. Each takes a host, a path,
 * a base URL, a status, or an excerpt the transport has already passed through
 * `redact()`. A provider that echoes the key back inside an error body is harmless:
 * the echo is replaced before anything can quote it.
 */

export type ProviderErrorKind =
  | 'network'
  | 'auth'
  | 'endpoint'
  | 'rate_limit'
  | 'provider'
  | 'protocol'
  | 'context_length';

export interface ProviderErrorInit {
  /** HTTP status, when the failure came from a response */
  status?: number;
  /** diagnostic text, already redacted. Logs and tests read it; the UI shows `message`. */
  detail?: string;
  /** the `Retry-After` the provider asked for, in milliseconds */
  retryAfterMs?: number;
  /** A second attempt cannot change the answer, whatever the kind says (a browser's CORS refusal of a local server). */
  permanent?: boolean;
  /** The browser's `fetch` rejected without an HTTP answer and without saying why: a CORS refusal looks the same as a dropped connection. */
  rejected?: boolean;
}

/** A failure the harness can act on. Thrown from `complete` and `listModels`. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;
  readonly detail: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly permanent: boolean;
  readonly rejected: boolean;

  constructor(kind: ProviderErrorKind, message: string, init: ProviderErrorInit = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = init.status;
    this.detail = init.detail;
    this.retryAfterMs = init.retryAfterMs;
    this.permanent = init.permanent === true;
    this.rejected = init.rejected === true;
  }
}

/**
 * §4's user-facing text. Kept as functions so the wording is in one place and the
 * tests can assert it byte for byte.
 */
export const providerMessages = {
  network: (host: string, reason?: string): string =>
    `Could not reach ${host}${reason ? ` (${reason})` : ''}. Check your connection and the base URL in Settings.`,
  auth: (host: string): string => `Key rejected by ${host}. Check the profile in Settings.`,
  endpoint: (path: string, baseUrl: string): string =>
    `No ${path} at ${baseUrl}. Most OpenAI-compatible bases end in /v1.`,
  rateLimit: (host: string): string =>
    `${host} is rate limiting this profile. Wait a moment and try again, or switch profiles in Settings.`,
  provider: (host: string, status: number, excerpt: string): string =>
    `${host} returned HTTP ${status}${excerpt ? `: ${excerpt}` : '.'}`,
  providerStream: (host: string, excerpt: string): string => `${host} reported an error: ${excerpt}`,
  protocol: (host: string, excerpt: string): string => `${host} sent a response Caotang could not read: ${excerpt}`,
  contextLength: (promptTokens: number, window: number | string): string =>
    `Prompt ≈ ${promptTokens} tokens exceeds model window (${window}). Reduce context: see activity log token budget.`,
  /**
   * The model list of a preset the sweep found browser-reachable, when the browser rejected that one request. The chat route is
   * a different request and may answer; a mistyped key can look the same, because a provider's 401 for the list may carry no
   * CORS header. So it says what was not read, not that the host cannot be reached.
   */
  modelListUnreadable: (host: string): string =>
    `The browser did not let this page read the model list from ${host}. That happens when the connection is down, and also when ${host} does not allow a web page to read that answer (a mistyped key can look the same). Chat may still work: send a message to find out, or check the key in Settings.`,
  /** A model server on this computer that the browser could not use. `fix` is the preset's exact setting. */
  localCors: (product: string, fix: string): string =>
    `${product} did not accept the request from this page, so the browser blocked it. ${fix}`,
  localRefused: (product: string, address: string): string =>
    `Nothing is listening on ${address}. Is ${product} running? Start it, or correct the address in Settings.`,
  localDenied: (product: string): string =>
    `Your browser blocked this page from reaching ${product} on this computer. Allow this site to connect to apps on your device in the browser’s site settings, then try again.`,
  missingKey: (name: string): string =>
    `The key stored for "${name}" cannot be read on this device. Enter it again in Settings.`,
  aborted: 'The request was aborted.',
};

/**
 * A request the egress guard refused. Not a provider failure, so it is not one of the
 * seven kinds: the gateway never sent anything, and retrying cannot change the answer.
 */
export class EgressDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressDeniedError';
  }
}

export type ProfileErrorCode = 'invalid' | 'not-found' | 'no-active' | 'key-unreadable';

/** A profile operation the store or gateway refused. `field` names the form field, when there is one. */
export class ProfileError extends Error {
  readonly code: ProfileErrorCode;
  readonly field: string | undefined;

  constructor(code: ProfileErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
    this.field = field;
  }
}

/** The error a cancelled request surfaces from calls that return a value rather than a stream. */
export function abortError(): Error {
  const error = new Error(providerMessages.aborted);
  error.name = 'AbortError';
  return error;
}
