import { expect, test } from '@playwright/test';

import { addDocument, addFolder } from '../../packages/store/src/index.js';
import { shadowOf } from '../../apps/desktop/src/app/persistence-plan.js';
import {
  UNSENT_KEY_PREFIX,
  keptChapterTitle,
  clearUnsentCopy,
  restoreParentOf,
  newStopId,
  noteStop,
  noteStopKept,
  putBackDocuments,
  readUnsentEntries,
  removeUnsentEntry,
  restoreStep,
  stopKeptInBrowser,
  subscribeStop,
  unsentDocuments,
  unsentKey,
  unsentStamp,
  writeUnsentEntry,
  type UnsentDocument,
  type UnsentStorage,
} from '../../apps/desktop/src/app/unsent-copy.js';
import { IDS, project } from './fixtures.js';

/**
 * The unsent copy of a stopped tab (unsent-copy.ts): which words it holds, how each stop keeps its own entry, how a put-back is retried
 * without a second create, and that a browser which keeps no storage, refuses a write, or holds a value this build did not write, is
 * tolerated. The browser's storage is a plain map here.
 */

/** A storage that keeps its rows in a map, with switches that make every call, or only the reads, throw, as a privacy mode can. */
function mapStorage(): UnsentStorage & { rows: Map<string, string>; broken: boolean; readBroken: boolean } {
  const rows = new Map<string, string>();
  const storage = {
    rows,
    broken: false,
    readBroken: false,
    get length(): number {
      return rows.size;
    },
    key(index: number): string | null {
      return [...rows.keys()][index] ?? null;
    },
    getItem(key: string): string | null {
      if (storage.broken || storage.readBroken) throw new Error('storage is blocked');
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

const PROJECT = 'p_TESTPROJ01';

test.describe('which words a stopped tab holds (unsent-copy.ts)', () => {
  test('a document whose body differs from what the store holds is unsent, and one the store holds unchanged is not', () => {
    const state = project();
    const shadow = shadowOf(state);
    // The writer types into Scene A; Scene B is untouched.
    const sceneA = state.documents.get(IDS.sceneA);
    expect(sceneA).toBeDefined();
    sceneA!.body = 'Four little words here, and more';

    const unsent = unsentDocuments(shadow, state);
    expect(unsent.map((doc) => doc.docId)).toEqual([IDS.sceneA]);
    // The document records its chapter, so a put-back restores it there.
    expect(unsent[0]).toEqual({ docId: IDS.sceneA, title: 'Scene A', body: 'Four little words here, and more', parentId: IDS.chapterOne });
  });

  test('a new document with words is unsent, and a blank one is not', () => {
    const state = project();
    const shadow = shadowOf(state);
    const fresh = addDocument(state, { parentId: IDS.chapterOne, title: 'Fresh', body: 'A new scene.', now: new Date('2026-10-09T09:00:00Z') });
    const blank = addDocument(state, { parentId: IDS.chapterOne, title: 'Blank', body: '  \n', now: new Date('2026-10-09T09:00:00Z') });

    const ids = unsentDocuments(shadow, state).map((doc) => doc.docId);
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(blank.id);
  });

  test('a document the session removed is not unsent, because nothing was typed in it', () => {
    const state = project();
    const shadow = shadowOf(state);
    state.documents.delete(IDS.sceneB);
    expect(unsentDocuments(shadow, state).map((doc) => doc.docId)).not.toContain(IDS.sceneB);
  });

  test('with no shadow to compare with, every document with words is kept', () => {
    const ids = unsentDocuments(null, project()).map((doc) => doc.docId);
    expect(ids).toEqual(expect.arrayContaining([IDS.sceneA, IDS.sceneB, IDS.deepScene]));
    expect(ids).not.toContain(IDS.sceneC);
  });
});

test.describe('where a kept document goes back (restoreParentOf, the chapterless-documents rule)', () => {
  test('into the chapter it recorded, while that is still a chapter under the manuscript', () => {
    expect(restoreParentOf(project(), IDS.chapterOne)).toBe(IDS.chapterOne);
  });

  test('a Research document goes back to its Research folder, or the Research root, not into the manuscript', () => {
    const state = project();
    addFolder(state, { parentId: 'research', title: 'Places', id: 'n_RESFOLDER1', now: new Date('2026-10-14T09:00:00Z') });
    addFolder(state, { parentId: 'n_RESFOLDER1', title: 'Harbours', id: 'n_RESFOLDER2', now: new Date('2026-10-14T09:00:00Z') });
    expect(restoreParentOf(state, 'research')).toBe('research');
    expect(restoreParentOf(state, 'n_RESFOLDER1')).toBe('n_RESFOLDER1');
    expect(restoreParentOf(state, 'n_RESFOLDER2')).toBe('n_RESFOLDER2');
    // Words kept from the fixture's research note record the Research root, so they go back there.
    addDocument(state, { parentId: 'n_RESFOLDER2', title: 'The quay', id: 'n_RESNOTE001', body: 'Notes on the quay', now: new Date('2026-10-14T09:00:00Z') });
    state.documents.get(IDS.note)!.body = 'A research note with words';
    const kept = unsentDocuments(null, state);
    expect(restoreParentOf(state, kept.find((doc) => doc.docId === IDS.note)?.parentId)).toBe('research');
    expect(restoreParentOf(state, kept.find((doc) => doc.docId === 'n_RESNOTE001')?.parentId)).toBe('n_RESFOLDER2');
    // A Research folder that is gone is not one to restore into.
    expect(restoreParentOf(state, 'n_RESGONE001')).toBeNull();
  });

  test('into the kept chapter when its chapter is gone, is not a chapter, or was never recorded', () => {
    const state = project();
    // A folder inside a chapter is not a chapter, the manuscript is not one, and a document holds nothing.
    expect(restoreParentOf(state, IDS.deep)).toBeNull();
    expect(restoreParentOf(state, 'manuscript')).toBeNull();
    expect(restoreParentOf(state, IDS.sceneA)).toBeNull();
    expect(restoreParentOf(state, 'n_GONE000001')).toBeNull();
    expect(restoreParentOf(state, undefined)).toBeNull();
    expect(keptChapterTitle()).toBe('Kept from a stopped tab');
  });

  test('an entry an older build wrote, with no chapter on its documents, still reads', () => {
    const storage = mapStorage();
    storage.rows.set(
      unsentKey(PROJECT),
      JSON.stringify([{ stopId: 'stop-old', savedAt: '2026-10-01T00:00:00.000Z', documents: [{ docId: IDS.sceneA, title: 'Scene A', body: 'Old words.' }] }]),
    );
    const [entry] = readUnsentEntries(storage, PROJECT);
    expect(entry?.documents[0]?.parentId).toBeUndefined();
    expect(entry?.documents[0]?.body).toBe('Old words.');
  });
});

test.describe('how the copy is kept, one entry per stop (unsent-copy.ts)', () => {
  test('an entry is written under the project key, read back with its documents, and removed when it holds none', () => {
    const STOP_A = newStopId();
    const storage = mapStorage();
    const documents = [{ docId: IDS.sceneA, title: 'Scene A', body: 'Words typed.' }];

    expect(writeUnsentEntry(storage, PROJECT, STOP_A, documents)).toBe(true);
    expect([...storage.rows.keys()]).toEqual([unsentKey(PROJECT)]);
    expect(unsentKey(PROJECT).startsWith(UNSENT_KEY_PREFIX)).toBe(true);
    const [entry] = readUnsentEntries(storage, PROJECT);
    expect(entry?.stopId).toBe(STOP_A);
    expect(entry?.documents).toEqual(documents);
    expect(Number.isNaN(Date.parse(entry?.savedAt ?? ''))).toBe(false);

    expect(writeUnsentEntry(storage, PROJECT, STOP_A, [])).toBe(true);
    expect(readUnsentEntries(storage, PROJECT)).toEqual([]);
    expect(storage.rows.size).toBe(0);
  });

  test('two stops of one project keep both entries, and a stop that writes again replaces only its own', () => {
    const STOP_A = newStopId();
    const STOP_B = newStopId();
    const storage = mapStorage();
    writeUnsentEntry(storage, PROJECT, STOP_A, [{ docId: IDS.sceneA, title: 'Scene A', body: 'First stop.' }]);
    writeUnsentEntry(storage, PROJECT, STOP_B, [{ docId: IDS.sceneB, title: 'Scene B', body: 'Second stop.' }]);

    let entries = readUnsentEntries(storage, PROJECT);
    expect(entries.map((entry) => entry.stopId)).toEqual([STOP_A, STOP_B]);
    expect(entries[0]?.documents[0]?.body).toBe('First stop.');
    expect(entries[1]?.documents[0]?.body).toBe('Second stop.');

    writeUnsentEntry(storage, PROJECT, STOP_B, [{ docId: IDS.sceneB, title: 'Scene B', body: 'Second stop, more.' }]);
    entries = readUnsentEntries(storage, PROJECT);
    expect(entries.map((entry) => entry.stopId)).toEqual([STOP_A, STOP_B]);
    expect(entries[0]?.documents[0]?.body).toBe('First stop.');
    expect(entries[1]?.documents[0]?.body).toBe('Second stop, more.');

    expect(removeUnsentEntry(storage, PROJECT, STOP_A)).toBe(true);
    expect(readUnsentEntries(storage, PROJECT).map((entry) => entry.stopId)).toEqual([STOP_B]);
  });

  test('a copy belongs to its project: another project reads none', () => {
    const STOP_A = newStopId();
    const storage = mapStorage();
    writeUnsentEntry(storage, PROJECT, STOP_A, [{ docId: IDS.sceneA, title: 'Scene A', body: 'Words.' }]);
    expect(readUnsentEntries(storage, 'p_OTHERPROJ2')).toEqual([]);
  });

  test('a value this build did not write is read as no entry, never as words, and one bad entry does not hide the rest', () => {
    const STOP_A = newStopId();
    const STOP_B = newStopId();
    const storage = mapStorage();
    storage.rows.set(unsentKey(PROJECT), '{"savedAt":"2026-10-09","documents":[{"docId":4}]}');
    expect(readUnsentEntries(storage, PROJECT)).toEqual([]);
    storage.rows.set(unsentKey(PROJECT), 'not json at all');
    expect(readUnsentEntries(storage, PROJECT)).toEqual([]);

    const good = { stopId: STOP_A, savedAt: '2026-10-09T09:00:00.000Z', documents: [{ docId: IDS.sceneA, title: 'Scene A', body: 'Kept.' }] };
    storage.rows.set(unsentKey(PROJECT), JSON.stringify([good, { stopId: STOP_B, documents: [{ docId: 4 }] }]));
    expect(readUnsentEntries(storage, PROJECT).map((entry) => entry.stopId)).toEqual([STOP_A]);
  });

  test('a browser that keeps no storage, blocks it, or refuses a write loses nothing it was asked to keep and throws nowhere', () => {
    const STOP_A = newStopId();
    expect(readUnsentEntries(undefined, PROJECT)).toEqual([]);
    expect(writeUnsentEntry(undefined, PROJECT, STOP_A, [{ docId: IDS.sceneA, title: 'Scene A', body: 'Words.' }])).toBe(false);
    clearUnsentCopy(undefined, PROJECT);

    const blocked = mapStorage();
    blocked.broken = true;
    expect(readUnsentEntries(blocked, PROJECT)).toEqual([]);
    expect(writeUnsentEntry(blocked, PROJECT, STOP_A, [{ docId: IDS.sceneA, title: 'Scene A', body: 'Words.' }])).toBe(false);
    expect(() => clearUnsentCopy(blocked, PROJECT)).not.toThrow();
  });

  test('a write is refused when the stored entries cannot be read, so another stop’s words are never replaced', () => {
    const STOP_A = newStopId();
    const STOP_B = newStopId();
    const storage = mapStorage();
    writeUnsentEntry(storage, PROJECT, STOP_A, [{ docId: IDS.sceneA, title: 'Scene A', body: 'The first stop’s words.' }]);
    storage.readBroken = true;
    expect(writeUnsentEntry(storage, PROJECT, STOP_B, [{ docId: IDS.sceneB, title: 'Scene B', body: 'Second.' }])).toBe(false);
    storage.readBroken = false;
    expect(readUnsentEntries(storage, PROJECT).map((entry) => entry.stopId)).toEqual([STOP_A]);
  });

  test('clearing a copy the browser refuses to remove keeps it, so it is offered again rather than lost', () => {
    const STOP_A = newStopId();
    const storage = mapStorage();
    writeUnsentEntry(storage, PROJECT, STOP_A, [{ docId: IDS.sceneA, title: 'Scene A', body: 'Words.' }]);
    storage.broken = true;
    clearUnsentCopy(storage, PROJECT);
    storage.broken = false;
    expect(readUnsentEntries(storage, PROJECT)[0]?.documents).toHaveLength(1);
  });
});

test.describe('the stopped-tab notice reads its own stop (unsent-copy.ts stopKeptInBrowser)', () => {
  test('the words count as kept only when this stop’s latest write landed and its entry is there', () => {
    const STOP_A = newStopId();
    const storage = mapStorage();
    noteStop(PROJECT, STOP_A);
    expect(stopKeptInBrowser(storage)).toBe(false);

    noteStopKept(STOP_A, true);
    expect(stopKeptInBrowser(storage)).toBe(false);

    writeUnsentEntry(storage, PROJECT, STOP_A, [{ docId: IDS.sceneA, title: 'Scene A', body: 'Kept.' }]);
    noteStopKept(STOP_A, true);
    expect(stopKeptInBrowser(storage)).toBe(true);

    noteStopKept(STOP_A, false);
    expect(stopKeptInBrowser(storage)).toBe(false);
  });

  test('another stop’s entry never makes this stop’s words count as kept, and a write for another stop is ignored', () => {
    const STOP_A = newStopId();
    const STOP_B = newStopId();
    const storage = mapStorage();
    writeUnsentEntry(storage, PROJECT, STOP_A, [{ docId: IDS.sceneA, title: 'Scene A', body: 'An earlier stop.' }]);
    noteStop(PROJECT, STOP_B);
    noteStopKept(STOP_A, true);
    expect(stopKeptInBrowser(storage)).toBe(false);
    noteStopKept(STOP_B, true);
    expect(stopKeptInBrowser(storage)).toBe(false);
  });

  test('a subscriber hears each change of the stop record, and an unsubscribed one hears none', () => {
    const STOP_A = newStopId();
    let heard = 0;
    const unsubscribe = subscribeStop(() => {
      heard += 1;
    });
    noteStop(PROJECT, STOP_A);
    noteStopKept(STOP_A, true);
    expect(heard).toBe(2);
    unsubscribe();
    noteStopKept(STOP_A, false);
    expect(heard).toBe(2);
  });
});

test.describe('putting the kept words back (putBackDocuments, restoreStep, unsent-copy.ts)', () => {
  /** A session's documents as the put-back sees them: created ids and their bodies. */
  function fakeSession(): { documents: Map<string, { body: string }>; creates: string[]; writes: string[] } {
    return { documents: new Map(), creates: [], writes: [] };
  }

  test('every kept document is made once, in order, and the entry stays until the caller removes it after a save', () => {
    const STOP_A = newStopId();
    const storage = mapStorage();
    writeUnsentEntry(storage, PROJECT, STOP_A, [
      { docId: IDS.sceneA, title: 'Scene A', body: 'A words.' },
      { docId: IDS.sceneB, title: 'Scene B', body: 'B words.' },
    ]);
    const session = fakeSession();
    let next = 0;
    const failure = putBackDocuments(storage, PROJECT, STOP_A, (doc, recordCreated) => {
      const step = restoreStep(doc, doc.restoredAs === undefined ? undefined : session.documents.get(doc.restoredAs));
      if (step.kind === 'done') return null;
      next += 1;
      const docId = `node-${next}`;
      session.creates.push(doc.docId);
      recordCreated(docId);
      session.documents.set(docId, { body: doc.body });
      return null;
    });
    expect(failure).toBeNull();
    expect(session.creates).toEqual([IDS.sceneA, IDS.sceneB]);
    // The copy still holds the entry, now with the id of each document it made, until the store has saved them.
    expect(readUnsentEntries(storage, PROJECT)[0]?.documents.map((doc) => doc.restoredAs)).toEqual(['node-1', 'node-2']);
    expect(removeUnsentEntry(storage, PROJECT, STOP_A)).toBe(true);
    expect(readUnsentEntries(storage, PROJECT)).toEqual([]);
  });

  test('a body write refused after its document was made is retried as a body write, never a second create', () => {
    const STOP_A = newStopId();
    const storage = mapStorage();
    writeUnsentEntry(storage, PROJECT, STOP_A, [
      { docId: IDS.sceneA, title: 'Scene A', body: 'A words.' },
      { docId: IDS.sceneB, title: 'Scene B', body: 'B words.' },
      { docId: IDS.sceneC, title: 'Scene C', body: 'C words.' },
    ]);
    const session = fakeSession();
    let refuseOnce = true;
    let next = 0;
    const put = (doc: UnsentDocument, recordCreated: (docId: string) => void): string | null => {
      const step = restoreStep(doc, doc.restoredAs === undefined ? undefined : session.documents.get(doc.restoredAs));
      if (step.kind === 'done') return null;
      let docId: string;
      if (step.kind === 'write') {
        docId = step.docId;
      } else {
        next += 1;
        docId = `node-${next}`;
        session.creates.push(doc.docId);
        recordCreated(docId);
        session.documents.set(docId, { body: '' });
      }
      if (doc.docId === IDS.sceneB && refuseOnce) {
        refuseOnce = false;
        return 'the words could not be written';
      }
      session.writes.push(docId);
      session.documents.set(docId, { body: doc.body });
      return null;
    };

    // The first try makes Scene A and Scene B, then Scene B's body write is refused.
    expect(putBackDocuments(storage, PROJECT, STOP_A, put)).toBe('the words could not be written');
    expect(session.creates).toEqual([IDS.sceneA, IDS.sceneB]);
    expect(readUnsentEntries(storage, PROJECT)[0]?.documents.map((doc) => doc.restoredAs)).toEqual(['node-1', 'node-2', undefined]);

    // The second try repeats Scene B's body write on the document it made, and makes only Scene C.
    expect(putBackDocuments(storage, PROJECT, STOP_A, put)).toBeNull();
    expect(session.creates).toEqual([IDS.sceneA, IDS.sceneB, IDS.sceneC]);
    expect(session.documents.get('node-2')?.body).toBe('B words.');
    expect(session.documents.size).toBe(3);
  });

  test('a document a put-back made and the writer deleted is made again, and one that holds words is left as the writer left it', () => {
    const kept: UnsentDocument = { docId: IDS.sceneA, title: 'Scene A', body: 'A words.', restoredAs: 'node-1' };
    expect(restoreStep(kept, { body: '' })).toEqual({ kind: 'write', docId: 'node-1' });
    expect(restoreStep(kept, { body: 'Typed since.' })).toEqual({ kind: 'done' });
    expect(restoreStep(kept, undefined)).toEqual({ kind: 'create' });
    expect(restoreStep({ docId: IDS.sceneA, title: 'Scene A', body: 'A words.' }, { body: '' })).toEqual({ kind: 'create' });
  });

  test('with no copy to put back, nothing is made and the answer is that every document is back', () => {
    const STOP_A = newStopId();
    const made: string[] = [];
    const failure = putBackDocuments(undefined, PROJECT, STOP_A, (doc) => {
      made.push(doc.docId);
      return null;
    });
    expect(failure).toBeNull();
    expect(made).toEqual([]);
  });
});

test('the kept-words stamp is written in the formatter locale, and an unreadable one is left blank', () => {
  // A local stamp, so the reading does not depend on the machine's timezone.
  expect(unsentStamp('2026-10-08T09:00:00', 'en-US')).toBe('Oct 8, 2026, 9:00:00 AM');
  expect(unsentStamp('2026-10-08T09:00:00', 'de-DE')).toBe('08.10.2026, 09:00:00');
  expect(unsentStamp('not a stamp', 'en-US')).toBe('');
});
