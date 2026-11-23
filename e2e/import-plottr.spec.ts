/**
 * **Import Plottr…** (issue #290): a `.pltr` outline chosen in the binder opens in the shared import preview with its
 * beats as folders of scenes and its characters as codex entries, and Import writes the folders, scenes, codex
 * entries and Research documents as one `binder.importTree`. Cancel writes nothing.
 */

import { expect, test, type Page } from '@playwright/test';

import { createProject, traceNames, treeOf, waitForSaved } from './support.js';

// Plottr's own file shape, with invented text.
const OUTLINE = {
  file: { fileName: 'demo.pltr', version: '2023.7.14-beta.3' },
  series: { name: 'The Saga' },
  books: { 1: { id: 1, title: 'Book One' }, allIds: [1] },
  beats: {
    1: {
      children: { 'null': [10], 10: [11], 11: [] },
      heap: { 10: null, 11: 10 },
      index: {
        10: { id: 10, bookId: 1, position: 0, title: 'Act One' },
        11: { id: 11, bookId: 1, position: 0, title: 'Chapter One' },
      },
    },
  },
  cards: [
    {
      id: 1,
      beatId: 11,
      lineId: 5,
      position: 0,
      title: 'The Landing',
      description: [{ type: 'paragraph', children: [{ text: 'The ferry came at noon and ' }, { text: 'Mara', bold: true }, { text: ' watched.' }] }],
      tags: [9],
      characters: [1],
      places: [2],
    },
  ],
  lines: [
    { id: 5, bookId: 1, title: 'Main Plot' },
    { id: 6, bookId: 'series', title: 'The Arc' },
  ],
  characters: [
    { id: 1, name: 'Ada', description: 'The captain', notes: [{ type: 'paragraph', children: [{ text: 'Keeps the light.' }] }], tags: [], imageId: null, bookIds: [1], Rank: 'Captain' },
  ],
  places: [{ id: 2, name: 'The Harbour', description: '', notes: [], tags: [], imageId: null, bookIds: [1] }],
  notes: [{ id: 1, title: 'Ideas', content: [{ type: 'paragraph', children: [{ text: 'A storm chapter.' }] }], tags: [], bookIds: [] }],
  tags: [{ id: 9, title: 'STAGE: Setup' }],
  categories: {},
  images: {},
};

const choose = async (page: Page): Promise<void> => {
  await page.locator('input[type="file"][aria-label="Plottr file"]').setInputFiles({ name: 'demo.pltr', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(OUTLINE)) });
};

test('a Plottr outline offers its beats and characters, and Import writes them as one step', async ({ page }) => {
  await createProject(page, 'Plottr Import');
  await choose(page);

  const dialog = page.getByRole('dialog', { name: 'Import “demo.pltr”' });
  await expect(dialog).toBeVisible();
  const carried = dialog.getByRole('list', { name: 'What the outline carried' });
  await expect(carried).toContainText('1 card became a scene under its beat folder');
  await expect(carried).toContainText('2 characters and places are offered as codex entries');
  await expect(carried).toContainText('1 note became a Research document');
  const codex = dialog.getByRole('region', { name: 'Codex rows' });
  await expect(codex).toContainText('Ada');
  await expect(codex).toContainText('The Harbour');

  // Cancel writes nothing.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await traceNames(page)).not.toContain('binder.importTree');

  await choose(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /Import \d+ document/ }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);

  expect((await traceNames(page)).filter((name) => name === 'binder.importTree')).toHaveLength(1);
  const tree = await treeOf(page);
  const titles = tree.map((node) => node.title);
  expect(titles).toContain('Act One');
  expect(titles).toContain('Chapter One');
  expect(titles).toContain('The Landing');
  const research = tree.filter((node) => node.parentId === 'research').map((node) => node.title);
  expect(research).toContain('Ideas');

  await page.getByRole('tab', { name: 'Codex' }).click();
  const entries = page.getByRole('region', { name: 'Codex entries' });
  await expect(entries).toContainText('Ada');
  await expect(entries).toContainText('The Harbour');
});

test('a file that is not a Plottr outline is refused with a plain message', async ({ page }) => {
  await createProject(page, 'Plottr Refusal');
  await page.locator('input[type="file"][aria-label="Plottr file"]').setInputFiles({ name: 'notes.pltr', mimeType: 'application/json', buffer: Buffer.from('{"hello":"world"}') });
  await expect(page.getByText('This is not a Plottr outline.')).toBeVisible();
  expect(await traceNames(page)).not.toContain('binder.importTree');
});
