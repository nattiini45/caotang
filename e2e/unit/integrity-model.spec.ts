import { expect, test } from '@playwright/test';

import {
  MANIFEST_FILE,
  MemoryIndexedDb,
  ProjectRefusedError,
  SESSIONS_FILE,
  ZIP_ENGINE,
  addDocument,
  driftOf,
  exportProjectZip,
  importProjectZip,
  listProjectIds,
  openRuntimeStore,
  readProject,
  readProjectState,
  readSessions,
  serializeSessionsLog,
  writeDocumentBody,
  writeProject,
  writeProjectState,
  type CodexEntry,
  type RuntimeStore,
  type SessionRecord,
} from '../../packages/store/src/index.js';
import { emptyCoherenceFile, type Finding } from '../../packages/coherence/src/index.js';

import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { setActiveAppDb, type AppDb } from '../../apps/desktop/src/app/app-db.js';
import { copyState, shadowOf } from '../../apps/desktop/src/app/persistence-plan.js';
import { readUnsentEntries } from '../../apps/desktop/src/app/unsent-copy.js';
import { wordsWrittenToday } from '../../apps/desktop/src/app/session-progress.js';
import {
  droppedFieldsSentence,
  folderOpenRoute,
  folderProjectRoute,
  folderSaveVerdict,
  isOwnWrite,
  keepBrowserDigests,
  openNoticeLines,
  sampleToReuse,
  saveStateWords,
  sentenceOf,
  type FolderSaveFacts,
} from '../../apps/desktop/src/app/integrity-model.js';
import { acquireProjectLease, leaseName, ProjectOpenElsewhereError } from '../../apps/desktop/src/app/project-lease.js';
import { rememberedFolder } from '../../apps/desktop/src/app/folder-memory.js';
import {
  answerFolderDiffers,
  completeRecovery,
  exportBundle,
  folderChanges,
  importBundle,
  openDemoSample,
  openElsewhere,
  openFolder,
  openOrCreateSample,
  openProject,
  removeProject,
  saveFolder,
  takeLeaveSuggestion,
  noteLeaveSuggestion,
  type OpenOutcome,
} from '../../apps/desktop/src/app/lifecycle.js';
import {
  folderArtifactFs,
  type DirectoryHandleLike,
  type FileHandleLike,
} from '../../apps/desktop/src/app/fs-access.js';

import { IDS, project } from './fixtures.js';

/*
 * The decisions the data-safety paths make, pinned without a browser: the editor's own-write test, the folder save's verdict, the
 * sample a demo run reuses, the project lease, what a session reports about its save state and its copy, and the recovery offers.
 */

// ---------------------------------------------------------------------------
// The editor's own-write test
// ---------------------------------------------------------------------------

