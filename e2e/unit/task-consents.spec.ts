import { expect, test } from '@playwright/test';
import { seededId } from '../../packages/ids/src/index.js';
import { MemoryIndexedDb } from '../../packages/store/src/index.js';
import { openAppDb } from '../../apps/desktop/src/app/app-db.js';
import { TaskConsents } from '../../apps/desktop/src/app/task-consents.js';

test('adding local task allowances preserves version-4 settings and task histories', async () => {
  const factory = new MemoryIndexedDb();
  const projectId = seededId('p', 1);
  const taskId = seededId('t', 1);
  const history = { key: `${projectId}:${taskId}`, projectId, taskId, history: [{ taskId, at: '2026-11-16T08:00:00.000Z', status: 'done', trigger: 'due', summary: 'A scan finished.' }] };
  await new Promise<void>((resolve, reject) => {
    const request = factory.open('caotang-app', 4);
    request.onupgradeneeded = () => {
      for (const name of ['kv', 'editor-history', 'editor-history-meta']) request.result.createObjectStore(name, { keyPath: 'key' });
      for (const name of ['skill-reviews', 'task-runs']) request.result.createObjectStore(name, { keyPath: 'key' }).createIndex('byProject', 'projectId');
    };
    request.onerror = () => reject(request.error ?? new Error('The version-4 database could not be opened.'));
    request.onsuccess = () => {
      const tx = request.result.transaction(['kv', 'task-runs'], 'readwrite');
      tx.objectStore('kv').put({ key: 'settings', value: { theme: 'dark' } });
      tx.objectStore('task-runs').put(history);
      tx.oncomplete = () => { request.result.close(); resolve(); };
      tx.onabort = () => reject(tx.error ?? new Error('The version-4 rows could not be saved.'));
    };
  });
  const upgraded = await openAppDb(factory);
  expect(await upgraded.get('settings')).toEqual({ theme: 'dark' });
  expect(await upgraded.taskRuns?.list(projectId)).toEqual([history]);
  expect(await upgraded.taskConsents?.list(projectId)).toEqual([]);
  const consents = await TaskConsents.open(projectId, upgraded);
  expect(await consents.grant(taskId, 'a'.repeat(64), '2026-11-16T09:00:00.000Z')).toBeNull();
  upgraded.close();
  const reopened = await openAppDb(factory);
  expect((await TaskConsents.open(projectId, reopened)).get(taskId)).toEqual({ hash: 'a'.repeat(64) });
  expect(await reopened.get('settings')).toEqual({ theme: 'dark' });
  expect(await reopened.taskRuns?.list(projectId)).toEqual([history]);
  reopened.close();
});
