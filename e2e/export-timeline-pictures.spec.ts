/**
 * The timeline PDF's pictures in the export dialog (timeline.md §8, §9.1). The Pictures control is offered for the timeline PDF only,
 * is kept in the recipe, and turns thumbnails on: without it the PDF holds no image, with it the scene's picture is drawn on its bar.
 * The PDF is read as text for its image objects, as the contact-sheet specs do. The project is made in Node and opened as a bundle.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { emptyCoherenceFile, serializeCoherenceFile, type CoherenceFile } from '../packages/coherence/src/index.js';
import { addDocument, createEmptyManifest, createProjectState, exportProjectZip } from '../packages/store/src/index.js';

const NOW = new Date('2026-10-01T09:00:00.000Z');
const SCENE = 'n_3W8RN2TQ6C';
const PICTURE = 'a_8K3QZ2M7RD';
const PROJECT = 'Pinned Book';

/** A 1×1 PNG, the smallest picture the store will take. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

async function openBook(page: Page, testInfo: TestInfo): Promise<void> {
  const state = createProjectState(createEmptyManifest(PROJECT, NOW, { locale: 'en-US' }), { now: NOW });
  addDocument(state, { id: SCENE, parentId: 'manuscript', title: 'The landing', body: 'The ferry was late.', now: NOW });
  state.manifest.assets = [{ id: PICTURE, file: `${PICTURE}.png`, mime: 'image/png', sha256: 'a'.repeat(64), bytes: PNG.length, width: 1, height: 1, alt: 'A lantern', createdAt: NOW.toISOString() }];
  state.manifest.assetLinks = [{ id: 'l_5H8QK2M9RT', assetId: PICTURE, target: { kind: 'node', nodeId: SCENE }, role: 'card', order: 10 }];
  const file: CoherenceFile = { ...emptyCoherenceFile(), sceneMeta: { [SCENE]: { dayOffset: 0, durationDays: 4 } }, findings: [] };
  const bundle = await exportProjectZip(state, { now: NOW, coherence: serializeCoherenceFile(file), assets: { [`assets/${PICTURE}.png`]: new Uint8Array(PNG) } });
  const path = testInfo.outputPath('pinned-book.caotang');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bundle.bytes);
  await page.goto('/');
  await page.getByTestId('bundle-input').setInputFiles(path);
  await expect(page.getByRole('heading', { name: PROJECT, level: 1 })).toBeVisible();
}

async function openDialog(page: Page) {
  await page.getByRole('button', { name: 'Compile…' }).click();
  return page.getByRole('dialog', { name: 'Export' });
}

test('the Pictures control is offered for the timeline PDF only, is kept, and draws the scene’s picture on its bar', async ({ page }, testInfo) => {
  await openBook(page, testInfo);

  const dialog = await openDialog(page);
  const pictures = dialog.getByRole('checkbox', { name: /^Pictures: show each scene/ });
  await dialog.getByRole('radio', { name: /^Timeline table \(\.csv\)/ }).check();
  await expect(pictures).toHaveCount(0);
  await dialog.getByRole('radio', { name: /^Timeline PDF/ }).check();
  await expect(pictures).toBeVisible();
  await expect(pictures).not.toBeChecked();

  // Off, the PDF holds no picture.
  const [plain] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Compile', exact: true }).click()]);
  expect(plain.suggestedFilename()).toContain('(timeline).pdf');
  const without = readFileSync(await plain.path(), 'latin1');
  expect(without.startsWith('%PDF-')).toBe(true);
  expect(without.match(/\/Subtype \/Image/g)).toBeNull();

  // On, the scene's picture is an image on its bar, and the choice is kept in the recipe.
  const second = await openDialog(page);
  await second.getByRole('radio', { name: /^Timeline PDF/ }).check();
  await second.getByRole('checkbox', { name: /^Pictures: show each scene/ }).check();
  const [thumbs] = await Promise.all([page.waitForEvent('download'), second.getByRole('button', { name: 'Compile', exact: true }).click()]);
  const withPictures = readFileSync(await thumbs.path(), 'latin1');
  expect(withPictures.match(/\/Subtype \/Image/g)?.length).toBeGreaterThan(0);

  const again = await openDialog(page);
  await again.getByRole('radio', { name: /^Timeline PDF/ }).check();
  await expect(again.getByRole('checkbox', { name: /^Pictures: show each scene/ })).toBeChecked();
});
