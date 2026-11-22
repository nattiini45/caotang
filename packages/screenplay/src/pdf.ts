/**
 * A minimal PDF writer for the paginated screenplay ([screenplay.md §5.3](../../../docs/architecture/screenplay.md)).
 *
 * One uncompressed content stream per page, one font in WinAnsi encoding, and, for a script with
 * other characters, one fallback font. Caotang owns it for the same reason it owns the EPUB
 * emitter (exporter.md §3a): a dormant dependency costs more than a few hundred lines of
 * frozen-format output. The one library the writer leans on, @pdf-lib/fontkit, cuts the fallback
 * subset, and is loaded only when a script needs it.
 *
 * The font is Courier Prime (A3) or Cousine, embedded whole as a TrueType font program (`FontFile2`),
 * when the caller passes its bytes. The exporter does unless the recipe asks for Courier. Without them the page names the
 * base-14 Courier, which every viewer has; both fonts have Courier's 600-unit advance, so the layout
 * is the same either way. The page is US Letter or A4 (`PdfInfo.pageSize`); the text sits at the same place on both.
 *
 * Characters WinAnsi cannot encode are printed in a second font when the caller passes one: the CJK fallback, a
 * subset of Noto Sans Mono CJK SC cut for the document (cjk-font.ts), embedded as a Type 0 font with a CIDFontType2
 * descendant (`FontFile2`, TrueType outlines), `Identity-H`, a `CIDToGIDMap` and a `ToUnicode` map, so the text can be copied
 * and searched.
 * Each fallback glyph starts at its grid cell and advances the cell's width: two columns for a CJK character
 * (width.ts). The glyph is drawn from the cell's left edge, so the text extracts with no gaps between characters. A line with no such
 * character is written exactly as it was before the fallback existed, and a document with none has no second font.
 *
 * Emoji print in a third font when the caller passes one: a subset of Noto Emoji (emoji-font.ts), embedded the same way
 * (`@caotang/pdf-fonts` writes both). An emoji is one grapheme cluster, however many code points it has (👨‍👩‍👧, 🇩🇪, 1️⃣): one CID, one glyph, two
 * columns, set at 10 points and centred in its cell so it fits the 12-point line. Its ToUnicode entry is the whole
 * cluster, so a reader copies the sequence the writer typed. A line with no emoji is written as it was without this font.
 *
 * With Colour emoji on (the recipe option), an emoji that Noto Color Emoji has prints in colour instead (colour-emoji.ts): a Type 3
 * font whose glyphs are the vector pictures of `@caotang/font-noto-color-emoji`, written by `@caotang/pdf-fonts` (type3.ts). Each
 * emoji is again one code, one cell and one `Tj`, set at the same size and centred in the same two columns, and its ToUnicode entry is
 * the whole cluster. An emoji the colour set lacks prints in the emoji font above, in the same cell. A file without colour emoji
 * is written as it was before they existed.
 *
 * Arabic and Hebrew print in two more fonts when the caller passes them (rtl-font.ts cuts them): subsets of Noto Sans Arabic and
 * Noto Sans Hebrew, written like the others. A line that holds either script, or belongs to a right-to-left paragraph, is not
 * placed by its text but by a plan the caller made for it (`PdfRtlFonts.lines`): the line's runs in the order the algorithm
 * of UAX #9 puts them, each at its column. A word of one of the scripts is a shaped run, set glyph by glyph at the positions the
 * shaper gave, because a text operator would drop the marks' offsets. The glyphs are written left to right in their visual order,
 * with no marked content: each has the letter it draws in its ToUnicode entry (a mark or a joiner that is not drawn is a glyph
 * of its own that draws nothing), and a reader puts the word back in logical order by the bidirectional rules, as it does for the
 * right-to-left text of any producer. `/ActualText` would be reversed again by Poppler, which spreads it over the word from left
 * to right. The one marked content they have is plain `/Span BMC … EMC` (no text) around the marks after a word's last letter: they
 * are drawn first, at the word's left end, but pdf.js appends a mark to the text item that is open, so they are written after the
 * word, and the marked content ends the item the word is in, which leaves the word whole and its marks in an item that follows it. The runs are written in logical order, each at an absolute position. A line without a plan is written as it always was.
 *
 * Devanagari prints in a fourth such font (rtl-font.ts cuts it): a subset of Noto Sans Devanagari, written like the others. A line
 * that holds it is planned the same way (`PdfRtlFonts.lines`): each Devanagari word is a shaped run, set glyph by glyph, because
 * the reordered vowel signs, reph and the stacked marks are placed by offsets a text operator would drop, with the word's typed
 * text as its `/ActualText`.
 *
 * Every byte is ASCII. Strings are escaped on the way in and the font program is written in
 * hexadecimal (`ASCIIHexDecode`), so the object offsets the xref table records are string
 * offsets, and the tests can check them exactly.
 */

import { cidFontObjects, isBidiControl, isEmojiCluster, INDIC_SCRIPT_NAMES, srgbIccProfile, type CidSubset, type IndicScript, type PdfObject, type PdfValue, type ShapedScript, type Type3Fonts } from '@caotang/pdf-fonts';

