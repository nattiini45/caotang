import { expect, test, type Page } from '@playwright/test';

import { binderTitle, createProject, waitForSaved } from './support.js';

/**
 * The writer's undo survives a reload (history-store.ts, editor-engine §7), and `caotang-app` gains its journal stores without losing the
 * records version 1 kept (app-db.ts).
 */

async function chapterWithScene(page: Page, scene: string): Promise<void> {
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(scene);
  await page.keyboard.press('Enter');
}

/** How many transactions the kept undo journal of the open project's documents holds, summed, or 0. */
async function keptEntries(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('caotang-app');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('editor-history')) {
            db.close();
            resolve(0);
            return;
          }
          const all = db.transaction('editor-history', 'readonly').objectStore('editor-history').getAll();
          all.onsuccess = () => {
            db.close();
            const rows = all.result as Array<{ journal: { entries: unknown[] } }>;
            resolve(rows.reduce((sum, row) => sum + row.journal.entries.length, 0));
          };
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

test('undo of the last typing still works after a reload, one burst at a time', async ({ page }) => {
  await createProject(page, 'Undo Book');
  await chapterWithScene(page, 'Opening');
  const surface = page.getByRole('textbox', { name: 'Document text' });
  await surface.click();

  // Two bursts, more than the editor's 500 ms grouping window apart.
  await page.keyboard.type('First burst.');
  await page.waitForTimeout(800);
  await page.keyboard.type(' Second burst.');
  await waitForSaved(page);
  // The journal is written a moment after the typing stops; the reload waits for it.
  await expect.poll(() => keptEntries(page), { timeout: 10_000 }).toBeGreaterThanOrEqual('First burst. Second burst.'.length);

  await page.reload();
  const row = page.getByRole('listitem').filter({ hasText: 'Undo Book' });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Open' }).click();
  await binderTitle(page, 'Opening').click();
  await expect(surface).toContainText('First burst. Second burst.');

  await surface.click();
  await page.keyboard.press('Control+z');
  await expect(surface).toHaveText('First burst.');
  await page.keyboard.press('Control+z');
  await expect(surface).toHaveText('');
  await waitForSaved(page);
});

test('caotang-app is upgraded from version 1 with the journal, skill review and task run stores, and the records version 1 kept survive', async ({ page }) => {
  // A static file of the app's origin, so IndexedDB is the app's own and the app has not opened its database yet.
  await page.goto('/tsconfig.json');
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const gone = indexedDB.deleteDatabase('caotang-app');
        gone.onerror = () => reject(gone.error);
        gone.onsuccess = () => {
          const request = indexedDB.open('caotang-app', 1);
          request.onupgradeneeded = () => {
            const store = request.result.createObjectStore('kv', { keyPath: 'key' });
            store.put({ key: 'version-one-row', value: { kept: true } });
          };
          request.onsuccess = () => {
            request.result.close();
            resolve();
          };
          request.onerror = () => reject(request.error);
        };
      }),
  );

  await createProject(page, 'Upgrade Book');

  const after = await page.evaluate(
    () =>
      new Promise<{ version: number; stores: string[]; row: unknown }>((resolve, reject) => {
        const request = indexedDB.open('caotang-app');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const row = db.transaction('kv', 'readonly').objectStore('kv').get('version-one-row');
          row.onsuccess = () => {
            const seen = { version: db.version, stores: [...db.objectStoreNames].sort(), row: row.result as unknown };
            db.close();
            resolve(seen);
          };
          row.onerror = () => reject(row.error);
        };
      }),
  );
  // Version 3 added the writer's skill reviews (app-db.ts); the upgrade adds a store and touches none of the others.
  expect(after.version).toBe(4);
  expect(after.stores).toEqual(['editor-history', 'editor-history-meta', 'kv', 'skill-reviews', 'task-runs']);
  expect(after.row).toEqual({ key: 'version-one-row', value: { kept: true } });
});
