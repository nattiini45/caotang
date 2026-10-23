/**
 * A map whose entries expire. The clock is passed in by the caller and a sweep of the dead runs on each read and write, so there is
 * no timer to leak and a test drives time by the numbers it passes. Both server-side memories of an answer are this shape: the
 * confirmation ledger (confirm.ts) and the idempotency replay cache (replay.ts). It lives in the process and is never written down.
 */
export interface TtlMap<V> {
  get(key: string, now: number): V | undefined;
  set(key: string, value: V, expiresAt: number, now: number): void;
  /** Drops the entry only if it still holds `value`, so a late settle never removes a newer entry stored under the same key. */
  delete(key: string, value: V): void;
}

export function createTtlMap<V>(): TtlMap<V> {
  const entries = new Map<string, { readonly value: V; readonly expiresAt: number }>();
  const sweep = (now: number): void => {
    for (const [key, entry] of entries) if (entry.expiresAt <= now) entries.delete(key);
  };
  return {
    get(key, now) {
      sweep(now);
      return entries.get(key)?.value;
    },
    set(key, value, expiresAt, now) {
      sweep(now);
      entries.set(key, { value, expiresAt });
    },
    delete(key, value) {
      if (entries.get(key)?.value === value) entries.delete(key);
    },
  };
}
