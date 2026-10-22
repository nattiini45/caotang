/**
 * The local request log — [provider-gateway.md §4](docs/architecture/provider-gateway.md):
 * every request and response, retries included, capped at 50 entries per session, for
 * the inspectable UI.
 *
 * An entry says what was asked and what came back: the endpoint URL (which carries no
 * credential, because the key travels in a header and a base URL with a query string
 * is rejected at save time), the model, the attempt number, the outcome, and a short
 * redacted note. It never holds a body, a header, or the key. That is why §4 can say
 * "no redaction needed": there is nothing in an entry that needs redacting, and the
 * note is redacted anyway as a second line of defence.
 */

import type { ProviderErrorKind } from './errors.js';

export const REQUEST_LOG_CAP = 50;

export type RequestOutcome = 'ok' | 'retrying' | 'failed' | 'cancelled' | 'refused';

export interface RequestLogEntry {
  readonly at: number;
  readonly profileId: string;
  readonly model: string;
  /** 0 for the first attempt, 1 for the first retry, and so on */
  readonly attempt: number;
  readonly url: string;
  /** The output cap the request was sent with, thinking room included, so a writer can see why a call cost more output. */
  readonly maxTokens?: number;
  readonly outcome: RequestOutcome;
  readonly status?: number;
  readonly errorKind?: ProviderErrorKind;
  readonly note?: string;
}

export class RequestLog {
  private readonly items: RequestLogEntry[] = [];

  constructor(private readonly cap: number = REQUEST_LOG_CAP) {}

  append(entry: RequestLogEntry): void {
    this.items.push(Object.freeze({ ...entry }));
    const excess = this.items.length - this.cap;
    if (excess > 0) this.items.splice(0, excess);
  }

  /** Oldest first. A copy, so the caller cannot edit the log. */
  entries(): RequestLogEntry[] {
    return [...this.items];
  }
}
