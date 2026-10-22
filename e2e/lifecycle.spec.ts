import { expect, test, type Page } from '@playwright/test';

import { binderRow, bodyOf, createProject, FOLDER_ACCESS_ONLY, idOf, projectTrace, trace, waitForSaved, binderTitle } from './support.js';

/**
 * Projects outlive a tab: they are kept in the browser's store, listed, opened, exported as a
 * bundle, imported back, and removed only after the writer confirms. Undo reaches the last
 * change, and the typed text is one step of it.
 */

function binderToolbar(page: Page) {
  return page.getByRole('toolbar', { name: 'Binder actions' });
}

/** Leave the open project for the projects screen, the way the Projects button does. */
async function leaveProject(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Projects' }).click();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();
}

test('a scene survives a reload: the project is listed, and it opens with the text as it was typed', async ({ page }) => {
  await createProject(page, 'Keeps Me');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await binderToolbar(page).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Opening');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('It was a dark and stormy night.');
  await waitForSaved(page);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();
  await page.getByRole('listitem').filter({ hasText: 'Keeps Me' }).getByRole('button', { name: 'Open' }).click();

  await expect(binderRow(page, 'Opening')).toBeVisible();
  await binderTitle(page, 'Opening').click();
  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveText('It was a dark and stormy night.');
});

test('the projects screen offers the folder picker where the browser can open folders', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', FOLDER_ACCESS_ONLY);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open a folder…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import bundle (.caotang)' })).toBeVisible();
});

test('the projects screen hides the folder picker where the browser cannot open folders', async ({ page }) => {
  // A browser without the File System Access picker: the app's feature check reads this property, so it is
  // set to undefined before any page script runs. The bundle import stays, since it works everywhere.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Import bundle (.caotang)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open a folder…' })).toHaveCount(0);
  await expect(page.getByText(/needs a Chromium-based browser/)).toBeVisible();
});

test('a bundle exports as a .caotang, and imports back as a separate copy with a notice', async ({ page }) => {
  await createProject(page, 'Bundle Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await waitForSaved(page);
  await leaveProject(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export Bundle Book as a bundle' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.caotang$/);
  const path = await download.path();
  expect(path).not.toBeNull();

  await page.getByTestId('bundle-input').setInputFiles(path ?? '');

  // The bundle's id is already in this browser, so the import is a copy with its own id.
  await expect(page.getByRole('heading', { name: 'Bundle Book', level: 1 })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'separate copy' })).toBeVisible();
  await expect(binderRow(page, 'Chapter 1')).toBeVisible();
});

test('removing a project from the browser asks first, and then the list is empty', async ({ page }) => {
  await createProject(page, 'Going Away');
  await waitForSaved(page);
  await leaveProject(page);

  await page.getByRole('button', { name: 'Remove Going Away from this browser' }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove “Going Away” from this browser?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Going Away' })).toBeVisible();

  await page.getByRole('button', { name: 'Remove Going Away from this browser' }).click();
  await page.getByRole('dialog', { name: 'Remove “Going Away” from this browser?' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('heading', { name: 'No projects here yet' })).toBeVisible();
});

test('Undo takes back each change in turn, and a new document is removed by the last of them', async ({ page }) => {
  await createProject(page, 'Undo Book');
  // A document goes inside a chapter, so the chapter is made first.
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await expect(binderRow(page, 'Chapter 1')).toBeVisible();
  await binderToolbar(page).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Draft');
  await page.keyboard.press('Enter');
  await expect(binderRow(page, 'Draft')).toBeVisible();

  // Exact: the project's name is a button too, and this project's name contains the word "Undo".
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(binderRow(page, 'Untitled')).toBeVisible();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(binderRow(page, 'Untitled')).toHaveCount(0);

  const deletes = (await trace(page)).filter((row) => row.command === 'project.deleteNode');
  expect(deletes).toHaveLength(1);
  expect(deletes[0]?.issuedBy).toBe('user');
  expect(await projectTrace(page)).toContain('binder.rename');
});

test('the text typed into a scene is one step, and the Undo button takes it back', async ({ page }) => {
  await createProject(page, 'Typed Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await binderToolbar(page).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('Scene');
  await page.keyboard.press('Enter');
  const docId = await idOf(page, 'Scene');
  await page.getByRole('textbox', { name: 'Document text' }).fill('First words.');
  await waitForSaved(page);
  // The stored body is the editor's canonical Markdown (editor-engine §5), and a save always ends with a newline.
  expect(await bodyOf(page, docId)).toBe('First words.\n');

  await page.getByRole('button', { name: 'Undo' }).click();

  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveText('');
  await expect.poll(() => bodyOf(page, docId)).toBe('');
});

test('the save indicator reports saved once the scene is in the browser store', async ({ page }) => {
  await createProject(page, 'Indicator Book');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  await expect(page.getByTestId('save-state')).toContainText('saved in this browser');
});
