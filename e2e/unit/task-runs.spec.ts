import { expect, test } from '@playwright/test';

import { MemoryIndexedDb } from '../../packages/store/src/index.js';
import { RUN_HISTORY_LIMIT, type TaskRunRecord } from '../../packages/tasks/src/index.js';

import { openAppDb } from '../../apps/desktop/src/app/app-db.js';
import { TaskRuns, dropTaskRunsOf } from '../../apps/desktop/src/app/task-runs.js';

/**
 * The run history of recurring tasks in the app database (app-db.ts `task-runs`, task-runs.ts): the version-4 upgrade keeps what an older
 * database held, a history survives a reload, one project's history is not another's, and with no database the history lasts the session.
 */

const PROJECT = 'p_ONE0000001';
const OTHER = 'p_TWO0000001';
const TASK = 't_AAAAAAAAAA';

const run = (n: number, patch: Partial<TaskRunRecord> = {}): TaskRunRecord => ({
  taskId: TASK,
  at: `2026-06-${String(n).padStart(2, '0')}T08:00:00.000Z`,
  status: 'done',
  trigger: 'due',
  summary: `Run ${n}`,
  requests: 2,
  promptTokens: 120,
  completionTokens: 40,
  ...patch,
});

/** A database made by build 3: version 3, the `kv` store and one settings row, none of the stores added since. */
async function versionThree(factory: IDBFactory): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = factory.open('caotang-app', 3);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('kv', { keyPath: 'key' });
      request.result.createObjectStore('editor-history', { keyPath: 'key' });
      request.result.createObjectStore('editor-history-meta', { keyPath: 'key' });
      request.result.createObjectStore('skill-reviews', { keyPath: 'key' }).createIndex('byProject', 'projectId');
    };
    request.onsuccess = () => {
      const tx = request.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ key: 'settings', value: { theme: 'dark' } });
      tx.oncomplete = () => {
        request.result.close();
        resolve();
      };
    };
    request.onerror = () => reject(request.error ?? new Error('could not seed version 3'));
  });
}

test('a version-3 database opens at version 4 with the task-runs store added, and what it held survives', async () => {
  const factory = new MemoryIndexedDb();
  await versionThree(factory);
  const db = await openAppDb(factory);
  expect(await db.get('settings')).toEqual({ theme: 'dark' });
  expect(await db.taskRuns?.list(PROJECT)).toEqual([]);
  db.close();
});

test('a history survives a reload, newest first and bounded, and the last run is the newest record', async () => {
  const factory = new MemoryIndexedDb();
  const first = await openAppDb(factory);
  const runs = await TaskRuns.open(PROJECT, first);
  for (let n = 1; n <= RUN_HISTORY_LIMIT + 3; n += 1) await runs.record(run((n % 27) + 1, { summary: `Run ${n}` }));
  first.close();

  const reopened = await openAppDb(factory);
  const again = await TaskRuns.open(PROJECT, reopened);
  expect(again.history(TASK)).toHaveLength(RUN_HISTORY_LIMIT);
  expect(again.history(TASK)[0]?.summary).toBe(`Run ${RUN_HISTORY_LIMIT + 3}`);
  expect(again.lastRuns()).toEqual({ [TASK]: again.history(TASK)[0]?.at });
  expect(again.failure).toBeNull();
  reopened.close();
});

test('a project reads only its own histories, and removing the project removes its histories and no other', async () => {
  const db = await openAppDb(new MemoryIndexedDb());
  await (await TaskRuns.open(PROJECT, db)).record(run(3));
  await (await TaskRuns.open(OTHER, db)).record(run(4, { taskId: 't_BBBBBBBBBB' }));

  expect(Object.keys((await TaskRuns.open(PROJECT, db)).lastRuns())).toEqual([TASK]);
  await dropTaskRunsOf(PROJECT, db);
  expect((await TaskRuns.open(PROJECT, db)).lastRuns()).toEqual({});
  expect(Object.keys((await TaskRuns.open(OTHER, db)).lastRuns())).toEqual(['t_BBBBBBBBBB']);
  db.close();
});

test('a task that is deleted takes its history with it', async () => {
  const db = await openAppDb(new MemoryIndexedDb());
  const runs = await TaskRuns.open(PROJECT, db);
  await runs.record(run(5));
  await runs.forget(TASK);
  expect(runs.history(TASK)).toEqual([]);
  expect((await TaskRuns.open(PROJECT, db)).history(TASK)).toEqual([]);
  db.close();
});

test('with no app database the history lasts the session and is not read back', async () => {
  const none = TaskRuns.none(PROJECT);
  await none.record(run(6));
  expect(none.history(TASK)).toHaveLength(1);
  expect((await TaskRuns.open(PROJECT, null)).history(TASK)).toEqual([]);
});

test('a database that cannot be read gives no history and says why, and a stand-in without the store behaves as none', async () => {
  const broken = {
    taskRuns: {
      list: () => Promise.reject(new Error('blocked')),
      put: () => Promise.reject(new Error('blocked')),
      delete: () => Promise.reject(new Error('blocked')),
    },
  };
  const runs = await TaskRuns.open(PROJECT, broken);
  expect(runs.failure).toBe('blocked');
  await runs.record(run(7));
  expect(runs.history(TASK)).toHaveLength(1);
  expect(runs.failure).toBe('blocked');
  expect((await TaskRuns.open(PROJECT, {})).history(TASK)).toEqual([]);
});
