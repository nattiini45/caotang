/**
 * The one writer of a fallback font in a PDF: a Type 0 font (Identity-H) over a CIDFontType2 descendant, which holds a
 * TrueType subset that fontkit cuts. Both PDFs embed Noto Sans Mono CJK SC and Noto Emoji this way, so a CJK character, an
 * emoji and (when they come) a right-to-left or Indic run are all written by the same code.
 *
 * Every distinct (glyph, text) pair the file prints has a CID of its own, never one per glyph: two characters the font draws
 * with one glyph (‧ U+2027 and ・ U+30FB, 👍 and 👍🏽) keep their own ToUnicode entry and their own width. A CIDToGIDMap sends
 * each CID to its glyph in the subset, so the glyph is stored once however many CIDs name it.
 *
 * The writer knows no PDF library. {@link cidFontObjects} gives a list of dictionaries and streams that refer to each other
 * by their index in the list; the screenplay writer serialises them as text (pdf.ts) and the contact sheet registers them
 * with pdf-lib (the exporter's cid-embedding.ts).
 */

import type { Font } from '@pdf-lib/fontkit';

import { encodeSubset, padGlyphs, subsetTag } from './fontkit.js';

/** One CID of the subset: the glyph it draws in the subset's program, its advance, and the text it copies back as. */
export interface CidEntry {
  readonly gid: number;
  /** The advance the PDF states, in glyph space (1000 to the em of the text size). */
  readonly width: number;
  /**
   * The text a reader gets back when it copies the CID. Empty for a CID that draws part of another's text (the positioned dot of
   * an Arabic letter, the later glyphs of an Indic cluster) or none. What the ToUnicode map says for it depends on its CID:
   * see {@link CidNumbering}.
   */
  readonly text: string;
  /** The CID, when a {@link CidNumbering} chose it; otherwise the entry's place in the list, counting from 1. */
  readonly cid?: number;
}

/** A font subset ready to be written: its program, and one entry for each CID (CID 1 first, unless the entries name theirs). */
export interface CidSubset {
  /** The subset's name: a six-letter tag, a plus, the PostScript name. */
  readonly baseFont: string;
  /** The TrueType font program of the subset. */
  readonly program: Uint8Array;
  readonly entries: readonly CidEntry[];
  readonly bbox: readonly [number, number, number, number];
  readonly ascent: number;
  readonly descent: number;
  readonly capHeight: number;
}

/** What a CID is to draw: a glyph of the source font, the advance to state, and the text it stands for. */
export interface CidUnit {
  readonly glyphId: number;
  readonly width: number;
  readonly text: string;
  /** The CID the host numbered it with ({@link CidNumbering}); otherwise the unit's place in the list, counting from 1. */
  readonly cid?: number;
}

/** A subset of the glyphs the units name, one CID per unit (its own, or its place in the list: CID 1 is the first). */
export async function cutCidSubset(font: Font, units: readonly CidUnit[], postscriptName: string): Promise<CidSubset> {
  const subset = font.createSubset();
  padGlyphs(subset);
  const gids = new Map<number, number>();
  const entries: CidEntry[] = units.map((unit) => {
    let gid = gids.get(unit.glyphId);
    if (gid === undefined) {
      gid = subset.includeGlyph(unit.glyphId as unknown as Parameters<typeof subset.includeGlyph>[0]);
      gids.set(unit.glyphId, gid);
    }
    return { gid, width: unit.width, text: unit.text, ...(unit.cid === undefined ? {} : { cid: unit.cid }) };
  });
  return describeSubset(font, await encodeSubset(subset), entries, postscriptName);
}

/** What {@link describeSubset} reads of a font. */
export interface SubsetSource {
  readonly unitsPerEm: number;
  readonly ascent: number;
  readonly descent: number;
  readonly capHeight: number;
  readonly bbox: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
}

/**
 * The subset's name, box and vertical metrics, taken from the font it was cut from, scaled to 1000 to the em. The name's
 * six-letter tag comes from the glyph list unless the host fixes one.
 */
export function describeSubset(font: SubsetSource, program: Uint8Array, entries: readonly CidEntry[], postscriptName: string, tag?: string): CidSubset {
  const scale = 1000 / font.unitsPerEm;
  const bbox = font.bbox;
  return {
    baseFont: `${tag ?? subsetTag(entries.map((entry) => `${entry.text}:${entry.gid}`).join(' '))}+${postscriptName}`,
    program,
    entries,
    bbox: [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY].map((v) => Math.round(v * scale)) as [number, number, number, number],
    ascent: Math.round(font.ascent * scale),
    descent: Math.round(font.descent * scale),
    capHeight: Math.round((font.capHeight || font.ascent) * scale),
  };
}

