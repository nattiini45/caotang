import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRun, DOCUMENT_STORE, MemoryIndexedDb, openRuntimeStore, readCoherenceFiles, readProjectState, readRunBaseline, readRunBaselines, updateRun, writeCoherenceFiles, writeDocumentBody, writeProjectState, type RunRow } from '@caotang/store';
import { emptyCoherenceFile, serializeCoherenceFile } from '@caotang/coherence';
import { captureRunBaseline, validateRunBaseline } from '../src/app/run-baseline.js';
import { sampleProjectState } from '../src/app/demo.js';
import { ProjectSession } from '../src/app/session.js';
import { shadowOf } from '../src/app/persistence-plan.js';
import { attachCoherence, legacyCoherenceKey } from '../src/app/coherence-io.js';
import { setActiveAppDb, type AppDb } from '../src/app/app-db.js';

const sessions: ProjectSession[] = [];
beforeEach(() => {
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
});
afterEach(async () => {
  setActiveAppDb(null);
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) await session.close();
  vi.unstubAllGlobals();
});

async function fixture() {
  const state = sampleProjectState();
  const factory = new MemoryIndexedDb();
  const store = await openRuntimeStore(factory);
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  sessions.push(session);
  const run: RunRow = { schema: 3, runId: 'run_baseline', projectId: session.projectId, kind: 'turn', intent: 'Tag the scene', createdAt: 1, updatedAt: 1, status: 'running' };
  await createRun(store, run);
  const doc = [...state.documents.values()][0]!;
  return { state, store, session, run, doc, factory };
}

it('can undo a restore when no findings persistence port is attached', async () => {
  const { session, run, doc } = await fixture();
  await session.captureRunBaseline(run.runId);
  session.dispatch('doc.write', { docId: doc.id, body: 'Changed.' });
  const expected = await session.prepareRunRestore(run.runId);
  expect(await session.restoreRun(run.runId, expected)).toMatchObject({ ok: true });
  expect(await session.undoGroup(session.newestUndoGroupId()!)).toEqual({ kind: 'done' });
});

it('round-trips text and binary skills without pictures or settings, and validates project ownership and findings', async () => {
  const state = sampleProjectState();
  state.skills.set('example', [{ path: 'SKILL.md', bytes: new TextEncoder().encode('---\nname: example\ndescription: Example\n---\nRead this.') }, { path: 'assets/data.bin', bytes: new Uint8Array([0xff, 0xfe, 0xfd]) }]);
  const doc = [...state.documents.values()][0]!;
  doc.revision = 42;
  const baseline = await captureRunBaseline(state);
  expect(Object.keys(baseline.binaryFiles)).toEqual(['.agents/skills/example/assets/data.bin']);
  expect(Object.keys(baseline.textFiles).some((path) => path.startsWith('assets/') || path.startsWith('runs/'))).toBe(false);
  const restored = await validateRunBaseline(baseline, state.manifest.project.id);
  expect(restored.documents.get(doc.id)).toEqual(doc);
  expect(restored.skills.get('example')).toEqual(state.skills.get('example'));
  await expect(validateRunBaseline(baseline, 'p_other')).rejects.toThrow('belong');
  await expect(validateRunBaseline({ ...baseline, coherence: '{}' }, state.manifest.project.id)).rejects.toThrow('findings');
  await expect(validateRunBaseline({ ...baseline, textFiles: { ...baseline.textFiles, '../secret': 'no' } }, state.manifest.project.id)).rejects.toThrow('path');
  await expect(validateRunBaseline({ ...baseline, binaryFiles: { 'assets/no.png': new Uint8Array([1]) } }, state.manifest.project.id)).rejects.toThrow('binary');
});

