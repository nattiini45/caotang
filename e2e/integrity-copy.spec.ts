import { expect, test } from '@playwright/test';

import { binderTitle, createProject, loose } from './support.js';

/**
 * Writer-facing words (ui-modules §0.1, the copy review): no internal term reaches the writer, a file that is not a bundle is said
 * in plain words, and a complaint about a keyword goes when the keyword does.
 */

test('the first-run card says the key is encrypted, and its key control reads as a link', async ({ page }) => {
  await page.goto('/');
  const card = page.getByTestId('first-run');
  await expect(card).toContainText('It is kept in this browser, encrypted');
  await expect(card).not.toContainText('sealed');
  const key = card.getByRole('button', { name: 'add your provider key' });
  await expect(key).toBeVisible();
  await expect(key).toHaveCSS('text-decoration-line', 'underline');
});

test('a file that is not a bundle is refused in plain words', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('bundle-input').setInputFiles({
    name: 'notes.caotang',
    mimeType: 'application/zip',
    buffer: Buffer.from('not a zip file at all'),
  });
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('This file is not a Caotang bundle');
  await expect(alert).not.toContainText('invalid zip');
});

test('removing a keyword clears the complaint that its duplicate was refused', async ({ page }) => {
  await createProject(page, 'Keyword Book');
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await binderTitle(page, 'The Landing').click();

  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  const input = inspector.getByLabel('Add keyword');
  await input.fill('sea');
  await input.press('Enter');
  await input.fill('Sea');
  await input.press('Enter');
  await expect(inspector.getByText(loose('“Sea” is already a keyword here.'))).toBeVisible();

  await inspector.getByRole('button', { name: 'Remove keyword sea' }).click();
  await expect(inspector.getByText(loose('“Sea” is already a keyword here.'))).toHaveCount(0);
});

test('the demo provider is listed by what it is, not by its internal model id', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('settings');
  await expect(settings.getByText('Demo, no key')).toBeVisible();
  await expect(settings.getByText('mock/echo-1')).toHaveCount(0);
  await expect(settings.getByText('Keys are encrypted in this browser')).toBeVisible();
});
