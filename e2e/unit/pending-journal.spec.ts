import { expect, test } from '@playwright/test';

import { MemoryIndexedDb, getBody, getRevision, openRuntimeStore, writeProjectState } from '../../packages/store/src/index.js';
import { shadowOf } from '../../apps/desktop/src/app/persistence-plan.js';
import {
  PENDING_CAP_CHARS,
  PendingJournal,
  clearPending,
  pendingKey,
  planRecovery,
  readPending,
  recoverPending,
  recoveryNotice,
  type PendingEntry,
  type PendingSource,
} from '../../apps/desktop/src/app/pending-journal.js';
import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { readUnsentEntries, type UnsentStorage } from '../../apps/desktop/src/app/unsent-copy.js';

import { IDS, project } from './fixtures.js';

/**
 * The pending journal (pending-journal.ts): the typing not yet saved, kept in the browser's storage so a reload cannot take it. The storage
 * is a plain map here, with switches that make it refuse a write the way a full quota does.
 */

function mapStorage(): UnsentStorage & { rows: Map<string, string>; broken: boolean } {
  const rows = new Map<string, string>();
  const storage = {
    rows,
    broken: false,
    get length(): number {
      return rows.size;
    },
    key(index: number): string | null {
      return [...rows.keys()][index] ?? null;
    },
    getItem(key: string): string | null {
      return rows.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (storage.broken) throw new Error('quota exceeded');
      rows.set(key, value);
    },
    removeItem(key: string): void {
      if (storage.broken) throw new Error('storage is blocked');
      rows.delete(key);
    },
  };
  return storage;
}

const PROJECT = 'p_PENDING001';
const NOW = '2026-10-22T10:00:00.000Z';

/** A source with two documents the store holds at the given bodies and revisions, and the session's bodies set by the test. */
interface TestSource extends PendingSource {
  readonly bodies: Map<string, string>;
  readonly storedRows: Map<string, { body: string; revision: number }>;
  readonly unsaved: Map<string, string>;
  isStopped: boolean;
}

function aSource(): TestSource {
  const bodies = new Map([
    ['a', 'Stored A'],
    ['b', 'Stored B'],
  ]);
  const storedRows = new Map([
    ['a', { body: 'Stored A', revision: 3 }],
    ['b', { body: 'Stored B', revision: 0 }],
  ]);
  const unsaved = new Map<string, string>();
  const source: TestSource = {
    bodies,
    storedRows,
    unsaved,
    isStopped: false,
    docIds: () => bodies.keys(),
    bodyOf: (docId) => bodies.get(docId),
    stored: (docId) => storedRows.get(docId),
    pendingBodyOf: (docId) => unsaved.get(docId) ?? null,
    dirtyDocIds: () => [...unsaved.keys()],
    stopped: () => source.isStopped,
  };
  return source;
}

function journalOf(storage: UnsentStorage | undefined, source: PendingSource): PendingJournal {
  return new PendingJournal(storage, PROJECT, source, () => NOW);
}

