/**
 * The IndexedDB binding's own contract.
 *
 * `memory-idb.ts` is 900+ lines of the one thing in this package that is *not*
 * the product: a test double standing in for a browser API. Its value is exactly
 * inverse to its line count — a binding that quietly agrees with whatever the
 * store happens to do makes the atomicity and concurrency tests prove nothing
 * about a browser. docs/decisions.md put it
 * plainly: "A test binding is only worth its lines if its bugs are findable this
 * way."
 *
 * So the properties below are tested the only way a double can be: by using the
 * real API in a way the real API refuses. Each one is mutation-checked — the
 * mutation that removes the behaviour, the test that catches it.
 */

import { describe, expect, it } from 'vitest';
import { MemoryIndexedDb } from '../src/runtime/memory-idb.js';
import { DOCUMENT_STORE, PROJECT_STORE, SESSION_STORE, openRuntimeStore } from '../src/runtime/store.js';

const DB = 'caotang-binding-test';

describe('open requests release their queue and respect closing transactions', () => {
  it.each(['throw', 'abort'] as const)('rolls back a failed %s upgrade and lets the next queued open finish', async (failure) => {
    const factory = new MemoryIndexedDb();
    const initial = factory.open(DB, 1);
    initial.onupgradeneeded = () => initial.result.createObjectStore('kept', { keyPath: 'id' });
    await new Promise<void>((resolve) => { initial.onsuccess = () => resolve(); });
    initial.result.close();
    const boom = new Error('The upgrade handler failed');
    const order: string[] = [];
    const bad = factory.open(DB, 2);
    bad.onupgradeneeded = () => {
      bad.transaction!.onabort = () => { order.push('abort'); };
      bad.result.deleteObjectStore('kept');
      bad.result.createObjectStore('partial', { keyPath: 'id' });
      if (failure === 'throw') throw boom;
      bad.transaction!.abort();
    };
    const failed = new Promise<void>((resolve, reject) => {
      bad.onerror = () => { order.push('error'); resolve(); };
      bad.onsuccess = () => reject(new Error('An aborted upgrade must not succeed'));
    });
    const next = factory.open(DB, 1);
    const resumed = new Promise<IDBDatabase>((resolve, reject) => {
      next.onsuccess = () => { order.push('next'); resolve(next.result); };
      next.onerror = () => reject(next.error);
    });
    await failed;
    const db = await resumed;
    expect(bad.error?.name).toBe('AbortError');
    expect(order).toEqual(['abort', 'error', 'next']);
    expect(db.version).toBe(1);
    expect(db.objectStoreNames.contains('kept')).toBe(true);
    expect(db.objectStoreNames.contains('partial')).toBe(false);
    expect(factory.handlerErrors()).toEqual(failure === 'throw' ? [boom] : []);
    db.close();
  });

  it('removes a newly created database when its upgrade aborts', async () => {
    const factory = new MemoryIndexedDb();
    const bad = factory.open(DB, 1);
    bad.onupgradeneeded = () => {
      bad.result.createObjectStore('partial', { keyPath: 'id' });
      bad.transaction!.abort();
    };
    await new Promise<void>((resolve, reject) => {
      bad.onerror = () => resolve();
      bad.onsuccess = () => reject(new Error('The upgrade must abort'));
    });
    expect(await factory.databases()).toEqual([]);
    const retry = factory.open(DB, 1);
    let oldVersion = -1;
    retry.onupgradeneeded = (event) => { oldVersion = event.oldVersion; };
    await new Promise<void>((resolve, reject) => {
      retry.onsuccess = () => resolve();
      retry.onerror = () => reject(retry.error);
    });
    expect(oldVersion).toBe(0);
    expect(retry.result.objectStoreNames.length).toBe(0);
    retry.result.close();
  });

  for (const mode of ['readonly', 'readwrite'] as const) {
    for (const ending of ['complete', 'abort'] as const) {
      it(`waits for a closing connection's ${mode} transaction to ${ending} before upgrading`, async () => {
        const factory = new MemoryIndexedDb();
        const initial = factory.open(DB, 1);
        initial.onupgradeneeded = () => initial.result.createObjectStore('items', { keyPath: 'id' });
        await new Promise<void>((resolve) => { initial.onsuccess = () => resolve(); });
        const db = initial.result;
        const tx = db.transaction('items', mode);
        const order: string[] = [];
        const request = mode === 'readwrite' ? tx.objectStore('items').put({ id: 'one' }) : tx.objectStore('items').get('one');
        request.onsuccess = () => {
          order.push('request');
          if (ending === 'abort') tx.abort();
        };
        const ended = new Promise<void>((resolve) => {
          tx.oncomplete = () => { order.push('complete'); resolve(); };
          tx.onabort = () => { order.push('abort'); resolve(); };
        });
        db.onversionchange = () => db.close();
        const upgrade = factory.open(DB, 2);
        let observed: string[] = [];
        upgrade.onupgradeneeded = () => { observed = [...order]; };
        const upgraded = new Promise<void>((resolve, reject) => {
          upgrade.onsuccess = () => { upgrade.result.close(); resolve(); };
          upgrade.onerror = () => reject(upgrade.error);
        });
        await Promise.all([ended, upgraded]);
        expect(observed).toEqual(['request', ending]);
        expect(() => db.transaction('items')).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));
      });
    }
  }
});

