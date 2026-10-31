import { expect, test } from '@playwright/test';

import { MemoryIndexedDb, openRuntimeStore, writeProjectState, type RuntimeStore } from '../../packages/store/src/index.js';
import { seededId } from '../../packages/ids/src/index.js';
import { TASKS_FILE, type AgentTask, type TasksFile } from '../../packages/tasks/src/index.js';

import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';
import { openTasksHome } from '../../apps/desktop/src/app/tasks-io.js';
import { filesIn, memoryFolder, textOf } from './memory-folder.js';

/**
 * A project's tasks.json in the browser store and in an open project folder (tasks-io.ts): a save is written to both, a folder file that
 * another program changed is not replaced while the browser keeps the tasks, a folder attached later receives the file once, and a
 * project with no tasks writes no file into the folder.
 */

const STATE = sampleProjectState();
const PROJECT = STATE.manifest.project.id;

/** A runtime store that holds the project, which a save needs: the tasks file sits under the project's row. */
async function storeWithProject(): Promise<RuntimeStore> {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  await writeProjectState(store, STATE, { now: new Date() });
  return store;
}

const TASK: AgentTask = {
  id: seededId('t', 1),
  name: 'Friday check',
  enabled: true,
  schedule: { kind: 'weekly', at: '17:00', day: 'fri' },
  whenDue: 'offer',
  body: { kind: 'scan', scope: 'full' },
  permission: 'ask',
};

const withTask = (): TasksFile => ({ formatVersion: 1, tasks: [TASK] });
const empty = (): TasksFile => ({ formatVersion: 1, tasks: [] });

const storedNames = async (store: RuntimeStore): Promise<string[]> => (await openTasksHome(PROJECT, store)).current().tasks.map((task) => task.name);

const folderTasks = (files: Map<string, Uint8Array>): { tasks: Array<{ name: string }> } => JSON.parse(textOf(files.get(TASKS_FILE)));

test.describe('a save with a folder open', () => {
  test('is written to the folder and to the browser store', async () => {
    const store = await storeWithProject();
    const { handle, tree } = memoryFolder();
    const home = await openTasksHome(PROJECT, store, handle);

    expect(await home.save(withTask())).toBeNull();
    expect(home.status().saveFailure).toBeNull();
    expect(folderTasks(filesIn(tree)).tasks.map((task) => task.name)).toEqual(['Friday check']);
    expect(await storedNames(store)).toEqual(['Friday check']);
  });

  test('does not replace a tasks.json another program changed, says so, and still saves in the browser', async () => {
    const store = await storeWithProject();
    const { handle, tree } = memoryFolder();
    const home = await openTasksHome(PROJECT, store, handle);
    expect(await home.save(withTask())).toBeNull();

    const other = '{"formatVersion":1,"tasks":[],"note":"written by another program"}';
    tree.children.set(TASKS_FILE, { kind: 'file', bytes: new TextEncoder().encode(other) });
    const failure = await home.save({ formatVersion: 1, tasks: [{ ...TASK, name: 'Monday check' }] });

    expect(failure).toContain('changed by another program');
    expect(home.status().saveFailure).toBe(failure);
    expect(textOf(filesIn(tree).get(TASKS_FILE))).toBe(other);
    expect(await storedNames(store)).toEqual(['Monday check']);
  });
});

test.describe('a folder attached after the project opened', () => {
  test('receives the file when there are tasks, and nothing when there are none', async () => {
    const store = await storeWithProject();
    const home = await openTasksHome(PROJECT, store, null);

    const none = memoryFolder();
    await home.attachFolder(none.handle);
    expect(filesIn(none.tree).size).toBe(0);

    expect(await home.save(withTask())).toBeNull();
    const some = memoryFolder();
    await home.attachFolder(some.handle);
    expect(folderTasks(filesIn(some.tree)).tasks.map((task) => task.name)).toEqual(['Friday check']);
    expect(home.status().saveFailure).toBeNull();
  });

  test('does not replace the folder’s own tasks.json with an empty list', async () => {
    const store = await storeWithProject();
    const home = await openTasksHome(PROJECT, store, null);
    const { handle, tree } = memoryFolder();
    const own = JSON.stringify({ formatVersion: 1, tasks: [{ ...TASK, name: 'Kept in the folder' }] });
    tree.children.set(TASKS_FILE, { kind: 'file', bytes: new TextEncoder().encode(own) });

    await home.attachFolder(handle);
    expect(textOf(filesIn(tree).get(TASKS_FILE))).toBe(own);
    expect([...filesIn(tree).keys()]).toEqual([TASKS_FILE]);
  });

  test('is a no-op the second time it is attached: the file is not written again', async () => {
    const store = await storeWithProject();
    const home = await openTasksHome(PROJECT, store, null);
    expect(await home.save(withTask())).toBeNull();
    const { handle, tree } = memoryFolder();

    await home.attachFolder(handle);
    const first = filesIn(tree);
    await home.attachFolder(handle);
    const second = filesIn(tree);
    expect([...second.keys()]).toEqual([...first.keys()]);
    expect(textOf(second.get(TASKS_FILE))).toBe(textOf(first.get(TASKS_FILE)));
    expect(second.has(`${TASKS_FILE}.bak.1`)).toBe(false);
    expect(home.status().saveFailure).toBeNull();
  });
});

test('text() is undefined for a project with no tasks, and the file as it is written otherwise', async () => {
  const store = await storeWithProject();
  const home = await openTasksHome(PROJECT, store, null);
  expect(home.text()).toBeUndefined();
  expect(await home.save(withTask())).toBeNull();
  expect(JSON.parse(home.text() ?? '{}').tasks[0].name).toBe('Friday check');
  expect(await home.save(empty())).toBeNull();
  expect(home.text()).toBeUndefined();
});
