/**
 * The comic page editor and the two exports made from it in the browser, driven the way a writer drives them: real pointer drags on the
 * sheet, the inspector, the keyboard, Undo, a reload and a reopen, then Compile in the Export dialog and a look inside the downloaded CBZ
 * and fixed-layout EPUB. comics.md §3.3 (the editor) and §5 (the formats) are the contract.
 *
 * What these do not show: how a CBZ looks in a comic reader or the EPUB in an ebook reader. They read the files, and decode the CBZ's
 * page picture in the page to confirm the art and the lettering were drawn.
 */

import { readFile } from 'node:fs/promises';

import { expect, test, type Download, type Locator, type Page } from '@playwright/test';

import { RED, solidPng } from './pictures-support.js';
import { binderTitle, countOf, createProject, firstChapter, waitForSaved } from './support.js';
import { textEntry, zipEntries } from './zip-entries.js';

const PROJECT = 'Night Shift';

async function menuItem(page: Page, parent: string, item: string): Promise<void> {
  await binderTitle(page, parent).click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${parent}` }).getByRole('menuitem', { name: item }).click();
  await page.keyboard.press('Escape');
}

function sheetOf(page: Page): Locator {
  return page.getByRole('region', { name: /^Comic page / });
}

/** Open the first page of a new comic book in the page editor. A fresh page holds six empty panels. */
async function openFirstPage(page: Page): Promise<void> {
  await menuItem(page, await firstChapter(page), 'New comic here');
  await page.getByRole('button', { name: 'Expand Untitled comic' }).click();
  await binderTitle(page, 'Page 1').click();
  await page.getByRole('radio', { name: 'Editor', exact: true }).click();
  await expect(sheetOf(page)).toBeVisible();
}

/** The viewport is tall enough for the whole sheet, so a pointer gesture never lands behind the app's own header. */
async function newComicPage(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 1500 });
  await createProject(page, PROJECT);
  // The browser-storage notice sits over the top of the sheet in a tall pane and takes the press meant for a top-row balloon.
  await page.getByTestId('storage-banner').getByRole('button', { name: 'Dismiss' }).click();
  await openFirstPage(page);
  await expect(sheetOf(page).locator('.comic-panel-g')).toHaveCount(6);
}

const panelOf = (page: Page, number: number): Locator => sheetOf(page).locator('.comic-panel-g').nth(number - 1);
const frameOf = (page: Page, number: number): Locator => panelOf(page, number).locator('.comic-panel-frame');
const balloons = (page: Page): Locator => sheetOf(page).locator('.comic-balloon-g');

interface Frame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A shape's drawn rectangle in the sheet's own millimetres, which a zoom or a resize of the window does not change. */
async function drawn(shape: Locator): Promise<Frame> {
  const [x, y, width, height] = await Promise.all(['x', 'y', 'width', 'height'].map(async (name) => Number(await shape.getAttribute(name))));
  return { x: x ?? NaN, y: y ?? NaN, width: width ?? NaN, height: height ?? NaN };
}

async function centreOf(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('the shape has no box on the screen');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** One drag with the pointer: press at a point, move in steps, release. The editor writes one command at release. */
async function dragFrom(page: Page, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
  await page.mouse.up();
}

/**
 * Select a panel with a real click on it. A press that moves nothing is a selection, not a change: it opens the panel's inspector and its
 * handles, puts no `comic.setPage` in the log and shows no refusal.
 */
async function selectPanel(page: Page, number: number): Promise<void> {
  const before = await countOf(page, 'comic.setPage');
  const at = await centreOf(frameOf(page, number));
  await page.mouse.click(at.x, at.y);
  await expect(panelOf(page, number)).toHaveClass(/is-selected/);
  await expect(page.getByRole('region', { name: `Panel ${number}`, exact: true })).toBeVisible();
  await expect(panelOf(page, number).locator('.comic-handle')).toHaveCount(8);
  await expect(panelOf(page, number)).toBeFocused();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await countOf(page, 'comic.setPage')).toBe(before);
}

/** Select a balloon with a real click on its lettering, with the same promise as selectPanel. */
async function selectBalloon(page: Page, balloon: Locator, number: number): Promise<void> {
  const before = await countOf(page, 'comic.setPage');
  const at = await centreOf(balloon.locator('.comic-balloon-text'));
  await page.mouse.click(at.x, at.y);
  await expect(balloon).toHaveClass(/is-selected/);
  await expect(page.getByRole('region', { name: `Balloon ${number}`, exact: true })).toBeVisible();
  await expect(balloon.locator('.comic-handle')).toHaveCount(8);
  await expect(balloon).toBeFocused();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await countOf(page, 'comic.setPage')).toBe(before);
}

const balloonText = (page: Page): Locator => page.getByRole('textbox', { name: 'Text' });

test.describe('the comic page editor', () => {
  test('a selected panel is resized by its handle, moved by dragging, and each gesture is one undoable step', async ({ page }) => {
    await newComicPage(page);
    await selectPanel(page, 1);
    const original = await drawn(frameOf(page, 1));

    // Resize: the east handle, pulled left, narrows the panel and leaves its left edge and its height alone.
    const handles = panelOf(page, 1).locator('.comic-handle');
    await expect(handles).toHaveCount(8);
    const east = await centreOf(handles.nth(3));
    await dragFrom(page, east, -90, 0);
    await expect.poll(() => countOf(page, 'comic.setPage')).toBe(1);
    const narrowed = await drawn(frameOf(page, 1));
    expect(narrowed.width).toBeLessThan(original.width - 1);
    expect(narrowed.x).toBeCloseTo(original.x, 1);
    expect(narrowed.height).toBeCloseTo(original.height, 1);
    // The panel stays selected, with its handles, so the writer can go on.
    await expect(panelOf(page, 1)).toHaveClass(/is-selected/);

    // Move: dragging the body carries the whole panel into the room the resize left.
    const body = await centreOf(frameOf(page, 1));
    await dragFrom(page, { x: body.x, y: body.y + 30 }, 40, 0);
    await expect.poll(() => countOf(page, 'comic.setPage')).toBe(2);
    const moved = await drawn(frameOf(page, 1));
    expect(moved.x).toBeGreaterThan(narrowed.x + 1);
    expect(moved.width).toBeCloseTo(narrowed.width, 1);
    expect(moved.height).toBeCloseTo(narrowed.height, 1);

    // Undo takes back the move alone, then the resize alone.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await drawn(frameOf(page, 1))).x).toBeCloseTo(narrowed.x, 1);
    expect((await drawn(frameOf(page, 1))).width).toBeCloseTo(narrowed.width, 1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await drawn(frameOf(page, 1))).width).toBeCloseTo(original.width, 1);
    await expect(sheetOf(page)).toContainText('6 panels');
  });

  test('a one per cent arrow nudge on a gutter-aligned panel stays where it was put, one undo step each', async ({ page }) => {
    await newComicPage(page);
    await selectPanel(page, 4);
    const original = await drawn(frameOf(page, 4));
    const onePercentMm = 0.01 * 152.4;

    await page.keyboard.press('Shift+ArrowLeft');
    await expect.poll(() => countOf(page, 'comic.setPage')).toBe(1);
    const widened = await drawn(frameOf(page, 4));
    expect(widened.x).toBeCloseTo(original.x - onePercentMm, 2);
    expect(widened.width).toBeCloseTo(original.width + onePercentMm, 2);
    expect(widened.y).toBeCloseTo(original.y, 2);

    await page.keyboard.press('ArrowDown');
    await expect.poll(() => countOf(page, 'comic.setPage')).toBe(2);
    const lowered = await drawn(frameOf(page, 4));
    expect(lowered.y).toBeCloseTo(widened.y + 0.01 * 244.475, 2);
    expect(lowered.x).toBeCloseTo(widened.x, 2);
    expect(lowered.height).toBeCloseTo(widened.height, 2);
    await expect(page.getByRole('alert')).toHaveCount(0);

    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await undo.click();
    await expect.poll(async () => (await drawn(frameOf(page, 4))).y).toBeCloseTo(widened.y, 2);
    await undo.click();
    await expect.poll(async () => (await drawn(frameOf(page, 4))).x).toBeCloseTo(original.x, 2);
    expect((await drawn(frameOf(page, 4))).width).toBeCloseTo(original.width, 2);
  });

  test('the keyboard changes the reading order, adds a balloon and removes a panel, and Undo restores them', async ({ page }) => {
    await newComicPage(page);
    await selectPanel(page, 2);

    // Alt with an arrow moves the panel in the reading order: it becomes panel 3, and keeps its focus and its inspector.
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page.getByRole('region', { name: 'Panel 3', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Panel 3 of 6' })).toBeVisible();

    await page.keyboard.press('b');
    await expect(balloons(page)).toHaveCount(1);
    await expect(balloons(page).first()).toHaveAttribute('aria-label', /^Balloon 1 of 1 on panel 3, Speech/);

    await selectPanel(page, 3);
    await page.keyboard.press('Delete');
    await expect(sheetOf(page)).toContainText('5 panels, 0 balloons, 0 pictures');
    expect(await countOf(page, 'comic.setPage')).toBe(3);

    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await undo.click();
    await expect(sheetOf(page)).toContainText('6 panels, 1 balloon, 0 pictures');
    await undo.click();
    await undo.click();
    await expect(sheetOf(page)).toContainText('6 panels, 0 balloons, 0 pictures');
  });

  test('B and T are read through the layout rule, and an IME candidate commit is not a balloon edit', async ({ page }) => {
    await newComicPage(page);
    await selectPanel(page, 2);

    // A Cyrillic layout prints и on the physical KeyB: the shortcut belongs to the letter's place, as the screenplay menu's does.
    await panelOf(page, 2).dispatchEvent('keydown', { key: 'и', code: 'KeyB', bubbles: true });
    await expect(balloons(page)).toHaveCount(1);
    // A key an input method is composing is not a shortcut.
    await panelOf(page, 2).dispatchEvent('keydown', { key: 'b', code: 'KeyB', isComposing: true, bubbles: true });
    await expect(balloons(page)).toHaveCount(1);

    const balloon = balloons(page).first();
    await selectBalloon(page, balloon, 1);
    await balloon.dispatchEvent('keydown', { key: 'е', code: 'KeyT', bubbles: true });
    await expect(balloonText(page)).toBeFocused();

    // Enter that commits an IME candidate (the older Windows path sends keyCode 229) leaves the text uncommitted and the field focused.
    await balloonText(page).fill('こんにちは');
    const before = await countOf(page, 'comic.setPage');
    await balloonText(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true });
    await expect(balloonText(page)).toBeFocused();
    expect(await countOf(page, 'comic.setPage')).toBe(before);
    await balloonText(page).press('Enter');
    await expect(balloon.locator('.comic-balloon-text')).toHaveText('こんにちは');
  });

  test('a balloon tail is aimed with the keyboard as well as the pointer', async ({ page }) => {
    await newComicPage(page);
    await selectPanel(page, 2);
    await page.getByRole('button', { name: 'Add balloon' }).click();
    const balloon = balloons(page).first();
    await selectBalloon(page, balloon, 1);

    await page.getByRole('button', { name: 'Aim the tail' }).click();
    const tail = balloon.locator('.comic-tail-handle');
    await expect(tail).toHaveCount(1);
    const before = await countOf(page, 'comic.setPage');
    const from = Number(await tail.getAttribute('cx'));
    await page.getByRole('button', { name: 'Tail right' }).click();
    await expect.poll(() => countOf(page, 'comic.setPage')).toBe(before + 1);
    expect(Number(await tail.getAttribute('cx'))).toBeGreaterThan(from);
  });

  test('a returned photograph is shown at its own proportions, its crops move with the arrow keys, and a skipped page is not called placed', async ({ page }) => {
    await newComicPage(page);
    await page.getByLabel('Choose the photographed pages').setInputFiles({ name: '0001.png', mimeType: 'image/png', buffer: solidPng([120, 120, 120], 40, 20) });
    const review = page.getByRole('complementary', { name: 'Review the returned photographs' });
    await expect(review).toBeVisible();

    const sheet = review.locator('.comic-review-sheet');
    await expect(sheet).toHaveAttribute('viewBox', '0 0 200 100');
    await expect.poll(async () => {
      const box = await sheet.boundingBox();
      return box === null ? 0 : box.width / box.height;
    }).toBeCloseTo(2, 1);

    const crop = review.locator('.comic-crop').first();
    const x = Number(await crop.getAttribute('x'));
    const width = Number(await crop.getAttribute('width'));
    await crop.focus();
    await page.keyboard.press('ArrowRight');
    expect(Number(await crop.getAttribute('x'))).toBeCloseTo(x + 2, 3);
    await page.keyboard.press('Shift+ArrowRight');
    expect(Number(await crop.getAttribute('width'))).toBeGreaterThan(width);

    await review.getByRole('button', { name: 'Skip this page' }).click();
    const row = review.getByRole('listitem').filter({ hasText: 'Page 1' });
    await expect(row).toContainText('Skipped');
    await expect(row).not.toContainText('Crops placed');
    await expect(review.getByRole('button', { name: /^Place the crops/ })).toBeDisabled();
  });

  test('a balloon is added, selected, retyped, re-kinded, dragged and resized, and Undo takes each step back', async ({ page }) => {
    await newComicPage(page);
    await selectPanel(page, 2);
    await page.getByRole('button', { name: 'Add balloon' }).click();
    const balloon = balloons(page).first();
    await expect(balloon).toHaveAttribute('aria-label', /^Balloon 1 of 1 on panel 2, Speech/);
    await expect(sheetOf(page)).toContainText('6 panels, 1 balloon, 0 pictures');

    // Selecting the balloon opens its own inspector; the text is written on Enter.
    await selectBalloon(page, balloon, 1);
    await balloonText(page).fill('Is anyone out there?');
    await balloonText(page).press('Enter');
    await expect(balloon.locator('.comic-balloon-text')).toHaveText('Is anyone out there?');

    // The kind changes the outline and the label: a shout is no longer a speech balloon.
    await page.getByLabel('Balloon kind').selectOption('shout');
    await expect(balloon).toHaveAttribute('aria-label', /Shout/);
    await expect(balloon.locator('.comic-balloon-text')).toHaveText('Is anyone out there?');

    // Move by dragging the balloon.
    const outline = balloon.locator('.comic-balloon-shape, .comic-balloon-tail').first();
    const beforeMove = await outline.boundingBox();
    const grab = await centreOf(balloon.locator('.comic-balloon-text'));
    const setPageBefore = await countOf(page, 'comic.setPage');
    await dragFrom(page, grab, 25, 35);
    await expect.poll(() => countOf(page, 'comic.setPage')).toBe(setPageBefore + 1);
    const afterMove = await outline.boundingBox();
    expect(beforeMove).not.toBeNull();
    expect(afterMove).not.toBeNull();
    expect(Math.abs((afterMove?.x ?? 0) - (beforeMove?.x ?? 0)) + Math.abs((afterMove?.y ?? 0) - (beforeMove?.y ?? 0))).toBeGreaterThan(5);

    // Resize by the south-east handle.
    await expect(balloon).toHaveClass(/is-selected/);
    const grown = await balloon.boundingBox();
    const southEast = await centreOf(balloon.locator('.comic-handle').nth(4));
    await dragFrom(page, southEast, 20, 20);
    await expect.poll(() => countOf(page, 'comic.setPage')).toBe(setPageBefore + 2);
    const afterResize = await balloon.boundingBox();
    expect((afterResize?.width ?? 0) + (afterResize?.height ?? 0)).toBeGreaterThan((grown?.width ?? 0) + (grown?.height ?? 0));

    // Undo, one step at a time: resize, move, kind, text, add.
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await undo.click();
    await undo.click();
    await undo.click();
    await expect(balloon).toHaveAttribute('aria-label', /Speech/);
    await undo.click();
    await expect(balloon.locator('.comic-balloon-text')).toHaveText('');
    await undo.click();
    await expect(balloons(page)).toHaveCount(0);
  });

  test('a layout, a resized panel, a balloon with its words and the reading direction are still there after a reload', async ({ page }) => {
    await newComicPage(page);
    await page.getByLabel('Page layout template').selectOption('grid-4');
    await expect(sheetOf(page).locator('.comic-panel-g')).toHaveCount(4);

    await selectPanel(page, 1);
    const east = await centreOf(panelOf(page, 1).locator('.comic-handle').nth(3));
    await dragFrom(page, east, -70, 0);
    await expect.poll(() => countOf(page, 'comic.setPage')).toBe(2);
    await page.getByRole('button', { name: 'Add balloon' }).click();
    const balloon = balloons(page).first();
    await selectBalloon(page, balloon, 1);
    await balloonText(page).fill('Lights out at nine.');
    await balloonText(page).press('Enter');
    await expect(balloon.locator('.comic-balloon-text')).toHaveText('Lights out at nine.');
    await page.getByLabel('Reading direction').selectOption('rtl');
    await expect(sheetOf(page)).toContainText('Reads right to left');
    await waitForSaved(page);

    const frames = await Promise.all([1, 2, 3, 4].map((number) => drawn(frameOf(page, number))));
    const balloonBox = await drawn(balloon.locator('foreignObject'));

    await page.reload();
    const row = page.getByRole('listitem').filter({ hasText: PROJECT });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByRole('button', { name: 'Open' }).click();
    if ((await binderTitle(page, 'Page 1').count()) === 0) await page.getByRole('button', { name: 'Expand Untitled comic' }).click();
    await binderTitle(page, 'Page 1').click();
    await page.getByRole('radio', { name: 'Editor', exact: true }).click();
    await expect(sheetOf(page)).toBeVisible();

    await expect(sheetOf(page).locator('.comic-panel-g')).toHaveCount(4);
    await expect(sheetOf(page)).toContainText('Reads right to left');
    await expect(sheetOf(page)).toContainText('4 panels, 1 balloon, 0 pictures');
    await expect(page.getByLabel('Page layout template')).toHaveValue('grid-4');
    await expect(balloons(page).first().locator('.comic-balloon-text')).toHaveText('Lights out at nine.');
    for (const [index, frame] of frames.entries()) {
      const again = await drawn(frameOf(page, index + 1));
      expect(again.x).toBeCloseTo(frame.x, 2);
      expect(again.y).toBeCloseTo(frame.y, 2);
      expect(again.width).toBeCloseTo(frame.width, 2);
      expect(again.height).toBeCloseTo(frame.height, 2);
    }
    const balloonAgain = await drawn(balloons(page).first().locator('foreignObject'));
    expect(balloonAgain.width).toBeCloseTo(balloonBox.width, 2);
    expect(balloonAgain.height).toBeCloseTo(balloonBox.height, 2);
  });
});

/** One splash page with a red picture in its panel and one balloon, ready to compile. */
async function letteredSplash(page: Page, words: string): Promise<void> {
  await newComicPage(page);
  await page.getByLabel('Page layout template').selectOption('splash');
  await expect(sheetOf(page).locator('.comic-panel-g')).toHaveCount(1);
  await selectPanel(page, 1);
  await page.getByLabel('Choose a picture for this panel').setInputFiles({ name: RED.name, mimeType: RED.mimeType, buffer: RED.buffer });
  await expect(sheetOf(page)).toContainText('1 panel, 0 balloons, 1 picture');
  await expect(panelOf(page, 1).locator('image.comic-panel-art')).toBeVisible();
  await page.getByRole('button', { name: 'Add balloon' }).click();
  const balloon = balloons(page).first();
  await selectBalloon(page, balloon, 1);
  await balloonText(page).fill(words);
  await balloonText(page).press('Enter');
  await expect(balloon.locator('.comic-balloon-text')).toHaveText(words);
  await waitForSaved(page);
}

/** Choose a comic format in the Export dialog for the book, compile, and take the download. */
async function compileBook(page: Page, format: RegExp): Promise<{ download: Download; bytes: Buffer }> {
  await binderTitle(page, 'Untitled comic').click();
  await page.getByRole('button', { name: 'Compile…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.getByRole('radio', { name: format }).check();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    dialog.getByRole('button', { name: 'Compile', exact: true }).click(),
  ]);
  const path = await download.path();
  if (path === null) throw new Error('the compile was not downloaded');
  return { download, bytes: await readFile(path) };
}

interface Decoded {
  readonly width: number;
  readonly height: number;
  /** Sampled on a 24-by-24 grid. */
  readonly red: number;
  readonly white: number;
  readonly cornerIsPaper: boolean;
}

/** Decode a JPEG in the page, as a reader would, and sample it. */
async function decodeJpeg(page: Page, bytes: Uint8Array): Promise<Decoded> {
  return page.evaluate(async (base64) => {
    // Not a data: URL through fetch, which the app's connect-src refuses.
    const jpegBytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([jpegBytes], { type: 'image/jpeg' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no 2d canvas');
    context.drawImage(bitmap, 0, 0);
    const grid = 24;
    let red = 0;
    let white = 0;
    for (let row = 0; row < grid; row += 1) {
      for (let column = 0; column < grid; column += 1) {
        const [r = 0, g = 0, b = 0] = context.getImageData(Math.floor(((column + 0.5) / grid) * bitmap.width), Math.floor(((row + 0.5) / grid) * bitmap.height), 1, 1).data;
        if (r > 150 && g < 100 && b < 100) red += 1;
        else if (r > 235 && g > 235 && b > 235) white += 1;
      }
    }
    const [r = 0, g = 0, b = 0] = context.getImageData(2, 2, 1, 1).data;
    return { width: bitmap.width, height: bitmap.height, red, white, cornerIsPaper: r > 200 && g > 200 && b > 200 };
  }, Buffer.from(bytes).toString('base64'));
}

test.describe('the comic exports made in the browser', () => {
  test('a CBZ downloads with the page as a 1988 px JPEG with its art and lettering drawn in, and a ComicInfo.xml', async ({ page }) => {
    await letteredSplash(page, 'The tide is coming in.');
    const { download, bytes } = await compileBook(page, /^Comic book archive/);
    expect(download.suggestedFilename()).toMatch(/\.cbz$/);

    expect(bytes.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');
    const entries = zipEntries(bytes);
    expect([...entries.keys()].sort()).toEqual(['0001.jpg', 'ComicInfo.xml']);
    const jpeg = entries.get('0001.jpg') as Uint8Array;
    expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);

    const picture = await decodeJpeg(page, jpeg);
    expect(picture.height).toBe(1988);
    expect(picture.width).toBeGreaterThan(1200);
    expect(picture.width).toBeLessThan(1400);
    // The red picture fills the splash panel, the balloon's paper-white sits on it, and the trim edge is paper.
    expect(picture.red).toBeGreaterThan(24 * 24 * 0.4);
    expect(picture.white).toBeGreaterThan(5);
    expect(picture.cornerIsPaper).toBe(true);

    const info = textEntry(entries, 'ComicInfo.xml');
    expect(info).toContain('<PageCount>1</PageCount>');
    expect(info).toContain('Type="FrontCover"');
    expect(info).toContain(`ImageWidth="${picture.width}"`);
    expect(info).toContain('ImageHeight="1988"');
    expect(info).not.toContain('<Manga>');
    expect(info).not.toContain('The tide is coming in.');
    expect(await countOf(page, 'export.compileSelection')).toBe(1);
  });

  test('a right-to-left comic EPUB downloads as a fixed-layout book with one page picture, readable balloon text and panel regions', async ({ page }) => {
    await letteredSplash(page, 'The tide is coming in.');
    await page.getByLabel('Reading direction').selectOption('rtl');
    await expect(sheetOf(page)).toContainText('Reads right to left');
    await waitForSaved(page);

    const { download, bytes } = await compileBook(page, /^Comic EPUB/);
    expect(download.suggestedFilename()).toMatch(/\.epub$/);

    const entries = zipEntries(bytes);
    // The container's one ordering rule: mimetype first, with its exact text.
    expect([...entries.keys()][0]).toBe('mimetype');
    expect(textEntry(entries, 'mimetype')).toBe('application/epub+zip');
    expect(textEntry(entries, 'META-INF/container.xml')).toContain('OEBPS/content.opf');

    const opf = textEntry(entries, 'OEBPS/content.opf');
    expect(opf).toContain('<meta property="rendition:layout">pre-paginated</meta>');
    expect(opf).toContain('<spine page-progression-direction="rtl">');
    expect(opf).toContain('properties="cover-image"');
    expect(opf).toContain('properties="data-nav"');
    expect(opf.match(/<itemref /g)).toHaveLength(1);

    const jpeg = entries.get('OEBPS/images/0001.jpg');
    if (jpeg === undefined) throw new Error('the EPUB has no page picture');
    expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const picture = await decodeJpeg(page, jpeg);
    expect(picture.height).toBe(1988);
    expect(picture.red).toBeGreaterThan(24 * 24 * 0.4);

    const pageXhtml = textEntry(entries, 'OEBPS/page-0001.xhtml');
    expect(pageXhtml).toContain(`<meta name="viewport" content="width=${picture.width}, height=1988"/>`);
    expect(pageXhtml).toContain('<img src="images/0001.jpg"');
    // The lettering is real text in the page, clipped to a pixel rather than hidden from a screen reader or a search.
    expect(pageXhtml).toContain('<li dir="auto">The tide is coming in.</li>');
    expect(pageXhtml).not.toMatch(/aria-hidden|display:\s*none|visibility:\s*hidden/);

    const regions = textEntry(entries, 'OEBPS/region-nav.xhtml');
    expect(regions).toContain('epub:type="region-based"');
    expect(regions).toContain('page-0001.xhtml#p0001-panel-1');
    expect(textEntry(entries, 'OEBPS/nav.xhtml')).toContain('page-0001.xhtml');
    expect(await countOf(page, 'export.compileSelection')).toBe(1);
  });
});
