import { expect, test, type Page } from '@playwright/test';

import { bodyOf, createProject, idOf, waitForSaved } from './support.js';

/**
 * Footnotes in the editor (editor-engine §3.4, #270), with the keyboard and the Add footnote button: add one, write its note, go
 * back to the text, delete the number and answer the question about its note, either way. The stored body is the GFM spelling.
 */

async function chapterWithScene(page: Page, scene: string): Promise<void> {
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(scene);
  await page.keyboard.press('Enter');
}

test('Ctrl+Shift+6 adds a footnote, the note is typed at the end, and the same keys go back to the text', async ({ page }) => {
  await createProject(page, 'Footnote Book');
  await chapterWithScene(page, 'Harbour');
  const docId = await idOf(page, 'Harbour');

  const surface = page.getByRole('textbox', { name: 'Document text' });
  await surface.click();
  await page.keyboard.type('The ferry was late');
  await page.keyboard.press('Control+Shift+6');
  await page.keyboard.type('The Marta.');
  await page.keyboard.press('Control+Shift+6');
  await page.keyboard.type(', as always.');
  await waitForSaved(page);

  expect(await bodyOf(page, docId)).toBe('The ferry was late[^1], as always.\n\n[^1]: The Marta.\n');
  // What a screen reader is given: the number is a named note reference, its note a named region.
  await expect(surface.locator('sup[role="doc-noteref"]')).toHaveAttribute('aria-label', 'Footnote 1');
  await expect(surface.locator('sup[role="doc-noteref"]')).toHaveAttribute('title', 'The Marta.');
  await expect(surface.getByRole('note', { name: 'Footnote 1' })).toHaveText('The Marta.');
});

test('the Add footnote button numbers in reading order, and deleting a number asks about its note', async ({ page }) => {
  await createProject(page, 'Footnote Order');
  await chapterWithScene(page, 'Order');
  const docId = await idOf(page, 'Order');

  const surface = page.getByRole('textbox', { name: 'Document text' });
  await surface.click();
  await page.keyboard.type('Second');
  await page.keyboard.press('Control+Shift+6');
  await page.keyboard.type('Note B.');
  // Back to the text, then to its start, and a footnote there: it becomes number 1.
  await page.keyboard.press('Control+Shift+6');
  await page.keyboard.press('Home');
  await page.keyboard.type('First ');
  await page.keyboard.press('ArrowLeft');
  await page.getByRole('button', { name: 'Add footnote' }).click();
  await page.keyboard.type('Note A.');
  await waitForSaved(page);
  expect(await bodyOf(page, docId)).toBe('First[^1] Second[^2]\n\n[^1]: Note A.\n\n[^2]: Note B.\n');

  // Delete the first number: the note stays, renumbered after the other, and the editor asks.
  await page.keyboard.press('Control+Shift+6');
  await page.keyboard.press('Backspace');
  const question = page.getByTestId('footnote-question');
  await expect(question).toContainText('footnote 2');
  await question.getByRole('button', { name: 'Delete the note' }).click();
  await waitForSaved(page);
  expect(await bodyOf(page, docId)).toBe('First Second[^1]\n\n[^1]: Note B.\n');
});

test('answering Keep the note closes the question and leaves the note, after the others', async ({ page }) => {
  await createProject(page, 'Footnote Keep');
  await chapterWithScene(page, 'Keep');
  const docId = await idOf(page, 'Keep');

  const surface = page.getByRole('textbox', { name: 'Document text' });
  await surface.click();
  await page.keyboard.type('Only');
  await page.keyboard.press('Control+Shift+6');
  await page.keyboard.type('Kept note.');
  await page.keyboard.press('Control+Shift+6');
  await waitForSaved(page);
  expect(await bodyOf(page, docId)).toBe('Only[^1]\n\n[^1]: Kept note.\n');

  // Delete the number, then keep its note: the question goes, and the note stays as an unreferenced note.
  await page.keyboard.press('Backspace');
  const question = page.getByTestId('footnote-question');
  await expect(question).toContainText('footnote 1');
  await question.getByRole('button', { name: 'Keep the note' }).click();
  await expect(question).toHaveCount(0);
  await waitForSaved(page);
  expect(await bodyOf(page, docId)).toBe('Only\n\n[^1]: Kept note.\n');
});
