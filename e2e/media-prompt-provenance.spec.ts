/**
 * The codex's visual references reach the prompt pack, in the app (video-prompt-pack.md §3). A shot whose action names a codex
 * entry sends that entry's reference image, and the Prompt pack tab says which entry it came from.
 *
 * The app has no control that sets an entry's visual references yet (the `codex.write` command does not carry them), so the test
 * sets them the way the stored project holds them: on the entry in the browser's copy of the manifest, then reloads.
 */

import { expect, test, type Page } from '@playwright/test';

import { binderTitle, createProject, firstChapter, projectIdOf, waitForSaved, loose } from './support.js';

const PROJECT = 'Provenance Reel';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** Makes a node from the context menu of the row it goes under, and keeps its default title. */
async function makeUnder(page: Page, under: string, item: string): Promise<void> {
  // The media entries are on chapters, so "under the manuscript" is its first chapter, made when there is none.
  const parent = under === 'Manuscript' ? await firstChapter(page) : under;
  await binderTitle(page, parent).click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${parent}` }).getByRole('menuitem', { name: item }).click();
  await page.keyboard.press('Escape');
}

/** Reloads the page and opens the project from the projects list. */
async function reopen(page: Page): Promise<void> {
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: PROJECT }).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

test('a codex entry’s visual reference is sent with the shot that names the entry, and the pack says where it came from', async ({ page }) => {
  await createProject(page, PROJECT);

  // A shot that names the entry in its action, with a picture of its own.
  await makeUnder(page, 'Manuscript', 'New storyboard here');
  await makeUnder(page, 'Storyboard', 'New shot here');
  await page.getByRole('article', { name: 'Shot 1: New shot' }).getByRole('button', { name: 'Edit the fields of shot 1' }).click();
  await page.getByLabel('Action', { exact: true }).fill('Elena walks down the quay.');
  await page.getByRole('button', { name: 'Save shot' }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await page.getByLabel('Choose an image file for shot 1').setInputFiles({ name: 'elena.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('article', { name: 'Shot 1: New shot' }).locator('img')).toBeVisible();

  // The codex entry the action names.
  await page.getByRole('tab', { name: 'Codex' }).click();
  await page.getByRole('button', { name: 'New entry' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Elena');
  await page.getByRole('tab', { name: 'Binder' }).click();
  await waitForSaved(page);

  // Give the entry its description and its visual reference, as the stored project holds them, then reload.
  const projectId = await projectIdOf(page);
  if (projectId === null) throw new Error('no project is open');
  await page.evaluate(async (id) => {
    const open = (name: string) =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const images = await open('caotang-assets');
    const paths = await new Promise<string[]>((resolve, reject) => {
      const tx = images.transaction('assets', 'readonly');
      const request = tx.objectStore('assets').index('byProject').getAll(id);
      request.onsuccess = () => resolve((request.result as { path: string }[]).map((row) => row.path));
      request.onerror = () => reject(request.error);
    });
    images.close();
    const assetId = paths[0]?.replace(/^assets\//, '').replace(/\.png$/, '');
    if (assetId === undefined) throw new Error('the picture is not in the browser’s copy');

    const runtime = await open('caotang');
    await new Promise<void>((resolve, reject) => {
      const tx = runtime.transaction('projects', 'readwrite');
      const store = tx.objectStore('projects');
      const read = store.get(id);
      read.onsuccess = () => {
        const row = read.result as { manifest: { codex: Record<string, unknown>[] } };
        const entry = row.manifest.codex[0];
        if (entry === undefined) throw new Error('the codex entry is not in the project');
        entry.description = 'A cartographer who maps the harbour.';
        entry.visualRefs = [assetId];
        store.put(row);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    runtime.close();
  }, projectId);

  await reopen(page);
  await binderTitle(page, 'Storyboard').click();
  await page.getByRole('article', { name: 'Shot 1: New shot' }).getByRole('button', { name: 'Edit the fields of shot 1' }).click();
  // A prompt for the target model, so the shot has a row in the pack.
  await page.getByLabel('Prompt: camera').fill('Slow dolly-in');
  await page.getByRole('button', { name: 'Save prompt' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved the prompt for' })).toBeVisible();

  await page.getByRole('radio', { name: 'Prompt pack', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Consistency of shot 1' })).toContainText(loose('Elena: mentioned in the action, sends 1 reference'));
  // The file the pack names is the stored image, so the reference is the picture the shot was given.
  await expect(page.locator('li.pp-shot')).toContainText(/Attach a_[0-9A-HJKMNP-TV-Z]{10}\.png/);
});
