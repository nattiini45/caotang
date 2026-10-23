/**
 * A fallback font as it is embedded in one contact-sheet PDF ([storyboard.md](../../../docs/architecture/storyboard.md) §6):
 * a Type 0 font (Identity-H) over a CIDFontType2 subset that fontkit cuts, written by the CID-font writer both PDFs share
 * (`@caotang/pdf-fonts`, cid-font.ts) and registered with pdf-lib here.
 *
 * pdf-lib's own font embedding writes one ToUnicode entry per glyph, from the code points fontkit reports for it, and fontkit
 * reports some of them short (a skin tone that the monochrome font draws as the plain figure is not among them; two characters
 * that share a glyph share an entry). So the font is written by hand: every distinct (glyph, text) pair the file draws gets a
 * CID of its own, mapped to its glyph by a CIDToGIDMap and to its exact text by the ToUnicode map, so copying a 👍🏽 gives 👍🏽
 * back, and 👍 gives 👍, though the two draw the same glyph.
 *
 * A CID is given the first time a glyph is drawn, in the order the file draws them, so one compile writes one file. The font
 * objects are written by {@link CidEmbedding.finish}, once every page is drawn; until then the pages point at `ref`.
 */

import { CidNumbering, cidFontObjects, describeSubset, encodeSubset, padGlyphs, type PdfObject, type PdfValue } from '@caotang/pdf-fonts';
import type * as PdfLib from 'pdf-lib';

/** One glyph a text draws: its id in the font, its advance in font units, and the text it stands for when copied. */
export interface CidGlyph {
  readonly id: number;
  readonly advance: number;
  /** The part of the text this glyph gives back when it is copied; a sequence's first glyph carries it all. */
  readonly text: string;
}

/** The parts of a fontkit font this file reads. */
export interface FontkitFont {
  readonly unitsPerEm: number;
  readonly ascent: number;
  readonly descent: number;
  readonly capHeight: number;
  readonly italicAngle: number;
  readonly postscriptName: string | null;
  readonly bbox: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
  layout(text: string): { readonly glyphs: readonly FontkitGlyph[] };
  hasGlyphForCodePoint(code: number): boolean;
  glyphForCodePoint(code: number): FontkitGlyph;
  getGlyph(id: number): FontkitGlyph;
  createSubset(): FontkitSubset;
}

/** The parts of a fontkit glyph this file reads. */
export interface FontkitGlyph {
  readonly id: number;
  readonly advanceWidth: number;
  readonly path: { readonly commands: readonly unknown[] };
}

export interface FontkitSubset {
  includeGlyph(glyph: number): number;
  encodeStream(): { on(event: string, listener: (value?: unknown) => void): unknown };
}

const hex4 = (value: number): string => value.toString(16).toUpperCase().padStart(4, '0');

/** How a font is named in the file: the resource its pages use, the tag its subset takes, and its PostScript name. */
export interface CidFontNames {
  readonly resource: string;
  readonly tag: string;
  readonly postscriptName: string;
}

export class CidEmbedding {
  readonly ref: PdfLib.PDFRef;
  private readonly subset: FontkitSubset;
  private readonly cids = new Map<string, number>();
  private readonly entries: { readonly gid: number; readonly advance: number; readonly text: string; readonly cid: number }[] = [];
  private readonly numbering: CidNumbering;
  private readonly keys = new Map<PdfLib.PDFPage, PdfLib.PDFName>();

  constructor(
    private readonly lib: typeof PdfLib,
    private readonly doc: PdfLib.PDFDocument,
    readonly font: FontkitFont,
    private readonly names: CidFontNames,
    /** True for a font whose glyphs with no text take a CID pdf.js skips (cid-font.ts CidNumbering): the right-to-left fonts. */
    textlessCids = false,
  ) {
    this.numbering = new CidNumbering(textlessCids);
    this.ref = doc.context.nextRef();
    this.subset = font.createSubset();
    padGlyphs(this.subset);
  }

  /** Whether any glyph has been drawn. */
  get used(): boolean {
    return this.entries.length > 0;
  }

  /** Draws glyphs from a baseline start, in a colour. */
  draw(page: PdfLib.PDFPage, glyphs: readonly CidGlyph[], x: number, y: number, size: number, ink: { r: number; g: number; b: number }): void {
    const { pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setFillingRgbColor, moveText, showText, PDFHexString } = this.lib;
    let key = this.keys.get(page);
    if (key === undefined) {
      key = page.node.newFontDictionary(this.names.resource, this.ref);
      this.keys.set(page, key);
    }
    const codes = glyphs.map((glyph) => hex4(this.cidOf(glyph))).join('');
    page.pushOperators(
      pushGraphicsState(),
      setFillingRgbColor(ink.r, ink.g, ink.b),
      beginText(),
      setFontAndSize(key, size),
      moveText(x, y),
      showText(PDFHexString.of(codes)),
      endText(),
      popGraphicsState(),
    );
  }