test.describe('what the journal keeps, and when', () => {
  test('keep writes, synchronously, the unsaved body of a document with the store revision it is based on', () => {
    const storage = mapStorage();
    const source = aSource();
    source.unsaved.set('a', 'Stored A, and more');

    journalOf(storage, source).keep();

    expect(readPending(storage, PROJECT)).toEqual([{ docId: 'a', body: 'Stored A, and more', baseRevision: 3, at: NOW }]);
  });

  test('a body the session holds in memory but the store does not is kept too, once the autosave has handed it over', () => {
    const storage = mapStorage();
    const source = aSource();
    source.bodies.set('b', 'Stored B, written to memory');

    journalOf(storage, source).keep();

    expect(readPending(storage, PROJECT).map((entry) => [entry.docId, entry.body, entry.baseRevision])).toEqual([
      ['b', 'Stored B, written to memory', 0],
    ]);
  });

  test('nothing unsaved writes nothing, and a document the store has not got is left to the persistence pass', () => {
    const storage = mapStorage();
    const source = aSource();
    source.bodies.set('new', 'A document only the session has');

    journalOf(storage, source).keep();

    expect(storage.rows.size).toBe(0);
  });

  test('an entry leaves the journal once the store holds that body, and the key goes with the last entry', () => {
    const storage = mapStorage();
    const source = aSource();
    source.unsaved.set('a', 'Typed');
    const journal = journalOf(storage, source);
    journal.keep();
    expect(readPending(storage, PROJECT)).toHaveLength(1);

    // The session wrote it to memory and the persistence pass committed it.
    source.unsaved.delete('a');
    source.bodies.set('a', 'Typed');
    journal.prune();
    expect(readPending(storage, PROJECT)).toHaveLength(1);
    source.storedRows.set('a', { body: 'Typed', revision: 4 });
    journal.prune();

    expect(storage.rows.has(pendingKey(PROJECT))).toBe(false);
  });

  test('a newer body replaces the older one for the same document, and keeps one entry', () => {
    const storage = mapStorage();
    const source = aSource();
    const journal = journalOf(storage, source);
    source.unsaved.set('a', 'One');
    journal.keep();
    source.unsaved.set('a', 'One, two');
    journal.keep();

    expect(readPending(storage, PROJECT).map((entry) => entry.body)).toEqual(['One, two']);
  });

  test('a stopped session writes no journal, and its key is cleared once the unsent copy landed', () => {
    const storage = mapStorage();
    const source = aSource();
    source.unsaved.set('a', 'Typed');
    const journal = journalOf(storage, source);
    journal.keep();
    expect(storage.rows.has(pendingKey(PROJECT))).toBe(true);

    source.isStopped = true;
    source.unsaved.set('a', 'Typed more');
    journal.keep();
    expect(readPending(storage, PROJECT).map((entry) => entry.body)).toEqual(['Typed']);

    journal.clearForStop(false);
    expect(storage.rows.has(pendingKey(PROJECT))).toBe(true);
    journal.clearForStop(true);
    expect(storage.rows.has(pendingKey(PROJECT))).toBe(false);
  });
});

test.describe('a browser that will not keep the journal', () => {
  test('a refused write (a full quota) is reported, the session carries on, and the next write that lands clears the report', () => {
    const storage = mapStorage();
    const source = aSource();
    source.unsaved.set('a', 'Typed');
    const journal = journalOf(storage, source);
    let told = 0;
    journal.subscribe(() => (told += 1));

    storage.broken = true;
    expect(() => journal.keep()).not.toThrow();
    expect(journal.failure()).toBe('refused');

    storage.broken = false;
    journal.keep();
    expect(journal.failure()).toBeNull();
    expect(readPending(storage, PROJECT)).toHaveLength(1);
    expect(told).toBe(2);
  });

  test('a browser with no storage at all is reported the same way, and throws nothing', () => {
    const source = aSource();
    source.unsaved.set('a', 'Typed');
    const journal = journalOf(undefined, source);

    expect(() => journal.keep()).not.toThrow();
    expect(journal.failure()).toBe('refused');
  });

  test('past the cap nothing is written, and the failure says it is the size', () => {
    const storage = mapStorage();
    const source = aSource();
    source.unsaved.set('a', 'x'.repeat(PENDING_CAP_CHARS));
    const journal = journalOf(storage, source);

    journal.keep();

    expect(journal.failure()).toBe('too-large');
    expect(storage.rows.size).toBe(0);
  });

  test('a value this build did not write reads as no journal, and entries that are not entries are dropped alone', () => {
    const storage = mapStorage();
    storage.rows.set(pendingKey(PROJECT), '{"not":"a list"}');
    expect(readPending(storage, PROJECT)).toEqual([]);
    storage.rows.set(pendingKey(PROJECT), '[{"docId":"a","body":"Kept","baseRevision":1,"at":"x"},{"docId":3},"nope"]');
    expect(readPending(storage, PROJECT)).toEqual([{ docId: 'a', body: 'Kept', baseRevision: 1, at: 'x' }]);
    storage.rows.set(pendingKey(PROJECT), 'not json');
    expect(readPending(storage, PROJECT)).toEqual([]);
    expect(readPending(undefined, PROJECT)).toEqual([]);
  });

  test('a journal the browser will not remove is reported, so the entries are offered again rather than lost', () => {
    const storage = mapStorage();
    storage.rows.set(pendingKey(PROJECT), '[]');
    storage.broken = true;
    expect(clearPending(storage, PROJECT)).toBe(false);
    expect(clearPending(undefined, PROJECT)).toBe(false);
  });
});

