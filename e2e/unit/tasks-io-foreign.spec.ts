import { expect, test } from '@playwright/test';

import { MemoryIndexedDb, openRuntimeStore } from '../../packages/store/src/index.js';

import { openTasksHome } from '../../apps/desktop/src/app/tasks-io.js';
import { filesIn, memoryFolder, textOf } from './memory-folder.js';

/**
 * A project folder that holds a tasks.json some other program wrote (project-format §1, agent-harness §12): opening it shows a notice
 * and no tasks, saves nothing to it, and leaves the file as it was, with no kept copy beside it.
 */

const FOREIGN = '{"tasks":[{"title":"buy milk"}]}';

test('opening a folder with a tasks.json that is not ours leaves it byte for byte as it was, and says so', async () => {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const { handle, tree } = memoryFolder();
  const file = await handle.getFileHandle('tasks.json', { create: true });
  const writable = await file.createWritable();
  await writable.write(FOREIGN);
  await writable.close();

  const home = await openTasksHome('p_TESTPROJ01', store, handle);
  const status = home.status();
  expect(status.writable).toBe(false);
  expect(home.current().tasks).toEqual([]);
  expect(status.notices.join(' ')).toContain('not a Caotang tasks file');

  expect(await home.save({ formatVersion: 1, tasks: [] })).toContain('cannot be saved here');
  const files = filesIn(tree);
  expect([...files.keys()]).toEqual(['tasks.json']);
  expect(textOf(files.get('tasks.json'))).toBe(FOREIGN);
});