/**
 * A PDF value, without a PDF library: numbers, names, text strings, references by index into the object list, arrays and
 * dictionaries. `raw` is PDF syntax written as it stands, for the numbers a Type 3 font states (type3.ts) and the shadings of the
 * colour emoji asset, which are built offline from pinned input (vendor/noto-color-emoji) and hold no string, stream or reference.
 */
export type PdfValue =
  | number
  | { readonly name: string }
  | { readonly string: string }
  | { readonly ref: number }
  | { readonly raw: string }
  | { readonly dict: { readonly [key: string]: PdfValue } }
  | readonly PdfValue[];

/** One indirect object: a dictionary, and a stream when the object has one. A binary stream is for the host to encode; text is written as it is. */
export interface PdfObject {
  readonly dict: { readonly [key: string]: PdfValue };
  readonly stream?: Uint8Array | string;
  /** The whole object as PDF syntax (a shading dictionary of the colour emoji asset), when it is not built from `dict`. */
  readonly raw?: string;
}

const name = (value: string): PdfValue => ({ name: value });
const ref = (index: number): PdfValue => ({ ref: index });

/** A ToUnicode CMap holds at most 100 entries per `beginbfchar` block (PDF 32000-1 §9.10.3, Adobe TN 5411). */
const BFCHAR_BLOCK = 100;

const hex4 = (value: number): string => value.toString(16).toUpperCase().padStart(4, '0');

/**
 * What the ToUnicode map says for a CID with no text of its own that {@link CidNumbering} could not give a code of the kind
 * below: U+200B ZERO WIDTH SPACE, a format character (category Cf) that pdf.js skips. A CID with no entry is not a CID with no
 * text: pdf.js reads the character code as the text (`toUnicode.get(code) || code`), and the codes are the CIDs. The stand-in
 * is no letter of the page, so `tools/pdf-validate` removes it from what a reader gives back, and nothing else.
 */
export const NO_TEXT = '\u200B';

/**
 * The CIDs of a glyph with no text of its own in a right-to-left font: codes that pdf.js reads as format characters (Cf) and
 * skips. The positioned dot of an Arabic letter is a glyph of its own with no text, and pdf.js gives a glyph the ToUnicode map
 * does not name the character whose number is the CID: a control character, and from CID 32 on a space, a letter or a digit,
 * inside the word. Mapping it to U+200B instead puts a character on the page that Poppler places on the dot's own line, which
 * cuts the word into pieces ("رأيت" came out in three, the last on the next line). A CID that is a skipped code and has no
 * ToUnicode entry is neither: Poppler ignores a code that maps to nothing, and pdf.js skips this one.
 */
const TEXTLESS_CIDS: readonly number[] = [
  0x00ad, 0x0600, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, 0x061c, 0x06dd, 0x070f, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, 0xfff9, 0xfffa, 0xfffb,
];
const TEXTLESS = new Set(TEXTLESS_CIDS);

/** Whether a CID is one of the codes {@link CidNumbering} keeps for glyphs with no text. */
export const isTextlessCid = (cid: number): boolean => TEXTLESS.has(cid);

/**
 * Numbers the CIDs of one font as its (glyph, text) pairs come, so the host can write them into content before the font is cut.
 * With `textless` on, a pair with no text takes the next of {@link TEXTLESS_CIDS} (its ToUnicode entry is then left out: see
 * there), and the others count up from 1 without ever taking one of those codes; with it off, or once the codes run out (38
 * distinct glyphs with no text, more than a document of Arabic holds), every pair counts up and the ToUnicode entry of one with
 * no text is {@link NO_TEXT}. A font whose pairs all have text is numbered 1, 2, 3, ... as before.
 */
export class CidNumbering {
  private count = 0;
  private textlessCount = 0;

  constructor(private readonly textless: boolean) {}

  /** The CID of a new pair whose text is `text`. */
  next(text: string): number {
    if (text === '' && this.textless && this.textlessCount < TEXTLESS_CIDS.length) {
      const cid = TEXTLESS_CIDS[this.textlessCount];
      this.textlessCount += 1;
      if (cid !== undefined) return cid;
    }
    do this.count += 1;
    while (TEXTLESS.has(this.count) && this.textless);
    return this.count;
  }
}