it('captures once, survives later writes and 101 checkpoints, preserves earlier undo groups, and can undo the restore', async () => {
  const { state, store, session, run, doc } = await fixture();
  const original = doc.body;
  session.dispatch('doc.write', { docId: doc.id, body: `${original}\nWriter’s edit.` });
  await session.captureRunBaseline(run.runId);
  const baseline = await readRunBaseline(store, session.projectId, run.runId);
  expect(baseline).toBeDefined();
  const captured = doc.body;
  for (let index = 0; index < 101; index += 1) session.dispatch('doc.write', { docId: doc.id, body: `Agent change ${index}` });
  await session.captureRunBaseline(run.runId);
  expect(await readRunBaseline(store, session.projectId, run.runId)).toEqual(baseline);
  await updateRun(store, run.runId, { status: 'finished', outcome: 'applied' });
  const expected = await session.prepareRunRestore(run.runId);
  const revision = doc.revision;
  const result = await session.restoreRun(run.runId, expected);
  expect(result.ok).toBe(true);
  expect(state.documents.get(doc.id)?.body).toBe(captured);
  expect(state.documents.get(doc.id)!.revision).toBeGreaterThan(revision);
  expect(session.undo.groups()).toHaveLength(2);
  expect((await session.undoGroup(session.newestUndoGroupId()!)).kind).toBe('done');
  expect(state.documents.get(doc.id)?.body).toBe('Agent change 100');
  expect(state.documents.get(doc.id)!.revision).toBeGreaterThan(revision + 1);
  expect(session.undo.groups()).toHaveLength(102);
  expect((await session.undoGroup(session.undo.groups()[0]!.id)).kind).toBe('failed');
  expect(await readRunBaselines(store, session.projectId)).toHaveLength(1);
});

it('refuses stale confirmations atomically, refuses an unavailable baseline, and leaves the live project intact', async () => {
  const { state, session, run, doc } = await fixture();
  await session.captureRunBaseline(run.runId);
  const expected = await session.prepareRunRestore(run.runId);
  session.dispatch('doc.write', { docId: doc.id, body: 'A later edit must survive.' });
  const result = await session.restoreRun(run.runId, expected);
  expect(result.ok).toBe(false);
  expect(state.documents.get(doc.id)?.body).toBe('A later edit must survive.');
  await expect(session.prepareRunRestore('run_missing')).rejects.toThrow();
});

it('refuses the first writing step if the pending project cannot save', async () => {
  const { session, store, run } = await fixture();
  vi.spyOn(session, 'saved').mockRejectedValue(new Error('revision conflict'));
  await expect(session.captureRunBaseline(run.runId)).rejects.toThrow('revision conflict');
  expect(await readRunBaseline(store, session.projectId, run.runId)).toBeUndefined();
});

it('restores its baseline after a new session has loaded the saved project', async () => {
  const { store, session, run, doc } = await fixture();
  const original = doc.body;
  await session.captureRunBaseline(run.runId);
  session.dispatch('doc.write', { docId: doc.id, body: 'Applied before reload.' });
  await session.saved();
  await session.close();
  const state = await readProjectState(store, session.projectId);
  const reloaded = new ProjectSession({ store, projectId: session.projectId, state, shadow: shadowOf(state) });
  sessions.push(reloaded);
  const expected = await reloaded.prepareRunRestore(run.runId);
  expect((await reloaded.restoreRun(run.runId, expected)).ok).toBe(true);
  expect((await readProjectState(store, session.projectId)).documents.get(doc.id)?.body).toBe(original);
});

it('restores and undoes with the lifecycle’s hydrated findings when the stored findings file is absent', async () => {
  const { store, session, run, doc } = await fixture();
  await attachCoherence(session, store);
  const original = doc.body;
  await session.captureRunBaseline(run.runId);
  session.dispatch('doc.write', { docId: doc.id, body: 'Applied with hydrated findings.' });
  await session.saved();
  await session.close();
  const state = await readProjectState(store, session.projectId);
  const reloaded = new ProjectSession({ store, projectId: session.projectId, state, shadow: shadowOf(state) });
  sessions.push(reloaded);
  await attachCoherence(reloaded, store);
  const expected = await reloaded.prepareRunRestore(run.runId);
  expect((await reloaded.restoreRun(run.runId, expected)).ok).toBe(true);
  expect((await readProjectState(store, session.projectId)).documents.get(doc.id)?.body).toBe(original);
  expect((await reloaded.undoGroup(reloaded.newestUndoGroupId()!)).kind).toBe('done');
  await reloaded.saved();
  expect((await readProjectState(store, session.projectId)).documents.get(doc.id)?.body).toBe('Applied with hydrated findings.');
});

it('keeps another tab’s newer words and rolls the in-memory restore back when its atomic guard refuses', async () => {
  const { store, session, run, doc, state } = await fixture();
  await session.captureRunBaseline(run.runId);
  session.dispatch('doc.write', { docId: doc.id, body: 'This tab’s last saved words.' });
  const expected = await session.prepareRunRestore(run.runId);
  await writeDocumentBody(store, { projectId: session.projectId, docId: doc.id, body: 'Another tab’s newer words.', expectedRevision: doc.revision });
  const result = await session.restoreRun(run.runId, expected);
  expect(result).toMatchObject({ ok: false, undone: [] });
  expect((await readProjectState(store, session.projectId)).documents.get(doc.id)?.body).toBe('Another tab’s newer words.');
  expect(state.documents.get(doc.id)?.body).toBe('This tab’s last saved words.');
  expect(session.saveState()).toBe('conflict');
});

