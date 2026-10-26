/**
 * The run log in the runtime store (agent-harness §5.1): the v3 to v4 upgrade, the atomic append, the interrupted mark, retention, and
 * deletion with the project.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { MemoryIndexedDb } from '../src/runtime/memory-idb.js';
import {
  DOCUMENT_STORE,
  PROJECT_STORE,
  RUNTIME_DB_VERSION,
  SESSION_STORE,
  SNAPSHOT_STORE,
  deleteProject,
  openRuntimeStore,
  readProjectState,
  writeProjectState,
  type RuntimeStore,
} from '../src/runtime/store.js';
import {
  RunExistsError,
  RunNotFoundError,
  appendRunEvents,
  createRun,
  deleteRun,
  markRunsInterrupted,
  pruneRuns,
  readOpenRuns,
  readRun,
  readRunEvents,
  readRuns,
  updateRun,
  type RunRow,
} from '../src/runtime/run-log-store.js';
import { addDocument, createEmptyManifest, createProjectState } from '../src/index.js';

const DB = 'caotang-run-log-test';
const PROJECT = 'p_9XK2M4Q7RZ';
const DAY = 86_400_000;

const opened: RuntimeStore[] = [];
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

async function freshStore(): Promise<{ factory: MemoryIndexedDb; store: RuntimeStore }> {
  const factory = new MemoryIndexedDb();
  const store = await openRuntimeStore(factory, DB);
  opened.push(store);
  return { factory, store };
}

const run = (runId: string, over: Partial<RunRow> = {}): RunRow => ({
  schema: 1,
  runId,
  projectId: PROJECT,
  kind: 'turn',
  intent: 'Tighten the opening',
  createdAt: 1_000,
  updatedAt: 1_000,
  status: 'running',
  ...over,
});

describe('the v3 to v4 upgrade', () => {
  it('is version 4, and keeps every record a version 3 database held', async () => {
    expect(RUNTIME_DB_VERSION).toBe(4);
    const factory = new MemoryIndexedDb();
    // A database as build 3 left it: the four stores, with a row in each.
    await new Promise<void>((resolve, reject) => {
      const request = factory.open(DB, 3);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore(PROJECT_STORE, { keyPath: 'id' });
        db.createObjectStore(DOCUMENT_STORE, { keyPath: ['projectId', 'id'] }).createIndex('byProject', 'projectId');
        db.createObjectStore(SESSION_STORE, { keyPath: ['projectId', 'index'] }).createIndex('byProject', 'projectId');
        db.createObjectStore(SNAPSHOT_STORE, { keyPath: ['projectId', 'docId', 'revision'] }).createIndex('byProject', 'projectId');
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction([PROJECT_STORE, DOCUMENT_STORE, SNAPSHOT_STORE], 'readwrite');
        tx.objectStore(PROJECT_STORE).put({ id: PROJECT, manifest: createEmptyManifest('Old', new Date(0)), storedAt: 'then' });
        tx.objectStore(DOCUMENT_STORE).put({ projectId: PROJECT, id: 'n_AAAAAAAAAA', body: 'kept body', revision: 4 });
        tx.objectStore(SNAPSHOT_STORE).put({ projectId: PROJECT, docId: 'n_AAAAAAAAAA', revision: 3, body: 'older', capturedAt: 1, command: 'doc.write' });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });

    const store = await openRuntimeStore(factory, DB);
    opened.push(store);
    expect(store.db.version).toBe(4);
    for (const name of ['documents', 'projects', 'runEvents', 'runs', 'sessions', 'snapshots']) expect(store.db.objectStoreNames.contains(name)).toBe(true);
    const state = await readProjectState(store, PROJECT);
    expect(state.manifest.project.name).toBe('Old');
    expect(state.documents.get('n_AAAAAAAAAA')?.revision).toBe(4);
    const snapshots = await new Promise<unknown[]>((resolve, reject) => {
      const request = store.db.transaction(SNAPSHOT_STORE).objectStore(SNAPSHOT_STORE).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(snapshots).toHaveLength(1);
    expect(await readRuns(store, PROJECT)).toEqual([]);
  });
});

describe('appending events', () => {
  it('stores a batch in order, with the status change that goes with it', async () => {
    const { store } = await freshStore();
    await createRun(store, run('run_A'));
    await appendRunEvents(store, 'run_A', [{ seq: 0, t: 'turn.start', intent: 'x' }, { seq: 1, t: 'messages', appended: [] }], { status: 'awaiting-approval', updatedAt: 5 });
    const events = await readRunEvents(store, 'run_A');
    expect(events.map((event) => [event.seq, event.t, event.runId])).toEqual([
      [0, 'turn.start', 'run_A'],
      [1, 'messages', 'run_A'],
    ]);
    expect(await readRun(store, 'run_A')).toMatchObject({ status: 'awaiting-approval', updatedAt: 5 });
  });

  it('is one transaction: a batch with a taken sequence number stores none of it, and leaves the status alone', async () => {
    const { store } = await freshStore();
    await createRun(store, run('run_A'));
    await appendRunEvents(store, 'run_A', [{ seq: 0, t: 'turn.start' }]);
    await expect(appendRunEvents(store, 'run_A', [{ seq: 1, t: 'messages' }, { seq: 0, t: 'messages' }], { status: 'finished' })).rejects.toBeDefined();
    expect((await readRunEvents(store, 'run_A')).map((event) => event.seq)).toEqual([0]);
    expect((await readRun(store, 'run_A'))?.status).toBe('running');
  });

  it('refuses events for a run that does not exist, and a run id taken twice', async () => {
    const { store } = await freshStore();
    await expect(appendRunEvents(store, 'run_NOPE', [{ seq: 0, t: 'turn.start' }])).rejects.toBeInstanceOf(RunNotFoundError);
    await createRun(store, run('run_A'));
    await expect(createRun(store, run('run_A'))).rejects.toBeInstanceOf(RunExistsError);
  });

  it('reads one run events and no other run’s, past nine of them', async () => {
    const { store } = await freshStore();
    await createRun(store, run('run_A'));
    await createRun(store, run('run_B'));
    await appendRunEvents(store, 'run_A', Array.from({ length: 12 }, (_, seq) => ({ seq, t: 'messages' })));
    await appendRunEvents(store, 'run_B', [{ seq: 0, t: 'turn.start' }]);
    expect((await readRunEvents(store, 'run_A')).map((event) => event.seq)).toEqual(Array.from({ length: 12 }, (_, seq) => seq));
    expect(await readRunEvents(store, 'run_B')).toHaveLength(1);
  });
});

describe('interrupted runs', () => {
  it('marks the runs that say running or awaiting approval, and no other', async () => {
    const { store } = await freshStore();
    await createRun(store, run('run_A', { status: 'running' }));
    await createRun(store, run('run_B', { status: 'awaiting-approval' }));
    await createRun(store, run('run_C', { status: 'finished' }));
    await createRun(store, run('run_D', { projectId: 'p_OTHER' }));
    expect(await markRunsInterrupted(store, PROJECT, 9)).toBe(2);
    expect((await readRuns(store, PROJECT)).map((entry) => [entry.runId, entry.status])).toEqual([
      ['run_A', 'interrupted'],
      ['run_B', 'interrupted'],
      ['run_C', 'finished'],
    ]);
    expect((await readRun(store, 'run_D'))?.status).toBe('running');
    expect((await readOpenRuns(store, PROJECT)).map((entry) => entry.runId)).toEqual(['run_A', 'run_B']);
  });

  it('changes a status on its own, and Discard log removes the run and its events', async () => {
    const { store } = await freshStore();
    await createRun(store, run('run_A'));
    await appendRunEvents(store, 'run_A', [{ seq: 0, t: 'turn.start' }]);
    await updateRun(store, 'run_A', { status: 'interrupted', cannotResume: true });
    expect(await readRun(store, 'run_A')).toMatchObject({ status: 'interrupted', cannotResume: true });
    await deleteRun(store, 'run_A');
    expect(await readRun(store, 'run_A')).toBeUndefined();
    expect(await readRunEvents(store, 'run_A')).toEqual([]);
  });
});

describe('retention', () => {
  it('keeps the newest fifty settled runs, drops those older than thirty days, and never evicts a live run', async () => {
    const { store } = await freshStore();
    const now = 100 * DAY;
    for (let index = 0; index < 55; index += 1) {
      await createRun(store, run(`run_${String(index).padStart(2, '0')}`, { status: 'finished', createdAt: now - 1_000 + index, updatedAt: now - 1_000 + index }));
    }
    await createRun(store, run('run_OLD', { status: 'failed', createdAt: now - 40 * DAY, updatedAt: now - 40 * DAY }));
    await createRun(store, run('run_LIVE', { status: 'running', createdAt: now - 90 * DAY, updatedAt: now - 90 * DAY }));
    await appendRunEvents(store, 'run_00', [{ seq: 0, t: 'turn.start' }]);

    expect(await pruneRuns(store, PROJECT, now)).toBe(6);
    const left = (await readRuns(store, PROJECT)).map((entry) => entry.runId);
    expect(left).toHaveLength(51);
    expect(left).toContain('run_LIVE');
    expect(left).not.toContain('run_OLD');
    expect(left).not.toContain('run_00');
    // The evicted run took its events with it.
    expect(await readRunEvents(store, 'run_00')).toEqual([]);
  });
});

describe('deleting a project', () => {
  it('takes its runs and their events, and leaves another project’s', async () => {
    const { store } = await freshStore();
    const manifest = createEmptyManifest('Keeper', new Date(0));
    manifest.project.id = PROJECT;
    const state = createProjectState(manifest);
    addDocument(state, { parentId: 'manuscript', title: 'One', body: 'x', now: new Date(0), id: 'n_AAAAAAAAAA' });
    await writeProjectState(store, state);
    await createRun(store, run('run_A'));
    await createRun(store, run('run_B', { projectId: 'p_OTHER' }));
    await appendRunEvents(store, 'run_A', [{ seq: 0, t: 'turn.start' }, { seq: 1, t: 'messages' }]);
    await appendRunEvents(store, 'run_B', [{ seq: 0, t: 'turn.start' }]);

    expect(await deleteProject(store, PROJECT)).toBe(true);
    expect(await readRun(store, 'run_A')).toBeUndefined();
    expect(await readRunEvents(store, 'run_A')).toEqual([]);
    expect(await readRunEvents(store, 'run_B')).toHaveLength(1);
    expect(await readRun(store, 'run_B')).toBeDefined();
  });
});
