import { expect, test } from '@playwright/test';

import { MemoryIndexedDb } from '../../packages/store/src/index.js';
import { APP_DB_NAME, APP_KEYS, openAppDb, type AppDb } from '../../apps/desktop/src/app/app-db.js';
import {
  HISTORY_MAX_AGE_MS,
  HISTORY_WRITE_DELAY_MS,
  HISTORY_WRITE_MAX_WAIT_MS,
  createHistorySaver,
  dropHistoryOf,
  historyKey,
  loadHistoryJournal,
  sweepHistory,
  type SaverTimers,
  type VisibilitySource,
} from '../../apps/desktop/src/app/history-store.js';

/**
 * The editor's undo journals in the app database (app-db.ts, history-store.ts): the version-2 upgrade of `caotang-app` keeps what version 1
 * held, journals are written debounced and at once when the tab is hidden, and they leave with their document, their project, or 30 days.
 */

const JOURNAL = { version: 1, schema: 's', baseBody: 'Hello.\n', entries: [{ kind: 'undo' as const }] };

/** A database made the way build 1 made it: version 1, the `kv` store and one settings row, nothing else. */
async function versionOne(factory: IDBFactory): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = factory.open(APP_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('kv', { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ key: APP_KEYS.settings, value: { theme: 'dark' } });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error ?? new Error('could not seed version 1'));
    };
    request.onerror = () => reject(request.error ?? new Error('could not open version 1'));
  });
}

async function freshDb(): Promise<AppDb> {
  return openAppDb(new MemoryIndexedDb());
}

function record(projectId: string, docId: string, updatedAt: number) {
  return { key: historyKey(projectId, docId), projectId, docId, updatedAt, journal: JOURNAL };
}

/** A clock the test runs by hand. */
function manualTimers(): SaverTimers & { advance(ms: number): void; at: number } {
  let now = 1_000_000;
  const pending: Array<{ at: number; callback: () => void; live: boolean }> = [];
  const timers = {
    get at(): number {
      return now;
    },
    now: () => now,
    setTimeout(callback: () => void, ms: number): unknown {
      const entry = { at: now + ms, callback, live: true };
      pending.push(entry);
      return entry;
    },
    clearTimeout(handle: unknown): void {
      (handle as { live: boolean }).live = false;
    },
    advance(ms: number): void {
      const until = now + ms;
      for (;;) {
        const due = pending.filter((entry) => entry.live && entry.at <= until).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.live = false;
        now = due.at;
        due.callback();
      }
      now = until;
    },
  };
  return timers;
}

function visibility(): VisibilitySource & { state: string; fire(): void } {
  const listeners = new Set<() => void>();
  const source = {
    state: 'visible',
    get visibilityState(): string {
      return source.state;
    },
    addEventListener(_type: 'visibilitychange', listener: () => void): void {
      listeners.add(listener);
    },
    removeEventListener(_type: 'visibilitychange', listener: () => void): void {
      listeners.delete(listener);
    },
    fire(): void {
      for (const listener of listeners) listener();
    },
  };
  return source;
}

