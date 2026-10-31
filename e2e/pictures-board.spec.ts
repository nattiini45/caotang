/**
 * The picture board and the Inspector's picture strip (pictures.md §5). Pictures come in by Choose, drop and paste, each one
 * `asset.importBatch`; every edit after is an `asset.*` command read back through the activity log and the hook's registry.
 *
 * A drop and a paste are dispatched as the browser's own `DragEvent` and `ClipboardEvent`, carrying a real `DataTransfer` of real `File`
 * objects, against the real handlers (see media-storyboard-images.spec.ts). The large photo is drawn on a canvas in the page, so the
 * working-copy path decodes and scales a real picture.
 */

import { writeFileSync } from 'node:fs';

import { expect, test, type Locator, type Page } from '@playwright/test';

import type { ReadAssetRecord } from '../packages/pictures/src/index.js';
import { createEmptyManifest, createProjectState, exportProjectZip } from '../packages/store/src/index.js';

import { asSent, bigPhoto, BLUE, GREEN, RED, registry, send, solidPng, undoLatest } from './pictures-support.js';
import { binderTitle, countOf, createProject, firstChapter, idOf, rejected, trace, waitForSaved } from './support.js';

const board = (page: Page): Locator => page.locator('section.pb-board');
const tiles = (page: Page): Locator => board(page).locator('.pb-tile');
const statusLine = (page: Page): Locator => page.locator('.status-line');

async function openBoard(page: Page): Promise<void> {
  await page.getByRole('radio', { name: 'Pictures', exact: true }).click();
  await expect(board(page)).toBeVisible();
}

async function importFiles(page: Page, files: readonly { name: string; mimeType: string; buffer: Buffer }[]): Promise<void> {
  await page.getByTestId('pictures-file-input').setInputFiles([...files]);
}

async function openDetails(page: Page, label: string): Promise<Locator> {
  await board(page).getByRole('button', { name: `Details of ${label}` }).click();
  // The panel is named by the picture's label, which a caption changes, so it is found by its place.
  const details = board(page).locator('aside.pb-details');
  await expect(details).toBeVisible();
  return details;
}

test('Choose imports pictures as one batch, shows them with the meter, and the same file again is already in the project', async ({ page }) => {
  await createProject(page, 'Board Book');
  await openBoard(page);
  await expect(board(page).getByRole('heading', { name: 'No pictures yet' })).toBeVisible();

  await importFiles(page, [RED, BLUE]);
  await expect(tiles(page)).toHaveCount(2);
  await expect(statusLine(page)).toContainText('Imported 2 pictures.');
  await expect(page.getByTestId('pictures-meter')).toContainText(/^2 pictures, .* in all\.$/);
  expect(await countOf(page, 'asset.importBatch')).toBe(1);
  expect((await registry(page)).records).toHaveLength(2);

  await importFiles(page, [RED]);
  await expect(statusLine(page)).toContainText('1 picture was already in the project.');
  await expect(tiles(page)).toHaveCount(2);
  expect((await registry(page)).records).toHaveLength(2);

  await undoLatest(page);
  expect((await registry(page)).records).toHaveLength(2);
});

test('a drop and a paste import too, a file that is not a picture is left out with its reason, and the tab does not open the file', async ({ page }) => {
  await createProject(page, 'Drop Book');
  await openBoard(page);
  const notes = { name: 'notes.txt', type: 'text/plain', bytes: Buffer.from('not a picture') };

  const dropped = await send(board(page), 'drop', [asSent(RED), notes]);
  expect(dropped.cancelled).toBe(true);
  await expect(tiles(page)).toHaveCount(1);
  await expect(statusLine(page)).toContainText('Imported 1 picture. 1 file was left out.');
  await expect(board(page).getByRole('listitem').filter({ hasText: 'notes.txt' })).toBeVisible();

  const pasted = await send(board(page), 'paste', [asSent(BLUE)]);
  expect(pasted.cancelled).toBe(true);
  await expect(tiles(page)).toHaveCount(2);
  expect(await countOf(page, 'asset.importBatch')).toBe(2);
});

