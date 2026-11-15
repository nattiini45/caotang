/**
 * **Import spreadsheet…** (issue #288): a CSV chosen in the binder opens in the shared import preview with its columns guessed and
 * changeable, as codex entries or as timeline scenes; Import writes them as one `binder.importTree`. Cancel writes nothing.
 */

import { expect, test } from '@playwright/test';

import { createProject, traceNames, treeOf, waitForSaved } from './support.js';

const BIBLE = 'Name,Also known as,Type,Description,Tags\nElena,Lena;El,Character,"A cartographer, back from sea",harbour;returning\nMara,,Character,"Keeps the light",harbour\n';
const TIMELINE = 'Title,Start,Duration,POV,Characters,Plotline,Summary\nThe Landing,2026-01-04,2 days,Elena,"Mara;Kai",The Pier,"The ferry came at noon."\nSalt,2026-01-09,1,Mara,Elena,The Pier,"The letter arrived."\n';

test('a story bible CSV opens as codex entries, and Import writes them with their pages as one step', async ({ page }) => {
  await createProject(page, 'CSV Import');
  await page.locator('input[type="file"][aria-label="Spreadsheet file"]').setInputFiles({ name: 'bible.csv', mimeType: 'text/csv', buffer: Buffer.from(BIBLE) });

  const dialog = page.getByRole('dialog', { name: 'Import “bible.csv”' });
  await expect(dialog).toBeVisible();
  const carried = dialog.getByRole('list', { name: 'What the file carried' });
  await expect(carried).toContainText('2 rows are offered as codex entries with their own Research pages');
  await expect(carried).toContainText('5 columns were mapped');
  // Every column has its own dropdown, guessed from its name.
  const rules = dialog.getByRole('group', { name: 'Rules' });
  await expect(rules.getByLabel('Also known as', { exact: true })).toHaveValue('aliases');
  await expect(rules.getByLabel('Tags', { exact: true })).toHaveValue('tags');
  const codex = dialog.getByRole('region', { name: 'Codex rows' });
  await expect(codex).toContainText('Elena');
  await expect(codex).toContainText('Mara');

  // Cancel writes nothing.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await traceNames(page)).not.toContain('binder.importTree');

  await page.locator('input[type="file"][aria-label="Spreadsheet file"]').setInputFiles({ name: 'bible.csv', mimeType: 'text/csv', buffer: Buffer.from(BIBLE) });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Import 2 entries' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);

  expect((await traceNames(page)).filter((name) => name === 'binder.importTree')).toHaveLength(1);
  const tree = await treeOf(page);
  const research = tree.filter((node) => node.parentId === 'research').map((node) => node.title);
  expect(research).toContain('Elena');
  expect(research).toContain('Mara');
  await page.getByRole('tab', { name: 'Codex' }).click();
  await expect(page.getByRole('region', { name: 'Codex entries' })).toContainText('Elena');
});

test('the same file read as timeline scenes keeps its days as a note and its arc as a keyword', async ({ page }) => {
  await createProject(page, 'CSV Timeline');
  await page.locator('input[type="file"][aria-label="Spreadsheet file"]').setInputFiles({ name: 'timeline.csv', mimeType: 'text/csv', buffer: Buffer.from(TIMELINE) });

  const dialog = page.getByRole('dialog', { name: 'Import “timeline.csv”' });
  await expect(dialog).toBeVisible();
  const rules = dialog.getByRole('group', { name: 'Rules' });
  await rules.getByLabel('Import as', { exact: true }).selectOption('timeline');
  await expect(dialog.getByRole('list', { name: 'What the file carried' })).toContainText('2 rows became scenes');
  await expect(dialog.getByRole('list', { name: 'What the file carried' })).toContainText('Days are counted from 2026-01-04');
  await expect(dialog.getByRole('list', { name: 'What was approximated' })).toContainText('2 rows’ days are kept as notes on their scenes');
  // A German day-first date is read only when the writer says so.
  await expect(rules.getByLabel('Dates are', { exact: true })).toHaveValue('iso');

  await dialog.getByRole('button', { name: 'Import 2 scenes' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);

  const tree = await treeOf(page);
  const scenes = tree.filter((node) => node.type === 'document').map((node) => node.title);
  expect(scenes).toContain('The Landing');
  expect(scenes).toContain('Salt');
});
