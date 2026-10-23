/**
 * The paper sheet in the export dialog (storyboard.md §6, the paper-photo round trip). The contact sheet's own option row holds
 * Paper size and Paper frames; the second is offered for the contact sheet only, is kept in the recipe, and turns the pictures
 * into empty frames. The PDF is read as text for its image objects, as the WebP contact-sheet spec does.
 */

import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { binderTitle, createProject, firstChapter } from './support.js';

const PROJECT = 'Picture Book';
/** A 1×1 PNG, the smallest picture the store will take. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

async function makeUnder(page: Page, under: string, item: string): Promise<void> {
  const parent = under === 'Manuscript' ? await firstChapter(page) : under;
  await binderTitle(page, parent).click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${parent}` }).getByRole('menuitem', { name: item }).click();
  await page.keyboard.press('Escape');
}

async function openSheetDialog(page: Page) {
  await binderTitle(page, 'Storyboard').click();
  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: /^Only “Storyboard”/ }).check();
  return dialog;
}

test('the Paper frames control is offered for the contact sheet only, is kept, and prints empty frames in place of the pictures', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeUnder(page, 'Manuscript', 'New storyboard here');
  await makeUnder(page, 'Storyboard', 'New shot here');
  const card = page.getByRole('article', { name: 'Shot 1: New shot' });
  await card.getByRole('button', { name: 'Edit the fields of shot 1' }).click();
  await page.getByLabel('Choose an image file for shot 1').setInputFiles({ name: 'frame.png', mimeType: 'image/png', buffer: PNG });
  await expect(card.locator('img')).toBeVisible();

  const dialog = await openSheetDialog(page);
  const paper = dialog.getByRole('checkbox', { name: /^Paper frames/ });
  await dialog.getByRole('radio', { name: /^Markdown/ }).check();
  await expect(paper).toHaveCount(0);
  await dialog.getByRole('radio', { name: /^Storyboard contact sheet \(\.pdf\)/ }).check();
  await expect(paper).toBeVisible();
  await expect(paper).not.toBeChecked();

  // The picture sheet draws the shot's picture.
  const [picture] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Compile', exact: true }).click()]);
  expect(picture.suggestedFilename()).toContain('(contact sheet).pdf');
  // The 1×1 PNG has alpha, so its image object comes with a soft mask.
  expect(readFileSync(await picture.path(), 'latin1').match(/\/Subtype \/Image/g)?.length).toBeGreaterThan(0);

  // The sheet of frames draws none, and the choice is kept in the recipe: it is still on when the dialog is opened again.
  const second = await openSheetDialog(page);
  await second.getByRole('radio', { name: /^Storyboard contact sheet \(\.pdf\)/ }).check();
  await second.getByRole('checkbox', { name: /^Paper frames/ }).check();
  const [blank] = await Promise.all([page.waitForEvent('download'), second.getByRole('button', { name: 'Compile', exact: true }).click()]);
  expect(blank.suggestedFilename()).toContain('(paper frames).pdf');
  const text = readFileSync(await blank.path(), 'latin1');
  expect(text.startsWith('%PDF-')).toBe(true);
  expect(text.match(/\/Subtype \/Image/g)).toBeNull();

  const again = await openSheetDialog(page);
  await again.getByRole('radio', { name: /^Storyboard contact sheet \(\.pdf\)/ }).check();
  await expect(again.getByRole('checkbox', { name: /^Paper frames/ })).toBeChecked();
});
