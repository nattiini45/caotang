/**
 * The screenplay PDF's fallback fonts (screenplay.md §5.3). A script with Chinese text and an emoji prints them in the two
 * Noto files the contact sheet uses too (Arabic, Hebrew and Devanagari print in three more, below): the app fetches one CJK file (10.7 MB, not the 16 MB OTF it was) and one emoji file
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
    if (/\.(otf|ttf|woff2?)$/i.test(name)) seen.push(name.replace(/-[\w-]{8}(?=\.(woff|ttf))/, ''));
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

/** The font programs the PDF embeds, as the hex the writer stores them in: Courier Prime's first, then the CJK subset. */
function fontPrograms(pdf: string): string[] {
  return [...pdf.matchAll(/stream\n([0-9A-F\n]{400,})>/g)].map((match) => (match[1] ?? '').replaceAll('\n', ''));
}

async function setLanguage(page: Page, project: string, language: string): Promise<void> {
  await page.getByRole('button', { name: project }).click();
  const field = page.getByRole('textbox', { name: 'Language' });
  await field.fill(language);
  await field.press('Enter');
  await page.keyboard.press('Escape');
}

test('a Han character prints in the forms of the project language, and a reader still copies it back as typed', async ({ page }) => {
  const fonts = watchFonts(page);
  await createProject(page, PROJECT);
  await makeScene(page, 'INT. 部屋 - NIGHT\n\n直骨今說次。\n');
  const simplified = await compilePdf(page);
  await setLanguage(page, PROJECT, 'ja');
  const japanese = await compilePdf(page);
  await setLanguage(page, PROJECT, 'zh-CN');
  const chinese = await compilePdf(page);

  for (const pdf of [simplified, japanese, chinese]) {
    expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansMonoCJKsc-Regular/);
    // 直 is U+76F4, whatever form it is drawn in.
    expect(pdf).toContain('<76F4>');
  }
  const plain = fontPrograms(simplified).at(-1);
  expect(fontPrograms(simplified)).toHaveLength(2);
  // The Japanese forms are other glyphs; zh-CN is the font's own, as a project in English is.
  expect(fontPrograms(japanese).at(-1)).not.toBe(plain);
  expect(fontPrograms(chinese).at(-1)).toBe(plain);
  // One CJK file, whatever the language.
  expect([...new Set(fonts)]).toEqual(['NotoSansMonoCJKsc-Regular.woff']);
});

test('a script with a woman walking facing right prints her as one emoji that a reader copies back as typed', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeScene(page, 'INT. HALL - DAY\n\nShe walks off \u{1F6B6}‍♀️‍➡️.\n');
  const pdf = await compilePdf(page);

  expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoEmoji-Regular/);
  // The whole sequence is one CID's ToUnicode entry: the walking person, ZWJ, the female sign, ZWJ, the right arrow, with their selectors.
  expect(pdf).toContain('<D83DDEB6200D2640FE0F200D27A1FE0F>');
  // Not as the first emoji alone (the walking person), which the sequence printed as before.
  expect(pdf).not.toContain('<D83DDEB6>');
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

test('a script with Arabic and Hebrew loads the one Arabic file and the one Hebrew file under the unchanged CSP, and the PDF embeds both with the words as text', async ({ page }) => {
  const fonts = watchFonts(page);
  await createProject(page, PROJECT);
  await makeScene(page, 'INT. LIGHTHOUSE - NIGHT\n\nمرحبا بالعالم، هل رأيت الفيلم؟\n\n@דוד\n(בשקט)\nשלום עולם, מה שלומך?\n');
  const pdf = await compilePdf(page);

  expect(pdf.startsWith('%PDF-')).toBe(true);
  expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansArabic-Regular/);
  expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansHebrew-Regular/);
  expect(pdf).not.toContain('(?????) Tj');
  // The words carry no marked content: Poppler would spread it over the word and reverse it. Each glyph has the letter it draws in
  // the font's ToUnicode map instead, and a reader puts the word back in order. "שלום" is U+05E9 U+05DC U+05D5 U+05DD.
  expect(pdf).not.toContain('/ActualText <FEFF05E905DC05D505DD>');
  for (const letter of ['05E9', '05DC', '05D5', '05DD']) expect(pdf).toMatch(new RegExp(`<[0-9A-F]{4}> <${letter}>`));
  expect([...new Set(fonts)].sort()).toEqual(['NotoSansArabic-Regular.ttf', 'NotoSansHebrew-Regular.ttf']);
});

test('a script with Hindi loads the one Devanagari file, and the PDF embeds it with the words as text and no question marks', async ({ page }) => {
  const fonts = watchFonts(page);
  await createProject(page, PROJECT);
  await makeScene(page, 'INT. घर - NIGHT\n\nराम हिन्दी में क्षत्रिय श्रीमान् की बात करता है।\n\n@राम\nमैं हिन्दी बोलता हूँ। क्या आप भी बोलते हैं\n');
  const pdf = await compilePdf(page);

  expect(pdf.startsWith('%PDF-')).toBe(true);
  expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansDevanagari-Regular/);
  expect(pdf).not.toMatch(/\(\?+\) Tj/);
  // Each word is marked content that carries its typed text: हिन्दी is U+0939 U+093F U+0928 U+094D U+0926 U+0940, as UTF-16 hex.
  expect(pdf).toContain('/ActualText <FEFF0939093F0928094D09260940>');
  expect([...new Set(fonts)].sort()).toEqual(['NotoSansDevanagari-Regular.ttf']);
});
