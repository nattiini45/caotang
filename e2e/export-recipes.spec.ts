import { readFileSync, statSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { ZIP_ENGINE } from '../packages/store/src/index.js';
import { VIDEO_TEMPLATE_IDS } from '../packages/video-prompt-pack/src/index.js';

import { binderTitle, createProject, firstChapter, waitForSaved } from './support.js';

// React warns in the console when two siblings share a key. The dialog's author and character-limit fields were both keyed by the
// recipe's name ("Manuscript"), and a project could hold one recipe name twice for the picker. Every test here fails on that warning.
const duplicateKeys = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const seen: string[] = [];
  duplicateKeys.set(page, seen);
  page.on('console', (message) => {
    if (message.text().includes('Encountered two children with the same key')) seen.push(message.text());
  });
});
test.afterEach(({ page }) => {
  expect(duplicateKeys.get(page) ?? []).toEqual([]);
});

/**
 * exporter.md §2 and §5 as the export dialog shows them: every format the exporter ships, grouped prose then media; the
 * recipe a compile names, with its title-page, contents and author settings saved to that recipe; a new recipe saved from
 * the dialog and listed in its picker; and a multi-file compile downloaded as one zip.
 */

async function manuscriptWithScene(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The boat came in with the tide. Nobody was on it.');
  await waitForSaved(page);
}

test('the export dialog offers the prose formats, then the media formats, then the coherence report', async ({ page }) => {
  await createProject(page, 'Groups');
  await manuscriptWithScene(page);
  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });

  const prose = dialog.getByRole('group', { name: 'Prose' });
  const media = dialog.getByRole('group', { name: 'Media' });
  await expect(prose.getByRole('radio')).toHaveCount(4);
  await expect(media.getByRole('radio')).toHaveCount(10);
  await expect(media.getByRole('radio', { name: /^Shot list \(\.xlsx\)/ })).toBeVisible();
  await expect(media.getByRole('radio', { name: /^Storyboard contact sheet \(\.pdf\)/ })).toBeVisible();
  await expect(media.getByRole('radio', { name: /^Fountain \(\.fountain\)/ })).toBeVisible();
  await expect(media.getByRole('radio', { name: /^Screenplay PDF \(\.pdf\)/ })).toBeVisible();
  await expect(media.getByRole('radio', { name: /^Prompt pack \(video\)/ })).toBeVisible();
  await expect(dialog.getByRole('group', { name: 'Review' }).getByRole('radio')).toHaveCount(2);
});

test('a recipe’s title-page setting is saved to the recipe, and is still off when the dialog opens again', async ({ page }) => {
  await createProject(page, 'Recipe Settings');
  await manuscriptWithScene(page);
  await page.getByRole('button', { name: 'Compile…' }).click();
  let dialog = page.getByRole('dialog', { name: 'Export' });
  await expect(dialog.getByRole('combobox', { name: 'Recipe' })).toHaveValue('Manuscript');
  await dialog.getByRole('checkbox', { name: 'Title page' }).uncheck();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole('button', { name: 'Compile…' }).click();
  dialog = page.getByRole('dialog', { name: 'Export' });
  await expect(dialog.getByRole('checkbox', { name: 'Title page' })).not.toBeChecked();
});

test('settings saved as a new recipe are listed in the recipe picker and selected', async ({ page }) => {
  await createProject(page, 'New Recipe');
  await manuscriptWithScene(page);
  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('textbox', { name: 'Save these settings as a new recipe' }).fill('Beta read');
  await dialog.getByRole('button', { name: 'Save as recipe' }).click();

  const picker = dialog.getByRole('combobox', { name: 'Recipe' });
  await expect(picker).toHaveValue('Beta read');
  await expect(picker.locator('option')).toHaveText(['Manuscript', 'Beta read']);
});

test('a compile of the manuscript to EPUB downloads a non-empty book, named for the project', async ({ page }) => {
  await createProject(page, 'EPUB Book');
  await manuscriptWithScene(page);
  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: /^EPUB \(\.epub\)/ }).check();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Compile', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('EPUB Book.epub');
  const path = await download.path();
  expect(statSync(path ?? '').size).toBeGreaterThan(0);
});

/** Makes a node from the context menu of the row it goes under, and keeps its default title. */
async function makeUnder(page: Page, under: string, item: string): Promise<void> {
  const parent = under === 'Manuscript' ? await firstChapter(page) : under;
  await binderTitle(page, parent).click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${parent}` }).getByRole('menuitem', { name: item }).click();
  await page.keyboard.press('Escape');
}

test('a prompt pack recipe keeps its vendor, and compiling it downloads the three packs as one zip', async ({ page }) => {
  await createProject(page, 'Pack Recipe');
  await makeUnder(page, 'Manuscript', 'New storyboard here');
  await makeUnder(page, 'Storyboard', 'New shot here');
  await page.getByRole('article', { name: 'Shot 1: New shot' }).getByRole('button', { name: 'Edit the fields of shot 1' }).click();
  await page.getByLabel('Prompt: camera').fill('Slow dolly-in');
  await page.getByLabel('Prompt: subject').fill('Elena');
  await page.getByLabel('Clip length, seconds').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Save prompt' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved the prompt for' })).toBeVisible();
  const vendor = VIDEO_TEMPLATE_IDS[0] ?? '';

  await page.getByRole('button', { name: 'Compile…' }).click();
  let dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: /^Prompt pack \(video\)/ }).check();
  // A recipe for the pack with no vendor would only ever be refused, so it is not saved.
  await dialog.getByRole('textbox', { name: 'Save these settings as a new recipe' }).fill('Video pack');
  await dialog.getByRole('button', { name: 'Save as recipe' }).click();
  await expect(dialog.getByRole('alert')).toContainText('vendor template');
  await expect(dialog.getByRole('combobox', { name: 'Recipe' }).locator('option')).toHaveText(['Manuscript']);

  await dialog.getByLabel('Vendor template').selectOption(vendor);
  await dialog.getByRole('button', { name: 'Save as recipe' }).click();
  await expect(dialog.getByRole('combobox', { name: 'Recipe' })).toHaveValue('Video pack');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

  // The recipe is chosen from the picker again: its format and its vendor come back with it.
  await page.getByRole('button', { name: 'Compile…' }).click();
  dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('combobox', { name: 'Recipe' }).selectOption('Video pack');
  await expect(dialog.getByRole('radio', { name: /^Prompt pack \(video\)/ })).toBeChecked();
  await expect(dialog.getByLabel('Vendor template')).toHaveValue(vendor);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Compile', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('Video pack.zip');
  const { unzipSync } = await ZIP_ENGINE.load();
  const files = unzipSync(new Uint8Array(readFileSync((await download.path()) ?? '')));
  const names = Object.keys(files);
  expect(names.map((name) => name.slice(name.lastIndexOf('.'))).sort()).toEqual(['.csv', '.json', '.md']);
  expect(names.every((name) => name.includes(vendor))).toBe(true);
  const json = names.find((name) => name.endsWith('.json')) ?? '';
  expect(() => JSON.parse(new TextDecoder().decode(files[json]))).not.toThrow();
});
