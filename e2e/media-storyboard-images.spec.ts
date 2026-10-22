/**
 * The image of a shot, in the app (storyboard.md §3.1–3.2). A picture is chosen from the desktop, dropped or pasted onto a card,
 * looked at larger in the lightbox, and kept across a reload with no folder attached. An image whose file has gone is dropped as the
 * project opens, with a notice. The tests drive the gestures and read the result through the activity log and the card.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { binderTitle, createProject, firstChapter, trace, waitForSaved } from './support.js';

const PROJECT = 'Picture Book';
/** A 1×1 PNG, the smallest picture the store will take. */
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

/** Reloads the page and opens the project from the projects list, as a writer does after a restart. */
async function reopen(page: Page): Promise<void> {
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: PROJECT }).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

/** A storyboard with one shot, whose fields are open in the editor. */
async function storyboardWithShot(page: Page): Promise<Locator> {
  await createProject(page, PROJECT);
  await makeUnder(page, 'Manuscript', 'New storyboard here');
  await makeUnder(page, 'Storyboard', 'New shot here');
  await page.getByRole('article', { name: 'Shot 1: New shot' }).getByRole('button', { name: 'Edit the fields of shot 1' }).click();
  return page.getByRole('article', { name: 'Shot 1: New shot' });
}

/** Drops a picture onto an element, as a file dragged from the desktop would be. */
async function dropPicture(target: Locator, name: string, bytes: Buffer): Promise<void> {
  await target.evaluate(
    (element, file) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(file.bytes)], file.name, { type: 'image/png' }));
      element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    },
    { name, bytes: [...bytes] },
  );
}

test('a picture chosen from the desktop shows on its card, and is still there after a reload with no folder attached', async ({ page }) => {
  const card = await storyboardWithShot(page);
  await page.getByLabel('Choose an image file for shot 1').setInputFiles({ name: 'frame.png', mimeType: 'image/png', buffer: PNG });

  await expect(card.locator('img')).toBeVisible();
  expect((await trace(page)).some((row) => row.command === 'shot.importImage')).toBe(true);

  await reopen(page);
  await binderTitle(page, 'Storyboard').click();
  await expect(page.getByRole('article', { name: 'Shot 1: New shot' }).locator('img')).toBeVisible();
});

test('a picture dropped on a card is its image, and the lightbox shows it larger until Escape closes it', async ({ page }) => {
  const card = await storyboardWithShot(page);
  await dropPicture(card.locator('figure.sb-frame'), 'frame.png', PNG);
  await expect(card.locator('img')).toBeVisible();

  await card.getByRole('button', { name: 'Look at the image of shot 1 larger' }).click();
  const lightbox = page.getByRole('dialog', { name: 'Image of New shot' });
  await expect(lightbox).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);
});

test('a file dropped on a card outside its picture slot is the card’s picture, and the tab does not open the file', async ({ page }) => {
  const card = await storyboardWithShot(page);
  // The drop's default action is to open the file in this tab, so a drop the card does not cancel would replace the app.
  const cancelled = await card.locator('.card-head').evaluate(
    (element, file) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(file.bytes)], file.name, { type: 'image/png' }));
      element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
      return !element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    },
    { name: 'frame.png', bytes: [...PNG] },
  );
  expect(cancelled).toBe(true);
  await expect(card.locator('img')).toBeVisible();
});

test('a picture pasted while a card is selected is its image', async ({ page }) => {
  const card = await storyboardWithShot(page);
  await card.focus();
  await card.evaluate((element, file) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(file.bytes)], file.name, { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, { name: 'pasted.png', bytes: [...PNG] });
  await expect(card.locator('img')).toBeVisible();
});

test('an image whose file is no longer in the project is dropped when the project opens, with a notice, and not named again after that', async ({ page }) => {
  const card = await storyboardWithShot(page);
  await page.getByLabel('Choose an image file for shot 1').setInputFiles({ name: 'frame.png', mimeType: 'image/png', buffer: PNG });
  await expect(card.locator('img')).toBeVisible();
  await waitForSaved(page);

  // Remove the files from the browser's copy, as a cleared site-data store would.
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('caotang-assets');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('assets', 'readwrite');
      tx.objectStore('assets').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
  });

  // The check ran as the project opened from the list: the open says so before the storyboard is ever opened.
  await reopen(page);
  await expect(page.getByText('A shot lost its picture because the file is not in the project.')).toBeVisible();
  await binderTitle(page, 'Storyboard').click();
  await expect(page.getByRole('status').filter({ hasText: 'An image was dropped when the project opened' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Shot 1: New shot' }).locator('img')).toHaveCount(0);

  // The drop is saved with the project, so the next open has nothing left to drop and no notice.
  await reopen(page);
  await expect(page.getByText('lost its picture')).toHaveCount(0);
  await binderTitle(page, 'Storyboard').click();
  await expect(page.getByText('An image was dropped when the project opened')).toHaveCount(0);
});
