/**
 * **Import AO3…** (issue #297): an Archive of Our Own work download, HTML or EPUB, opens in the shared import preview with its
 * tags as keywords, its characters offered as codex entries and its script removed, and Import writes the documents and the
 * codex entries as one `binder.importTree`. Cancel writes nothing.
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

// AO3's own shape, written here rather than copied from a work.
const TAGS =
  '<dl class="work meta group">' +
  '<dt class="rating tags">Rating:</dt><dd class="rating tags"><ul class="commas"><li><a class="tag" href="#">Teen And Up Audiences</a></li></ul></dd>' +
  '<dt class="fandom tags">Fandom:</dt><dd class="fandom tags"><ul class="commas"><li><a class="tag" href="#">The Ninth House</a></li></ul></dd>' +
  '<dt class="relationship tags">Relationship:</dt><dd class="relationship tags"><ul class="commas"><li><a class="tag" href="#">Elena/Mara</a></li></ul></dd>' +
  '<dt class="character tags">Character:</dt><dd class="character tags"><ul class="commas"><li><a class="tag" href="#">Elena</a></li><li><a class="tag" href="#">Mara</a></li></ul></dd>' +
  '<dt class="freeform tags">Additional Tags:</dt><dd class="freeform tags"><ul class="commas"><li><a class="tag" href="#">Slow Burn</a></li></ul></dd>' +
  '<dt class="language">Language:</dt><dd class="language">English</dd>' +
  '<dt class="stats">Stats:</dt><dd class="stats"><dl class="stats"><dt class="words">Words:</dt><dd class="words">4,321</dd></dl></dd>' +
  '</dl>';

const WORK_PREFACE =
  '<div class="preface group"><h2 class="title heading">The Ninth Wave</h2><h3 class="byline heading"><a rel="author" href="#">keeper</a></h3>' +
  '<div class="summary module"><h3 class="heading">Summary:</h3><blockquote class="userstuff"><p>Elena returns to the pier.</p></blockquote></div>' +
  '<div class="notes module"><h3 class="heading">Notes:</h3><blockquote class="userstuff"><p>Written for the exchange.</p></blockquote></div></div>';

const CHAPTER_ONE =
  '<div class="chapter preface group"><h3 class="title"><a href="#">Chapter 1: The Landing</a></h3>' +
  '<div class="chapter notes module"><blockquote class="userstuff"><p>Thanks to the beta.</p></blockquote></div></div>' +
  '<div class="userstuff module" role="article"><p>The ferry came at noon.</p><hr/><p>By evening the wind had turned.</p><script>alert(1)</script></div>';

const CHAPTER_TWO =
  '<div class="chapter preface group"><h3 class="title"><a href="#">Chapter 2: Salt</a></h3></div>' +
  '<div class="userstuff module" role="article"><p>The letter arrived on a Tuesday.</p><p><img src="https://example.com/x.png" alt="x"/></p></div>';

const END_NOTES = '<div id="work_endnotes" class="end notes module"><blockquote class="userstuff"><p>Sequel soon.</p></blockquote></div>';

const HTML =
  '<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>The Ninth Wave</title></head><body><div id="main">' +
  `${TAGS}<div id="workskin">${WORK_PREFACE}<div id="chapters">${CHAPTER_ONE}${CHAPTER_TWO}</div>${END_NOTES}</div></div></body></html>`;

const page = (body: string): string =>
  `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>t</title></head><body>${body}</body></html>`;

const BOOK: Record<string, string | Buffer> = {
  mimetype: 'application/epub+zip',
  'META-INF/container.xml':
    '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  'OEBPS/content.opf':
    '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Ninth Wave</dc:title><dc:creator>keeper</dc:creator><dc:language>en</dc:language></metadata>' +
    '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="tp" href="title.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest>' +
    '<spine><itemref idref="tp"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
  'OEBPS/nav.xhtml': page('<nav epub:type="toc"><ol><li><a href="ch1.xhtml">Chapter 1: The Landing</a></li><li><a href="ch2.xhtml">Chapter 2: Salt</a></li></ol></nav>'),
  'OEBPS/title.xhtml': page(`${TAGS}<div id="workskin">${WORK_PREFACE}</div>`),
  'OEBPS/ch1.xhtml': page(CHAPTER_ONE),
  'OEBPS/ch2.xhtml': page(`${CHAPTER_TWO}${END_NOTES}`),
};

const chooseHtml = async (page: Page): Promise<void> => {
  await page.locator('input[type="file"][aria-label="AO3 download"]').setInputFiles({ name: 'the-ninth-wave.html', mimeType: 'text/html', buffer: Buffer.from(HTML) });
};

const chooseEpub = async (page: Page): Promise<void> => {
  await page.locator('input[type="file"][aria-label="AO3 download"]').setInputFiles({ name: 'the-ninth-wave.epub', mimeType: 'application/epub+zip', buffer: storedZip(BOOK) });
};

test('an AO3 HTML download keeps its tags, characters and notes, and Import writes them as one step', async ({ page }) => {
  await createProject(page, 'AO3 Import');
  await chooseHtml(page);

  const dialog = page.getByRole('dialog', { name: 'Import “the-ninth-wave.html”' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.import-preview-detected')).toContainText('2 chapters');
  const carried = dialog.getByRole('list', { name: 'What the work carried' });
  await expect(carried).toContainText('6 tags became keywords');
  await expect(carried).toContainText('2 characters are offered as codex entries');
  await expect(carried).toContainText('4 notes from the work are kept');
  await expect(carried).toContainText('The summary became the synopsis.');
  await expect(dialog.getByRole('list', { name: 'What the import removed' })).toContainText('1 script was removed');
  await expect(dialog.getByRole('list', { name: 'What was not downloaded' })).toContainText('1 picture on the internet was not downloaded');
  // The characters are offered, not written yet.
  const codex = dialog.getByRole('region', { name: 'Codex rows' });
  await expect(codex).toContainText('Elena');
  await expect(codex).toContainText('Mara');

  // Cancel writes nothing.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await traceNames(page)).not.toContain('binder.importTree');

  await chooseHtml(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Import 2 chapters' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);

  expect((await traceNames(page)).filter((name) => name === 'binder.importTree')).toHaveLength(1);
  const tree = await treeOf(page);
  const chapters = tree.filter((node) => node.parentId === 'manuscript' && node.type === 'folder').map((node) => node.title);
  expect(chapters).toEqual(['Chapter 1: The Landing', 'Chapter 2: Salt']);
  const one = tree.find((node) => node.title === 'Chapter 1: The Landing');
  const scenes = tree.filter((node) => node.parentId === one?.id && node.type === 'document');
  expect(scenes).toHaveLength(2);
  const body = await bodyOf(page, scenes[0]?.id ?? '');
  expect(body).toContain('The ferry came at noon.');
  expect(body).not.toContain('alert');
  // The tag list and the preface did not become prose.
  expect(body).not.toContain('Slow Burn');

  // The characters are in the codex, written by the same step.
  await page.getByRole('tab', { name: 'Codex' }).click();
  const entries = page.getByRole('region', { name: 'Codex entries' });
  await expect(entries).toContainText('Elena');
  await expect(entries).toContainText('Mara');
});

test('the EPUB download of the same work gives the same chapters and the same keywords', async ({ page }) => {
  await createProject(page, 'AO3 EPUB Import');
  await chooseEpub(page);

  const dialog = page.getByRole('dialog', { name: 'Import “the-ninth-wave.epub”' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.import-preview-detected')).toContainText('2 chapters');
  const carried = dialog.getByRole('list', { name: 'What the work carried' });
  await expect(carried).toContainText('6 tags became keywords');
  await expect(carried).toContainText('2 characters are offered as codex entries');
  await expect(dialog.getByRole('list', { name: 'What the import removed' })).toContainText('1 script was removed');

  await dialog.getByRole('button', { name: 'Import 2 chapters' }).click();
  await expect(dialog).toBeHidden();
  await waitForSaved(page);

  const tree = await treeOf(page);
  expect(tree.filter((node) => node.parentId === 'manuscript' && node.type === 'folder').map((node) => node.title)).toEqual(['Chapter 1: The Landing', 'Chapter 2: Salt']);
  // The preface page is not a chapter and not prose.
  expect(tree.some((node) => node.title === 'The Ninth Wave' && node.parentId === 'manuscript')).toBe(false);
});
