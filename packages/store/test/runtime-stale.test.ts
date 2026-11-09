/**
 * A runtime store whose connection another tab's upgrade has closed. The browser fires `versionchange` on this tab's connection
 * when a newer build opens the database; from then on this tab's writes must say why they fail, and say what to do (reload), rather
 * than surface the browser's `InvalidStateError` from a closed connection.
 */

import { describe, expect, it, vi } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';

import {
  requireLiveConnection,
  runtimeConnectionMachine,
  runtimeConnectionTable,
  type ConnectionEvent,
  type ConnectionState,
} from '../src/runtime/store.js';

import {
  MemoryIndexedDb,
  RuntimeStoreNewerError,
  RuntimeStoreStaleError,
  RUNTIME_DB_VERSION,
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectState,
  evictSnapshots,
  openRuntimeStore,
  readProjectState,
  writeProjectState,
  type RuntimeStore,
} from '../src/index.js';

const STAMP = new Date('2026-10-08T09:00:00.000Z');

/** Fires the event the browser fires on an open connection when another tab opens the database at a newer version. */
function upgradeFromAnotherTab(store: RuntimeStore): void {
  store.db.onversionchange?.call(store.db, new Event('versionchange') as IDBVersionChangeEvent);
}

function aProject() {
  const state = createProjectState(createEmptyManifest('Stale Book', STAMP));
  addFolder(state, { parentId: 'manuscript', title: 'Chapter 1', now: STAMP, id: 'n_CHAPTR0001' });
  addDocument(state, { parentId: 'n_CHAPTR0001', title: 'Kept', body: 'The ferry was late.', now: STAMP, id: 'n_KEEP000001' });
  return state;
}