test('a large photo asks once for the whole batch; Cancel writes nothing, and the choice is kept for what follows', async ({ page }) => {
  await createProject(page, 'Large Book');
  await openBoard(page);
  const first = await bigPhoto(page, 'wide-1.jpg', '#a33');
  const second = await bigPhoto(page, 'wide-2.jpg', '#33a');

  await importFiles(page, [first, second, RED]);
  const question = page.getByRole('dialog', { name: 'These pictures are large' });
  await expect(question).toBeVisible();
  await expect(question).toContainText('2 pictures are over 24 megapixels or 8 MB.');
  await question.getByRole('button', { name: 'Cancel' }).click();
  await expect(question).toBeHidden();
  await expect(statusLine(page)).toContainText('Nothing was imported.');
  expect((await registry(page)).records).toHaveLength(0);
  expect(await countOf(page, 'asset.importBatch')).toBe(0);
  expect((await rejected(page)).filter((row) => row.command === 'asset.importBatch')).toHaveLength(0);
  await expect(tiles(page)).toHaveCount(0);

  await importFiles(page, [first, second, RED]);
  await expect(question).toBeVisible();
  await question.getByRole('button', { name: 'Store 4096 px working copies' }).click();
  await expect(tiles(page)).toHaveCount(3);
  const { records } = await registry(page);
  expect(records.filter((record) => record.workingCopy)).toHaveLength(2);
  expect(Math.max(...records.map((record) => record.width ?? 0))).toBeLessThanOrEqual(4096);
  expect(await countOf(page, 'asset.importBatch')).toBe(1);

  const third = await bigPhoto(page, 'wide-3.jpg', '#3a3');
  await importFiles(page, [third]);
  await page.getByRole('dialog', { name: 'This picture is large' }).getByRole('button', { name: 'Keep originals' }).click();
  await expect(tiles(page)).toHaveCount(4);
  expect((await registry(page)).records.find((record) => record.file.length > 0 && record.width === 6000)).toBeDefined();
});

test('a caption, alt text and tags are edited in the details, each one undoable, and survive a reload', async ({ page }) => {
  await createProject(page, 'Caption Book');
  await openBoard(page);
  await importFiles(page, [RED]);
  await expect(tiles(page)).toHaveCount(1);

  const details = await openDetails(page, 'red.png');
  await details.getByLabel('Caption').fill('The signal lamp at dusk');
  await details.getByLabel('Alt text').fill('A red lamp');
  await details.getByLabel('Alt text').blur();
  await details.getByLabel('Add tags, separated by commas').fill('lamp, dusk');
  await details.getByRole('button', { name: 'Add tags' }).click();
  await expect.poll(async () => (await registry(page)).records[0]?.caption).toBe('The signal lamp at dusk');
  expect((await registry(page)).records[0]?.tags).toEqual(['lamp', 'dusk']);
  await expect(tiles(page).first().locator('.pb-caption')).toHaveText('The signal lamp at dusk');
  expect(await countOf(page, 'asset.setMeta')).toBeGreaterThanOrEqual(3);

  await details.getByLabel('Decorative: a reader who cannot see it misses nothing').check();
  await expect(tiles(page).first().locator('img')).toHaveAttribute('alt', '');

  await undoLatest(page);
  await expect(tiles(page).first().locator('img')).toHaveAttribute('alt', 'A red lamp');

  await waitForSaved(page);
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: 'Caption Book' }).getByRole('button', { name: 'Open' }).click();
  await openBoard(page);
  await expect(tiles(page).first().locator('.pb-caption')).toHaveText('The signal lamp at dusk');
  await expect(tiles(page).first().locator('img')).toBeVisible();
});

test('filters narrow the board by tag, by where a picture is placed and by unused, and Clear filters brings them back', async ({ page }) => {
  await createProject(page, 'Filter Book');
  await firstChapter(page);
  await openBoard(page);
  await importFiles(page, [RED, BLUE, GREEN]);
  await expect(tiles(page)).toHaveCount(3);

  await (await openDetails(page, 'red.png')).getByLabel('Add tags, separated by commas').fill('lamp');
  await board(page).getByRole('button', { name: 'Add tags', exact: true }).last().click();
  const chapterId = await idOf(page, 'Chapter 1');
  const placeOn = board(page).getByLabel('Place this picture on');
  await placeOn.selectOption(chapterId);
  await board(page).getByRole('button', { name: 'Place', exact: true }).click();
  await expect.poll(async () => (await registry(page)).links.length).toBe(1);

  const filters = board(page).getByRole('group', { name: 'Filter pictures' });
  await filters.getByLabel('Tag').selectOption('lamp');
  await expect(tiles(page)).toHaveCount(1);
  await expect(board(page).getByText('Showing 1 of 3 pictures.')).toBeVisible();
  await filters.getByRole('button', { name: 'Clear filters' }).click();
  await expect(tiles(page)).toHaveCount(3);

  // The placed picture is used; the other two are not.
  await filters.getByLabel('Unused').check();
  await expect(tiles(page)).toHaveCount(2);
  await filters.getByLabel('Unused').uncheck();
  await filters.getByLabel('Placed on').selectOption(chapterId);
  await expect(tiles(page)).toHaveCount(1);
  await expect(tiles(page).first()).toHaveAttribute('data-picture-tile', (await registry(page)).records[0]?.id ?? '');
  expect(await filters.getByLabel('Has a transcription').count()).toBe(0);
});

