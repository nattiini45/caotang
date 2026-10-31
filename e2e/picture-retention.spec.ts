/**
 * Keeping pictures from being lost (pictures.md §2.3, §5, §6.5, §6.6): the picture-aware eviction banner, the monthly bundle reminder,
 * *Make document-level* for a picture that lost its paragraph, and the sweep offered before *Export bundle*.
 *
 * The notices read what the browser reports, so `navigator.storage` and `showDirectoryPicker` are set before any page script runs, the
 * way sessions.spec.ts and lifecycle.spec.ts do. What the writer answered is read back from the app database, where it is kept. A
 * project that already holds pictures, or a picture that lost its paragraph, is packed as a bundle and opened the way a writer opens
 * one. Nothing here needs a provider.
 */

import { writeFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { captureParagraphAnchor, type ReadAssetRecord } from '../packages/pictures/src/index.js';
import { addDocument, createEmptyManifest, createProjectState, exportProjectZip } from '../packages/store/src/index.js';

import { RED, registry, solidPng } from './pictures-support.js';
import { binderTitle, countOf, createProject, firstChapter, selectionOf, waitForSaved } from './support.js';

const MIB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const CHAPTER = 'n_7K2QX9M4A1';
const BODY = 'The ferry was late.\n\nThe keeper waited on the jetty.';

/** The browser has not promised to keep this site's storage. */
async function browserKeepsNothing(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const storage = (globalThis as unknown as { navigator: { storage?: object } }).navigator.storage;
    if (storage === undefined) return;
    const proto = Object.getPrototypeOf(storage) as Record<string, unknown>;
    proto['persisted'] = async () => false;
    proto['persist'] = async () => false;
  });
}

/** The browser has promised, so only the bundle reminder can speak. */
async function browserKeepsEverything(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const storage = (globalThis as unknown as { navigator: { storage?: object } }).navigator.storage;
    if (storage === undefined) return;
    const proto = Object.getPrototypeOf(storage) as Record<string, unknown>;
    proto['persisted'] = async () => true;
  });
}

async function withoutFolderAccess(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
  });
}

interface Pack {
  readonly name: string;
  readonly pictures: readonly { readonly id: string; readonly caption: string; readonly bytes: number }[];
  /** A placement that lost its paragraph, on the chapter. */
  readonly orphans?: readonly { readonly linkId: string; readonly assetId: string; readonly note?: string }[];
}

/** A project with a chapter, pictures of the sizes asked for, and placements that lost their paragraph, packed as a bundle. */
async function bundleOf(pack: Pack, path: string): Promise<void> {
  const now = new Date('2026-10-01T09:00:00.000Z');
  const state = createProjectState(createEmptyManifest(pack.name, now, { locale: 'en-US' }), { now });
  addDocument(state, { parentId: 'manuscript', title: 'Chapter 1', body: BODY, now, id: CHAPTER });
  const records: ReadAssetRecord[] = pack.pictures.map((picture) => ({
    id: picture.id,
    file: `${picture.id}.png`,
    mime: 'image/png',
    sha256: picture.id.slice(2).toLowerCase().padEnd(64, '0'),
    bytes: picture.bytes,
    width: 8,
    height: 6,
    caption: picture.caption,
    createdAt: now.toISOString(),
  }));
  state.manifest.assets = records;
  const anchor = captureParagraphAnchor(BODY, BODY.indexOf('The keeper'), 1);
  if (anchor === undefined) throw new Error('no paragraph to capture');
  state.manifest.assetLinks = (pack.orphans ?? []).map((orphan, index) => ({
    id: orphan.linkId,
    assetId: orphan.assetId,
    target: { kind: 'paragraph' as const, nodeId: CHAPTER, anchor, orphaned: true as const },
    role: 'reference' as const,
    order: 10 * (index + 1),
    ...(orphan.note === undefined ? {} : { note: orphan.note }),
  }));
  const bundle = await exportProjectZip(state, {
    now,
    assets: Object.fromEntries(records.map((record) => [`assets/${record.file}`, Uint8Array.from(solidPng([200, 30, 30]))])),
  });
  writeFileSync(path, bundle.bytes);
}

