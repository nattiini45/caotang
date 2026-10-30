/**
 * Bold CJK in the contact sheet (storyboard.md §6, #253). The sheet's header title is set in bold, so a project named in Chinese
 * prints its name in Noto Sans Mono CJK SC Bold, which the app fetches from its own origin only for such a sheet (its common file,
 * when every character is in it); the shot text in the cards is the Regular. Neither has the synthetic stroke (`2 Tr`), which is
 * the fallback when the Bold cannot be read. The PDF's page streams are compressed, so they are inflated here and read as text.
 */

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

import { expect, test, type Page } from '@playwright/test';

import { binderTitle, createProject, firstChapter } from './support.js';

/** Every stream of the file that inflates, as text: the page content among them. */
function streamsOf(file: Buffer): string[] {
  const text = file.toString('latin1');
  const streams: string[] = [];
  for (let at = text.indexOf('stream\n'); at >= 0; at = text.indexOf('stream\n', at + 1)) {
    if (text.slice(at - 3, at) === 'end') continue;
    const start = at + 'stream\n'.length;
    const end = text.indexOf('\nendstream', start);
    if (end < 0) break;
    try {
      streams.push(inflateSync(file.subarray(start, end)).toString('latin1'));
    } catch {
      // A stream that is not Flate (a font program is, an image may not be) is not a page.
    }
  }
  return streams;
}

/** The font files the page asked its own origin for, without Vite's hash. */
function watchFonts(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const name = new URL(request.url()).pathname.split('/').pop() ?? '';
    if (/\.(otf|ttf|woff2?)$/i.test(name)) seen.push(name.replace(/-[\w-]{8}(?=\.(woff|ttf))/, ''));
  });
  return seen;
}

/** The text-showing lines of a page set in a font resource (`/NotoCjk`, `/NotoCjkBold`), each under the last `Tf` before it. */
function runsIn(lines: readonly string[], resource: string): string[] {
  return lines.filter((line, index) => line.endsWith(' Tj') && new RegExp(`^/${resource}-?\\d* `).test(lines.slice(0, index).reverse().find((before) => before.endsWith(' Tf')) ?? ''));
}

async function makeUnder(page: Page, parent: string, item: string): Promise<void> {
  await binderTitle(page, parent).click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${parent}` }).getByRole('menuitem', { name: item }).click();
  await page.keyboard.press('Escape');
}

async function compileSheet(page: Page, project: string): Promise<{ file: Buffer; lines: string[] }> {
  await createProject(page, project);
  await makeUnder(page, await firstChapter(page), 'New storyboard here');
  await makeUnder(page, 'Storyboard', 'New shot here');
  const card = page.getByRole('article', { name: 'Shot 1: New shot' });
  await card.getByRole('button', { name: 'Edit the fields of shot 1' }).click();
  await page.getByRole('textbox', { name: 'Action', exact: true }).fill('草堂的早晨');
  await page.getByRole('button', { name: 'Save shot' }).click();

  await binderTitle(page, 'Storyboard').click();
  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: /^Only “Storyboard”/ }).check();
  await dialog.getByRole('radio', { name: /^Storyboard contact sheet \(\.pdf\)/ }).check();
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Compile', exact: true }).click()]);
  const file = readFileSync(await download.path());
  const pageContent = streamsOf(file).find((stream) => stream.includes(' Tj') && stream.includes(' Tf')) ?? '';
  expect(pageContent).not.toBe('');
  return { file, lines: pageContent.split('\n') };
}

test('a contact sheet of a project named in Chinese prints the name in the Bold face, and the shot text in the cards in the Regular', async ({ page }) => {
  const fonts = watchFonts(page);
  const { file, lines } = await compileSheet(page, '草堂的早晨');
  // The header title is set in the Bold, with no stroke; the action line is set in the Regular.
  expect(runsIn(lines, 'NotoCjkBold').length).toBeGreaterThan(0);
  expect(runsIn(lines, 'NotoCjk').length).toBeGreaterThan(0);
  expect(lines).not.toContain('2 Tr');
  const pdf = file.toString('latin1');
  expect(pdf).toMatch(/\/BaseFont \/CAOTCB\+NotoSansMonoCJKsc-Bold/);
  expect(pdf).toMatch(/\/BaseFont \/CAOTCJ\+NotoSansMonoCJKsc-Regular/);
  expect(pdf).not.toContain('CIDFontType0');
  // Every character is in the common files, so those are the ones fetched.
  expect([...new Set(fonts)].sort()).toEqual(['NotoSansMonoCJKsc-Bold-common.woff', 'NotoSansMonoCJKsc-Regular-common.woff']);
});

test('a contact sheet with CJK only in the cards does not fetch the Bold', async ({ page }) => {
  const fonts = watchFonts(page);
  const { file, lines } = await compileSheet(page, 'The Lighthouse');
  expect(runsIn(lines, 'NotoCjkBold')).toHaveLength(0);
  expect(runsIn(lines, 'NotoCjk').length).toBeGreaterThan(0);
  expect(file.toString('latin1')).not.toContain('NotoSansMonoCJKsc-Bold');
  expect([...new Set(fonts)]).toEqual(['NotoSansMonoCJKsc-Regular-common.woff']);
});
