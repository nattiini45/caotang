/**
 * **Import plain text…** and **Import RTF…** (issues #283, #274, #267): a manuscript file chosen in the binder opens in the shared
 * import preview, split by the splitter source into chapters and scenes, and Import writes it as one `binder.importTree` whose
 * documents are in the binder. Cancel writes nothing.
 */

import { expect, test, type Page } from '@playwright/test';

import { bodyOf, createProject, traceNames, treeOf, waitForSaved } from './support.js';

const MANUSCRIPT = [
  "THE KEEPER'S DAUGHTER",
  '',
  'For my father.',
  '',
  '',
  'CHAPTER ONE',
  '',
  'The ferry came at noon, as it always did, and Mara watched it',
  'cross the grey water from the lamp room.',
  '',
  '* * *',
  '',
  'By evening the wind had turned. She lit the lamp at six.',
  '',
  '',
  'CHAPTER TWO',
  '',
  'The letter arrived on a Tuesday.',
  '',
  '* * *',
  '',
  'She burned it in the stove.',
  '',
  '',
  'CHAPTER THREE',
  '',
  'Spring came late to the island. Mara counted the boats.',
  '',
].join('\r\n');

/** A 1×1 PNG, as hex for an RTF `\pict`. */
const PNG_HEX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('hex');

const RTF = [
  '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Times;}}',
  '{\\stylesheet{\\s0 Normal;}{\\s1 heading 1;}}',
  '{\\pard\\s1\\outlinelevel0 The Landing\\par}',
  '{\\pard The ferry came at noon. Mara watched it from the rocks.\\par}',
  `{\\pard{\\pict\\pngblip ${PNG_HEX}}\\par}`,
  '{\\pard\\s1\\outlinelevel0 Salt\\par}',
  '{\\pard Mara kept the \\ul light\\ul0 .\\par}',
  '{\\pard\\s1\\outlinelevel0 The Lantern\\par}',
  '{\\pard The lantern swung in the wind.\\par}',
  '}',
].join('\n');

async function choose(page: Page, label: string, name: string, text: string): Promise<void> {
  await page.locator(`input[type="file"][aria-label="${label}"]`).setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text, 'utf8') });
}

test('a plain-text manuscript opens split into chapters and scenes, and Import puts its documents in the binder as one step', async ({ page }) => {
  await createProject(page, 'Keeper Import');
  await choose(page, 'Plain text file', 'keeper.txt', MANUSCRIPT);

  const dialog = page.getByRole('dialog', { name: 'Import “keeper.txt”' });
  await expect(dialog).toBeVisible();
  const detected = dialog.locator('.import-preview-detected');
  await expect(detected).toContainText('3 chapters · 5 scenes');
  await expect(dialog.getByRole('note', { name: 'Split: chapter, because a “Chapter” line' })).toHaveCount(3);
  await expect(dialog.getByRole('note', { name: 'Split: scene, because scene break “* * *”' })).toHaveCount(2);

  // Cancel writes nothing.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await traceNames(page)).not.toContain('binder.importTree');

  await choose(page, 'Plain text file', 'keeper.txt', MANUSCRIPT);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Import 3 chapters' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);

  expect((await traceNames(page)).filter((name) => name === 'binder.importTree')).toHaveLength(1);
  const tree = await treeOf(page);
  const chapters = tree.filter((node) => node.parentId === 'manuscript' && node.type === 'folder').map((node) => node.title);
  expect(chapters).toEqual(expect.arrayContaining(['CHAPTER ONE', 'CHAPTER TWO', 'CHAPTER THREE']));
  const one = tree.find((node) => node.title === 'CHAPTER ONE');
  const scenes = tree.filter((node) => node.parentId === one?.id && node.type === 'document');
  expect(scenes.map((node) => node.title)).toEqual(['CHAPTER ONE · 1', 'CHAPTER ONE · 2']);
  expect(await bodyOf(page, scenes[0]?.id ?? '')).toContain('The ferry came at noon, as it always did, and Mara watched it cross the grey water from the lamp room.');
  // The text before chapter 1 goes to Research, never dropped.
  expect(tree.find((node) => node.title === 'Before chapter 1')?.parentId).toBe('research');
});

test('an RTF file opens split at its headings, and Import brings its documents and its picture into the binder', async ({ page }) => {
  await createProject(page, 'Lamp Import');
  await choose(page, 'RTF file', 'lamp.rtf', RTF);

  const dialog = page.getByRole('dialog', { name: 'Import “lamp.rtf”' });
  await expect(dialog.locator('.import-preview-detected')).toContainText('3 chapters');
  await expect(dialog.getByRole('checkbox', { name: 'Import 1 picture' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Import 3 chapters' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);

  const tree = await treeOf(page);
  const landing = tree.find((node) => node.title === 'The Landing' && node.type === 'folder');
  expect(landing?.parentId).toBe('manuscript');
  const scene = tree.find((node) => node.parentId === landing?.id && node.type === 'document');
  const body = await bodyOf(page, scene?.id ?? '');
  expect(body).toContain('The ferry came at noon.');
  expect(body).toMatch(/!\[[^\]]*\]\(\.\.\/assets\/a_[0-9A-Z]{10}\.png\)/);
  const salt = tree.find((node) => node.title === 'Salt' && node.type === 'folder');
  const saltScene = tree.find((node) => node.parentId === salt?.id && node.type === 'document');
  expect(await bodyOf(page, saltScene?.id ?? '')).toContain('*light*');
});