import { COURIER_PRIME_METRICS } from './fonts/courier-prime-metrics.js';
import { LAYOUT, PAGE_GEOMETRY, type LineTag, type PageSize } from './paginate.js';
import { WIN_ANSI_EXTRA, isPrintable } from './winansi.js';
import { textUnits, unitColumns } from './width.js';

export { isPrintable };

/** How many objects a CID font takes (`cidFontObjects`). */
const CID_FONT_OBJECTS = 6;

/** A standard structure role a tagged line takes (PDF 32000-1 §14.8.4), when the file is marked. */
export type PdfTag = LineTag;

export interface PdfText {
  readonly text: string;
  /** The line belongs to a right-to-left paragraph (paginate.ts `LayoutLine.rtl`); with its text it finds the line's plan. */
  readonly rtl?: true;
  /** The role the line's marked content takes, when `PdfInfo.profile` marks the file. Absent: an artifact, outside the structure. */
  readonly tag?: PdfTag;
  /** Points from the left page edge. */
  readonly x: number;
  /** Baseline in points from the top page edge. */
  readonly y: number;
}

export interface PdfInfo {
  readonly title?: string;
  readonly author?: string;
  readonly producer?: string;
  /** The page's paper (default Letter). It is not in the info dictionary: it sets each page's `MediaBox` and the flip of the y axis. */
  readonly pageSize?: PageSize;
  /**
   * `pdfa-2u` writes the file as PDF/A-2u (screenplay.md §5.3): PDF 1.7, an XMP packet declaring the conformance, an sRGB
   * output intent, a ToUnicode map on the WinAnsi font, a structure tree over the tagged lines, and a trailer ID.
   */
  readonly profile?: 'pdfa-2u';
  /** The document language as a BCP 47 tag, for `/Lang` when `profile` marks the file. */
  readonly lang?: string;
}

/** What a font descriptor states (PDF 1.7 §9.8), in glyph space of 1000 units to the em. `COURIER_PRIME_METRICS` is one. */
export interface PdfFontMetrics {
  readonly postScriptName: string;
  /** The advance of every glyph, which the font program has and the PDF states. */
  readonly width: number;
  readonly bbox: readonly number[];
  readonly ascent: number;
  readonly descent: number;
  readonly capHeight: number;
  readonly xHeight: number;
  readonly italicAngle: number;
  readonly stemV: number;
  readonly flags: number;
}

/** A TrueType font program to embed: Courier Prime (A3) unless `metrics` says it is another monospaced font. */
export interface PdfFont {
  readonly bytes: Uint8Array;
  /** The figures of the font's descriptor. Absent: `COURIER_PRIME_METRICS`. */
  readonly metrics?: PdfFontMetrics;
}

/** One glyph of the fallback subset. */
export interface PdfCidGlyph {
  /** The glyph's CID in the subset, which is also its code in the content stream (Identity-H). */
  readonly cid: number;
  /** The advance the PDF states, in glyph space: the character's grid cell, 600 a column. */
  readonly width: number;
}

/** A TrueType subset to print the characters WinAnsi cannot encode (cjk-font.ts cuts it), written as `@caotang/pdf-fonts` writes any CID font. */
export interface PdfCidFont extends CidSubset {
  /** The glyph each character the subset prints is drawn with. */
  readonly glyphs: ReadonlyMap<string, PdfCidGlyph>;
}

/** One glyph of the emoji subset. */
export interface PdfEmojiGlyph {
  /** The unit's CID in the subset, which is also its code in the content stream (Identity-H). */
  readonly cid: number;
  /** The advance the PDF states, in glyph space at the emoji size: the unit's grid cell. */
  readonly width: number;
  /** Points from the cell's left edge to the glyph's, which centres the glyph in its cell. */
  readonly dx: number;
}

/**
 * A TrueType subset to print emoji (emoji-font.ts cuts it). Each unit it prints (an emoji cluster, or a character only it
 * has) has its own CID; several CIDs can share one glyph.
 */
export interface PdfEmojiFont extends CidSubset {
  /** The size it is set in, in points. */
  readonly size: number;
  /** The glyph each unit prints with, by the unit's text. */
  readonly glyphs: ReadonlyMap<string, PdfEmojiGlyph>;
}

/** One colour emoji: its code in one of the Type 3 fonts, and its cell like {@link PdfEmojiGlyph}'s. */
export interface PdfColourGlyph {
  /** The font in {@link PdfColourEmojiFont.fonts}, counting from 0 (resource `CE1`, `CE2`, …). */
  readonly font: number;
  /** The one-byte code in that font (1 to 255), which is what the content stream shows. */
  readonly code: number;
  readonly width: number;
  readonly dx: number;
}

/** The colour emoji a file prints: Type 3 fonts (`@caotang/pdf-fonts` writes them), and the font and code of each emoji. */
export interface PdfColourEmojiFont {
  /** The size it is set in, in points. */
  readonly size: number;
  readonly fonts: Type3Fonts;
  readonly glyphs: ReadonlyMap<string, PdfColourGlyph>;
  /** Compresses a stream (zlib), when the host can: the glyph procedures are text and shrink to a fifth. */
  readonly deflate?: (data: Uint8Array) => Uint8Array;
}

