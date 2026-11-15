/**
 * The AO3 adapter (#297, epic #263): a synthetic replica of an Archive of Our Own work download, as HTML and as
 * EPUB, read into the same structure and the same metadata. No real work is copied; the markup is AO3's own shape.
 */

import { describe, expect, it } from 'vitest';

import { splitImport } from '@caotang/import-core';
import { rawZip } from '../../import-read/test/zip-fixtures.js';

import { ao3Keywords, ao3SeriesNote, looksLikeAo3, parseAo3Preface } from '../src/preface.js';
import { readAo3Epub, readAo3Html } from '../src/reader.js';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const zipOf = (files: Record<string, string>): Uint8Array => rawZip(Object.entries(files).map(([path, value]) => ({ name: path, data: enc(value) })));

const TAGS =
  '<dl class="work meta group">' +
  '<dt class="rating tags">Rating:</dt><dd class="rating tags"><ul class="commas"><li><a class="tag" href="#">Teen And Up Audiences</a></li></ul></dd>' +
  '<dt class="warning tags">Archive Warning:</dt><dd class="warning tags"><ul class="commas"><li><a class="tag" href="#">No Archive Warnings Apply</a></li></ul></dd>' +
  '<dt class="category tags">Category:</dt><dd class="category tags"><ul class="commas"><li><a class="tag" href="#">F/F</a></li></ul></dd>' +
  '<dt class="fandom tags">Fandom:</dt><dd class="fandom tags"><ul class="commas"><li><a class="tag" href="#">The Ninth House</a></li></ul></dd>' +
  '<dt class="relationship tags">Relationship:</dt><dd class="relationship tags"><ul class="commas"><li><a class="tag" href="#">Elena/Mara</a></li></ul></dd>' +
  '<dt class="character tags">Character:</dt><dd class="character tags"><ul class="commas"><li><a class="tag" href="#">Elena</a></li><li><a class="tag" href="#">Mara</a></li></ul></dd>' +
  '<dt class="freeform tags">Additional Tags:</dt><dd class="freeform tags"><ul class="commas"><li><a class="tag" href="#">Slow Burn</a></li><li><a class="tag" href="#">Elena</a></li></ul></dd>' +
  '<dt class="language">Language:</dt><dd class="language">English</dd>' +
  '<dt class="series">Series:</dt><dd class="series"><span class="series"><a href="#">The Pier</a> Part 2</span></dd>' +
  '<dt class="stats">Stats:</dt><dd class="stats"><dl class="stats"><dt class="published">Published:</dt><dd class="published">2024-01-01</dd><dt class="words">Words:</dt><dd class="words">4,321</dd><dt class="chapters">Chapters:</dt><dd class="chapters">2/2</dd></dl></dd>' +
  '</dl>';

const WORK_PREFACE =
  '<div class="preface group">' +
  '<h2 class="title heading">The Ninth Wave</h2>' +
  '<h3 class="byline heading"><a rel="author" href="#">keeper</a></h3>' +
  '<div class="summary module"><h3 class="heading">Summary:</h3><blockquote class="userstuff"><p>Elena returns to the pier.</p></blockquote></div>' +
  '<div class="notes module"><h3 class="heading">Notes:</h3><blockquote class="userstuff"><p>Written for the exchange.</p></blockquote></div>' +
  '</div>';

const CHAPTER_ONE_NOTES = '<div class="chapter notes module"><h3 class="heading">Notes:</h3><blockquote class="userstuff"><p>Thanks to the beta.</p></blockquote></div>';
const CHAPTER_ONE = '<div class="chapter preface group"><h3 class="title"><a href="#">Chapter 1: The Landing</a></h3>' + CHAPTER_ONE_NOTES + '</div>' + '<div class="userstuff module" role="article"><p>The ferry came at noon.</p><hr/><p>By evening the wind had turned.</p></div>';
const CHAPTER_TWO = '<div class="chapter preface group"><h3 class="title"><a href="#">Chapter 2: Salt</a></h3></div>' + '<div class="userstuff module" role="article"><p>The letter arrived on a Tuesday.</p></div>';
const END_NOTES = '<div id="work_endnotes" class="end notes module"><h3 class="heading">Notes:</h3><blockquote class="userstuff"><p>Sequel soon.</p></blockquote></div>';

const HTML = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>The Ninth Wave</title></head><body><div id="main">${TAGS}<div id="workskin">${WORK_PREFACE}<div id="chapters">${CHAPTER_ONE}${CHAPTER_TWO}</div>${END_NOTES}</div></div></body></html>`;

const page = (body: string): string => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`;

const EPUB = zipOf({
  mimetype: 'application/epub+zip',
  'META-INF/container.xml': '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  'OEBPS/content.opf':
    '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Ninth Wave</dc:title><dc:creator>keeper</dc:creator><dc:language>en</dc:language></metadata>' +
    '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="tp" href="title.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest>' +
    '<spine><itemref idref="tp"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
  'OEBPS/nav.xhtml': page('<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="ch1.xhtml">Chapter 1: The Landing</a></li><li><a href="ch2.xhtml">Chapter 2: Salt</a></li></ol></nav>'),
  'OEBPS/title.xhtml': page(`${TAGS}<div id="workskin">${WORK_PREFACE}</div>`),
  'OEBPS/ch1.xhtml': page(CHAPTER_ONE),
  'OEBPS/ch2.xhtml': page(`${CHAPTER_TWO}${END_NOTES}`),
});

