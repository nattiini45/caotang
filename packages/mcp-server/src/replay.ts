/**
 * The replay cache: how a retried write request writes once (extensibility.md §9, command-bus.md §6).
 *
 * Every request is its own turn, so the bus's replay cache, keyed on a turn and call id the server minted and ended with
 * the request, cannot see a retry. A caller that wants the guarantee sends a key in the request's `_meta`
 * (`IDEMPOTENCY_KEY_META`), and the server remembers the answer under it for a short window. The key is optional: a request
 * without one is a new call, as it always was. The cache is the confirmation ledger's primitive (ttl-map.ts) over a second
 * key space, and like the ledger it is in the process only: it can hold writer text, so it is never written to the folder, and a
 * restart ends it.
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import { IDEMPOTENCY_KEY_META } from '@caotang/harness';

import { createTtlMap } from './ttl-map.js';

/** The retry window: how long a key keeps its answer. A host's retry comes in seconds to minutes, not the confirmation's half hour. */
export const REPLAY_TTL_MS = 5 * 60 * 1000;

/** The longest key accepted. A longer one is ignored, and the call is a new call. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/** What a keyed call settled to: the answer, and whether a repeat may run the call again because this one wrote nothing. */
export interface ReplayAnswer {
  readonly result: CallToolResult;
  readonly retryable: boolean;
}

/** A keyed call: which tool and arguments it was for, and its answer, stored before the write's save is awaited. */
export interface ReplayEntry {
  readonly tool: string;
  readonly digest: string;
  readonly answer: Promise<ReplayAnswer>;
}

export interface ReplayCache {
  recall(key: string, now: number): ReplayEntry | undefined;
  remember(key: string, entry: ReplayEntry, now: number): void;
}

export function createReplayCache(): ReplayCache {
  const entries = createTtlMap<ReplayEntry>();
  return {
    recall: (key, now) => entries.get(key, now),
    remember(key, entry, now) {
      entries.set(key, entry, now + REPLAY_TTL_MS, now);
      // A call that was refused wrote nothing, so a repeat runs it again and may succeed. A failure after the change was made in
      // memory is kept: running it again would write twice.
      void entry.answer.then(
        ({ retryable }) => {
          if (retryable) entries.delete(key, entry);
        },
        () => entries.delete(key, entry),
      );
    },
  };
}

/**
 * The key a request carries, or `undefined` when it carries none the server accepts: only our own name is read, and only a
 * non-blank string of bounded length. A reserved `io.modelcontextprotocol/*` name is the SDK's, never a key, and any other foreign
 * `_meta` key is left alone.
 */
export function idempotencyKeyOf(meta: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const key = meta?.[IDEMPOTENCY_KEY_META];
  if (typeof key !== 'string' || key.trim() === '' || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) return undefined;
  return key;
}