/** One glyph of a shaped Arabic or Hebrew run: its CID in the font's subset, and its place in points from the run's left edge, right and up. */
export interface PdfShapedGlyph {
  readonly cid: number;
  readonly x: number;
  readonly y: number;
  /**
   * A mark or joiner after the last letter of a right-to-left word: drawn at the word's left end, so first among its glyphs, and
   * written after the others in marked content of its own (see the header).
   */
  readonly final?: true;
}

/** A word of a shaped script, set in the font of its script glyph by glyph (see the header). */
export interface PdfShapedRun {
  readonly kind: 'shaped';
  readonly font: ShapedScript;
  /** The column of the run's left edge, from the line's start. */
  readonly column: number;
  /** The glyphs left to right as drawn, each at its own position, the order the shaper gives them. */
  readonly glyphs: readonly PdfShapedGlyph[];
  /** The run's text in logical order: its `/ActualText` for Devanagari; Arabic and Hebrew carry none (see the header). */
  readonly source: string;
  /** The run's place among the line's runs in logical order. */
  readonly order: number;
}

/** Text of the other fonts, in the order it is drawn, left to right, from a column. */
export interface PdfPlainRun {
  readonly kind: 'plain';
  readonly column: number;
  readonly text: string;
  /** The text in logical order. When it differs from `text` the run gets an `/ActualText` of it. */
  readonly source: string;
  readonly order: number;
}

export type PdfRtlItem = PdfShapedRun | PdfPlainRun;

/** The shaped-script subsets, by script, and the plan of each line that holds one of the scripts or belongs to a right-to-left paragraph. */
export interface PdfRtlFonts {
  readonly arabic?: CidSubset;
  readonly hebrew?: CidSubset;
  /** The Indic fonts' subsets, by script. */
  readonly indic?: Partial<Record<IndicScript, CidSubset>>;
  /** A line's plan, by {@link rtlLineKey}. */
  readonly lines: ReadonlyMap<string, readonly PdfRtlItem[]>;
}

/** What finds a line's plan: its text, and whether its paragraph is right to left. */
export function rtlLineKey(text: string, rtl: boolean): string {
  return `${rtl ? 'r' : 'l'}${text}`;
}

/** The WinAnsi byte for a character. Anything it cannot encode becomes a question mark. */
function winAnsiCode(ch: string): number {
  const code = ch.codePointAt(0) ?? 0x3f;
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code;
  return WIN_ANSI_EXTRA[ch] ?? 0x3f;
}

/** A PDF literal string body: escapes parentheses and backslashes, writes other non-ASCII as octal. */
export function pdfString(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = winAnsiCode(ch);
    if (code === 0x28 || code === 0x29 || code === 0x5c) out += `\\${String.fromCharCode(code)}`;
    else if (code >= 0x20 && code <= 0x7e) out += String.fromCharCode(code);
    else out += `\\${code.toString(8).padStart(3, '0')}`;
  }
  return out;
}

function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Text that is all WinAnsi in the Latin-1 range: one unit a character, each one column in Courier Prime. */
const LATIN = /^[\x20-\x7e\xa0-\xff]*$/;

/** The marked lines of a page, in draw order: each one's structure role, at the index that is its MCID. */
export interface PageMarks {
  readonly roles: PdfTag[];
}

function contentStream(lines: readonly PdfText[], pageHeight: number, fallback?: PdfCidFont, emoji?: PdfEmojiFont, rtl?: PdfRtlFonts, colour?: PdfColourEmojiFont, marks?: PageMarks): string {
  const parts = ['BT', '/F1 12 Tf'];
  let current = 'F1';
  const setFont = (name: string, size = 12): void => {
    if (current !== name) parts.push(`/${name} ${size} Tf`);
    current = name;
  };
  /** The units of a stretch of a line, each run placed at its column from `x`. */
  const writeUnits = (units: readonly string[], x: number, y: string): void => {
    for (const run of runsOf(units, fallback, emoji, colour)) {
      if (run.font === 'C' && colour !== undefined) {
        // Each colour emoji is placed on its own, centred in its two-column cell, by the one byte of its code.
        (run.glyphs as PdfColourGlyph[]).forEach((glyph, i) => {
          setFont(`CE${glyph.font + 1}`, colour.size);
          parts.push(`1 0 0 1 ${num(x + (run.column + 2 * i) * LAYOUT.charWidth + glyph.dx)} ${y} Tm`, `<${glyph.code.toString(16).toUpperCase().padStart(2, '0')}> Tj`);
        });
        continue;
      }
      if (run.font === 'F3' && emoji !== undefined) {
        // Each emoji is placed on its own, centred in its two-column cell.
        setFont('F3', emoji.size);
        (run.glyphs as PdfEmojiGlyph[]).forEach((glyph, i) => {
          parts.push(`1 0 0 1 ${num(x + (run.column + 2 * i) * LAYOUT.charWidth + glyph.dx)} ${y} Tm`, `${cidString([glyph])} Tj`);
        });
        continue;
      }
      parts.push(`1 0 0 1 ${num(x + run.column * LAYOUT.charWidth)} ${y} Tm`);
      if (run.font === 'F1') {
        setFont('F1');
        parts.push(`(${pdfString(run.text)}) Tj`);
      } else {
        setFont('F2');
        parts.push(`${cidString(run.glyphs as PdfCidGlyph[])} Tj`);
      }
    }
  };
  for (const line of lines) {
    const y = num(pageHeight - line.y);
    // A marked file wraps each line: its role's BDC with the next MCID, or /Artifact for the lines the structure skips.
    const wrap = marks === undefined ? undefined : line.tag === undefined ? ('/Artifact BMC' as const) : (`/${line.tag} << /MCID ${marks.roles.length} >> BDC` as const);
    if (line.tag !== undefined) marks?.roles.push(line.tag);
    if (wrap !== undefined) parts.push(wrap);
    const plan = rtl?.lines.get(rtlLineKey(line.text, line.rtl === true));
    if (plan !== undefined) {
      writePlan(plan, line, y, pageHeight, setFont, writeUnits, parts);
      if (wrap !== undefined) parts.push('EMC');
      continue;
    }
    // A line whose every unit is one Courier Prime column is one string, as the writer always wrote it.
    const units = LATIN.test(line.text) ? null : textUnits(line.text);
    if (units === null || units.every((unit) => unit.length === 1 && unitColumns(unit) === 1 && fontOf(unit, fallback, emoji, colour) === 'F1')) {
      setFont('F1');
      parts.push(`1 0 0 1 ${num(line.x)} ${y} Tm`, `(${pdfString(line.text)}) Tj`);
      if (wrap !== undefined) parts.push('EMC');
      continue;
    }
    // A line with fallback glyphs or emoji is written as runs, each placed at its first unit's column.
    writeUnits(units, line.x, y);
    if (wrap !== undefined) parts.push('EMC');
  }
  parts.push('ET');
  return parts.join('\n');
}

