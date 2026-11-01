/**
 * The comic PDF (render-comic-pdf.ts, comics.md §5), read back the way the other PDFs are: pdf-lib for the page count, the boxes, the image
 * objects and the catalog, and pdf.js for the text a reader gets from the ToUnicode maps. A file that parses is not a file that prints: the
 * pages of the corpus are also drawn to PNG when `CAOTANG_COMIC_PDF_OUT` names a folder (see the end of this file), and looked at.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PDFNumber} from 'pdf-lib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { pageGeometry } from '@caotang/comic';
import {
  loadArabicFontInNode,
  loadCjkFontInNode,
  loadComicLetteringFontInNode,
  loadDevanagariFontInNode,
  loadEmojiFontInNode,
  loadHebrewFontInNode,
} from '@caotang/pdf-fonts/node-loader';

import { drawComicPdf, type ComicPdfBook, type ComicPdfInput } from '../src/render-comic-pdf.js';
import { LTR_BOOK, RTL_BOOK, mixedPage, readPicture, sixPanelPage, ART_JPEG, ART_LANDSCAPE, ART_PORTRAIT } from './comic-pdf-fixture.js';

const AT = new Date(Date.UTC(2026, 9, 30, 12, 0, 0));
const MM = 72 / 25.4;

const base = (book: ComicPdfBook, extra: Partial<ComicPdfInput> = {}): ComicPdfInput => ({
  book,
  readPicture,
  title: book.title,
  author: 'Ada Lovelace',
  at: AT,
  language: 'en',
  loadComicFont: loadComicLetteringFontInNode,
  loadFallbackFont: loadCjkFontInNode,
  loadEmojiFont: loadEmojiFontInNode,
  loadArabicFont: loadArabicFontInNode,
  loadHebrewFont: loadHebrewFontInNode,
  loadDevanagariFont: loadDevanagariFontInNode,
  ...extra,
});

const near = (actual: number, expected: number): void => expect(actual).toBeCloseTo(expected, 1);

async function boxes(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => ({
    media: page.getMediaBox(),
    crop: page.getCropBox(),
    bleed: page.getBleedBox(),
    trim: page.getTrimBox(),
  }));
}

interface ImageObject {
  readonly width: number;
  readonly height: number;
  readonly filter: string;
}

/** Every image XObject of the file: its size and the filter its bytes are stored with. */
async function imageObjects(bytes: Uint8Array): Promise<ImageObject[]> {
  const doc = await PDFDocument.load(bytes);
  const out: ImageObject[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    if (object.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    const filter = object.dict.get(PDFName.of('Filter'));
    out.push({
      width: (object.dict.get(PDFName.of('Width')) as PDFNumber).asNumber(),
      height: (object.dict.get(PDFName.of('Height')) as PDFNumber).asNumber(),
      filter: filter instanceof PDFName ? filter.asString().slice(1) : filter instanceof PDFArray ? String(filter.get(0)).slice(1) : '',
    });
  }
  return out;
}

/** The decoded content stream of each page, as text: the operators a page was drawn with. */
async function contentsOf(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
    return streams.map((stream) => Buffer.from(decodePDFRawStream(stream as PDFRawStream).decode()).toString('latin1')).join('\n');
  });
}

async function pdfjs() {
  const dir = join(process.cwd(), 'packages', 'exporter', 'node_modules', 'pdfjs-dist');
  const lib = (await import(/* @vite-ignore */ pathToFileURL(join(dir, 'legacy', 'build', 'pdf.mjs')).href)) as {
    getDocument(options: object): {
      promise: Promise<{
        numPages: number;
        getPage(n: number): Promise<{
          getTextContent(): Promise<{ items: { str?: string }[] }>;
          getOperatorList(): Promise<{ fnArray: number[] }>;
        }>;
      }>;
    };
  };
  return { dir, lib };
}

