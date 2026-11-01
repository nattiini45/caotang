/**
 * A card's picture on the corkboard (pictures.md §5). The card picture is the `card` placement of a binder item: a picture dragged on
 * from the desktop is imported and placed, one dragged from the board is placed, and the keyboard reaches the same through the card's
 * menu. Medium and large cards show it, small cards do not. Every change is a bus command, so each one is undone with the Activity row.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { asSent, BLUE, RED, registry, send, undoLatest } from './pictures-support.js';
import { binderTitle, card, countOf, createProject, firstChapter, waitForSaved } from './support.js';

const PICTURE_TYPE = 'application/x-caotang-picture';

async function openCorkboard(page: Page): Promise<void> {
  await page.getByRole('radio', { name: 'Corkboard', exact: true }).click();
  await expect(page.locator('.corkboard')).toBeVisible();
}

/** A card made on the open corkboard, named as the writer names it. */
async function addCard(page: Page, title: string): Promise<Locator> {
  await page.locator('.corkboard-head').getByRole('button', { name: 'New card' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(title);
  await page.keyboard.press('Enter');
  const made = card(page, title);
  await expect(made).toBeVisible();
  return made;
}

/** A card named "Scene A" in the new chapter, whose board is open: a chapter selected in the binder shows its own children. */
async function sceneCard(page: Page): Promise<Locator> {
  await firstChapter(page);
  await openCorkboard(page);
  return addCard(page, 'Scene A');
}

/** The corkboard of the chapter again, after a reload: the chapter is selected in the binder first. */
async function backToChapter(page: Page): Promise<Locator> {
  await binderTitle(page, 'Chapter 1').click();
  await openCorkboard(page);
  return card(page, 'Scene A');
}

/** A drag of a picture the project holds, as the board's tile carries it, dropped on the element. */
async function dropPicture(target: Locator, assetId: string): Promise<{ cancelled: boolean }> {
  return target.evaluate(
    (element, input) => {
      const data = new DataTransfer();
      data.setData(input.type, input.assetId);
      element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
      return { cancelled: !element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })) };
    },
    { type: PICTURE_TYPE, assetId },
  );
}

async function reopen(page: Page, project: string): Promise<void> {
  await waitForSaved(page);
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: project }).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

test('files dropped on a card are imported and the first is its picture, shown on medium and large cards and not on small ones, and the tab does not open the file', async ({ page }) => {
  await createProject(page, 'Cork Book');
  const chapter = await sceneCard(page);
  await expect(chapter.locator('img.card-picture')).toHaveCount(0);

  const { cancelled } = await send(chapter, 'drop', [asSent(RED)]);
  expect(cancelled).toBe(true);
  await expect(chapter.locator('img.card-picture')).toBeVisible();
  expect(await countOf(page, 'asset.importBatch')).toBe(1);
  const links = (await registry(page)).links;
  expect(links).toHaveLength(1);
  expect(links[0]?.role).toBe('card');

  await page.getByRole('radio', { name: /^L:/ }).click();
  await expect(chapter.locator('img.card-picture')).toBeVisible();
  await page.getByRole('radio', { name: /^S:/ }).click();
  await expect(chapter.locator('img.card-picture')).toHaveCount(0);
  await page.getByRole('radio', { name: /^M:/ }).click();
  await expect(chapter.locator('img.card-picture')).toBeVisible();

  await reopen(page, 'Cork Book');
  await expect(await backToChapter(page)).toBeVisible();
  await expect(card(page, 'Scene A').locator('img.card-picture')).toBeVisible();
});

test('a picture from the board dropped on a card is its card picture, the earlier one stays on the item as a reference, and one Undo puts it back', async ({ page }) => {
  await createProject(page, 'Swap Book');
  const chapter = await sceneCard(page);
  await send(chapter, 'drop', [asSent(RED)]);
  await expect(chapter.locator('img.card-picture')).toBeVisible();

  const first = (await registry(page)).links[0]?.assetId;
  await page.getByRole('radio', { name: 'Pictures', exact: true }).click();
  await page.getByTestId('pictures-file-input').setInputFiles([BLUE]);
  await expect(page.locator('.pb-tile')).toHaveCount(2);
  const blue = (await registry(page)).records.find((record) => record.id !== first);
  expect(blue).toBeDefined();
  await openCorkboard(page);

  const before = await chapter.locator('img.card-picture').getAttribute('src');
  const { cancelled } = await dropPicture(chapter, blue?.id ?? '');
  expect(cancelled).toBe(true);
  await expect.poll(async () => (await registry(page)).links.find((link) => link.role === 'card')?.assetId).toBe(blue?.id);
  await expect(chapter.locator('img.card-picture')).toBeVisible();
  expect(await chapter.locator('img.card-picture').getAttribute('src')).not.toBe(before);
  const afterLinks = (await registry(page)).links;
  expect(afterLinks).toHaveLength(2);
  expect(afterLinks.filter((link) => link.role === 'card')).toHaveLength(1);
  expect(afterLinks.filter((link) => link.role === 'reference')).toHaveLength(1);

  await undoLatest(page);
  await expect.poll(async () => (await registry(page)).links.find((link) => link.role === 'card')?.assetId).not.toBe(blue?.id);
});

