/**
 * The shared import preview (issue #267, import-preview.md): a DOCX-like block list through the dialog. Nothing is written until
 * Import; a rule change re-splits and asks before it drops manual edits; each split says why; losses and AI-instruction passages
 * are listed first; the commit is one undo step, codex rows and pictures included, and Undo takes it all back.
 *
 * The page loads the fixture sources (e2e/import-preview-fixture.ts) through the dev server and opens them through the app's own
 * request store, as a reader's Import action does. The readers themselves land with their own issues.
 */

import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { createProject, traceNames, treeOf, waitForSaved } from './support.js';

const fixtureUrl = `/@fs/${fileURLToPath(new URL('./import-preview-fixture.ts', import.meta.url)).replaceAll('\\', '/').replace(/^\/+/, '')}`;

async function openFixture(page: Page, which: 'lighthouseSource' | 'longSource' | 'stuckSource', words = 0): Promise<void> {
  await page.evaluate(
    async ({ url, store, which, words }) => {
      const fixture = (await import(/* @vite-ignore */ url)) as Record<string, (words: number) => unknown>;
      const requests = (await import(/* @vite-ignore */ store)) as { openImportPreview(request: { source: unknown }): void };
      requests.openImportPreview({ source: fixture[which]?.(words) });
    },
    // The app's own request store, at the URL the dev server gives the app's import of it, so this is the module the workspace listens to.
    { url: fixtureUrl, store: '/src/import-preview/requests.ts', which, words },
  );
}

test('a DOCX-like file: split reasons, a removed split, a rule change that asks, and Cancel writes nothing', async ({ page }) => {
  await createProject(page, 'Lighthouse Import');
  await openFixture(page, 'lighthouseSource');

  const dialog = page.getByRole('dialog', { name: 'Import “The Lighthouse Keeper.docx”' });
  await expect(dialog).toBeVisible();
  const detected = dialog.locator('.import-preview-detected');
  await expect(detected).toHaveText('Detected: 39 words · 3 chapters · 5 scenes · 1 image · 3 codex rows');

  // Every split says why it is there.
  await expect(dialog.getByRole('note', { name: 'Split: chapter, because Heading 1' })).toHaveCount(2);
  await expect(dialog.getByRole('note', { name: 'Split: scene, because scene break “* * *”' })).toHaveCount(2);

  // Losses and AI-instruction passages are listed before anything is written, the passage with where it is.
  await expect(dialog.getByRole('list', { name: 'What the import cannot keep' })).toContainText('1 × table became paragraphs');
  await expect(dialog.getByRole('list', { name: 'Passages that read like instructions to an AI' })).toContainText('Chapter 2: Salt · 1');

  // A network step is off until the writer turns it on, and says where it goes.
  const download = dialog.getByRole('checkbox', { name: /Download linked images \(downloads 2 files, about 2\.1 MB, from images\.example\.com\)/ });
  await expect(download).not.toBeChecked();

  // × removes one split: the scenes go from five to four.
  await dialog.getByRole('button', { name: 'Remove this split (scene break “* * *”)' }).first().click();
  await expect(detected).toContainText('4 scenes');

  // A rule change re-splits and asks before it drops the manual edit.
  await dialog.getByRole('combobox', { name: 'Chapters at' }).selectOption('none');
  const ask = dialog.getByRole('group', { name: 'Keep your manual edits?' });
  await expect(ask).toContainText('You made 1 manual edit.');
  await expect(dialog.getByRole('button', { name: 'Import 3 chapters' })).toBeDisabled();
  await ask.getByRole('button', { name: 'Discard them' }).click();
  await expect(detected).toContainText('1 chapter · 3 scenes');
  await dialog.getByRole('combobox', { name: 'Chapters at' }).selectOption('heading-1');
  await expect(detected).toContainText('3 chapters · 5 scenes');

  // A codex row that collides with an earlier row starts as Skip.
  await expect(dialog.getByRole('combobox', { name: 'What to do with mara', exact: true })).toHaveValue('skip');

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await traceNames(page)).not.toContain('binder.importTree');
  expect((await treeOf(page)).some((node) => node.title === 'Chapter 1: The Landing')).toBe(false);
});