test.describe('a store change is the editor’s own write only when body and revision both match', () => {
  test('the same revision over different text is not this session’s write', () => {
    // The revision alone is not the write: the body is checked too, so other text on the same number is not taken for this
    // session's own write (an undo now moves the revision up, so this no longer happens through one).
    expect(isOwnWrite({ body: 'typed by the writer', revision: 1 }, 'a 239-character draft', 1)).toBe(false);
  });

  test('the same body at the same revision is this session’s write', () => {
    expect(isOwnWrite({ body: 'typed by the writer', revision: 1 }, 'typed by the writer', 1)).toBe(true);
  });

  test('a different revision is not, and neither is a session with no write recorded', () => {
    expect(isOwnWrite({ body: 'typed', revision: 1 }, 'typed', 2)).toBe(false);
    expect(isOwnWrite(null, 'typed', 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The folder save's verdict
// ---------------------------------------------------------------------------

const folder = (overrides: Partial<FolderSaveFacts>): FolderSaveFacts => ({
  onDisk: '{"v":1}',
  baseline: '{"v":1}',
  locked: false,
  lockConfirmed: false,
  overwriteConfirmed: false,
  filesChanged: false,
  ...overrides,
});

test.describe('a save to a folder is written only over the copy this session holds', () => {
  test('the copy this session last loaded or saved is written over', () => {
    expect(folderSaveVerdict(folder({}))).toBe('write');
  });

  test('a folder with no manifest is written, since there is nothing in it to lose', () => {
    expect(folderSaveVerdict(folder({ onDisk: null, baseline: null }))).toBe('write');
  });

  test('a caotang.json another program removed after this session loaded it is refused as changed, not recreated, and the writer can replace it', () => {
    // The session held a manifest in this folder (baseline set), and the folder has none now: a removal is a change.
    expect(folderSaveVerdict(folder({ onDisk: null }))).toBe('changed');
    expect(folderSaveVerdict(folder({ onDisk: null, overwriteConfirmed: true }))).toBe('write');
    // A removed manifest with a changed document is still the manifest's question first (the files are named in it).
    expect(folderSaveVerdict(folder({ onDisk: null, filesChanged: true }))).toBe('changed');
    // The lock is still asked before the removal: a locked folder is a different question.
    expect(folderSaveVerdict(folder({ onDisk: null, locked: true }))).toBe('locked');
  });

  test('a manifest another program changed after this session saw it is refused, and the writer can replace it', () => {
    expect(folderSaveVerdict(folder({ onDisk: '{"v":2}' }))).toBe('changed');
    expect(folderSaveVerdict(folder({ onDisk: '{"v":2}', overwriteConfirmed: true }))).toBe('write');
  });

  test('a folder whose project this session never loaded or saved is a question, not a write', () => {
    expect(folderSaveVerdict(folder({ baseline: null }))).toBe('unknown');
    expect(folderSaveVerdict(folder({ baseline: null, overwriteConfirmed: true }))).toBe('write');
  });

  test('a folder the MCP server holds is refused until the writer says to save anyway, and the lock is checked first', () => {
    expect(folderSaveVerdict(folder({ locked: true }))).toBe('locked');
    expect(folderSaveVerdict(folder({ locked: true, lockConfirmed: true }))).toBe('write');
    expect(folderSaveVerdict(folder({ locked: true, onDisk: '{"v":2}' }))).toBe('locked');
  });

  test('a document or codex file another program changed is refused as files, even when the manifest is the same', () => {
    expect(folderSaveVerdict(folder({ filesChanged: true }))).toBe('files');
    expect(folderSaveVerdict(folder({ filesChanged: true, overwriteConfirmed: true }))).toBe('write');
    // With the manifest changed, the manifest's own question comes first; the files are named in that question too (lifecycle `folderChanges`).
    expect(folderSaveVerdict(folder({ onDisk: '{"v":2}', filesChanged: true }))).toBe('changed');
  });

  test('a folder with no manifest is refused as files when a document this session held has changed, and written otherwise', () => {
    expect(folderSaveVerdict(folder({ onDisk: null, baseline: null, filesChanged: true }))).toBe('files');
    expect(folderSaveVerdict(folder({ onDisk: null, baseline: null, filesChanged: false }))).toBe('write');
  });
});

/** A codex entry with the fields a folder's codex file names (the store's own fields), for the names a change is given. */
function codexEntry(id: string, name: string): CodexEntry {
  return {
    id,
    name,
    aliases: [],
    type: 'character',
    description: 'The lighthouse keeper’s daughter.',
    includePolicy: 'detected',
    caseSensitive: false,
    exclude: [],
    attachments: [],
    keywords: [],
    origin: 'manual',
    sources: [],
    createdAt: '2026-10-08T09:00:00.000Z',
    updatedAt: '2026-10-08T09:00:00.000Z',
  };
}

test.describe('a change to a document is named by its title, and a file this copy does not hold is described', () => {
  const state = project();
  // The titles the copy held, by id, as the session keeps them.
  const held = new Map([
    [IDS.sceneA, 'Scene A'],
    [IDS.sceneB, 'Scene B'],
  ]);

  test('a changed document is named by its title, a removed one by its title, and an added one by a description', () => {
    const changes = folderChanges(
      { changed: [`docs/${IDS.sceneA}.md`], removed: [`docs/${IDS.sceneB}.md`], added: ['docs/n_B2C3D4E5F6.md'] },
      state,
      held,
    );

    expect(changes).toEqual([
      { label: 'the document “Scene A”', change: 'changed' },
      { label: 'the document “Scene B”', change: 'removed' },
      { label: 'a document this copy does not hold', change: 'added' },
    ]);
  });

  test('a document the writer deleted is still named, from the titles the copy held', () => {
    const next = project();
    next.documents.delete(IDS.sceneA);
    next.manifest.tree = next.manifest.tree.filter((node) => node.id !== IDS.sceneA);

    expect(folderChanges({ changed: [`docs/${IDS.sceneA}.md`], removed: [], added: [] }, next, held)).toEqual([
      { label: 'the document “Scene A”', change: 'changed' },
    ]);
  });

  test('a codex entry is named by its name, and no node id or file name reaches the writer', () => {
    const withCodex = project();
    withCodex.manifest.codex = [codexEntry('c_5H8QK2M9RT', 'Elena Voss')];

    const [change] = folderChanges({ changed: ['codex/c_5H8QK2M9RT.md'], removed: [], added: [] }, withCodex, new Map());

    expect(change?.label).toBe('the codex entry “Elena Voss”');
    expect(change?.label).not.toContain('c_5H8QK2M9RT');
  });
});

// ---------------------------------------------------------------------------
// The sample a demo run reuses
// ---------------------------------------------------------------------------

test.describe('a demo run reuses the writer’s sample', () => {
  test('the first sample the settings name that is still in the browser is the one reused', () => {
    expect(sampleToReuse(['p_GONE000001', 'p_KEEP000001', 'p_KEEP000002'], ['p_KEEP000002', 'p_KEEP000001'])).toBe('p_KEEP000001');
  });

  test('when none of the named samples is left, a new one is made', () => {
    expect(sampleToReuse(['p_GONE000001'], ['p_OTHER00001'])).toBeNull();
    expect(sampleToReuse([], ['p_OTHER00001'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The project lease, against a lock manager that behaves as the browser's does
// ---------------------------------------------------------------------------

/** A lock manager that grants one holder per name, and waits for a name that is held, as Web Locks does for `request`. */
function lockManager(): {
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown>;
} {
  const held = new Set<string>();
  return {
    request(name, options, callback) {
      const grant = (): Promise<unknown> => {
        held.add(name);
        return Promise.resolve(callback({ name })).finally(() => held.delete(name));
      };
      if (!held.has(name)) return grant();
      return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          if (options.signal?.aborted) {
            clearInterval(timer);
            reject(new DOMException('the request was aborted', 'AbortError'));
            return;
          }
          if (!held.has(name)) {
            clearInterval(timer);
            grant().then(resolve, reject);
          }
        }, 10);
      });
    },
  };
}

/** Runs `body` with a `navigator.locks` in place, and puts back whatever was there. */
async function withLocks(body: () => Promise<void>, locks: unknown | undefined): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true, writable: true });
  try {
    await body();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete (globalThis as Record<string, unknown>)['navigator'];
  }
}

/**
 * A store whose transactions over one object store are refused, as a full disk refuses them. Every other transaction runs as usual.
 * `refuse` says whether the refusal applies now, so a test can make the store fail and then work again.
 */
function refusingStore(store: RuntimeStore, storeName: string, refuse: () => boolean = () => true): RuntimeStore {
  const db = new Proxy(store.db, {
    get(target, property) {
      if (property === 'transaction') {
        return (storeNames: string | string[], mode?: IDBTransactionMode) => {
          const names = typeof storeNames === 'string' ? [storeNames] : storeNames;
          if (refuse() && names.includes(storeName)) throw new Error('the disk is full');
          return target.transaction(storeNames, mode);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db, name: store.name, close: () => store.close() };
}

test.describe('the project lease', () => {
  test('where the browser has no Web Locks, the lease is granted, and releasing it twice is harmless', async () => {
    await withLocks(async () => {
      const lease = await acquireProjectLease('p_NOLOCKS001');
      expect(lease).not.toBeNull();
      lease?.release();
      lease?.release();
    }, undefined);
  });

  test('a project another tab holds is refused, and the next tab has it once the first releases it', async () => {
    test.setTimeout(20_000);
    await withLocks(async () => {
      const first = await acquireProjectLease('p_SAME000001');
      expect(first).not.toBeNull();
      // Held by the first tab, so the second waits out its wait and is refused.
      expect(await acquireProjectLease('p_SAME000001')).toBeNull();
      // Another project is not held by it.
      const other = await acquireProjectLease('p_OTHER00001');
      expect(other).not.toBeNull();
      other?.release();

      first?.release();
      const third = await acquireProjectLease('p_SAME000001');
      expect(third).not.toBeNull();
      third?.release();
    }, lockManager());
  });

  test('the lock is named for the project, and the refusal says what to do', () => {
    expect(leaseName('p_SAME000001')).toBe('caotang:project:p_SAME000001');
    expect(new ProjectOpenElsewhereError('p_SAME000001').message).toContain('open in another tab');
  });

  test('a bundle whose sessions cannot be recorded gives the project’s lease back, so the next open is granted', async () => {
    test.setTimeout(20_000);
    const state = project();
    const bundle = await exportProjectZip(state, {
      sessions: [{ startedAt: '2026-10-01T09:00:00.000Z', endedAt: '2026-10-01T09:30:00.000Z', wordsWritten: 12, docIds: [IDS.sceneA] }],
    });
    const store = refusingStore(await openRuntimeStore(new MemoryIndexedDb()), 'sessions');
    await withLocks(async () => {
      await expect(importBundle(store, bundle.bytes, 'Fixture.caotang')).rejects.toThrow('the disk is full');
      // The session that could not be finished was closed, so the project is not held: its next open is granted at once.
      const lease = await acquireProjectLease(state.manifest.project.id);
      expect(lease).not.toBeNull();
      lease?.release();
    }, lockManager());
  });
});

// ---------------------------------------------------------------------------
// What a session reports: its save state, its copy, its folder
// ---------------------------------------------------------------------------

/** A session on a fresh in-memory store, as the lifecycle makes one, with the page's visibility and page-hide events stood in for. */
async function sessionOf(
  state: ReturnType<typeof project>,
): Promise<{ session: ProjectSession; store: RuntimeStore }> {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  await writeProjectState(store, state);
  const session = new ProjectSession({
    store,
    projectId: state.manifest.project.id,
    state,
    shadow: shadowOf(state),
  });
  return { session, store };
}

const globals = globalThis as unknown as Record<string, unknown>;
let previousGlobals: { document: unknown; window: unknown } | null = null;

test.beforeAll(() => {
  previousGlobals = { document: globals['document'], window: globals['window'] };
  globals['document'] = new EventTarget();
  globals['window'] = new EventTarget();
});

test.afterAll(() => {
  if (previousGlobals === null) return;
  globals['document'] = previousGlobals.document;
  globals['window'] = previousGlobals.window;
});

// ---------------------------------------------------------------------------
// The findings file leaves on the lifecycle signals (project-format §4)
// ---------------------------------------------------------------------------

test.describe('a findings save that failed is tried again when the tab is hidden or leaves', () => {
  /** A session whose findings save fails until `recover()`, and a finding added to the held file, which queues that save. */
  async function sessionWithFailingSave() {
    const state = project();
    const { session } = await sessionOf(state);
    let failing = true;
    const saved: string[] = [];
    session.attachCoherence(
      { file: emptyCoherenceFile(), writable: true, notices: [] },
      {
        save: async (next) => {
          if (failing) throw new Error('the store refused the findings');
          saved.push(JSON.stringify(next));
        },
        attachFolder: async () => {},
      },
    );
    const changed = emptyCoherenceFile();
    // The cast is the store's own record of a finding, which is all a save reads.
    changed.findings.push({
      id: 'f_AAAAAAAAAA',
      status: 'open',
      updatedAt: '2026-10-01T09:00:00.000Z',
      evidence: [{ docId: IDS.sceneA }],
    } as unknown as Finding);
    session.applyCoherenceFile(changed);
    await session.settle();
    expect(session.saveState()).toBe('failed');
    return {
      session,
      saved,
      changed,
      recover: (): void => {
        failing = false;
      },
    };
  }

  test('a hidden tab tries the failed findings save again, and the findings are saved', async () => {
    const { session, saved, changed, recover } = await sessionWithFailingSave();
    recover();
    (globals['document'] as EventTarget).dispatchEvent(new Event('visibilitychange'));
    await session.settle();
    expect(saved).toEqual([JSON.stringify(changed)]);
    expect(session.saveState()).toBe('saved');
    await session.close();
  });

  test('a page that is leaving tries the failed findings save again, and the findings are saved', async () => {
    const { session, saved, changed, recover } = await sessionWithFailingSave();
    recover();
    (globals['window'] as EventTarget).dispatchEvent(new Event('pagehide'));
    await session.settle();
    expect(saved).toEqual([JSON.stringify(changed)]);
    expect(session.saveState()).toBe('saved');
    await session.close();
  });

  test('a session that has closed starts no findings save when the page leaves', async () => {
    const { session, saved, recover } = await sessionWithFailingSave();
    await session.close();
    recover();
    (globals['window'] as EventTarget).dispatchEvent(new Event('pagehide'));
    // A macrotask lets any save the signal started run to its end before the count is read.
    await new Promise((done) => setTimeout(done, 0));
    expect(saved).toEqual([]);
  });
});

test.describe('what a session reports', () => {
  test('a body the store refused because another tab stored newer text is the conflict save state', async () => {
    const state = project();
    const { session, store } = await sessionOf(state);
    // The other tab's write lands first, at the revision this session expects.
    await writeDocumentBody(store, {
      projectId: state.manifest.project.id,
      docId: IDS.sceneA,
      body: 'Another tab, saved first',
      expectedRevision: 0,
    });
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'This tab, typed' });

    await session.settle();
    expect(session.saveState()).toBe('conflict');
    await session.close();
  });

  test('a session reports the changes since its copy, and taking a copy resets that', async () => {
    const state = project();
    const { session } = await sessionOf(state);
    session.markExported();
    expect(session.changedSinceExport()).toBe(false);

    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Changed after the copy' });
    expect(session.changedSinceExport()).toBe(true);

    session.markExported();
    expect(session.changedSinceExport()).toBe(false);
    await session.close();
  });

  test('a session no one has taken a copy for is never reported as changed', async () => {
    const { session } = await sessionOf(project());
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Changed, no baseline' });
    expect(session.changedSinceExport()).toBe(false);
    await session.close();
  });

  test('an undo drops the record of this session’s own writes, so a later change is not taken for one of them', async () => {
    const state = project();
    const { session } = await sessionOf(state);
    session.autosave.open(IDS.sceneA, { body: state.documents.get(IDS.sceneA)?.body ?? '', revision: 0 });
    session.autosave.noteEdit(IDS.sceneA, 'Typed by the writer');
    await session.autosave.flush();
    expect(session.lastWritten(IDS.sceneA)).toEqual({ body: 'Typed by the writer', revision: 1 });

    await session.undoLast();
    expect(session.lastWritten(IDS.sceneA)).toBeNull();
    await session.close();
  });

  test('the documents a save may remove are the ones this session deleted from the folder’s copy', async () => {
    const state = project();
    const { session } = await sessionOf(state);
    session.setFolderBaseline(memoryFolder('Fixture Book'), '{}', [IDS.sceneA, IDS.sceneB], new Map(), new Map());
    expect(session.documentsDeletedSinceFolder()).toEqual([]);

    state.documents.delete(IDS.sceneB);
    state.manifest.tree = state.manifest.tree.filter((node) => node.id !== IDS.sceneB);
    expect(session.documentsDeletedSinceFolder()).toEqual([IDS.sceneB]);
    await session.close();
  });

  test('closing a session gives its lease back, once, even when the close is asked twice', async () => {
    const state = project();
    const store = await openRuntimeStore(new MemoryIndexedDb());
    await writeProjectState(store, state);
    let released = 0;
    const session = new ProjectSession({
      store,
      projectId: state.manifest.project.id,
      state,
      shadow: shadowOf(state),
      onClosed: () => {
        released += 1;
      },
    });
    await session.close();
    await session.close();
    expect(released).toBe(1);
  });

  test('after a stale write stops the session, a dismissal changes the findings in memory and writes no findings file', async () => {
    const state = project();
    const { session, store } = await sessionOf(state);
    // One open finding, in the findings file this session holds. The cast is the store's own record of a finding, which is all a dismissal reads.
    const file = emptyCoherenceFile();
    file.findings.push({
      id: 'f_AAAAAAAAAA',
      status: 'open',
      updatedAt: '2026-10-01T09:00:00.000Z',
      evidence: [{ docId: IDS.sceneA }],
    } as unknown as Finding);
    const saves: string[] = [];
    session.attachCoherence(
      { file, writable: true, notices: [] },
      {
        save: async (next) => {
          saves.push(JSON.stringify(next));
        },
        attachFolder: async () => {},
      },
    );
    // Another tab stores newer text for the scene, so this session's write is refused and the session stops.
    await writeDocumentBody(store, {
      projectId: state.manifest.project.id,
      docId: IDS.sceneA,
      body: 'Another tab, saved first',
      expectedRevision: 0,
    });
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'This tab, typed' });
    await session.settle();
    expect(session.saveState()).toBe('conflict');
    saves.length = 0;

    const dismissed = session.dispatch('coherence.setFindingStatus', {
      findingId: 'f_AAAAAAAAAA',
      status: 'dismissed',
      reason: 'false-positive',
      note: 'Checked.',
    });
    expect(dismissed.ok).toBe(true);
    await session.settle();
    expect(session.coherenceFile()?.findings[0]?.status).toBe('dismissed');
    // The dismissal is kept in this tab, and nothing is written from it: another tab may hold newer findings.
    expect(saves).toEqual([]);
    await session.close();
  });

  test('a session a stale write has stopped refuses a save to a folder, and the folder is not written', async () => {
    const state = project();
    const root = memoryFolder('Fixture Book');
    await writeProject(folderArtifactFs(root), state);
    const { session, store } = await sessionOf(state);
    session.setFolderBaseline(root, await folderArtifactFs(root).read(MANIFEST_FILE), documentIdsOf(state), new Map(), new Map());
    await writeDocumentBody(store, {
      projectId: state.manifest.project.id,
      docId: IDS.sceneA,
      body: 'Another tab, saved first',
      expectedRevision: 0,
    });
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'This tab, typed' });
    await session.settle();
    expect(session.saveState()).toBe('conflict');

    const before = await folderArtifactFs(root).read(MANIFEST_FILE);
    await expect(saveFolder(session, root)).rejects.toThrow('This tab cannot save');
    expect(await folderArtifactFs(root).read(MANIFEST_FILE)).toBe(before);
    await session.close();
  });
});

// ---------------------------------------------------------------------------
// The recovery offer for a bundle whose caotang.json will not load
// ---------------------------------------------------------------------------

/** A bundle of the fixture project with its `caotang.json` cut short, and a backup of the good one beside it when asked. */
async function corruptBundle(options: { backup: boolean; documents: boolean }): Promise<Uint8Array> {
  const exported = await exportProjectZip(project());
  const { unzipSync, zipSync } = await ZIP_ENGINE.load();
  const entries = unzipSync(exported.bytes);
  const good = entries['caotang.json'];
  if (good === undefined) throw new Error('the fixture bundle has no caotang.json');
  if (options.backup) entries['caotang.json.bak.1'] = good;
  entries['caotang.json'] = new TextEncoder().encode('{"formatVersion": 1, "project": ');
  if (!options.documents) for (const name of Object.keys(entries)) if (name.startsWith('docs/')) delete entries[name];
  return zipSync(entries);
}

test.describe('a bundle whose caotang.json will not load is offered its recovery, and nothing is written until the writer says yes', () => {
  test('a bundle with an older copy of its manifest offers that copy, and naming it is the offer', async () => {
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const outcome: OpenOutcome = await importBundle(store, await corruptBundle({ backup: true, documents: true }), 'Fixture.caotang');
    if (outcome.kind !== 'recover') throw new Error('expected a recovery offer');
    expect(outcome.recovery.offer.source).toEqual({ kind: 'snapshot', path: 'caotang.json.bak.1', generation: 1 });
    expect(outcome.recovery.offer.requiresConsent).toBe(false);
    // The offer is read only: the store holds nothing yet.
    expect(await listProjectIds(store)).toEqual([]);
  });

  test('a bundle with no readable copy of its manifest offers a rebuild, which needs a yes and says what it loses', async () => {
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const outcome = await importBundle(store, await corruptBundle({ backup: false, documents: true }), 'Fixture.caotang');
    if (outcome.kind !== 'recover') throw new Error('expected a recovery offer');
    expect(outcome.recovery.offer.source.kind).toBe('rebuild');
    expect(outcome.recovery.offer.requiresConsent).toBe(true);
    expect(outcome.recovery.offer.loss.length).toBeGreaterThan(0);
    expect(await listProjectIds(store)).toEqual([]);
  });

  test('accepting the offer writes the recovered project as a new manifest, and opens it in the store', async () => {
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const outcome = await importBundle(store, await corruptBundle({ backup: true, documents: true }), 'Fixture.caotang');
    if (outcome.kind !== 'recover') throw new Error('expected a recovery offer');
    const accepted = await completeRecovery(store, outcome.recovery);
    if (accepted.kind !== 'opened') throw new Error('expected the recovery to open');
    const opened = accepted.opened;
    expect(opened.session.state.manifest.project.name).toBe('Fixture Book');
    expect(await listProjectIds(store)).toEqual([opened.session.projectId]);
    await opened.session.close();
  });

  test('a bundle with no manifest copy and no documents has nothing to offer, and the reason is said', async () => {
    const store = await openRuntimeStore(new MemoryIndexedDb());
    await expect(importBundle(store, await corruptBundle({ backup: false, documents: false }), 'Empty.caotang')).rejects.toThrow(
      'Caotang could not find a readable copy of this project',
    );
  });

  test('a file that is not a bundle is refused in the writer’s words, not the archive’s', async () => {
    await expect(importProjectZip(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow('This file is not a Caotang bundle.');
  });
});

// ---------------------------------------------------------------------------
// The recovery of a folder whose caotang.json will not load
// ---------------------------------------------------------------------------

/**
 * A folder whose caotang.json is cut short, with the good manifest kept as bak.1: what a folder looks like after a torn save. The
 * second write is what rotates the first manifest into the backup.
 */
async function damagedFolder(): Promise<DirectoryHandleLike> {
  const root = memoryFolder('Fixture Book');
  const fs = folderArtifactFs(root);
  await writeProject(fs, project());
  await writeProject(fs, project());
  await fs.writeAtomic(MANIFEST_FILE, '{"formatVersion": 1, "project": ');
  return root;
}

test.describe('a folder whose caotang.json will not load is offered its recovery, and the folder is checked before anything is written', () => {
  test('a folder with an older copy is offered it, and accepting keeps the damaged copy in the folder and opens the copy', async () => {
    const root = await damagedFolder();
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const outcome = await openFolder(store, root);
    if (outcome.kind !== 'recover') throw new Error('expected a recovery offer');
    expect(outcome.recovery.offer.source).toEqual({ kind: 'snapshot', path: 'caotang.json.bak.1', generation: 1 });

    const accepted = await completeRecovery(store, outcome.recovery);
    if (accepted.kind !== 'opened') throw new Error('expected the recovery to open');
    const fs = folderArtifactFs(root);
    // The damaged copy is kept beside the new manifest, under the dated name, with the bytes that were replaced.
    const kept = (await fs.listFiles('')).filter((name) => name.startsWith('caotang.json.corrupt-'));
    expect(kept).toHaveLength(1);
    expect(await fs.read(kept[0] ?? '')).toBe('{"formatVersion": 1, "project": ');
    expect(accepted.opened.session.state.manifest.project.name).toBe('Fixture Book');
    // The copy the session now holds is the one the folder holds, so a later save is checked against it.
    expect(accepted.opened.session.folderBaseline()?.manifestText).toBe(await fs.read(MANIFEST_FILE));
    await accepted.opened.session.close();
  });

  test('a folder changed after its recovery was offered is refused, and nothing is written', async () => {
    const root = await damagedFolder();
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const outcome = await openFolder(store, root);
    if (outcome.kind !== 'recover') throw new Error('expected a recovery offer');
    // Another program repairs caotang.json while the offer is on screen. The offer read the cut-short copy, so the file is now a change.
    const repaired = '{"formatVersion": 1, "project": {"name": "Repaired elsewhere"}}';
    const fs = folderArtifactFs(root);
    await fs.writeAtomic(MANIFEST_FILE, repaired);

    expect(await completeRecovery(store, outcome.recovery)).toEqual({ kind: 'refused', reason: 'changed', files: [] });
    expect(await fs.read(MANIFEST_FILE)).toBe(repaired);
    expect((await fs.listFiles('')).some((name) => name.startsWith('caotang.json.corrupt-'))).toBe(false);
    expect(await listProjectIds(store)).toEqual([]);
  });

  test('a folder with a lock file is refused until the writer says to recover anyway, and nothing is written before that', async () => {
    const root = await damagedFolder();
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const outcome = await openFolder(store, root);
    if (outcome.kind !== 'recover') throw new Error('expected a recovery offer');
    await root.getFileHandle('.caotang-mcp.lock', { create: true });
    const fs = folderArtifactFs(root);
    const damaged = await fs.read(MANIFEST_FILE);

    expect(await completeRecovery(store, outcome.recovery)).toEqual({ kind: 'refused', reason: 'locked', files: [] });
    expect(await fs.read(MANIFEST_FILE)).toBe(damaged);
    expect(await listProjectIds(store)).toEqual([]);

    const accepted = await completeRecovery(store, outcome.recovery, { lockConfirmed: true });
    expect(accepted.kind).toBe('opened');
    if (accepted.kind === 'opened') await accepted.opened.session.close();
  });
});

// ---------------------------------------------------------------------------
// The sample a demo run opens
// ---------------------------------------------------------------------------

test.describe('a folder recovery is checked against the documents the offer read, and names what changed', () => {
  test('a document another program changed after the offer is named by its title, and the recovery writes nothing', async () => {
    const root = await damagedFolder();
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const outcome = await openFolder(store, root);
    if (outcome.kind !== 'recover') throw new Error('expected a recovery offer');
    const fs = folderArtifactFs(root);
    const damaged = await fs.read(MANIFEST_FILE);
    const document = (await fs.listFiles('docs')).find((name) => name.endsWith('.md'));
    if (document === undefined) throw new Error('the fixture folder holds no document file');
    await fs.writeAtomic(`docs/${document}`, 'Changed by another program after the offer.');

    const refused = await completeRecovery(store, outcome.recovery);
    expect(refused.kind).toBe('refused');
    if (refused.kind !== 'refused') throw new Error('expected a refusal');
    expect(refused.reason).toBe('files');
    expect(refused.files.some((file) => file.change === 'changed' && file.label.startsWith('the document “'))).toBe(true);
    // Nothing was written: the damaged manifest is still there, no copy was kept beside it, and no project was made.
    expect(await fs.read(MANIFEST_FILE)).toBe(damaged);
    expect((await fs.listFiles('')).some((name) => name.startsWith('caotang.json.corrupt-'))).toBe(false);
    expect(await listProjectIds(store)).toEqual([]);
  });
});

test.describe('a folder whose project another tab holds is refused, as the list refuses it', () => {
  test('the folder open is refused while another tab holds the project, and no second copy of the book is made', async () => {
    test.setTimeout(20_000);
    const state = project();
    const id = state.manifest.project.id;
    const root = memoryFolder('Fixture Book');
    await writeProject(folderArtifactFs(root), state);
    const store = await openRuntimeStore(new MemoryIndexedDb());
    await writeProjectState(store, state);

    await withLocks(async () => {
      const otherTab = await acquireProjectLease(id);
      expect(otherTab).not.toBeNull();
      await expect(openFolder(store, root)).rejects.toBeInstanceOf(ProjectOpenElsewhereError);
      // The list holds the one project, not a second one with a new id for the same book.
      expect(await listProjectIds(store)).toEqual([id]);
      otherTab?.release();
    }, lockManager());
  });
});

test.describe('a folder of a project this browser keeps is that project, whatever order the two copies’ keys were made in', () => {
  test('the folder opens as the stored project, not as a copy, when the stored copy orders its node keys differently', async () => {
    const state = project();
    const root = memoryFolder('Fixture Book');
    await writeProject(folderArtifactFs(root), state);
    // A project made in this browser holds its nodes' keys in the order it was made in, and the folder's copy reads back in the serializer's
    // order. The same book in those two orders is the same book.
    const stored = project();
    // The same project: a new state takes a new id and a new identifier, so the stored copy is given the folder's.
    stored.manifest.project.id = state.manifest.project.id;
    stored.manifest.project.identifier = state.manifest.project.identifier;
    stored.manifest.tree = stored.manifest.tree.map((node) => Object.fromEntries(Object.entries(node).reverse()) as typeof node);
    const store = await openRuntimeStore(new MemoryIndexedDb());
    await writeProjectState(store, stored);

    const outcome = await openFolder(store, root);
    if (outcome.kind !== 'opened') throw new Error('the fixture folder should open as a project');
    expect(outcome.opened.copiedFrom).toBeNull();
    expect(outcome.opened.session.projectId).toBe(state.manifest.project.id);
    expect(await listProjectIds(store)).toEqual([state.manifest.project.id]);
    await outcome.opened.session.close();
  });
});

test.describe('a manifest another program wrote in a newer format is refused, not offered a rebuild', () => {
  test('a folder whose caotang.json names a newer format is refused in words, and nothing is offered or written', async () => {
    const root = memoryFolder('Fixture Book');
    const fs = folderArtifactFs(root);
    await writeProject(fs, project());
    const manifest = JSON.parse(await fs.read(MANIFEST_FILE)) as Record<string, unknown>;
    manifest.formatVersion = 2;
    const newer = JSON.stringify(manifest);
    await fs.writeAtomic(MANIFEST_FILE, newer);
    const store = await openRuntimeStore(new MemoryIndexedDb());

    const refused = openFolder(store, root);
    await expect(refused).rejects.toBeInstanceOf(ProjectRefusedError);
    await expect(refused).rejects.toThrow('format version 2');
    expect(await fs.read(MANIFEST_FILE)).toBe(newer);
    expect((await fs.listFiles('')).some((name) => name.startsWith('caotang.json.corrupt-'))).toBe(false);
    expect(await listProjectIds(store)).toEqual([]);
  });
});

test.describe('the folder copy a session holds carries the digests and titles of the folder', () => {
  test('a folder opened holds the digest of each document and codex file it has, and their titles', async () => {
    const { session } = await folderSession();
    const baseline = session.folderBaseline();
    expect(baseline).not.toBeNull();
    expect(baseline?.digests.size).toBeGreaterThan(0);
    for (const path of baseline?.digests.keys() ?? []) expect(path.startsWith('docs/') || path.startsWith('codex/')).toBe(true);
    expect(baseline?.titles.size).toBeGreaterThan(0);
    await session.close();
  });
});

test.describe('an export of an open project does not stamp it as changed', () => {
  test('the open project’s manifest keeps its save time after a bundle is made from it', async () => {
    const state = project();
    const store = await openRuntimeStore(new MemoryIndexedDb());
    await writeProjectState(store, state);
    const session = await openProject(store, state.manifest.project.id);
    const before = session.state.manifest.project.modifiedAt;
    await exportBundle(store, session);
    expect(session.state.manifest.project.modifiedAt).toBe(before);
    await session.close();
  });
});

test.describe('a demo run reuses the sample the writer already has', () => {
  test('a run with no sample makes one, and a run after it reuses that one', async () => {
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const first = await openOrCreateSample(store, []);
    expect(first.created).toBe(true);
    await first.session.close();

    const second = await openOrCreateSample(store, [first.session.projectId]);
    expect(second.created).toBe(false);
    expect(second.session.projectId).toBe(first.session.projectId);
    expect(await listProjectIds(store)).toEqual([first.session.projectId]);
    await second.session.close();
  });

  test('a demo sample the settings cannot record is closed and not shown, and its lease is given back', async () => {
    test.setTimeout(20_000);
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const settings = {
      current: () => ({ sampleProjectIds: [] as readonly string[] }),
      update: async (): Promise<unknown> => {
        throw new Error('the settings could not be saved');
      },
    };
    await withLocks(async () => {
      await expect(openDemoSample(store, settings)).rejects.toThrow('the settings could not be saved');
      // The sample was made, and is not shown: closing it gave its lease back, so the next open of it is granted.
      const [sampleId] = await listProjectIds(store);
      expect(sampleId).toBeDefined();
      const lease = await acquireProjectLease(sampleId ?? '');
      expect(lease).not.toBeNull();
      lease?.release();
    }, lockManager());
  });
});

// ---------------------------------------------------------------------------
// The leave suggestion is handed to the projects screen once
// ---------------------------------------------------------------------------

test('a leave suggestion waits for the projects screen, and is taken once', () => {
  noteLeaveSuggestion({ projectId: 'p_LEAVE00001', name: 'Leave Book' });
  expect(takeLeaveSuggestion()).toEqual({ projectId: 'p_LEAVE00001', name: 'Leave Book' });
  expect(takeLeaveSuggestion()).toBeNull();
});

// ---------------------------------------------------------------------------
// The save indicator's words
// ---------------------------------------------------------------------------

test.describe('the save indicator says what is safe, and what to do', () => {
  test('a failed save says the words are safe in the tab, and offers a backup', () => {
    const words = saveStateWords('failed');
    expect(words.text).toContain('Your words are safe in this tab');
    expect(words.text).toContain('written again on the next change');
    expect(words.offersBackup).toBe(true);
  });

  test('a stop caused by another tab’s upgrade says so, and says what to do; newer text in another tab keeps its words', () => {
    expect(saveStateWords('conflict', 'updated')).toEqual({
      text: 'Caotang was updated in another tab, so this tab cannot save. Export a backup, then reload this tab.',
      offersBackup: false,
    });
    expect(saveStateWords('conflict', 'newer-text')).toEqual({ text: 'Another tab has newer text', offersBackup: false });
  });

  test('the other states say what they are, and offer nothing', () => {
    expect(saveStateWords('saved')).toEqual({ text: 'All changes saved in this browser', offersBackup: false });
    expect(saveStateWords('saving')).toEqual({ text: 'Saving…', offersBackup: false });
    expect(saveStateWords('conflict')).toEqual({ text: 'Another tab has newer text', offersBackup: false });
  });
});

// ---------------------------------------------------------------------------
// Saving to a folder, against an in-memory folder that follows the handle contract
// ---------------------------------------------------------------------------

type MemoryNode = { kind: 'file'; text: string } | { kind: 'directory'; children: Map<string, MemoryNode> };

function notFoundError(name: string): Error {
  const error = new Error(`no entry named ${name}`);
  error.name = 'NotFoundError';
  return error;
}

/** A folder handle the browser can compare with another, as `FileSystemHandle.isSameEntry` does. */
type MemoryFolder = DirectoryHandleLike & { isSameEntry(other: DirectoryHandleLike): Promise<boolean> };

/** The children of each in-memory folder, by handle. Two handles to one folder share a children map, which is what `isSameEntry` compares. */
const childrenOfHandle = new WeakMap<DirectoryHandleLike, Map<string, MemoryNode>>();

/** An in-memory folder with the File System Access handle contract: a missing entry is a NotFoundError, and a writable lands on close. */
function memoryFolder(name: string, children: Map<string, MemoryNode> = new Map()): DirectoryHandleLike {
  const folder: MemoryFolder = {
    kind: 'directory',
    name,
    async isSameEntry(other: DirectoryHandleLike) {
      return childrenOfHandle.get(other) === children;
    },
    async getDirectoryHandle(child: string, options?: { create?: boolean }) {
      let node = children.get(child);
      if (node === undefined) {
        if (!options?.create) throw notFoundError(child);
        node = { kind: 'directory', children: new Map() };
        children.set(child, node);
      }
      if (node.kind !== 'directory') throw new Error(`${child} is a file`);
      return memoryFolder(child, node.children);
    },
    async getFileHandle(child: string, options?: { create?: boolean }) {
      let node = children.get(child);
      if (node === undefined) {
        if (!options?.create) throw notFoundError(child);
        node = { kind: 'file', text: '' };
        children.set(child, node);
      }
      if (node.kind !== 'file') throw new Error(`${child} is a folder`);
      const file = node;
      const handle: FileHandleLike = {
        kind: 'file',
        name: child,
        async getFile() {
          const text = file.text;
          return { text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
        },
        async createWritable() {
          let bytes: Uint8Array = new Uint8Array(0);
          return {
            async write(data: string | Uint8Array) {
              bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
            },
            async close() {
              file.text = new TextDecoder().decode(bytes);
            },
          };
        },
      };
      return handle;
    },
    async removeEntry(child: string) {
      if (!children.has(child)) throw notFoundError(child);
      children.delete(child);
    },
    async *entries() {
      for (const [childName, node] of children) {
        yield [childName, { kind: node.kind, name: childName }] as [string, { kind: 'file' | 'directory'; name: string }];
      }
    },
  };
  childrenOfHandle.set(folder, children);
  return folder;
}

/** A second handle to the folder `root` names: a fresh object for the same folder, as a second folder pick gives. */
function sameFolderAgain(root: DirectoryHandleLike): DirectoryHandleLike {
  return memoryFolder(root.name, childrenOfHandle.get(root) ?? new Map());
}

/**
 * A handle to the folder `root` names that calls `change` once the file at `path` has been written through it: another program acting
 * between two of a save's writes. It is the same folder, so the copy a session holds for `root` counts for it.
 */
function changeAfterWrite(root: DirectoryHandleLike, path: string, change: () => void): DirectoryHandleLike {
  const wrap = (dir: DirectoryHandleLike, at: string): DirectoryHandleLike => ({
    ...dir,
    async getDirectoryHandle(child: string, options?: { create?: boolean }) {
      return wrap(await dir.getDirectoryHandle(child, options), `${at}${child}/`);
    },
    async getFileHandle(child: string, options?: { create?: boolean }) {
      const handle = await dir.getFileHandle(child, options);
      if (`${at}${child}` !== path) return handle;
      return {
        ...handle,
        async createWritable() {
          const writable = await handle.createWritable();
          return {
            ...writable,
            async close() {
              await writable.close();
              change();
            },
          };
        },
      };
    },
  });
  const racing = wrap(root, '');
  childrenOfHandle.set(racing, childrenOfHandle.get(root) ?? new Map());
  return racing;
}

/** Sets the text of the file at `path` in an in-memory folder, as another program writing it would. */
function setFileText(root: DirectoryHandleLike, path: string, text: string): void {
  const segments = path.split('/');
  let children = childrenOfHandle.get(root);
  for (const segment of segments.slice(0, -1)) {
    const node = children?.get(segment);
    children = node?.kind === 'directory' ? node.children : undefined;
  }
  const file = children?.get(segments[segments.length - 1] ?? '');
  if (file?.kind !== 'file') throw new Error(`${path} is not a file in the folder`);
  file.text = text;
}

/** The ids of a state's documents, as a session's folder baseline names them. */
function documentIdsOf(state: ReturnType<typeof project>): string[] {
  return state.manifest.tree.filter((node) => node.type === 'document').map((node) => node.id);
}

/** A session whose project is in an in-memory folder, with the folder's copy as its baseline, as opening the folder leaves it. */
async function folderSession(): Promise<{ session: ProjectSession; root: DirectoryHandleLike; state: ReturnType<typeof project> }> {
  const state = project();
  const root = memoryFolder('Fixture Book');
  await writeProject(folderArtifactFs(root), state);
  // The session is opened from the folder as the lifecycle opens one, so its folder copy holds the digests and titles a folder open takes.
  const opened = await openFolder(await openRuntimeStore(new MemoryIndexedDb()), root);
  if (opened.kind !== 'opened') throw new Error('the fixture folder should open as a project');
  return { session: opened.opened.session, root, state: opened.opened.session.state };
}

test.describe('saving to a folder: what is written, and what is left alone', () => {
  test('a folder holding the copy this session loaded is written, and the copy is read back as the new baseline', async () => {
    const { session, root } = await folderSession();
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Saved to the folder' });

    expect(await saveFolder(session, root)).toEqual({ kind: 'saved' });
    expect(await folderArtifactFs(root).read(MANIFEST_FILE)).toBe(session.folderBaseline()?.manifestText);
    await session.close();
  });

  test('a folder another program has changed is refused, nothing is written, and the writer can replace it', async () => {
    const { session, root } = await folderSession();
    const otherText = '{"formatVersion": 1, "changed": "by another program"}';
    await folderArtifactFs(root).writeAtomic(MANIFEST_FILE, otherText);
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Not written' });

    expect(await saveFolder(session, root)).toEqual({ kind: 'refused', reason: 'changed', files: [] });
    expect(await folderArtifactFs(root).read(MANIFEST_FILE)).toBe(otherText);

    expect(await saveFolder(session, root, { overwriteConfirmed: true })).toEqual({ kind: 'saved' });
    await session.close();
  });

  test('an external edit to a document makes the save refuse, and the file keeps the bytes the other program wrote', async () => {
    const { session, root } = await folderSession();
    const fs = folderArtifactFs(root);
    const otherText = `---\nid: ${IDS.sceneA}\ntitle: Scene A\n---\n\nEdited by another program.\n`;
    await fs.writeAtomic(`docs/${IDS.sceneA}.md`, otherText);
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Not written' });

    expect(await saveFolder(session, root)).toEqual({
      kind: 'refused',
      reason: 'files',
      files: [{ label: 'the document “Scene A”', change: 'changed' }],
    });
    expect(await fs.read(`docs/${IDS.sceneA}.md`)).toBe(otherText);

    // The writer's yes replaces the document, and the folder then holds this tab's text.
    expect(await saveFolder(session, root, { overwriteConfirmed: true })).toEqual({ kind: 'saved' });
    expect(await fs.read(`docs/${IDS.sceneA}.md`)).toContain('Not written');
    await session.close();
  });

  test('a document another program changes while the save writes is not written, and the refusal says the save stopped part way', async () => {
    const { session, root } = await folderSession();
    const fs = folderArtifactFs(root);
    const otherText = `---\nid: ${IDS.sceneB}\ntitle: Scene B\n---\n\nEdited by another program during the save.\n`;
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Written before the change' });
    session.dispatch('doc.write', { docId: IDS.sceneB, body: 'Not written' });
    // The other program writes Scene B as soon as the save has written Scene A, after the save's check of the whole folder.
    const racing = changeAfterWrite(root, `docs/${IDS.sceneA}.md`, () => setFileText(root, `docs/${IDS.sceneB}.md`, otherText));

    expect(await saveFolder(session, racing)).toEqual({
      kind: 'refused',
      reason: 'files',
      files: [{ label: 'the document “Scene B”', change: 'changed' }],
      partial: true,
    });
    expect(await fs.read(`docs/${IDS.sceneA}.md`)).toContain('Written before the change');
    expect(await fs.read(`docs/${IDS.sceneB}.md`)).toBe(otherText);
    await session.close();
  });

  test('a folder the MCP server holds is refused until the writer says to save anyway', async () => {
    const { session, root } = await folderSession();
    await root.getFileHandle('.caotang-mcp.lock', { create: true });

    expect(await saveFolder(session, root)).toEqual({ kind: 'refused', reason: 'locked', files: [] });
    expect(await saveFolder(session, root, { lockConfirmed: true })).toEqual({ kind: 'saved' });
    await session.close();
  });

  test('a folder with a manifest this session never loaded is a question, and a save removes only the documents the session deleted', async () => {
    const state = project();
    const root = memoryFolder('Fixture Book');
    const { session } = await sessionOf(state);
    // A manifest this session never loaded: the question comes first.
    await folderArtifactFs(root).writeAtomic(MANIFEST_FILE, '{"formatVersion": 1}');
    expect(await saveFolder(session, root)).toEqual({ kind: 'refused', reason: 'unknown', files: [] });

    // With the writer's yes, the folder is written, and its copy becomes the baseline.
    expect(await saveFolder(session, root, { overwriteConfirmed: true })).toEqual({ kind: 'saved' });
    // A document the session then deletes, and a document file another writer put in the folder.
    await folderArtifactFs(root).writeAtomic('docs/n_B2C3D4E5F6.md', '---\nid: n_B2C3D4E5F6\n---\n\nnot ours\n');
    state.documents.delete(IDS.sceneB);
    state.manifest.tree = state.manifest.tree.filter((node) => node.id !== IDS.sceneB);

    // A document file another writer added is a change this copy does not hold: the save is refused, and the file is kept.
    const fs = folderArtifactFs(root);
    expect(await saveFolder(session, root)).toEqual({
      kind: 'refused',
      reason: 'files',
      files: [{ label: 'a document this copy does not hold', change: 'added' }],
    });
    expect(await fs.exists('docs/n_B2C3D4E5F6.md')).toBe(true);

    // The writer's yes saves, and removes only the document this session deleted.
    expect(await saveFolder(session, root, { overwriteConfirmed: true })).toEqual({ kind: 'saved' });
    expect(await fs.exists(`docs/${IDS.sceneB}.md`)).toBe(false);
    expect(await fs.exists('docs/n_B2C3D4E5F6.md')).toBe(true);
    await session.close();
  });

  test('a copy taken from one folder is no baseline for another: a manifest in the other folder is a question, not a change', async () => {
    const { session, root } = await folderSession();
    const other = memoryFolder('Other book');
    const otherText = '{"formatVersion": 1, "other": "book"}';
    await folderArtifactFs(other).writeAtomic(MANIFEST_FILE, otherText);
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Not for the other book' });

    expect(await saveFolder(session, other)).toEqual({ kind: 'refused', reason: 'unknown', files: [] });
    expect(await folderArtifactFs(other).read(MANIFEST_FILE)).toBe(otherText);
    // The folder the copy was taken from still holds it, so it is still written.
    expect(await saveFolder(session, root)).toEqual({ kind: 'saved' });
    await session.close();
  });

  test('a folder picked again is the same folder, so the copy the session holds still counts for it', async () => {
    const { session, root } = await folderSession();
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Saved through a second pick' });
    expect(await saveFolder(session, sameFolderAgain(root))).toEqual({ kind: 'saved' });
    await session.close();
  });
});

// ---------------------------------------------------------------------------
// The data-safety rules of a folder save, end to end over an in-memory folder
// ---------------------------------------------------------------------------

/** A dialogue container the folder tests add: a body file of its own, `docs/<id>.ink`, which a save must remove with the container. */
const DIALOGUE = 'n_DRAMA00001';

test.describe('a document file the load declined is kept by the folder writer', () => {
  test('a copy of a state carries the document files the load declined, and the text they hold', () => {
    const state = project();
    state.declinedDocFiles.add('n_DECLINED01.md');
    state.declinedText.set('docs/n_DECLINED01.md', 'The bytes the load could not hold.');

    const copy = copyState(state);

    expect([...copy.declinedDocFiles]).toEqual(['n_DECLINED01.md']);
    expect(copy.declinedText.get('docs/n_DECLINED01.md')).toBe('The bytes the load could not hold.');
  });

  test('a document whose body the load held is written through a copy, and its file is left where it is', async () => {
    const state = project();
    const root = memoryFolder('Held Book');
    await writeProject(folderArtifactFs(root), state);
    // The load held the scene: no body record, and its file declined, as a body that is not UTF-8 text is.
    state.documents.delete(IDS.sceneA);
    state.declinedDocFiles.add(`${IDS.sceneA}.md`);

    await expect(writeProject(folderArtifactFs(root), copyState(state), { now: new Date(), pruneDocumentIds: [] })).resolves.toBeDefined();
    expect(await folderArtifactFs(root).exists(`docs/${IDS.sceneA}.md`)).toBe(true);
  });

  test('what the load declined survives a round trip through the runtime store and a bundle', async () => {
    const state = project();
    state.declinedDocFiles.add('n_DECLINED01.md');
    state.declinedText.set('docs/n_DECLINED01.md', 'The bytes the load could not hold.');
    const store = await openRuntimeStore(new MemoryIndexedDb());

    await writeProjectState(store, copyState(state));
    const back = await readProjectState(store, state.manifest.project.id);
    expect([...back.declinedDocFiles]).toEqual(['n_DECLINED01.md']);
    expect(back.declinedText.get('docs/n_DECLINED01.md')).toBe('The bytes the load could not hold.');

    const bundle = await exportProjectZip(back, { sessions: [] });
    const unpacked = await importProjectZip(bundle.bytes);
    expect(await unpacked.fs.read('docs/n_DECLINED01.md')).toBe('The bytes the load could not hold.');
  });

  test('a stray document file named for a folder survives the identity backfill that opening the folder writes', async () => {
    const root = memoryFolder('Pre-identity Book');
    await writeProject(folderArtifactFs(root), project());
    const fs = folderArtifactFs(root);
    // A manifest with no language, as an older build wrote it. The open backfills it, and that write is the one that used to delete the stray file.
    const manifest = JSON.parse(await fs.read(MANIFEST_FILE)) as { project: Record<string, unknown> };
    delete manifest.project['language'];
    await fs.writeAtomic(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
    // A document file named for a folder node. The load declines it, because a folder has no body, and the file is the author's.
    const stray = `docs/${IDS.chapterOne}.md`;
    const text = '---\nid: n_CH100000AA\ntitle: Kept by hand\n---\n\nA note the folder keeps.\n';
    await fs.writeAtomic(stray, text);

    const opened = await openFolder(await openRuntimeStore(new MemoryIndexedDb()), root);
    expect(opened.kind).toBe('opened');
    if (opened.kind !== 'opened') return;
    await opened.opened.session.close();

    expect(await fs.read(stray)).toBe(text);
  });
});

test.describe('a folder reopened in this browser keeps its project id', () => {
  test('a copy opened from the folder cannot be saved into it, in words, and the folder keeps its id', async () => {
    const state = project();
    const root = memoryFolder('Fixture Book');
    await writeProject(folderArtifactFs(root), state);
    const store = await openRuntimeStore(new MemoryIndexedDb());

    const first = await openFolder(store, root);
    expect(first.kind).toBe('opened');
    if (first.kind !== 'opened') return;
    // The writer types in this copy and does not save it, so the project this browser keeps differs from the folder.
    first.opened.session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Typed in the first copy' });
    await first.opened.session.close();

    // The stored project differs from the folder, so the second open asks, and the writer's "Open as a separate copy" makes a copy with a fresh id.
    const asked = await openFolder(store, root);
    if (asked.kind !== 'differs') throw new Error('the open should ask which version to keep');
    const second = await answerFolderDiffers(store, asked.differs, 'separate-copy');
    const copy = second.session;
    expect(second.copiedFrom).toBe(state.manifest.project.id);
    expect(copy.state.manifest.project.id).not.toBe(state.manifest.project.id);
    const before = await folderArtifactFs(root).read(MANIFEST_FILE);
    copy.dispatch('doc.write', { docId: IDS.sceneA, body: 'Typed in the copy' });

    await expect(saveFolder(copy, root)).rejects.toThrow('cannot be saved into that folder');
    expect(await folderArtifactFs(root).read(MANIFEST_FILE)).toBe(before);

    // The copy can still be saved to a folder of its own.
    expect(await saveFolder(copy, memoryFolder('A New Book'))).toEqual({ kind: 'saved' });
    await copy.close();
  });

  test('a folder reopened after it was closed opens the same project, and a save writes the folder as the session holds it', async () => {
    const state = project();
    const root = memoryFolder('Round Trip Book');
    await writeProject(folderArtifactFs(root), state);
    const store = await openRuntimeStore(new MemoryIndexedDb());

    const first = await openFolder(store, root);
    if (first.kind !== 'opened') throw new Error('the folder should open');
    await first.opened.session.close();

    // The same book is already in this browser, so the folder opens that project, not a copy of it.
    const second = await openFolder(store, root);
    if (second.kind !== 'opened') throw new Error('the folder should open again');
    expect(second.opened.copiedFrom).toBeNull();
    const session = second.opened.session;
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Edited after reopening' });

    expect(await saveFolder(session, root)).toEqual({ kind: 'saved' });
    const fs = folderArtifactFs(root);
    expect(await fs.read(MANIFEST_FILE)).toBe(session.folderBaseline()?.manifestText);
    const onDisk = await readProject(fs);
    expect(onDisk.state.manifest.project.id).toBe(session.state.manifest.project.id);
    for (const [id, record] of session.state.documents) {
      expect(onDisk.state.documents.get(id)?.body).toBe(record.body);
    }
    await session.close();
  });
});

// A folder holding another project: whose project a folder holds decides the question.
test.describe('a save into a folder holding a project: another project, the original of a copy, or this project’s own earlier save', () => {
  test('the route: no id, this project, the book a copy was made from, and any other project', () => {
    expect(folderProjectRoute({ folderId: undefined, ownId: 'p_A', copiedFrom: null })).toBe('none');
    expect(folderProjectRoute({ folderId: 'p_A', ownId: 'p_A', copiedFrom: null })).toBe('own');
    expect(folderProjectRoute({ folderId: 'p_A', ownId: 'p_A', copiedFrom: 'p_B' })).toBe('own');
    expect(folderProjectRoute({ folderId: 'p_B', ownId: 'p_A', copiedFrom: 'p_B' })).toBe('original');
    expect(folderProjectRoute({ folderId: 'p_C', ownId: 'p_A', copiedFrom: 'p_B' })).toBe('other');
    expect(folderProjectRoute({ folderId: 'p_C', ownId: 'p_A', copiedFrom: null })).toBe('other');
  });

  test('the verdict: this project’s own earlier save with no baseline is “earlier”, never “unknown”, and a yes writes it', () => {
    expect(folderSaveVerdict(folder({ baseline: null, sameProject: true }))).toBe('earlier');
    expect(folderSaveVerdict(folder({ baseline: null, sameProject: false }))).toBe('unknown');
    expect(folderSaveVerdict(folder({ baseline: null, sameProject: true, overwriteConfirmed: true }))).toBe('write');
    // The lock is still asked first, and a folder with a baseline is checked against it as before.
    expect(folderSaveVerdict(folder({ baseline: null, sameProject: true, locked: true }))).toBe('locked');
    expect(folderSaveVerdict(folder({ sameProject: true, onDisk: '{"v":2}' }))).toBe('changed');
  });

  test('a folder holding another project asks (unknown), and “Save over it” writes this project there with a backup of the caotang.json', async () => {
    const root = memoryFolder('Another Book');
    const other = project();
    await writeProject(folderArtifactFs(root), other);
    const theirs = await folderArtifactFs(root).read(MANIFEST_FILE);
    const { session } = await sessionOf(project());
    expect(session.state.manifest.project.id).not.toBe(other.manifest.project.id);

    expect(await saveFolder(session, root)).toEqual({ kind: 'refused', reason: 'unknown', files: [] });
    expect(await folderArtifactFs(root).read(MANIFEST_FILE)).toBe(theirs);

    expect(await saveFolder(session, root, { overwriteConfirmed: true })).toEqual({ kind: 'saved' });
    const onDisk = await readProject(folderArtifactFs(root));
    expect(onDisk.state.manifest.project.id).toBe(session.state.manifest.project.id);
    expect(await folderArtifactFs(root).read(`${MANIFEST_FILE}.bak.1`)).toBe(theirs);
    await session.close();
  });

  test('a copy made from a folder’s own book is refused there after a reload too, and asked about in any other project’s folder', async () => {
    setActiveAppDb(handleDb());
    try {
      const state = project();
      const root = memoryFolder('Original Book');
      await writeProject(folderArtifactFs(root), state);
      const store = await openRuntimeStore(new MemoryIndexedDb());
      const first = await openFolder(store, root);
      if (first.kind !== 'opened') throw new Error('the folder should open');
      first.opened.session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Typed in the original' });
      await first.opened.session.close();
      const asked = await openFolder(store, root);
      if (asked.kind !== 'differs') throw new Error('the open should ask');
      const copy = await answerFolderDiffers(store, asked.differs, 'separate-copy');
      const copyId = copy.session.projectId;
      await copy.session.close();

      // After a reload the copy opens from the projects list, with no folder and nothing in memory about where it came from.
      const reopened = await openProject(store, copyId);
      expect(reopened.copiedFrom()).toBeNull();
      await expect(saveFolder(reopened, root)).rejects.toThrow('cannot be saved into that folder');
      // A folder holding a third project is that project's question, not the copy's refusal.
      const third = memoryFolder('Third Book');
      await writeProject(folderArtifactFs(third), project());
      expect(await saveFolder(reopened, third)).toEqual({ kind: 'refused', reason: 'unknown', files: [] });
      await reopened.close();
    } finally {
      setActiveAppDb(null);
    }
  });

  test('this project’s own folder after a reload: saved straight away, or the changed-files question, from the copy kept across the reload', async () => {
    setActiveAppDb(handleDb());
    try {
      const state = project();
      const root = memoryFolder('Own Book');
      await writeProject(folderArtifactFs(root), state);
      const store = await openRuntimeStore(new MemoryIndexedDb());
      const first = await openFolder(store, root);
      if (first.kind !== 'opened') throw new Error('the folder should open');
      first.opened.session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Saved before the reload' });
      expect(await saveFolder(first.opened.session, root)).toEqual({ kind: 'saved' });
      await first.opened.session.close();

      // The reload: a session from the store, holding no copy of any folder.
      const again = await openProject(store, state.manifest.project.id);
      expect(again.folderBaseline()).toBeNull();
      again.dispatch('doc.write', { docId: IDS.sceneA, body: 'Typed after the reload' });
      // The folder is as Caotang last left it, so the save goes straight in, through a second handle to the same folder.
      expect(await saveFolder(again, sameFolderAgain(root))).toEqual({ kind: 'saved' });
      expect((await readProject(folderArtifactFs(root))).state.documents.get(IDS.sceneA)?.body).toBe('Typed after the reload');
      await again.close();

      // Another program edits a document; after the next reload the save names it in the changed-files question, and writes nothing.
      const fs = folderArtifactFs(root);
      await fs.writeAtomic(`docs/${IDS.sceneB}.md`, `---\nid: ${IDS.sceneB}\ntitle: Scene B\n---\n\nEdited by another program.\n`);
      const third = await openProject(store, state.manifest.project.id);
      third.dispatch('doc.write', { docId: IDS.sceneA, body: 'Typed after the second reload' });
      expect(await saveFolder(third, root)).toEqual({
        kind: 'refused',
        reason: 'files',
        files: [{ label: 'the document “Scene B”', change: 'changed' }],
      });
      expect(await fs.read(`docs/${IDS.sceneB}.md`)).toContain('Edited by another program.');
      await third.close();
    } finally {
      setActiveAppDb(null);
    }
  });

  test('this project’s own earlier save with no copy kept for it asks “earlier”, which a yes writes', async () => {
    // No app database: nothing is kept across the reload, so there is no baseline at all.
    const state = project();
    const root = memoryFolder('Earlier Book');
    await writeProject(folderArtifactFs(root), state);
    const { session } = await sessionOf(state);
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'This tab’s version' });

    expect(await saveFolder(session, root)).toEqual({ kind: 'refused', reason: 'earlier', files: [] });
    expect(await saveFolder(session, root, { overwriteConfirmed: true })).toEqual({ kind: 'saved' });
    expect((await readProject(folderArtifactFs(root))).state.documents.get(IDS.sceneA)?.body).toBe('This tab’s version');
    await session.close();
  });

  test('the copy kept for another folder of this project is no baseline here: the question is “earlier”', async () => {
    setActiveAppDb(handleDb());
    try {
      const state = project();
      const older = memoryFolder('Older Save');
      await writeProject(folderArtifactFs(older), state);
      const first = await sessionOf(state);
      // The project is saved to a new, empty folder, which is the folder it remembers from now on.
      expect(await saveFolder(first.session, memoryFolder('Newer Save'))).toEqual({ kind: 'saved' });
      await first.session.close();

      const { session } = await sessionOf(state);
      expect(await saveFolder(session, older)).toEqual({ kind: 'refused', reason: 'earlier', files: [] });
      await session.close();
    } finally {
      setActiveAppDb(null);
    }
  });
});

/** An in-memory app database that keeps values as they are: a test folder handle has methods, which a structured clone refuses. */
function handleDb(): AppDb {
  const rows = new Map<string, unknown>();
  return {
    get: async <T>(key: string): Promise<T | undefined> => rows.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => {
      rows.set(key, value);
    },
    list: async <T>(prefix: string) =>
      [...rows.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => ({ key, value: value as T })),
    delete: async (key: string): Promise<void> => {
      rows.delete(key);
    },
    close: (): void => {},
  };
}

/**
 * A store whose project row refuses a write that carries declined files — the
 * write that puts a held file back. Every other write goes to the store it
 * wraps, so the put-back of a copy fails and nothing else does.
 */
function storeRefusingHeldFiles(store: RuntimeStore): RuntimeStore {
  const db = new Proxy(store.db, {
    get(target: IDBDatabase, property: string | symbol) {
      if (property !== 'transaction') {
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const tx = (target.transaction as (...a: unknown[]) => IDBTransaction)(...args);
        return new Proxy(tx, {
          get(txTarget: IDBTransaction, txProperty: string | symbol) {
            if (txProperty !== 'objectStore') {
              const value = Reflect.get(txTarget, txProperty) as unknown;
              return typeof value === 'function' ? value.bind(txTarget) : value;
            }
            return (name: string) => {
              const objectStore = txTarget.objectStore(name);
              return new Proxy(objectStore, {
                get(storeTarget: IDBObjectStore, storeProperty: string | symbol) {
                  if (storeProperty !== 'put') {
                    const value = Reflect.get(storeTarget, storeProperty) as unknown;
                    return typeof value === 'function' ? value.bind(storeTarget) : value;
                  }
                  return (value: unknown, key?: IDBValidKey) => {
                    const declined = (value as { declinedDocFiles?: unknown }).declinedDocFiles;
                    if (Array.isArray(declined) && declined.length > 0) {
                      throw new Error('the store refused the write');
                    }
                    return key === undefined
                      ? storeTarget.put(value as never)
                      : storeTarget.put(value as never, key);
                  };
                },
              });
            };
          },
        });
      };
    },
  });
  return { ...store, db: db as IDBDatabase };
}

// Linking a copy to its folder: a reopened folder whose book differs from the stored
// project asks, rather than copying without a word.
test.describe('a folder whose version differs from this browser\'s asks which to keep', () => {
  test('the route: a project this browser does not keep opens new, the same book opens as its own, and a different one asks', () => {
    expect(folderOpenRoute({ storedHasId: false, sameBook: false })).toBe('new');
    expect(folderOpenRoute({ storedHasId: true, sameBook: true })).toBe('own');
    expect(folderOpenRoute({ storedHasId: true, sameBook: false })).toBe('ask');
  });

  test('the digests a "keep this browser\'s version" save checks name only the files both hold that differ', () => {
    const browser = new Map([
      ['docs/a.md', 'browser-a'],
      ['docs/b.md', 'same'],
      ['docs/only-browser.md', 'x'],
    ]);
    const folder = new Map([
      ['docs/a.md', 'folder-a'],
      ['docs/b.md', 'same'],
      ['docs/only-folder.md', 'y'],
    ]);
    const held = keepBrowserDigests(browser, folder);
    expect([...held]).toEqual([
      ['docs/a.md', 'browser-a'],
      ['docs/b.md', 'same'],
      ['docs/only-folder.md', 'y'],
    ]);
    // Checked against the folder, only the file the save would write over is a change: nothing is removed or added.
    expect(driftOf(held, folder)).toEqual({ changed: ['docs/a.md'], removed: [], added: [] });
  });

  /** A folder holding the fixture, opened once, then edited in this browser and closed, so the stored project differs from the folder. */
  async function differingFolder(name: string): Promise<{ store: RuntimeStore; root: ReturnType<typeof memoryFolder>; id: string }> {
    const state = project();
    const root = memoryFolder(name);
    await writeProject(folderArtifactFs(root), state);
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const first = await openFolder(store, root);
    if (first.kind !== 'opened') throw new Error('the folder should open');
    first.opened.session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Typed in this browser' });
    await first.opened.session.close();
    return { store, root, id: state.manifest.project.id };
  }

  test('the question names the project and the folder, and nothing has been written for it', async () => {
    const { store, root, id } = await differingFolder('Asked Book');
    const before = await folderArtifactFs(root).read(MANIFEST_FILE);
    const asked = await openFolder(store, root);
    if (asked.kind !== 'differs') throw new Error('the open should ask');
    expect(asked.differs.projectId).toBe(id);
    expect(asked.differs.folderName).toBe('Asked Book');
    expect(asked.differs.projectName).toBe(project().manifest.project.name);
    expect(await folderArtifactFs(root).read(MANIFEST_FILE)).toBe(before);
    expect((await readProjectState(store, id)).documents.get(IDS.sceneA)?.body).toBe('Typed in this browser');
  });

  test('"Use the folder\'s version" replaces this browser\'s copy under the same id, and the folder is its own again', async () => {
    const { store, root, id } = await differingFolder('Folder Wins');
    const asked = await openFolder(store, root);
    if (asked.kind !== 'differs') throw new Error('the open should ask');
    const opened = await answerFolderDiffers(store, asked.differs, 'use-folder');
    expect(opened.copiedFrom).toBeNull();
    expect(opened.session.projectId).toBe(id);
    expect(opened.session.state.documents.get(IDS.sceneA)?.body).toBe(project().documents.get(IDS.sceneA)?.body);
    expect(await listProjectIds(store)).toEqual([id]);
    // The folder is the project's own: a save goes straight back into it.
    opened.session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Edited after choosing the folder' });
    expect(await saveFolder(opened.session, root)).toEqual({ kind: 'saved' });
    await opened.session.close();
    // And the next open finds the same book.
    const again = await openFolder(store, root);
    if (again.kind !== 'opened') throw new Error('the folder should open as the same book');
    expect(again.opened.copiedFrom).toBeNull();
    await again.opened.session.close();
  });

  test('"Use the folder\'s version" that fails to open puts this browser\'s copy back, words and history, under the same id', async () => {
    const { store, root, id } = await differingFolder('Folder Fails');
    const historyBefore = await readSessions(store, id);
    const asked = await openFolder(store, root);
    if (asked.kind !== 'differs') throw new Error('the open should ask');
    // A session line no reader accepts makes the adopt refuse after this browser's copy was removed.
    const broken = { ...asked.differs, folderLog: [{ startedAt: 'not a time' } as unknown as SessionRecord] };
    await expect(answerFolderDiffers(store, broken, 'use-folder')).rejects.toThrow();

    expect(await listProjectIds(store)).toEqual([id]);
    const kept = await readProjectState(store, id);
    expect(kept.documents.get(IDS.sceneA)?.body).toBe('Typed in this browser');
    expect(await readSessions(store, id)).toEqual(historyBefore);
    // The restored copy is closed, so it opens again as the project it was.
    const again = await openProject(store, id);
    expect(again.state.documents.get(IDS.sceneA)?.body).toBe('Typed in this browser');
    await again.close();
  });

  /**
   * A browser's copy whose Scene A the load held: the file's bytes are not UTF-8, so the
   * state has no text for it and names the file in `declinedDocFiles`.
   *
   * The row is written the way the load's own write writes it (`writeProjectState`),
   * because a session's later writes keep the row's record rather than restating it: the
   * record belongs to the load, not to an edit.
   */
  async function heldCopy(
    name: string,
    seed?: (folder: ReturnType<typeof folderArtifactFs>) => Promise<void>,
  ): Promise<{ store: RuntimeStore; root: ReturnType<typeof memoryFolder>; id: string; held: string }> {
    const state = project();
    const root = memoryFolder(name);
    await writeProject(folderArtifactFs(root), state);
    await seed?.(folderArtifactFs(root));
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const first = await openFolder(store, root);
    if (first.kind !== 'opened') throw new Error('the folder should open');
    await first.opened.session.close();
    const held = `${IDS.sceneA}.md`;
    const heldState = await readProjectState(store, state.manifest.project.id);
    heldState.declinedDocFiles.add(held);
    heldState.documents.delete(IDS.sceneA);
    await writeProjectState(store, heldState, { now: new Date() });
    return { store, root, id: state.manifest.project.id, held };
  }

  // A file the load held is named on the state, and the state holds no text for it. The
  // internal bundle the 'use-folder' answer holds before it removes this browser's copy
  // cannot carry either: it writes an empty document in place of the held one. So the
  // copy that is put back after a failed adopt has to be given the held files again, or
  // the next save to the folder writes that empty document over the author's file.
  test('"Use the folder\'s version" that fails to open puts back the copy with the files the load held', async () => {
    setActiveAppDb(handleDb());
    try {
      const { store, root, id, held } = await heldCopy('Held Book');
      const asked = await openFolder(store, root);
      if (asked.kind !== 'differs') throw new Error('the open should ask');
      const broken = { ...asked.differs, folderLog: [{ startedAt: 'not a time' } as unknown as SessionRecord] };
      await expect(answerFolderDiffers(store, broken, 'use-folder')).rejects.toThrow();

      const restored = await openProject(store, id);
      // The file is named again, and the state holds no text for it.
      expect(restored.state.declinedDocFiles.has(held)).toBe(true);
      expect(restored.state.documents.has(IDS.sceneA)).toBe(false);
      // And a save to the folder leaves the author's file as it is.
      expect(await saveFolder(restored, root)).toEqual({ kind: 'saved' });
      expect(await folderArtifactFs(root).read(`docs/${held}`)).toContain('Four little words here');
      await restored.close();
    } finally {
      setActiveAppDb(null);
    }
  });

  // The codex twin: a codex file the load declined is one no entry owns, so the
  // save's prune would remove it unless the copy put back still names it.
  test('"Use the folder\'s version" that fails to open puts back the codex files the load held, and a save keeps them', async () => {
    setActiveAppDb(handleDb());
    try {
      const declined = 'c_7K3M9P2Q4R.md';
      // A codex file with no front matter: the load declines it and keeps it.
      const { store, root, id } = await heldCopy('Held Codex Book', (folder) =>
        folder.writeAtomic(`codex/${declined}`, 'the author’s only copy'),
      );
      const folder = folderArtifactFs(root);
      // Held as a file whose bytes are not UTF-8 is held: named, with no text the state could write back.
      const heldState = await readProjectState(store, id);
      expect(heldState.declinedCodexFiles.has(declined)).toBe(true);
      heldState.declinedText.delete(`codex/${declined}`);
      await writeProjectState(store, heldState, { now: new Date() });

      const asked = await openFolder(store, root);
      if (asked.kind !== 'differs') throw new Error('the open should ask');
      const broken = { ...asked.differs, folderLog: [{ startedAt: 'not a time' } as unknown as SessionRecord] };
      await expect(answerFolderDiffers(store, broken, 'use-folder')).rejects.toThrow();

      const restored = await openProject(store, id);
      expect(restored.state.declinedCodexFiles.has(declined)).toBe(true);
      expect(await saveFolder(restored, root)).toEqual({ kind: 'saved' });
      expect(await folder.read(`codex/${declined}`)).toBe('the author’s only copy');
      await restored.close();
    } finally {
      setActiveAppDb(null);
    }
  });

  // A store that refuses the write that puts the held files back: the put-back
  // of this browser's copy fails, and the failure must not skip the close of
  // the session — the lease would stay held by a session nobody has — nor the
  // records the removal forgot, and the writer must be told why the *open*
  // failed rather than why the store refused the write.
  test('"Use the folder\'s version" whose put-back cannot write the held files still closes the copy, keeps its records, and says why the open failed', async () => {
    test.setTimeout(20_000);
    setActiveAppDb(handleDb());
    try {
      await withLocks(async () => {
        const { store, root, id } = await heldCopy('Held Book, Refused');
        const asked = await openFolder(store, root);
        if (asked.kind !== 'differs') throw new Error('the open should ask');
        const broken = { ...asked.differs, folderLog: [{ startedAt: 'not a time' } as unknown as SessionRecord] };

        const failure = await answerFolderDiffers(storeRefusingHeldFiles(store), broken, 'use-folder').then(
          () => {
            throw new Error('the answer should have failed');
          },
          (error: unknown) => error,
        );

        // The writer is told why the open failed, and that the copy could not be
        // put back either: the store's refusal is not why the open failed.
        expect(failure).toBeInstanceOf(Error);
        const message = (failure as Error).message;
        expect(message).toContain('sessions.jsonl record');
        expect(message).toContain('could not be put back');
        // And the adopt's own error is the cause, so nothing about it is lost.
        expect((failure as Error).cause).toBeInstanceOf(Error);

        // The lease is back: the session that could not write the held files
        // was closed all the same, so the project is not held by a session
        // nobody has.
        const lease = await acquireProjectLease(id);
        expect(lease).not.toBeNull();
        lease?.release();

        // The copy is in the list as it was, and the folder it belongs to is
        // remembered, as the removal forgot it.
        expect(await listProjectIds(store)).toEqual([id]);
        expect(await rememberedFolder(id)).not.toBeNull();
      }, lockManager());
    } finally {
      setActiveAppDb(null);
    }
  });

  test('"Use the folder\'s version" that fails to open puts back the copy\'s folder records: still refused in its original\'s folder, saved straight into its own', async () => {
    setActiveAppDb(handleDb());
    try {
      const { store, root } = await differingFolder('Original Of A Copy');
      const asked = await openFolder(store, root);
      if (asked.kind !== 'differs') throw new Error('the open should ask');
      const copy = await answerFolderDiffers(store, asked.differs, 'separate-copy');
      const copyId = copy.session.projectId;
      // The copy is saved to a folder of its own, then edited in this browser, so that folder differs from the stored copy.
      const copyRoot = memoryFolder('The Copy');
      expect(await saveFolder(copy.session, copyRoot)).toEqual({ kind: 'saved' });
      copy.session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Typed in the copy after its save' });
      await copy.session.close();

      const differs = await openFolder(store, copyRoot);
      if (differs.kind !== 'differs') throw new Error('the copy\'s folder should ask');
      const broken = { ...differs.differs, folderLog: [{ startedAt: 'not a time' } as unknown as SessionRecord] };
      await expect(answerFolderDiffers(store, broken, 'use-folder')).rejects.toThrow();

      const restored = await openProject(store, copyId);
      expect(restored.state.documents.get(IDS.sceneA)?.body).toBe('Typed in the copy after its save');
      // The copied-from record is back: the copy is still refused in its original's folder.
      await expect(saveFolder(restored, root)).rejects.toThrow('cannot be saved into that folder');
      // The folder-copy record is back: its own unchanged folder takes the save straight in, rather than asking "earlier".
      expect(await saveFolder(restored, sameFolderAgain(copyRoot))).toEqual({ kind: 'saved' });
      await restored.close();
    } finally {
      setActiveAppDb(null);
    }
  });

  test('"Keep this browser\'s version" opens it with the folder, and its save asks about each document it would write over', async () => {
    const { store, root, id } = await differingFolder('Browser Wins');
    const asked = await openFolder(store, root);
    if (asked.kind !== 'differs') throw new Error('the open should ask');
    const opened = await answerFolderDiffers(store, asked.differs, 'keep-browser');
    expect(opened.saveToFolder).toBe(root);
    expect(opened.copiedFrom).toBeNull();
    expect(opened.session.projectId).toBe(id);
    expect(opened.session.state.documents.get(IDS.sceneA)?.body).toBe('Typed in this browser');

    // The save goes through the changed-documents question, naming the one document the browser's version would write over.
    const refused = await saveFolder(opened.session, root);
    expect(refused).toMatchObject({ kind: 'refused', reason: 'files' });
    if (refused.kind !== 'refused') return;
    expect(refused.files.map((file) => file.change)).toEqual(['changed']);
    expect(await readProject(folderArtifactFs(root)).then((loaded) => loaded.state.documents.get(IDS.sceneA)?.body)).not.toBe('Typed in this browser');

    // The writer's "Save over them" writes this browser's version into the folder.
    expect(await saveFolder(opened.session, root, { overwriteConfirmed: true })).toEqual({ kind: 'saved' });
    const onDisk = await readProject(folderArtifactFs(root));
    expect(onDisk.state.documents.get(IDS.sceneA)?.body).toBe('Typed in this browser');
    expect(onDisk.state.manifest.project.id).toBe(id);
    await opened.session.close();
  });
});

test.describe('a folder saved to, closed and reopened is still its own project', () => {
  test('the save stamps only the folder, so the reopened folder opens the same project and saves into it again', async () => {
    const state = project();
    const root = memoryFolder('Saved Book');
    await writeProject(folderArtifactFs(root), state);
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const fs = folderArtifactFs(root);

    // The writer's normal cycle: open the folder, edit, save to it, close.
    const first = await openFolder(store, root);
    if (first.kind !== 'opened') throw new Error('the folder should open');
    first.opened.session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Edited before the first save' });
    expect(await saveFolder(first.opened.session, root)).toEqual({ kind: 'saved' });
    await first.opened.session.close();

    // The folder's caotang.json carries the save's time, and the project this browser keeps does not: it is still the same book.
    const second = await openFolder(store, root);
    if (second.kind !== 'opened') throw new Error('the folder should open again');
    expect(second.opened.copiedFrom).toBeNull();
    const session = second.opened.session;
    expect(session.state.manifest.project.id).toBe(state.manifest.project.id);
    session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Edited after reopening' });
    expect(await saveFolder(session, root)).toEqual({ kind: 'saved' });
    const onDisk = await readProject(fs);
    expect(onDisk.state.manifest.project.id).toBe(state.manifest.project.id);
    expect(onDisk.state.documents.get(IDS.sceneA)?.body).toBe('Edited after reopening');
    await session.close();

    // A save with no edit, then a close, still reopens the same project.
    const third = await openFolder(store, root);
    if (third.kind !== 'opened') throw new Error('the folder should open a third time');
    expect(await saveFolder(third.opened.session, root)).toEqual({ kind: 'saved' });
    await third.opened.session.close();
    const fourth = await openFolder(store, root);
    if (fourth.kind !== 'opened') throw new Error('the folder should open a fourth time');
    expect(fourth.opened.copiedFrom).toBeNull();
    await fourth.opened.session.close();
  });
});

test.describe('a dialogue container deleted from the tree leaves no file behind', () => {
  test('its .ink file goes with the save, and the container does not come back on the next open', async () => {
    const state = project();
    addDocument(state, {
      parentId: IDS.chapterOne,
      title: 'The Choice',
      body: '=== start ===\n',
      kind: 'branching',
      type: 'dialogue',
      now: new Date('2026-10-08T09:00:00Z'),
      id: DIALOGUE,
    });
    const root = memoryFolder('Dialogue Book');
    await writeProject(folderArtifactFs(root), state);
    const fs = folderArtifactFs(root);
    expect(await fs.exists(`docs/${DIALOGUE}.ink`)).toBe(true);
    const store = await openRuntimeStore(new MemoryIndexedDb());

    const opened = await openFolder(store, root);
    expect(opened.kind).toBe('opened');
    if (opened.kind !== 'opened') return;
    const session = opened.opened.session;
    session.dispatch('project.deleteNode', { nodeId: DIALOGUE });
    expect(await saveFolder(session, root)).toEqual({ kind: 'saved' });
    expect(await fs.exists(`docs/${DIALOGUE}.ink`)).toBe(false);
    await session.close();

    const reopened = await openFolder(store, root);
    expect(reopened.kind).toBe('opened');
    if (reopened.kind !== 'opened') return;
    expect(reopened.opened.session.state.manifest.tree.some((node) => node.id === DIALOGUE)).toBe(false);
    await reopened.opened.session.close();
  });
});

test.describe('a project another tab has open is not removed from this one', () => {
  test('the removal is refused while another tab holds the project, and goes once that tab lets go', async () => {
    test.setTimeout(20_000);
    const state = project();
    const id = state.manifest.project.id;
    const store = await openRuntimeStore(new MemoryIndexedDb());
    await writeProjectState(store, state);

    await withLocks(async () => {
      const otherTab = await acquireProjectLease(id);
      expect(otherTab).not.toBeNull();
      expect(await openElsewhere(id)).toBe(true);
      await expect(removeProject(store, id)).rejects.toBeInstanceOf(ProjectOpenElsewhereError);
      expect(await listProjectIds(store)).toContain(id);

      otherTab?.release();
      expect(await openElsewhere(id)).toBe(false);
      await removeProject(store, id);
      expect(await listProjectIds(store)).not.toContain(id);
    }, lockManager());
  });

  test('a project this page’s own session still holds is not reported as open elsewhere, and its removal waits for the close', async () => {
    test.setTimeout(20_000);
    const state = project();
    const id = state.manifest.project.id;
    const store = await openRuntimeStore(new MemoryIndexedDb());
    await writeProjectState(store, state);

    await withLocks(async () => {
      // The session is left open, as a close the shell started and has not finished leaves it: it still holds the project's lease.
      const session = await openProject(store, id);
      const started = Date.now();
      expect(await openElsewhere(id)).toBe(false);
      // Asked straight away, not after the lock's wait: the answer comes from what this page holds.
      expect(Date.now() - started).toBeLessThan(500);

      let removed = false;
      const removal = removeProject(store, id).then(() => {
        removed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(removed).toBe(false);
      expect(await listProjectIds(store)).toContain(id);

      await session.close();
      await removal;
      expect(await listProjectIds(store)).not.toContain(id);
    }, lockManager());
  });
});

test.describe('a store another tab has upgraded stops this tab, and the words are kept', () => {
  test('a stopped session makes no later write attempt: no writing status, the store keeps its text, and the words are kept for this tab', async () => {
    // The unsent copy is kept in the browser's local storage (unsent-copy.ts), which this test stands in for. The session reads that storage
    // when it is made, so the stand-in is in place before the session is.
    const kept = memoryLocalStorage();
    globals.localStorage = kept;
    try {
      const idb = new MemoryIndexedDb();
      const store = await openRuntimeStore(idb);
      const state = project();
      const projectId = state.manifest.project.id;
      await writeProjectState(store, state);
      const session = new ProjectSession({ store, projectId, state, shadow: shadowOf(state) });

      // Another tab opens the database at a newer version, and the browser fires versionchange on this tab's connection.
      store.db.onversionchange?.call(store.db, new Event('versionchange') as IDBVersionChangeEvent);
      session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Typed after the upgrade' });
      await session.settle();

      expect(session.saveState()).toBe('conflict');
      expect(session.persistence.isStopped()).toBe(true);

      // A second connection to the same database reads what the store holds, before and after a further change in the stopped tab.
      const reader = await openRuntimeStore(idb);
      const held = (await readProjectState(reader, projectId)).documents.get(IDS.sceneA);
      // Each state the session's writer passes through after the stop. The store checks below would hold even if the writer tried, because the
      // upgraded connection refuses every write. So this list is the assertion that depends on the stop: a write attempted would pass through
      // `writing`, and an empty list is what says the stop itself kept the writer from trying.
      const statuses: string[] = [];
      const unsubscribe = session.persistence.subscribe(() => statuses.push(session.persistence.getStatus()));
      session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Typed after the stop, too' });
      await session.settle();
      unsubscribe();
      const after = (await readProjectState(reader, projectId)).documents.get(IDS.sceneA);

      expect(statuses).not.toContain('writing');
      expect(after?.body).toBe(held?.body);
      expect(after?.revision).toBe(held?.revision);
      // The words typed after the stop are the ones the browser keeps for the stopped tab, not the text the store holds.
      expect(JSON.stringify(readUnsentEntries(kept, projectId))).toContain('Typed after the stop, too');
      await session.close();
    } finally {
      delete globals.localStorage;
    }
  });
});

test.describe('a store another tab has upgraded does not reject into the page', () => {
  test('the words written today keep the last total this page read, and do not reject', async () => {
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const day = Date.now();
    await expect(wordsWrittenToday(store, day)).resolves.toBe(0);

    store.db.onversionchange?.call(store.db, new Event('versionchange') as IDBVersionChangeEvent);

    await expect(wordsWrittenToday(store, day)).resolves.toBe(0);
  });
});

/** A stand-in for the browser's local storage, where the unsent copy (unsent-copy.ts) is kept. */
function memoryLocalStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, String(value));
    },
    removeItem: (key: string) => {
      items.delete(key);
    },
    clear: () => {
      items.clear();
    },
  } as unknown as Storage;
}

// ---------------------------------------------------------------------------
// What an open says to the writer
// ---------------------------------------------------------------------------

test.describe('an open’s notices are whole sentences in the writer’s words', () => {
  test('a notice with a sentence is quoted once, and those without one are counted, not quoted', () => {
    const lines = openNoticeLines([
      { say: 'The project had no language, so it is set from the app’s language.' },
      {},
      { say: 'The project had no language, so it is set from the app’s language.' },
      {},
    ]);
    expect(lines).toEqual([
      'The project had no language, so it is set from the app’s language.',
      'Caotang also noted 2 smaller things in the project’s files as it opened them.',
    ]);
    expect(openNoticeLines([{}])).toEqual(['Caotang also noted one smaller thing in the project’s files as it opened them.']);
    expect(openNoticeLines([])).toEqual([]);
  });

  test('a reason an error carries is made a sentence: a capital first and a full stop last', () => {
    expect(sentenceOf('the folder could not be written')).toBe('The folder could not be written.');
    expect(sentenceOf('Already a sentence.')).toBe('Already a sentence.');
    expect(sentenceOf('  ')).toBe('');
  });

  test('a dropped field the file carries on several items is named once, with how many times it occurs', () => {
    expect(droppedFieldsSentence(['x', 'x', 'x'])).toBe(
      'The file has 3 fields Caotang keeps but does not use: “x” 3 times. They are dropped on the next save.',
    );
    expect(droppedFieldsSentence(['x', 'colour', 'x'])).toBe(
      'The file has 3 fields Caotang keeps but does not use: “x” 2 times and “colour”. They are dropped on the next save.',
    );
    expect(droppedFieldsSentence(['colour'])).toBe('The file has a field Caotang keeps but does not use: “colour”. It is dropped on the next save.');
    expect(droppedFieldsSentence([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A stored project carries on a folder's session log
// ---------------------------------------------------------------------------

/** A session line for the log, `n` minutes into the day, so each line is its own. */
function sessionLine(n: number): SessionRecord {
  const at = new Date(Date.UTC(2026, 9, 14, 9, n)).toISOString();
  return { startedAt: at, endedAt: at, wordsWritten: n, docIds: [] };
}

/** Opens a folder that must open as a project, and returns what opened. */
async function openedFolder(store: RuntimeStore, root: DirectoryHandleLike) {
  const outcome = await openFolder(store, root);
  if (outcome.kind !== 'opened') throw new Error('expected the folder to open');
  return outcome.opened;
}

test.describe('a stored project opened from its folder carries on the folder’s session log (carryFolderSessions)', () => {
  test('a folder holding more lines than the store, which start with the store’s, gives the store its extra lines', async () => {
    const root = memoryFolder('Fixture Book');
    const fs = folderArtifactFs(root);
    await writeProject(fs, project());
    await fs.writeAtomic(SESSIONS_FILE, serializeSessionsLog([sessionLine(1)]));
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const first = await openedFolder(store, root);
    const projectId = first.session.projectId;
    await first.session.close();
    expect(await readSessions(store, projectId)).toEqual([sessionLine(1)]);

    // Sittings written to the folder elsewhere, after the line this browser holds.
    await fs.writeAtomic(SESSIONS_FILE, serializeSessionsLog([sessionLine(1), sessionLine(2), sessionLine(3)]));
    const again = await openedFolder(store, root);
    // The stored project is the folder's own session, not a copy, so its log is the one carried on.
    expect(again.copiedFrom).toBeNull();
    expect(again.session.projectId).toBe(projectId);
    expect(await readSessions(store, projectId)).toEqual([sessionLine(1), sessionLine(2), sessionLine(3)]);
    await again.session.close();
  });

  test('a folder whose log differs from the store’s saves: every line of both is kept, and the folder’s own lines stay first', async () => {
    const root = memoryFolder('Fixture Book');
    const fs = folderArtifactFs(root);
    await writeProject(fs, project());
    await fs.writeAtomic(SESSIONS_FILE, serializeSessionsLog([sessionLine(1)]));
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const first = await openedFolder(store, root);
    const projectId = first.session.projectId;
    await first.session.close();

    // Another machine wrote two sittings the browser never saw, so neither log is the start of the other.
    await fs.writeAtomic(SESSIONS_FILE, serializeSessionsLog([sessionLine(7), sessionLine(8)]));
    const again = await openedFolder(store, root);
    expect(again.copiedFrom).toBeNull();
    // The store keeps its own line and takes the folder's, in the folder's order, after it.
    expect(await readSessions(store, projectId)).toEqual([sessionLine(1), sessionLine(7), sessionLine(8)]);
    // The save writes the folder's lines as they are, then the line the folder lacks. Nothing is refused.
    await expect(saveFolder(again.session, root)).resolves.toEqual({ kind: 'saved' });
    expect(await fs.read(SESSIONS_FILE)).toBe(serializeSessionsLog([sessionLine(7), sessionLine(8), sessionLine(1)]));
    await again.session.close();
  });

  test('a damaged line in the folder’s log is kept where it is, and the save appends nothing the folder already holds', async () => {
    const root = memoryFolder('Fixture Book');
    const fs = folderArtifactFs(root);
    await writeProject(fs, project());
    await fs.writeAtomic(SESSIONS_FILE, serializeSessionsLog([sessionLine(1)]));
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const first = await openedFolder(store, root);
    await first.session.close();

    // A line this build cannot read sits between two sittings the folder holds.
    const damaged = `${serializeSessionsLog([sessionLine(1)])}{"startedAt": not json\n${serializeSessionsLog([sessionLine(2)])}`;
    await fs.writeAtomic(SESSIONS_FILE, damaged);
    const again = await openedFolder(store, root);
    expect(await readSessions(store, first.session.projectId)).toEqual([sessionLine(1), sessionLine(2)]);
    await expect(saveFolder(again.session, root)).resolves.toEqual({ kind: 'saved' });
    expect(await fs.read(SESSIONS_FILE)).toBe(damaged);
    await again.session.close();
  });

  test('a session the folder holds twice and the store once is carried once, so both logs then hold it twice', async () => {
    const root = memoryFolder('Fixture Book');
    const fs = folderArtifactFs(root);
    await writeProject(fs, project());
    await fs.writeAtomic(SESSIONS_FILE, serializeSessionsLog([sessionLine(1)]));
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const first = await openedFolder(store, root);
    const projectId = first.session.projectId;
    await first.session.close();

    // The folder's log holds the same sitting twice: each line the store holds answers for one of them only.
    const twice = serializeSessionsLog([sessionLine(1), sessionLine(1), sessionLine(2)]);
    await fs.writeAtomic(SESSIONS_FILE, twice);
    const again = await openedFolder(store, root);
    expect(await readSessions(store, projectId)).toEqual([sessionLine(1), sessionLine(1), sessionLine(2)]);
    // The save finds every line of the store in the folder, so it appends nothing.
    await expect(saveFolder(again.session, root)).resolves.toEqual({ kind: 'saved' });
    expect(await fs.read(SESSIONS_FILE)).toBe(twice);
    await again.session.close();
  });

  test('a session the store holds twice and the folder once is written once more by the save', async () => {
    const root = memoryFolder('Fixture Book');
    const fs = folderArtifactFs(root);
    await writeProject(fs, project());
    await fs.writeAtomic(SESSIONS_FILE, serializeSessionsLog([sessionLine(1), sessionLine(1)]));
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const first = await openedFolder(store, root);
    const projectId = first.session.projectId;
    await first.session.close();
    expect(await readSessions(store, projectId)).toEqual([sessionLine(1), sessionLine(1)]);

    // Another machine kept one copy of that sitting and added its own.
    await fs.writeAtomic(SESSIONS_FILE, serializeSessionsLog([sessionLine(1), sessionLine(3)]));
    const again = await openedFolder(store, root);
    expect(await readSessions(store, projectId)).toEqual([sessionLine(1), sessionLine(1), sessionLine(3)]);
    await expect(saveFolder(again.session, root)).resolves.toEqual({ kind: 'saved' });
    expect(await fs.read(SESSIONS_FILE)).toBe(serializeSessionsLog([sessionLine(1), sessionLine(3), sessionLine(1)]));
    await again.session.close();
  });

  test('a log another program rewrites while the save writes it refuses the save, and the other program’s log is left as it wrote it', async () => {
    const root = memoryFolder('Fixture Book');
    const fs = folderArtifactFs(root);
    await writeProject(fs, project());
    await fs.writeAtomic(SESSIONS_FILE, serializeSessionsLog([sessionLine(1)]));
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const opened = await openedFolder(store, root);

    // Another program rewrites the log right after the save has read it, and before the save's own write reads it again.
    const theirs = serializeSessionsLog([sessionLine(7)]);
    let raced = false;
    const racing: DirectoryHandleLike = {
      ...root,
      async getFileHandle(child: string, options?: { create?: boolean }) {
        const handle = await root.getFileHandle(child, options);
        if (child !== SESSIONS_FILE) return handle;
        return {
          ...handle,
          async getFile() {
            const file = await handle.getFile();
            return {
              ...file,
              async text() {
                const text = await file.text();
                if (!raced) {
                  raced = true;
                  setFileText(root, SESSIONS_FILE, theirs);
                }
                return text;
              },
            };
          },
        };
      },
    };
    childrenOfHandle.set(racing, childrenOfHandle.get(root) ?? new Map());

    await expect(saveFolder(opened.session, racing)).rejects.toThrow(
      'The folder’s record of writing sessions changed while Caotang was saving it. Nothing was written. Save again.',
    );
    expect(raced).toBe(true);
    expect(await fs.read(SESSIONS_FILE)).toBe(theirs);
    await opened.session.close();
  });
});