/** The text of every page as pdf.js gives it, items joined by a space. */
async function pdfjsPages(bytes: Uint8Array): Promise<string[]> {
  const { dir, lib } = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(bytes), verbosity: 0, standardFontDataUrl: `${join(dir, 'standard_fonts')}/`, useSystemFonts: false }).promise;
  const pages: string[] = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number);
    await page.getOperatorList();
    pages.push((await page.getTextContent()).items.map((item) => item.str ?? '').join(' '));
  }
  return pages;
}

/** The text with every space taken out, since layout decides where lines and items break. */
const squash = (text: string): string => text.replace(/\s/g, '');

// Each test lays out a page with real fonts, which a loaded machine runs well past the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

describe('the comic PDF: pages and boxes', () => {
  it('draws one PDF page for each comic page, in order, with the boxes of the page size', async () => {
    const { contents } = await drawComicPdf(base(LTR_BOOK));
    const all = await boxes(contents);
    expect(all).toHaveLength(2);
    const us = pageGeometry('us-comic');
    const a4 = pageGeometry('a4');
    for (const [index, geo] of [us, a4].entries()) {
      const box = all[index];
      if (box === undefined) throw new Error('missing page');
      const bleed = geo.bleedMm * MM;
      near(box.trim.width, geo.trimWidthMm * MM);
      near(box.trim.height, geo.trimHeightMm * MM);
      near(box.trim.x, bleed);
      near(box.trim.y, bleed);
      near(box.bleed.width, geo.trimWidthMm * MM + 2 * bleed);
      near(box.bleed.height, geo.trimHeightMm * MM + 2 * bleed);
      near(box.bleed.x, 0);
      near(box.media.width, box.bleed.width);
      near(box.media.height, box.bleed.height);
      expect(box.crop).toEqual(box.media);
    }
    expect(us.bleedMm).toBeCloseTo(3.175, 3);
    expect(a4.bleedMm).toBe(3);
  });

  it.each([
    ['us-comic', 6.625 * 25.4, 10.25 * 25.4, 0.125 * 25.4],
    ['manga-b5', 182, 257, 3],
    ['a4', 210, 297, 3],
    ['letter', 8.5 * 25.4, 11 * 25.4, 0.125 * 25.4],
  ])('sizes a %s page at its trim plus its bleed', async (size, widthMm, heightMm, bleedMm) => {
    const book: ComicPdfBook = { ...LTR_BOOK, pages: [{ id: 'n_SIZE', page: { size, panels: [] } }] };
    const [box] = await boxes((await drawComicPdf(base(book))).contents);
    near(box?.trim.width ?? 0, widthMm * MM);
    near(box?.trim.height ?? 0, heightMm * MM);
    near(box?.media.width ?? 0, (widthMm + 2 * bleedMm) * MM);
    near(box?.media.height ?? 0, (heightMm + 2 * bleedMm) * MM);
  });

  it('drops the bleed when it is off: the media, bleed and trim boxes are one', async () => {
    const [box] = await boxes((await drawComicPdf(base(LTR_BOOK, { bleed: false }))).contents);
    expect(box?.media).toEqual(box?.trim);
    expect(box?.bleed).toEqual(box?.trim);
  });

  it('adds crop marks outside the bleed, in the margin the media box grows by, and keeps the trim and bleed boxes true', async () => {
    const plain = (await boxes((await drawComicPdf(base(LTR_BOOK))).contents))[0];
    const marked = await drawComicPdf(base(LTR_BOOK, { cropMarks: true }));
    const [box] = await boxes(marked.contents);
    if (box === undefined || plain === undefined) throw new Error('missing page');
    const grow = (7 + 3.175) * MM - 3.175 * MM;
    near(box.media.width, plain.media.width + 2 * grow);
    near(box.trim.width, plain.trim.width);
    near(box.bleed.width, plain.bleed.width);
    near(box.trim.x, box.bleed.x + 3.175 * MM);
    expect(box.crop).toEqual(box.media);
    const [page] = await contentsOf(marked.contents);
    // Eight marks at each page: a registration colour and a stroke for each.
    expect((page?.match(/1 1 1 1 K/g) ?? []).length).toBe(1);
    expect((page?.match(/\bS\b/g) ?? []).length).toBeGreaterThanOrEqual(8);
    expect(marked.notes.join('\n')).toContain('crop marks');
  });

  it('marks a right-to-left book for readers that lay out spreads, and leaves a left-to-right book alone', async () => {
    const ltr = await PDFDocument.load((await drawComicPdf(base(LTR_BOOK))).contents);
    const rtl = await PDFDocument.load((await drawComicPdf(base(RTL_BOOK))).contents);
    expect(ltr.catalog.get(PDFName.of('ViewerPreferences'))).toBeUndefined();
    const prefs = rtl.catalog.lookup(PDFName.of('ViewerPreferences'), PDFDict);
    expect(prefs.get(PDFName.of('Direction'))).toBe(PDFName.of('R2L'));
  });
});

