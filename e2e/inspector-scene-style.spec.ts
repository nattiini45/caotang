import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { binderTitle, countOf, createProject, waitForSaved } from './support.js';

/**
 * exporter.md §2, Per-scene styling: a document's Export style is Normal or Section. Section prints the scene's title as a heading in
 * the exports; Normal clears it. Each change is one `binder.setMeta`, so it is undoable.
 */

function inspector(page: Page) {
  return page.getByRole('complementary', { name: 'Inspector' });
}

/** A chapter with one scene that has words in it, the scene selected. */
async function selectedScene(page: Page): Promise<void> {
  await createProject(page, 'Style Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The boat came in with the tide.');
  await waitForSaved(page);
  await binderTitle(page, 'The Landing').click();
}

/** Compiles the manuscript to Markdown from the Export dialog and returns the file's text. */
async function compiledMarkdown(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: /^Markdown \(\.md\)/ }).check();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Compile', exact: true }).click(),
  ]);
  return readFileSync((await download.path()) ?? '', 'utf8');
}

test('a scene starts as Normal, and Section prints its title in the export', async ({ page }) => {
  await selectedScene(page);
  const style = inspector(page).getByRole('combobox', { name: 'Export style' });
  await expect(style).toHaveValue('normal');
  expect(await compiledMarkdown(page)).not.toContain('### The Landing');

  await style.selectOption('section');
  await expect(style).toHaveValue('section');
  expect(await countOf(page, 'binder.setMeta')).toBe(1);
  expect(await compiledMarkdown(page)).toContain('### The Landing\n\nThe boat came in with the tide.');
});

test('Normal clears the style, and Undo brings Section back', async ({ page }) => {
  await selectedScene(page);
  const style = inspector(page).getByRole('combobox', { name: 'Export style' });

  await style.selectOption('section');
  await style.selectOption('normal');
  await expect(style).toHaveValue('normal');
  expect(await countOf(page, 'binder.setMeta')).toBe(2);

  // The focus leaves the select, so the chord is the app's undo.
  await binderTitle(page, 'The Landing').click();
  await page.keyboard.press('Control+z');
  await expect(style).toHaveValue('section');
});

test('a folder has no Export style', async ({ page }) => {
  await createProject(page, 'Folder Style');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await expect(inspector(page).getByRole('heading', { name: 'Chapter 1' })).toBeVisible();
  await expect(inspector(page).getByRole('combobox', { name: 'Export style' })).toHaveCount(0);
});
