/**
 * A storyboard's pictures across the project's ways out and in (storyboard.md §2.2, project-format §2 `assets/`): a bundle made from
 * the projects list after a reload, a folder saved after a reload, and a folder opened where the browser holds none of its pictures.
 *
 * The folder is a directory in the page's own storage, handed out by a stand-in for the folder picker, so the tests read back what the
 * app wrote through the same file API. Before each folder test the picker is set; the browser's own copy of the pictures is cleared
 * where a test needs the folder to be the only place they are.
 */

import { readFile } from 'node:fs/promises';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { binderTitle, createProject, firstChapter, FOLDER_ACCESS_ONLY, waitForSaved } from './support.js';
import { zipEntries } from './zip-entries.js';

const PROJECT = 'Picture Book';
/** The folder the stand-in picker hands out, a directory in the page's own storage. */
const FOLDER = 'picture-book-folder';
/** A 1×1 PNG, the smallest picture the store will take. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** Makes a node from the context menu of the row it goes under, and keeps its default title. */
async function makeUnder(page: Page, under: string, item: string): Promise<void> {
  // The media entries are on chapters, so "under the manuscript" is its first chapter, made when there is none.
  const parent = under === 'Manuscript' ? await firstChapter(page) : under;
  await binderTitle(page, parent).click({ button: 'right' });
  await page.getByRole('menu', { name: `Actions for ${parent}` }).getByRole('menuitem', { name: item }).click();
  await page.keyboard.press('Escape');
}

/** A storyboard with one shot, whose fields are open in the editor. */
async function storyboardWithShot(page: Page): Promise<Locator> {
  await makeUnder(page, 'Manuscript', 'New storyboard here');
  await makeUnder(page, 'Storyboard', 'New shot here');
  await page.getByRole('article', { name: 'Shot 1: New shot' }).getByRole('button', { name: 'Edit the fields of shot 1' }).click();
  return page.getByRole('article', { name: 'Shot 1: New shot' });
}

/** Reloads the page and opens the project from the projects list, as a writer does after a restart. */
async function reopen(page: Page): Promise<void> {
  await page.reload();
  await page.getByRole('listitem').filter({ hasText: PROJECT }).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
}

/** Chooses a picture for shot 1 from the desktop, as the image slot takes it. */
async function choosePicture(page: Page, card: Locator): Promise<void> {
  await page.getByLabel('Choose an image file for shot 1').setInputFiles({ name: 'frame.png', mimeType: 'image/png', buffer: PNG });
  await expect(card.locator('img')).toBeVisible();
  await waitForSaved(page);
}

/**
 * Makes the folder picker hand back the one folder, in the page's own storage. It is installed before the page loads, so every load
 * of the page has it, as the File System Access picker would have it for the writer's whole session.
 */
async function standInFolderPicker(page: Page): Promise<void> {
  await page.addInitScript((name: string) => {
    const host = globalThis as unknown as { showDirectoryPicker: () => Promise<unknown> };
    host.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
  }, FOLDER);
}

/** Every file under the folder, by slash path, read back through the file API the app writes with. */
async function filesInFolder(page: Page): Promise<string[]> {
  return page.evaluate(async (name: string) => {
    type Dir = { entries(): AsyncIterable<[string, { kind: string }]>; getDirectoryHandle(child: string): Promise<Dir> };
    const list = async (dir: Dir, prefix: string): Promise<string[]> => {
      const found: string[] = [];
      for await (const [child, handle] of dir.entries()) {
        const path = prefix === '' ? child : `${prefix}/${child}`;
        if (handle.kind === 'directory') found.push(...(await list(await dir.getDirectoryHandle(child), path)));
        else found.push(path);
      }
      return found.sort();
    };
    const root = await navigator.storage.getDirectory();
    return list((await root.getDirectoryHandle(name)) as unknown as Dir, '');
  }, FOLDER);
}

/** Empties the browser's copy of the pictures, as a cleared site-data store would, so only a folder holds them. */
async function clearBrowserPictures(page: Page): Promise<void> {
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
}

test('a bundle made from the projects list after a reload carries the project’s pictures and its cover', async ({ page }) => {
  await createProject(page, PROJECT);
  await page.getByRole('button', { name: PROJECT }).click();
  const panel = page.getByRole('dialog', { name: 'Project' });
  await panel.getByLabel('Cover image file').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('status').filter({ hasText: 'The cover is set' })).toBeVisible();
  await panel.getByRole('button', { name: 'Done' }).click();

  const card = await storyboardWithShot(page);
  await choosePicture(page, card);

  // The projects list makes the bundle without opening the project, so the pictures must come from the browser's copy.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Projects in this browser' })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: `Export ${PROJECT} as a bundle` }).click(),
  ]);
  await expect(page.getByRole('status').filter({ hasText: `Exported “\u2068${PROJECT}\u2069”` })).toBeVisible();
  await expect(page.getByText('is not available in this browser')).toHaveCount(0);

  const path = await download.path();
  if (path === null) throw new Error('the bundle was not downloaded');
  const entries = zipEntries(new Uint8Array(await readFile(path)));
  expect([...entries.keys()].filter((name) => name.startsWith('assets/'))).toHaveLength(2);
});

