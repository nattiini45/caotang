/**
 * **Import EPUB…** (issue #296): an EPUB chosen in the binder opens in the shared import preview, its chapters named from the
 * book's own contents, its title page offered as Research and its script removed, and Import writes the documents as one
 * `binder.importTree`. Cancel writes nothing.
 */

import { expect, test, type Page } from '@playwright/test';

import { bodyOf, createProject, traceNames, treeOf, waitForSaved } from './support.js';

/** A zip whose entries are stored, not compressed: enough to hand the app a book without a zip tool. */
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

/** A 1×1 PNG, so the picture pipeline accepts the cover. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const page = (body: string): string =>
  `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>t</title></head><body>${body}</body></html>`;

const BOOK: Record<string, string | Buffer> = {
  mimetype: 'application/epub+zip',
  'META-INF/container.xml':
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  'OEBPS/content.opf':
    '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">' +
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Lighthouse Keeper</dc:title><dc:creator>Mara Vale</dc:creator><dc:language>en</dc:language></metadata>' +
    '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
    '<item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>' +
    '<item id="tp" href="text/title.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/></manifest>' +
    '<spine><itemref idref="tp"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
  'OEBPS/nav.xhtml': page(
    '<nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">Chapter One: The Landing</a></li><li><a href="text/ch2.xhtml">Chapter Two: Salt</a></li></ol></nav>' +
      '<nav epub:type="landmarks"><ol><li><a epub:type="titlepage" href="text/title.xhtml">Title page</a></li></ol></nav>',
  ),
  'OEBPS/images/cover.png': PNG,
  'OEBPS/text/title.xhtml': page('<p>The Lighthouse Keeper, by Mara Vale.</p>'),
  'OEBPS/text/ch1.xhtml': page('<h1>The Landing</h1><p>The ferry came at noon.</p><hr/><p>By evening the wind had turned.</p><script>alert(1)</script>'),
  'OEBPS/text/ch2.xhtml': page('<h1>Salt</h1><p>The letter arrived on a Tuesday.</p>'),
};

const choose = async (page: Page): Promise<void> => {
  await page.locator('input[type="file"][aria-label="EPUB file"]').setInputFiles({ name: 'keeper.epub', mimeType: 'application/epub+zip', buffer: storedZip(BOOK) });
};

test('an EPUB opens named from its contents, and Import writes the documents as one step', async ({ page }) => {
  await createProject(page, 'EPUB Import');
  await choose(page);

  const dialog = page.getByRole('dialog', { name: 'Import “keeper.epub”' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.import-preview-detected')).toContainText('2 chapters');
  // The book's own contents name the chapters, and its title page is offered as Research.
  await expect(dialog.getByRole('list', { name: 'What the book named' })).toContainText('2 chapter titles came from the book’s contents');
  await expect(dialog.getByRole('list', { name: 'What the book named' })).toContainText('1 section the book marks as matter is offered as Research');
  await expect(dialog.getByRole('list', { name: 'What the import removed' })).toContainText('1 script was removed');

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
  expect(chapters).toEqual(['Chapter One: The Landing', 'Chapter Two: Salt']);
  const one = tree.find((node) => node.title === 'Chapter One: The Landing');
  const scenes = tree.filter((node) => node.parentId === one?.id && node.type === 'document');
  expect(scenes).toHaveLength(2);
  const body = await bodyOf(page, scenes[0]?.id ?? '');
  expect(body).toContain('The ferry came at noon.');
  expect(body).not.toContain('alert');
  // The title page went to Research, not into the manuscript.
  expect(tree.some((node) => node.parentId === 'research' && node.type === 'document')).toBe(true);
});
