import { afterEach, expect, it } from 'vitest';
import { addDocument, createEmptyManifest, createProjectState, MemoryIndexedDb, openRuntimeStore, ProjectWriteConflictError, readCoherenceFiles, readProjectState, writeCoherenceFiles, writeDocumentBody, writeProjectState, type RuntimeStore } from '../src/index.js';

const stores: RuntimeStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

async function fixture() {
  const factory = new MemoryIndexedDb();
  const store = await openRuntimeStore(factory);
  stores.push(store);
  const state = createProjectState(createEmptyManifest('Restore', new Date(0)));
  addDocument(state, { parentId: 'manuscript', title: 'One', body: 'First body.', now: new Date(0) });
  addDocument(state, { parentId: 'manuscript', title: 'Two', body: 'Second body.', now: new Date(0) });
  await writeProjectState(store, state);
  await writeCoherenceFiles(store, state.manifest.project.id, { 'coherence.json': 'old findings' });
  const expected = await readProjectState(store, state.manifest.project.id);
  const next = structuredClone(expected);
  next.manifest.project.name = 'Restored';
  for (const doc of next.documents.values()) { doc.body = 'Restored body.'; doc.revision += 1; next.revisionFloors!.set(doc.id, doc.revision); }
  return { factory, store, state, expected, next, projectId: state.manifest.project.id };
}

it('checks every document and findings before changing anything in a restore transaction', async () => {
  const { store, state, expected, next, projectId } = await fixture();
  const doc = [...state.documents.values()][1]!;
  await writeDocumentBody(store, { projectId, docId: doc.id, body: 'Newer words in another tab.', expectedRevision: doc.revision });
  const before = await readProjectState(store, projectId);
  await expect(writeProjectState(store, next, { expected, expectedCoherence: 'old findings', coherence: 'restored findings' })).rejects.toBeInstanceOf(ProjectWriteConflictError);
  expect(await readProjectState(store, projectId)).toEqual(before);
  expect(await readCoherenceFiles(store, projectId)).toEqual({ 'coherence.json': 'old findings' });
});

it('commits project content and findings together, or aborts every write', async () => {
  const { factory, store, expected, next, projectId } = await fixture();
  factory.abortAfterWrites(2);
  await expect(writeProjectState(store, next, { expected, expectedCoherence: 'old findings', coherence: 'restored findings' })).rejects.toThrow();
  expect(await readProjectState(store, projectId)).toEqual(expected);
  expect(await readCoherenceFiles(store, projectId)).toEqual({ 'coherence.json': 'old findings' });
  await writeProjectState(store, next, { expected, expectedCoherence: 'old findings', coherence: 'restored findings' });
  expect(await readProjectState(store, projectId)).toEqual(next);
  expect(await readCoherenceFiles(store, projectId)).toEqual({ 'coherence.json': 'restored findings' });
});

it('refuses changed structure or findings even when document revisions match', async () => {
  const { store, expected, next, projectId } = await fixture();
  await writeCoherenceFiles(store, projectId, { 'coherence.json': 'newer findings' });
  await expect(writeProjectState(store, next, { expected, expectedCoherence: 'old findings', coherence: 'restored findings' })).rejects.toBeInstanceOf(ProjectWriteConflictError);
  const changed = structuredClone(expected);
  changed.manifest.project.name = 'Another title';
  await writeProjectState(store, changed);
  await expect(writeProjectState(store, next, { expected, expectedCoherence: 'newer findings', coherence: 'restored findings' })).rejects.toBeInstanceOf(ProjectWriteConflictError);
  expect((await readProjectState(store, projectId)).manifest.project.name).toBe('Another title');
});
