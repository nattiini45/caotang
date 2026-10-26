/**
 * Colour emoji in the export dialog (screenplay.md §5.3, storyboard.md §6). Both PDFs have a Colour emoji checkbox: off by default for the
 * screenplay PDF, on by default for the contact sheet, kept in the recipe only when it differs from that default. The file it names is
 * Noto Color Emoji's vector pictures, which the app fetches from its own origin only for an export that holds an emoji and has colour on.
 * The PDF is read as text for the fonts it embeds: a colour emoji is a Type 3 font, a black-and-white one the Noto Emoji subset.
 */

import { readFileSync } from 'node:fs';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { binderTitle, createProject, firstChapter, waitForSaved } from './support.js';

const COLOUR = /^Colour emoji/;

/** The colour emoji files the page asked its own origin for. */
function watchColourFile(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const name = new URL(request.url()).pathname.split('/').pop() ?? '';
    if (/^NotoColorEmoji.*\.bin$/.test(name)) seen.push(name);
  });
  return seen;
}

async function makeUnder(page: Page, parent: string, item: string): Promise<void> {
  await binderTitle(page, parent).click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${parent}` }).getByRole('menuitem', { name: item }).click();
  await page.keyboard.press('Escape');
}

async function makeScene(page: Page, source: string): Promise<void> {
  await makeUnder(page, await firstChapter(page), 'New screenplay scene here');
  await page.getByRole('radio', { name: 'Source', exact: true }).click();
  await page.getByRole('textbox', { name: 'Fountain source' }).fill(source);
  await waitForSaved(page);
}

async function openScriptDialog(page: Page) {
  await binderTitle(page, 'Untitled scene').click();
  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: /^Only “Untitled scene”/ }).check();
  await dialog.getByRole('radio', { name: /^Screenplay PDF \(\.pdf\)/ }).check();
  return dialog;
}

async function compile(page: Page, dialog: Locator): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Compile', exact: true }).click()]);
  return readFileSync(await download.path(), 'latin1');
}

test('the screenplay PDF is black and white until Colour emoji is turned on, and then prints each emoji as a colour picture', async ({ page }) => {
  const files = watchColourFile(page);
  await createProject(page, 'Lamp Room');
  await makeScene(page, 'INT. KITCHEN - NIGHT\n\nA thumbs up 👍🏽 and a flag 🏳️‍🌈.\n');

  const dialog = await openScriptDialog(page);
  const colour = dialog.getByRole('checkbox', { name: COLOUR });
  await expect(colour).toBeVisible();
  await expect(colour).not.toBeChecked();
  // The words say why it is off, and that colour is how to get skin tones.
  await expect(dialog.getByText(/Scripts are usually printed in black and white/)).toBeVisible();
  await expect(dialog.getByText(/colour is how to get skin tones/)).toBeVisible();

  const mono = await compile(page, dialog);
  expect(mono).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoEmoji-Regular/);
  expect(mono).not.toContain('/Subtype /Type3');
  expect(files).toEqual([]);

  // Compiling closes the dialog; the next one is opened again and turned on there.
  const second = await openScriptDialog(page);
  await expect(second.getByRole('checkbox', { name: COLOUR })).not.toBeChecked();
  await second.getByRole('checkbox', { name: COLOUR }).check();
  const picture = await compile(page, second);
  expect(picture).toContain('/Subtype /Type3');
  expect(picture).not.toMatch(/\/BaseFont \/[A-Z]{6}\+NotoEmoji-Regular/);
  // The whole sequence comes back out of the file: 👍🏽 is U+1F44D U+1F3FD.
  expect(picture.startsWith('%PDF-')).toBe(true);
  expect(new Set(files).size).toBe(1);

  // The choice is kept in the recipe: it is still on when the dialog is opened again, and a Markdown compile does not offer it.
  const again = await openScriptDialog(page);
  await expect(again.getByRole('checkbox', { name: COLOUR })).toBeChecked();
  await again.getByRole('radio', { name: /^Markdown/ }).check();
  await expect(again.getByRole('checkbox', { name: COLOUR })).toHaveCount(0);
});

test('the contact sheet is in colour by default, keeps an explicit off, and prints the black-and-white font then', async ({ page }) => {
  await createProject(page, 'Picture Book');
  await makeUnder(page, await firstChapter(page), 'New storyboard here');
  await makeUnder(page, 'Storyboard', 'New shot here');
  const card = page.getByRole('article', { name: 'Shot 1: New shot' });
  await card.getByRole('button', { name: 'Edit the fields of shot 1' }).click();
  await page.getByRole('textbox', { name: 'Action', exact: true }).fill('Cut to 👍🏽 and 🇩🇪 and 🎬');
  await page.getByRole('button', { name: 'Save shot' }).click();

  const open = async () => {
    await binderTitle(page, 'Storyboard').click();
    await page.getByRole('button', { name: 'Compile…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await dialog.getByRole('radio', { name: /^Only “Storyboard”/ }).check();
    await dialog.getByRole('radio', { name: /^Storyboard contact sheet \(\.pdf\)/ }).check();
    return dialog;
  };

  const first = await open();
  await expect(first.getByRole('checkbox', { name: COLOUR })).toBeChecked();
  await expect(first.getByText(/On by default, because a contact sheet is a picture to look at/)).toBeVisible();
  const sheet = await compile(page, first);
  expect(sheet).toContain('/Subtype /Type3');
  expect(sheet).not.toMatch(/\/BaseFont \/[A-Z]{6}\+NotoEmoji-Regular/);

  const off = await open();
  await off.getByRole('checkbox', { name: COLOUR }).uncheck();
  const mono2 = await compile(page, off);
  expect(mono2).not.toContain('/Subtype /Type3');
  expect(mono2).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoEmoji-Regular/);

  // The explicit off is kept in the recipe; turning it on again removes it, and the sheet is in colour once more.
  const second = await open();
  await expect(second.getByRole('checkbox', { name: COLOUR })).not.toBeChecked();
  await second.getByRole('checkbox', { name: COLOUR }).check();
  expect(await compile(page, second)).toContain('/Subtype /Type3');
});