async function openBundle(page: Page, path: string, name: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('bundle-input').setInputFiles(path);
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

async function reopen(page: Page, name: string): Promise<void> {
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: name }).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

type Answer = { evictionDismissedAtBytes?: number; bundleRemindedAt?: number; bundleReminderOff?: boolean };

/** What the app database keeps for the open project's picture notices. */
async function answered(page: Page): Promise<Answer | null> {
  return page.evaluate(
    () =>
      new Promise<Answer | null>((resolve, reject) => {
        const id = (globalThis as unknown as { __caotang?: { projectId(): string | null } }).__caotang?.projectId();
        const open = indexedDB.open('caotang-app');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('kv', 'readonly').objectStore('kv').get(`picture-notices:${id}`);
          request.onsuccess = () => {
            db.close();
            const row = request.result as { value?: Answer | null } | undefined;
            resolve(row?.value ?? null);
          };
          request.onerror = () => reject(request.error);
        };
      }),
  );
}

/** Replaces what the app database keeps for the open project's picture notices. */
async function setAnswer(page: Page, answer: Answer): Promise<void> {
  await page.evaluate(
    (value) =>
      new Promise<void>((resolve, reject) => {
        const id = (globalThis as unknown as { __caotang?: { projectId(): string | null } }).__caotang?.projectId();
        const open = indexedDB.open('caotang-app');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put({ key: `picture-notices:${id}`, value });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    answer,
  );
}

/** The toolbar's Undo, which takes back the newest undo group, and waits for the group to be gone. */
async function undoNewest(page: Page): Promise<void> {
  const groups = () => page.evaluate(() => (globalThis as unknown as { __caotang?: { undoGroups(): number } }).__caotang?.undoGroups() ?? 0);
  const before = await groups();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(groups).toBe(before - 1);
}
const banner = (page: Page) => page.getByTestId('storage-banner');
const reminder = (page: Page) => page.getByTestId('bundle-reminder');

test.describe('the picture-aware eviction banner', () => {
  test('replaces the general banner once the project has pictures, and a dismissal lasts for the project across a reload', async ({ page }) => {
    await browserKeepsNothing(page);
    await createProject(page, 'Evict Book');

    // No pictures yet: the general banner, as before.
    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).not.toHaveAttribute('data-variant', 'pictures');
    await expect(banner(page)).toContainText('Your words are kept in this browser');

    await page.getByRole('radio', { name: 'Pictures', exact: true }).click();
    await page.getByTestId('pictures-file-input').setInputFiles([RED]);
    await expect.poll(async () => (await registry(page)).records.length).toBe(1);

    await expect(banner(page)).toHaveAttribute('data-variant', 'pictures');
    await expect(banner(page)).toContainText('Pictures are stored only in this browser');
    await expect(banner(page).getByRole('button', { name: 'Learn why' })).toHaveCount(0);
    // Chromium is not Safari: the seven-day rule is Safari's and is not said here.
    await expect(banner(page)).not.toContainText('Safari');
    await expect(banner(page)).not.toContainText('7 days');
    await waitForSaved(page);

    await banner(page).getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(banner(page)).toHaveCount(0);
    const kept = await answered(page);
    expect(kept?.evictionDismissedAtBytes).toBe((await registry(page)).records[0]?.bytes);

    // A new visit: the picture banner was answered for this project, and the general one does not take its place.
    await reopen(page, 'Evict Book');
    await expect(banner(page)).toHaveCount(0);
  });

  test('comes back once the pictures weigh twice what they did when it was dismissed, and not before', async ({ page }) => {
    await browserKeepsNothing(page);
    await createProject(page, 'Double Book');
    await page.getByRole('radio', { name: 'Pictures', exact: true }).click();
    await page.getByTestId('pictures-file-input').setInputFiles([RED]);
    await expect.poll(async () => (await registry(page)).records.length).toBe(1);
    await waitForSaved(page);
    const bytes = (await registry(page)).records[0]?.bytes ?? 0;
    expect(bytes).toBeGreaterThan(0);

    // Dismissed when they weighed just over half of what they weigh now: less than double, so it stays away.
    await setAnswer(page, { evictionDismissedAtBytes: Math.floor(bytes / 2) + 1 });
    await reopen(page, 'Double Book');
    await expect(banner(page)).toHaveCount(0);

    // Dismissed when they weighed half as much: now doubled, so it returns.
    await setAnswer(page, { evictionDismissedAtBytes: Math.floor(bytes / 2) });
    await reopen(page, 'Double Book');
    await expect(banner(page)).toHaveAttribute('data-variant', 'pictures');
  });
});

test.describe('the bundle reminder', () => {
  test('waits for 50 MB of pictures, is quiet for a month once dismissed, returns after it, and is off for good with one click', async ({ page }, testInfo) => {
    await browserKeepsEverything(page);
    await withoutFolderAccess(page);
    const small = testInfo.outputPath('small.caotang');
    const large = testInfo.outputPath('large.caotang');
    await bundleOf({ name: 'Small Book', pictures: [{ id: 'a_AAAAAAAAAA', caption: 'Lamp', bytes: 40 * MIB }] }, small);
    await bundleOf({ name: 'Large Book', pictures: [{ id: 'a_AAAAAAAAAA', caption: 'Lamp', bytes: 30 * MIB }, { id: 'a_BBBBBBBBBB', caption: 'Harbour', bytes: 30 * MIB }] }, large);

    await openBundle(page, small, 'Small Book');
    await expect(binderTitle(page, 'Chapter 1')).toBeVisible();
    await expect(reminder(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Projects', exact: true }).click();

    await page.getByTestId('bundle-input').setInputFiles(large);
    await expect(page.getByRole('heading', { name: 'Large Book', level: 1 })).toBeVisible();
    await expect(reminder(page)).toBeVisible();
    await expect(reminder(page)).toContainText('This project’s pictures take about 60.0 MB');
    await expect(reminder(page)).toContainText('this browser cannot save to a folder');

    await reminder(page).getByRole('button', { name: 'Remind me next month' }).click();
    await expect(reminder(page)).toHaveCount(0);
    const dismissed = await answered(page);
    expect(typeof dismissed?.bundleRemindedAt).toBe('number');
    expect(dismissed?.bundleReminderOff).toBeUndefined();

    // Quiet across a reload, for a month.
    await reopen(page, 'Large Book');
    await expect(reminder(page)).toHaveCount(0);
    const when = dismissed?.bundleRemindedAt ?? 0;
    await page.clock.setFixedTime(new Date(when + 29 * DAY));
    await reopen(page, 'Large Book');
    await expect(reminder(page)).toHaveCount(0);

    // A month later it is back, and one click turns it off for good.
    await page.clock.setFixedTime(new Date(when + 31 * DAY));
    await reopen(page, 'Large Book');
    await expect(reminder(page)).toBeVisible();
    await reminder(page).getByRole('button', { name: 'Turn this reminder off' }).click();
    await expect(reminder(page)).toHaveCount(0);
    expect((await answered(page))?.bundleReminderOff).toBe(true);
    await page.clock.setFixedTime(new Date(when + 400 * DAY));
    await reopen(page, 'Large Book');
    await expect(reminder(page)).toHaveCount(0);
  });

  test('exports a bundle from the reminder and then stays quiet for a month', async ({ page }, testInfo) => {
    await browserKeepsEverything(page);
    await withoutFolderAccess(page);
    const large = testInfo.outputPath('large.caotang');
    await bundleOf({ name: 'Export Book', pictures: [{ id: 'a_AAAAAAAAAA', caption: 'Lamp', bytes: 60 * MIB }] }, large);
    await openBundle(page, large, 'Export Book');
    await expect(reminder(page)).toBeVisible();

    const [download] = await Promise.all([page.waitForEvent('download'), reminder(page).getByRole('button', { name: 'Export a bundle' }).click()]);
    expect(download.suggestedFilename()).toMatch(/\.caotang$/);
    await expect(reminder(page)).toHaveCount(0);
    expect(typeof (await answered(page))?.bundleRemindedAt).toBe('number');
  });

  test('is not shown where the browser can save to a folder', async ({ page }, testInfo) => {
    test.skip(test.info().project.name !== 'chromium', 'Folder access is a Chromium feature.');
    await browserKeepsEverything(page);
    const large = testInfo.outputPath('large.caotang');
    await bundleOf({ name: 'Folder Book', pictures: [{ id: 'a_AAAAAAAAAA', caption: 'Lamp', bytes: 90 * MIB }] }, large);
    await openBundle(page, large, 'Folder Book');
    await expect(binderTitle(page, 'Chapter 1')).toBeVisible();
    await expect(reminder(page)).toHaveCount(0);
  });
});

test.describe('Make document-level', () => {
  const pack = (name: string): Pack => ({
    name,
    pictures: [{ id: 'a_AAAAAAAAAA', caption: 'The jetty', bytes: 100 }],
    orphans: [{ linkId: 'l_1AAAAAAAAA', assetId: 'a_AAAAAAAAAA', note: 'Arrival' }],
  });

  test('moves a picture that lost its paragraph onto the whole item, with its note, and one Undo puts it back', async ({ page }, testInfo) => {
    const path = testInfo.outputPath('lost.caotang');
    await bundleOf(pack('Lost Book'), path);
    await openBundle(page, path, 'Lost Book');
    await binderTitle(page, 'Chapter 1').click();

    const lost = page.locator('.inspector').getByTestId('lost-paragraphs');
    await expect(lost).toBeVisible();
    await expect(lost.getByRole('heading', { name: 'Lost their paragraph' })).toBeVisible();
    await expect(lost).toContainText('The jetty');
    await expect(lost.locator('del')).toHaveText('The keeper waited on the jetty.');
    expect((await registry(page)).links.map((link) => link.kind)).toEqual(['paragraph']);

    await lost.getByRole('button', { name: 'Make The jetty document-level' }).click();
    // The picture's name is the writer's own text, so the sentence isolates it from its surroundings.
    await expect(page.locator('.status-line')).toContainText(/\u2068The jetty\u2069 is now placed on the whole item\. Undo puts it back under its paragraph\./);
    await expect(lost).toHaveCount(0);

    const links = (await registry(page)).links;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ assetId: 'a_AAAAAAAAAA', kind: 'node', nodeId: CHAPTER, role: 'reference', note: 'Arrival' });
    const strip = page.locator('.inspector').locator('section.pi-strip');
    await expect(strip.locator('.pi-item')).toHaveCount(1);
    expect(await countOf(page, 'asset.makeDocumentLevel')).toBe(1);
    expect(await countOf(page, 'asset.link')).toBe(0);
    expect(await countOf(page, 'asset.unlink')).toBe(0);

    await undoNewest(page);
    await binderTitle(page, 'Chapter 1').click();
    await expect(page.locator('.inspector').getByTestId('lost-paragraphs')).toBeVisible();
    const back = (await registry(page)).links;
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ kind: 'paragraph', note: 'Arrival' });
  });

  test('is offered on the board for the same placement, and the button goes once it is done', async ({ page }, testInfo) => {
    const path = testInfo.outputPath('lost-board.caotang');
    await bundleOf(pack('Board Lost Book'), path);
    await openBundle(page, path, 'Board Lost Book');
    await page.getByRole('radio', { name: 'Pictures', exact: true }).click();
    const board = page.locator('section.pb-board');
    await board.getByRole('button', { name: 'Details of The jetty' }).click();
    const details = board.locator('aside.pb-details');
    await expect(details.getByText('Lost its paragraph')).toBeVisible();

    await details.getByRole('button', { name: 'Make document-level' }).click();
    await expect(details.getByText('Lost its paragraph')).toHaveCount(0);
    await expect(details.getByRole('button', { name: 'Make document-level' })).toHaveCount(0);
    expect((await registry(page)).links.map((link) => link.kind)).toEqual(['node']);
  });
});

