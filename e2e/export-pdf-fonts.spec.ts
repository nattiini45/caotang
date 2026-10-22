/**
 * The screenplay PDF's fallback fonts (screenplay.md §5.3). A script with Chinese text and an emoji prints them in the two
 * Noto files the contact sheet uses too: the app fetches one CJK file (7.2 MB, not the 16 MB OTF it was) and one emoji file
 * from its own origin, only for an export that needs them, and the PDF carries the characters as text a reader can copy.
 */

import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { binderTitle, createProject, firstChapter, waitForSaved } from './support.js';

const PROJECT = 'Lamp Room';

async function makeScene(page: Page, source: string): Promise<void> {
  const parent = await firstChapter(page);
  await binderTitle(page, parent).click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${parent}` }).getByRole('menuitem', { name: 'New screenplay scene here' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await page.getByRole('textbox', { name: 'Fountain source' }).fill(source);
  await waitForSaved(page);
}

/** Compiles the scene as a screenplay PDF and gives the file as text, every byte of it ASCII. */
async function compilePdf(page: Page): Promise<string> {
  await binderTitle(page, 'Untitled scene').click();
  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: /^Only “Untitled scene”/ }).check();
  await dialog.getByRole('radio', { name: /^Screenplay PDF \(\.pdf\)/ }).check();
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Compile', exact: true }).click()]);
  return readFileSync(await download.path(), 'latin1');
}

/** The font files the page asked its own origin for. */
function watchFonts(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const name = new URL(request.url()).pathname.split('/').pop() ?? '';
    if (/\.(otf|ttf|woff2?)$/i.test(name)) seen.push(name.replace(/-[\w-]{8}(?=\.woff)/, ''));
  });
  return seen;
}

test('a script with Chinese text and an emoji loads the one CJK file and the one emoji file, and the PDF embeds both as TrueType', async ({ page }) => {
  const fonts = watchFonts(page);
  await createProject(page, PROJECT);
  await makeScene(page, 'INT. 草堂 - NIGHT\n\nThe lamp turns 👍, tired 🫩.\n');
  const pdf = await compilePdf(page);

  expect(pdf.startsWith('%PDF-')).toBe(true);
  expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansMonoCJKsc-Regular/);
  expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoEmoji-Regular/);
  expect(pdf).toContain('/Subtype /CIDFontType2');
  expect(pdf).not.toContain('CIDFontType0');
  // The characters come back out of the file: their CIDs have ToUnicode entries.
  expect(pdf).toContain('<8349>');
  expect(pdf).toContain('<D83DDC4D>');
  // 🫩 is Emoji 16.0, in the font from 3.006 on.
  expect(pdf).toContain('<D83EDEE9>');
  expect([...new Set(fonts)].sort()).toEqual(['NotoEmoji-Regular.woff', 'NotoSansMonoCJKsc-Regular.woff']);
});

test('a Latin-only script loads no font', async ({ page }) => {
  const fonts = watchFonts(page);
  await createProject(page, PROJECT);
  await makeScene(page, 'INT. LIGHTHOUSE - NIGHT\n\nThe lamp turns.\n');
  const pdf = await compilePdf(page);

  expect(pdf).toContain('/BaseFont /CourierPrime');
  expect(pdf).not.toContain('CIDFontType2');
  expect(fonts).toEqual([]);
});