it('uses the findings owner’s loaded bytes without treating harmless formatting as a newer file', async () => {
  const { store, session, run, doc } = await fixture();
  await session.saved();
  const text = JSON.stringify(JSON.parse(serializeCoherenceFile(emptyCoherenceFile())));
  await writeCoherenceFiles(store, session.projectId, { 'coherence.json': text });
  await attachCoherence(session, store);
  await session.captureRunBaseline(run.runId);
  session.dispatch('doc.write', { docId: doc.id, body: 'Later words.' });
  const expected = await session.prepareRunRestore(run.runId);
  expect((await session.restoreRun(run.runId, expected)).ok).toBe(true);
  const again = await session.prepareRunRestore(run.runId);
  expect((await session.restoreRun(run.runId, again)).ok).toBe(true);
});

it('keeps another tab’s newer findings when the local findings mirror has not read them', async () => {
  const { store, session, run } = await fixture();
  await attachCoherence(session, store);
  await session.captureRunBaseline(run.runId);
  const expected = await session.prepareRunRestore(run.runId);
  const newer = serializeCoherenceFile({ ...emptyCoherenceFile(), worldRules: [{ id: 'w_ABCDEFGHJK', text: 'A newer rule.', origin: 'manual', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }] });
  await writeCoherenceFiles(store, session.projectId, { 'coherence.json': newer });
  expect((await session.restoreRun(run.runId, expected)).ok).toBe(false);
  expect((await readCoherenceFiles(store, session.projectId))['coherence.json']).toBe(newer);
  expect(session.saveState()).toBe('conflict');
});

it('refuses to replace a newer-format findings file through run recovery', async () => {
  const { store, session, run, doc } = await fixture();
  await session.saved();
  const text = '{"formatVersion": 2, "findings": []}';
  await writeCoherenceFiles(store, session.projectId, { 'coherence.json': text });
  await attachCoherence(session, store);
  await session.captureRunBaseline(run.runId);
  session.dispatch('doc.write', { docId: doc.id, body: 'Words to keep.' });
  const expected = await session.prepareRunRestore(run.runId);
  expect((await session.restoreRun(run.runId, expected)).ok).toBe(false);
  expect(session.state.documents.get(doc.id)?.body).toBe('Words to keep.');
  expect((await readCoherenceFiles(store, session.projectId))['coherence.json']).toBe(text);
});

it('restores a deleted scene above every revision its later body held', async () => {
  const { store, session, run, doc, state } = await fixture();
  doc.revision = 5;
  await session.captureRunBaseline(run.runId);
  for (let revision = 6; revision <= 20; revision += 1) session.dispatch('doc.write', { docId: doc.id, body: `Later body ${revision}.` });
  await session.saved();
  session.dispatch('project.deleteNode', { nodeId: doc.id });
  await session.saved();
  expect(state.documents.has(doc.id)).toBe(false);
  const expected = await session.prepareRunRestore(run.runId);
  expect((await session.restoreRun(run.runId, expected)).ok).toBe(true);
  expect(state.documents.get(doc.id)?.revision).toBe(21);
  expect((await readProjectState(store, session.projectId)).documents.get(doc.id)?.revision).toBe(21);
});

it('saves a body above a retained floor after an older artifact replaces the working copy', async () => {
  const { store, session, state, doc } = await fixture();
  await session.saved();
  const older = structuredClone(state);
  for (let index = 0; index < 3; index += 1) session.dispatch('doc.write', { docId: doc.id, body: `Later text ${index}.` });
  await session.saved();
  const floor = state.documents.get(doc.id)!.revision;
  await session.close();
  await writeProjectState(store, older);
  const loaded = await readProjectState(store, session.projectId);
  const reloaded = new ProjectSession({ store, projectId: session.projectId, state: loaded, shadow: shadowOf(loaded) });
  sessions.push(reloaded);
  expect(reloaded.dispatch('doc.write', { docId: doc.id, body: 'A newly saved body.' }).ok).toBe(true);
  await reloaded.saved();
  expect(reloaded.saveState()).toBe('saved');
  expect((await readProjectState(store, session.projectId)).documents.get(doc.id)).toMatchObject({ body: 'A newly saved body.', revision: floor + 1 });
});

