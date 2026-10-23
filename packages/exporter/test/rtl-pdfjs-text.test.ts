/**
 * What pdf.js reads back from the Arabic and Hebrew words of both PDFs, raw: no character stripped, none of the control
 * characters of an unmapped glyph tolerated. Noto Sans Arabic draws a dotted letter as a skeleton and a positioned dot, a glyph
 * of its own with no text, and pdf.js reads a glyph the ToUnicode map does not name as the character whose number is the CID
 * (`toUnicode.get(code) || code`). The CIDs are numbered in the order the file first prints each (glyph, text) pair, so a file
 * with a few dozen of them already puts a space, a letter or a digit in the middle of a word. The dot glyphs therefore map to
 * CIDs pdf.js skips as format characters (`CidNumbering`, pdf-fonts cid-font.ts); this runs a file with more than a hundred CIDs ahead of its last dotted letters. (U+200B would not do: Poppler cuts a word at it.)
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadArabicFontInNode, loadHebrewFontInNode } from '@caotang/pdf-fonts/node-loader';
import { MemoryArtifactFs, type ProjectState } from '@caotang/store';
import { addShotNode } from '@caotang/storyboard';
import { createExporter } from '../src/index.js';
import { COMPILED_AT } from './fixture.js';
import { MEDIA_IDS, OPENED, makeMediaProject } from './media-fixture.js';

/** Every letter of the alphabet by itself, then dotted letters in each joining form: more than a hundred distinct glyphs and texts. */
const LETTERS = 'ابتثجحخدذرزسشصضطظعغفقكلمنهوي';
const FILLER = ['بنت ثلث جحخ نيش تقى غبي ظبي شقي فتى', 'ضيف ذنب زيت خبز نبيذ شاي قهوة فنجان عصير', 'ثلج غيم نجم بحر نهر تين تفاح عنب ليمون'];
/** The words that must come back whole, each ending in or holding dotted letters that print after the filler. */
const ARABIC_WORDS = ['الفيلم', 'رأيت', 'بني', 'نبتت', 'التين', 'سارة', 'يتبنى', 'ثقيلة'];
const HEBREW_WORDS = ['שלום', 'עולם', 'שלומך'];
const WORDS = [...ARABIC_WORDS, ...HEBREW_WORDS];

const SCRIPT = ['INT. A - DAY', '', LETTERS, ...FILLER, '', '@سارة', `رأيت الفيلم يا بني ثم نبتت التين يتبنى ثقيلة`, '', '@דוד', 'שלום עולם, מה שלומך?'].join('\n');
/** One shot's action each: a card cuts a long text short, so the filler comes first and the words each have a card to themselves. */
const SHEET_ACTIONS = [`${LETTERS} ${FILLER.join(' ')}`, ...WORDS.map((word, index) => (index < ARABIC_WORDS.length ? `${word} ${HEBREW_WORDS[index % 3]}` : word))];

function rig(state: ProjectState) {
  return createExporter({
    readState: () => state,
    artifacts: new MemoryArtifactFs(),
    clock: { now: () => COMPILED_AT },
    metadata: () => ({ author: 'Ada Lovelace' }),
    assets: () => new Map(),
    readAsset: async () => null,
    loadArabicFont: loadArabicFontInNode,
    loadHebrewFont: loadHebrewFontInNode,
  });
}

async function compile(state: ProjectState, format: 'pdf' | 'contact-sheet-pdf'): Promise<Uint8Array> {
  const result = await rig(state).compile({ includeRootIds: ['manuscript'] }, format);
  const file = result.files[0];
  if (file === undefined || result.files.length !== 1) throw new Error(`expected one file, got ${result.files.length}`);
  return new Uint8Array(await file.blob.arrayBuffer());
}

/**
 * The text of every page as pdf.js gives it (the legacy build, as tools/pdf-validate loads it), items joined by `separator` (a
 * space by default), untouched. Joined by nothing it is the text a search or a selection of the page sees, which does not put a
 * space between the items of one word.
 */
async function pdfjsText(bytes: Uint8Array, separator = ' '): Promise<string> {
  const dir = join(process.cwd(), 'packages', 'exporter', 'node_modules', 'pdfjs-dist');
  const pdfjs = (await import(/* @vite-ignore */ pathToFileURL(join(dir, 'legacy', 'build', 'pdf.mjs')).href)) as {
    getDocument(options: object): { promise: Promise<{ numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: { str?: string }[] }> }> }> };
  };
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, standardFontDataUrl: `${join(dir, 'standard_fonts')}/`, useSystemFonts: false }).promise;
  const pages: string[] = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const content = await (await doc.getPage(number)).getTextContent();
    pages.push(content.items.map((item) => item.str ?? '').join(separator));
  }
  return pages.join('\n');
}