describe('the AO3 preface (#297)', () => {
  it('reads every tag row, the title, the byline, the summary and the notes', () => {
    const preface = parseAo3Preface(HTML);
    expect(preface).not.toBeNull();
    if (preface === null) return;
    expect(preface.meta).toMatchObject({
      title: 'The Ninth Wave',
      author: 'keeper',
      rating: ['Teen And Up Audiences'],
      warnings: ['No Archive Warnings Apply'],
      categories: ['F/F'],
      fandoms: ['The Ninth House'],
      relationships: ['Elena/Mara'],
      characters: ['Elena', 'Mara'],
      freeform: ['Slow Burn', 'Elena'],
      language: 'English',
      series: ['The Pier Part 2'],
      summary: 'Elena returns to the pier.',
      notes: 'Written for the exchange.',
      endNotes: 'Sequel soon.',
    });
    expect(preface.meta.stats).toMatchObject({ published: '2024-01-01', words: '4,321', chapters: '2/2' });
    expect(preface.chapters).toEqual([
      { title: 'Chapter 1: The Landing', summary: '', notes: 'Thanks to the beta.' },
      { title: 'Chapter 2: Salt', summary: '', notes: '' },
    ]);
  });

  it('keeps every tag as a keyword once, and the series and stats as a note', () => {
    const preface = parseAo3Preface(HTML);
    if (preface === null) throw new Error('no preface');
    expect(ao3Keywords(preface.meta)).toEqual(['Teen And Up Audiences', 'No Archive Warnings Apply', 'F/F', 'The Ninth House', 'Elena/Mara', 'Elena', 'Mara', 'Slow Burn']);
    expect(ao3SeriesNote(preface.meta)).toBe('Series: The Pier Part 2\nLanguage: English\nPublished: 2024-01-01 · Words: 4,321 · Chapters: 2/2');
  });

  it('is not an AO3 page when it carries none of AO3’s structure', () => {
    expect(looksLikeAo3('<html><body><p>A letter.</p></body></html>')).toBe(false);
    expect(parseAo3Preface('<html><body><p>A letter.</p></body></html>')).toBeNull();
  });
});

describe('the AO3 HTML download (#297)', () => {
  it('keeps the prose and the chapter headings, and the preface out of the text', () => {
    const read = readAo3Html(enc(HTML), 'the-ninth-wave.html');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const text = JSON.stringify(read.value.document.blocks);
    expect(text).toContain('The ferry came at noon.');
    expect(text).not.toContain('Slow Burn');
    expect(text).not.toContain('Elena returns to the pier.');
    expect(text).not.toContain('Thanks to the beta.');
    expect(text).not.toContain('keeper');

    const split = splitImport(read.value.document);
    expect(split.title?.text).toBe('The Ninth Wave');
    expect(split.tree.map((node) => node.title)).toEqual(['Chapter 1: The Landing', 'Chapter 2: Salt']);
    const first = split.tree[0];
    expect(first?.kind === 'folder' ? first.children.length : 0).toBe(2);
  });

  it('places the work summary, the work notes, the chapter notes and the end notes', () => {
    const read = readAo3Html(enc(HTML), 'the-ninth-wave.html');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.notes.map((note) => [note.kind, note.text])).toEqual([
      ['work-summary', 'Elena returns to the pier.'],
      ['work-notes', 'Written for the exchange.'],
      ['chapter-notes', 'Thanks to the beta.'],
      ['end-notes', 'Sequel soon.'],
    ]);
    expect(read.value.keywords).toContain('Slow Burn');
    expect(read.value.format).toBe('html');
  });

  it('refuses a page that is not an AO3 download', () => {
    const read = readAo3Html(enc('<html><body><p>A letter.</p></body></html>'), 'letter.html');
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.kind).toBe('not-ao3');
  });

  it('lists a remote picture and counts a dropped script', () => {
    const hostile = HTML.replace('<p>The letter arrived on a Tuesday.</p>', '<p>The letter arrived on a Tuesday.</p><script>alert(1)</script><p><img src="https://example.com/x.png" alt="x"/></p>');
    const read = readAo3Html(enc(hostile), 'work.html');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.remoteImages).toEqual(['https://example.com/x.png']);
    expect(read.value.dropped.scripts).toBe(1);
    expect(JSON.stringify(read.value.document.blocks)).not.toContain('alert(1)');
  });
});

describe('the AO3 EPUB download (#297)', () => {
  it('reads the same metadata and the same chapters as the HTML download', async () => {
    const html = readAo3Html(enc(HTML), 'the-ninth-wave.html');
    const epub = await readAo3Epub(EPUB);
    expect(html.ok).toBe(true);
    expect(epub.ok).toBe(true);
    if (!html.ok || !epub.ok) return;

    expect(epub.value.keywords).toEqual(html.value.keywords);
    expect(epub.value.summary).toBe(html.value.summary);
    expect(epub.value.seriesNote).toBe(html.value.seriesNote);
    expect(epub.value.title).toBe(html.value.title);
    expect(epub.value.format).toBe('epub');
    expect(epub.value.chapters.map((chapter) => chapter.title)).toEqual(['Chapter 1: The Landing', 'Chapter 2: Salt']);
    expect(epub.value.notes.map((note) => [note.kind, note.text])).toEqual([
      ['work-summary', 'Elena returns to the pier.'],
      ['work-notes', 'Written for the exchange.'],
      ['chapter-notes', 'Thanks to the beta.'],
      ['end-notes', 'Sequel soon.'],
    ]);

    const text = JSON.stringify(epub.value.document.blocks);
    expect(text).toContain('The ferry came at noon.');
    expect(text).not.toContain('Slow Burn');
    expect(text).not.toContain('Thanks to the beta.');
  });

  it('refuses an EPUB with no AO3 preface', async () => {
    const plain = zipOf({
      'META-INF/container.xml': '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      'content.opf': '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
      'ch1.xhtml': page('<h1>One</h1><p>A letter.</p>'),
    });
    const read = await readAo3Epub(plain);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.kind).toBe('not-ao3');
  });
});