test.describe('what an open decides for each entry (planRecovery)', () => {
  const entry = (docId: string, body: string, baseRevision: number): PendingEntry => ({ docId, body, baseRevision, at: NOW });

  test('the same revision with a different body never landed and is saved; an equal body is dropped; a moved revision is offered', () => {
    const state = project();
    const sceneA = state.documents.get(IDS.sceneA)!;
    sceneA.revision = 2;
    const plan = planRecovery(
      [
        entry(IDS.sceneA, 'Four little words here, and the rest', 2),
        entry(IDS.sceneB, 'Two words', 0),
        entry(IDS.sceneC, 'Typed before the other tab saved', 5),
        entry('n_GONE000001', 'A document that has since gone', 0),
      ],
      state,
    );

    expect(plan.save.map((e) => e.docId)).toEqual([IDS.sceneA]);
    expect(plan.drop.map((e) => e.docId)).toEqual([IDS.sceneB]);
    expect(plan.offer.map((e) => e.docId)).toEqual([IDS.sceneC, 'n_GONE000001']);
  });
});

test.describe('recovery on open (recoverPending)', () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  let previous: { document: unknown; window: unknown } | null = null;

  test.beforeAll(() => {
    previous = { document: globals['document'], window: globals['window'] };
    globals['document'] = new EventTarget();
    globals['window'] = new EventTarget();
  });
  test.afterAll(() => {
    if (previous === null) return;
    globals['document'] = previous.document;
    globals['window'] = previous.window;
  });

  /** A session over a project the store holds, as a reopened project is. */
  async function reopened(): Promise<ProjectSession> {
    const state = project();
    const store = await openRuntimeStore(new MemoryIndexedDb());
    await writeProjectState(store, state);
    return new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: shadowOf(state) });
  }

  test('words the store never got are saved as the writer’s own edit, announced, and the journal is gone', async () => {
    const session = await reopened();
    const storage = mapStorage();
    const revision = getRevision(session.state, IDS.sceneA);
    storage.rows.set(
      pendingKey(session.projectId),
      JSON.stringify([{ docId: IDS.sceneA, body: 'Four little words here, typed just before', baseRevision: revision, at: NOW }]),
    );

    const outcome = await recoverPending(session, storage);

    expect(outcome).toEqual({ saved: 1, offered: 0 });
    expect(getBody(session.state, IDS.sceneA)).toBe('Four little words here, typed just before');
    expect(session.saveState()).toBe('saved');
    expect(storage.rows.has(pendingKey(session.projectId))).toBe(false);
    expect(recoveryNotice(outcome)).toBe('Caotang kept 1 unsaved change from before the reload and saved it.');
    // An ordinary user write: one undo group, issued by the writer.
    const rows = session.log.entries().filter((row) => row.command === 'doc.write');
    expect(rows.map((row) => row.issuedBy)).toEqual(['user']);
    await session.close();
  });

  test('words the store has moved past are offered as a copy, never written over the newer text', async () => {
    const session = await reopened();
    const storage = mapStorage();
    storage.rows.set(
      pendingKey(session.projectId),
      JSON.stringify([{ docId: IDS.sceneB, body: 'Typed against an older save', baseRevision: 7, at: NOW }]),
    );

    const outcome = await recoverPending(session, storage);

    expect(outcome).toEqual({ saved: 0, offered: 1 });
    expect(getBody(session.state, IDS.sceneB)).toBe('Two words');
    const kept = readUnsentEntries(storage, session.projectId);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.origin).toBe('reload');
    expect(kept[0]?.documents).toEqual([
      { docId: IDS.sceneB, title: 'Scene B', body: 'Typed against an older save', parentId: IDS.chapterOne },
    ]);
    expect(storage.rows.has(pendingKey(session.projectId))).toBe(false);
    expect(recoveryNotice(outcome)).toContain('binder footer');
    await session.close();
  });

  test('words the store already holds are dropped without a word, and without a write', async () => {
    const session = await reopened();
    const storage = mapStorage();
    storage.rows.set(
      pendingKey(session.projectId),
      JSON.stringify([{ docId: IDS.sceneB, body: 'Two words', baseRevision: 0, at: NOW }]),
    );
    const before = getRevision(session.state, IDS.sceneB);

    const outcome = await recoverPending(session, storage);

    expect(outcome).toEqual({ saved: 0, offered: 0 });
    expect(getRevision(session.state, IDS.sceneB)).toBe(before);
    expect(storage.rows.has(pendingKey(session.projectId))).toBe(false);
    expect(recoveryNotice(outcome)).toBeNull();
    await session.close();
  });

  test('a copy the browser will not take keeps the journal, so the words are offered again at the next open', async () => {
    const session = await reopened();
    const storage = mapStorage();
    storage.rows.set(
      pendingKey(session.projectId),
      JSON.stringify([{ docId: IDS.sceneB, body: 'Typed against an older save', baseRevision: 7, at: NOW }]),
    );
    storage.broken = true;

    await recoverPending(session, storage);

    expect(storage.rows.has(pendingKey(session.projectId))).toBe(true);
    await session.close();
  });
});

