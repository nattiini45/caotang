/**
 * The Twee import (dialogue-narrative.md §4). A Twine story format is a programming environment, so the import shows what it will
 * strip before it writes anything: cancelling leaves the project as it was, and confirming makes one container in one step.
 */

import { expect, test, type Page } from '@playwright/test';

import { binderTitle, createProject, traceNames, waitForSaved } from './support.js';

const PROJECT = 'Night Shift';

const TWEE = [
  ':: StoryTitle',
  'The Lantern',
  '',
  ':: StoryData',
  '{"ifid": "D674C58C-DEFA-4F70-B7A2-27742230C0FC", "format": "SugarCube", "format-version": "2.36.1", "start": "Gate"}',
  '',
  ':: Story JavaScript [script]',
  'setup.lamp = 3;',
  '',
  ':: Start',
  'The story opens here. [[Gate]]',
  '',
  ':: Gate',
  'The gate creaks.',
  '<<set $opened to true>>',
  '[[Enter the hall->The Hall]]',
  '',
  ':: The Hall',
  'A cold hall.',
  '',
].join('\n');

const HARLOWE = [
  ':: StoryData',
  '{"ifid": "D674C58C-DEFA-4F70-B7A2-27742230C0FC", "format": "Harlowe", "format-version": "3.3.8"}',
  '',
  ':: Start',
  'Go to [[the cellar->Cellar]].',
  '',
  ':: Cellar',
  'Damp.',
  '',
].join('\n');

async function chooseTwee(page: Page, name: string, text: string): Promise<void> {
  await page.locator('input[type="file"][aria-label="Twee file"]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
}

test('a Twee story shows its report before anything is written, and cancelling writes nothing', async ({ page }) => {
  await createProject(page, PROJECT);
  await chooseTwee(page, 'lantern.twee', TWEE);

  const dialog = page.getByRole('dialog', { name: 'Import this Twee story?' });
  await expect(dialog).toBeVisible();
  const report = dialog.getByRole('list', { name: 'What the import does' });
  await expect(report).toContainText('Story format: SugarCube 2.');
  await expect(report).toContainText('3 passages will become knots, with 2 choices.');
  await expect(report).toContainText('1 logic block stripped — Twine story formats are programming environments.');
  await expect(report).toContainText('1 special passage skipped: Story JavaScript.');

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(binderTitle(page, 'The Lantern')).toHaveCount(0);
  expect(await traceNames(page)).not.toContain('dialogue.importInk');
});

test('confirming the report makes one dialogue container in one step', async ({ page }) => {
  await createProject(page, PROJECT);
  await chooseTwee(page, 'lantern.twee', TWEE);

  const dialog = page.getByRole('dialog', { name: 'Import this Twee story?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();

  await expect(page.getByText(/Imported lantern\.twee as one dialogue container: 3 knots, 2 choices, 1 logic block stripped\./)).toBeVisible();
  await waitForSaved(page);
  await expect(binderTitle(page, 'The Lantern')).toBeVisible();
  const names = await traceNames(page);
  expect(names.filter((name) => name === 'dialogue.importInk')).toHaveLength(1);
});

test('a story in a format the reader does not know says it was imported as structure only', async ({ page }) => {
  await createProject(page, PROJECT);
  await chooseTwee(page, 'cellar.tw', HARLOWE);

  const dialog = page.getByRole('dialog', { name: 'Import this Twee story?' });
  await expect(dialog.getByRole('list', { name: 'What the import does' })).toContainText('Story format: Harlowe 3.3.8 (structure only).');
  await expect(dialog.getByRole('list', { name: 'What the import does' })).toContainText('1 link stripped to its text');
  await expect(dialog.getByRole('list', { name: 'Warnings' })).toContainText('This story uses Harlowe 3.3.8.');
});

test('a file with no passage is refused on the status line', async ({ page }) => {
  await createProject(page, PROJECT);
  await chooseTwee(page, 'empty.twee', ':: StoryTitle\nOnly a title\n');

  await expect(page.getByText(/empty\.twee has no passage to import\./)).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Import this Twee story?' })).toBeHidden();
});
