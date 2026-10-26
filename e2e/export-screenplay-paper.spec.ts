/**
 * Paper size and Font in the export dialog (screenplay.md §5.3). The screenplay PDF offers both: Letter and Courier Prime are preselected
 * and left out of the recipe, A4 and Cousine are kept in it, and the file carries them. The contact sheet keeps its own Paper size
 * (A4 preselected) and has no Font. The PDF is read as text for its page boxes and fonts.
 */

import { readFileSync } from 'node:fs';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { binderTitle, createProject, firstChapter, waitForSaved } from './support.js';

async function makeScene(page: Page, source: string): Promise<void> {
  await binderTitle(page, await firstChapter(page)).click({ button: 'right' });
  await page.getByRole('menu', { name: /^Actions for / }).getByRole('menuitem', { name: 'New screenplay scene here' }).click();
  await page.keyboard.press('Escape');
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

const boxes = (pdf: string): string[] => [...new Set([...pdf.matchAll(/\/MediaBox \[([^\]]+)\]/g)].map((match) => match[1] ?? ''))];

test('the screenplay PDF offers Paper size and Font, keeps A4 and Cousine in the recipe, and writes them to the file', async ({ page }) => {
  await createProject(page, 'Lamp Room');
  await makeScene(page, 'INT. KITCHEN - NIGHT\n\nA lamp turns.\n');

  const dialog = await openScriptDialog(page);
  const paper = dialog.getByRole('combobox', { name: 'Paper size' });
  const font = dialog.getByRole('combobox', { name: 'Font' });
  // Letter in Courier Prime is what the screenplay PDF has always been, so it is what is preselected.
  await expect(paper).toHaveValue('Letter');
  await expect(font).toHaveValue('courier-prime');
  const plain = await compile(page, dialog);
  expect(boxes(plain)).toEqual(['0 0 612 792']);
  expect(plain).toContain('/BaseFont /CourierPrime');

  const second = await openScriptDialog(page);
  await second.getByRole('combobox', { name: 'Paper size' }).selectOption('A4');
  await second.getByRole('combobox', { name: 'Font' }).selectOption('cousine');
  const a4 = await compile(page, second);
  expect(boxes(a4)).toEqual(['0 0 595.28 841.89']);
  expect(a4).toContain('/BaseFont /Cousine-Regular');
  expect(a4).toContain('(INT. KITCHEN - NIGHT) Tj');

  // Both are kept in the recipe: they are still chosen when the dialog is opened again.
  const third = await openScriptDialog(page);
  await expect(third.getByRole('combobox', { name: 'Paper size' })).toHaveValue('A4');
  await expect(third.getByRole('combobox', { name: 'Font' })).toHaveValue('cousine');

  // The base-14 Courier embeds no font program.
  await third.getByRole('combobox', { name: 'Font' }).selectOption('courier');
  const courier = await compile(page, third);
  expect(courier).toContain('/BaseFont /Courier ');
  expect(courier).not.toContain('/FontFile2');
});

test('the Paper size control is the contact sheet’s too, with A4 preselected there, and Font is the screenplay PDF’s alone', async ({ page }) => {
  await createProject(page, 'Lamp Room');
  await makeScene(page, 'INT. KITCHEN - NIGHT\n\nA lamp turns.\n');

  const dialog = await openScriptDialog(page);
  await expect(dialog.getByRole('combobox', { name: 'Font' })).toBeVisible();
  await dialog.getByRole('radio', { name: /^Storyboard contact sheet \(\.pdf\)/ }).check();
  await expect(dialog.getByRole('combobox', { name: 'Paper size' })).toHaveValue('A4');
  await expect(dialog.getByRole('combobox', { name: 'Font' })).toHaveCount(0);
  await dialog.getByRole('radio', { name: /^Markdown/ }).check();
  await expect(dialog.getByRole('combobox', { name: 'Paper size' })).toHaveCount(0);
});
