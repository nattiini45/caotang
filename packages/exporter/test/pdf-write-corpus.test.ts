/**
 * The PDF write corpus: both PDF writers' real output, written to disk for the independent validators in
 * tools/pdf-validate (qpdf, Poppler, Ghostscript, MuPDF, pdf.js). It writes only when CAOTANG_PDF_OUT names a directory, so
 * `pnpm verify` is unchanged; CI's pdf-validate job sets it, then runs `node tools/pdf-validate/check.mjs`.
 *
 * Every file goes through the exporter's own command port, as a click on Export does, with the recipe options a writer would
 * set, and the CJK, emoji, Arabic and Hebrew fonts loaded from disk as the desktop loads them. Next to the files it writes
 * expected.json: per file, its page count and size, the text each page must give back, and the fonts the file must name.
 * The validators trust that file, and this one checks it against the file it describes (pdf-lib counts the pages), so it cannot
 * drift from what was written.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { loadArabicFontInNode, loadCjkFontInNode, loadColourEmojiInNode, loadDevanagariFontInNode, loadEmojiFontInNode, loadHebrewFontInNode } from '@caotang/pdf-fonts/node-loader';
import { MemoryArtifactFs, type ExportRecipeOptions, type ProjectState } from '@caotang/store';
import { addShotNode } from '@caotang/storyboard';
import type { AssetRecord } from '@caotang/video-prompt-pack';
import { createExporter } from '../src/index.js';
import { COMPILED_AT } from './fixture.js';
import { ASSET_FILE, ASSETS, MEDIA_IDS, OPENED, makeMediaProject } from './media-fixture.js';

const OUT = process.env['CAOTANG_PDF_OUT'] ?? '';

/** What the validators must find in one file. `pages[i]` holds the strings page i + 1 must give back as text. */
interface Expected {
  readonly file: string;
  readonly format: 'pdf' | 'contact-sheet-pdf';
  readonly pages: readonly (readonly string[])[];
  readonly size: readonly [number, number];
  /** Every font the file names: a substring of its BaseFont, whether its program is embedded, and whether it carries a ToUnicode map. */
  readonly fonts: readonly { readonly name: string; readonly embedded: boolean; readonly toUnicode: boolean }[];
}

interface Case {
  readonly file: string;
  readonly build: () => { state: ProjectState; assets?: ReadonlyMap<string, AssetRecord>; files?: Record<string, Uint8Array> };
  readonly format: Expected['format'];
  readonly options?: ExportRecipeOptions;
  /** The project's language, when the case sets one. */
  readonly language?: string;
  readonly pages: Expected['pages'];
  readonly size: Expected['size'];
  readonly fonts: Expected['fonts'];
}

const LETTER = [612, 792] as const;
const A4 = [595.28, 841.89] as const;

const COURIER = { name: 'CourierPrime', embedded: true, toUnicode: false } as const;
const CJK = { name: 'NotoSansMonoCJKsc-Regular', embedded: true, toUnicode: true } as const;
const EMOJI = { name: 'NotoEmoji-Regular', embedded: true, toUnicode: true } as const;
const ARABIC = { name: 'NotoSansArabic-Regular', embedded: true, toUnicode: true } as const;
/** The colour emoji: a Type 3 font, which has no BaseFont and no font program, so the validators name it `Type3` (tools/pdf-validate/check.mjs). */
const TYPE3 = { name: 'Type3', embedded: true, toUnicode: true } as const;
const HEBREW = { name: 'NotoSansHebrew-Regular', embedded: true, toUnicode: true } as const;
const DEVANAGARI = { name: 'NotoSansDevanagari-Regular', embedded: true, toUnicode: true } as const;
/** The contact sheet's built-in font: base-14, so it is not embedded. */
const HELVETICA = { name: 'Helvetica', embedded: false, toUnicode: false } as const;

function sceneWith(body: string): ProjectState {
  const state = makeMediaProject();
  const kitchen = state.documents.get(MEDIA_IDS.kitchen);
  if (kitchen === undefined) throw new Error('the fixture has no kitchen scene');
  state.documents.set(MEDIA_IDS.kitchen, { ...kitchen, body });
  return state;
}

/** Some action, then a speech of 60 one-row sentences: taller than a page, so it crosses one, then a dual-dialogue pair. */
const LONG_SPEECH = [
  'INT. KITCHEN - DAY',
  '',
  ...Array.from({ length: 10 }, (_, i) => `Filler ${i}.\n`),
  'MARA',
  Array.from({ length: 60 }, () => `${'w'.repeat(34)}.`).join(' '),
  '',
  'MARA',
  'We will talk at dawn.',
  '',
  'ELI ^',
  'Out on the water.',
  '',
  'INT. HARBOUR - NIGHT',
  '',
  'The lamp turns.',
].join('\n');

