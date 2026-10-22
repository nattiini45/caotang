import { expect, test } from '@playwright/test';

import { MemoryIndexedDb } from '../../packages/store/src/index.js';
import { APP_KEYS, openAppDb } from '../../apps/desktop/src/app/app-db.js';

/** The `kv` store's two calls the background tasks need (app-db.ts): list by key prefix, and delete. */

test('list returns the records under a prefix in key order, and nothing else', async () => {
  const db = await openAppDb(new MemoryIndexedDb());
  await db.put('task:p1:b', { n: 2 });
  await db.put('task:p1:a', { n: 1 });
  await db.put('task:p10:a', { n: 3 });
  await db.put(APP_KEYS.settings, { theme: 'dark' });

  const rows = await db.list<{ n: number }>('task:p1:');

  expect(rows.map((row) => row.key)).toEqual(['task:p1:a', 'task:p1:b']);
  expect(rows.map((row) => row.value.n)).toEqual([1, 2]);
  expect(await db.list('task:none:')).toEqual([]);
});

test('delete removes one record, leaves its neighbours, and accepts a key that is not there', async () => {
  const db = await openAppDb(new MemoryIndexedDb());
  await db.put('task:p1:a', 1);
  await db.put('task:p1:b', 2);

  await db.delete('task:p1:a');
  await db.delete('task:p1:missing');

  expect((await db.list('task:p1:')).map((row) => row.key)).toEqual(['task:p1:b']);
  expect(await db.get('task:p1:a')).toBeUndefined();
});