/** Lets the saver's promise chain run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test.describe('the app database upgrade (caotang-app, version 1 to 2)', () => {
  test('a database made by version 1 opens at version 2 with the journal stores added, and its settings row survives', async () => {
    const factory = new MemoryIndexedDb();
    await versionOne(factory);

    const db = await openAppDb(factory);

    expect(await db.get(APP_KEYS.settings)).toEqual({ theme: 'dark' });
    expect(await db.history!.get('p:d')).toBeUndefined();
    await db.history!.put(record('p', 'd', 5));
    expect(await db.history!.get('p:d')).toEqual(record('p', 'd', 5));
    // The new stores did not disturb the old: a second write of each reads back.
    await db.put(APP_KEYS.profiles, [{ id: 'a' }]);
    expect(await db.get(APP_KEYS.profiles)).toEqual([{ id: 'a' }]);
    expect(await db.get(APP_KEYS.settings)).toEqual({ theme: 'dark' });
    db.close();

    // A reopen at version 2 changes nothing.
    const again = await openAppDb(factory);
    expect(await again.get(APP_KEYS.settings)).toEqual({ theme: 'dark' });
    expect((await again.history!.get('p:d'))?.journal).toEqual(JOURNAL);
  });

  test('a journal is listed without being read, replaced by a newer write, and removed by key', async () => {
    const db = await freshDb();
    await db.history!.put(record('p', 'a', 1));
    await db.history!.put(record('p', 'b', 2));
    await db.history!.put({ ...record('p', 'a', 3), journal: { ...JOURNAL, baseBody: 'Newer.\n' } });

    const listed = await db.history!.list();
    expect(listed.map((meta) => [meta.key, meta.updatedAt]).sort()).toEqual([
      ['p:a', 3],
      ['p:b', 2],
    ]);
    expect(Object.keys(listed[0] ?? {}).sort()).toEqual(['docId', 'key', 'projectId', 'updatedAt']);
    expect(((await db.history!.get('p:a'))?.journal as typeof JOURNAL).baseBody).toBe('Newer.\n');

    await db.history!.delete(['p:a', 'p:missing']);
    expect(await db.history!.get('p:a')).toBeUndefined();
    expect((await db.history!.list()).map((meta) => meta.key)).toEqual(['p:b']);
  });
});

test.describe('the saver', () => {
  test('a burst of changes is one write, a second after the last, with the journal as it is then', async () => {
    const db = await freshDb();
    const timers = manualTimers();
    const saver = createHistorySaver('p', 'd', db, timers, null);
    let reads = 0;
    const read = () => {
      reads += 1;
      return { ...JOURNAL, baseBody: `read ${reads}` };
    };

    saver.onChange(read);
    timers.advance(400);
    saver.onChange(read);
    timers.advance(400);
    saver.onChange(read);
    timers.advance(HISTORY_WRITE_DELAY_MS - 1);
    await settle();
    expect(await db.history!.get('p:d')).toBeUndefined();
    expect(reads).toBe(0);

    timers.advance(1);
    await settle();
    expect(reads).toBe(1);
    expect(((await db.history!.get('p:d'))?.journal as typeof JOURNAL).baseBody).toBe('read 1');
    expect((await db.history!.get('p:d'))?.updatedAt).toBe(timers.at);
  });

  test('typing that never pauses is still written, no later than the longest wait after its first change', async () => {
    const db = await freshDb();
    const timers = manualTimers();
    const saver = createHistorySaver('p', 'd', db, timers, null);

    for (let elapsed = 0; elapsed < HISTORY_WRITE_MAX_WAIT_MS; elapsed += 500) {
      saver.onChange(() => JOURNAL);
      timers.advance(500);
    }
    await settle();

    expect(await db.history!.get('p:d')).toBeDefined();
  });

  test('hiding the tab writes at once, and so does a flush or a dispose', async () => {
    const db = await freshDb();
    const timers = manualTimers();
    const tab = visibility();
    const saver = createHistorySaver('p', 'd', db, timers, tab);

    saver.onChange(() => JOURNAL);
    tab.state = 'visible';
    tab.fire();
    await settle();
    expect(await db.history!.get('p:d')).toBeUndefined();

    tab.state = 'hidden';
    tab.fire();
    await settle();
    expect(await db.history!.get('p:d')).toBeDefined();

    await db.history!.delete(['p:d']);
    saver.onChange(() => JOURNAL);
    await saver.dispose();
    expect(await db.history!.get('p:d')).toBeDefined();
  });

  test('an empty journal removes the record, so a journal the editor discarded is not tried again', async () => {
    const db = await freshDb();
    await db.history!.put(record('p', 'd', 1));
    const timers = manualTimers();
    const saver = createHistorySaver('p', 'd', db, timers, null);

    saver.onChange(() => null);
    await saver.flush();

    expect(await db.history!.get('p:d')).toBeUndefined();
  });

  test('a document opened again finds the journal its last visit was still writing', async () => {
    const db = await freshDb();
    const timers = manualTimers();
    const saver = createHistorySaver('p', 'd', db, timers, null);

    saver.onChange(() => JOURNAL);
    const disposing = saver.dispose();
    const loaded = await loadHistoryJournal('p', 'd', db);
    await disposing;

    expect(loaded).toEqual(JOURNAL);
  });

  test('a database that fails costs the journal and throws nothing', async () => {
    const db = await freshDb();
    const broken: AppDb = {
      ...db,
      history: {
        get: () => Promise.reject(new Error('closed')),
        put: () => Promise.reject(new Error('full')),
        delete: () => Promise.reject(new Error('closed')),
        list: () => Promise.reject(new Error('closed')),
      },
    };
    const saver = createHistorySaver('p', 'd', broken, manualTimers(), null);
    saver.onChange(() => JOURNAL);

    await expect(saver.flush()).resolves.toBeUndefined();
    await expect(loadHistoryJournal('p', 'd', broken)).resolves.toBeUndefined();
    await expect(dropHistoryOf('p', null, broken)).resolves.toBe(0);
    await expect(sweepHistory(broken)).resolves.toBe(0);
    await expect(loadHistoryJournal('p', 'd', null)).resolves.toBeUndefined();
    // A database that keeps only settings (a stand-in) keeps no journals and says nothing.
    const { history: _history, ...settingsOnly } = db;
    void _history;
    const bare = createHistorySaver('p', 'd', settingsOnly, manualTimers(), null);
    bare.onChange(() => JOURNAL);
    await expect(bare.flush()).resolves.toBeUndefined();
    await expect(loadHistoryJournal('p', 'd', settingsOnly)).resolves.toBeUndefined();
  });
});

test.describe('which journals go', () => {
  test('the journals of documents a project no longer has go, and another project’s stay', async () => {
    const db = await freshDb();
    await db.history!.put(record('p', 'kept', 1));
    await db.history!.put(record('p', 'deleted', 1));
    await db.history!.put(record('other', 'deleted', 1));

    expect(await dropHistoryOf('p', new Set(['kept']), db)).toBe(1);

    expect((await db.history!.list()).map((meta) => meta.key).sort()).toEqual(['other:deleted', 'p:kept']);
  });

  test('every journal of a project goes with the project', async () => {
    const db = await freshDb();
    await db.history!.put(record('p', 'a', 1));
    await db.history!.put(record('p', 'b', 1));
    await db.history!.put(record('other', 'a', 1));

    expect(await dropHistoryOf('p', null, db)).toBe(2);

    expect((await db.history!.list()).map((meta) => meta.key)).toEqual(['other:a']);
  });

  test('a journal not written for 30 days goes, and one written inside the 30 days stays', async () => {
    const db = await freshDb();
    const now = Date.UTC(2026, 9, 22);
    await db.history!.put(record('p', 'old', now - HISTORY_MAX_AGE_MS - 1));
    await db.history!.put(record('p', 'edge', now - HISTORY_MAX_AGE_MS));
    await db.history!.put(record('p', 'recent', now - 1000));

    expect(await sweepHistory(db, now)).toBe(1);

    expect((await db.history!.list()).map((meta) => meta.docId).sort()).toEqual(['edge', 'recent']);
  });
});