test('typing in the transcription search narrows the board, and clearing it brings the pictures back', async ({ page }, testInfo) => {
  // A project whose pictures already carry transcriptions, packed as a bundle and opened the way a writer opens one, so the
  // search reads what a saved project holds (timeline-view.spec.ts packs one the same way). Nothing here needs a provider.
  const now = new Date('2026-10-01T09:00:00.000Z');
  const state = createProjectState(createEmptyManifest('Search Book', now, { locale: 'en-US' }), { now });
  const picture = (id: string, caption: string, text?: string): ReadAssetRecord => ({
    id,
    file: `${id}.png`,
    mime: 'image/png',
    sha256: 'a'.repeat(64),
    bytes: 100,
    width: 8,
    height: 6,
    caption,
    transcription: text === undefined ? undefined : { at: now.toISOString(), text },
    createdAt: now.toISOString(),
  });
  const records = [
    picture('a_AAAAAAAAAA', 'Lamp', 'A red lamp glowing at dusk'),
    picture('a_BBBBBBBBBB', 'Harbour', 'cafe\u0301 au lait at the harbour'),
    picture('a_CCCCCCCCCC', 'Plain'),
  ];
  state.manifest.assets = records;
  const bundle = await exportProjectZip(state, {
    now,
    assets: Object.fromEntries(records.map((asset) => [`assets/${asset.file}`, Uint8Array.from(solidPng([200, 30, 30]))])),
  });
  const path = testInfo.outputPath('search-book.caotang');
  writeFileSync(path, bundle.bytes);
  await page.goto('/');
  await page.getByTestId('bundle-input').setInputFiles(path);
  await expect(page.getByRole('heading', { name: 'Search Book', level: 1 })).toBeVisible();

  await openBoard(page);
  await expect(tiles(page)).toHaveCount(3);

  const filters = board(page).getByRole('group', { name: 'Filter pictures' });
  const search = filters.getByLabel('Transcription text', { exact: true });
  await expect(search).toBeVisible();

  await search.fill('lamp');
  await expect(tiles(page)).toHaveCount(1);
  await expect(tiles(page).first()).toHaveAttribute('data-picture-tile', 'a_AAAAAAAAAA');
  await expect(board(page).getByText('Showing 1 of 3 pictures.')).toBeVisible();

  // The needle folds like the binder's text filter, so case and a composed é still find the decomposed one.
  await search.fill('CAFÉ');
  await expect(tiles(page)).toHaveCount(1);
  await expect(tiles(page).first()).toHaveAttribute('data-picture-tile', 'a_BBBBBBBBBB');

  await search.fill('zzz');
  await expect(tiles(page)).toHaveCount(0);
  await expect(board(page).getByRole('heading', { name: 'No picture matches these filters' })).toBeVisible();

  await search.fill('');
  await expect(tiles(page)).toHaveCount(3);
  await expect(board(page).getByText('Showing 1 of 3 pictures.')).toBeHidden();
});