/**
 * Each word is in the text as it was typed: whitespace is not squashed away (a space is what pdf.js wrote for a CID of 0x20),
 * and the text holds no control character (what it wrote for a lower CID).
 */
function expectWhole(text: string): void {
  for (const word of WORDS) expect(text, word).toContain(word);
  const isControl = (code: number): boolean => (code < 0x20 && code !== 10) || (code >= 0x7f && code <= 0x9f);
  const controls = [...text].filter((char) => isControl(char.charCodeAt(0)));
  expect(controls).toEqual([]);
}

/**
 * Words whose last letter carries a mark: the mark is drawn at the left end of the word, first among its glyphs, and pdf.js
 * appends a mark to the text item that is open, so a writer that left it first would have it read into the word drawn before.
 * The final fatha, kasra and damma, the Hebrew points under the last letter, and a word whose last letter has two marks.
 */
const MARKED_WORDS = ['كَتَبَ', 'الوَلَدُ', 'بِسْمِ', 'اللّٰهِ', 'الرَّحْمٰنِ', 'مُحَمَّدٌ', 'שָׁלוֹם', 'עוֹלָם', 'שָׁמָּה'];
const MARKED_SCRIPT = ['INT. A - DAY', '', '@سارة', MARKED_WORDS.slice(0, 5).join(' '), '', '@דוד', MARKED_WORDS.slice(5).join(' ')].join('\n');
const MARKED_ACTIONS = MARKED_WORDS.map((word) => `${word} ${word}`);

/** Each word is whole in the text a search sees, with its final mark after it, and the words before it are not touched. */
function expectMarkedWords(text: string, hasCue = false): void {
  for (const word of MARKED_WORDS) expect(text, word).toContain(word);
  // A cue or an earlier word does not take a mark that belongs to the word after it.
  if (hasCue) {
    expect(text).toContain('سارة');
    expect(text).not.toMatch(/سارة[ً-ٟ]/u);
  }
  expect(text).not.toMatch(/^[ً-ְٟ-ׇ]/mu);
}

describe('the Arabic and Hebrew words of both PDFs, as pdf.js extracts them', () => {
  it('come back whole from the screenplay PDF, with no character of the glyph codes inside them', async () => {
    const state = makeMediaProject();
    const kitchen = state.documents.get(MEDIA_IDS.kitchen);
    if (kitchen === undefined) throw new Error('the fixture has no kitchen scene');
    state.documents.set(MEDIA_IDS.kitchen, { ...kitchen, body: SCRIPT });
    const text = await pdfjsText(await compile(state, 'pdf'));
    expectWhole(text);
  });

  it('come back whole from the contact sheet, with no character of the glyph codes inside them', async () => {
    const state = makeMediaProject();
    SHEET_ACTIONS.forEach((action, index) =>
      addShotNode(state, { parentId: MEDIA_IDS.shots, title: `Shot ${index}`, id: `n_WORLD${String(index).padStart(5, '0')}`, now: OPENED, stored: { action } }),
    );
    const text = await pdfjsText(await compile(state, 'contact-sheet-pdf'));
    expectWhole(text);
  });

  it('keep the mark after the last letter of a word with the word, in the screenplay PDF', async () => {
    const state = makeMediaProject();
    const kitchen = state.documents.get(MEDIA_IDS.kitchen);
    if (kitchen === undefined) throw new Error('the fixture has no kitchen scene');
    state.documents.set(MEDIA_IDS.kitchen, { ...kitchen, body: MARKED_SCRIPT });
    const bytes = await compile(state, 'pdf');
    expectMarkedWords(await pdfjsText(bytes, ''), true);
  });

  it('keep the mark after the last letter of a word with the word, in the contact sheet', async () => {
    const state = makeMediaProject();
    MARKED_ACTIONS.forEach((action, index) =>
      addShotNode(state, { parentId: MEDIA_IDS.shots, title: `Shot ${index}`, id: `n_WORLD${String(index).padStart(5, '0')}`, now: OPENED, stored: { action } }),
    );
    const bytes = await compile(state, 'contact-sheet-pdf');
    expectMarkedWords(await pdfjsText(bytes, ''));
  });
});