  /**
   * Draws a shaped run glyph by glyph, each at its own position (a pen that moves by the advances, and the glyph's offset from
   * it). pdf-lib's own text operators write advances only, so the offsets that place a joined or marked word are drawn here.
   * With `actual`, the run's logical text, the glyphs are inside marked content that gives it to a reader (`/ActualText`); that
   * is for a left-to-right script. A right-to-left run passes none: its glyphs are in visual order, each with its text in
   * ToUnicode, and a reader puts the words in logical order itself. The `final` glyphs, the marks after the last letter of such
   * a run, which are drawn first at its left end, are written after the others in marked content of their own: pdf.js appends a
   * mark to the text item that is open, so first in the stream it would be read into the word drawn before this one.
   */
  drawPlaced(
    page: PdfLib.PDFPage,
    glyphs: readonly { readonly id: number; readonly advance: number; readonly text: string; readonly dx: number; readonly dy: number; readonly final?: true }[],
    x: number,
    y: number,
    size: number,
    ink: { r: number; g: number; b: number },
    actual?: string,
  ): void {
    const { pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setFillingRgbColor, setTextMatrix, showText, PDFHexString, PDFName, PDFOperator, PDFOperatorNames, beginMarkedContent, endMarkedContent } = this.lib;
    let key = this.keys.get(page);
    if (key === undefined) {
      key = page.node.newFontDictionary(this.names.resource, this.ref);
      this.keys.set(page, key);
    }
    const scale = size / this.font.unitsPerEm;
    const operators = [
      pushGraphicsState(),
      ...(actual === undefined
        ? []
        : [
            // pdf-lib has the operator for marked content without properties only (BMC); this is BDC, with the /ActualText
            // dictionary inline. Its operand types leave out a dictionary, which the operator writes as it writes any object.
            PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
              PDFName.of('Span'),
              this.doc.context.obj({ ActualText: PDFHexString.fromText(actual) }) as unknown as PdfLib.PDFName,
            ]),
          ]),
      setFillingRgbColor(ink.r, ink.g, ink.b),
      beginText(),
      setFontAndSize(key, size),
    ];
    let pen = x;
    const body: PdfLib.PDFOperator[] = [];
    const finals: PdfLib.PDFOperator[] = [];
    for (const glyph of glyphs) {
      (glyph.final === true ? finals : body).push(setTextMatrix(1, 0, 0, 1, pen + glyph.dx * scale, y + glyph.dy * scale), showText(PDFHexString.of(hex4(this.cidOf(glyph)))));
      pen += glyph.advance * scale;
    }
    operators.push(...body, endText(), ...(actual === undefined ? [] : [endMarkedContent()]));
    if (finals.length > 0) operators.push(beginMarkedContent('Span'), beginText(), setFontAndSize(key, size), ...finals, endText(), endMarkedContent());
    operators.push(popGraphicsState());
    page.pushOperators(...operators);
  }

  private cidOf(glyph: CidGlyph): number {
    const key = `${glyph.id}\u0000${glyph.text}`;
    const known = this.cids.get(key);
    if (known !== undefined) return known;
    const gid = this.subset.includeGlyph(glyph.id);
    const cid = this.numbering.next(glyph.text);
    this.entries.push({ gid, advance: glyph.advance, text: glyph.text, cid });
    this.cids.set(key, cid);
    return cid;
  }

  /**
   * Writes the font objects: the subset program, its widths, the CID-to-glyph map and the ToUnicode map. Writes nothing when no
   * glyph was drawn, since no page points at {@link ref} then, and a font with no glyphs is no font to embed.
   */
  async finish(): Promise<void> {
    if (!this.used) return;
    const scale = 1000 / this.font.unitsPerEm;
    const entries = this.entries.map((entry) => ({ gid: entry.gid, width: Math.round(entry.advance * scale * 1000) / 1000, text: entry.text, cid: entry.cid }));
    const program = await encodeSubset(this.subset);
    const subset = describeSubset(this.font, program, entries, this.names.postscriptName, this.names.tag);
    this.register(cidFontObjects(subset));
  }

  /** Registers the writer's objects with pdf-lib: object 0 is the font {@link ref} names, the others get references of their own. */
  private register(objects: readonly PdfObject[]): void {
    const { PDFName, PDFNumber, PDFString } = this.lib;
    const context = this.doc.context;
    const refs = objects.map((_, index) => (index === 0 ? this.ref : context.nextRef()));
    const convert = (value: PdfValue): PdfLib.PDFObject => {
      if (typeof value === 'number') return PDFNumber.of(value);
      if (Array.isArray(value)) return context.obj((value as readonly PdfValue[]).map(convert));
      const object = value as Exclude<PdfValue, number | readonly PdfValue[]>;
      if ('name' in object) return PDFName.of(object.name);
      if ('string' in object) return PDFString.of(object.string);
      if ('ref' in object) return refs[object.ref] as PdfLib.PDFRef;
      return convertDict(object.dict);
    };
    const convertDict = (dict: { readonly [key: string]: PdfValue }): PdfLib.PDFDict =>
      context.obj(Object.fromEntries(Object.entries(dict).map(([key, item]) => [key, convert(item)]))) as PdfLib.PDFDict;
    objects.forEach((object, index) => {
      const ref = refs[index] as PdfLib.PDFRef;
      const entries = Object.fromEntries(Object.entries(object.dict).map(([key, item]) => [key, convert(item)]));
      if (object.stream === undefined) context.assign(ref, context.obj(entries));
      else context.assign(ref, context.flateStream(object.stream, entries));
    });
  }
}