async function opened(): Promise<{ factory: MemoryIndexedDb; store: Awaited<ReturnType<typeof openRuntimeStore>> }> {
  const factory = new MemoryIndexedDb();
  const store = await openRuntimeStore(factory, DB);
  return { factory, store };
}

describe('a transaction is scoped to the stores it was opened with', () => {
  it('refuses an object store outside its own scope, and allows the ones inside', async () => {
    // Real IndexedDB raises NotFoundError for a store the transaction does not
    // cover, and the consequence is the whole reason it matters: a mutation that
    // reached a store outside its own transaction would be a second mutation
    // wearing one name — the torn-write class §4 says cannot occur here.
    //
    // Mutation-checked: resolving the store regardless of scope
    // leaves the whole store suite green (190 tests), because every store list in
    // the package happens to be complete. This test is what makes the check
    // load-bearing rather than incidentally true.
    const { store } = await opened();

    const tx = store.db.transaction([PROJECT_STORE], 'readwrite');
    expect(() => tx.objectStore(PROJECT_STORE)).not.toThrow();
    expect(() => tx.objectStore(DOCUMENT_STORE)).toThrow(/no object store/i);
    expect(() => tx.objectStore(SESSION_STORE)).toThrow(/no object store/i);
  });

  it('names the stores it was opened with, so the refusal says which transaction', async () => {
    // The error is a diagnostic the store author reads in a failing test, and a
    // refusal that does not say what it *was* allowed to touch costs a debugging
    // round-trip to earn.
    const { store } = await opened();
    const tx = store.db.transaction([PROJECT_STORE, DOCUMENT_STORE], 'readwrite');
    expect(() => tx.objectStore(SESSION_STORE)).toThrow(
      /opened with \[projects, documents\]/,
    );
  });
});

// The binding reports what a browser would. An exception that escapes a success callback is kept, a request error the request's
// own handler deals with is not, and a request an abort cuts short fails with AbortError before the transaction's abort event.
describe('a request the binding fails: what it records, and the order of its events', () => {
  it('records a success callback that throws, and aborts its transaction as an uncaught exception does in a browser', async () => {
    const { factory, store } = await opened();
    const boom = new Error('boom');
    const tx = store.db.transaction([PROJECT_STORE], 'readonly');
    tx.objectStore(PROJECT_STORE).get('missing').onsuccess = () => {
      throw boom;
    };
    await new Promise<void>((resolve) => tx.addEventListener('abort', () => resolve()));
    expect(factory.handlerErrors()).toEqual([boom]);
  });

  it('does not record a request error: a constraint violation is the request failing, and it is not an exception out of a callback', async () => {
    const { factory, store } = await opened();
    const first = store.db.transaction([PROJECT_STORE], 'readwrite');
    first.objectStore(PROJECT_STORE).add({ id: 'taken' });
    await new Promise<void>((resolve) => first.addEventListener('complete', () => resolve()));

    const second = store.db.transaction([PROJECT_STORE], 'readwrite');
    const refused = second.objectStore(PROJECT_STORE).add({ id: 'taken' });
    refused.onerror = () => undefined;
    await new Promise<void>((resolve) => second.addEventListener('abort', () => resolve()));
    expect(refused.error?.name).toBe('ConstraintError');
    expect(factory.handlerErrors()).toEqual([]);
  });

  it('fails a request that an abort cuts short with AbortError, and does so before the transaction fires its abort event', async () => {
    const { store } = await opened();
    const order: string[] = [];
    const tx = store.db.transaction([PROJECT_STORE], 'readonly');
    const first = tx.objectStore(PROJECT_STORE).get('missing');
    const second = tx.objectStore(PROJECT_STORE).get('missing');
    first.onsuccess = () => {
      tx.abort();
    };
    second.onerror = () => {
      order.push(`error:${second.error?.name ?? 'none'}`);
    };
    await new Promise<void>((resolve) =>
      tx.addEventListener('abort', () => {
        order.push('abort');
        resolve();
      }),
    );
    expect(order).toEqual(['error:AbortError', 'abort']);
  });
});