it('cannot persist part of a multi-document restore when the second document write fails', async () => {
  const { store, session, run, state, factory } = await fixture();
  await session.captureRunBaseline(run.runId);
  for (const doc of state.documents.values()) session.dispatch('doc.write', { docId: doc.id, body: `Later text for ${doc.id}.` });
  const expected = await session.prepareRunRestore(run.runId);
  const before = await readProjectState(store, session.projectId);
  const tx = store.db.transaction(DOCUMENT_STORE, 'readonly');
  const prototype = Object.getPrototypeOf(tx.objectStore(DOCUMENT_STORE)) as IDBObjectStore;
  const put = prototype.put;
  let writes = 0;
  vi.spyOn(prototype, 'put').mockImplementation(function(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (this.name === DOCUMENT_STORE && ++writes >= 2) factory.abortAfterWrites(0);
    return put.call(this, value, key);
  });
  expect((await session.restoreRun(run.runId, expected)).ok).toBe(false);
  const after = await readProjectState(store, session.projectId);
  expect(after.documents).toEqual(before.documents);
  expect(after.manifest).toEqual(before.manifest);
});

it.each([2, 3])('persists the latest findings when a failed restore is retried with scene day %s', async (dayOffset) => {
  const { store, session, run, doc, factory } = await fixture();
  await attachCoherence(session, store);
  expect(session.dispatch('coherence.setSceneMeta', { docId: doc.id, patch: { dayOffset: 1 } }).ok).toBe(true);
  await session.captureRunBaseline(run.runId);
  expect(session.dispatch('coherence.setSceneMeta', { docId: doc.id, patch: { dayOffset: 2 } }).ok).toBe(true);
  const expected = await session.prepareRunRestore(run.runId);
  const tx = store.db.transaction(DOCUMENT_STORE, 'readonly');
  const prototype = Object.getPrototypeOf(tx.objectStore(DOCUMENT_STORE)) as IDBObjectStore;
  const put = prototype.put;
  let failing = true;
  vi.spyOn(prototype, 'put').mockImplementation(function(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (this.name === DOCUMENT_STORE && failing) factory.abortAfterWrites(0);
    return put.call(this, value, key);
  });
  expect(await session.restoreRun(run.runId, expected)).toMatchObject({ ok: false });
  expect(session.saveState()).toBe('failed');
  expect(session.coherenceFile()?.sceneMeta[doc.id]?.dayOffset).toBe(1);
  failing = false;
  expect(session.dispatch('coherence.setSceneMeta', { docId: doc.id, patch: { dayOffset } }).ok).toBe(true);
  await session.saved();
  const text = (await readCoherenceFiles(store, session.projectId))['coherence.json']!;
  expect(JSON.parse(text).sceneMeta[doc.id].dayOffset).toBe(dayOffset);
  expect(session.runRestoreCoherenceText(null)).toBe(text);
  await session.close();
  const state = await readProjectState(store, session.projectId);
  const reloaded = new ProjectSession({ store, projectId: session.projectId, state, shadow: shadowOf(state) });
  sessions.push(reloaded);
  await attachCoherence(reloaded, store);
  expect(reloaded.coherenceFile()?.sceneMeta[doc.id]?.dayOffset).toBe(dayOffset);
});

it.each([false, true])('returns the groups taken back when saving a multi-group restore fails (step: %s)', async (partialStep) => {
  const { session, doc } = await fixture();
  session.dispatch('doc.write', { docId: doc.id, body: 'First change.' });
  const target = session.newestUndoGroupId()!;
  session.dispatch('doc.write', { docId: doc.id, body: 'Second change.' });
  const later = session.newestUndoGroupId()!;
  await session.saved();
  const saved = vi.spyOn(session, 'saved');
  saved.mockResolvedValueOnce().mockRejectedValueOnce(new Error('Disk is full.'));
  const step = vi.fn(() => session.undo.undo(target));
  const result = await session.restoreBefore(target, partialStep ? step : undefined);
  expect(result).toMatchObject({ ok: false, undone: [later] });
  expect(session.state.documents.get(doc.id)?.body).toBe('First change.');
  expect(session.undo.group(target)).toBeDefined();
  expect(step).not.toHaveBeenCalled();
});

