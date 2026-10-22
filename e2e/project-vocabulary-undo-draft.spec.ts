import { expect, test, type Page } from '@playwright/test';

import { createProject } from './support.js';

/**
 * The vocabulary editor's rows follow the project (project-format §2): a term the project took back
 * leaves the row showing the term the project holds, and the row is not left looking changed.
 */

/**
 * A chapter with one scene in it, so the inspector offers the vocabulary editor.
 *
 * The scene's text is left alone: the autosave's write is a command of its own, and a saved body
 * would be the newest group to undo, so the rename below would not be the one the chord takes back.
 */
async function sceneInChapter(page: Page): Promise<void> {
  await createProject(page, 'Vocabulary Draft Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
}

/** The vocabulary editor, open on the labels, with one label in it. */
async function editorWithALabel(page: Page) {
  await page.getByRole('button', { name: /^Label: No label\. Change label/ }).click();
  await page.getByRole('menuitem', { name: '+ Add label…' }).click();
  const editor = page.getByRole('dialog', { name: 'Statuses and labels' });
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'Labels', exact: true }).click();
  await editor.getByRole('textbox', { name: 'New label' }).fill('Act 1');
  await editor.getByRole('button', { name: 'Add label' }).click();
  await expect(editor.locator('li.vocabulary-row')).toHaveCount(1);
  return editor;
}

test('a label the project took back leaves the row showing the term the project holds', async ({ page }) => {
  await sceneInChapter(page);
  const editor = await editorWithALabel(page);
  const row = editor.locator('li.vocabulary-row').first();
  // The colour field is a textbox too, so the name field is named by its type.
  const name = row.locator('input[type="text"]');

  await name.fill('First pass');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(name).toHaveValue('First pass');

  // The focus is on the Save button, which is not a text field, so the chord is the app's undo.
  await page.keyboard.press('Control+z');

  // The project holds the label it held before the rename, so the row shows that name and is not
  // left looking changed.
  await expect(name).toHaveValue('Act 1');
  await expect(row.getByRole('button', { name: 'Save' })).toBeDisabled();
});
