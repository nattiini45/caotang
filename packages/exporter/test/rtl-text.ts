/**
 * What a reader copies from the Arabic and Hebrew words of a contact sheet. The words are drawn glyph by glyph in visual order,
 * one text object for each run, with the text of every glyph in its font's ToUnicode map and no `/ActualText`; so a reader gets
 * a word by taking the glyphs' texts in the order they are drawn, last first (the bidirectional algorithm puts a right-to-left
 * word back in its logical order).
 */

import { NO_TEXT } from '@caotang/pdf-fonts';
import { PDFArray, PDFDict, PDFName, PDFRawStream, type PDFDocument } from 'pdf-lib';
import { unzlibSync } from 'fflate';

/** One run of glyphs drawn in an Arabic or Hebrew font: where the first glyph is, and what the glyphs copy as. */
export interface DrawnRun {
  /** The x of the first glyph drawn, the leftmost. */
  readonly x: number;
  /** The glyphs' texts, in the order they are drawn. */
  readonly drawn: readonly string[];
  /** The run as a reader puts it together: the glyphs' texts, last drawn first. */
  readonly word: string;
}

function inflated(stream: PDFRawStream): Uint8Array {
  return stream.dict.get(PDFName.of('Filter')) === PDFName.of('FlateDecode') ? unzlibSync(stream.contents) : stream.contents;
}

/** The CID to text map of a Type 0 font's ToUnicode CMap. */
function toUnicodeMap(pdf: PDFDocument, font: PDFDict): Map<number, string> {
  const map = new Map<number, string>();
  const ref = font.get(PDFName.of('ToUnicode'));
  const stream = ref === undefined ? undefined : pdf.context.lookup(ref);
  if (!(stream instanceof PDFRawStream)) return map;
  const cmap = new TextDecoder().decode(inflated(stream));
  for (const match of cmap.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
    const units: number[] = [];
    const hex = match[2] ?? '';
    for (let i = 0; i + 4 <= hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
    const text = String.fromCharCode(...units);
    // The writers' stand-in for a glyph with no text is no text to a reader.
    map.set(parseInt(match[1] ?? '', 16), text === NO_TEXT ? '' : text);
  }
  return map;
}

/** One page's content stream, decompressed, as text. */
function contentOf(pdf: PDFDocument, index: number): string {
  const contents = pdf.getPage(index).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => pdf.context.lookup(ref)) : [contents];
  return streams.map((stream) => (stream instanceof PDFRawStream ? new TextDecoder('latin1').decode(inflated(stream)) : '')).join('\n');
}

/** The runs of glyphs a page draws in fonts whose BaseFont contains one of `fonts`, in the order they are drawn. */
export function drawnRuns(pdf: PDFDocument, fonts: readonly string[] = ['NotoSansArabic', 'NotoSansHebrew'], index = 0): DrawnRun[] {
  const resources = pdf.getPage(index).node.Resources();
  const fontDict = resources?.lookup(PDFName.of('Font'));
  const texts = new Map<string, Map<number, string>>();
  if (fontDict instanceof PDFDict) {
    for (const [key, ref] of fontDict.entries()) {
      const font = pdf.context.lookup(ref);
      if (font instanceof PDFDict && fonts.some((name) => String(font.get(PDFName.of('BaseFont'))).includes(name))) {
        texts.set(String(key).replace(/^\//, ''), toUnicodeMap(pdf, font));
      }
    }
  }
  const runs: DrawnRun[] = [];
  for (const block of contentOf(pdf, index).matchAll(/BT\s+\/(\S+) [\d.]+ Tf([\s\S]*?)ET/g)) {
    const map = texts.get(block[1] ?? '');
    if (map === undefined) continue;
    const glyphs = [...(block[2] ?? '').matchAll(/1 0 0 1 (\S+) \S+ Tm\s+<([0-9A-F]{4})> Tj/g)];
    const drawn = glyphs.map((glyph) => map.get(parseInt(glyph[2] ?? '', 16)) ?? '');
    runs.push({ x: Number(glyphs[0]?.[1] ?? Number.NaN), drawn, word: [...drawn].reverse().join('') });
  }
  return runs;
}

/**
 * The words a screenplay page draws in Arabic and Hebrew fonts as a reader copies them, in the order they are written: the
 * glyphs of one font written one after another, up to the next text of another font or the next plain string, with their
 * ToUnicode texts last drawn first. The screenplay writes one text object for the page and a `Tj` for each glyph.
 */
export function drawnWords(pdf: PDFDocument, fonts: readonly string[] = ['NotoSansArabic', 'NotoSansHebrew'], index = 0): string[] {
  const resources = pdf.getPage(index).node.Resources();
  const fontDict = resources?.lookup(PDFName.of('Font'));
  const texts = new Map<string, Map<number, string>>();
  if (fontDict instanceof PDFDict) {
    for (const [key, ref] of fontDict.entries()) {
      const font = pdf.context.lookup(ref);
      if (font instanceof PDFDict && fonts.some((name) => String(font.get(PDFName.of('BaseFont'))).includes(name))) {
        texts.set(String(key).replace(/^\//, ''), toUnicodeMap(pdf, font));
      }
    }
  }
  const words: string[] = [];
  let current = '';
  let drawn: string[] = [];
  let font = '';
  const flush = (): void => {
    if (drawn.length > 0) words.push([...drawn].reverse().join(''));
    drawn = [];
  };
  for (const op of contentOf(pdf, index).matchAll(/\/(\S+) [\d.]+ Tf|<([0-9A-F]+)> Tj|\((?:[^()\\]|\\.)*\) Tj/g)) {
    if (op[1] !== undefined) {
      if (op[1] !== font) flush();
      font = op[1];
      current = font;
    } else if (op[2] !== undefined && texts.has(current)) {
      drawn.push(texts.get(current)?.get(parseInt(op[2], 16)) ?? '');
    } else flush();
  }
  flush();
  return words;
}