test.describe('Re-pin', () => {
  const pack = (name: string): Pack => ({
    name,
    pictures: [
      { id: 'a_AAAAAAAAAA', caption: 'The jetty', bytes: 100 },
      { id: 'a_BBBBBBBBBB', caption: 'The chart', bytes: 100 },
    ],
    orphans: [
      { linkId: 'l_1AAAAAAAAA', assetId: 'a_AAAAAAAAAA', note: 'Arrival' },
      { linkId: 'l_2AAAAAAAAA', assetId: 'a_BBBBBBBBBB' },
    ],
  });
  const repinOf = (page: Page, title: string) => page.locator('.inspector').getByTestId('lost-paragraphs').getByRole('button', { name: `Re-pin ${title} to the selected paragraph` });

  test('is unavailable until the editor has a range selected, and refusing changes nothing', async ({ page }, testInfo) => {
    const path = testInfo.outputPath('repin-none.caotang');
    await bundleOf(pack('Repin None Book'), path);
    await openBundle(page, path, 'Repin None Book');
    await binderTitle(page, 'Chapter 1').click();

    const lost = page.locator('.inspector').getByTestId('lost-paragraphs');
    await expect(lost).toBeVisible();
    await expect(repinOf(page, 'The jetty')).toBeDisabled();
    await expect(repinOf(page, 'The chart')).toBeDisabled();
    await expect(lost).toContainText('Select text in the paragraph you want, in this document, to re-pin a picture to it.');

    // A bare caret is not a selection.
    await page.getByRole('textbox', { name: 'Document text' }).click();
    await page.keyboard.press('Control+Home');
    await expect(repinOf(page, 'The jetty')).toBeDisabled();

    expect(await countOf(page, 'asset.repin')).toBe(0);
    await expect(lost.locator('li')).toHaveCount(2);
    expect(await page.evaluate(() => (globalThis as unknown as { __caotang?: { undoGroups(): number } }).__caotang?.undoGroups() ?? 0)).toBe(0);
  });

  test('pins one lost picture to the selected paragraph, leaves the others lost, and one Undo puts it back', async ({ page }, testInfo) => {
    const path = testInfo.outputPath('repin.caotang');
    await bundleOf(pack('Repin Book'), path);
    await openBundle(page, path, 'Repin Book');
    await binderTitle(page, 'Chapter 1').click();

    const lost = page.locator('.inspector').getByTestId('lost-paragraphs');
    await expect(lost.locator('li')).toHaveCount(2);

    await page.getByRole('textbox', { name: 'Document text' }).click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Shift+End');
    await expect.poll(() => selectionOf(page)).toMatchObject({ docId: CHAPTER, from: 0, to: 'The ferry was late.'.length });
    await expect(repinOf(page, 'The jetty')).toBeEnabled();
    await expect(lost).toContainText('Re-pin attaches the picture to the paragraph the selected text starts in.');

    await repinOf(page, 'The jetty').click();
    await expect(page.locator('.status-line')).toContainText(/\u2068The jetty\u2069 is now pinned to the paragraph you selected\. Undo puts it back as it was\./);
    expect(await countOf(page, 'asset.repin')).toBe(1);
    await expect(lost.locator('li')).toHaveCount(1);
    await expect(lost).toContainText('The chart');
    await expect(lost).not.toContainText('The jetty');
    const links = (await registry(page)).links;
    expect(links).toHaveLength(2);
    expect(links.find((link) => link.id === 'l_1AAAAAAAAA')).toMatchObject({ kind: 'paragraph', nodeId: CHAPTER, note: 'Arrival' });

    await undoNewest(page);
    await binderTitle(page, 'Chapter 1').click();
    await expect(lost.locator('li')).toHaveCount(2);
    await expect(lost).toContainText('The jetty');
    expect((await registry(page)).links.map((link) => link.kind)).toEqual(['paragraph', 'paragraph']);
  });
});

