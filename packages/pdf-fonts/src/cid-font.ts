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
   * an Arabic letter, the later glyphs of an Indic cluster) or none: the ToUnicode map then holds {@link NO_TEXT} for it.
   */
  readonly text: string;
}

/** A font subset ready to be written: its program, and one entry for each CID, CID 1 first. */
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
}

/** A subset of the glyphs the units name, one CID per unit in order (CID 1 is the first). */
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
    return { gid, width: unit.width, text: unit.text };
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

/** A PDF value, without a PDF library: numbers, names, text strings, references by index into the object list, arrays and dictionaries. */
export type PdfValue =
  | number
  | { readonly name: string }
  | { readonly string: string }
  | { readonly ref: number }
  | { readonly dict: { readonly [key: string]: PdfValue } }
  | readonly PdfValue[];

/** One indirect object: a dictionary, and a stream when the object has one. A binary stream is for the host to encode; text is written as it is. */
export interface PdfObject {
  readonly dict: { readonly [key: string]: PdfValue };
  readonly stream?: Uint8Array | string;
}

const name = (value: string): PdfValue => ({ name: value });
const ref = (index: number): PdfValue => ({ ref: index });

/** A ToUnicode CMap holds at most 100 entries per `beginbfchar` block (PDF 32000-1 §9.10.3, Adobe TN 5411). */
const BFCHAR_BLOCK = 100;

const hex4 = (value: number): string => value.toString(16).toUpperCase().padStart(4, '0');

/**
 * What the ToUnicode map says for a CID with no text of its own: U+200B ZERO WIDTH SPACE. A CID with no entry is not a CID with
 * no text: pdf.js reads the character code as the text (`toUnicode.get(code) || code`), and the codes are the CIDs, so the dot
 * glyph of an Arabic letter came out inside the word as a control character, and as a space, a letter or a digit once the file
 * had more than 31 CIDs. A zero-width space is a format character (category Cf): pdf.js skips it; a viewer that copies it adds
 * an invisible character that is no letter of the word. It stands for the absence of text and is never text, so
 * `tools/pdf-validate` removes it and nothing else.
 */
export const NO_TEXT = '​';

/** UTF-16BE hex of a text, as a ToUnicode destination writes it. */
function utf16Hex(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) out += hex4(text.charCodeAt(i));
  return out;
}

/**
 * The ToUnicode CMap (PDF 1.7 §9.10.3): each CID back to its text, so the text extracts; a CID with no text of its own maps to
 * {@link NO_TEXT}, never to nothing (see there).
 */
export function toUnicodeCMap(entries: readonly CidEntry[]): string {
  const mapped = entries.map((entry, index) => `<${hex4(index + 1)}> <${utf16Hex(entry.text === '' ? NO_TEXT : entry.text)}>`);
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
    '<0000> <FFFF>',
    'endcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
}

/**
 * The six objects of a subset, in this order, referring to each other by index: 0 the Type 0 font (what a page's font
 * resource points at), 1 its CIDFontType2 descendant, 2 the descriptor, 3 the TrueType program, 4 the ToUnicode map and
 * 5 the CIDToGIDMap.
 */
export function cidFontObjects(font: CidSubset): readonly PdfObject[] {
  const gidMap = new Uint8Array(2 * (font.entries.length + 1));
  font.entries.forEach((entry, i) => {
    gidMap[2 * (i + 1)] = entry.gid >> 8;
    gidMap[2 * (i + 1) + 1] = entry.gid & 0xff;
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
        W: [1, font.entries.map((entry) => entry.width)],
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