it('reports a save failure after the target step was taken back without claiming the whole group', async () => {
  const { session, doc } = await fixture();
  session.dispatch('doc.write', { docId: doc.id, body: 'A change to take back.' });
  const target = session.newestUndoGroupId()!;
  await session.saved();
  vi.spyOn(session, 'saved').mockResolvedValueOnce().mockRejectedValueOnce(new Error('Disk is full.'));
  const step = vi.fn(() => session.undo.undo(target));
  const result = await session.restoreBefore(target, step);
  expect(result).toMatchObject({ ok: false, undone: [], message: expect.stringContaining('Some changes were taken back') });
  expect(step).toHaveBeenCalledOnce();
  expect(session.undo.group(target)).toBeUndefined();
});

it('reports an initial save failure before taking any restore group back', async () => {
  const { session, doc } = await fixture();
  session.dispatch('doc.write', { docId: doc.id, body: 'A change to keep.' });
  const target = session.newestUndoGroupId()!;
  await session.saved();
  vi.spyOn(session, 'saved').mockRejectedValueOnce(new Error('Disk is full.'));
  expect(await session.restoreBefore(target)).toMatchObject({ ok: false, undone: [], message: expect.stringContaining('nothing was restored') });
  expect(session.state.documents.get(doc.id)?.body).toBe('A change to keep.');
  expect(session.undo.group(target)).toBeDefined();
});

it.each([false, true])('preserves an edit made while checkpoint restoration saves (same group: %s)', async (sameGroup) => {
  const { session, doc } = await fixture();
  session.dispatch('doc.write', { docId: doc.id, body: 'First change.' });
  const target = session.undo.groups().at(-1)!;
  session.dispatch('doc.write', { docId: doc.id, body: 'Second change.' });
  const later = session.newestUndoGroupId()!;
  await session.saved();
  const saved = session.saved.bind(session);
  vi.spyOn(session, 'saved').mockImplementationOnce(saved).mockImplementationOnce(async () => {
    session.dispatch('doc.write', { docId: doc.id, body: 'New work during restore.' });
    if (sameGroup) {
      const added = session.undo.groups().at(-1)!;
      for (const entry of added.entries) session.undo.register({ id: target.id, kind: target.kind, at: target.at, replay: false }, entry);
      session.undo.forget(added.id);
    }
    await saved();
  });
  expect(await session.restoreBefore(target.id)).toMatchObject({ ok: false, undone: [later] });
  expect(session.state.documents.get(doc.id)?.body).toBe('New work during restore.');
  expect(session.undo.group(target.id)).toBeDefined();
});

it.each([false, true])('guards legacy findings against the runtime store rather than the loaded fallback (newer runtime: %s)', async (newerRuntime) => {
  const { session, store, run, doc } = await fixture();
  await session.saved();
  const legacy = { ...emptyCoherenceFile(), sceneMeta: { [doc.id]: { dayOffset: 5 } } };
  const text = serializeCoherenceFile(legacy);
  setActiveAppDb({
    get: async <T,>(key: string): Promise<T | undefined> => key === legacyCoherenceKey(session.projectId) ? { 'coherence.json': text } as T : undefined,
    put: async () => {},
    close: () => {},
  } as AppDb);
  await attachCoherence(session, store);
  expect(session.coherenceFile()?.sceneMeta[doc.id]?.dayOffset).toBe(5);
  await session.captureRunBaseline(run.runId);
  session.dispatch('doc.write', { docId: doc.id, body: 'Words after loading legacy findings.' });
  const expected = await session.prepareRunRestore(run.runId);
  expect((await readCoherenceFiles(store, session.projectId))['coherence.json']).toBeUndefined();
  const newer = serializeCoherenceFile({ ...legacy, sceneMeta: { [doc.id]: { dayOffset: 10 } } });
  if (newerRuntime) await writeCoherenceFiles(store, session.projectId, { 'coherence.json': newer });
  const outcome = await session.restoreRun(run.runId, expected);
  expect(outcome.ok).toBe(!newerRuntime);
  if (newerRuntime) {
    expect(session.saveState()).toBe('conflict');
    expect((await readCoherenceFiles(store, session.projectId))['coherence.json']).toBe(newer);
    expect(session.state.documents.get(doc.id)?.body).toBe('Words after loading legacy findings.');
  } else {
    expect(session.saveState()).toBe('saved');
    expect(session.runRestoreCoherenceText(null)).toBe((await readCoherenceFiles(store, session.projectId))['coherence.json']);
    expect(session.coherenceFile()?.sceneMeta[doc.id]?.dayOffset).toBe(5);
    expect(await session.undoGroup(session.newestUndoGroupId()!)).toEqual({ kind: 'done' });
  }
});
