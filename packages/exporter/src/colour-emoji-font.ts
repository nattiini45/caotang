/**
 * The colour emoji of the contact-sheet PDF ([storyboard.md](../../../docs/architecture/storyboard.md) §6): Noto Color Emoji's
 * vector pictures (`@caotang/font-noto-color-emoji`, opened by `@caotang/pdf-fonts/colour`) as Type 3 fonts, written by the writer both
 * PDFs share (`@caotang/pdf-fonts`, type3.ts) and registered with pdf-lib here (pdf-objects.ts).
 *
 * A colour emoji is one code of a Type 3 font, whatever it is made of, so copying a 👍🏽 gives 👍🏽 back. A glyph draws its own
 * colours (`d0`), so the ink the text is set in does not tint it. Codes are given the first time an emoji is drawn, 255 to a font, so one
 * compile writes one file; the fonts are written by {@link ColourEmbedding.finish}, once every page is drawn, and until then the pages
 * point at the references reserved for them.
 */

import { type3Objects, type3Place, type Type3Glyph } from '@caotang/pdf-fonts';
import type { ColourEmoji } from '@caotang/pdf-fonts/colour';
import type * as PdfLib from 'pdf-lib';

import { registerPdfObjects } from './pdf-objects.js';

export class ColourEmbedding {
  private readonly places = new Map<string, number>();
  private readonly order: string[] = [];
  private readonly refs: PdfLib.PDFRef[] = [];
  private readonly keys = new Map<PdfLib.PDFPage, Map<string, PdfLib.PDFName>>();

  constructor(
    private readonly lib: typeof PdfLib,
    private readonly doc: PdfLib.PDFDocument,
    private readonly asset: ColourEmoji,
  ) {}

  /** Whether any emoji has been drawn. */
  get used(): boolean {
    return this.order.length > 0;
  }

  /** Whether the asset has a picture for a cluster. */
  has(cluster: string): boolean {
    return this.asset.has(cluster);
  }

  /** The advance of a cluster's picture at a size, in points. */
  widthOf(cluster: string, size: number): number {
    return ((this.asset.glyph(cluster)?.advance ?? 0) * size) / 1000;
  }

  /** Draws a cluster's picture from a baseline start. Its colours are its own: it takes no ink. */
  draw(page: PdfLib.PDFPage, cluster: string, x: number, y: number, size: number): void {
    const { pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, moveText, showText, PDFHexString } = this.lib;
    let index = this.places.get(cluster);
    if (index === undefined) {
      index = this.order.length;
      this.places.set(cluster, index);
      this.order.push(cluster);
    }
    const { font, code } = type3Place(index);
    while (this.refs.length <= font) this.refs.push(this.doc.context.nextRef());
    const tag = `CE${font + 1}`;
    // A page names a font by a key of its own: one for each font and page.
    let names = this.keys.get(page);
    if (names === undefined) {
      names = new Map();
      this.keys.set(page, names);
    }
    let key = names.get(tag);
    if (key === undefined) {
      key = page.node.newFontDictionary(tag, this.refs[font] as PdfLib.PDFRef);
      names.set(tag, key);
    }
    page.pushOperators(pushGraphicsState(), beginText(), setFontAndSize(key, size), moveText(x, y), showText(PDFHexString.of(code.toString(16).toUpperCase().padStart(2, '0'))), endText(), popGraphicsState());
  }

  /**
   * Writes the fonts: the glyph procedures, the ToUnicode maps and what they share. Writes nothing when no emoji was drawn, since no
   * page points at a font then.
   */
  async finish(): Promise<void> {
    if (!this.used) return;
    const glyphs: Type3Glyph[] = [];
    for (const cluster of this.order) {
      const glyph = this.asset.glyph(cluster);
      if (glyph !== undefined) glyphs.push({ text: cluster, width: glyph.advance, content: glyph.content, ids: glyph.ids, bbox: glyph.bbox });
    }
    const { objects } = type3Objects(glyphs, (id) => this.asset.pool(id));
    registerPdfObjects(this.lib, this.doc, objects, new Map(this.refs.map((ref, index) => [index, ref])));
  }
}
