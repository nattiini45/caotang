import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { ZIP_ENGINE } from '../packages/store/src/index.js';

import { binderTitle, bodyOf, createProject, FOLDER_ACCESS_ONLY, idOf, projectIdOf, waitForSaved } from './support.js';

/**
 * Two tabs on one project (project-lease.ts, persistence.ts). Two pages of one browser context share the browser's storage, as two
 * tabs do. A second tab cannot open a project the first has open, and a tab whose text the store refuses stops and keeps its words,
 * without writing over the newer text. A stopped tab keeps its words in this browser (unsent-copy.ts), and a reload is asked for twice.
 */

/** A page of the same browser context: it shares the browser's storage with the first, as a second tab does. */
async function secondTab(page: Page): Promise<Page> {
  const other = await page.context().newPage();
  await other.goto('/');
  return other;
}

/** A scene with text in it, in a new chapter of a new project. */
async function projectWithScene(page: Page, name: string, text: string): Promise<void> {
  await createProject(page, name);
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill(text);
  await waitForSaved(page);
}

/**
 * Another writer stores newer text for the scene, at the revision the stale tab holds: the store's own write, as a second writer
 * would make it.
 */
async function storeNewerText(other: Page, projectId: string | null, sceneId: string): Promise<void> {
  await other.evaluate(
    async ([pid, docId]) => {
      const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = idb.open('caotang');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction('documents', 'readwrite');
      const documents = tx.objectStore('documents');
      const row = await new Promise<{ projectId: string; id: string; body: string; revision: number }>((resolve, reject) => {
        const request = documents.get([pid, docId]);
        request.onsuccess = () => resolve(request.result as { projectId: string; id: string; body: string; revision: number });
        request.onerror = () => reject(request.error);
      });
      documents.put({ ...row, body: 'Written in another tab.\n', revision: row.revision + 1 });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    },
    [projectId ?? '', sceneId] as const,
  );
}

