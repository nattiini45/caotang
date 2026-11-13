/**
 * **Import Markdown…** (issue #280): a Markdown file chosen in the binder opens in the shared import preview, split at its `#`
 * headings and `* * *` breaks, and Import writes it as one `binder.importTree` whose documents are in the binder. Cancel writes
 * nothing. The front matter's scene facts reach the timeline's SceneMeta.
 */

import { expect, test } from '@playwright/test';

import { bodyOf, createProject, traceNames, treeOf, waitForSaved } from './support.js';

const MARKDOWN = [
  '---',
  'title: The Landing',
  'pov: Elena',
  'day: 3',
  'tags:',
  '  - sea',
  '  - grief',
  '---',
  '',
  '# Chapter One',
  '',
  'The ferry came at noon.',
  '',
  '* * *',
  '',
  'By evening the wind had turned.',
  '',
  '# Chapter Two',
  '',
  'The letter arrived on a Tuesday.',
].join('\n');

const choose = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.locator('input[type="file"][aria-label="Markdown file"]').setInputFiles({ name: 'novel.md', mimeType: 'text/markdown', buffer: Buffer.from(MARKDOWN, 'utf8') });
};

test('a Markdown file opens split at its headings, and Import puts its documents in the binder as one step', async ({ page }) => {
  await createProject(page, 'Markdown Import');
  await choose(page);

  const dialog = page.getByRole('dialog', { name: 'Import “novel.md”' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.import-preview-detected')).toContainText('2 chapters');

  // Cancel writes nothing.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await traceNames(page)).not.toContain('binder.importTree');

  await choose(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Import 2 chapters' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);

  expect((await traceNames(page)).filter((name) => name === 'binder.importTree')).toHaveLength(1);
  const tree = await treeOf(page);
  const chapters = tree.filter((node) => node.parentId === 'manuscript' && node.type === 'folder').map((node) => node.title);
  expect(chapters).toEqual(expect.arrayContaining(['Chapter One', 'Chapter Two']));
  const one = tree.find((node) => node.title === 'Chapter One');
  const scenes = tree.filter((node) => node.parentId === one?.id && node.type === 'document');
  expect(scenes).toHaveLength(2);
  expect(await bodyOf(page, scenes[0]?.id ?? '')).toContain('The ferry came at noon.');
  expect(await bodyOf(page, scenes[1]?.id ?? '')).toContain('By evening the wind had turned.');
});