/** The font resource of each script's subset: Arabic, Hebrew, then the Indic scripts in {@link INDIC_SCRIPT_NAMES} order. */
const SHAPED_FONT: Readonly<Record<ShapedScript, string>> = {
  arabic: 'F4',
  hebrew: 'F5',
  ...Object.fromEntries(INDIC_SCRIPT_NAMES.map((script, i) => [script, `F${6 + i}`])),
} as Record<ShapedScript, string>;

/** The marked content that gives a reader the text a stretch of the page stands for (PDF 32000-1 §14.9.4). */
/** Marked content with no properties: it ends a text item in pdf.js and carries no text. */
const PLAIN_SPAN = '/Span BMC';
const actualText = (text: string): string => `/Span << /ActualText <FEFF${utf16Hex(text)}> >> BDC`;

/**
 * A planned line: its runs in logical order, each at its column. A shaped run is set glyph by glyph; a run of the other fonts
 * is written as any line's units are. A run whose drawn text differs from its logical text, and every shaped run, carries
 * its logical text for copying.
 */
function writePlan(
  plan: readonly PdfRtlItem[],
  line: PdfText,
  y: string,
  pageHeight: number,
  setFont: (name: string, size?: number) => void,
  writeUnits: (units: readonly string[], x: number, y: string) => void,
  parts: string[],
): void {
  for (const item of [...plan].sort((a, b) => a.order - b.order)) {
    const x = line.x + item.column * LAYOUT.charWidth;
    if (item.kind === 'shaped') {
      // Only the Indic scripts carry their typed text as marked content. Arabic and Hebrew glyphs are drawn in visual order
      // with the text of each in ToUnicode, so a reader puts the words back in logical order by the bidirectional algorithm,
      // as it does for any right-to-left text (see the header).
      const marked = item.font !== 'arabic' && item.font !== 'hebrew';
      if (marked) parts.push(actualText(item.source));
      setFont(SHAPED_FONT[item.font]);
      const show = (glyph: PdfShapedGlyph): void => {
        parts.push(`1 0 0 1 ${num(x + glyph.x)} ${num(pageHeight - line.y + glyph.y)} Tm`, `${cidString([glyph])} Tj`);
      };
      item.glyphs.filter((glyph) => glyph.final !== true).forEach(show);
      if (marked) parts.push('EMC');
      // The marks after a right-to-left word's last letter are drawn first, at its left end, but pdf.js appends a mark to the text
      // item that is open, which is the word before. They are written after their word, each run in an item of its own that
      // marked content ends, so a reader finds the word's item and then its marks, in logical order.
      const finals = item.glyphs.filter((glyph) => glyph.final === true);
      if (finals.length > 0) {
        parts.push(PLAIN_SPAN);
        finals.forEach(show);
        parts.push('EMC');
      }
      continue;
    }
    const copied = item.text !== item.source;
    if (copied) parts.push(actualText(item.source));
    writeUnits(textUnits(item.text), x, y);
    if (copied) parts.push('EMC');
  }
}

/** The font a unit prints in: F1 Courier Prime, F2 the CJK fallback, F3 the emoji fallback, C the colour emoji. A unit no font has is F1, as "?". */
function fontOf(unit: string, fallback?: PdfCidFont, emoji?: PdfEmojiFont, colour?: PdfColourEmojiFont): 'F1' | 'F2' | 'F3' | 'C' {
  if (unit.length > 1 || unit.charCodeAt(0) >= 0x231a) {
    if (isEmojiCluster(unit)) {
      if (colour?.glyphs.has(unit) === true) return 'C';
      return emoji?.glyphs.has(unit) === true ? 'F3' : 'F1';
    }
  }
  const base = String.fromCodePoint(unit.codePointAt(0) ?? 0x3f);
  if (isPrintable(base)) return 'F1';
  if (fallback?.glyphs.has(base) === true) return 'F2';
  if (emoji?.glyphs.has(unit) === true) return 'F3';
  return 'F1';
}

