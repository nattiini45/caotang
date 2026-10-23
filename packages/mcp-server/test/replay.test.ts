/**
 * The replay cache that lets a retried write request write once: the key a request may carry, and the TTL map under the cache
 * (the confirmation ledger's primitive). The wire behaviour is in server.test.ts.
 */

import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/server';

import { createReplayCache, idempotencyKeyOf, MAX_IDEMPOTENCY_KEY_LENGTH, REPLAY_TTL_MS } from '../src/index.js';
import { createTtlMap } from '../src/ttl-map.js';

const KEY = 'app.caotang/idempotencyKey';
const answered = (retryable: boolean) => Promise.resolve({ result: { content: [] } satisfies CallToolResult, retryable });

describe('idempotencyKeyOf', () => {
  it('reads a non-blank string under the project key only', () => {
    expect(idempotencyKeyOf({ [KEY]: 'req-1' })).toBe('req-1');
    expect(idempotencyKeyOf(undefined)).toBeUndefined();
    expect(idempotencyKeyOf({})).toBeUndefined();
    expect(idempotencyKeyOf({ idempotencyKey: 'bare' })).toBeUndefined();
    expect(idempotencyKeyOf({ 'io.modelcontextprotocol/idempotencyKey': 'reserved' })).toBeUndefined();
  });

  it('ignores a key that is blank, too long, or not a string', () => {
    expect(idempotencyKeyOf({ [KEY]: '  ' })).toBeUndefined();
    expect(idempotencyKeyOf({ [KEY]: 'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH) })).toBe('k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH));
    expect(idempotencyKeyOf({ [KEY]: 'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1) })).toBeUndefined();
    expect(idempotencyKeyOf({ [KEY]: 42 })).toBeUndefined();
  });
});

describe('createReplayCache', () => {
  it('holds an entry for the retry window and sweeps it on the read that finds it dead', () => {
    const cache = createReplayCache();
    const entry = { tool: 'notes.append', digest: 'd', answer: answered(false) };
    cache.remember('k', entry, 1_000);
    expect(cache.recall('k', 1_000 + REPLAY_TTL_MS - 1)).toBe(entry);
    expect(cache.recall('k', 1_000 + REPLAY_TTL_MS)).toBeUndefined();
    expect(cache.recall('never', 0)).toBeUndefined();
  });

  it('forgets an entry whose call was refused, and keeps one whose change was made', async () => {
    const cache = createReplayCache();
    const refused = { tool: 'notes.append', digest: 'd', answer: answered(true) };
    const written = { tool: 'notes.append', digest: 'd', answer: answered(false) };
    cache.remember('refused', refused, 0);
    cache.remember('written', written, 0);
    await refused.answer;
    await written.answer;
    await Promise.resolve();
    expect(cache.recall('refused', 1)).toBeUndefined();
    expect(cache.recall('written', 1)).toBe(written);
  });
});

describe('createTtlMap', () => {
  it('deletes an entry only while it still holds the value given', () => {
    const map = createTtlMap<string>();
    map.set('k', 'first', 100, 0);
    map.set('k', 'second', 100, 0);
    map.delete('k', 'first');
    expect(map.get('k', 1)).toBe('second');
    map.delete('k', 'second');
    expect(map.get('k', 1)).toBeUndefined();
  });
});
