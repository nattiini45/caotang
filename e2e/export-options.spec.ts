import { readFileSync, writeFileSync } from 'node:fs';

import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { ZIP_ENGINE } from '../packages/store/src/index.js';
import { VIDEO_TEMPLATE_IDS } from '../packages/video-prompt-pack/src/index.js';

import { binderRow, createProject, waitForSaved } from './support.js';

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
 * exporter.md §2 and §5 with the recipe options: the dialogue table's character limit is a recipe setting, shown for the dialogue table
 * only and kept with the recipe; and a single item compiles with the recipe's title page, as a whole manuscript does.
 */

async function manuscriptWithScene(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill('The boat came in with the tide. Nobody was on it.');
  await waitForSaved(page);
}

test('the dialogue table’s character limit is a recipe setting: shown for that format, kept with the recipe, and set when the dialog opens again', async ({
  page,
}) => {
  await createProject(page, 'Character Limits');
  await manuscriptWithScene(page);

  await page.getByRole('button', { name: 'Compile…' }).click();
  let dialog = page.getByRole('dialog', { name: 'Export' });
  // The limit belongs to the dialogue table, so the field is not offered for the Markdown default.
  await expect(dialog.getByLabel('Character limit for each line')).toHaveCount(0);
  await dialog.getByRole('radio', { name: /^Dialogue table \(\.csv\)/ }).check();
  await dialog.getByLabel('Character limit for each line').fill('42');
  // The limit is saved when the writer leaves the field, as the author line is.
  await dialog.getByLabel('Character limit for each line').press('Tab');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole('button', { name: 'Compile…' }).click();
  dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: /^Dialogue table \(\.csv\)/ }).check();
  await expect(dialog.getByLabel('Character limit for each line')).toHaveValue('42');
  // The spreadsheet is the same table, so it reads the same limit.
  await dialog.getByRole('radio', { name: /^Dialogue table \(\.xlsx\)/ }).check();
  await expect(dialog.getByLabel('Character limit for each line')).toHaveValue('42');
});

test('the screenplay PDF’s scene numbers and (MORE)/(CONT’D) are recipe settings, shown for that format and kept with the recipe', async ({
  page,
}) => {
  await createProject(page, 'Screenplay PDF Settings');
  await manuscriptWithScene(page);

  await page.getByRole('button', { name: 'Compile…' }).click();
  let dialog = page.getByRole('dialog', { name: 'Export' });
  // Both settings belong to the screenplay PDF, so neither is offered for the Markdown default.
  await expect(dialog.getByLabel('Scene numbers')).toHaveCount(0);
  await dialog.getByRole('radio', { name: /^Screenplay PDF \(\.pdf\)/ }).check();
  await expect(dialog.getByLabel('Scene numbers')).toHaveValue('off');
  const continued = dialog.getByRole('checkbox', { name: /\(MORE\) and \(CONT’D\)/ });
  await expect(continued).toBeChecked();
  await dialog.getByLabel('Scene numbers').selectOption('both');
  await continued.uncheck();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole('button', { name: 'Compile…' }).click();
  dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: /^Screenplay PDF \(\.pdf\)/ }).check();
  await expect(dialog.getByLabel('Scene numbers')).toHaveValue('both');
  await expect(dialog.getByRole('checkbox', { name: /\(MORE\) and \(CONT’D\)/ })).not.toBeChecked();
});

test('a single item compiles with the recipe’s title page, as the whole manuscript does', async ({ page }) => {
  await createProject(page, 'Part Book');
  await manuscriptWithScene(page);
  await binderRow(page, 'The Landing').click();

  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: /^Only “The Landing”/ }).check();
  await dialog.getByRole('radio', { name: /^Plain text/ }).check();
  // The recipe's settings apply to one item too, so the title page is offered and set for it.
  await expect(dialog.getByRole('checkbox', { name: 'Title page' })).toBeEnabled();
  await expect(dialog.getByRole('checkbox', { name: 'Title page' })).toBeChecked();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Compile', exact: true }).click(),
  ]);
  const text = readFileSync((await download.path()) ?? '', 'utf8');
  expect(text, 'the title page names the project').toContain('Part Book');
  expect(text).toContain('The boat came in with the tide.');
});

/** The app's own bundle of the open project, as bytes. */
async function exportedBundle(page: Page): Promise<Uint8Array> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export bundle', exact: true }).click(),
  ]);
  return new Uint8Array(readFileSync((await download.path()) ?? ''));
}

/** The bundle as a project that predates recipes holds it: the same bundle with the manifest's `recipes` key taken out. */
async function bundleWithoutRecipes(testInfo: TestInfo, bytes: Uint8Array): Promise<string> {
  const { unzipSync, zipSync } = await ZIP_ENGINE.load();
  const entries = unzipSync(bytes);
  const good = entries['caotang.json'];
  if (good === undefined) throw new Error('the exported bundle has no caotang.json');
  const manifest = JSON.parse(new TextDecoder().decode(good)) as Record<string, unknown>;
  delete manifest['recipes'];
  entries['caotang.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const path = testInfo.outputPath('predates-recipes.caotang');
  writeFileSync(path, zipSync(entries));
  return path;
}

test('a project that predates recipes offers the Manuscript recipe it holds, and exports with it', async ({ page }, testInfo) => {
  // exporter.md §4: a project with no recipes key holds the default. The dialog offers it, so the compile must accept it.
  await createProject(page, 'Legacy Book');
  await manuscriptWithScene(page);
  const bundle = await exportedBundle(page);
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();

  await page.getByTestId('bundle-input').setInputFiles(await bundleWithoutRecipes(testInfo, bundle));
  await expect(page.getByRole('heading', { name: 'Legacy Book', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await expect(dialog.getByRole('combobox', { name: 'Recipe', exact: true })).toHaveValue('Manuscript');
  await dialog.getByRole('radio', { name: /^Plain text/ }).check();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Compile', exact: true }).click(),
  ]);
  const text = readFileSync((await download.path()) ?? '', 'utf8');
  expect(text).toContain('The boat came in with the tide.');
});

test('the prompt pack is offered in the Media group with a vendor choice, and a compile that names no vendor is refused in the dialog', async ({
  page,
}) => {
  await createProject(page, 'Pack Vendor');
  await manuscriptWithScene(page);
  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  // The vendor is asked for only when the pack is chosen.
  await expect(dialog.getByLabel('Vendor template')).toHaveCount(0);
  await dialog.getByRole('group', { name: 'Media' }).getByRole('radio', { name: /^Prompt pack \(video\)/ }).check();

  const vendor = dialog.getByLabel('Vendor template');
  // The seeded Manuscript recipe carries a layout template id; it is not a vendor, so none is chosen.
  await expect(vendor).toHaveValue('');
  const values = await vendor.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  expect(values).toEqual(['', ...VIDEO_TEMPLATE_IDS]);

  let downloaded = false;
  page.on('download', () => {
    downloaded = true;
  });
  await dialog.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('vendor template');
  await expect(dialog).toBeVisible();
  expect(downloaded).toBe(false);
});
