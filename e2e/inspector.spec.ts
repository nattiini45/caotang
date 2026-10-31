import { expect, test, type Page } from '@playwright/test';

import { binderRow, binderTitle, card, countOf, createProject, freezeClock, projectTrace, trace, loose } from './support.js';

/**
 * ui-modules §4: the inspector edits the selected node. Synopsis and notes are debounced at
 * 800 ms; keywords and status/label are one command each.
 */

/** A chapter with one scene in it, the scene selected: the inspector is showing a document. */
async function selectedScene(page: Page): Promise<void> {
  await createProject(page, 'Inspector Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await expect(binderRow(page, 'The Landing')).toBeVisible();
  await binderTitle(page, 'The Landing').click();
}

function inspector(page: Page) {
  return page.getByRole('complementary', { name: 'Inspector' });
}

test('with nothing selected, the inspector says what to select', async ({ page }) => {
  await createProject(page, 'Nothing Selected');

  await expect(inspector(page).getByRole('heading', { name: 'Select a document' })).toBeVisible();
  await expect(inspector(page).getByRole('textbox', { name: 'Synopsis' })).toHaveCount(0);
});

test('a document shows its synopsis, notes, keywords, status and label', async ({ page }) => {
  await selectedScene(page);

  await expect(inspector(page).getByRole('heading', { name: 'The Landing' })).toBeVisible();
  await expect(inspector(page).getByRole('textbox', { name: 'Synopsis' })).toBeVisible();
  await expect(inspector(page).getByRole('textbox', { name: 'Notes' })).toBeVisible();
  // The field has a suggestion list, so its ARIA role is "combobox"; the label is what names it.
  await expect(inspector(page).getByLabel('Add keyword')).toBeVisible();
  await expect(inspector(page).getByRole('button', { name: /^Status: No status/ })).toBeVisible();
  await expect(inspector(page).getByRole('button', { name: /^Label: No label/ })).toBeVisible();
});

test('a folder shows the same panel without notes', async ({ page }) => {
  await createProject(page, 'Folder Variant');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();

  await expect(inspector(page).getByRole('heading', { name: 'Chapter 1' })).toBeVisible();
  await expect(inspector(page).getByRole('textbox', { name: 'Synopsis' })).toBeVisible();
  await expect(inspector(page).getByRole('textbox', { name: 'Notes' })).toHaveCount(0);
});

test('the synopsis is committed 800 ms after the writer pauses, and the counter follows the text', async ({ page }) => {
  // The clock is installed before the page loads; the test takes it over at the freeze, so the debounce
  // is measured by the test and not by the wall clock.
  await page.clock.install();
  await selectedScene(page);
  const synopsis = inspector(page).getByRole('textbox', { name: 'Synopsis' });
  await freezeClock(page);

  await synopsis.fill('Elena returns to the island.');
  // "Elena returns to the island." is 28 characters.
  await expect(inspector(page).getByText('28 / 2,000')).toBeVisible();

  await page.clock.runFor(799);
  expect(await countOf(page, 'binder.setSynopsis')).toBe(0);
  await page.clock.runFor(1);
  expect(await countOf(page, 'binder.setSynopsis')).toBe(1);
  // The card and the binder tooltip read the same field, so the row now carries the preview.
  await expect(binderRow(page, 'The Landing')).toHaveAttribute('title', 'Elena returns to the island.');
});

test('the notes commit 800 ms after the writer pauses, through notes.set', async ({ page }) => {
  await page.clock.install();
  await selectedScene(page);
  const notes = inspector(page).getByRole('textbox', { name: 'Notes' });
  await freezeClock(page);

  await notes.fill('Fix the pacing in the last three paragraphs.');

  await page.clock.runFor(799);
  expect(await countOf(page, 'notes.set')).toBe(0);
  await page.clock.runFor(1);
  expect(await countOf(page, 'notes.set')).toBe(1);
});

test("a folder's status shows on its binder row and on its corkboard card, once it is set", async ({ page }) => {
  await createProject(page, 'Folder Status');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();

  // Chapter 1 is selected, so the inspector shows the folder's own fields, status included (ui-modules §4.2).
  await inspector(page).getByRole('button', { name: /^Status: No status/ }).click();
  await page.getByRole('menuitemradio', { name: 'Final' }).click();
  await expect(inspector(page).getByRole('button', { name: /^Status: Final/ })).toBeVisible();

  // The binder row carries the chip, as a document's does.
  await expect(binderRow(page, 'Chapter 1').getByRole('button', { name: /^Status of Chapter 1: Final/ })).toBeVisible();
  // The corkboard shows the folder as a card once the manuscript is the scope.
  await page.locator('.row.is-section', { hasText: 'Manuscript' }).click();
  await expect(card(page, 'Chapter 1').locator('.chip-status')).toContainText('Final');
  expect((await projectTrace(page)).filter((name) => name === 'binder.setMeta')).toHaveLength(1);
});

test('keywords are added and removed one command at a time, and duplicates are refused without one', async ({ page }) => {
  await selectedScene(page);
  const input = inspector(page).getByLabel('Add keyword');

  await input.fill('sea');
  await input.press('Enter');
  await expect(inspector(page).getByRole('listitem').filter({ hasText: 'sea' })).toBeVisible();

  await input.fill('Sea');
  await input.press('Enter');
  await expect(inspector(page).getByText(loose('“Sea” is already a keyword here.'))).toBeVisible();

  await inspector(page).getByRole('button', { name: 'Remove keyword sea' }).click();
  await expect(inspector(page).getByRole('listitem').filter({ hasText: 'sea' })).toHaveCount(0);

  const meta = (await trace(page)).filter((row) => row.command === 'binder.setMeta');
  expect(meta).toHaveLength(2);
});

test('the status picker writes binder.setMeta, and the chip and the picker agree afterwards', async ({ page }) => {
  await selectedScene(page);

  await inspector(page).getByRole('button', { name: /^Status: No status/ }).click();
  await page.getByRole('menuitemradio', { name: 'Final' }).click();

  await expect(inspector(page).getByRole('button', { name: /^Status: Final/ })).toBeVisible();
  await expect(binderRow(page, 'The Landing').getByRole('button', { name: /^Status of The Landing: Final/ })).toBeVisible();
  expect((await projectTrace(page)).filter((name) => name === 'binder.setMeta')).toHaveLength(1);
});

test('a label picker with no labels offers to add the first one (the vocabulary editor)', async ({ page }) => {
  await selectedScene(page);

  await inspector(page).getByRole('button', { name: /^Label: No label/ }).click();
  // With no label yet, the one entry is "+ Add label…", which opens the vocabulary editor (project-vocabulary.spec.ts).
  await expect(page.getByRole('menuitem', { name: '+ Add label…' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});