/** A PNG whose pixels carry an alpha ramp, so the PDF has to write a soft mask for it. */
function alphaPng(): Uint8Array {
  const size = 16;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = y * (size * 4 + 1) + 1 + x * 4;
      raw[at] = 200 - x * 8;
      raw[at + 1] = 60 + y * 8;
      raw[at + 2] = 120;
      raw[at + 3] = Math.round(((x + y) / (2 * size - 2)) * 255);
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Uint8Array(
    Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]),
  );
}

/** A 1 x 1 baseline JPEG. */
const JPEG = Uint8Array.from(
  atob(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  ),
  (c) => c.charCodeAt(0),
);

const JPEG_ASSET = 'a_3JPEG7SHOT';
const PNG_ASSET_FILE = ASSET_FILE;
const JPEG_ASSET_FILE = `${JPEG_ASSET}.jpg`;

/** The default storyboard plus a JPEG shot, with the PNG (with alpha) and the JPEG in the asset store. */
function pictures(): ReturnType<Case['build']> {
  const state = makeMediaProject();
  addShotNode(state, {
    parentId: MEDIA_IDS.shots,
    title: 'Shot three',
    id: 'n_SHOTTHREE1',
    now: OPENED,
    stored: { shotSize: 'CU', action: 'The lamp turns slowly.', durationSec: 3, image: JPEG_ASSET },
  });
  return {
    state,
    assets: new Map([...ASSETS, [JPEG_ASSET, { id: JPEG_ASSET, fileName: JPEG_ASSET_FILE }]]),
    files: { [`assets/${PNG_ASSET_FILE}`]: alphaPng(), [`assets/${JPEG_ASSET_FILE}`]: JPEG },
  };
}

function sheetWith(title: string, action: string): ProjectState {
  const state = makeMediaProject();
  addShotNode(state, { parentId: MEDIA_IDS.shots, title, id: 'n_SHOTWORLD1', now: OPENED, stored: { shotSize: 'LS', action, durationSec: 2 } });
  return state;
}