interface Run {
  readonly column: number;
  readonly font: 'F1' | 'F2' | 'F3' | 'C';
  /** The text a Courier Prime run prints: each unit's character, or "?" for a unit no font has. */
  text: string;
  /** The fallback glyphs of an F2, F3 or colour run. */
  readonly glyphs: (PdfCidGlyph | PdfEmojiGlyph | PdfColourGlyph)[];
  /** Set when the run's last unit is wider than what it prints ("?" for an emoji), so the next unit starts a new run. */
  closed: boolean;
}

/** A line's units cut into runs of one font each, with the grid column each run starts at. */
function runsOf(units: readonly string[], fallback?: PdfCidFont, emoji?: PdfEmojiFont, colour?: PdfColourEmojiFont): Run[] {
  const runs: Run[] = [];
  let column = 0;
  for (const unit of units) {
    // A bidirectional control character prints nothing and takes no column, planned line or not.
    if (isBidiControl(unit)) continue;
    const font = fontOf(unit, fallback, emoji, colour);
    const cols = unitColumns(unit);
    const base = String.fromCodePoint(unit.codePointAt(0) ?? 0x3f);
    let last = runs[runs.length - 1];
    if (last === undefined || last.font !== font || last.closed) {
      last = { column, font, text: '', glyphs: [], closed: false };
      runs.push(last);
    }
    if (font === 'F1') {
      // A selector after a character prints nothing; a unit of several code points no font has is one "?".
      const printed = isPrintable(base) ? base : '?';
      last.text += printed;
      if (cols !== 1) last.closed = true;
    } else if (font === 'F2') {
      last.glyphs.push(fallback?.glyphs.get(base) as PdfCidGlyph);
    } else if (font === 'C') {
      last.glyphs.push(colour?.glyphs.get(unit) as PdfColourGlyph);
    } else {
      last.glyphs.push(emoji?.glyphs.get(unit) as PdfEmojiGlyph);
    }
    column += cols;
  }
  return runs;
}

/** A hexadecimal string of fallback glyph codes, two bytes each (Identity-H). */
function cidString(glyphs: readonly { readonly cid: number }[]): string {
  return `<${glyphs.map((glyph) => glyph.cid.toString(16).toUpperCase().padStart(4, '0')).join('')}>`;
}

function hex(bytes: Uint8Array): string {
  const digits = '0123456789ABCDEF';
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    out += digits.charAt(byte >> 4) + digits.charAt(byte & 15);
    // A line break every 64 bytes keeps the file readable in a text editor. ASCIIHexDecode ignores white space.
    if (i % 64 === 63) out += '\n';
  }
  return `${out}>`;
}

/** The font dictionary for an embedded TrueType font, Courier Prime unless the font brings its own metrics, with WinAnsi codes 32 to 255. */
function embeddedFontObjects(font: PdfFont, descriptorId: number, fileId: number): { font: string; descriptor: string; file: string } {
  const m = font.metrics ?? COURIER_PRIME_METRICS;
  const widths = Array.from({ length: 224 }, () => String(m.width)).join(' ');
  const program = hex(font.bytes);
  return {
    font:
      `<< /Type /Font /Subtype /TrueType /BaseFont /${m.postScriptName} /FirstChar 32 /LastChar 255 ` +
      `/Widths [${widths}] /Encoding /WinAnsiEncoding /FontDescriptor ${descriptorId} 0 R >>`,
    descriptor:
      `<< /Type /FontDescriptor /FontName /${m.postScriptName} /Flags ${m.flags} /FontBBox [${m.bbox.join(' ')}] ` +
      `/ItalicAngle ${m.italicAngle} /Ascent ${m.ascent} /Descent ${m.descent} /CapHeight ${m.capHeight} ` +
      `/XHeight ${m.xHeight} /StemV ${m.stemV} /MissingWidth ${m.width} /FontFile2 ${fileId} 0 R >>`,
    file: `<< /Length ${program.length} /Length1 ${font.bytes.length} /Filter /ASCIIHexDecode >>\nstream\n${program}\nendstream`,
  };
}

/** UTF-16BE hex of one character, as a ToUnicode map and a text string write it. */
function utf16Hex(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) out += text.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  return out;
}

/** A PDF value as the file writes it. */
function valueText(value: PdfValue, first: number): string {
  if (typeof value === 'number') return num(value);
  if (Array.isArray(value)) return `[${(value as readonly PdfValue[]).map((item) => valueText(item, first)).join(' ')}]`;
  const object = value as Exclude<PdfValue, number | readonly PdfValue[]>;
  if ('name' in object) return `/${object.name}`;
  if ('string' in object) return `(${pdfString(object.string)})`;
  if ('ref' in object) return `${first + object.ref} 0 R`;
  if ('raw' in object) return object.raw;
  return `<< ${Object.entries(object.dict).map(([key, item]) => `/${key} ${valueText(item, first)}`).join(' ')} >>`;
}

/**
 * Objects of `@caotang/pdf-fonts` as file text, the first one numbered `first`. A binary stream is written in hexadecimal; with
 * `deflate`, a text stream is compressed first and written in hexadecimal too.
 */
