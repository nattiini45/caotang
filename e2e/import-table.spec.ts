/**
 * **Import spreadsheet…** (#288, #289): a table chosen in the binder opens in the shared import preview, the writer maps its columns,
 * and Import writes codex entries or timeline scenes as one undo step. The reads run in the real lazy reader Worker.
 */

import { expect, test, type Page } from '@playwright/test';

import { cell, xlsx } from '../packages/import-xlsx/test/fixtures/workbook.js';

import { bodyOf, createProject, traceNames, treeOf, waitForSaved } from './support.js';

async function choose(page: Page, name: string, text: string | Uint8Array): Promise<void> {
  const workbook = typeof text !== 'string';
  await page.locator('input[type="file"][aria-label="Spreadsheet file"]').setInputFiles({
    name,
    mimeType: workbook ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv',
    buffer: typeof text === 'string' ? Buffer.from(text, 'utf8') : Buffer.from(text),
  });
}

async function codexOf(page: Page): Promise<{ id: string; name: string; type: string; attachments: string[] }[]> {
  return page.evaluate(() => (globalThis as unknown as { __caotang?: { codex(): { id: string; name: string; type: string; attachments: string[] }[] } }).__caotang?.codex() ?? []);
}

async function sceneMetaOf(page: Page): Promise<Record<string, { dayOffset?: number; durationDays?: number; pov?: string; expectedPresent?: string[]; threads?: { id: string; payoff: string }[] }>> {
  return page.evaluate(() => (globalThis as unknown as { __caotang?: { sceneMeta(): Record<string, never> } }).__caotang?.sceneMeta() ?? {});
}

