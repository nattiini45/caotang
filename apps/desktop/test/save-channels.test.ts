import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getBody, getRevision, MemoryIndexedDb, openRuntimeStore, RevisionConflictError, writeProjectState } from '@caotang/store';

import { ProjectSession } from '../src/app/session.js';
import { shadowOf } from '../src/app/persistence-plan.js';
import { openTasksHome } from '../src/app/tasks-io.js';
import { IDS, project } from '../../../e2e/unit/fixtures.js';
import { SettingsStore } from '../src/app/services.js';
import { DEFAULT_SETTINGS } from '../src/app/settings.js';
import type { AppDb } from '../src/app/app-db.js';
import { activateEnglish } from '../src/i18n/runtime.js';
import { saveStateWords } from '../src/app/integrity-model.js';
import { SaveChannel } from '../src/app/save-channel.js';

beforeEach(() => {
  activateEnglish();
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());

it.each([false, true])('names a retained document revision conflict even after an unchanged flush: %s', async (unchanged) => {
  const state = project();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  await writeProjectState(store, state);
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: shadowOf(state) });
  await session.settle();
  const original = getBody(state, IDS.sceneA);
  session.autosave.open(IDS.sceneA, { body: original, revision: getRevision(state, IDS.sceneA) });
  expect(session.dispatch('doc.write', { docId: IDS.sceneA, body: 'Newer saved text.' }).ok).toBe(true);
  await session.persistence.settle();
  session.autosave.noteEdit(IDS.sceneA, 'My unsaved words.');
  expect((await session.autosave.flush(IDS.sceneA))[0]?.outcome).toBe('conflict');
  if (unchanged) {
    session.autosave.noteEdit(IDS.sceneA, original);
    expect((await session.autosave.flush(IDS.sceneA))[0]?.outcome).toBe('unchanged');
    expect(session.autosave.status(IDS.sceneA).dirty).toBe(false);
  }
  expect(session.autosave.status(IDS.sceneA).lastError).toBeInstanceOf(RevisionConflictError);
  expect(session.saveState()).toBe('failed');
  expect(session.failedSaveChannels()).toEqual(['documents']);
  const words = saveStateWords(session.saveState(), undefined, session.failedSaveChannels());
  expect(words.text).toContain('Not saved: Documents.');
  expect(words.text).toContain('Copy your unsaved text somewhere safe before reloading.');
  expect(words.offersBackup).toBe(false);
  await expect(session.saved()).rejects.toThrow('could not be saved');
  await session.autosave.reseat(IDS.sceneA, { body: getBody(state, IDS.sceneA), revision: getRevision(state, IDS.sceneA) });
  session.autosave.noteEdit(IDS.sceneA, 'The resolved words.');
  await session.saved();
  expect(session.saveState()).toBe('saved');
  expect(session.failedSaveChannels()).toEqual([]);
  await session.close();
});

it('does not report saved when a task write failed', async () => {
  const state = project();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  await writeProjectState(store, state);
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: shadowOf(state) });
  const tasks = await openTasksHome(state.manifest.project.id, store);
  session.attachTasks(tasks);
  await session.settle();
  store.db.close();
  const failure = await tasks.save({ formatVersion: 1, tasks: [] });
  expect(failure).not.toBeNull();
  expect(session.saveState()).toBe('failed');
  expect(session.failedSaveChannels()).toEqual(['tasks']);
  expect(saveStateWords(session.saveState(), undefined, session.failedSaveChannels()).text).toContain('Tasks');
  await session.close().catch(() => undefined);
});

it('includes pending and refused settings writes and recovers after a successful retry', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const put = vi.fn<AppDb['put']>().mockImplementationOnce(async () => { await gate; throw new Error('full'); }).mockResolvedValue(undefined);
  const settings = new SettingsStore({ put } as AppDb, DEFAULT_SETTINGS);
  const state = project();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  await writeProjectState(store, state);
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: shadowOf(state), saveChannels: [settings.saveChannel] });
  await session.settle();
  const seen: string[] = [];
  session.subscribe(() => seen.push(session.saveState()));
  const updating = settings.update({ editor: { autosaveDebounceMs: 1200 } });
  expect(session.saveState()).toBe('saving');
  release();
  expect(await updating).toContain('full');
  expect(session.saveState()).toBe('failed');
  expect(session.failedSaveChannels()).toEqual(['settings']);
  expect(saveStateWords(session.saveState(), undefined, session.failedSaveChannels())).toEqual({
    text: 'Not saved: Settings. Your changes are kept in this tab. Try the change again.', summary: 'Not saved: Settings', offersBackup: false,
  });
  await settings.persist();
  expect(session.saveState()).toBe('saved');
  expect(seen).toContain('failed');
  expect(seen.at(-1)).toBe('saved');
  await session.close();
});

it('returns undo outcomes to their own callers rather than overwriting a shared message', async () => {
  const state = project();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  await writeProjectState(store, state);
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: shadowOf(state) });
  const refused = session.undoGroup('missing');
  const empty = session.undoLast();
  expect(await refused).toEqual({ kind: 'failed', message: expect.stringContaining('already been undone') });
  expect(await empty).toEqual({ kind: 'empty' });
  await session.close();
});

it('saved waits for an included channel and refuses when that write fails', async () => {
  const state = project();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  await writeProjectState(store, state);
  const channel = new SaveChannel('settings');
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: shadowOf(state), saveChannels: [channel] });
  await session.settle();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const write = channel.enqueue(async () => { await gate; return 'full'; });
  let finished = false;
  const saved = session.saved().then(() => { finished = true; }, (error: unknown) => error);
  await session.persistence.settle();
  expect(session.saveState()).toBe('saving');
  expect(finished).toBe(false);
  release();
  await write;
  expect(await saved).toBeInstanceOf(Error);
  await session.close();
});