function objectsText(objects: readonly PdfObject[], first: number, deflate?: (data: Uint8Array) => Uint8Array): string[] {
  return objects.map((object) => {
    if (object.raw !== undefined) return object.raw;
    const dict = Object.entries(object.dict).map(([key, item]) => `/${key} ${valueText(item, first)}`);
    const { stream } = object;
    if (stream === undefined) return `<< ${dict.join(' ')} >>`;
    const packed = typeof stream === 'string' && deflate !== undefined ? deflate(new TextEncoder().encode(stream)) : undefined;
    const body = packed !== undefined ? hex(packed) : typeof stream === 'string' ? stream : hex(stream);
    const filter = packed !== undefined ? ['/Filter [/ASCIIHexDecode /FlateDecode]'] : typeof stream === 'string' ? [] : ['/Filter /ASCIIHexDecode'];
    return `<< /Length ${body.length} ${[...dict, ...filter].join(' ')} >>
stream
${body}
endstream`;
  });
}

/** The objects of a CID font (`@caotang/pdf-fonts`, cid-font.ts) as file text, the first one numbered `first`. */
function cidFontText(font: CidSubset, first: number): string[] {
  return objectsText(cidFontObjects(font), first);
}

/** An info-dictionary string: a literal in WinAnsi when every character is printable, UTF-16BE with a byte order mark otherwise. */
function infoString(text: string): string {
  if ([...text].every(isPrintable)) return `(${pdfString(text)})`;
  return `<FEFF${utf16Hex(text)}>`;
}

/**
 * One XML character escaped for a text node or attribute, and every non-ASCII code point a numeric
 * character reference: the writer's offsets are character counts, so the packet stays ASCII byte for byte.
 */
function xmlText(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch.codePointAt(0)! > 0x7f) out += `&#x${ch.codePointAt(0)!.toString(16).toUpperCase()};`;
    else out += ch;
  }
  return out;
}

/**
 * The XMP packet PDF/A carries on the catalogue (ISO 16684): the conformance claim in `pdfaid`, and the document's
 * title, creator and tool in the fields the info dictionary mirrors (PDF/A-2 6.6.2.3 asks them to agree).
 */
function xmpPacket(title: string, author: string | undefined, producer: string): string {
  // No BOM: the writer keeps every byte ASCII, so the packet starts at the PI.
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">\n` +
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n` +
    `<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">\n` +
    `<pdf:Producer>${xmlText(producer)}</pdf:Producer>\n` +
    `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlText(title)}</rdf:li></rdf:Alt></dc:title>\n` +
    (author === undefined ? '' : `<dc:creator><rdf:Seq><rdf:li>${xmlText(author)}</rdf:li></rdf:Seq></dc:creator>\n`) +
    `<pdfaid:part>2</pdfaid:part>\n` +
    `<pdfaid:conformance>U</pdfaid:conformance>\n` +
    `</rdf:Description>\n` +
    `</rdf:RDF>\n` +
    `</x:xmpmeta>\n` +
    `<?xpacket end="w"?>`;
}

/**
 * The ToUnicode CMap on the WinAnsi font (PDF/A-2u asks every character to map to Unicode): codes 32–255 to their
 * character, the Windows-1252 range through `WIN_ANSI_EXTRA`, its five undefined codes left out.
 */
