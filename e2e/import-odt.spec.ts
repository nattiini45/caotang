/**
 * **Import OpenDocument…** (issue #298): an `.odt` chosen in the binder opens in the shared import preview with its chapters from
 * its own outline levels, its tracked changes as a choice, and its footnote kept; Import writes the documents as one
 * `binder.importTree`. Cancel writes nothing.
 */

import { expect, test, type Page } from '@playwright/test';

import { bodyOf, createProject, traceNames, treeOf, waitForSaved } from './support.js';

/** A zip whose entries are stored, not compressed: enough to hand the app an ODF package without a zip tool. */
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

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"';

const REGIONS =
  '<text:tracked-changes>' +
  '<text:changed-region text:id="i1"><text:insertion><dc:creator>Mara</dc:creator></text:insertion></text:changed-region>' +
  '<text:changed-region text:id="d1"><text:deletion><text:p>left at dawn</text:p></text:deletion></text:changed-region>' +
  '</text:tracked-changes>';

const BODY =
  '<text:h text:outline-level="1">The Landing</text:h>' +
  REGIONS +
  '<text:p>The ferry <text:change-start text:change-id="i1"/>came at noon<text:change-end text:change-id="i1"/><text:change text:change-id="d1"/>' +
  '<text:note text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body><text:p>At noon exactly.</text:p></text:note-body></text:note></text:p>' +
  '<text:h text:outline-level="1">Salt</text:h><text:p>The letter arrived on a Tuesday.</text:p>';

const ODT: Record<string, string | Buffer> = {
  mimetype: 'application/vnd.oasis.opendocument.text',
  'content.xml': `<?xml version="1.0"?><office:document-content ${NS}><office:body><office:text>${BODY}</office:text></office:body></office:document-content>`,
  'meta.xml': `<?xml version="1.0"?><office:document-meta ${NS}><office:meta><dc:title>The Ninth Wave</dc:title></office:meta></office:document-meta>`,
};

const choose = async (page: Page): Promise<void> => {
  await page.locator('input[type="file"][aria-label="OpenDocument file"]').setInputFiles({
    name: 'manuscript.odt',
    mimeType: 'application/vnd.oasis.opendocument.text',
    buffer: storedZip(ODT),
  });
};

test('an OpenDocument manuscript opens split at its outline levels, and Import writes the documents as one step', async ({ page }) => {
  await createProject(page, 'ODT Import');
  await choose(page);

  const dialog = page.getByRole('dialog', { name: 'Import “manuscript.odt”' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.import-preview-detected')).toContainText('2 chapters');
  const carried = dialog.getByRole('list', { name: 'What the file carried' });
  await expect(carried).toContainText('1 insertion was read');
  await expect(carried).toContainText('1 deletion was read');
  await expect(carried).toContainText('1 note became a footnote of its scene');
  await expect(dialog).toContainText('came at noon');

  await dialog.getByRole('group', { name: 'Rules' }).getByLabel('Tracked changes').selectOption('reject');
  await expect(dialog).toContainText('left at dawn');

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
  expect(chapters).toEqual(['The Landing', 'Salt']);
  const one = tree.find((node) => node.title === 'The Landing');
  const scenes = tree.filter((node) => node.parentId === one?.id && node.type === 'document');
  const body = await bodyOf(page, scenes[0]?.id ?? '');
  expect(body).toContain('The ferry came at noon');
  expect(body).toContain('[^1]: At noon exactly.');
});

test('a file that is not OpenDocument is refused with a plain message', async ({ page }) => {
  await createProject(page, 'ODT Refusal');
  await page.locator('input[type="file"][aria-label="OpenDocument file"]').setInputFiles({
    name: 'notes.odt',
    mimeType: 'application/vnd.oasis.opendocument.text',
    buffer: storedZip({ 'notes.txt': 'a letter' }),
  });
  await expect(page.getByText('This is not an OpenDocument text file.')).toBeVisible();
  expect(await traceNames(page)).not.toContain('binder.importTree');
});
