/**
 * The per-project home of `tasks.json` (agent-harness.md §12): the runtime store keeps the file's artifact set on the project row, the
 * manifest writes leave it alone, and the zip bundle carries the live file at its root. Beside coherence-home.test.ts, which it mirrors.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  addDocument,
  createEmptyManifest,
  createProjectState,
  exportProjectZip,
  importProjectZip,
  readCoherenceFiles,
  readTaskFiles,
  writeCoherenceFiles,
  writeTaskFiles,
  type ProjectState,
  type RuntimeStore,
} from '../src/index.js';
import { MemoryIndexedDb } from '../src/runtime/memory-idb.js';
import { ProjectNotFoundError, commitProject, openRuntimeStore, writeProjectState } from '../src/runtime/store.js';

const OPENED = new Date('2026-10-01T02:00:00.000Z');
const LATER = new Date('2026-10-02T02:00:00.000Z');
const DB = 'caotang-tasks-home';
const PROJECT = 'p_9XK2M4Q7RZ';

const TASKS_JSON = '{\n  "formatVersion": 1,\n  "tasks": []\n}\n';
const BAK_ONE = '{\n  "formatVersion": 1,\n  "tasks": [{ "id": "t_AAAAAAAAAA" }]\n}\n';

function fixtureProject(): ProjectState {
  const manifest = createEmptyManifest('The Lighthouse Keeper', OPENED);
  manifest.project.id = PROJECT;
  const state = createProjectState(manifest);
  addDocument(state, { parentId: 'manuscript', title: 'The Landing', body: 'The ferry was late.', now: OPENED, id: 'n_7K2QX9M4A1' });
  return state;
}

const opened: RuntimeStore[] = [];

async function openStore(factory: MemoryIndexedDb): Promise<RuntimeStore> {
  const store = await openRuntimeStore(factory, DB);
  opened.push(store);
  return store;
}

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

describe('the tasks file on the project row (agent-harness.md §12)', () => {
  it('reads as no set for a project with no tasks, and refuses a project the store does not hold', async () => {
    const store = await openStore(new MemoryIndexedDb());
    await expect(readTaskFiles(store, PROJECT)).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(writeTaskFiles(store, PROJECT, {})).rejects.toBeInstanceOf(ProjectNotFoundError);
    await commitProject(store, { projectId: PROJECT, manifest: fixtureProject().manifest, now: OPENED });
    expect(await readTaskFiles(store, PROJECT)).toEqual({});
  });

  it('writes the whole set and a later write replaces it rather than adding to it', async () => {
    const store = await openStore(new MemoryIndexedDb());
    await writeProjectState(store, fixtureProject(), { now: OPENED });
    await writeTaskFiles(store, PROJECT, { 'tasks.json': TASKS_JSON, 'tasks.json.bak.1': BAK_ONE });
    expect(await readTaskFiles(store, PROJECT)).toEqual({ 'tasks.json': TASKS_JSON, 'tasks.json.bak.1': BAK_ONE });
    await writeTaskFiles(store, PROJECT, { 'tasks.json': BAK_ONE });
    expect(await readTaskFiles(store, PROJECT)).toEqual({ 'tasks.json': BAK_ONE });
  });

  it('keeps the set across a structural commit, a wholesale write and a reopen of the database', async () => {
    const factory = new MemoryIndexedDb();
    const store = await openStore(factory);
    const state = fixtureProject();
    await writeProjectState(store, state, { now: OPENED });
    await writeTaskFiles(store, PROJECT, { 'tasks.json': TASKS_JSON });

    await commitProject(store, { projectId: PROJECT, manifest: state.manifest, now: LATER });
    expect(await readTaskFiles(store, PROJECT)).toEqual({ 'tasks.json': TASKS_JSON });

    await writeProjectState(store, state, { now: LATER });
    expect(await readTaskFiles(store, PROJECT)).toEqual({ 'tasks.json': TASKS_JSON });

    store.close();
    opened.splice(opened.indexOf(store), 1);
    expect(await readTaskFiles(await openStore(factory), PROJECT)).toEqual({ 'tasks.json': TASKS_JSON });
  });

  it('is a set of its own: writing it leaves the findings set alone, and writing that leaves this one alone', async () => {
    const store = await openStore(new MemoryIndexedDb());
    await writeProjectState(store, fixtureProject(), { now: OPENED });
    await writeCoherenceFiles(store, PROJECT, { 'coherence.json': '{}' });
    await writeTaskFiles(store, PROJECT, { 'tasks.json': TASKS_JSON });
    expect(await readCoherenceFiles(store, PROJECT)).toEqual({ 'coherence.json': '{}' });
    await writeCoherenceFiles(store, PROJECT, {});
    expect(await readTaskFiles(store, PROJECT)).toEqual({ 'tasks.json': TASKS_JSON });
  });
});

describe('the zip bundle carries tasks.json (agent-harness.md §12)', () => {
  it('writes the live file at the bundle root, byte for byte, and imports it back', async () => {
    const exported = await exportProjectZip(fixtureProject(), { now: OPENED, tasks: TASKS_JSON });
    expect(exported.entries).toContain('tasks.json');
    expect(await (await importProjectZip(exported.bytes)).fs.read('tasks.json')).toBe(TASKS_JSON);
  });

  it('carries no tasks file when the project has none, and not the recovery generations', async () => {
    const none = await exportProjectZip(fixtureProject(), { now: OPENED });
    expect(none.entries).not.toContain('tasks.json');
    const some = await exportProjectZip(fixtureProject(), { now: OPENED, tasks: TASKS_JSON });
    expect(some.entries.some((entry) => entry.startsWith('tasks.json.bak.'))).toBe(false);
  });
});