describe('the comic PDF: pictures', () => {
  it('embeds a JPEG as stored and a PNG once however many panels use it, and draws a missing picture as a grey frame', async () => {
    const { contents, notes } = await drawComicPdf(base({ ...LTR_BOOK, pages: [sixPanelPage()] }));
    const images = await imageObjects(contents);
    const flate = images.filter((image) => image.filter === 'FlateDecode');
    // The portrait is used twice and embedded once; the landscape once. The JPEG is stored as it was given.
    expect(flate.map((image) => `${image.width}x${image.height}`).sort()).toEqual(['200x300', '300x150']);
    expect(images.filter((image) => image.filter === 'DCTDecode')).toHaveLength(1);
    expect(notes.join('\n')).toContain('image a_ARTMISSING01 could not be read');
    const [text] = await pdfjsPages(contents);
    expect(text).toContain('Picture not found');
  });

  it('places a picture by its crop and runs a borderless panel on into the bleed', async () => {
    const { contents } = await drawComicPdf(base({ ...LTR_BOOK, pages: [sixPanelPage()] }));
    const [page] = await contentsOf(contents);
    const clips = [...(page ?? '').matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re\s+W\s+n/g)].map((m) => m.slice(1, 5).map(Number));
    // Four panels hold pictures; the two borderless ones are clipped to a box that reaches the bleed edge (x or y of 0, or the far edge).
    expect(clips).toHaveLength(4);
    const media = (await boxes(contents))[0]?.media;
    if (media === undefined) throw new Error('missing page');
    const reaching = clips.filter(([x, y, w, h]) => (x ?? 1) < 0.01 || (y ?? 1) < 0.01 || Math.abs((x ?? 0) + (w ?? 0) - media.width) < 0.01 || Math.abs((y ?? 0) + (h ?? 0) - media.height) < 0.01);
    expect(reaching).toHaveLength(2);
  });

  it('keeps a WebP out of the file unless a transcoder is given', async () => {
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
    const book: ComicPdfBook = { ...LTR_BOOK, pages: [{ id: 'n_WEBP', page: { size: 'us-comic', panels: [{ id: 'pn_webp', rect: [0, 0, 1, 1], assetId: 'a_WEBPPICTURE', balloons: [] }] } }] };
    const { notes } = await drawComicPdf(base(book, { readPicture: async () => webp }));
    expect(notes.join('\n')).toContain('is a WebP file, which the PDF cannot embed');
  });
});

