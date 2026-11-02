import { expect, test, type Page } from '@playwright/test';

import { bodyOf, binderTitle, createProject, idOf, waitForSaved } from './support.js';

/**
 * The live editor (editor-engine §4 and §9): what the writer types is the scene's text, it is saved
 * in this browser, it is there after a reload, and each scene opens with its own words.
 */

function binderToolbar(page: Page) {
  return page.getByRole('toolbar', { name: 'Binder actions' });
}

/** A chapter, and one scene in it, named. The scene is open in the editor. */
async function chapterWithScene(page: Page, scene: string): Promise<void> {
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await binderToolbar(page).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill(scene);
  await page.keyboard.press('Enter');
}

test('typing persists across a reload: the text is saved, and it opens with the paragraphs as they were typed', async ({
  page,
}) => {
  // The editor's own warnings and errors are part of the contract: a page that logs them is not working.
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    // WebKit doesn't know the viewport's interactive-widget key (#364) and says so once; that notice is not a problem.
    if (/Viewport argument key "interactive-widget" not recognized/.test(message.text())) return;
    if (message.type() === 'error') problems.push(message.text());
  });

  await createProject(page, 'Typing Book');
  await chapterWithScene(page, 'Typed');
  const docId = await idOf(page, 'Typed');

  // Real key presses, the way a writer types: a paragraph, Enter, another paragraph.
  const surface = page.getByRole('textbox', { name: 'Document text' });
  await surface.click();
  await page.keyboard.type('The harbour was quiet.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Nobody had come in on the tide.');
  await waitForSaved(page);

  // The stored body is the editor's canonical Markdown: a blank line between paragraphs, and a final newline.
  expect(await bodyOf(page, docId)).toBe('The harbour was quiet.\n\nNobody had come in on the tide.\n');

  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'Typing Book' }).getByRole('button', { name: 'Open' }).click();
  await binderTitle(page, 'Typed').click();

  await expect(surface.locator('p')).toHaveText(['The harbour was quiet.', 'Nobody had come in on the tide.']);
  expect(problems).toEqual([]);
});

test('each scene opens with its own words, and moving between scenes never carries one into another', async ({
  page,
}) => {
  await createProject(page, 'Two Scenes');
  await chapterWithScene(page, 'Alpha');
  await page.getByRole('textbox', { name: 'Document text' }).fill('Alpha is the first scene.');
  await waitForSaved(page);

  await binderToolbar(page).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Beta');
  await page.keyboard.press('Enter');
  const surface = page.getByRole('textbox', { name: 'Document text' });
  await expect(surface).toHaveText('');
  await surface.fill('Beta is the second.');
  await waitForSaved(page);

  await binderTitle(page, 'Alpha').click();
  await expect(surface).toHaveText('Alpha is the first scene.');
  await binderTitle(page, 'Beta').click();
  await expect(surface).toHaveText('Beta is the second.');
});

test('Ctrl+Z inside the editor takes back the writer’s own typing, and the saved text follows it', async ({ page }) => {
  await createProject(page, 'Keys Book');
  await chapterWithScene(page, 'Typed Twice');
  const docId = await idOf(page, 'Typed Twice');
  const surface = page.getByRole('textbox', { name: 'Document text' });

  await surface.click();
  await page.keyboard.type('Alpha beta.');
  await waitForSaved(page);
  expect(await bodyOf(page, docId)).toBe('Alpha beta.\n');

  // The keystrokes are the editor's own history (editor-engine §7, lane 1): the key is the editor's, not the shell's.
  await page.keyboard.press('Control+z');
  await expect(surface).toHaveText('');
  await waitForSaved(page);
  await expect.poll(() => bodyOf(page, docId)).toBe('');
});

test('the status bar counts the words the store counts, and says when they are saved', async ({ page }) => {
  await createProject(page, 'Counting Book');
  await chapterWithScene(page, 'Counted');
  await page.getByRole('textbox', { name: 'Document text' }).fill('Two words here.');
  await waitForSaved(page);

  const status = page.getByLabel('Document status');
  await expect(status).toContainText('3 words');
  await expect(status).toContainText('Saved');
});
