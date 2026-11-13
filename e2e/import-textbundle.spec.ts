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

// A stored (uncompressed) zip, built here so the spec needs no archive dependency.
function storedZip(entries: Record<string, string>): Buffer {
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
    const data = Buffer.from(text);
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