test('the card menu gives the keyboard the same: it opens a dialog to choose a picture the project holds or a file, and Undo takes the card picture back', async ({ page }) => {
  await createProject(page, 'Keys Book');
  await firstChapter(page);
  await page.getByRole('radio', { name: 'Pictures', exact: true }).click();
  await page.getByTestId('pictures-file-input').setInputFiles([RED]);
  await expect(page.locator('.pb-tile')).toHaveCount(1);
  await openCorkboard(page);
  const chapter = await addCard(page, 'Scene A');
  await chapter.focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menu', { name: 'Actions for Scene A' }).getByRole('menuitem', { name: 'Card picture…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Card picture for Scene A' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('A picture the project holds').selectOption({ index: 1 });
  await dialog.getByRole('button', { name: 'Use as card picture' }).click();
  await expect(dialog).toBeHidden();
  await expect(chapter.locator('img.card-picture')).toBeVisible();
  await expect(chapter).toBeFocused();
  expect((await registry(page)).links.map((link) => link.role)).toEqual(['card']);

  await undoLatest(page);
  await expect(chapter.locator('img.card-picture')).toHaveCount(0);
  expect((await registry(page)).links.map((link) => link.role)).toEqual([]);

  await chapter.focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menu', { name: 'Actions for Scene A' }).getByRole('menuitem', { name: 'Card picture…' }).click();
  await page.getByRole('dialog', { name: 'Card picture for Scene A' }).getByTestId('card-picture-input').setInputFiles([BLUE]);
  await expect(chapter.locator('img.card-picture')).toBeVisible();
  await expect.poll(async () => (await registry(page)).links.filter((link) => link.role === 'card').length).toBe(1);

  await chapter.focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menu', { name: 'Actions for Scene A' }).getByRole('menuitem', { name: 'Card picture…' }).click();
  await page.getByRole('dialog', { name: 'Card picture for Scene A' }).getByRole('button', { name: 'Take the card picture off' }).click();
  await expect(chapter.locator('img.card-picture')).toHaveCount(0);
  expect(await countOf(page, 'asset.unlink')).toBe(1);
});

test('a card whose picture file is gone shows it as missing, and the placement is kept', async ({ page }) => {
  await createProject(page, 'Gone Book');
  const chapter = await sceneCard(page);
  await send(chapter, 'drop', [asSent(RED)]);
  await expect(chapter.locator('img.card-picture')).toBeVisible();
  await waitForSaved(page);

  await page.reload();
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('caotang-assets');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('assets', 'readwrite');
          tx.objectStore('assets').clear();
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await page.getByRole('listitem').filter({ hasText: 'Gone Book' }).getByRole('button', { name: 'Open' }).click();
  await backToChapter(page);
  await expect(card(page, 'Scene A').locator('.card-picture-missing')).toBeVisible();
  await expect(card(page, 'Scene A').locator('img.card-picture')).toHaveCount(0);
  expect((await registry(page)).links.map((link) => link.role)).toEqual(['card']);
});

test('in a right-to-left interface the card still shows its dropped picture', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('caotang.pseudo', '1'));
  await createProject(page, 'RTL Cork');
  await sceneCard(page);
  await page.getByTestId('open-settings').focus();
  await page.keyboard.press('Enter');
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="appearance"]').click();
  await settings.locator('input[name="interface-language"][value="ar-XB"]').click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dir)).toBe('rtl');
  await settings.locator('.settings-head button').click();

  const chapter = page.locator('article.card').first();
  await expect(chapter).toBeVisible();
  const { cancelled } = await send(chapter, 'drop', [asSent(RED)]);
  expect(cancelled).toBe(true);
  await expect(chapter.locator('img.card-picture')).toBeVisible();
  const box = await chapter.boundingBox();
  const image = await chapter.locator('img.card-picture').boundingBox();
  expect((image?.x ?? -1) >= (box?.x ?? 0) - 1 && (image?.x ?? 0) + (image?.width ?? 0) <= (box?.x ?? 0) + (box?.width ?? 0) + 1).toBe(true);
});
