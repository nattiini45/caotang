import { expect, test } from '@playwright/test';
import { emptyCoherenceFile, serializeCoherenceFile, type CoherenceFile } from '../../packages/coherence/src/index.js';
import { MemoryIndexedDb } from '../../packages/store/src/runtime/memory-idb.js';
import { commitProject, openRuntimeStore, readCoherenceFiles, type RuntimeStore } from '../../packages/store/src/index.js';

import { setActiveAppDb, type AppDb } from '../../apps/desktop/src/app/app-db.js';
import { attachCoherence, legacyCoherenceKey } from '../../apps/desktop/src/app/coherence-io.js';
import type { DirectoryHandleLike, FileHandleLike } from '../../apps/desktop/src/app/fs-access.js';
import type { CoherencePort, ProjectSession } from '../../apps/desktop/src/app/session.js';
import { IDS, project } from './fixtures.js';
import { filesIn, memoryFolder, textOf, type Directory } from './memory-folder.js';

/**
 * The findings file's homes (coherence.md §3, project-format §1): the project's row in the browser store, and the copy beside the
 * project in an open folder. A session is stood in for by the one method the I/O calls, so the test reads what was attached and
 * saves. The store is a real runtime store over an in-memory IndexedDB, so what a save writes is what a reopen reads back.
 */

interface Attached {
  file?: CoherenceFile;
  writable?: boolean;
  notices?: readonly string[];
  port?: CoherencePort;
}

const PROJECT_ID = 'p_TESTPROJ01';

function fakeSession(): { session: ProjectSession; attached: Attached } {
  const state = project();
  const attached: Attached = {};
  const session = {
    projectId: PROJECT_ID,
    state,
    attachCoherence(loaded: { file: CoherenceFile; writable: boolean; notices: readonly string[] }, port: CoherencePort) {
      attached.file = loaded.file;
      attached.writable = loaded.writable;
      attached.notices = loaded.notices;
      attached.port = port;
      state.coherence = loaded.file;
    },
  } as unknown as ProjectSession;
  return { session, attached };
}

/** A runtime store over a private in-memory database, with the project's row in it, as an opened project has. */
async function storeWithProject(): Promise<RuntimeStore> {
  const store = await openRuntimeStore(new MemoryIndexedDb(), `coherence-io-${Math.random().toString(36).slice(2)}`);
  const state = project();
  await commitProject(store, { projectId: PROJECT_ID, manifest: { ...state.manifest, project: { ...state.manifest.project, id: PROJECT_ID } } });
  return store;
}

/** A store whose database cannot be read: the record is there in principle, and the browser will not give it back. */
function unreadableStore(): RuntimeStore {
  const db = {
    transaction(): never {
      throw new Error('the database is busy');
    },
  };
  return { db, name: 'unreadable', close: () => {} } as unknown as RuntimeStore;
}

/** The findings file as the folder holds it now, parsed. */
function folderFile(tree: Directory): CoherenceFile {
  const bytes = filesIn(tree).get('coherence.json');
  return JSON.parse(textOf(bytes)) as CoherenceFile;
}

/**
 * A folder whose one file cannot be read: opening it fails with a read error, which is not "not found", the way a locked file
 * fails. Everything else is the in-memory folder underneath.
 */
function unreadableFile(base: DirectoryHandleLike, name: string): DirectoryHandleLike {
  return {
    kind: 'directory',
    name: base.name,
    getDirectoryHandle: (child, options) => base.getDirectoryHandle(child, options),
    async getFileHandle(child, options): Promise<FileHandleLike> {
      const handle = await base.getFileHandle(child, options);
      if (child !== name) return handle;
      return {
        ...handle,
        async getFile(): Promise<never> {
          throw Object.assign(new Error('The file is open in another program.'), { name: 'NotReadableError' });
        },
      };
    },
    removeEntry: (child, options) => base.removeEntry(child, options),
    entries: () => base.entries(),
  };
}