test('several selected pictures are tagged and placed together, the thumbnail size changes the grid, and delete asks first and one Undo brings the picture back', async ({ page }) => {
  await createProject(page, 'Batch Book');
  await firstChapter(page);
  await openBoard(page);
  await importFiles(page, [RED, BLUE, GREEN]);
  await expect(tiles(page)).toHaveCount(3);

  await board(page).getByLabel('Select red.png').check();
  await board(page).getByLabel('Select blue.png').check();
  const batch = board(page).getByRole('group', { name: 'Selected pictures' });
  await expect(batch).toContainText('2 pictures selected');
  await batch.getByLabel('Tags to add to the selected pictures, separated by commas').fill('harbour');
  await batch.getByRole('button', { name: 'Tag selected' }).click();
  await expect(statusLine(page)).toContainText('Tagged 2 pictures.');
  expect((await registry(page)).records.filter((record) => record.tags.includes('harbour'))).toHaveLength(2);

  await batch.getByLabel('Place the selected pictures on').selectOption(await idOf(page, 'Chapter 1'));
  await batch.getByRole('button', { name: 'Place selected' }).click();
  await expect(statusLine(page)).toContainText('Placed 2 pictures.');
  expect((await registry(page)).links).toHaveLength(2);
  expect((await registry(page)).links.every((link) => link.role === 'reference')).toBe(true);

  await board(page).getByRole('radio', { name: /^S:/ }).click();
  await expect(board(page).locator('.pb-grid.zoom-S')).toBeVisible();
  await board(page).getByRole('radio', { name: /^L:/ }).click();
  await expect(board(page).locator('.pb-grid.zoom-L')).toBeVisible();

  const details = await openDetails(page, 'red.png');
  await expect(details).toContainText('Placed on');
  await details.getByRole('button', { name: 'Delete picture…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete red.png?' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('Its placements go with it:');
  await expect(confirm).toContainText('Placed on “Chapter 1”');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  expect((await registry(page)).records).toHaveLength(3);

  await details.getByRole('button', { name: 'Delete picture…' }).click();
  await confirm.getByRole('button', { name: 'Delete picture' }).click();
  await expect(tiles(page)).toHaveCount(2);
  expect((await registry(page)).links).toHaveLength(1);

  await undoLatest(page);
  await expect(tiles(page)).toHaveCount(3);
  expect((await registry(page)).links).toHaveLength(2);
});

test('a picture the project cannot read shows as missing with its caption and placements kept', async ({ page }) => {
  await createProject(page, 'Missing Book');
  await firstChapter(page);
  await openBoard(page);
  await importFiles(page, [RED]);
  const details = await openDetails(page, 'red.png');
  await details.getByLabel('Caption').fill('Kept caption');
  await details.getByLabel('Caption').blur();
  await expect.poll(async () => (await registry(page)).records[0]?.caption).toBe('Kept caption');
  await waitForSaved(page);

  await page.reload();
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('caotang-assets');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('assets', 'readwrite');
          tx.objectStore('assets').clear();
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await page.getByRole('listitem').filter({ hasText: 'Missing Book' }).getByRole('button', { name: 'Open' }).click();
  await openBoard(page);
  await expect(tiles(page)).toHaveCount(1);
  await expect(tiles(page).first().locator('.badge.is-warn')).toContainText('File missing');
  await expect(tiles(page).first().locator('.pb-caption')).toHaveText('Kept caption');
  await expect(tiles(page).first().locator('img')).toHaveCount(0);
  expect((await registry(page)).records).toHaveLength(1);
});

test('the Inspector strip links a picture to the selected item, makes it the card picture, keeps a note, and opens it on the board', async ({ page }) => {
  await createProject(page, 'Strip Book');
  await firstChapter(page);
  await openBoard(page);
  await importFiles(page, [RED, BLUE]);
  await expect(tiles(page)).toHaveCount(2);

  await binderTitle(page, 'Chapter 1').click();
  const strip = page.locator('.inspector').locator('section.pi-strip');
  await expect(strip).toContainText('No pictures are placed on this item.');
  await strip.getByLabel('Link a picture the project holds').selectOption({ label: 'red.png' });
  await strip.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(strip.locator('.pi-item')).toHaveCount(1);
  expect((await registry(page)).links[0]?.role).toBe('reference');

  await strip.getByRole('button', { name: 'Make red.png the card picture' }).click();
  await expect(strip.locator('.pi-item .badge')).toContainText('Card picture');
  const links = (await registry(page)).links;
  expect(links).toHaveLength(1);
  expect(links[0]?.role).toBe('card');

  const note = strip.getByLabel('Note for red.png on this item');
  await note.fill('Frontispiece');
  await note.blur();
  await expect.poll(async () => (await registry(page)).links[0]?.note).toBe('Frontispiece');
  expect(await countOf(page, 'asset.setLinkMeta')).toBe(1);

  await strip.getByRole('button', { name: 'Open red.png on the board' }).click();
  await expect(board(page).getByRole('complementary', { name: 'Details of red.png' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Pictures', exact: true })).toHaveAttribute('aria-checked', 'true');

  await binderTitle(page, 'Chapter 1').click();
  await page.locator('.inspector').getByRole('button', { name: 'Take red.png off this item' }).click();
  await expect(page.locator('.inspector').locator('.pi-item')).toHaveCount(0);
  expect((await registry(page)).links).toHaveLength(0);
  const names = (await trace(page)).map((row) => row.command);
  expect(names).toContain('asset.unlink');
});

test('the board is read in the same order in a right-to-left interface, and adds no sideways scrolling', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('caotang.pseudo', '1'));
  await createProject(page, 'RTL Book');
  await page.getByTestId('open-settings').focus();
  await page.keyboard.press('Enter');
  const settings = page.getByTestId('settings');
  await settings.locator('[data-section="appearance"]').click();
  await settings.locator('input[name="interface-language"][value="ar-XB"]').click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dir)).toBe('rtl');
  await settings.locator('.settings-head button').click();

  // The pseudo shell already scrolls sideways at this width, with no picture view open; the board must not add to it.
  const shellWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  await page.locator('#center-pictures').click();
  await expect(board(page)).toBeVisible();
  await page.getByTestId('pictures-file-input').setInputFiles([RED, BLUE]);
  await expect(tiles(page)).toHaveCount(2);
  await expect(tiles(page).first().locator('img')).toBeVisible();

  const first = await tiles(page).nth(0).boundingBox();
  const second = await tiles(page).nth(1).boundingBox();
  expect((first?.x ?? 0) > (second?.x ?? 0)).toBe(true);

  await tiles(page).first().locator('.pb-thumb').click();
  await expect(board(page).locator('.pb-details')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(shellWidth);
});