test.describe('a session writes the journal on the lifecycle events', () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  let previous: { document: unknown; window: unknown; localStorage: PropertyDescriptor | undefined } | null = null;
  const storage = mapStorage();
  const win = new EventTarget();
  const doc = new EventTarget();

  test.beforeAll(() => {
    previous = {
      document: globals['document'],
      window: globals['window'],
      localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    };
    globals['document'] = doc;
    globals['window'] = win;
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  });
  test.afterAll(() => {
    if (previous === null) return;
    globals['document'] = previous.document;
    globals['window'] = previous.window;
    if (previous.localStorage === undefined) delete globals['localStorage'];
    else Object.defineProperty(globalThis, 'localStorage', previous.localStorage);
  });

  for (const signal of ['beforeunload', 'pagehide', 'visibilitychange']) {
    test(`${signal} writes the typing not yet saved before the handler returns`, async () => {
      storage.rows.clear();
      const state = project();
      const store = await openRuntimeStore(new MemoryIndexedDb());
      await writeProjectState(store, state);
      const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: shadowOf(state) });
      session.autosave.open(IDS.sceneA, { body: getBody(state, IDS.sceneA), revision: getRevision(state, IDS.sceneA) });
      // A producer, as the editor offers: the text is read when the journal needs it.
      session.autosave.noteEdit(IDS.sceneA, () => 'Four little words here, typed in the last moment');

      (signal === 'visibilitychange' ? doc : win).dispatchEvent(new Event(signal));

      // Read at once, with no await between the event and the read: this is what a page that is going away leaves behind.
      expect(readPending(storage, session.projectId).map((e) => [e.docId, e.body, e.baseRevision])).toEqual([
        [IDS.sceneA, 'Four little words here, typed in the last moment', 0],
      ]);

      // Once the store holds the words the journal is empty again.
      await session.close();
      expect(storage.rows.has(pendingKey(session.projectId))).toBe(false);
    });
  }
});