const CORPUS: readonly Case[] = [
  {
    file: 'screenplay-latin.pdf',
    format: 'pdf',
    build: () => ({ state: makeMediaProject() }),
    pages: [['The Lighthouse Keeper', 'Ada Lovelace'], ['INT. KITCHEN - DAY', 'MARA', 'Where were you?', 'ELI', 'Out on the water.']],
    size: LETTER,
    fonts: [COURIER],
  },
  {
    file: 'screenplay-scene-numbers-continued.pdf',
    format: 'pdf',
    build: () => ({ state: sceneWith(LONG_SPEECH) }),
    options: { titlePage: false, sceneNumbers: 'both' },
    pages: [['INT. KITCHEN - DAY', 'Filler 9.', '(MORE)'], ["MARA (CONT'D)", 'We will talk at dawn.', 'ELI', 'Out on the water.', 'INT. HARBOUR - NIGHT', 'The lamp turns.']],
    size: LETTER,
    fonts: [COURIER],
  },
  {
    file: 'screenplay-cjk.pdf',
    format: 'pdf',
    build: () => ({ state: sceneWith('INT. TEAHOUSE - DAY\n\nMARA\nThe sign says 草堂, ようこそ, 환영합니다.') }),
    options: { titlePage: false },
    pages: [['INT. TEAHOUSE - DAY', 'The sign says', '草堂', 'ようこそ', '환영합니다']],
    size: LETTER,
    fonts: [COURIER, CJK],
  },
  {
    // The regional forms of Han characters: a Japanese and a Traditional Chinese project, cut from the font's `locl` glyphs.
    file: 'screenplay-cjk-ja.pdf',
    format: 'pdf',
    build: () => ({ state: sceneWith('INT. TEAHOUSE - DAY\n\nMARA\n直骨今說次。ようこそ') }),
    options: { titlePage: false },
    language: 'ja',
    pages: [['INT. TEAHOUSE - DAY', '直骨今說次。ようこそ']],
    size: LETTER,
    fonts: [COURIER, CJK],
  },
  {
    file: 'screenplay-cjk-zh-hant.pdf',
    format: 'pdf',
    build: () => ({ state: sceneWith('INT. TEAHOUSE - DAY\n\nMARA\n直骨今說次。草堂') }),
    options: { titlePage: false },
    language: 'zh-Hant',
    pages: [['INT. TEAHOUSE - DAY', '直骨今說次。草堂']],
    size: LETTER,
    fonts: [COURIER, CJK],
  },
  {
    file: 'screenplay-emoji.pdf',
    format: 'pdf',
    build: () => ({ state: sceneWith('INT. STUDIO - DAY\n\nMARA\nAction 🎬 and family 👨‍👩‍👧, flag 🇯🇵, key 1️⃣, thumb 👍🏽.') }),
    options: { titlePage: false },
    pages: [['INT. STUDIO - DAY', 'Action', '🎬', '👨‍👩‍👧', '🇯🇵', '1️⃣', '👍🏽']],
    size: LETTER,
    fonts: [COURIER, EMOJI],
  },
  {
    // Colour emoji (screenplay.md §5.3): the pictures are Type 3 glyphs, each with its whole sequence in ToUnicode.
    file: 'screenplay-colour-emoji.pdf',
    format: 'pdf',
    build: () => ({ state: sceneWith('INT. STUDIO - DAY\n\nMARA\nAction 🎬 and family 👨‍👩‍👧, flag 🇯🇵, pride 🏳️‍🌈, key 1️⃣, thumb 👍🏽.') }),
    options: { titlePage: false, colourEmoji: true },
    pages: [['INT. STUDIO - DAY', 'Action', '🎬', '👨‍👩‍👧', '🇯🇵', '🏳️‍🌈', '1️⃣', '👍🏽']],
    size: LETTER,
    fonts: [COURIER, TYPE3],
  },
  {
    file: 'screenplay-arabic-hebrew.pdf',
    format: 'pdf',
    // Right-to-left words are drawn glyph by glyph in visual order, each glyph with its text in ToUnicode and no /ActualText, so
    // pdf.js and Poppler both put them back in logical order (tools/pdf-validate/check.mjs): the needles are the logical words,
    // each as typed to its last mark. A mark after the last letter is written after its word, in marked content of its own.
    build: () => ({
      state: sceneWith('INT. A - DAY\n\n@سارة\nمرحبا Bob، هل رأيت الفيلم؟ بِسْمِ الله\n\n@سارة\nكَتَبَ الوَلَدُ\n\n@سارة\nمُحَمَّدٌ اللّٰهِ\n\n@דוד\nשלום עולם, מה שלומך? שָׁלוֹם שָׁמָּה'),
    }),
    options: { titlePage: false },
    pages: [
      [
        'INT. A - DAY', 'سارة', 'مرحبا', 'Bob', 'رأيت', 'الفيلم', 'بِسْمِ', 'الله', 'كَتَبَ', 'الوَلَدُ', 'مُحَمَّدٌ', 'اللّٰهِ',
        'דוד', 'שלום', 'עולם', 'שלומך', 'שָׁלוֹם', 'שָׁמָּה',
      ],
    ],
    size: LETTER,
    fonts: [COURIER, ARABIC, HEBREW],
  },
  {
    // Devanagari keeps its /ActualText (it is written left to right, so Poppler's spreading of it over the word reads it in
    // order): this file shows it, in the tools that read it, and in pdf.js, which does not, from the ToUnicode of the clusters.
    file: 'screenplay-devanagari.pdf',
    format: 'pdf',
    build: () => ({ state: sceneWith('INT. A - DAY\n\n@राधा\nनमस्ते दुनिया, क्षमा करें।') }),
    options: { titlePage: false },
    pages: [['INT. A - DAY', 'राधा', 'नमस्ते', 'दुनिया', 'क्षमा', 'करें']],
    size: LETTER,
    fonts: [COURIER, DEVANAGARI],
  },
  {
    // A private-use character no font holds: the writer prints "?" and says so in the log.
    file: 'screenplay-unprintable.pdf',
    format: 'pdf',
    build: () => ({ state: sceneWith('INT. KITCHEN - DAY\n\nMARA\nThe mark is  here.') }),
    options: { titlePage: false },
    pages: [['INT. KITCHEN - DAY', 'The mark is ? here.']],
    size: LETTER,
    fonts: [COURIER],
  },
  {
    file: 'sheet-latin.pdf',
    format: 'contact-sheet-pdf',
    build: () => ({ state: makeMediaProject(), files: {} }),
    pages: [['Mara sets the kettle down.', 'The harbour, empty.']],
    size: A4,
    fonts: [HELVETICA],
  },
  {
    file: 'sheet-cjk-emoji.pdf',
    format: 'contact-sheet-pdf',
    build: () => ({ state: sheetWith('World', '草堂 at dawn, ようこそ 🎬 👨‍👩‍👧'), files: {} }),
    options: { colourEmoji: false },
    pages: [['Mara sets the kettle down.', '草堂 at dawn', 'ようこそ', '🎬', '👨‍👩‍👧']],
    size: A4,
    fonts: [HELVETICA, CJK, EMOJI],
  },
  {
    // The contact sheet's emoji are in colour by default, so the black-and-white case above turns it off, and this one names it.
    file: 'sheet-colour-emoji.pdf',
    format: 'contact-sheet-pdf',
    build: () => ({ state: sheetWith('World', 'Cut 🎬 👨‍👩‍👧 🇯🇵 🏳️‍🌈 👍🏽'), files: {} }),
    options: { colourEmoji: true },
    pages: [['Mara sets the kettle down.', 'Cut', '🎬', '👨‍👩‍👧', '🇯🇵', '🏳️‍🌈', '👍🏽']],
    size: A4,
    fonts: [HELVETICA, TYPE3],
  },
  {
    file: 'sheet-cjk-ko.pdf',
    format: 'contact-sheet-pdf',
    build: () => ({ state: sheetWith('World', '直骨今說次。 한국어'), files: {} }),
    language: 'ko',
    pages: [['Mara sets the kettle down.', '直骨今說次。', '한국어']],
    size: A4,
    fonts: [HELVETICA, CJK],
  },
  {
    // Right-to-left words on the contact sheet: the same drawing as the screenplay's, through the exporter's own embedding.
    file: 'sheet-arabic-hebrew.pdf',
    format: 'contact-sheet-pdf',
    build: () => ({ state: sheetWith('World', 'مرحبا كَتَبَ الوَلَدُ سارة، هل رأيت الفيلم؟ בסדר גמור שָׁלוֹם'), files: {} }),
    pages: [['Mara sets the kettle down.', 'مرحبا', 'سارة', 'رأيت', 'الفيلم', 'كَتَبَ', 'الوَلَدُ', 'בסדר', 'גמור', 'שָׁלוֹם']],
    size: A4,
    fonts: [HELVETICA, ARABIC, HEBREW],
  },
  {
    file: 'sheet-png-alpha-jpeg.pdf',
    format: 'contact-sheet-pdf',
    build: pictures,
    pages: [['Mara sets the kettle down.', 'The harbour, empty.', 'The lamp turns slowly.']],
    size: A4,
    fonts: [HELVETICA],
  },
  {
    file: 'sheet-letter.pdf',
    format: 'contact-sheet-pdf',
    build: pictures,
    options: { pageSize: 'Letter' },
    pages: [['Mara sets the kettle down.', 'The harbour, empty.', 'The lamp turns slowly.']],
    size: LETTER,
    fonts: [HELVETICA],
  },
];