test('a folder saved after a reload holds every picture of the project, not only the ones this page added', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', FOLDER_ACCESS_ONLY);
  await standInFolderPicker(page);
  await createProject(page, PROJECT);
  const card = await storyboardWithShot(page);
  await choosePicture(page, card);

  // After a reload the picture is in the browser's copy only, so the folder save is what has to put it in the folder.
  await reopen(page);
  await page.getByRole('button', { name: 'Save to folder' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved the project to the folder' })).toBeVisible();

  const files = await filesInFolder(page);
  expect(files).toContain('caotang.json');
  expect(files.filter((file) => file.startsWith('assets/'))).toHaveLength(1);
});

test('a project opened from a folder keeps its pictures when it is opened again from the projects list', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', FOLDER_ACCESS_ONLY);
  await standInFolderPicker(page);
  await createProject(page, PROJECT);
  const card = await storyboardWithShot(page);
  await choosePicture(page, card);
  await page.getByRole('button', { name: 'Save to folder' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved the project to the folder' })).toBeVisible();

  // The project leaves this browser with its copy of the pictures, so the folder is the only place they are.
  await page.getByRole('button', { name: 'Projects' }).click();
  await page.getByRole('button', { name: `Remove ${PROJECT} from this browser` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: PROJECT })).toHaveCount(0);
  await clearBrowserPictures(page);

  await page.getByRole('button', { name: 'Open a folder…' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await binderTitle(page, 'Storyboard').click();
  await expect(page.getByRole('article', { name: 'Shot 1: New shot' }).locator('img')).toBeVisible();

  // Opened again from the list with no folder attached, the board still has the picture: the browser's copy holds it.
  await reopen(page);
  await binderTitle(page, 'Storyboard').click();
  await expect(page.getByRole('article', { name: 'Shot 1: New shot' }).locator('img')).toBeVisible();
  await expect(page.getByText('was dropped when the project opened')).toHaveCount(0);
});

/** Writes a text file into the folder, under a directory it creates, as another program would. */
async function writeFolderFile(page: Page, directory: string, name: string, text: string): Promise<void> {
  await page.evaluate(
    async ([folder, dir, file, body]: readonly [string, string, string, string]) => {
      type Writable = { write(data: string): Promise<void>; close(): Promise<void> };
      type Dir = {
        getDirectoryHandle(child: string, options?: { create: boolean }): Promise<Dir>;
        getFileHandle(child: string, options?: { create: boolean }): Promise<{ createWritable(): Promise<Writable> }>;
      };
      const root = (await (await navigator.storage.getDirectory()).getDirectoryHandle(folder)) as unknown as Dir;
      const writable = await (await (await root.getDirectoryHandle(dir, { create: true })).getFileHandle(file, { create: true })).createWritable();
      await writable.write(body);
      await writable.close();
    },
    [FOLDER, directory, name, text] as const,
  );
}

test('a folder whose attach is refused still lends its pictures: the browser’s version keeps the shot’s image', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', FOLDER_ACCESS_ONLY);
  await standInFolderPicker(page);
  await createProject(page, PROJECT);
  const card = await storyboardWithShot(page);
  await choosePicture(page, card);
  await page.getByRole('button', { name: 'Save to folder' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved the project to the folder' })).toBeVisible();

  // The browser's version moves on, so it differs from the folder's; the picture is then in the folder only, and the folder's
  // compile log cannot be read, so attaching the folder is refused.
  await makeUnder(page, 'Storyboard', 'New shot here');
  await waitForSaved(page);
  await clearBrowserPictures(page);
  await writeFolderFile(page, 'exports', 'compile-log.json', '{}');

  await page.reload();
  await page.getByRole('button', { name: 'Open a folder…' }).click();
  const question = page.getByRole('dialog').filter({ hasText: 'The folder holds a different version of' });
  await expect(question).toBeVisible();
  await question.getByRole('button', { name: 'Keep this browser’s version and save it to the folder' }).click();
  await expect(page.getByRole('tree', { name: 'Binder' })).toBeVisible();
  await expect(page.getByText('Exports are kept in this browser, not in the folder.')).toBeVisible();

  await binderTitle(page, 'Storyboard').click();
  await expect(page.getByRole('article', { name: 'Shot 1: New shot' }).locator('img')).toBeVisible();
  await expect(page.getByText('was dropped when the project opened')).toHaveCount(0);
  await expect(page.getByText('lost its picture')).toHaveCount(0);
});