function openDatabase(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe('the runtime connection machine', () => {
  it('agrees with every table row, including both open-error outcomes and late events', async () => {
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const error = new Error('Storage is unavailable');
    const states: ConnectionState[] = [
      { kind: 'opening' },
      { kind: 'open', db: store.db },
      { kind: 'stale' },
      { kind: 'closed' },
      { kind: 'blocked' },
      { kind: 'newer' },
      { kind: 'failed', error },
    ];
    const events: ConnectionEvent[] = [
      { type: 'opened', db: store.db },
      { type: 'blocked' },
      { type: 'error', error },
      { type: 'error', error: new DOMException('A newer version exists', 'VersionError') },
      { type: 'versionchange' },
      { type: 'close' },
    ];
    expect(checkMachine(runtimeConnectionMachine, { states, events })).toEqual([]);
    expect(runtimeConnectionMachine.step({ kind: 'opening' }, events[0]!)).toEqual({ kind: 'open', db: store.db });
    expect(runtimeConnectionMachine.step({ kind: 'opening' }, events[2]!)).toEqual({ kind: 'failed', error });
    expect(runtimeConnectionMachine.step({ kind: 'opening' }, events[3]!)).toEqual({ kind: 'newer' });
    expect(runtimeConnectionTable.final).toEqual(['stale', 'closed', 'blocked', 'newer', 'failed']);
    store.close();
  });
});

describe('a runtime store another tab has upgraded', () => {
  it('a store that no other tab has upgraded keeps writing', async () => {
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const state = aProject();
    await writeProjectState(store, state);
    expect((await readProjectState(store, state.manifest.project.id)).documents.get('n_KEEP000001')?.body).toBe(
      'The ferry was late.',
    );
  });

  it('the next write is refused with an error that names the reload, not the browser’s closed-connection error', async () => {
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const state = aProject();
    await writeProjectState(store, state);

    upgradeFromAnotherTab(store);

    const refused = writeProjectState(store, state);
    await expect(refused).rejects.toBeInstanceOf(RuntimeStoreStaleError);
    await expect(refused).rejects.toThrow('Reload this tab');
  });

  it('a read on the upgraded store is refused the same way, so no screen shows a partly loaded project', async () => {
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const state = aProject();
    await writeProjectState(store, state);

    upgradeFromAnotherTab(store);

    await expect(readProjectState(store, state.manifest.project.id)).rejects.toBeInstanceOf(RuntimeStoreStaleError);
  });

  it('the snapshot retention sweep is refused by the same name, not by the browser’s closed-connection error', async () => {
    const store = await openRuntimeStore(new MemoryIndexedDb());
    upgradeFromAnotherTab(store);

    await expect(evictSnapshots(store, 'p_upgraded')).rejects.toBeInstanceOf(RuntimeStoreStaleError);
  });

  it('cooperates with a real upgrade request and retains the stale refusal after close', async () => {
    const factory = new MemoryIndexedDb();
    const store = await openRuntimeStore(factory);
    const state = aProject();
    await writeProjectState(store, state);

    const upgraded = await openDatabase(factory, store.name, RUNTIME_DB_VERSION + 1);
    try {
      expect(() => requireLiveConnection(store)).toThrow(RuntimeStoreStaleError);
      store.close();
      await expect(writeProjectState(store, state)).rejects.toBeInstanceOf(RuntimeStoreStaleError);
      await expect(openRuntimeStore(factory)).rejects.toBeInstanceOf(RuntimeStoreNewerError);
    } finally {
      upgraded.close();
    }
  });

  it('keeps an ordinary close distinct from another tab’s upgrade', async () => {
    const store = await openRuntimeStore(new MemoryIndexedDb());
    store.close();
    store.close();

    expect(() => requireLiveConnection(store)).not.toThrow();
    await expect(readProjectState(store, 'closed')).rejects.toMatchObject({ name: 'InvalidStateError' });
  });
});

describe('a runtime store blocked by another tab', () => {
  it('refuses the open instead of waiting indefinitely for a tab that keeps its old connection', async () => {
    vi.useFakeTimers();
    const factory = new MemoryIndexedDb();
    const oldRequest = factory.open('blocked', RUNTIME_DB_VERSION - 1);
    await vi.runAllTimersAsync();
    const oldConnection = oldRequest.result;
    const versionChanges: number[] = [];
    oldConnection.onversionchange = (event) => { versionChanges.push(event.newVersion!); };
    try {
      const outcome = openRuntimeStore(factory, 'blocked').then(
        (store) => { store.close(); return 'opened'; },
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );
      const timedOut = new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 100));
      const result = Promise.race([outcome, timedOut]);
      await vi.runAllTimersAsync();
      expect(versionChanges).toEqual([RUNTIME_DB_VERSION]);
      expect(await result).toMatch(/Close the other Caotang tabs/);
    } finally {
      oldConnection.close();
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it('closes a late successful connection after refusing the blocked open, so it cannot block another upgrade', async () => {
    const factory = new MemoryIndexedDb();
    const oldConnection = await openDatabase(factory, 'late', RUNTIME_DB_VERSION - 1);
    const open = vi.spyOn(factory, 'open');
    const outcome = openRuntimeStore(factory, 'late').catch((error: unknown) => error);
    const request = open.mock.results[0]!.value as IDBOpenDBRequest;
    const blocked = new Promise<IDBVersionChangeEvent>((resolve) => request.addEventListener('blocked', (event) => {
      resolve(event as IDBVersionChangeEvent);
    }));
    try {
      expect(await blocked).toMatchObject({ oldVersion: RUNTIME_DB_VERSION - 1, newVersion: RUNTIME_DB_VERSION });
      expect(await outcome).toMatchObject({ message: expect.stringContaining('Close the other Caotang tabs') });
      expect(request.readyState).toBe('pending');
      expect(await factory.databases()).toEqual([{ name: 'late', version: RUNTIME_DB_VERSION - 1 }]);

      const succeeded = new Promise<void>((resolve) => request.addEventListener('success', () => resolve()));
      oldConnection.close();
      await succeeded;
      expect(request.readyState).toBe('done');
      expect(() => request.result.transaction('projects')).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));

      const retry = await openRuntimeStore(factory, 'late');
      retry.close();
      const upgraded = await openDatabase(factory, 'late', RUNTIME_DB_VERSION + 1);
      upgraded.close();
    } finally {
      oldConnection.close();
      open.mockRestore();
    }
  });

  it('opens normally when the older tab closes in response to versionchange', async () => {
    const factory = new MemoryIndexedDb();
    const oldConnection = await openDatabase(factory, 'cooperative', RUNTIME_DB_VERSION - 1);
    oldConnection.onversionchange = () => oldConnection.close();
    const store = await openRuntimeStore(factory, 'cooperative');
    expect(store.db.version).toBe(RUNTIME_DB_VERSION);
    expect(store.db.objectStoreNames.contains('runEvents')).toBe(true);
    store.close();
  });
});

describe('other runtime store open failures', () => {
  it('keeps the original browser error', async () => {
    const error = new DOMException('Storage was refused', 'SecurityError');
    const factory = {
      open() {
        const request = { error } as IDBOpenDBRequest;
        queueMicrotask(() => request.onerror?.call(request, new Event('error')));
        return request;
      },
    } as unknown as IDBFactory;
    await expect(openRuntimeStore(factory)).rejects.toBe(error);
  });

  it('keeps the fallback message when the request provides no error', async () => {
    const factory = {
      open() {
        const request = { error: null } as IDBOpenDBRequest;
        queueMicrotask(() => request.onerror?.call(request, new Event('error')));
        return request;
      },
    } as unknown as IDBFactory;
    await expect(openRuntimeStore(factory, 'unavailable')).rejects.toThrow('could not open the runtime store "unavailable"');
  });
});

describe('a store a newer build has upgraded, opened by an older build', () => {
  it('the browser’s VersionError is said as what this tab must do: reload to get the updated version', async () => {
    // The browser refuses an older build's open of a store at a newer version with a VersionError (store.ts openRuntimeStore).
    const olderBuild = {
      open() {
        const request = { error: { name: 'VersionError', message: 'The requested version is less than the existing version.' } } as unknown as IDBOpenDBRequest;
        setTimeout(() => (request as unknown as { onerror: () => void }).onerror(), 0);
        return request;
      },
    } as unknown as IDBFactory;

    const opened = openRuntimeStore(olderBuild);

    await expect(opened).rejects.toBeInstanceOf(RuntimeStoreNewerError);
    await expect(opened).rejects.toThrow('Reload this tab to get the updated version');
  });
});