/** The CID of an entry: the one it was numbered with, or its place in the list, counting from 1. */
const cidOfEntry = (entry: CidEntry, index: number): number => entry.cid ?? index + 1;

/** UTF-16BE hex of a text, as a ToUnicode destination writes it. */
function utf16Hex(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) out += hex4(text.charCodeAt(i));
  return out;
}

/**
 * The ToUnicode CMap (PDF 1.7 §9.10.3): each CID back to its text, so the text extracts. A Type 3 font has one-byte codes
 * (`codeBytes` 1). A CID with no text of its own that is
 * one of {@link TEXTLESS_CIDS} has no entry (pdf.js skips its code); another maps to {@link NO_TEXT}, never to nothing.
 */
export function toUnicodeCMap(entries: readonly CidEntry[], codeBytes: 1 | 2 = 2): string {
  const code = (cid: number): string => (codeBytes === 1 ? cid.toString(16).toUpperCase().padStart(2, '0') : hex4(cid));
  const mapped = entries.flatMap((entry, index) => {
    const cid = cidOfEntry(entry, index);
    if (entry.text === '') return TEXTLESS.has(cid) ? [] : [`<${code(cid)}> <${utf16Hex(NO_TEXT)}>`];
    return [`<${code(cid)}> <${utf16Hex(entry.text)}>`];
  });
  const blocks: string[] = [];
  for (let i = 0; i < mapped.length; i += BFCHAR_BLOCK) {
    const block = mapped.slice(i, i + BFCHAR_BLOCK);
    blocks.push(`${block.length} beginbfchar\n${block.join('\n')}\nendbfchar`);
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    codeBytes === 1 ? '<00> <FF>' : '<0000> <FFFF>',
    'endcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}

/** The widths of the CIDs as the /W array of a CIDFont writes them: runs of consecutive CIDs, `first [w1 w2 ...]`. */
function widthRuns(entries: readonly CidEntry[]): PdfValue[] {
  const byCid = entries.map((entry, index) => ({ cid: cidOfEntry(entry, index), width: entry.width })).sort((a, b) => a.cid - b.cid);
  const out: PdfValue[] = [];
  let run: number[] = [];
  let first = 0;
  byCid.forEach(({ cid, width }, i) => {
    if (run.length > 0 && cid === first + run.length) run.push(width);
    else {
      if (run.length > 0) out.push(first, run);
      first = cid;
      run = [width];
    }
    if (i === byCid.length - 1) out.push(first, run);
  });
  return out;
}

/**
 * The six objects of a subset, in this order, referring to each other by index: 0 the Type 0 font (what a page's font
 * resource points at), 1 its CIDFontType2 descendant, 2 the descriptor, 3 the TrueType program, 4 the ToUnicode map and
 * 5 the CIDToGIDMap.
 */
export function cidFontObjects(font: CidSubset): readonly PdfObject[] {
  const gidMap = new Uint8Array(2 * (Math.max(0, ...font.entries.map(cidOfEntry)) + 1));
  font.entries.forEach((entry, i) => {
    const cid = cidOfEntry(entry, i);
    gidMap[2 * cid] = entry.gid >> 8;
    gidMap[2 * cid + 1] = entry.gid & 0xff;
  });
  return [
    {
      dict: { Type: name('Font'), Subtype: name('Type0'), BaseFont: name(font.baseFont), Encoding: name('Identity-H'), DescendantFonts: [ref(1)], ToUnicode: ref(4) },
    },
    {
      dict: {
        Type: name('Font'),
        Subtype: name('CIDFontType2'),
        BaseFont: name(font.baseFont),
        CIDSystemInfo: { dict: { Registry: { string: 'Adobe' }, Ordering: { string: 'Identity' }, Supplement: 0 } },
        FontDescriptor: ref(2),
        DW: 1000,
        W: widthRuns(font.entries),
        CIDToGIDMap: ref(5),
      },
    },
    {
      dict: {
        Type: name('FontDescriptor'),
        FontName: name(font.baseFont),
        Flags: 4,
        FontBBox: [...font.bbox],
        ItalicAngle: 0,
        Ascent: font.ascent,
        Descent: font.descent,
        CapHeight: font.capHeight,
        StemV: 80,
        FontFile2: ref(3),
      },
    },
    { dict: { Length1: font.program.length }, stream: font.program },
    { dict: {}, stream: toUnicodeCMap(font.entries) },
    { dict: {}, stream: gidMap },
  ];
}
