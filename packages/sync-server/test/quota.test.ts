import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';
import { quotaMachine } from '../src/quota-lifecycle.js';
import { QuotaStore, reconcileQuota } from '../src/quota.js';
import type { QuotaSettlement } from '../src/quota.js';

let runtime: Miniflare;
let db: D1Database;

beforeEach(async () => {
  runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("local"); } }',
    compatibilityDate: '2026-07-30',
    d1Databases: ['DB'],
  });
  db = await runtime.getD1Database('DB');
  for (const name of ['0001_accounts.sql', '0002_quota.sql']) {
    await db.exec(readFileSync(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url).href), 'utf8').replaceAll('\n', ' '));
  }
}, 30_000);

afterEach(async () => { await runtime?.dispose(); });

async function account(accountId: string, limit = 10) {
  await db.prepare('INSERT INTO accounts (account_id, github_id, login, quota_limit) VALUES (?, ?, ?, ?)')
    .bind(accountId, accountId, 'fictional-reader', limit).run();
  return new QuotaStore(db, { accountId, revision: 1 }, { leaseMs: 100, now: () => 1_000 });
}

class FakeUploader {
  readonly objects = new Set<string>();
  readonly fenced = new Set<string>();
  readonly stuck = new Set<string>();
  available = true;
  failWithError = false;

  write(accountId: string, operationId: string, objectKey: string): boolean {
    if (this.fenced.has(`${accountId}/${operationId}`)) return false;
    this.objects.add(`${accountId}/${objectKey}`);
    return true;
  }

  async settle(operation: QuotaSettlement): Promise<boolean> {
    if (this.failWithError) throw new Error(`private-adapter-error:${operation.objectKey}`);
    if (!this.available || this.stuck.has(`${operation.accountId}/${operation.operationId}`)) return false;
    this.fenced.add(`${operation.accountId}/${operation.operationId}`);
    this.objects.delete(`${operation.accountId}/${operation.objectKey}`);
    return !this.objects.has(`${operation.accountId}/${operation.objectKey}`);
  }
}

