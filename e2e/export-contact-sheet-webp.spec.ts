/**
 * A WebP picture on the storyboard contact sheet (storyboard.md §6). The PDF library embeds PNG and JPEG only, so the app decodes
 * the WebP on a canvas and hands the PDF a PNG. The app's CSP refuses WebAssembly, so no decoder runs in the page: the page is
 * checked for a CSP violation as well as for the picture in the file.
 */

import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { webpFixture } from '../packages/exporter/test/webp-fixtures.js';
import { binderTitle, createProject, firstChapter } from './support.js';

const PROJECT = 'Picture Book';
const fixture = (name: 'lossy' | 'alpha'): Buffer => Buffer.from(webpFixture(name));

async function makeUnder(page: Page, under: string, item: string): Promise<void> {
  const parent = under === 'Manuscript' ? await firstChapter(page) : under;
  await binderTitle(page, parent).click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${parent}` }).getByRole('menuitem', { name: item }).click();
  await page.keyboard.press('Escape');
}

/** A storyboard with one shot whose picture is `file`, chosen from the desktop. */
async function storyboardWithPicture(page: Page, name: string, mimeType: string, buffer: Buffer): Promise<void> {
  await createProject(page, PROJECT);
  await makeUnder(page, 'Manuscript', 'New storyboard here');
  await makeUnder(page, 'Storyboard', 'New shot here');
  const card = page.getByRole('article', { name: 'Shot 1: New shot' });
  await card.getByRole('button', { name: 'Edit the fields of shot 1' }).click();
  await page.getByLabel('Choose an image file for shot 1').setInputFiles({ name, mimeType, buffer });
  await expect(card.locator('img')).toBeVisible();
}

/** Compiles the storyboard as a contact sheet and gives the file as text, every byte of it ASCII. */
async function compileSheet(page: Page): Promise<string> {
  await binderTitle(page, 'Storyboard').click();
  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: /^Only “Storyboard”/ }).check();
  await dialog.getByRole('radio', { name: /^Storyboard contact sheet \(\.pdf\)/ }).check();
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Compile', exact: true }).click()]);
  return readFileSync(await download.path(), 'latin1');
}

test('a WebP picture on a shot is drawn on the contact sheet as one image, with no change to the CSP', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|wasm/i.test(message.text())) violations.push(message.text());
  });
  await storyboardWithPicture(page, 'frame.webp', 'image/webp', fixture('lossy'));
  const pdf = await compileSheet(page);

  expect(pdf.startsWith('%PDF-')).toBe(true);
  expect(pdf.match(/\/Subtype \/Image/g)).toHaveLength(1);
  // The picture is 96 × 64 pixels, below the cap for its card, so it is embedded at its own size.
  expect(pdf).toMatch(/\/Width 96\b/);
  expect(pdf).toMatch(/\/Height 64\b/);
  expect(violations).toEqual([]);
});

test('a WebP picture with transparency is drawn with its alpha as a soft mask', async ({ page }) => {
  await storyboardWithPicture(page, 'frame.webp', 'image/webp', fixture('alpha'));
  const pdf = await compileSheet(page);

  expect(pdf).toMatch(/\/Width 64\b/);
  expect(pdf).toContain('/SMask');
});