function winAnsiToUnicode(): string {
  const extra = new Map<number, number>();
  for (const [ch, code] of Object.entries(WIN_ANSI_EXTRA)) extra.set(code, ch.codePointAt(0) ?? 0);
  const pairs: string[] = [];
  for (let code = 0x20; code <= 0xff; code += 1) {
    const uni = code <= 0x7e || code >= 0xa0 ? code : extra.get(code);
    if (uni !== undefined) pairs.push(`<${code.toString(16).toUpperCase().padStart(2, '0')}> <${uni.toString(16).toUpperCase().padStart(4, '0')}>`);
  }
  const chunks: string[] = [];
  for (let i = 0; i < pairs.length; i += 100) {
    chunks.push(`${Math.min(100, pairs.length - i)} beginbfchar\n${pairs.slice(i, i + 100).join('\n')}\nendbfchar`);
  }
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n` +
    `/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n` +
    `1 begincodespacerange\n<00> <FF>\nendcodespacerange\n${chunks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
}

/** A 16-byte file ID: two passes of FNV-1a over the bytes so far, eight different seeds. */
function fileId(text: string): string {
  const digest = (seed: number): string => {
    let h = seed;
    for (let i = 0; i < text.length; i += 1) h = (Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0);
    return h.toString(16).toUpperCase().padStart(8, '0');
  };
  return digest(0x811c9dc5) + digest(0x01234567) + digest(0x89abcdef) + digest(0xdeadbeef);
}

/**
 * Writes one PDF from pages of positioned text. Object 1 is the catalogue, 2 the page tree,
 * 3 the font, 4 the info dictionary. Each page then takes two objects: the page, and its
 * content stream. An embedded font adds its descriptor and its program after the pages, a CJK fallback that prints at
 * least one character adds its six objects after those, and an emoji font that prints at least one unit its six after
 * those, and an Arabic, a Hebrew and a Devanagari font that print at least one glyph their six each after those, and the objects of
 * the colour emoji fonts (type3.ts) last. Every page names each font the file has.
 *
 * A document with nothing to print writes one blank page: PDF 1.7 §7.7.3.2 asks the page tree to hold at least one
 * page, and a reader refuses a file whose page tree is empty.
 */
export function writePdf(
  pages: readonly (readonly PdfText[])[],
  info: PdfInfo = {},
  font?: PdfFont,
  cjk?: PdfCidFont,
  emojiFont?: PdfEmojiFont,
  rtlFonts?: PdfRtlFonts,
  colourFont?: PdfColourEmojiFont,
): Uint8Array<ArrayBuffer> {
  const fallback = cjk === undefined || cjk.glyphs.size === 0 ? undefined : cjk;
  const colour = colourFont === undefined || colourFont.glyphs.size === 0 ? undefined : colourFont;
  const emoji = emojiFont === undefined || emojiFont.glyphs.size === 0 ? undefined : emojiFont;
  const profile = info.profile === 'pdfa-2u';
  // A page tree with no page in it is a file a reader refuses, so a script that prints nothing still writes one page.
  const written: readonly (readonly PdfText[])[] = pages.length === 0 ? [[]] : pages;
  const pageId = (i: number): number => 5 + 2 * i;
  const geometry = PAGE_GEOMETRY[info.pageSize ?? 'Letter'];
  const bodies: string[] = [];
  bodies[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  bodies[1] = `<< /Type /Pages /Kids [${written.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${written.length} >>`;
  const arabic = rtlFonts?.arabic === undefined || rtlFonts.arabic.entries.length === 0 ? undefined : rtlFonts.arabic;
  const hebrew = rtlFonts?.hebrew === undefined || rtlFonts.hebrew.entries.length === 0 ? undefined : rtlFonts.hebrew;
  const indicSubsets = new Map<IndicScript, CidSubset>();
  INDIC_SCRIPT_NAMES.forEach((script) => {
    const subset = rtlFonts?.indic?.[script];
    if (subset !== undefined && subset.entries.length > 0) indicSubsets.set(script, subset);
  });
  const fallbackId = pageId(written.length) + (font === undefined ? 0 : 2);
  const emojiId = fallbackId + (fallback === undefined ? 0 : CID_FONT_OBJECTS);
  const arabicId = emojiId + (emoji === undefined ? 0 : CID_FONT_OBJECTS);
  const hebrewId = arabicId + (arabic === undefined ? 0 : CID_FONT_OBJECTS);
  const indicIdBase = hebrewId + (hebrew === undefined ? 0 : CID_FONT_OBJECTS);
  const colourId = indicIdBase + indicSubsets.size * CID_FONT_OBJECTS;
  // PDF/A-2u objects, numbered after the colour fonts: a ToUnicode on the WinAnsi font, the XMP packet, the sRGB
  // output intent, then the structure tree — the document element, one element per marked line, the tree's root and
  // the parent tree last (their ids are set once the marks are counted).
  const pdfaId = colourId + (colour === undefined ? 0 : colour.fonts.objects.length);
  const toUniId = pdfaId;
  const metaId = pdfaId + 1;
  const iccId = pdfaId + 2;
  const intentId = pdfaId + 3;
  const docElemId = pdfaId + 4;
  const firstElemId = pdfaId + 5;
  const toUniRef = (id: number): string => (profile ? ` /ToUnicode ${id} 0 R` : '');
  if (font === undefined) {
    bodies[2] = `<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding${toUniRef(toUniId)} >>`;
  } else {
    const descriptorId = pageId(written.length);
    const objects = embeddedFontObjects(font, descriptorId, descriptorId + 1);
    bodies[2] = `${objects.font.slice(0, -3)}${toUniRef(toUniId)} >>`;
    bodies[descriptorId - 1] = objects.descriptor;
    bodies[descriptorId] = objects.file;
  }
  if (fallback !== undefined) {
    cidFontText(fallback, fallbackId).forEach((body, i) => {
      bodies[fallbackId - 1 + i] = body;
    });
  }
  if (emoji !== undefined) {
    cidFontText(emoji, emojiId).forEach((body, i) => {
      bodies[emojiId - 1 + i] = body;
    });
  }
  if (arabic !== undefined) {
    cidFontText(arabic, arabicId).forEach((body, i) => {
      bodies[arabicId - 1 + i] = body;
    });
  }
  if (hebrew !== undefined) {
    cidFontText(hebrew, hebrewId).forEach((body, i) => {
      bodies[hebrewId - 1 + i] = body;
    });
  }
  const indicIds = new Map<IndicScript, number>();
  let nextIndicId = indicIdBase;
  for (const [script, subset] of indicSubsets) {
    const id = nextIndicId;
    indicIds.set(script, id);
    cidFontText(subset, id).forEach((body, i) => {
      bodies[id - 1 + i] = body;
    });
    nextIndicId += CID_FONT_OBJECTS;
  }
  if (colour !== undefined) {
    objectsText(colour.fonts.objects, colourId, colour.deflate).forEach((body, i) => {
      bodies[colourId - 1 + i] = body;
    });
  }
  const allMarks: PageMarks[] = [];
  if (profile) {
    bodies[toUniId - 1] = `<< /Length ${winAnsiToUnicode().length} >>\nstream\n${winAnsiToUnicode()}\nendstream`;
    bodies[metaId - 1] = `<< /Type /Metadata /Subtype /XML /Length ${xmpPacket(info.title ?? 'Screenplay', info.author, info.producer ?? 'Caotang').length} >>\nstream\n${xmpPacket(info.title ?? 'Screenplay', info.author, info.producer ?? 'Caotang')}\nendstream`;
    bodies[iccId - 1] = `<< /N 3 /Length ${hex(srgbIccProfile()).length} /Filter /ASCIIHexDecode >>\nstream\n${hex(srgbIccProfile())}\nendstream`;
    bodies[intentId - 1] = `<< /Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier (sRGB IEC61966-2.1) /Info (sRGB IEC61966-2.1) /DestOutputProfile ${iccId} 0 R >>`;
    written.forEach(() => allMarks.push({ roles: [] }));
  }
  const fonts =
    '/F1 3 0 R' +
    (fallback === undefined ? '' : ` /F2 ${fallbackId} 0 R`) +
    (emoji === undefined ? '' : ` /F3 ${emojiId} 0 R`) +
    (arabic === undefined ? '' : ` /F4 ${arabicId} 0 R`) +
    (hebrew === undefined ? '' : ` /F5 ${hebrewId} 0 R`) +
    [...indicIds.entries()].map(([script, id]) => ` /${SHAPED_FONT[script]} ${id} 0 R`).join('') +
    (colour === undefined ? '' : colour.fonts.fonts.map((font, i) => ` /CE${i + 1} ${colourId + font.object} 0 R`).join(''));
  const planned = arabic === undefined && hebrew === undefined && indicSubsets.size === 0 ? undefined : rtlFonts;
  const author = info.author === undefined || info.author.trim() === '' ? '' : ` /Author ${infoString(info.author)}`;
  bodies[3] = `<< /Title ${infoString(info.title ?? 'Screenplay')}${author} /Producer ${infoString(info.producer ?? 'Caotang')} >>`;
  written.forEach((lines, i) => {
    const stream = contentStream(lines, geometry.pageHeight, fallback, emoji, planned, colour, profile ? allMarks[i] : undefined);
    bodies[pageId(i) - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${geometry.pageWidth} ${geometry.pageHeight}] ` +
      `/Resources << /Font << ${fonts} >> >>${profile ? ` /StructParents ${i}` : ''} /Contents ${pageId(i) + 1} 0 R >>`;
    bodies[pageId(i)] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  if (profile) {
    // One structure element per marked line, all children of the document element in reading order (page, then MCID).
    const markRefs: number[] = [];
    const nums: string[] = [];
    let elem = firstElemId;
    allMarks.forEach((marks, i) => {
      const pageElems: number[] = [];
      marks.roles.forEach((role, mcid) => {
        bodies[elem - 1] = `<< /Type /StructElem /S /${role} /P ${docElemId} 0 R /Pg ${pageId(i)} 0 R /K ${mcid} >>`;
        pageElems.push(elem);
        markRefs.push(elem);
        elem += 1;
      });
      nums.push(`${i} [${pageElems.map((id) => `${id} 0 R`).join(' ')}]`);
    });
    const rootId = elem;
    const parentTreeId = elem + 1;
    bodies[docElemId - 1] = `<< /Type /StructElem /S /Document /P ${rootId} 0 R /K [${markRefs.map((id) => `${id} 0 R`).join(' ')}] >>`;
    bodies[rootId - 1] = `<< /Type /StructTreeRoot /K ${docElemId} 0 R /ParentTree ${parentTreeId} 0 R /ParentTreeNextKey ${written.length} /RoleMap << /Title /H1 >> >>`;
    bodies[parentTreeId - 1] = `<< /Nums [${nums.join(' ')}] >>`;
    bodies[0] =
      `<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> ` +
      `${info.lang === undefined ? '' : `/Lang (${pdfString(info.lang)}) `}/Metadata ${metaId} 0 R ` +
      `/StructTreeRoot ${rootId} 0 R /OutputIntents [${intentId} 0 R] >>`;
  }

  // The binary comment line: four bytes above 127 under the version line, so the file reads as binary to a text tool.
  // PDF/A-2u requires it (ISO 19005-2 6.1.2); the unprofiled file carries it too, as the PDF spec recommends.
  // `âãÏÓ` encodes to eight bytes all above 127, and decodes back losslessly. It goes in the head, so the body
  // `out` stays ASCII and `out.length` is a byte count.
  const head = new TextEncoder().encode(`${profile ? '%PDF-1.7' : '%PDF-1.4'}\n%âãÏÓ\n`);
  const headLen = head.length;
  let out = '%CAOTANG\n';
  const offsets: number[] = [];
  bodies.forEach((body, index) => {
    offsets.push(headLen + out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = headLen + out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  const trailerId = profile ? ` /ID [<${fileId(out)}> <${fileId(out)}>]` : '';
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R /Info 4 0 R${trailerId} >>\nstartxref\n${xref}\n%%EOF\n`;
  const body = new TextEncoder().encode(out);
  const pdf = new Uint8Array(headLen + body.length);
  pdf.set(head);
  pdf.set(body, headLen);
  return pdf;
}
