/**
 * A minimal PDF writer for the paginated screenplay ([screenplay.md §5.3](../../../docs/architecture/screenplay.md)).
 *
 * One uncompressed content stream per page, one font in WinAnsi encoding, and, for a script with
 * other characters, one fallback font. Caotang owns it for the same reason it owns the EPUB
 * emitter (exporter.md §3a): a dormant dependency costs more than a few hundred lines of
 * frozen-format output. The one library the writer leans on, @pdf-lib/fontkit, cuts the fallback
 * subset, and is loaded only when a script needs it.
 *
 * The font is Courier Prime (A3), embedded whole as a TrueType font program (`FontFile2`),
 * when the caller passes its bytes. The exporter always does. Without them the page names the
 * base-14 Courier, which every viewer has; Courier Prime has Courier's metrics, so the layout
 * is the same either way.
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
 * Every byte is ASCII. Strings are escaped on the way in and the font program is written in
 * hexadecimal (`ASCIIHexDecode`), so the object offsets the xref table records are string
 * offsets, and the tests can check them exactly.
 */

import { cidFontObjects, type CidSubset, type PdfValue } from '@caotang/pdf-fonts';

import { COURIER_PRIME_METRICS } from './fonts/courier-prime-metrics.js';
import { isEmojiCluster } from './emoji.js';
import { LAYOUT } from './paginate.js';
import { WIN_ANSI_EXTRA, isPrintable } from './winansi.js';
import { textUnits, unitColumns } from './width.js';

export { isPrintable };

/** How many objects a CID font takes (`cidFontObjects`). */
const CID_FONT_OBJECTS = 6;

export interface PdfText {
  readonly text: string;
  /** Points from the left page edge. */
  readonly x: number;
  /** Baseline in points from the top page edge. */
  readonly y: number;
}

export interface PdfInfo {
  readonly title?: string;
  readonly author?: string;
  readonly producer?: string;
}