test('a project another tab has open is refused, the first tab keeps its words, and the second opens it once the first lets go', async ({
  page,
}) => {
  await projectWithScene(page, 'Two Tabs', 'First tab words.');

  const other = await secondTab(page);
  await other.getByRole('listitem').filter({ hasText: 'Two Tabs' }).getByRole('button', { name: 'Open' }).click();
  await expect(other.getByRole('alert')).toContainText('This project is open in another tab');
  await expect(other.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();

  // The first tab is untouched, and its words are saved.
  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveText('First tab words.');
  await waitForSaved(page);

  // Once the first tab leaves the project, the second can open it, with the saved words.
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();
  await other.getByRole('listitem').filter({ hasText: 'Two Tabs' }).getByRole('button', { name: 'Open' }).click();
  await expect(other.getByRole('heading', { name: 'Two Tabs', level: 1 })).toBeVisible();
  await binderTitle(other, 'The Landing').click();
  await expect(other.getByRole('textbox', { name: 'Document text' })).toHaveText('First tab words.');
});

test('a folder whose project another tab has open is refused as the list refuses it, and no second copy of the book is made', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', FOLDER_ACCESS_ONLY);
  // The folder picker is a directory in the page's own storage, for both tabs (as media-storyboard-folder.spec.ts stands one in).
  await context.addInitScript(() => {
    const host = globalThis as unknown as { showDirectoryPicker: () => Promise<unknown> };
    host.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('two-tabs-folder', { create: true });
  });
  await createProject(page, 'Folder Tabs');
  await page.getByRole('button', { name: 'Save to folder' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved the project to the folder' })).toBeVisible();
  await waitForSaved(page);

  // The second tab opens the same folder while the first still holds its project: the open is refused, with the list's own words.
  const other = await secondTab(page);
  await other.getByRole('button', { name: 'Open a folder…' }).click();
  await expect(other.getByRole('alert')).toContainText('This project is open in another tab');
  await expect(other.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();

  // Nothing was copied: the list holds the one project, and the first tab's words are unchanged.
  await other.reload();
  await expect(other.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();
  await expect(other.locator('.project-row').filter({ hasText: 'Folder Tabs' })).toHaveCount(1);
  await expect(other.getByText('already in this browser')).toHaveCount(0);
});

test('a tab whose text the store refuses stops, keeps its words, and leaves the newer text in the store', async ({ page }) => {
  await projectWithScene(page, 'Stale Tab', 'Saved here first.');
  const projectId = await projectIdOf(page);
  const sceneId = await idOf(page, 'The Landing');
  expect(projectId).not.toBeNull();

  // Another writer stores newer text for the scene, at the revision this tab holds.
  const other = await secondTab(page);
  await storeNewerText(other, projectId, sceneId);

  // This tab types on: its save is refused, and the tab stops.
  await page.getByRole('textbox', { name: 'Document text' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' More from here.');

  const notice = page.getByRole('dialog', { name: 'This project is open in another tab' });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole('button', { name: 'Export a backup' })).toBeVisible();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'conflict');

  // The words typed here are kept in this tab, and the newer text in the store is what the store still holds.
  await expect.poll(async () => (await bodyOf(page, sceneId)) ?? '').toContain('More from here.');

  // The notice's promise: a backup of this tab's words. The bundle carries the text on screen, not the newer text in the store.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    notice.getByRole('button', { name: 'Export a backup' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.caotang$/);
  const { unzipSync } = await ZIP_ENGINE.load();
  const bundle = unzipSync(new Uint8Array(readFileSync((await download.path()) ?? '')));
  const sceneFile = new TextDecoder().decode(bundle[`docs/${sceneId}.md`]);
  expect(sceneFile).toContain('More from here.');
  const stored = await other.evaluate(
    async ([pid, docId]) => {
      const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = idb.open('caotang');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const row = await new Promise<{ body: string }>((resolve, reject) => {
        const request = db.transaction('documents', 'readonly').objectStore('documents').get([pid, docId]);
        request.onsuccess = () => resolve(request.result as { body: string });
        request.onerror = () => reject(request.error);
      });
      db.close();
      return row.body;
    },
    [projectId ?? '', sceneId] as const,
  );
  expect(stored).toBe('Written in another tab.\n');
});

test('a stale tab asks before it reloads, and the question names the words the reload would lose', async ({ page }) => {
  await projectWithScene(page, 'Asked Reload', 'Saved here first.');
  const projectId = await projectIdOf(page);
  const sceneId = await idOf(page, 'The Landing');
  const other = await secondTab(page);
  await storeNewerText(other, projectId, sceneId);

  // This tab types on, and its save is refused.
  await page.getByRole('textbox', { name: 'Document text' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' More from here.');
  const notice = page.getByRole('dialog', { name: 'This project is open in another tab' });
  await expect(notice).toBeVisible();

  // The first request says what a reload would lose, and reloads nothing. Keeping the tab goes back to the notice.
  await notice.getByRole('button', { name: 'Reload this tab' }).click();
  await expect(notice).toContainText('Reloading this tab keeps the words in this browser');
  await notice.getByRole('button', { name: 'Keep this tab' }).click();
  await expect(notice).toContainText('Another tab has stored newer text');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'conflict');

  // Only the second request reloads. The browser's own leave prompt is answered yes, and the page comes back to the projects screen.
  page.once('dialog', (dialog) => void dialog.accept());
  await notice.getByRole('button', { name: 'Reload this tab' }).click();
  await notice.getByRole('button', { name: 'Reload and keep the words here' }).click();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();

  // The reloaded tab carries on from the text the store holds, which is the other tab's.
  await page.getByRole('listitem').filter({ hasText: 'Asked Reload' }).getByRole('button', { name: 'Open' }).click();
  await binderTitle(page, 'The Landing').click();
  await expect(page.getByRole('textbox', { name: 'Document text' })).toContainText('Written in another tab.');
});

test('a project open in another tab is not offered for removal, and the list says where it is', async ({ page }) => {
  await createProject(page, 'Held Here');
  const other = await secondTab(page);

  await other.getByRole('button', { name: 'Remove Held Here from this browser' }).click();
  await expect(other.getByText(/is open in another tab/)).toBeVisible();
  await expect(other.getByRole('dialog')).toHaveCount(0);

  // Once the first tab leaves the project, the second can remove it.
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();
  await other.getByRole('button', { name: 'Remove Held Here from this browser' }).click();
  await other.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(other.getByRole('listitem').filter({ hasText: 'Held Here' })).toHaveCount(0);
});

test('a project this tab has left is removed from the list at once, and is not reported as open in another tab', async ({ page }) => {
  await createProject(page, 'Just Left');
  // The list is opened straight from the project. The close of this tab's session is not held open here, so this checks the list's own
  // answer (no report of another tab), not the wait for that close.
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();

  await page.getByRole('button', { name: 'Remove Just Left from this browser' }).click();
  await expect(page.getByText(/is open in another tab/)).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Just Left' })).toHaveCount(0);
});

test('a store another tab has upgraded stops this tab, and the words typed after the upgrade stay in this tab', async ({ page }) => {
  await projectWithScene(page, 'Upgraded Store', 'Saved here first.');

  // Another tab opens the browser's store at a newer version. The browser closes this tab's connection, as it does when a newer build runs.
  const other = await secondTab(page);
  await other.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB.open('caotang', 4);
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(request.error);
      }),
  );

  await page.getByRole('textbox', { name: 'Document text' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed after the upgrade.');

  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'conflict');
  // The cause is the upgrade, not newer text in another tab: the notice and the save indicator say so, and say what to do.
  const notice = page.getByRole('dialog', { name: 'Caotang was updated in another tab' });
  await expect(notice).toContainText('Caotang was updated in another tab, so this tab cannot save to browser storage.');
  await expect(notice).not.toContainText('Another tab has stored newer text');
  await expect(page.getByTestId('save-state')).toContainText('Caotang was updated in another tab');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toContainText('Typed after the upgrade.');

  // This build cannot reopen the upgraded store: the browser refuses its older version, so a reload of this build is refused the same way.
  // The page says what the writer must do, rather than the browser's own words (store.ts RuntimeStoreNewerError).
  page.once('dialog', (dialog) => void dialog.accept());
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Caotang was updated in another tab, and this tab is still the older version');
});