describe('the comic PDF: lettering', () => {
  it('writes the lettering as searchable text: capitals made, emphasis markers gone, every script in its own font', async () => {
    const ltr = await drawComicPdf(base(LTR_BOOK));
    const [six, over] = (await pdfjsPages(ltr.contents)).map(squash);
    for (const line of [
      'WHEREWEREYOU?!IWAITEDALLNIGHT.',
      'MEANWHILE,ATTHEDOCKS...',
      'IWONDERIFSHEKNOWS...',
      "DON'TWAKETHEBABY.",
      'STOP!',
      'BASETOUNITTHREE,COMEIN.OVER.',
      'KRAKOOM',
      'WHOSAIDTHAT?',
      'THISPANELBLEEDSOFFTHELEFTANDBOTTOM.',
      'ONEVERYIMPORTANTWORD,THENANOTHERLONGEMPHASISEDPHRASETHATWRAPSOVERLINES.',
    ]) {
      expect(six, line).toContain(line);
    }
    expect(six).not.toContain('**');
    expect(over).toContain('ASHORTLINETHATFITS.');

    const rtl = await drawComicPdf(base(RTL_BOOK));
    const [manga, mixed] = (await pdfjsPages(rtl.contents)).map(squash);
    expect(manga).toContain(squash('今日はどこへ行くの？ 早くしなさい！'));
    expect(manga).toContain('東京、午前七時');
    // The text layer is in drawing order, so a right-to-left line reads from its left end: the words come last-first and the
    // question mark, which ends the sentence, stands at the left.
    expect(manga).toContain('?היוםשלומךמה,עולםשלום');
    expect(manga).toContain('بالعالممرحبا');
    expect(manga).toContain('HELLO');
    // ß is lettered ẞ in this book, which neither Comic Neue nor the CJK font has: Bangers draws it, and the text keeps it.
    expect(mixed).toContain('STRAẞEANDẞ');
    expect(mixed).toContain('ПРИВЕТ');
    expect(mixed).toContain('ΩΜΕΓΑ');
    expect(mixed).toContain('🎬');
    expect(mixed).toContain('तुमकहाँहो?');
    expect(rtl.notes.join('\n')).toContain('ẞ from Bangers');
    expect(rtl.notes.join('\n')).not.toContain('drawn as "?"');
  });

  it('draws a ß as SS in a book that has not opted into the capital sharp s', async () => {
    const book: ComicPdfBook = { ...RTL_BOOK, settings: { ...RTL_BOOK.settings, esszett: false }, pages: [mixedPage()] };
    const [text] = (await pdfjsPages((await drawComicPdf(base(book))).contents)).map(squash);
    expect(text).toContain('STRASSEANDẞ');
  });

  it('keeps the text as typed when the book keeps mixed case', async () => {
    const book: ComicPdfBook = { ...LTR_BOOK, settings: { ...LTR_BOOK.settings, capsTransform: false }, pages: [sixPanelPage()] };
    const [text] = (await pdfjsPages((await drawComicPdf(base(book))).contents)).map(squash);
    expect(text).toContain("Don'twakethebaby.");
  });

  it('sets text that does not fit at the floor, runs it past the balloon in red, and names the balloon in the log', async () => {
    const { contents, notes } = await drawComicPdf(base(LTR_BOOK));
    const overflow = notes.filter((note) => note.includes('does not fit'));
    expect(overflow).toHaveLength(1);
    expect(overflow[0]).toContain('page 2, panel 2, balloon 1');
    expect(overflow[0]).toContain('4.5 pt');
    const [, page] = await contentsOf(contents);
    expect(page).toContain('0.85 0.1 0.1 RG');
    const [, text] = (await pdfjsPages(contents)).map(squash);
    // Nothing is cut: the whole speech is in the text of the page.
    expect(text).toContain('BEFOREANYTHINGGOESTOPRINT.');
    const [first] = await contentsOf(contents);
    expect(first).not.toContain('0.85 0.1 0.1 RG');
  });

  it('refuses to draw balloons when no lettering font can be read, and draws a book with no lettering without one', async () => {
    await expect(drawComicPdf(base(LTR_BOOK, { loadComicFont: undefined as never }))).rejects.toThrow('cannot read the comic lettering fonts');
    const bare: ComicPdfBook = { ...LTR_BOOK, pages: [{ id: 'n_BARE', page: { size: 'a4', panels: [{ id: 'pn_bare', rect: [0, 0, 1, 1], balloons: [] }] } }] };
    const { contents } = await drawComicPdf({ ...base(bare), loadComicFont: undefined as never });
    expect((await boxes(contents)).length).toBe(1);
  });

  it('draws a character no font has as a question mark and says which', async () => {
    const book: ComicPdfBook = {
      ...LTR_BOOK,
      pages: [{ id: 'n_MISSING', page: { size: 'us-comic', panels: [{ id: 'pn_m', rect: [0, 0, 1, 1], balloons: [{ id: 'bl_m', kind: 'speech', text: 'Hi 𐎀', rect: [0.2, 0.2, 0.5, 0.2] }] }] } }],
    };
    const { notes } = await drawComicPdf(base(book));
    expect(notes.join('\n')).toContain('drawn as "?": 𐎀 (U+10380)');
  });

  it('says so, and still draws the page, when a fallback font is not wired', async () => {
    const { notes } = await drawComicPdf(base(RTL_BOOK, { loadFallbackFont: undefined, loadHebrewFont: undefined }));
    const text = notes.join('\n');
    expect(text).toContain('this compile has no fallback font');
    expect(text).toContain('this compile has no Hebrew font');
  });
});