/** A TrueType font program to embed: Courier Prime (A3). Its metrics are the ones `COURIER_PRIME_METRICS` states. */
export interface PdfFont {
  readonly bytes: Uint8Array;
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

function contentStream(lines: readonly PdfText[], fallback?: PdfCidFont, emoji?: PdfEmojiFont): string {
  const parts = ['BT', '/F1 12 Tf'];
  let current = 'F1';
  const setFont = (name: string, size = 12): void => {
    if (current !== name) parts.push(`/${name} ${size} Tf`);
    current = name;
  };
  for (const line of lines) {
    const y = num(LAYOUT.pageHeight - line.y);
    // A line whose every unit is one Courier Prime column is one string, as the writer always wrote it.
    const units = LATIN.test(line.text) ? null : textUnits(line.text);
    if (units === null || units.every((unit) => unit.length === 1 && unitColumns(unit) === 1 && fontOf(unit, fallback, emoji) === 'F1')) {
      setFont('F1');
      parts.push(`1 0 0 1 ${num(line.x)} ${y} Tm`, `(${pdfString(line.text)}) Tj`);
      continue;
    }
    // A line with fallback glyphs or emoji is written as runs, each placed at its first unit's column.
    for (const run of runsOf(units, fallback, emoji)) {
      if (run.font === 'F3' && emoji !== undefined) {
        // Each emoji is placed on its own, centred in its two-column cell.
        setFont('F3', emoji.size);
        (run.glyphs as PdfEmojiGlyph[]).forEach((glyph, i) => {
          parts.push(`1 0 0 1 ${num(line.x + (run.column + 2 * i) * LAYOUT.charWidth + glyph.dx)} ${y} Tm`, `${cidString([glyph])} Tj`);
        });
        continue;
      }
      parts.push(`1 0 0 1 ${num(line.x + run.column * LAYOUT.charWidth)} ${y} Tm`);
      if (run.font === 'F1') {
        setFont('F1');
        parts.push(`(${pdfString(run.text)}) Tj`);
      } else {
        setFont('F2');
        parts.push(`${cidString(run.glyphs)} Tj`);
      }
    }
  }
  parts.push('ET');
  return parts.join('\n');
}

/** The font a unit prints in: F1 Courier Prime, F2 the CJK fallback, F3 the emoji fallback. A unit no font has is F1, as "?". */
function fontOf(unit: string, fallback?: PdfCidFont, emoji?: PdfEmojiFont): 'F1' | 'F2' | 'F3' {
  if (unit.length > 1 || unit.charCodeAt(0) >= 0x231a) {
    if (isEmojiCluster(unit)) return emoji?.glyphs.has(unit) === true ? 'F3' : 'F1';
  }
  const base = String.fromCodePoint(unit.codePointAt(0) ?? 0x3f);
  if (isPrintable(base)) return 'F1';
  if (fallback?.glyphs.has(base) === true) return 'F2';
  if (emoji?.glyphs.has(unit) === true) return 'F3';
  return 'F1';
}

interface Run {
  readonly column: number;
  readonly font: 'F1' | 'F2' | 'F3';
  /** The text a Courier Prime run prints: each unit's character, or "?" for a unit no font has. */
  text: string;
  /** The fallback glyphs of an F2 or F3 run. */
  readonly glyphs: (PdfCidGlyph | PdfEmojiGlyph)[];
  /** Set when the run's last unit is wider than what it prints ("?" for an emoji), so the next unit starts a new run. */
  closed: boolean;
}

/** A line's units cut into runs of one font each, with the grid column each run starts at. */
function runsOf(units: readonly string[], fallback?: PdfCidFont, emoji?: PdfEmojiFont): Run[] {
  const runs: Run[] = [];
  let column = 0;
  for (const unit of units) {
    const font = fontOf(unit, fallback, emoji);
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

/** The font dictionary for Courier Prime as an embedded TrueType font, with WinAnsi codes 32 to 255. */
function embeddedFontObjects(font: PdfFont, descriptorId: number, fileId: number): { font: string; descriptor: string; file: string } {
  const m = COURIER_PRIME_METRICS;
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
  return `<< ${Object.entries(object.dict).map(([key, item]) => `/${key} ${valueText(item, first)}`).join(' ')} >>`;
}

/** The objects of a CID font (`@caotang/pdf-fonts`, cid-font.ts) as file text, the first one numbered `first`. A binary stream is written in hexadecimal. */
function cidFontText(font: CidSubset, first: number): string[] {
  return cidFontObjects(font).map((object) => {
    const dict = Object.entries(object.dict).map(([key, item]) => `/${key} ${valueText(item, first)}`);
    const { stream } = object;
    if (stream === undefined) return `<< ${dict.join(' ')} >>`;
    const body = typeof stream === 'string' ? stream : hex(stream);
    const filter = typeof stream === 'string' ? [] : ['/Filter /ASCIIHexDecode'];
    return `<< /Length ${body.length} ${[...dict, ...filter].join(' ')} >>\nstream\n${body}\nendstream`;
  });
}

/** An info-dictionary string: a literal in WinAnsi when every character is printable, UTF-16BE with a byte order mark otherwise. */
function infoString(text: string): string {
  if ([...text].every(isPrintable)) return `(${pdfString(text)})`;
  return `<FEFF${utf16Hex(text)}>`;
}

/**
 * Writes one PDF from pages of positioned text. Object 1 is the catalogue, 2 the page tree,
 * 3 the font, 4 the info dictionary. Each page then takes two objects: the page, and its
 * content stream. An embedded font adds its descriptor and its program after the pages, a CJK fallback that prints at
 * least one character adds its six objects after those, and an emoji font that prints at least one unit its six after
 * those. Every page names each font the file has.
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
): Uint8Array<ArrayBuffer> {
  const fallback = cjk === undefined || cjk.glyphs.size === 0 ? undefined : cjk;
  const emoji = emojiFont === undefined || emojiFont.glyphs.size === 0 ? undefined : emojiFont;
  // A page tree with no page in it is a file a reader refuses, so a script that prints nothing still writes one page.
  const written: readonly (readonly PdfText[])[] = pages.length === 0 ? [[]] : pages;
  const pageId = (i: number): number => 5 + 2 * i;
  const bodies: string[] = [];
  bodies[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  bodies[1] = `<< /Type /Pages /Kids [${written.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${written.length} >>`;
  if (font === undefined) {
    bodies[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  } else {
    const descriptorId = pageId(written.length);
    const objects = embeddedFontObjects(font, descriptorId, descriptorId + 1);
    bodies[2] = objects.font;
    bodies[descriptorId - 1] = objects.descriptor;
    bodies[descriptorId] = objects.file;
  }
  const fallbackId = pageId(written.length) + (font === undefined ? 0 : 2);
  if (fallback !== undefined) {
    cidFontText(fallback, fallbackId).forEach((body, i) => {
      bodies[fallbackId - 1 + i] = body;
    });
  }
  const emojiId = fallbackId + (fallback === undefined ? 0 : CID_FONT_OBJECTS);
  if (emoji !== undefined) {
    cidFontText(emoji, emojiId).forEach((body, i) => {
      bodies[emojiId - 1 + i] = body;
    });
  }
  const fonts =
    '/F1 3 0 R' + (fallback === undefined ? '' : ` /F2 ${fallbackId} 0 R`) + (emoji === undefined ? '' : ` /F3 ${emojiId} 0 R`);
  const author = info.author === undefined || info.author.trim() === '' ? '' : ` /Author ${infoString(info.author)}`;
  bodies[3] = `<< /Title ${infoString(info.title ?? 'Screenplay')}${author} /Producer ${infoString(info.producer ?? 'Caotang')} >>`;
  written.forEach((lines, i) => {
    const stream = contentStream(lines, fallback, emoji);
    bodies[pageId(i) - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${LAYOUT.pageWidth} ${LAYOUT.pageHeight}] ` +
      `/Resources << /Font << ${fonts} >> >> /Contents ${pageId(i) + 1} 0 R >>`;
    bodies[pageId(i)] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let out = '%PDF-1.4\n%CAOTANG\n';
  const offsets: number[] = [];
  bodies.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
