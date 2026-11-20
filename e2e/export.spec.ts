import { readFileSync, statSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { createProject, waitForSaved } from './support.js';

/**
 * exporter.md §2 and §5: the manuscript compiles to each format the exporter writes, through the bus
 * (`export.compile`), and the file downloads. Each format has its own test, so a renderer that fails
 * names itself.
 */

/** A chapter, one scene with words in it, saved: enough manuscript for every renderer to have something to write. */
async function manuscriptWithScene(page: Page, text = 'The boat came in with the tide. Nobody was on it.'): Promise<void> {
  await page.getByRole('button', { name: 'Create Chapter 1' }).click();
  await page.getByRole('toolbar', { name: 'Binder actions' }).getByRole('button', { name: 'New document' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled' }).fill('The Landing');
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Document text' }).fill(text);
  await waitForSaved(page);
}

test('a prose PDF download embeds Bengali and wraps a word that fits on the next line', async ({ page }) => {
  const first = 'a'.repeat(57);
  await createProject(page, 'Prose PDF');
  await manuscriptWithScene(page, `${first} harbor বাংলা`);

  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: /^Prose PDF \(\.pdf\)/ }).check();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Compile', exact: true }).click(),
  ]);
  const pdf = readFileSync(await download.path(), 'latin1');
  expect(pdf).toContain(`(${first}) Tj`);
  expect(pdf).toMatch(/\(harbor ?\) Tj/);
  expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansBengali-Regular/);
  expect(/\/ActualText <(FEFF[0-9A-F]+)>/.exec(pdf)?.[1]).toBe('FEFF09AC09BE098209B209BE');
});

const FORMATS = [
  { label: /^Markdown \(\.md\)/, extension: 'md' },
  { label: /^Plain text \(\.txt\)/, extension: 'txt' },
  { label: /^Word \(\.docx\)/, extension: 'docx' },
  { label: /^EPUB \(\.epub\)/, extension: 'epub' },
] as const;

for (const format of FORMATS) {
  test(`the manuscript compiles to a non-empty .${format.extension} download`, async ({ page }) => {
    await createProject(page, `Export ${format.extension}`);
    await manuscriptWithScene(page);

    await page.getByRole('button', { name: 'Compile…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('radio', { name: format.label }).check();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: 'Compile', exact: true }).click(),
    ]);

    expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${format.extension}$`));
    const path = await download.path();
    expect(path).not.toBeNull();
    expect(statSync(path ?? '').size).toBeGreaterThan(0);
    // The dialog closes on a finished compile, the status line says what was written, and focus goes back to Compile….
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Exported' })).toContainText('1 scene');
    await expect(page.getByRole('button', { name: 'Compile…' })).toBeFocused();
  });
}

test('a selected item exports alone, through export.compileSelection, and the activity row says so', async ({ page }) => {
  await createProject(page, 'Part Export');
  await manuscriptWithScene(page);
  // The scene is the binder's selection: the dialog offers it as the part to export.
  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: /^Only “The Landing”/ }).check();
  await dialog.getByRole('radio', { name: /^Plain text \(\.txt\)/ }).check();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Compile', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.txt$/);

  await page.getByRole('tab', { name: 'Activity' }).click();
  const latest = page.getByRole('list', { name: 'Activity' }).getByRole('listitem').first();
  await expect(latest.locator('.activity-title')).toHaveText('Part of the manuscript exported');
});

test('the export is an activity row with its title, its digest and an undo', async ({ page }) => {
  await createProject(page, 'Logged Export');
  await manuscriptWithScene(page);

  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: /^Markdown \(\.md\)/ }).check();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Compile', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.md$/);

  await page.getByRole('tab', { name: 'Activity' }).click();
  const latest = page.getByRole('list', { name: 'Activity' }).getByRole('listitem').first();
  await expect(latest.locator('.activity-title')).toHaveText('Manuscript exported');
  await expect(latest.locator('.activity-summary')).toContainText('as md');
  await expect(latest.getByRole('button', { name: 'Undo' })).toBeVisible();
});

test('a compile the exporter refuses says why inside the dialog, beside Compile, and starts no download', async ({ page }) => {
  // A short window: the dialog is taller than it, so the refusal has to be inside the dialog to be read at all.
  await page.setViewportSize({ width: 1100, height: 640 });
  await createProject(page, 'Refused Export');
  // Prose only: a Fountain script has no screenplay scene to write, so the exporter refuses the compile at apply.
  await manuscriptWithScene(page);

  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: /^Fountain \(\.fountain\)/ }).check();
  let downloads = 0;
  page.on('download', () => {
    downloads += 1;
  });
  await dialog.getByRole('button', { name: 'Compile', exact: true }).click();

  const refusal = dialog.getByRole('alert');
  await expect(refusal).toContainText('the selection holds no screenplay scene');
  await expect(refusal).toBeInViewport();
  // The dialog stays open for the writer to change the format, and the status line under it does not repeat the refusal.
  await expect(dialog).toBeVisible();
  await expect(page.locator('.status-line').filter({ hasText: 'screenplay' })).toHaveCount(0);
  expect(downloads).toBe(0);

  // The refusal was about Fountain: once the writer chooses another format, it is no longer shown.
  await dialog.getByRole('radio', { name: /^Markdown \(\.md\)/ }).check();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('a refusal in the export dialog is taken away when the writer chooses another recipe', async ({ page }) => {
  await createProject(page, 'Refused Recipe');
  await manuscriptWithScene(page);

  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  // A second recipe to choose: saved from the dialog, which selects it.
  await dialog.getByRole('textbox', { name: 'Save these settings as a new recipe' }).fill('Draft');
  await dialog.getByRole('button', { name: 'Save as recipe' }).click();
  const picker = dialog.getByRole('combobox', { name: 'Recipe' });
  await expect(picker).toHaveValue('Draft');

  await dialog.getByRole('radio', { name: /^Fountain \(\.fountain\)/ }).check();
  await dialog.getByRole('button', { name: 'Compile', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('the selection holds no screenplay scene');

  await picker.selectOption('Manuscript');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});