test('Import writes the tree, the codex rows and the picture as one undo step, and Undo takes it all back', async ({ page }) => {
  await createProject(page, 'Lighthouse Commit');
  const before = await treeOf(page);
  await openFixture(page, 'lighthouseSource');

  const dialog = page.getByRole('dialog', { name: 'Import “The Lighthouse Keeper.docx”' });
  // Rename a chapter in the binder pane (F2), and leave the third one out (Space).
  const tree = dialog.getByRole('tree', { name: 'Binder (proposed)' });
  await tree.getByText('Chapter 1: The Landing', { exact: true }).click();
  await page.keyboard.press('F2');
  await dialog.getByRole('textbox', { name: 'Rename Chapter 1: The Landing', exact: true }).fill('The Landing');
  await page.keyboard.press('Enter');
  await tree.getByRole('checkbox', { name: 'Import Chapter 3: The Lantern', exact: true }).uncheck();

  await dialog.getByRole('button', { name: 'Import 3 chapters' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Imported 4 documents in 2 folders from The Lighthouse Keeper\.docx\./)).toBeVisible();
  await waitForSaved(page);

  const names = await traceNames(page);
  expect(names.filter((name) => name === 'binder.importTree')).toHaveLength(1);
  const after = await treeOf(page);
  const landing = after.find((node) => node.title === 'The Landing');
  expect(landing?.parentId).toBe('manuscript');
  expect(after.some((node) => node.title === 'Chapter 3: The Lantern')).toBe(false);
  const scene = after.find((node) => node.title === 'Chapter 1: The Landing · 2');
  expect(scene).toBeDefined();
  const body = await page.evaluate((id) => (globalThis as unknown as { __caotang: { body(id: string): string | null } }).__caotang.body(id), scene?.id ?? '');
  expect(body).toMatch(/!\[The harbour\]\(\.\.\/assets\/a_[0-9A-Z]{10}\.png\)/);

  // One undo takes back the whole import.
  await page.getByRole('tab', { name: 'Activity' }).click();
  const newest = page.getByRole('list', { name: 'Activity' }).getByRole('listitem').first();
  await expect(newest.locator('.activity-title')).toHaveText('Imported into the binder');
  await newest.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await treeOf(page)).map((node) => node.id).sort()).toEqual(before.map((node) => node.id).sort());
});

test('a 200,000-word file opens with a progress line, and the text pane renders only what is in view', async ({ page }) => {
  await createProject(page, 'Long Import');
  await openFixture(page, 'longSource', 200_000);

  const dialog = page.getByRole('dialog', { name: 'Import “Long.docx”' });
  await expect(dialog.locator('.import-preview-detected')).toContainText('200,000 words · 40 chapters');
  const blocks = dialog.locator('.import-preview-block');
  expect(await blocks.count()).toBeLessThan(120);

  // Scrolling to the end shows the last paragraph, still with only a window of blocks in the DOM.
  const pane = dialog.getByRole('region', { name: 'Text of the file' });
  await pane.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(dialog.getByText(/^Paragraph4000 /)).toBeVisible();
  expect(await blocks.count()).toBeLessThan(120);

  // Selecting a chapter in the binder scrolls the text to it.
  await dialog.getByRole('tree', { name: 'Binder (proposed)' }).getByText('Chapter 2', { exact: true }).click();
  await expect(dialog.getByText(/^Paragraph101 /)).toBeVisible();

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await traceNames(page)).not.toContain('binder.importTree');
});

test('Cancel while the file is still being read closes the preview and writes nothing', async ({ page }) => {
  await createProject(page, 'Stuck Import');
  await openFixture(page, 'stuckSource');
  const dialog = page.getByRole('dialog', { name: 'Import “Stuck.docx”' });
  await expect(dialog.getByRole('status')).toHaveText('Reading Stuck.docx… 10%');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await traceNames(page)).not.toContain('binder.importTree');
});
