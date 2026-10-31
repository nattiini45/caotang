import { expect, test, type Page } from '@playwright/test';

import { RED } from './pictures-support.js';
import { bodyOf, binderTitle, createProject, idOf, waitForSaved } from './support.js';

/**
 * Pictures inside a scene (pictures.md §2.2, editor-engine §3.4): the toolbar and the slash menu bring a file into the project and
 * write `![alt](../assets/…)` into the text, the picture shows from the project's own store, one undo takes an inserted picture
 * back, and a picture whose file is gone says so instead of failing.
 */

async function chapterWithScene(page: Page, scene: string): Promise<void> {
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(scene);
  await page.keyboard.press('Enter');
}

/** ProseMirror keeps empty img.ProseMirror-separator hacks beside an inline picture; they are not pictures. */
const PICTURE_IMG = 'img:not(.ProseMirror-separator)';

const surfaceOf = (page: Page) => page.getByRole('textbox', { name: 'Document text' });

/** Presses the control that opens the chooser and answers it with the files (none for a cancelled chooser). */
async function answerChooser(page: Page, open: () => Promise<void>, files: readonly (typeof RED)[]): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await open();
  await (await chooser).setFiles([...files]);
}

/** Keeps the keyboard-created input open so the test can answer it without Chromium's native chooser automation. */
async function stubNativePictureChooser(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const click = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.hasAttribute('data-caotang-picture-input')) return;
      click.call(this);
    };
  });
}

async function answerSlashChooser(page: Page, files: readonly (typeof RED)[]): Promise<void> {
  await page.keyboard.press('Enter');
  const input = page.locator('input[data-caotang-picture-input]');
  await expect(input).toHaveCount(1);
  if (files.length === 0) await input.evaluate((element) => element.dispatchEvent(new Event('cancel')));
  else await input.setInputFiles([...files]);
}

test('Insert picture stores the file, writes it into the scene as Markdown, and it is still there after a reload', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));

  await createProject(page, 'Pictured Book');
  await chapterWithScene(page, 'Pictured');
  const docId = await idOf(page, 'Pictured');
  const surface = surfaceOf(page);
  await surface.click();

  await answerChooser(page, () => page.getByRole('button', { name: 'Insert picture' }).click(), [RED]);

  // A picture alone in its paragraph is a figure, and its bytes come from the project, not from the network.
  await expect(surface.locator('figure.caotang-picture img')).toBeVisible();
  await expect.poll(() => surface.locator(PICTURE_IMG).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await waitForSaved(page);
  expect(await bodyOf(page, docId)).toMatch(/^!\[red\]\(\.\.\/assets\/a_[A-Za-z0-9]+\.png\)\n$/);

  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'Pictured Book' }).getByRole('button', { name: 'Open' }).click();
  await binderTitle(page, 'Pictured').click();
  await expect(surfaceOf(page).locator(PICTURE_IMG)).toBeVisible();
  await expect.poll(() => surfaceOf(page).locator(PICTURE_IMG).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  expect(await bodyOf(page, docId)).toMatch(/^!\[red\]\(\.\.\/assets\/a_[A-Za-z0-9]+\.png\)\n$/);
  expect(problems).toEqual([]);
});

test('typing a slash opens the menu, the keyboard chooses, and a cancelled chooser leaves what was typed', async ({ page }) => {
  await stubNativePictureChooser(page);
  await createProject(page, 'Slash Book');
  await chapterWithScene(page, 'Slashed');
  const surface = surfaceOf(page);
  await surface.click();
  await page.keyboard.type('Intro /pic');

  const menu = page.getByRole('listbox', { name: 'Insert' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('option', { name: /Insert picture/ })).toHaveAttribute('aria-selected', 'true');

  // Escape dismisses it and the text stays.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(surface).toHaveText('Intro /pic');

  // A new slash opens it again; Enter chooses; a chooser answered with nothing changes nothing.
  await page.keyboard.type(' /pic');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('option', { name: /Insert picture/ })).toHaveAttribute('aria-selected', 'true');
  await answerSlashChooser(page, []);
  await expect(menu).toHaveCount(0);
  await expect(surface.locator(PICTURE_IMG)).toHaveCount(0);
  await expect(surface).toHaveText('Intro /pic /pic');
});

test('a picture chosen from the slash menu replaces the slash, and one undo takes it back', async ({ page }) => {
  await stubNativePictureChooser(page);
  await createProject(page, 'Undo Book');
  await chapterWithScene(page, 'Undone');
  const docId = await idOf(page, 'Undone');
  const surface = surfaceOf(page);
  await surface.click();
  await page.keyboard.type('Intro /pic');
  const menu = page.getByRole('listbox', { name: 'Insert' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('option', { name: /Insert picture/ })).toHaveAttribute('aria-selected', 'true');

  await answerSlashChooser(page, [RED]);
  await expect(surface.locator(PICTURE_IMG)).toBeVisible();
  await expect(surface).not.toContainText('/pic');
  await waitForSaved(page);
  expect(await bodyOf(page, docId)).toMatch(/^Intro !\[red\]\(\.\.\/assets\/a_[A-Za-z0-9]+\.png\)\n$/);

  await surface.click();
  await page.keyboard.press('Control+z');
  await expect(surface.locator(PICTURE_IMG)).toHaveCount(0);
  await waitForSaved(page);
  expect(await bodyOf(page, docId)).not.toContain('![');
  await expect(surface).toContainText('Intro');
});

test('a picture whose file is gone from the project says so, and its Markdown is kept', async ({ page }) => {
  await createProject(page, 'Gone Book');
  await chapterWithScene(page, 'Gone');
  const docId = await idOf(page, 'Gone');
  await surfaceOf(page).click();
  await answerChooser(page, () => page.getByRole('button', { name: 'Insert picture' }).click(), [RED]);
  await expect(surfaceOf(page).locator(PICTURE_IMG)).toBeVisible();
  await waitForSaved(page);
  const written = await bodyOf(page, docId);
  expect(written).toMatch(/^!\[red\]\(\.\.\/assets\/a_[A-Za-z0-9]+\.png\)\n$/);

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
  await binderTitle(page, 'Gone').click();

  await expect(surfaceOf(page).locator('.caotang-image-placeholder[data-state="missing"]')).toContainText('Picture not found');
  await expect(surfaceOf(page).locator(PICTURE_IMG)).toHaveCount(0);
  expect(await bodyOf(page, docId)).toBe(written);
});
