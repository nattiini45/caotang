/**
 * **Import TextPack…** (issue #282): a TextPack (a zipped TextBundle) chosen in the binder opens in the shared import preview,
 * its `text.md` split at `#` headings and `* * *` breaks, and Import writes it as one `binder.importTree` whose documents are in
 * the binder. Cancel writes nothing. The Ulysses app is named from `info.json`, and its `%%` comment is reported as kept as a note.
 */

import { expect, test, type Page } from '@playwright/test';

import { bodyOf, createProject, traceNames, treeOf, waitForSaved } from './support.js';

const TEXT_MD = [
  '# Chapter One',
  '',
  'The ferry came at noon. %% remember the tide',
  '',
  '* * *',
  '',
  'By evening the wind had turned.',
  '',
  '# Chapter Two',
  '',
  'The letter arrived on a Tuesday.',
].join('\n');

const INFO_JSON = JSON.stringify({ creatorIdentifier: 'com.ulyssesapp.mac', title: 'The Landing' });

// A stored (uncompressed) zip, built here so the spec needs no archive dependency. A value may be bytes, for a real picture.
function storedZip(entries: Record<string, string | Buffer>): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (data: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of data) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = typeof text === 'string' ? Buffer.from(text) : text;
    const path = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    locals.push(local, path, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(path.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, path);
    offset += 30 + path.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const choose = async (page: Page): Promise<void> => {
  const buffer = storedZip({ 'The Landing.textbundle/info.json': INFO_JSON, 'The Landing.textbundle/text.md': TEXT_MD });
  await page.locator('input[type="file"][aria-label="TextPack file"]').setInputFiles({ name: 'novel.textpack', mimeType: 'application/zip', buffer });
};

test('a TextPack opens split at its headings, and Import puts its documents in the binder as one step', async ({ page }) => {
  await createProject(page, 'TextBundle Import');
  await choose(page);

  const dialog = page.getByRole('dialog', { name: 'Import “novel.textpack”' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.import-preview-detected')).toContainText('2 chapters');
  // The Ulysses comment is reported as kept as a note, not dropped.
  await expect(dialog).toContainText('1 Ulysses comment kept as a note.');

  // Cancel writes nothing.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await traceNames(page)).not.toContain('binder.importTree');

  await choose(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Import 2 chapters' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);

  expect((await traceNames(page)).filter((name) => name === 'binder.importTree')).toHaveLength(1);
  const tree = await treeOf(page);
  const chapters = tree.filter((node) => node.parentId === 'manuscript' && node.type === 'folder').map((node) => node.title);
  expect(chapters).toEqual(expect.arrayContaining(['Chapter One', 'Chapter Two']));
  const one = tree.find((node) => node.title === 'Chapter One');
  const scenes = tree.filter((node) => node.parentId === one?.id && node.type === 'document');
  expect(scenes).toHaveLength(2);
  expect(await bodyOf(page, scenes[0]?.id ?? '')).toContain('The ferry came at noon.');
  expect(await bodyOf(page, scenes[1]?.id ?? '')).toContain('By evening the wind had turned.');
});
const bearInfo = (title: string, created: string): string =>
  JSON.stringify({ version: 2, creatorIdentifier: 'net.shinyfrog.bear', title, 'net.shinyfrog.bear': { creationDate: created, modificationDate: created } });

const BACKUP: Record<string, string> = {
  'Bear Notes/BBB.textbundle/info.json': bearInfo('The Lamp', '2024-05-02T10:00:00Z'),
  'Bear Notes/BBB.textbundle/text.md': 'She lit the lamp. #harbour/night\n',
  'Bear Notes/AAA.textbundle/info.json': bearInfo('The Landing', '2024-05-01T10:00:00Z'),
  'Bear Notes/AAA.textbundle/text.md': 'The ferry came. #sea\n',
};

const chooseBackup = async (page: Page): Promise<void> => {
  await page.locator('input[type="file"][aria-label="TextPack file"]').setInputFiles({ name: 'notes.bear2bk', mimeType: 'application/zip', buffer: storedZip(BACKUP) });
};

test('a Bear backup imports its notes oldest first into Research, with its dates kept and its tags as keywords', async ({ page }) => {
  await createProject(page, 'Bear Backup');
  await chooseBackup(page);
  const dialog = page.getByRole('dialog', { name: 'Import “notes.bear2bk”' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.import-preview-tree')).toContainText('The Landing');
  await expect(dialog).toContainText('2 Bear tags kept as keywords.');
  await expect(dialog).toContainText('2 notes kept their Bear dates as note lines');
  await expect(dialog.getByRole('combobox', { name: 'Bear tags', exact: true })).toHaveValue('keywords');

  await dialog.getByRole('button', { name: 'Import 2 chapters' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);
  expect((await traceNames(page)).filter((name) => name === 'binder.importTree')).toHaveLength(1);

  const tree = await treeOf(page);
  // Research, not the manuscript: a note app's archive stays beside the book.
  expect(tree.filter((node) => node.parentId === 'manuscript')).toHaveLength(0);
  const notes = tree.filter((node) => node.parentId === 'research' && node.type === 'folder');
  expect(notes.map((node) => node.title)).toEqual(['The Landing', 'The Lamp']);
  const first = tree.find((node) => node.parentId === notes[0]?.id && node.type === 'document');
  expect(await bodyOf(page, first?.id ?? '')).toContain('The ferry came.');
});

test('sorting a Bear backup by tag puts its notes in tag folders in the manuscript', async ({ page }) => {
  await createProject(page, 'Bear Tags');
  await chooseBackup(page);
  const dialog = page.getByRole('dialog', { name: 'Import “notes.bear2bk”' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Bear tags', exact: true }).selectOption('folders');
  await expect(dialog.locator('.import-preview-tree')).toContainText('harbour');
  await expect(dialog.locator('.import-preview-tree')).toContainText('night');

  await dialog.getByRole('button', { name: /Import/ }).last().click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);
  const tree = await treeOf(page);
  expect(tree.filter((node) => node.parentId === 'research')).toHaveLength(0);
  const top = tree.filter((node) => node.parentId === 'manuscript' && node.type === 'folder').map((node) => node.title);
  expect(top).toEqual(['sea', 'harbour']);
  const harbour = tree.find((node) => node.title === 'harbour');
  const night = tree.find((node) => node.parentId === harbour?.id && node.type === 'folder');
  expect(night?.title).toBe('night');
  const lamp = tree.find((node) => node.parentId === night?.id && node.type === 'folder');
  expect(lamp?.title).toBe('The Lamp');
});

test('an iA Writer project takes its Content Blocks in index order and names the CSV as an approximation', async ({ page }) => {
  await createProject(page, 'iA Project');
  const project: Record<string, string | Buffer> = {
    'Book.textbundle/info.json': JSON.stringify({ creatorIdentifier: 'pro.writer.mac', title: 'The Book' }),
    'Book.textbundle/text.md': ['/Chapter 2.md', '/images/lamp.png "The lamp"', '/data.csv', '/Chapter 1.md', '', '---', 'author: Jane', '...'].join('\n'),
    'Book.textbundle/Chapter 1.md': '# Chapter One\n\nThe ferry came.',
    'Book.textbundle/Chapter 2.md': '# Chapter Two\n\nThe letter arrived.',
    'Book.textbundle/data.csv': 'Name,Place\nAda,The Rock',
    // A real 1×1 PNG: the picture pipeline reads the bytes, so a fake would be refused.
    'Book.textbundle/images/lamp.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
  };
  await page.locator('input[type="file"][aria-label="TextPack file"]').setInputFiles({ name: 'Book.textpack', mimeType: 'application/zip', buffer: storedZip(project) });
  const dialog = page.getByRole('dialog', { name: 'Import “Book.textpack”' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('The iA Writer Authorship block was kept out of the body.');
  await expect(dialog).toContainText('3 iA Writer Content Blocks came in where the index lists them.');
  await expect(dialog).toContainText('1 CSV file became paragraphs');
  // Index order: Chapter Two before Chapter One.
  const tree = dialog.locator('.import-preview-tree');
  await expect(tree).toContainText('Chapter Two');
  await expect(tree).toContainText('Chapter One');

  await dialog.getByRole('button', { name: /Import/ }).last().click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);
  const nodes = await treeOf(page);
  const chapters = nodes.filter((node) => node.parentId === 'manuscript' && node.type === 'folder').map((node) => node.title);
  expect(chapters).toEqual(['Chapter Two', 'Chapter One']);
  const two = nodes.find((node) => node.title === 'Chapter Two');
  const scene = nodes.find((node) => node.parentId === two?.id && node.type === 'document');
  const body = await bodyOf(page, scene?.id ?? '');
  expect(body).toContain('The letter arrived.');
  expect(body).toContain('Ada, The Rock');
  expect(body).not.toContain('author: Jane');
  // The Content Block's picture came in with its caption, its ref rewritten to the project's assets path.
  expect(body).toContain('![The lamp](../assets/');
});