describe.skipIf(OUT === '')('the PDF write corpus', () => {
  const expected: Expected[] = [];

  it.each(CORPUS.map((entry) => [entry.file, entry] as const))('writes %s through the exporter', async (_name, entry) => {
    const { state, assets, files } = entry.build();
    const written = new Map<string, Uint8Array>();
    const exporter = createExporter({
      readState: () => state,
      artifacts: new MemoryArtifactFs(),
      bytes: { writeBytes: async (path, data) => void written.set(path, data), removeBytes: async (path) => void written.delete(path) },
      clock: { now: () => COMPILED_AT },
      metadata: () => ({ author: 'Ada Lovelace', ...(entry.language === undefined ? {} : { language: entry.language }) }),
      assets: () => assets ?? ASSETS,
      readAsset: async (path) => files?.[path] ?? null,
      loadFallbackFont: loadCjkFontInNode,
      loadEmojiFont: loadEmojiFontInNode,
      loadColourEmoji: loadColourEmojiInNode,
      loadArabicFont: loadArabicFontInNode,
      loadHebrewFont: loadHebrewFontInNode,
      loadDevanagariFont: loadDevanagariFontInNode,
    });
    await exporter.ready();
    state.manifest.recipes = [{ name: 'Corpus', includeRootIds: ['manuscript'], format: entry.format, options: entry.options ?? {} }];
    exporter.commandPort().compile(state, { selection: { kind: 'manuscript' }, format: entry.format, recipeName: 'Corpus', at: COMPILED_AT });
    await exporter.idle();
    expect(exporter.failures()).toEqual([]);
    expect(written.size).toBe(1);
    const bytes = [...written.values()][0] ?? new Uint8Array();

    // The description is checked against the file: the validators must not be handed a page count the writer did not write.
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(pdf.getPageCount()).toBe(entry.pages.length);
    const size = pdf.getPage(0).getSize();
    expect(size.width).toBeCloseTo(entry.size[0], 2);
    expect(size.height).toBeCloseTo(entry.size[1], 2);

    mkdirSync(OUT, { recursive: true });
    writeFileSync(resolve(OUT, entry.file), bytes);
    expected.push({
      file: entry.file,
      format: entry.format,
      pages: entry.pages,
      size: entry.size,
      fonts: entry.fonts,
    });
  });

  it('writes expected.json for the files above', () => {
    expect(expected.map((entry) => entry.file)).toEqual(CORPUS.map((entry) => entry.file));
    writeFileSync(resolve(OUT, 'expected.json'), `${JSON.stringify({ files: expected }, null, 2)}\n`);
  });
});
