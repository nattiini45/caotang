/**
 * The image of a shot, in the app (storyboard.md §3.1–3.2). A picture is chosen from the desktop, dropped or pasted onto a card,
 * looked at larger in the lightbox, and kept across a reload with no folder attached. An image whose file has gone is dropped as the
 * project opens, with a notice. The tests drive the gestures and read the result through the activity log and the card.
 *
 * A drop and a paste are dispatched as the browser's own `DragEvent` and `ClipboardEvent`, carrying a real `DataTransfer` that holds real
 * `File` objects, against the real handlers. The event's origin is the one synthetic step: Explorer's or Finder's drag payload and the
 * system clipboard are not driven (Playwright cannot start either). `send` checks the files the `DataTransfer` holds before it
 * dispatches, so a test cannot pass on an event that carries nothing.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

import { binderTitle, createProject, dragShotCard, firstChapter, trace, waitForSaved } from './support.js';

const PROJECT = 'Picture Book';
/** A 1×1 PNG, the smallest picture the store will take. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
/** A 1×1 JPEG. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

/** A file as a drop or a paste hands it to a handler: its name, its type and its bytes. */
interface Sent {
  readonly name: string;
  readonly type: string;
  readonly bytes: Buffer;
}

interface ReceivedTransfer {
  readonly types: readonly string[];
  readonly files: readonly { readonly name: string; readonly type: string }[];
  readonly items: readonly { readonly kind: string; readonly type: string; readonly file: string | null }[];
}

const FRAME_PNG: Sent = { name: 'frame.png', type: 'image/png', bytes: PNG };
const FRAME_JPG: Sent = { name: 'frame.jpg', type: 'image/jpeg', bytes: JPEG };
const NOTES_TXT: Sent = { name: 'notes.txt', type: 'text/plain', bytes: Buffer.from('not a picture') };

