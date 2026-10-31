/**
 * A comic book in the app: made from the binder with comic.createBook, its pages opened in the page editor, and compiled to a comic
 * PDF from the Compile dialog. comics.md §3.2 and §5 are the contract; undo takes the whole book back in one step. The editor's own
 * gestures and the CBZ and comic EPUB downloads are in comic-page.spec.ts.
 */

import { readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';

import { binderTitle, createProject, firstChapter, trace, traceNames } from './support.js';

const PROJECT = 'Night Shift';

async function menuItem(page: Page, parent: string, item: string): Promise<void> {
  await binderTitle(page, parent).click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${parent}` }).getByRole('menuitem', { name: item }).click();
  await page.keyboard.press('Escape');
}

test('a comic book is made from a chapter with its first page, and a page opens in the page view', async ({ page }) => {
  await createProject(page, PROJECT);
  await menuItem(page, await firstChapter(page), 'New comic here');

  const rows = await trace(page);
  expect(rows.some((row) => row.command === 'comic.createBook')).toBe(true);
  await expect(binderTitle(page, 'Untitled comic')).toBeVisible();

  await menuItem(page, 'Untitled comic', 'New page here');
  await page.getByRole('button', { name: 'Expand Untitled comic' }).click();
  await binderTitle(page, 'Page 1').click();
  // A media view mounts in the Editor view; the Corkboard keeps showing cards.
  await page.getByRole('radio', { name: 'Editor', exact: true }).click();
  await expect(page.getByRole('region', { name: /^Comic page / })).toBeVisible();
  await expect(page.getByRole('region', { name: /^Comic page / })).toContainText('Reads left to right');
  expect((await traceNames(page)).filter((name) => name === 'binder.create').length).toBeGreaterThan(0);
});

test('a comic page compiles to a PDF from the Compile dialog, and the format is offered only for a comic', async ({ page }) => {
  await createProject(page, PROJECT);
  const chapter = await firstChapter(page);
  await menuItem(page, chapter, 'New comic here');

  await binderTitle(page, chapter).click();
  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  // The dialog is lazy: wait until its native showModal effect has opened it before sending Escape.
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /^Comic PDF/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await binderTitle(page, 'Untitled comic').click();
  await page.getByRole('button', { name: 'Compile…' }).click();
  await dialog.getByRole('radio', { name: /^Comic PDF/ }).check();
  await expect(dialog.getByRole('checkbox', { name: /^Bleed/ })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /^Crop marks/ })).not.toBeChecked();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Compile', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  const path = await download.path();
  if (path === null) throw new Error('the comic PDF was not downloaded');
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

  expect(await traceNames(page)).toContain('export.compileSelection');

  // The status line counts what a comic holds, its pages and panels, and never the chapters, scenes and words it does not have.
  const status = page.getByRole('status').filter({ hasText: /^Exported / });
  await expect(status).toContainText('1 page, 6 panels');
  await expect(status).not.toContainText(/chapter|scene|word/);
});

test('the paper size options of a PDF carry the stable ids A4 and Letter, not translated words', async ({ page }) => {
  await createProject(page, PROJECT);
  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: /^Storyboard contact sheet/ }).check();
  const options = dialog.getByRole('combobox', { name: 'Paper size' }).locator('option');
  expect(await options.evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value))).toEqual(['A4', 'Letter']);
});