test.describe('the sweep before Export bundle', () => {
  /** A file no picture, placement or saved copy names: a picture imported, deleted, saved, and the tab reloaded so no undo holds it. */
  async function strandAFile(page: Page, name: string): Promise<void> {
    await createProject(page, name);
    await firstChapter(page);
    await page.getByRole('radio', { name: 'Pictures', exact: true }).click();
    await page.getByTestId('pictures-file-input').setInputFiles([RED]);
    await expect.poll(async () => (await registry(page)).records.length).toBe(1);
    const board = page.locator('section.pb-board');
    await board.getByRole('button', { name: 'Details of red.png' }).click();
    await board.locator('aside.pb-details').getByRole('button', { name: 'Delete picture…' }).click();
    await page.getByRole('dialog', { name: 'Delete red.png?' }).getByRole('button', { name: 'Delete picture' }).click();
    await expect.poll(async () => (await registry(page)).records.length).toBe(0);
    await waitForSaved(page);
    await reopen(page, name);
  }

  test('offers the exact unused files first, exports without removing on request, and removes only on the second choice', async ({ page }) => {
    await strandAFile(page, 'Sweep Export Book');

    // Cancel: nothing is downloaded and nothing is removed.
    let downloads = 0;
    page.on('download', () => (downloads += 1));
    await page.getByRole('button', { name: 'Export bundle', exact: true }).click();
    const offer = page.getByRole('dialog', { name: 'Remove 1 unused file before exporting?' });
    await expect(offer).toBeVisible();
    await expect(offer.getByTestId('export-sweep-candidates').getByRole('listitem')).toHaveCount(1);
    await expect(offer.getByTestId('export-sweep-candidates')).toContainText(/a_[0-9A-Za-z]+\.png/);
    await expect(offer).toContainText('Removing them cannot be undone');
    await offer.getByRole('button', { name: 'Cancel' }).click();
    await expect(offer).toBeHidden();
    expect(downloads).toBe(0);

    // Export without removing: the bundle is made, and the file is still offered next time.
    await page.getByRole('button', { name: 'Export bundle', exact: true }).click();
    const [plain] = await Promise.all([page.waitForEvent('download'), offer.getByRole('button', { name: 'Export without removing' }).click()]);
    expect(plain.suggestedFilename()).toMatch(/\.caotang$/);
    await expect(page.locator('.status-line')).toContainText('Exported');
    await page.getByRole('button', { name: 'Export bundle', exact: true }).click();
    await expect(offer).toBeVisible();

    // Remove them, then export: the sweep runs first, the status line says so, and the file is gone for the next export.
    const [swept] = await Promise.all([page.waitForEvent('download'), offer.getByRole('button', { name: 'Remove them, then export' }).click()]);
    expect(swept.suggestedFilename()).toMatch(/\.caotang$/);
    await expect(page.locator('.status-line')).toContainText('Removed 1 unused file.');
    expect(await countOf(page, 'asset.sweep')).toBe(1);
    const [again] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export bundle', exact: true }).click()]);
    expect(again.suggestedFilename()).toMatch(/\.caotang$/);
    await expect(offer).toBeHidden();
  });

  test('goes straight to the export when no file is unused', async ({ page }) => {
    await createProject(page, 'No Sweep Book');
    await firstChapter(page);
    await page.getByRole('radio', { name: 'Pictures', exact: true }).click();
    await page.getByTestId('pictures-file-input').setInputFiles([RED]);
    await expect.poll(async () => (await registry(page)).records.length).toBe(1);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export bundle', exact: true }).click()]);
    expect(download.suggestedFilename()).toMatch(/\.caotang$/);
    await expect(page.getByRole('dialog', { name: /unused file/ })).toHaveCount(0);
    expect(await countOf(page, 'asset.sweep')).toBe(0);
  });
});
