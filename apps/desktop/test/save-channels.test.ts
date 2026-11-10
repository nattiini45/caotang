import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryIndexedDb, openRuntimeStore, writeProjectState } from '@caotang/store';

import { ProjectSession } from '../src/app/session.js';
import { shadowOf } from '../src/app/persistence-plan.js';
import { openTasksHome } from '../src/app/tasks-io.js';
import { project } from '../../../e2e/unit/fixtures.js';
import { SettingsStore } from '../src/app/services.js';
import { DEFAULT_SETTINGS } from '../src/app/settings.js';
import type { AppDb } from '../src/app/app-db.js';
import { activateEnglish } from '../src/i18n/runtime.js';
import { saveStateWords } from '../src/app/integrity-model.js';

beforeEach(() => {
  activateEnglish();
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());

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
    text: 'Not saved: Settings. Your changes are kept in this tab. Try the change again.', offersBackup: false,
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
