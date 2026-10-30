import { readFileSync } from 'node:fs';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { createProject, projectTrace, rejected, traceNames, waitForSaved } from './support.js';

/**
 * exporter.md §4, the Draft: the Export dialog's Preview says what the compile will hold and what it will leave out before any file is
 * made, in the compile log's own words, and the numbers it gives are the ones the compile reports afterwards.
 */

/** Two chapters: the first holds two scenes with words, the second holds an empty document and one scene. */
async function manuscript(page: Page): Promise<void> {
  await newChapter(page, 'Chapter 1');
  await newDocument(page, 'The Landing', 'The boat came in with the tide. Nobody was on it.');
  await newDocument(page, 'The Storm', 'The glass fell all night.');
  await newChapter(page, 'Chapter 2');
  await newDocument(page, 'The Call', null);
  await newDocument(page, 'Morning', 'Light, at last.');
}

async function newChapter(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(title);
  await page.keyboard.press('Enter');
}

async function newDocument(page: Page, title: string, body: string | null): Promise<void> {
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(title);
  await page.keyboard.press('Enter');
  if (body !== null) {
    await page.getByRole('textbox', { name: 'Document text' }).fill(body);
    await waitForSaved(page);
  }
}

async function openDialog(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await expect(dialog).toBeVisible();
  return dialog;
}

const preview = (dialog: Locator): Locator => dialog.getByRole('group', { name: 'Preview' });
const region = (dialog: Locator): Locator => dialog.getByRole('region', { name: 'What will be compiled' });

test('the Preview lists the chapters and scenes and names an empty document as skipped before anything is compiled', async ({ page }) => {
  await createProject(page, 'Draft Preview');
  await manuscript(page);
  const before = await projectTrace(page);

  const dialog = await openDialog(page);
  await dialog.getByRole('radio', { name: /^Markdown \(\.md\)/ }).check();
  const list = region(dialog);
  await expect(list).toContainText('Title page');
  await expect(list.getByRole('listitem').filter({ hasText: /^\d\. Chapter/ })).toHaveCount(2);
  await expect(list).toContainText('The Landing');
  await expect(list).toContainText('The Storm');
  await expect(list).toContainText('Morning');
  await expect(list).toContainText('3 words');
  // The empty document is named in the compile log's words, and it is not in the list of scenes.
  await expect(list.getByRole('list').first()).toContainText('skipped: Chapter 2 → The Call (empty)');
  await expect(list.getByRole('listitem').filter({ hasText: /^The Call/ })).toHaveCount(0);
  await expect(preview(dialog)).toContainText('2 chapters, 3 scenes');
  await expect(preview(dialog)).toContainText('leave out 1 empty document');

  // A look is not a compile: no command ran, nothing was refused, and no file was made.
  expect(await projectTrace(page)).toEqual(before);
  expect(await rejected(page)).toEqual([]);
  expect((await traceNames(page)).some((name) => name.startsWith('export.'))).toBe(false);
});

test('the Preview is reachable by the keyboard, and the Compile button stays in the dialog and in view', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 640 });
  await createProject(page, 'Draft Keyboard');
  await manuscript(page);

  const dialog = await openDialog(page);
  const list = region(dialog);
  await list.focus();
  await expect(list).toBeFocused();
  await list.scrollIntoViewIfNeeded();
  // The region has a height of its own, so a long list scrolls inside it and the buttons do not move away.
  const box = await list.boundingBox();
  expect(box?.height ?? 0).toBeLessThanOrEqual(240);
  const compile = dialog.getByRole('button', { name: 'Compile', exact: true });
  await compile.scrollIntoViewIfNeeded();
  await expect(compile).toBeInViewport();
});

