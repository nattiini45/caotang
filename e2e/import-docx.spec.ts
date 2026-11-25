/**
 * **Import Word…** (issue #279): a `.docx` chosen in the binder opens in the shared import preview with its chapters from its
 * heading styles, its tracked changes as a choice, and its footnote and comment kept; Import writes the documents as one
 * `binder.importTree`. Cancel writes nothing.
 */

import { expect, test, type Page } from '@playwright/test';

import { bodyOf, createProject, traceNames, treeOf, waitForSaved } from './support.js';

/** A zip whose entries are stored, not compressed: enough to hand the app a Word file without a zip tool. */
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

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const part = (name: string, body: string): string => `<?xml version="1.0" encoding="UTF-8"?><w:${name} ${NS}>${body}</w:${name}>`;
const para = (text: string, style?: string): string =>
  `<w:p><w:pPr>${style === undefined ? '' : `<w:pStyle w:val="${style}"/>`}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const STYLES =
  '<w:style w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>' +
  '<w:style w:styleId="ChapterTitle"><w:name w:val="Chapter Title"/><w:basedOn w:val="Heading1"/></w:style>';

const BODY =
  para('The Landing', 'ChapterTitle') +
  '<w:p><w:commentRangeStart w:id="1"/><w:r><w:t xml:space="preserve">The ferry </w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r>' +
  '<w:ins w:id="1" w:author="Mara"><w:r><w:t>came at noon</w:t></w:r></w:ins><w:del w:id="2" w:author="Mara"><w:r><w:delText>left at dawn</w:delText></w:r></w:del>' +
  '<w:r><w:footnoteReference w:id="1"/></w:r></w:p>' +
  para('Salt', 'Heading1') +
  para('The letter arrived on a Tuesday.');

const WORD: Record<string, string | Buffer> = {
  'word/document.xml': part('document', `<w:body>${BODY}</w:body>`),
  'word/styles.xml': part('styles', STYLES),
  'word/footnotes.xml': part('footnotes', `<w:footnote w:id="1">${para('At noon exactly.')}</w:footnote>`),
  'word/comments.xml': part('comments', `<w:comment w:id="1" w:author="Mara Vale" w:date="2026-11-01T10:00:00Z">${para('Check the time.')}</w:comment>`),
  'docProps/core.xml':
    '<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Ninth Wave</dc:title><dc:creator>Mara Vale</dc:creator></cp:coreProperties>',
};

const choose = async (page: Page): Promise<void> => {
  await page.locator('input[type="file"][aria-label="Word file"]').setInputFiles({
    name: 'manuscript.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: storedZip(WORD),
  });
};

test('a Word manuscript opens split at its styles, and Import writes the documents as one step', async ({ page }) => {
  await createProject(page, 'Word Import');
  await choose(page);

  const dialog = page.getByRole('dialog', { name: 'Import “manuscript.docx”' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.import-preview-detected')).toContainText('2 chapters');
  const carried = dialog.getByRole('list', { name: 'What the file carried' });
  await expect(carried).toContainText('1 insertion was read');
  await expect(carried).toContainText('1 deletion was read');
  await expect(carried).toContainText('1 note became a footnote of its scene');
  await expect(carried).toContainText('1 comment became a scene note');
  await expect(dialog).toContainText('came at noon');

  // Rejecting the changes re-reads the file in the Worker and swaps the text.
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

test('a file that is not a Word document is refused with a plain message', async ({ page }) => {
  await createProject(page, 'Word Refusal');
  await page.locator('input[type="file"][aria-label="Word file"]').setInputFiles({
    name: 'notes.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: storedZip({ 'notes.txt': 'a letter' }),
  });
  await expect(page.getByText('This is not a Word .docx file.')).toBeVisible();
  expect(await traceNames(page)).not.toContain('binder.importTree');
});