describe('the D1 quota seam', () => {
  it('has an exhaustive lifecycle whose terminal states cannot release retained data', () => {
    expect(checkMachine(quotaMachine, {
      states: [{ kind: 'reserved' }, { kind: 'writing' }, { kind: 'committed' }, { kind: 'aborted' }, { kind: 'released' }],
      events: [{ type: 'begin' }, { type: 'commit' }, { type: 'cancel' }, { type: 'abort' }, { type: 'settle' }],
    })).toEqual([]);
  });
  it('reserves the exact allowance once and refuses one byte over', async () => {
    const store = await account('account-boundary');
    expect(await store.usage()).toEqual({ limitBytes: 10, usedBytes: 0, reservedBytes: 0 });
    const first = await store.reserve('op-one', 'object-one', 10);
    expect(first).toMatchObject({ ok: true, operation: { state: 'reserved', bytes: 10, deadline: 1_100 } });
    expect(await store.reserve('op-one', 'object-one', 10)).toEqual(first);
    expect(await store.reserve('op-two', 'object-two', 1)).toEqual({ ok: false, reason: 'capacity' });
    expect(await store.usage()).toEqual({ limitBytes: 10, usedBytes: 0, reservedBytes: 10 });
  });

  it('moves reserved bytes to retained usage once and recovers across store instances', async () => {
    const store = await account('account-commit');
    await store.reserve('op-one', 'object-one', 7);
    expect(await store.commit('op-one')).toEqual({ ok: false, reason: 'transition' });
    expect(await store.beginWrite('op-one')).toMatchObject({ ok: true, operation: { state: 'writing' } });
    const recovered = new QuotaStore(db, { accountId: 'account-commit', revision: 1 }, { leaseMs: 100, now: () => 1_050 });
    const committed = await recovered.commit('op-one');
    expect(committed).toMatchObject({ ok: true, operation: { state: 'committed' } });
    expect(await recovered.commit('op-one')).toEqual(committed);
    expect(await recovered.cancel('op-one')).toEqual({ ok: false, reason: 'transition' });
    expect(await recovered.usage()).toEqual({ limitBytes: 10, usedBytes: 7, reservedBytes: 0 });
    await recovered.reserve('op-two', 'object-two', 3);
    expect(await recovered.cancel('op-two')).toMatchObject({ ok: true, operation: { state: 'released' } });
    expect(await recovered.usage()).toEqual({ limitBytes: 10, usedBytes: 7, reservedBytes: 0 });
  });

  it('settles a started expired write before releasing and fences a delayed writer', async () => {
    const store = await account('account-lease');
    const uploader = new FakeUploader();
    await store.reserve('lease-op', 'lease-object', 10);
    await store.beginWrite('lease-op');
    expect(uploader.write('account-lease', 'lease-op', 'lease-object')).toBe(true);
    expect(await reconcileQuota(db, uploader, { now: () => 1_099, batchSize: 10 })).toEqual({ examined: 0, released: 0, deferred: 0 });
    expect(await store.usage()).toEqual({ limitBytes: 10, usedBytes: 0, reservedBytes: 10 });
    expect(await reconcileQuota(db, uploader, { now: () => 1_100, batchSize: 10 })).toEqual({ examined: 1, released: 1, deferred: 0 });
    expect(uploader.objects.size).toBe(0);
    expect(uploader.write('account-lease', 'lease-op', 'lease-object')).toBe(false);
    expect(await store.usage()).toEqual({ limitBytes: 10, usedBytes: 0, reservedBytes: 0 });
    expect(await store.commit('lease-op')).toEqual({ ok: false, reason: 'transition' });
    expect(await store.cancel('lease-op')).toMatchObject({ ok: true, operation: { state: 'released' } });
  });

  it('keeps failed settlements charged and releases on the first sweep after recovery with exact sanitized logs', async () => {
    const first = await account('account-outage');
    const second = await account('account-other');
    const uploader = new FakeUploader();
    for (const [store, accountId, operation, key] of [[first, 'account-outage', 'outage-one', 'opaque-one'], [first, 'account-outage', 'outage-two', 'opaque-two'], [second, 'account-other', 'outage-three', 'opaque-three']] as const) {
      await store.reserve(operation, key, 4);
      await store.beginWrite(operation);
      uploader.write(accountId, operation, key);
    }
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      uploader.available = false;
      expect(await reconcileQuota(db, uploader, { now: () => 1_100, batchSize: 10 })).toEqual({ examined: 3, released: 0, deferred: 3 });
      expect(log.mock.calls).toEqual([[{ accountId: 'account-other', objectCount: 1 }], [{ accountId: 'account-outage', objectCount: 2 }]]);
      log.mockClear();
      uploader.failWithError = true;
      expect(await reconcileQuota(db, uploader, { now: () => 1_200, batchSize: 10 })).toEqual({ examined: 3, released: 0, deferred: 3 });
      expect(log.mock.calls).toEqual([[{ accountId: 'account-other', objectCount: 1 }], [{ accountId: 'account-outage', objectCount: 2 }]]);
      expect(await first.usage()).toEqual({ limitBytes: 10, usedBytes: 0, reservedBytes: 8 });
      expect(uploader.objects.size).toBe(3);
      uploader.failWithError = false;
      uploader.available = true;
      log.mockClear();
      expect(await reconcileQuota(db, uploader, { now: () => 1_300, batchSize: 10 })).toEqual({ examined: 3, released: 3, deferred: 0 });
      expect(log).not.toHaveBeenCalled();
      const recovered = new QuotaStore(db, { accountId: 'account-outage', revision: 1 }, { leaseMs: 100, now: () => 1_300 });
      expect(await recovered.usage()).toEqual({ limitBytes: 10, usedBytes: 0, reservedBytes: 0 });
      expect(uploader.objects.size).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  it('releases expired, revoked and failed writes within a five-minute lease plus one-minute healthy sweep', async () => {
    for (const id of ['account-expired', 'account-revoked', 'account-failed']) await account(id);
    const stores = ['account-expired', 'account-revoked', 'account-failed'].map((accountId) =>
      new QuotaStore(db, { accountId, revision: 1 }, { leaseMs: 300_000, now: () => 0 }));
    const uploader = new FakeUploader();
    for (const [index, store] of stores.entries()) {
      await store.reserve(`bounded-${index}`, `bounded-object-${index}`, 10);
      await store.beginWrite(`bounded-${index}`);
      uploader.write(['account-expired', 'account-revoked', 'account-failed'][index]!, `bounded-${index}`, `bounded-object-${index}`);
    }
    await db.prepare("UPDATE accounts SET status = 'disabled', session_revision = 2 WHERE account_id = ?").bind('account-revoked').run();
    expect(await stores[1]!.commit('bounded-1')).toEqual({ ok: false, reason: 'unavailable' });
    expect(await stores[2]!.abort('bounded-2')).toMatchObject({ ok: true, operation: { state: 'aborted' } });
    expect(await stores[2]!.usage()).toEqual({ limitBytes: 10, usedBytes: 0, reservedBytes: 10 });
    expect(await reconcileQuota(db, uploader, { now: () => 60_000, batchSize: 10 })).toEqual({ examined: 2, released: 2, deferred: 0 });
    expect(await stores[2]!.usage()).toEqual({ limitBytes: 10, usedBytes: 0, reservedBytes: 0 });
    await db.prepare("UPDATE accounts SET status = 'active' WHERE account_id = ?").bind('account-revoked').run();
    const regranted = new QuotaStore(db, { accountId: 'account-revoked', revision: 2 }, { leaseMs: 300_000, now: () => 60_000 });
    expect(await regranted.usage()).toEqual({ limitBytes: 10, usedBytes: 0, reservedBytes: 0 });
    expect(await reconcileQuota(db, uploader, { now: () => 360_000, batchSize: 10 })).toEqual({ examined: 1, released: 1, deferred: 0 });
    expect(await stores[0]!.usage()).toEqual({ limitBytes: 10, usedBytes: 0, reservedBytes: 0 });
    expect(uploader.objects.size).toBe(0);
  });

  it('does not oversubscribe under concurrent reservations or charge concurrent retries twice', async () => {
    const store = await account('account-concurrent', 64);
    const attempts = await Promise.all(Array.from({ length: 16 }, (_, index) => store.reserve(`race-${index}`, `race-object-${index}`, 8)));
    expect(attempts.filter((result) => result.ok)).toHaveLength(8);
    expect(attempts.filter((result) => !result.ok)).toEqual(Array.from({ length: 8 }, () => ({ ok: false, reason: 'capacity' })));
    expect(await store.usage()).toEqual({ limitBytes: 64, usedBytes: 0, reservedBytes: 64 });
    const retryStore = await account('account-retries');
    const retries = await Promise.all(Array.from({ length: 12 }, () => retryStore.reserve('same-op', 'same-object', 10)));
    expect(retries.every((result) => result.ok)).toBe(true);
    expect(await retryStore.usage()).toEqual({ limitBytes: 10, usedBytes: 0, reservedBytes: 10 });
    await retryStore.beginWrite('same-op');
    await Promise.all(Array.from({ length: 12 }, () => retryStore.commit('same-op')));
    expect(await retryStore.usage()).toEqual({ limitBytes: 10, usedBytes: 10, reservedBytes: 0 });
  });

  it('keeps one immutable operation and object identity across retries and account scopes', async () => {
    const store = await account('account-identity');
    const first = await store.reserve('identity-op', 'identity-object', 6);
    const retry = new QuotaStore(db, { accountId: 'account-identity', revision: 1 }, { leaseMs: 10_000, now: () => 1_050 });
    expect(await retry.reserve('identity-op', 'identity-object', 6)).toEqual(first);
    expect(await retry.reserve('identity-op', 'different-object', 6)).toEqual({ ok: false, reason: 'conflict' });
    expect(await retry.reserve('identity-op', 'identity-object', 5)).toEqual({ ok: false, reason: 'conflict' });
    expect(await retry.reserve('different-op', 'identity-object', 6)).toEqual({ ok: false, reason: 'conflict' });
    const other = await account('account-isolated');
    expect(await other.beginWrite('identity-op')).toEqual({ ok: false, reason: 'not-found' });
    expect(await other.reserve('identity-op', 'identity-object', 6)).toMatchObject({ ok: true });
    await db.prepare('UPDATE accounts SET session_revision = 2 WHERE account_id = ?').bind('account-identity').run();
    expect(await store.usage()).toBeNull();
    expect(await store.reserve('new-op', 'new-object', 1)).toEqual({ ok: false, reason: 'unavailable' });
    expect(await store.beginWrite('identity-op')).toEqual({ ok: false, reason: 'unavailable' });
    expect(await store.cancel('identity-op')).toEqual({ ok: false, reason: 'unavailable' });
    const renewed = new QuotaStore(db, { accountId: 'account-identity', revision: 2 }, { leaseMs: 100, now: () => 1_050 });
    expect(await renewed.reserve('identity-op', 'identity-object', 6)).toEqual({ ok: false, reason: 'conflict' });
    expect(await renewed.beginWrite('identity-op')).toEqual({ ok: false, reason: 'conflict' });
    expect(await renewed.usage()).toEqual({ limitBytes: 10, usedBytes: 0, reservedBytes: 6 });
  });

  it('admits safe integer boundaries without rounding the allowance or deadlines', async () => {
    const store = await account('account-integer', Number.MAX_SAFE_INTEGER);
    for (const bytes of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await store.reserve('invalid-op', 'invalid-object', bytes)).toEqual({ ok: false, reason: 'invalid' });
    }
    for (const key of ['', 'x'.repeat(129), '../object', 'https://example.invalid/object', 'key\n']) {
      expect(await store.reserve('invalid-op', key, 1)).toEqual({ ok: false, reason: 'invalid' });
    }
    await store.reserve('maximum-op', 'maximum-object', Number.MAX_SAFE_INTEGER - 1);
    await store.beginWrite('maximum-op');
    await store.commit('maximum-op');
    expect(await store.reserve('last-op', 'last-object', 1)).toMatchObject({ ok: true });
    expect(await store.reserve('overflow-op', 'overflow-object', 1)).toEqual({ ok: false, reason: 'capacity' });
    expect(await store.usage()).toEqual({ limitBytes: Number.MAX_SAFE_INTEGER, usedBytes: Number.MAX_SAFE_INTEGER - 1, reservedBytes: 1 });
    const overflow = new QuotaStore(db, { accountId: 'account-integer', revision: 1 }, { leaseMs: 100, now: () => Number.MAX_SAFE_INTEGER });
    expect(await overflow.reserve('overflow-op', 'overflow-object', 0)).toEqual({ ok: false, reason: 'invalid' });
    expect(() => new QuotaStore(db, { accountId: 'account-integer', revision: 0 }, { leaseMs: 100 })).toThrow(RangeError);
    expect(() => new QuotaStore(db, { accountId: 'account-integer', revision: 1 }, { leaseMs: 0 })).toThrow(RangeError);
    expect(() => new QuotaStore(db, { accountId: 'account-integer', revision: 1 }, { leaseMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });

  it('never refunds a started cancellation or races a commit into a double release', async () => {
    const store = await account('account-cancel-race');
    await store.reserve('cancel-op', 'cancel-object', 10);
    await store.beginWrite('cancel-op');
    const uploader = new FakeUploader();
    uploader.write('account-cancel-race', 'cancel-op', 'cancel-object');
    await Promise.all([store.commit('cancel-op'), store.cancel('cancel-op'), store.abort('cancel-op')]);
    const after = await store.usage();
    expect(after).toSatisfy((usage: { usedBytes: number; reservedBytes: number }) =>
      (usage.usedBytes === 10 && usage.reservedBytes === 0) || (usage.usedBytes === 0 && usage.reservedBytes === 10));
    await Promise.all([
      reconcileQuota(db, uploader, { now: () => 1_100, batchSize: 10 }),
      reconcileQuota(db, uploader, { now: () => 1_100, batchSize: 10 }),
    ]);
    const final = await store.usage();
    expect(final).toEqual({ limitBytes: 10, usedBytes: after!.usedBytes, reservedBytes: 0 });
    expect(uploader.objects.size).toBe(after!.usedBytes === 10 ? 1 : 0);
    await Promise.all(Array.from({ length: 8 }, () => store.cancel('cancel-op')));
    expect(await store.usage()).toEqual(final);
  });

  it('cancels a reservation safely when begin and cancel compete and cannot reopen it', async () => {
    const store = await account('account-start-race');
    await store.reserve('start-op', 'start-object', 10);
    await Promise.all([store.beginWrite('start-op'), store.cancel('start-op')]);
    await store.cancel('start-op');
    const uploader = new FakeUploader();
    await reconcileQuota(db, uploader, { now: () => 1_100, batchSize: 10 });
    expect(await store.usage()).toEqual({ limitBytes: 10, usedBytes: 0, reservedBytes: 0 });
    expect(await store.reserve('start-op', 'start-object', 10)).toMatchObject({ ok: true, operation: { state: 'released' } });
    expect(await store.beginWrite('start-op')).toEqual({ ok: false, reason: 'transition' });
    expect(await store.usage()).toEqual({ limitBytes: 10, usedBytes: 0, reservedBytes: 0 });
  });

  it('refuses write admission and commit at the deadline without refunding on timeout alone', async () => {
    const store = await account('account-expiry');
    await store.reserve('expired-op', 'expired-object', 10);
    await store.beginWrite('expired-op');
    const expired = new QuotaStore(db, { accountId: 'account-expiry', revision: 1 }, { leaseMs: 100, now: () => 1_100 });
    expect(await expired.beginWrite('expired-op')).toEqual({ ok: false, reason: 'expired' });
    expect(await expired.commit('expired-op')).toEqual({ ok: false, reason: 'expired' });
    expect(await expired.usage()).toEqual({ limitBytes: 10, usedBytes: 0, reservedBytes: 10 });
    expect(await expired.cancel('expired-op')).toMatchObject({ ok: true, operation: { state: 'aborted' } });
    expect(await expired.usage()).toEqual({ limitBytes: 10, usedBytes: 0, reservedBytes: 10 });
  });

  it('bounds each sweep batch and retains committed charges through revocation and sweeping', async () => {
    const store = await account('account-batch');
    await store.reserve('retained-op', 'retained-object', 4);
    await store.beginWrite('retained-op');
    await store.commit('retained-op');
    for (let index = 0; index < 3; index++) await store.reserve(`batch-${index}`, `batch-object-${index}`, 2);
    await db.prepare('UPDATE accounts SET session_revision = 2 WHERE account_id = ?').bind('account-batch').run();
    const uploader = new FakeUploader();
    uploader.objects.add('account-batch/retained-object');
    expect(await reconcileQuota(db, uploader, { now: () => 1_050, batchSize: 2 })).toEqual({ examined: 2, released: 2, deferred: 0 });
    const renewed = new QuotaStore(db, { accountId: 'account-batch', revision: 2 }, { leaseMs: 100, now: () => 1_050 });
    expect(await renewed.usage()).toEqual({ limitBytes: 10, usedBytes: 4, reservedBytes: 2 });
    expect(await reconcileQuota(db, uploader, { now: () => 1_050, batchSize: 2 })).toEqual({ examined: 1, released: 1, deferred: 0 });
    expect(await renewed.usage()).toEqual({ limitBytes: 10, usedBytes: 4, reservedBytes: 0 });
    expect([...uploader.objects]).toEqual(['account-batch/retained-object']);
    for (const batchSize of [0, -1, 0.5, 1_001, Number.POSITIVE_INFINITY]) {
      await expect(reconcileQuota(db, uploader, { now: () => 1_050, batchSize })).rejects.toThrow(RangeError);
    }
  });

  it('blocks commit and restart while settlement is in flight and releases only after absence is confirmed', async () => {
    const store = await account('account-settling');
    await store.reserve('settling-op', 'settling-object', 10);
    await store.beginWrite('settling-op');
    const uploader = new FakeUploader();
    uploader.write('account-settling', 'settling-op', 'settling-object');
    let finish: () => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const allowed = new Promise<void>((resolve) => { finish = resolve; });
    const sweep = reconcileQuota(db, {
      async settle(operation) {
        entered();
        await allowed;
        return uploader.settle(operation);
      },
    }, { now: () => 1_100, batchSize: 10 });
    await started;
    expect(await store.commit('settling-op')).toEqual({ ok: false, reason: 'transition' });
    expect(await store.beginWrite('settling-op')).toEqual({ ok: false, reason: 'transition' });
    expect(await store.usage()).toEqual({ limitBytes: 10, usedBytes: 0, reservedBytes: 10 });
    finish();
    expect(await sweep).toEqual({ examined: 1, released: 1, deferred: 0 });
    expect(await store.usage()).toEqual({ limitBytes: 10, usedBytes: 0, reservedBytes: 0 });
    expect(uploader.write('account-settling', 'settling-op', 'settling-object')).toBe(false);
  });

  it('refuses to begin a write on a committed or released operation', async () => {
    const store = await account('account-terminal-begin');
    await store.reserve('committed-op', 'committed-object', 3);
    await store.beginWrite('committed-op');
    await store.commit('committed-op');
    await store.reserve('released-op', 'released-object', 3);
    await store.cancel('released-op');
    expect(await store.beginWrite('committed-op')).toEqual({ ok: false, reason: 'transition' });
    expect(await store.beginWrite('released-op')).toEqual({ ok: false, reason: 'transition' });
    expect(await store.usage()).toEqual({ limitBytes: 10, usedBytes: 3, reservedBytes: 0 });
  });

  it('samples the clock again after reading, so a lease that lapsed during the reads is refused', async () => {
    const seed = await account('account-clock');
    await seed.reserve('clock-op', 'clock-object', 5);
    let clock = 1_050;
    const lapsing = new Proxy(db, { get: (target, property) => property === 'withSession' ? (...args: Parameters<D1Database['withSession']>) => { clock = 1_100; return target.withSession(...args); } : Reflect.get(target, property) });
    const slow = new QuotaStore(lapsing, { accountId: 'account-clock', revision: 1 }, { leaseMs: 100, now: () => clock });
    expect(await slow.beginWrite('clock-op')).toEqual({ ok: false, reason: 'expired' });
    expect(await slow.usage()).toEqual({ limitBytes: 10, usedBytes: 0, reservedBytes: 5 });
  });

  it('retries a stuck settlement behind operations it has not yet tried', async () => {
    const store = await account('account-fair', 100);
    const uploader = new FakeUploader();
    for (const index of [1, 2, 3, 4]) {
      await store.reserve(`fair-${index}`, `fair-object-${index}`, 1);
      await store.beginWrite(`fair-${index}`);
      uploader.write('account-fair', `fair-${index}`, `fair-object-${index}`);
    }
    uploader.stuck.add('account-fair/fair-1');
    uploader.stuck.add('account-fair/fair-2');
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await reconcileQuota(db, uploader, { now: () => 1_100, batchSize: 2 })).toEqual({ examined: 2, released: 0, deferred: 2 });
      expect(await reconcileQuota(db, uploader, { now: () => 1_200, batchSize: 2 })).toEqual({ examined: 2, released: 2, deferred: 0 });
      expect(await store.usage()).toEqual({ limitBytes: 100, usedBytes: 0, reservedBytes: 2 });
      expect(await reconcileQuota(db, uploader, { now: () => 1_300, batchSize: 2 })).toEqual({ examined: 2, released: 0, deferred: 2 });
      uploader.stuck.clear();
      expect(await reconcileQuota(db, uploader, { now: () => 1_400, batchSize: 2 })).toEqual({ examined: 2, released: 2, deferred: 0 });
      expect(await store.usage()).toEqual({ limitBytes: 100, usedBytes: 0, reservedBytes: 0 });
    } finally {
      log.mockRestore();
    }
  });

  it('scopes writer fences and object identities to the account when two accounts share operation and object names', async () => {
    const first = await account('account-scope-one');
    const second = await account('account-scope-two');
    const uploader = new FakeUploader();
    for (const [store, accountId] of [[first, 'account-scope-one'], [second, 'account-scope-two']] as const) {
      await store.reserve('shared-op', 'shared-object', 4);
      await store.beginWrite('shared-op');
      uploader.write(accountId, 'shared-op', 'shared-object');
    }
    await db.prepare('UPDATE accounts SET session_revision = 2 WHERE account_id = ?').bind('account-scope-one').run();
    expect(await reconcileQuota(db, uploader, { now: () => 1_050, batchSize: 10 })).toEqual({ examined: 1, released: 1, deferred: 0 });
    expect([...uploader.objects]).toEqual(['account-scope-two/shared-object']);
    expect(uploader.write('account-scope-one', 'shared-op', 'shared-object')).toBe(false);
    expect(uploader.write('account-scope-two', 'shared-op', 'shared-object')).toBe(true);
    expect(await second.commit('shared-op')).toMatchObject({ ok: true, operation: { state: 'committed' } });
    expect(await second.usage()).toEqual({ limitBytes: 10, usedBytes: 4, reservedBytes: 0 });
  });
});
