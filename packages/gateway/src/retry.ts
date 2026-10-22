/**
 * Retry and timeout policy — [provider-gateway.md §4](docs/architecture/provider-gateway.md).
 *
 * The contract, as numbers:
 *  - up to 2 retries, backoff 1s then 4s, each with ±20% jitter;
 *  - a `Retry-After` from the provider replaces the backoff for that retry;
 *  - connect 10s, first token 30s, idle between chunks 60s, the whole request 5 min;
 *  - a stream that has delivered output is never retried, because the caller has seen
 *    part of an answer and a second attempt would repeat it.
 */

import type { ProviderError } from './errors.js';

export interface RetryPolicy {
  /** retries after the first attempt */
  readonly maxRetries: number;
  /** backoff before each retry, in order; the last value repeats past the end */
  readonly delaysMs: readonly number[];
  /** fraction of the delay to vary by, either way */
  readonly jitter: number;
}

export interface TransportTimeouts {
  readonly connectMs: number;
  readonly firstTokenMs: number;
  readonly idleMs: number;
  readonly totalMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: 2,
  delaysMs: [1_000, 4_000],
  jitter: 0.2,
};

export const DEFAULT_TIMEOUTS: TransportTimeouts = {
  connectMs: 10_000,
  firstTokenMs: 30_000,
  idleMs: 60_000,
  totalMs: 300_000,
};

/**
 * The wait before retry number `retryIndex` (0-based). `random` is injected so tests
 * can pin the jitter: at 0.5 the factor is exactly 1, at 0 it is 0.8, and it stays
 * below 1.2 for any value in [0, 1).
 */
export function backoffMs(retryIndex: number, random: () => number, policy: RetryPolicy): number {
  const index = Math.min(retryIndex, policy.delaysMs.length - 1);
  const base = policy.delaysMs[index] ?? 0;
  const jitter = (random() * 2 - 1) * policy.jitter;
  return Math.round(base * (1 + jitter));
}

/**
 * Parses a `Retry-After` header, which is either a count of seconds or an HTTP date.
 * Returns undefined when the header is absent or unreadable, so the caller falls back
 * to the backoff rather than trusting a malformed value.
 */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const dated = Date.parse(trimmed);
  if (Number.isFinite(dated)) return Math.max(0, dated - now);
  return undefined;
}

/**
 * Whether a failure is worth another attempt, before any output has been delivered.
 * Only transport trouble, rate limits, and 5xx qualify. A 401, a 404, a context-length
 * refusal, a malformed stream, and a provider's in-stream error are the same answer on
 * every try, so retrying them only delays the message.
 */
export function isRetryable(error: ProviderError): boolean {
  if (error.permanent) return false;
  if (error.kind === 'network' || error.kind === 'rate_limit') return true;
  return error.kind === 'provider' && error.status !== undefined && error.status >= 500;
}