test('changing the format, the scope or the recipe changes the Preview, and its counts are the ones the compile reports', async ({ page }) => {
  await createProject(page, 'Draft Follows');
  await manuscript(page);
  // The binder's selection is "Morning": the dialog offers it as the part to export.
  const dialog = await openDialog(page);
  await dialog.getByRole('radio', { name: /^Plain text \(\.txt\)/ }).check();
  await expect(preview(dialog)).toContainText('2 chapters, 3 scenes, 19 words');

  // The scope: one item.
  await dialog.getByRole('radio', { name: /^Only “Morning”/ }).check();
  await expect(preview(dialog)).toContainText('1 chapter, 1 scene, 3 words');
  await expect(region(dialog)).not.toContainText('The Landing');
  await expect(region(dialog).getByRole('listitem').filter({ hasText: /^Title page/ })).toHaveCount(1);

  // The recipe's settings: the title page off takes it out of the Draft, as it takes it out of the compile.
  await dialog.getByRole('checkbox', { name: 'Title page' }).uncheck();
  await expect(region(dialog).getByRole('listitem').filter({ hasText: /^Title page/ })).toHaveCount(0);

  // The format: a screenplay format is not built from a block list, and this book holds no screenplay scene.
  await dialog.getByRole('radio', { name: /^Fountain \(\.fountain\)/ }).check();
  await expect(preview(dialog)).toContainText('would be refused');
  await expect(preview(dialog)).toContainText('the selection holds no screenplay scene');
  await expect(region(dialog)).toHaveCount(0);

  // Back to the whole manuscript as Markdown, and compile: the status line gives the same numbers the Preview did.
  await dialog.getByRole('radio', { name: /^The whole manuscript/ }).check();
  await dialog.getByRole('radio', { name: /^Markdown \(\.md\)/ }).check();
  await expect(preview(dialog)).toContainText('2 chapters, 3 scenes, 19 words');
  await expect(preview(dialog)).toContainText('leave out 1 empty document');
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Compile', exact: true }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.md$/);
  const sentence = page.getByRole('status').filter({ hasText: 'Exported' });
  await expect(sentence).toContainText('2 chapters, 3 scenes, 19 words');
  await expect(sentence).toContainText('Skipped 1 empty document');
});

test('a media format that passes its gates shows the compile’s counts and says it has no block list', async ({ page }) => {
  await createProject(page, 'Draft Media');
  await manuscript(page);
  const dialog = await openDialog(page);
  // The coherence report is written for any project, so it passes its gates here and is not built from a block list.
  await dialog.getByRole('radio', { name: /^Coherence report \(\.md\)/ }).check();
  await expect(preview(dialog)).toContainText('The compile will hold the coherence report');
  await expect(preview(dialog)).toContainText('not built from a block list');
  await expect(dialog.getByRole('button', { name: 'Compile', exact: true })).toBeEnabled();
});

const proofRegion = (dialog: Locator): Locator => dialog.getByRole('region', { name: 'The file the compile will write' });

test('the Proof shows the file the compile writes for a text format, and says a binary format has none, writing nothing', async ({ page }) => {
  await createProject(page, 'Proof Preview');
  await manuscript(page);
  const before = await projectTrace(page);

  const dialog = await openDialog(page);
  await dialog.getByRole('radio', { name: /^Markdown \(\.md\)/ }).check();
  await dialog.getByRole('radio', { name: /^Proof/ }).check();
  const file = proofRegion(dialog);
  await expect(file).toContainText('The boat came in with the tide. Nobody was on it.');
  await expect(file).toContainText('Light, at last.');
  await expect(preview(dialog)).toContainText('The compile will write Proof Preview.md');
  // The Draft's list is not shown beside it: one half at a time.
  await expect(region(dialog)).toHaveCount(0);
  await file.focus();
  await expect(file).toBeFocused();

  // A binary format has no Proof, and the dialog says so in words.
  await dialog.getByRole('radio', { name: /^Word \(\.docx\)/ }).check();
  await expect(preview(dialog)).toContainText('There is no Proof of Word (.docx) in Caotang.');
  await expect(proofRegion(dialog)).toHaveCount(0);

  // A look is not a compile.
  expect(await projectTrace(page)).toEqual(before);
  expect((await traceNames(page)).some((name) => name.startsWith('export.'))).toBe(false);

  // The Proof is the file the compile then writes.
  await dialog.getByRole('radio', { name: /^Plain text \(\.txt\)/ }).check();
  await expect(proofRegion(dialog)).toContainText('Light, at last.');
  const shown = await proofRegion(dialog).locator('pre').textContent();
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Compile', exact: true }).click()]);
  const path = await download.path();
  expect(path).not.toBeNull();
  expect(readFileSync(path, 'utf8')).toBe(shown);
});