/** Makes a node from the context menu of the row it goes under, and keeps its default title. */
async function makeUnder(page: Page, under: string, item: string): Promise<void> {
  // The media entries are on chapters, so "under the manuscript" is its first chapter, made when there is none.
  const parent = under === 'Manuscript' ? await firstChapter(page) : under;
  await binderTitle(page, parent).click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${parent}` }).getByRole('menuitem', { name: item }).click();
  await page.keyboard.press('Escape');
}

/** Reloads the page and opens the project from the projects list, as a writer does after a restart. */
async function reopen(page: Page): Promise<void> {
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: PROJECT }).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

/** A storyboard with one shot, whose fields are open in the editor. */
async function storyboardWithShot(page: Page): Promise<Locator> {
  await createProject(page, PROJECT);
  await makeUnder(page, 'Manuscript', 'New storyboard here');
  await makeUnder(page, 'Storyboard', 'New shot here');
  await page.getByRole('article', { name: 'Shot 1: New shot' }).getByRole('button', { name: 'Edit the fields of shot 1' }).click();
  return page.getByRole('article', { name: 'Shot 1: New shot' });
}

/**
 * Builds a `DataTransfer` of the given files, checks that it holds and delivers exactly those files, then dispatches a `drop` (after its
 * `dragover`) or a `paste` on the element. Resolves with whether the handler cancelled the event; for a drop that keeps the tab from opening it.
 */
async function send(
  target: Locator,
  gesture: 'drop' | 'paste',
  files: readonly Sent[],
): Promise<{ cancelled: boolean; received: ReceivedTransfer | null }> {
  return target.evaluate(
    (element, input) => {
      const data = new DataTransfer();
      for (const file of input.files) data.items.add(new File([Uint8Array.from(file.bytes)], file.name, { type: file.type }));
      const held = Array.from(data.files, (file) => file.name);
      if (held.length !== input.files.length || held.join('|') !== input.files.map((file) => file.name).join('|')) {
        throw new Error(`the DataTransfer holds ${held.length} file(s) (${held.join(', ')}), not the ${input.files.length} sent`);
      }
      const inspect = (event: Event): ReceivedTransfer | null => {
        const transfer = input.gesture === 'paste' ? (event as ClipboardEvent).clipboardData : (event as DragEvent).dataTransfer;
        return transfer === null ? null : {
          types: Array.from(transfer.types),
          files: Array.from(transfer.files, (file) => ({ name: file.name, type: file.type })),
          items: Array.from(transfer.items, (item) => ({ kind: item.kind, type: item.type, file: item.getAsFile()?.name ?? null })),
        };
      };
      if (input.gesture === 'paste') {
        const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
        // Firefox ignores ClipboardEventInit.clipboardData; put the prepared payload on the dispatched event explicitly.
        Object.defineProperty(event, 'clipboardData', { configurable: true, value: data });
        let received: ReceivedTransfer | null = null;
        element.addEventListener('paste', (receivedEvent) => { received = inspect(receivedEvent); }, { capture: true, once: true });
        const cancelled = !element.dispatchEvent(event);
        return { cancelled, received };
      }
      element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
      let received: ReceivedTransfer | null = null;
      element.addEventListener('drop', (receivedEvent) => { received = inspect(receivedEvent); }, { capture: true, once: true });
      const cancelled = !element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      return { cancelled, received };
    },
    { gesture, files: files.map((file) => ({ name: file.name, type: file.type, bytes: [...file.bytes] })) },
  );
}

function expectReceivedFiles(received: ReceivedTransfer | null, files: readonly Sent[]): void {
  expect(received?.files).toEqual(files.map(({ name, type }) => ({ name, type })));
  expect(received?.items).toEqual(files.map(({ name, type }) => ({ kind: 'file', type, file: name })));
}

/** How many times a picture was set through the command the picker uses. */
async function imports(page: Page): Promise<number> {
  return (await trace(page)).filter((row) => row.command === 'shot.importImage').length;
}

test('a picture chosen from the desktop shows on its card, and is still there after a reload with no folder attached', async ({ page }) => {
  const card = await storyboardWithShot(page);
  await page.getByLabel('Choose an image file for shot 1').setInputFiles({ name: 'frame.png', mimeType: 'image/png', buffer: PNG });

  await expect(card.locator('img')).toBeVisible();
  expect(await imports(page)).toBe(1);

  await reopen(page);
  await binderTitle(page, 'Storyboard').click();
  await expect(page.getByRole('article', { name: 'Shot 1: New shot' }).locator('img')).toBeVisible();
});

test('a picture dropped on a card is its image, and the lightbox shows it larger until Escape closes it', async ({ page }) => {
  const card = await storyboardWithShot(page);
  await send(card.locator('figure.sb-frame'), 'drop', [FRAME_PNG]);
  await expect(card.locator('img')).toBeVisible();
  expect(await imports(page)).toBe(1);

  await card.getByRole('button', { name: 'Look at the image of shot 1 larger' }).click();
  const lightbox = page.getByRole('dialog', { name: 'Image of New shot' });
  await expect(lightbox).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);
});

test('a file dropped on a card outside its picture slot is the card’s picture, and the tab does not open the file', async ({ page }) => {
  const card = await storyboardWithShot(page);
  // The drop's default action is to open the file in this tab, so a drop the card does not cancel would replace the app.
  const { cancelled } = await send(card.locator('.card-head'), 'drop', [FRAME_PNG]);
  expect(cancelled).toBe(true);
  await expect(card.locator('img')).toBeVisible();
  expect(await imports(page)).toBe(1);
});

test('a drop of a text file and a picture lands the picture, whichever comes first', async ({ page }) => {
  const card = await storyboardWithShot(page);
  const { cancelled } = await send(card, 'drop', [NOTES_TXT, FRAME_PNG]);
  expect(cancelled).toBe(true);
  await expect(card.locator('img')).toBeVisible();
  expect(await imports(page)).toBe(1);
});

test('a drop that carries no picture changes nothing, and the tab still does not open the file', async ({ page }) => {
  const card = await storyboardWithShot(page);
  const { cancelled } = await send(card, 'drop', [NOTES_TXT]);
  expect(cancelled).toBe(true);
  // The import is asynchronous, so the picture is waited for to be absent, not read once.
  await expect(card.locator('img')).toHaveCount(0);
  expect(await imports(page)).toBe(0);
});

test('a picture pasted while a card is selected is its image', async ({ page }) => {
  const card = await storyboardWithShot(page);
  await card.focus();
  const { cancelled, received } = await send(card, 'paste', [FRAME_PNG]);
  expectReceivedFiles(received, [FRAME_PNG]);
  expect(cancelled).toBe(true);
  await expect(card.locator('img')).toBeVisible();
  expect(await imports(page)).toBe(1);
});

test('a JPEG pasted while a card is selected is its image', async ({ page }) => {
  const card = await storyboardWithShot(page);
  await card.focus();
  const { received } = await send(card, 'paste', [FRAME_JPG]);
  expectReceivedFiles(received, [FRAME_JPG]);
  await expect(card.locator('img')).toBeVisible();
  expect(await imports(page)).toBe(1);
  // The browser decoded what the card kept, so the card shows a picture and not a broken-image box.
  await expect.poll(() => card.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
});

test('a paste that carries no picture is left to the browser', async ({ page }) => {
  const card = await storyboardWithShot(page);
  await card.focus();
  const { cancelled, received } = await send(card, 'paste', [NOTES_TXT]);
  expectReceivedFiles(received, [NOTES_TXT]);
  expect(cancelled).toBe(false);
  await expect(card.locator('img')).toHaveCount(0);
  expect(await imports(page)).toBe(0);
});

test('an image whose file is no longer in the project is dropped when the project opens, with a notice, and not named again after that', async ({ page }) => {
  const card = await storyboardWithShot(page);
  await page.getByLabel('Choose an image file for shot 1').setInputFiles({ name: 'frame.png', mimeType: 'image/png', buffer: PNG });
  await expect(card.locator('img')).toBeVisible();
  await waitForSaved(page);

  // Remove the files from the browser's copy, as a cleared site-data store would.
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('caotang-assets');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('assets', 'readwrite');
      tx.objectStore('assets').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
  });

  // The check ran as the project opened from the list: the open says so before the storyboard is ever opened.
  await reopen(page);
  await expect(page.getByText('A shot lost its picture because the file is not in the project.')).toBeVisible();
  await binderTitle(page, 'Storyboard').click();
  await expect(page.getByRole('status').filter({ hasText: 'An image was dropped when the project opened' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Shot 1: New shot' }).locator('img')).toHaveCount(0);

  // The drop is saved with the project, so the next open has nothing left to drop and no notice.
  await reopen(page);
  await expect(page.getByText('lost its picture')).toHaveCount(0);
  await binderTitle(page, 'Storyboard').click();
  await expect(page.getByText('An image was dropped when the project opened')).toHaveCount(0);
});

/** A storyboard of three shots, all titled New shot, numbered 1 to 3 by their order. */
async function storyboardWithThreeShots(page: Page): Promise<{ cards: Locator; board: Locator }> {
  await createProject(page, PROJECT);
  await makeUnder(page, 'Manuscript', 'New storyboard here');
  for (let shot = 0; shot < 3; shot += 1) await makeUnder(page, 'Storyboard', 'New shot here');
  const cards = page.locator('article.sb-card');
  await expect(cards).toHaveCount(3);
  return { cards, board: page.getByRole('list', { name: /^Shots in/ }) };
}

/** How many times a command ran, by its activity rows. */
async function ran(page: Page, command: string): Promise<number> {
  return (await trace(page)).filter((row) => row.command === command).length;
}

test('several pictures dropped on the board go on the shots their names number, the notice names each file, and one Undo takes them all back', async ({ page }) => {
  const { cards, board } = await storyboardWithThreeShots(page);
  const NINE: Sent = { name: '9.png', type: 'image/png', bytes: PNG };
  const NO_NUMBER: Sent = { name: 'ferry.png', type: 'image/png', bytes: PNG };
  const { cancelled } = await send(board, 'drop', [
    { name: '003.png', type: 'image/png', bytes: PNG },
    { name: '1-wide.jpg', type: 'image/jpeg', bytes: JPEG },
    NOTES_TXT,
    NINE,
    NO_NUMBER,
  ]);
  // The tab must not open a file dropped on the board.
  expect(cancelled).toBe(true);

  await expect(cards.nth(0).locator('img')).toBeVisible();
  await expect(cards.nth(2).locator('img')).toBeVisible();
  await expect(cards.nth(1).locator('img')).toHaveCount(0);
  // One command put both pictures on, not one command each.
  expect(await ran(page, 'shot.importImages')).toBe(1);
  expect(await ran(page, 'shot.importImage')).toBe(0);

  const notice = page.getByRole('status').filter({ hasText: 'Put 2 pictures on their shots; 3 files were not imported.' });
  await expect(notice).toBeVisible();
  const lines = notice.getByRole('list', { name: 'Pictures dropped on the board' }).getByRole('listitem');
  await expect(lines).toHaveText([
    '003.png: shot 3, New shot',
    '1-wide.jpg: shot 1, New shot',
    'notes.txt: not imported, it is not a PNG, JPEG or WebP picture',
    '9.png: not imported, the board has 3 shots and none is numbered 9',
    'ferry.png: not imported, its name does not start with a shot number (name a photograph like 007.jpg)',
  ]);
  await expect(notice).toContainText('a sheet printed from a longer board does not match it');

  // One Undo, from the activity row of the batch, takes back both pictures.
  await page.getByRole('tab', { name: 'Activity' }).click();
  const row = page.getByRole('list', { name: 'Activity' }).getByRole('listitem').first();
  await expect(row.locator('.activity-title')).toHaveText('Images added to shots');
  await row.getByRole('button', { name: 'Undo' }).click();
  await expect(cards.locator('img')).toHaveCount(0);
});

test('a drop on the board that matches no shot imports nothing, names every file, and still does not open the file', async ({ page }) => {
  const { cards, board } = await storyboardWithThreeShots(page);
  const { cancelled } = await send(board, 'drop', [
    { name: 'sketch.png', type: 'image/png', bytes: PNG },
    { name: '12.png', type: 'image/png', bytes: PNG },
  ]);
  expect(cancelled).toBe(true);

  const notice = page.getByRole('status').filter({ hasText: 'Nothing was imported.' });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole('listitem')).toHaveCount(2);
  await expect(notice).toContainText('sketch.png: not imported');
  await expect(notice).toContainText('12.png: not imported, the board has 3 shots and none is numbered 12');
  await expect(cards.locator('img')).toHaveCount(0);
  expect(await ran(page, 'shot.importImages')).toBe(0);

  // The notice goes when the writer dismisses it.
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toHaveCount(0);
});

test('a card dragged on the board still reorders, and a file dropped on a card still goes on that card whatever its name', async ({ page }) => {
  const { cards } = await storyboardWithThreeShots(page);
  const ids = await cards.evaluateAll((items) => items.map((item) => item.getAttribute('data-shot-id')));
  // The panel can cover a card's centre; use the blank gap below its header and let the browser deliver stepped native drag events.
  await dragShotCard(page, cards.nth(1), cards.nth(0));
  await expect.poll(() => cards.nth(0).getAttribute('data-shot-id')).toBe(ids[1]);
  expect(await ran(page, 'binder.move')).toBeGreaterThan(0);
  expect(await ran(page, 'shot.importImages')).toBe(0);

  // A file dropped on the second card is that card's picture, though its name numbers shot 3, and the board does not take it again.
  const { cancelled } = await send(cards.nth(1), 'drop', [{ name: '3.png', type: 'image/png', bytes: PNG }]);
  expect(cancelled).toBe(true);
  await expect(cards.nth(1).locator('img')).toBeVisible();
  await expect(cards.locator('img')).toHaveCount(1);
  expect(await ran(page, 'shot.importImage')).toBe(1);
  expect(await ran(page, 'shot.importImages')).toBe(0);
  await expect(page.getByRole('list', { name: 'Pictures dropped on the board' })).toHaveCount(0);
});

test('a file dropped on a board with no shots is not opened by the tab, and the board says there is nothing to put it on', async ({ page }) => {
  await createProject(page, PROJECT);
  await makeUnder(page, 'Manuscript', 'New storyboard here');
  const empty = page.locator('section.sb-view section.empty-state');
  await expect(empty).toBeVisible();
  const { cancelled } = await send(empty, 'drop', [FRAME_PNG]);
  expect(cancelled).toBe(true);
  await expect(page.getByText('This board has no shots yet, so there is nothing to put the pictures on.')).toBeVisible();
  expect(await ran(page, 'shot.importImages')).toBe(0);
});