test.describe('the findings file beside the project (coherence.md §3)', () => {
  test('a findings file already in the open folder is the one the project opens with', async () => {
    const folder = memoryFolder();
    const stored: CoherenceFile = { ...emptyCoherenceFile(), sceneMeta: { [IDS.sceneA]: { dayOffset: 3 } } };
    folder.tree.children.set('coherence.json', { kind: 'file', bytes: new TextEncoder().encode(serializeCoherenceFile(stored)) });

    const { session, attached } = fakeSession();
    await attachCoherence(session, await storeWithProject(), folder.handle);
    expect(attached.file?.sceneMeta[IDS.sceneA]).toEqual({ dayOffset: 3 });
    expect(attached.writable).toBe(true);
  });

  test('a run the MCP server saved in the open folder is in the run history the project opens with', async () => {
    const folder = memoryFolder();
    const run = {
      id: 'r_SERVER0001',
      at: '2026-10-08T09:00:00.000Z',
      kind: 'deterministic' as const,
      checkIds: ['codex.never-mentioned'],
      scope: { docIds: [IDS.sceneA], mode: 'full' as const },
      findingsUpserted: [],
      status: 'complete' as const,
    };
    const fromHost: CoherenceFile = { ...emptyCoherenceFile(), runs: [run] };
    folder.tree.children.set('coherence.json', { kind: 'file', bytes: new TextEncoder().encode(serializeCoherenceFile(fromHost)) });

    const { session, attached } = fakeSession();
    await attachCoherence(session, await storeWithProject(), folder.handle);
    expect(attached.file?.runs.map((held) => held.id)).toEqual(['r_SERVER0001']);
  });

  test('a save writes the file into the project’s row in the store, and reads back from there on reopen', async () => {
    const store = await storeWithProject();
    const { session, attached } = fakeSession();
    await attachCoherence(session, store, null);

    const saved: CoherenceFile = { ...emptyCoherenceFile(), sceneMeta: { [IDS.sceneB]: { dayOffset: 9 } } };
    await attached.port?.save(saved);
    const stored = await readCoherenceFiles(store, PROJECT_ID);
    expect(JSON.parse(stored['coherence.json'] ?? '{}')).toEqual(JSON.parse(serializeCoherenceFile(saved)));

    // A second session over the same store reads the same file back, which is what a reopen of the project does.
    const reopened = fakeSession();
    await attachCoherence(reopened.session, store, null);
    expect(reopened.attached.file?.sceneMeta[IDS.sceneB]).toEqual({ dayOffset: 9 });
  });

  test('a save writes the file into the open folder as well, and the folder reads it back', async () => {
    const folder = memoryFolder();
    const { session, attached } = fakeSession();
    await attachCoherence(session, await storeWithProject(), folder.handle);

    await attached.port?.save({ ...emptyCoherenceFile(), sceneMeta: { [IDS.sceneB]: { dayOffset: 9 } } });
    expect(folderFile(folder.tree).sceneMeta[IDS.sceneB]).toEqual({ dayOffset: 9 });
  });

  test('a folder attached after the project opened receives the findings file as it stands, at once', async () => {
    const { session, attached } = fakeSession();
    await attachCoherence(session, await storeWithProject(), null);
    expect(attached.file).toEqual(emptyCoherenceFile());

    const standing: CoherenceFile = { ...emptyCoherenceFile(), sceneMeta: { [IDS.sceneC]: { dayOffset: 2 } } };
    await attached.port?.save(standing);
    const folder = memoryFolder();
    expect(filesIn(folder.tree).has('coherence.json')).toBe(false);

    // The folder holds the file as soon as it is attached, before any later save.
    await attached.port?.attachFolder(folder.handle, standing);
    expect(folderFile(folder.tree).sceneMeta[IDS.sceneC]).toEqual({ dayOffset: 2 });

    await attached.port?.save({ ...emptyCoherenceFile(), sceneMeta: { [IDS.sceneC]: { dayOffset: 4 } } });
    expect(folderFile(folder.tree).sceneMeta[IDS.sceneC]).toEqual({ dayOffset: 4 });
  });

  test('a findings file in the open folder that cannot be read does not stop the project from opening, and is not written over', async () => {
    const folder = memoryFolder();
    const stored: CoherenceFile = { ...emptyCoherenceFile(), sceneMeta: { [IDS.sceneA]: { dayOffset: 3 } } };
    folder.tree.children.set('coherence.json', { kind: 'file', bytes: new TextEncoder().encode(serializeCoherenceFile(stored)) });
    const locked = unreadableFile(folder.handle, 'coherence.json');

    const { session, attached } = fakeSession();
    await attachCoherence(session, await storeWithProject(), locked);
    // The stored copy is what opens, the writer is told which file failed, and the project is writable.
    expect(attached.file).toEqual(emptyCoherenceFile());
    expect(attached.writable).toBe(true);
    expect(attached.notices?.join(' ')).toContain('coherence.json in the project folder could not be read');

    // A save goes to the store only: the folder's copy keeps the day it had.
    await attached.port?.save({ ...emptyCoherenceFile(), sceneMeta: { [IDS.sceneA]: { dayOffset: 7 } } });
    expect(folderFile(folder.tree).sceneMeta[IDS.sceneA]).toEqual({ dayOffset: 3 });

    // Attaching the same folder again names the file rather than writing over it.
    await expect(attached.port?.attachFolder(locked, emptyCoherenceFile())).rejects.toThrow('coherence.json in the project folder');
    expect(folderFile(folder.tree).sceneMeta[IDS.sceneA]).toEqual({ dayOffset: 3 });
  });

  test('a stored set that cannot be read is never written over: the file is read-only and no save reaches the store', async () => {
    const { session, attached } = fakeSession();
    await attachCoherence(session, unreadableStore(), null);
    expect(attached.writable).toBe(false);
    expect(attached.notices?.join(' ')).toContain('could not be read from this browser');

    await expect(attached.port?.save({ ...emptyCoherenceFile(), sceneMeta: { [IDS.sceneB]: { dayOffset: 9 } } })).rejects.toThrow('not saved over');
  });

  test('a findings file the app database held before the store had a home is read once, and the first save moves it into the store', async () => {
    const legacy: CoherenceFile = { ...emptyCoherenceFile(), sceneMeta: { [IDS.sceneA]: { dayOffset: 5 } } };
    const db: AppDb = {
      get: async <T,>(key: string): Promise<T | undefined> =>
        key === legacyCoherenceKey(PROJECT_ID) ? ({ 'coherence.json': serializeCoherenceFile(legacy) } as unknown as T) : undefined,
      put: async () => {},
      close: () => {},
    } as unknown as AppDb;
    setActiveAppDb(db);
    try {
      const store = await storeWithProject();
      const { session, attached } = fakeSession();
      await attachCoherence(session, store, null);
      expect(attached.file?.sceneMeta[IDS.sceneA]).toEqual({ dayOffset: 5 });

      await attached.port?.save(legacy);
      expect(JSON.parse((await readCoherenceFiles(store, PROJECT_ID))['coherence.json'] ?? '{}')).toMatchObject({
        sceneMeta: { [IDS.sceneA]: { dayOffset: 5 } },
      });
    } finally {
      setActiveAppDb(null);
    }
  });
});