test('a codex CSV shows the row grid and type mapping, and imports entries and research pages as one step', async ({ page }) => {
  await createProject(page, 'Table Codex');
  const long = `Ada was born before the machine. ${'Her notes fill the archive. '.repeat(90)}`;
  const csv = `Name,Aliases,Type,Description,Long text,Tags,Include policy\n"Ada","A.;The Countess",person,"${long}","Analytical engines",math;inventor,private\n`;
  await choose(page, 'characters.csv', csv);

  const dialog = page.getByRole('dialog').last();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Rows become' })).toHaveValue('codex');
  await expect(dialog.getByRole('combobox', { name: 'Column Name becomes' })).toHaveValue('name');
  await expect(dialog.getByRole('combobox', { name: 'Column Type becomes' })).toHaveValue('type');
  await expect(dialog.getByRole('combobox', { name: 'Type “person” becomes' })).toHaveValue('character');
  await expect(dialog.getByRole('table').first()).toContainText('Analytical engines');
  await expect(dialog.getByRole('table').last()).toContainText('Ada');
  await expect(dialog.getByRole('button', { name: 'Import 1 row' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Import 1 row' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);
  expect((await traceNames(page)).filter((name) => name === 'binder.importTree')).toHaveLength(1);

  const tree = await treeOf(page);
  const pageNode = tree.find((node) => node.title === 'Ada' && node.type === 'document');
  expect(pageNode).toBeDefined();
  const pageBody = await bodyOf(page, pageNode?.id ?? '');
  expect(pageBody).toContain('Analytical engines');
  expect(pageBody).toContain('Her notes fill the archive.');
  const entries = await codexOf(page);
  expect(entries.find((entry) => entry.name === 'Ada')).toMatchObject({ type: 'character', attachments: [pageNode?.id] });

  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await waitForSaved(page);
  expect((await codexOf(page)).some((entry) => entry.name === 'Ada')).toBe(false);
  expect((await treeOf(page)).some((node) => node.title === 'Ada')).toBe(false);
});

test('a timeline TSV round trip maps hierarchy, days, people, locations and threads as scene declarations', async ({ page }) => {
  await createProject(page, 'Table Timeline');
  const rows = [
    ['reading index', 'part', 'title', 'folder path', 'day', 'duration days', 'pov', 'expected present', 'location', 'threads', 'summary', 'body'],
    ['0', 'main', 'Opening', 'Part 1 / Chapter 1', "'-14", '2', 'Ada', 'Ada, Bob', 'Harbour', 'Quest', 'The start', 'The ferry came.'],
    ['1', 'main', 'Aftermath', 'Part 1 / Chapter 1', "'-12", '1', 'Bob', 'Bob', 'Harbour', 'Quest', 'The result', 'Mara waved.'],
  ].map((row) => row.join('\t')).join('\n');
  await choose(page, 'timeline.tsv', rows);

  const dialog = page.getByRole('dialog').last();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Rows become' }).selectOption('timeline');
  await expect(dialog.getByRole('combobox', { name: 'Day zero' })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Column folder path becomes' })).toHaveValue('folder');
  await expect(dialog.getByRole('combobox', { name: 'Column expected present becomes' })).toHaveValue('participants');
  await expect(dialog.getByRole('combobox', { name: 'Column threads becomes' })).toHaveValue('arc');
  await expect(dialog.getByRole('button', { name: 'Import 2 rows' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Import 2 rows' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);
  expect((await traceNames(page)).filter((name) => name === 'binder.importTree')).toHaveLength(1);

  const tree = await treeOf(page);
  const part = tree.find((node) => node.title === 'Part 1');
  const chapter = tree.find((node) => node.title === 'Chapter 1' && node.parentId === part?.id);
  const opening = tree.find((node) => node.title === 'Opening' && node.parentId === chapter?.id);
  const aftermath = tree.find((node) => node.title === 'Aftermath' && node.parentId === chapter?.id);
  expect(opening).toBeDefined();
  expect(aftermath).toBeDefined();

  const entries = await codexOf(page);
  const ada = entries.find((entry) => entry.name === 'Ada');
  const bob = entries.find((entry) => entry.name === 'Bob');
  const harbour = entries.find((entry) => entry.name === 'Harbour');
  expect(ada?.type).toBe('character');
  expect(harbour?.type).toBe('location');
  expect(harbour?.attachments).toEqual(expect.arrayContaining([opening?.id ?? '', aftermath?.id ?? '']));

  const meta = await sceneMetaOf(page);
  expect(meta[opening?.id ?? '']).toMatchObject({ dayOffset: -14, durationDays: 2, pov: ada?.id, expectedPresent: [ada?.id, bob?.id] });
  expect(meta[opening?.id ?? '']?.threads?.[0]).toMatchObject({ id: 'Quest', payoff: aftermath?.id });
  expect(meta[aftermath?.id ?? '']).toMatchObject({ dayOffset: -12, durationDays: 1, pov: bob?.id });

  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await waitForSaved(page);
  expect(await sceneMetaOf(page)).toEqual({});
  expect((await codexOf(page)).some((entry) => entry.name === 'Ada')).toBe(false);
  expect((await treeOf(page)).some((node) => node.title === 'Opening')).toBe(false);
});

test('an Excel workbook offers its worksheets and imports the chosen sheet as timeline scenes', async ({ page }) => {
  await createProject(page, 'Table Workbook');
  const book = xlsx([
    { name: 'Bible', rows: [
      [cell('A1', '0', 's'), cell('B1', '1', 's')],
      [cell('A2', '2', 's'), cell('B2', 'A cartographer', 'inlineStr')],
    ] },
    { name: 'Timeline', rows: [
      [cell('A1', '3', 's'), cell('B1', '4', 's')],
      [cell('A2', '5', 's'), cell('B2', 'The ferry came at noon.', 'inlineStr')],
    ] },
  ], { shared: ['Name', 'Description', 'Elena', 'Title', 'Summary', 'The Landing'] });
  await choose(page, 'workbook.xlsx', book);

  const dialog = page.getByRole('dialog').last();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Worksheet' })).toHaveValue('Bible');
  await expect(dialog.getByRole('combobox', { name: 'Delimiter' })).toHaveCount(0);
  await dialog.getByRole('combobox', { name: 'Worksheet' }).selectOption('Timeline');
  await dialog.getByRole('combobox', { name: 'Rows become' }).selectOption('timeline');
  await expect(dialog.getByRole('table').first()).toContainText('The Landing');
  await expect(dialog.getByRole('button', { name: 'Import 1 row' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Import 1 row' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);
  expect((await traceNames(page)).filter((name) => name === 'binder.importTree')).toHaveLength(1);
  expect((await treeOf(page)).some((node) => node.title === 'The Landing')).toBe(true);

  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await waitForSaved(page);
  expect((await treeOf(page)).some((node) => node.title === 'The Landing')).toBe(false);
});

test('a changed column mapping is saved and reapplied to the same column layout', async ({ page }) => {
  await createProject(page, 'Table Mapping');
  const csv = 'Name,Description\nAda,First\n';
  await choose(page, 'characters.csv', csv);
  let dialog = page.getByRole('dialog').last();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Column Description becomes' }).selectOption('ignore');
  await expect(dialog.getByRole('combobox', { name: 'Column Description becomes' })).toHaveValue('ignore');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  await choose(page, 'characters-again.csv', 'Name,Description\nBob,Second\n');
  dialog = page.getByRole('dialog').last();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Column Description becomes' })).toHaveValue('ignore');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});
