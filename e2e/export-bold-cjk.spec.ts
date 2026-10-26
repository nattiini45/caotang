/**
 * Bold CJK in the contact sheet (storyboard.md §6). The sheet's header title is set in bold, and the CJK font has no Bold, so a
 * project named in Chinese prints its name with a synthetic stroke (`2 Tr`); the shot text in the cards is regular and has none.
 * The PDF's page streams are compressed, so they are inflated here and read as text.
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

async function makeUnder(page: Page, parent: string, item: string): Promise<void> {
  await binderTitle(page, parent).click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${parent}` }).getByRole('menuitem', { name: item }).click();
  await page.keyboard.press('Escape');
}

test('a contact sheet of a project named in Chinese prints the name in bold, and the shot text in the cards in regular weight', async ({ page }) => {
  await createProject(page, '草堂的早晨');
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
  const lines = pageContent.split('\n');
  // The header title is stroked, with the line width and spacing of its size and the stroke undone at the end of its run.
  const bold = lines.indexOf('2 Tr');
  expect(bold).toBeGreaterThan(0);
  expect(lines.slice(lines.lastIndexOf('q', bold), bold)).toContain('1 j');
  expect(lines[lines.indexOf('ET', bold) + 1]).toBe('Q');
  // The action line is CJK text too, and is not stroked: the page holds more CJK runs than stroked ones.
  const cjkRuns = lines.filter((line, index) => line.endsWith(' Tj') && lines.slice(0, index).reverse().find((before) => before.endsWith(' Tf'))?.startsWith('/NotoCjk'));
  const stroked = lines.filter((line) => line === '2 Tr').length;
  expect(stroked).toBeGreaterThan(0);
  expect(cjkRuns.length).toBeGreaterThan(stroked);
});
