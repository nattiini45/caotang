/**
 * **Import HTML…** (issue #299): a Google Docs web-page zip chosen in the binder opens in the shared import preview, its headings
 * split into chapters, its script removed and its remote picture listed, and Import writes the documents as one `binder.importTree`.
 * Cancel writes nothing.
 */

import { expect, test, type Page } from '@playwright/test';

import { bodyOf, createProject, traceNames, treeOf, waitForSaved } from './support.js';

/** A zip whose entries are stored, not compressed: enough to hand the app a web page without a zip tool. */
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

/** A 1×1 PNG, so the picture pipeline accepts the resolved image. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const EXPORT: Record<string, string | Buffer> = {
  'page.html':
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>The Landing</title></head><body>' +
    '<h1>Chapter One</h1><p>The ferry came at noon.</p>' +
    '<h1>Chapter Two</h1><p>The letter arrived on a Tuesday.</p>' +
    '<script>alert(1)</script>' +
    '<p><img src="images/cover.png" alt="cover"/><img src="https://example.com/x.png" alt="remote"/></p>' +
    '</body></html>',
  'images/cover.png': PNG,
};

const choose = async (page: Page): Promise<void> => {
  await page.locator('input[type="file"][aria-label="HTML file"]').setInputFiles({ name: 'page.zip', mimeType: 'application/zip', buffer: storedZip(EXPORT) });
};

test('a web-page zip opens with its script removed and remote picture listed, and Import writes the documents as one step', async ({ page }) => {
  await createProject(page, 'HTML Import');
  await choose(page);

  const dialog = page.getByRole('dialog', { name: 'Import “page.zip”' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.import-preview-detected')).toContainText('2 chapters');
  // The report names the removed script and the remote picture that was not downloaded.
  await expect(dialog.getByRole('list', { name: 'What the import removed' })).toContainText('1 script was removed');
  await expect(dialog.getByRole('list', { name: 'What was not downloaded' })).toContainText('1 picture on the internet was not downloaded');

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
  const body = await bodyOf(page, scenes[0]?.id ?? '');
  expect(body).toContain('The ferry came at noon.');
  expect(body).not.toContain('alert');
});
