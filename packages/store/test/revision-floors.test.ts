import { afterEach, describe, expect, it } from 'vitest';

import {
  addDocument,
  addFolder,
  cloneProjectState,
  createEmptyManifest,
  createProjectState,
  getRevision,
  getRevisionFloor,
  removeDocument,
  removeNode,
  setBody,
} from '../src/index.js';
import { MemoryIndexedDb } from '../src/runtime/memory-idb.js';
import {
  PROJECT_STORE,
  commitProject,
  openRuntimeStore,
  readProjectState,
  writeDocumentBody,
  writeProjectState,
  type ProjectRow,
  type RuntimeStore,
} from '../src/runtime/store.js';

const NOW = new Date('2026-11-11T09:00:00.000Z');
const DB = 'revision-floors';
const PROJECT = 'p_FLOORS0001';
const FOLDER = 'n_FOLDER0001';
const DOC = 'n_SCENE0001';
const opened: RuntimeStore[] = [];

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

function fixture() {
  const state = createProjectState(createEmptyManifest('Revision floors', NOW));
  state.manifest.project.id = PROJECT;
  addFolder(state, { parentId: 'manuscript', id: FOLDER, title: 'Chapter', now: NOW });
  addDocument(state, { parentId: FOLDER, id: DOC, title: 'Scene', body: 'Baseline.', now: NOW });
  state.documents.get(DOC)!.revision = 5;
  return state;
}

async function open(factory = new MemoryIndexedDb()) {
  const store = await openRuntimeStore(factory, DB);
  opened.push(store);
  return { factory, store };
}

async function forgetFloors(store: RuntimeStore): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = store.db.transaction(PROJECT_STORE, 'readwrite');
    const projects = tx.objectStore(PROJECT_STORE);
    const request = projects.get(PROJECT);
    request.onsuccess = () => {
      const row = request.result as ProjectRow;
      delete row.revisionFloors;
      projects.put(row);
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

describe('in-memory document revision floors', () => {
  it('keeps the highest live revision when a subtree is deleted and its id is recreated', () => {
    const state = fixture();
    for (let revision = 6; revision <= 20; revision += 1) setBody(state, DOC, `Draft ${revision}.`, { now: NOW });
    removeNode(state, FOLDER);
    expect(state.documents.has(DOC)).toBe(false);
    expect(getRevision(state, DOC)).toBe(0);
    expect(getRevisionFloor(state, DOC)).toBe(20);
    addDocument(state, { parentId: 'manuscript', id: DOC, title: 'Restored', body: 'Baseline.', now: NOW });
    expect(getRevision(state, DOC)).toBe(21);
  });

  it('clones deleted-document floors without sharing them, and a body write uses the floor', () => {
    const state = fixture();
    state.revisionFloors!.set(DOC, 20);
    removeDocument(state, DOC);
    const copy = cloneProjectState(state);
    expect(copy).toEqual(state);
    copy.revisionFloors!.set(DOC, 30);
    expect(getRevisionFloor(state, DOC)).toBe(20);
    copy.documents.set(DOC, { id: DOC, body: 'Baseline.', revision: 5 });
    setBody(copy, DOC, 'Restored.', { now: NOW });
    expect(getRevision(copy, DOC)).toBe(31);
    expect(getRevisionFloor(copy, DOC)).toBe(31);
  });

  it('accepts an older state without the additive field', () => {
    const state = fixture();
    delete state.revisionFloors;
    expect(getRevisionFloor(state, DOC)).toBe(5);
    removeDocument(state, DOC);
    expect(getRevisionFloor(state, DOC)).toBe(5);
  });
});

describe('persistent document revision floors', () => {
  it('keeps r20 after deletion and reopen so an r5 baseline restores at r21', async () => {
    const { factory, store } = await open();
    const state = fixture();
    const baseline = cloneProjectState(state);
    await writeProjectState(store, state);
    for (let revision = 6; revision <= 20; revision += 1) {
      await writeDocumentBody(store, { projectId: PROJECT, docId: DOC, body: `Draft ${revision}.`, expectedRevision: revision - 1 });
    }
    const edited = await readProjectState(store, PROJECT);
    removeNode(edited, FOLDER);
    await writeProjectState(store, edited);
    store.close();
    const reopened = (await open(factory)).store;
    const deleted = await readProjectState(reopened, PROJECT);
    expect(reopened.db.version).toBe(4);
    expect(deleted.documents.has(DOC)).toBe(false);
    expect(getRevisionFloor(deleted, DOC)).toBe(20);
    expect(cloneProjectState(deleted)).toEqual(deleted);
    baseline.revisionFloors = new Map(deleted.revisionFloors);
    baseline.documents.get(DOC)!.revision = getRevisionFloor(baseline, DOC) + 1;
    await writeProjectState(reopened, baseline);
    expect(getRevision(await readProjectState(reopened, PROJECT), DOC)).toBe(21);
  });

  it('captures stored revisions before a wholesale deletion even if incoming state forgot its floors', async () => {
    const { store } = await open();
    const state = fixture();
    state.documents.get(DOC)!.revision = 20;
    await writeProjectState(store, state);
    await forgetFloors(store);
    const deleted = fixture();
    removeNode(deleted, FOLDER);
    deleted.revisionFloors = new Map();
    await writeProjectState(store, deleted);
    const reopened = await readProjectState(store, PROJECT);
    expect(reopened.documents.has(DOC)).toBe(false);
    expect(getRevisionFloor(reopened, DOC)).toBe(20);
  });

  it('retains legacy live revisions during a structural deletion and starts recreation above them', async () => {
    const { store } = await open();
    const state = fixture();
    state.documents.get(DOC)!.revision = 20;
    await writeProjectState(store, state);
    await forgetFloors(store);
    const rehydrated = await readProjectState(store, PROJECT);
    expect(getRevisionFloor(rehydrated, DOC)).toBe(20);
    const restoredManifest = structuredClone(state.manifest);
    removeNode(state, DOC);
    await commitProject(store, { projectId: PROJECT, manifest: state.manifest, removeDocumentIds: [DOC] });
    await commitProject(store, { projectId: PROJECT, manifest: state.manifest });
    expect(getRevisionFloor(await readProjectState(store, PROJECT), DOC)).toBe(20);
    await commitProject(store, { projectId: PROJECT, manifest: restoredManifest, createDocuments: [{ id: DOC, body: 'Restored.' }] });
    expect(getRevision(await readProjectState(store, PROJECT), DOC)).toBe(21);
  });

  it('merges high-water marks across lower-revision ingest and advances the next body write above them', async () => {
    const { factory, store } = await open();
    const state = fixture();
    state.documents.get(DOC)!.revision = 20;
    await writeProjectState(store, state);
    await writeProjectState(store, fixture());
    const ingested = await readProjectState(store, PROJECT);
    expect(getRevision(ingested, DOC)).toBe(5);
    expect(getRevisionFloor(ingested, DOC)).toBe(20);
    expect(await writeDocumentBody(store, { projectId: PROJECT, docId: DOC, body: 'After ingest.', expectedRevision: 5 })).toEqual({ revision: 21, changed: true });
    const rows = factory.rawRecords(DB, PROJECT_STORE) as ProjectRow[];
    expect(rows[0]?.revisionFloors?.[DOC]).toBe(21);
  });
});