describe('the comic PDF: paper frames', () => {
  it('draws numbered empty frames and each page\'s number, with no picture, no lettering and no font to read', async () => {
    const { contents, notes } = await drawComicPdf({ ...base(LTR_BOOK, { mode: 'paper-frame' }), loadComicFont: undefined as never });
    expect(await imageObjects(contents)).toEqual([]);
    const [one, two] = (await pdfjsPages(contents)).map(squash);
    expect(one).toContain('PAGE1');
    expect(two).toContain('PAGE2');
    expect(one).not.toContain('WHERE');
    expect(one).toMatch(/^1?.*6/);
    expect(notes.join('\n')).toContain('paper frames');
    expect(notes.join('\n')).not.toContain('Picture');
    expect(notes.join('\n')).not.toContain('RGB');
  });
});

describe('the comic PDF: the file', () => {
  it('writes one file for one compile: the same input is the same bytes', async () => {
    const one = await drawComicPdf(base(RTL_BOOK));
    const two = await drawComicPdf(base(RTL_BOOK));
    expect(Buffer.from(one.contents).equals(Buffer.from(two.contents))).toBe(true);
  });

  it('carries the title, the author and the language, and rejects a book with no page', async () => {
    const doc = await PDFDocument.load((await drawComicPdf(base(LTR_BOOK))).contents);
    expect(doc.getTitle()).toBe('The Dock');
    expect(doc.getAuthor()).toBe('Ada Lovelace');
    await expect(drawComicPdf(base({ ...LTR_BOOK, pages: [] }))).rejects.toThrow('no page');
  });

  it('states what it does not do for print in the log', async () => {
    const { notes } = await drawComicPdf(base(LTR_BOOK));
    expect(notes[0]).toContain('2 pages');
    expect(notes.join('\n')).toContain('RGB');
    expect(notes.join('\n')).toContain('before sending it to print');
  });
});

// The pages of the corpus, written out so each can be drawn and looked at: CAOTANG_COMIC_PDF_OUT=<dir>.
const OUT = process.env['CAOTANG_COMIC_PDF_OUT'];
describe.skipIf(OUT === undefined)('the comic PDF corpus, written for a look at the pages', () => {
  it('writes the files', async () => {
    const dir = OUT as string;
    mkdirSync(dir, { recursive: true });
    const variants: [string, ComicPdfBook, Partial<ComicPdfInput>][] = [
      ['ltr', LTR_BOOK, { cropMarks: true }],
      ['rtl', RTL_BOOK, {}],
      ['paper', LTR_BOOK, { mode: 'paper-frame', cropMarks: true }],
    ];
    for (const [name, book, extra] of variants) writeFileSync(join(dir, `${name}.pdf`), (await drawComicPdf(base(book, extra))).contents);
    expect([ART_PORTRAIT, ART_LANDSCAPE, ART_JPEG].length).toBe(3);
  });
});
