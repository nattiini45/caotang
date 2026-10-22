/**
 * The emoji font of the contact-sheet PDF ([storyboard.md](../../../docs/architecture/storyboard.md) §6): the last fallback,
 * after Helvetica and Noto Sans Mono CJK.
 *
 * The font is Noto Emoji Regular 3.002 (OFL-1.1), the monochrome Noto emoji font, as a static TrueType WOFF file in
 * `@caotang/font-noto-emoji` (vendor/noto-emoji, where its source, checksum and build are written down). It draws every
 * fully-qualified emoji of Unicode Emoji 15.1. Like the CJK font, the host passes a {@link FontLoader} for it, and the emitter
 * calls it only when a sheet holds an emoji, so a sheet without one never reads it.
 *
 * ## Layout
 *
 * An emoji can be many code points that draw as one picture: a ZWJ sequence (👨‍👩‍👧), a skin tone (👍🏽), a flag (🇩🇪), a
 * keycap (1️⃣), a tag sequence (🏴󠁧󠁢󠁳󠁣󠁴󠁿). The font draws each through its GSUB ligatures (`ccmp`), so each grapheme cluster
 * is laid out with fontkit's `font.layout`, and the glyphs it gives are what is drawn. A ZWJ sequence the font has no ligature
 * for is drawn as its parts, as Unicode's emoji spec recommends: of Emoji 15.1's people "facing right", the woman and man walking,
 * kneeling or running and everyone with a white cane or in a wheelchair (🚶‍♀️‍➡️ as 🚶, ♀️ and ➡️); the person walking, kneeling
 * or running facing right (🚶‍➡️) has a ligature, and is one glyph.
 *
 * ## Embedding
 *
 * pdf-lib's own font embedding writes one ToUnicode entry per glyph, from the code points fontkit reports for it, and fontkit
 * reports some of them short (a skin tone that the monochrome font draws as the plain figure is not among them). So this file
 * writes the font itself, as a Type 0 font over a TrueType subset that fontkit cuts: every distinct cluster gets CIDs of its
 * own, mapped to its glyphs by a CIDToGIDMap and to its exact text by the ToUnicode map, so copying a 👍🏽 gives 👍🏽 back,
 * and 👍 gives 👍, though the two draw the same glyph.
 */

import { encodeSubset } from '@caotang/pdf-fonts';
import type * as PdfLib from 'pdf-lib';

/** The parts of a fontkit glyph this file reads. */
interface FontkitGlyph {
  readonly id: number;
  readonly advanceWidth: number;
  readonly path: { readonly commands: readonly unknown[] };
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
  createSubset(): FontkitSubset;
}

interface FontkitSubset {
  includeGlyph(glyph: number): number;
  encodeStream(): { on(event: string, listener: (value?: unknown) => void): unknown };
}

/** One glyph an emoji draws: its id in the font, its advance in font units, and the text it stands for when copied. */
export interface EmojiGlyph {
  readonly id: number;
  readonly advance: number;
  /** The part of the cluster this glyph gives back when the text is copied; the cluster's first glyph carries it all. */
  readonly text: string;
}

const ZWJ = '\u200d';

/** The emoji font, laid out by grapheme cluster. */
export class EmojiFace {
  private readonly cache = new Map<string, readonly EmojiGlyph[] | null>();

  constructor(readonly font: FontkitFont) {}

  /**
   * The glyphs that draw a cluster, in order, or `null` when the font cannot draw it (a glyph would be `.notdef`). Glyphs that
   * draw nothing and take no room (a variation selector the ligature left behind) are dropped.
   */
  glyphsOf(cluster: string): readonly EmojiGlyph[] | null {
    const known = this.cache.get(cluster);
    if (known !== undefined) return known;
    const glyphs = this.resolve(cluster);
    this.cache.set(cluster, glyphs);
    return glyphs;
  }

  /** The width of a cluster's glyphs at a size, in points. */
  widthOf(glyphs: readonly EmojiGlyph[], size: number): number {
    return (glyphs.reduce((sum, glyph) => sum + glyph.advance, 0) * size) / this.font.unitsPerEm;
  }

  private resolve(cluster: string): readonly EmojiGlyph[] | null {
    const whole = this.shape(cluster);
    if (whole !== null && whole.length > 0 && (whole.length === 1 || !cluster.includes(ZWJ))) return carrying(whole, cluster);
    if (!cluster.includes(ZWJ)) return null;
    // No ligature for the whole sequence: draw its parts, as UTS #51 recommends. The joiners go with the copied text.
    const glyphs: EmojiGlyph[] = [];
    for (const [index, part] of cluster.split(ZWJ).entries()) {
      if (part === '') continue;
      const shaped = this.shape(part);
      if (shaped === null || shaped.length === 0) return null;
      glyphs.push(...carrying(shaped, index === 0 ? part : `${ZWJ}${part}`));
    }
    return glyphs.length > 0 ? glyphs : null;
  }

  /** The visible glyphs of a text as the font's layout gives them, or `null` when one of them is `.notdef`. */
  private shape(text: string): FontkitGlyph[] | null {
    const { glyphs } = this.font.layout(text);
    if (glyphs.some((glyph) => glyph.id === 0)) return null;
    return glyphs.filter((glyph) => glyph.advanceWidth > 0 || glyph.path.commands.length > 0);
  }
}

/** Glyphs as {@link EmojiGlyph}s, the first carrying the whole text and the rest none. */
function carrying(glyphs: readonly FontkitGlyph[], text: string): EmojiGlyph[] {
  return glyphs.map((glyph, index) => ({ id: glyph.id, advance: glyph.advanceWidth, text: index === 0 ? text : '' }));
}

/** A ToUnicode CMap holds at most 100 entries per `beginbfchar` block (PDF 32000-1 §9.10.3, Adobe TN 5411). */
const BFCHAR_BLOCK = 100;

/** A code point as UTF-16 hex, as a ToUnicode destination writes it. */
function utf16Hex(text: string): string {
  let hex = '';
  for (let i = 0; i < text.length; i += 1) hex += text.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  return hex;
}

const hex4 = (value: number): string => value.toString(16).toUpperCase().padStart(4, '0');

/**
 * The emoji font as it is embedded in one PDF: a Type 0 font (Identity-H) over a CIDFontType2 subset. A CID is given to each
 * distinct glyph-and-text pair the file draws, in the order first drawn, so one compile writes one file. The font objects
 * are written by {@link finish}, once every page is drawn; until then the pages point at {@link ref}.
 */
export class EmojiEmbedding {
  readonly ref: PdfLib.PDFRef;
  private readonly subset: FontkitSubset;
  private readonly cids = new Map<string, number>();
  private readonly entries: { readonly gid: number; readonly advance: number; readonly text: string }[] = [];
  private readonly keys = new Map<PdfLib.PDFPage, PdfLib.PDFName>();

  constructor(
    private readonly lib: typeof PdfLib,
    private readonly doc: PdfLib.PDFDocument,
    readonly face: EmojiFace,
  ) {
    this.ref = doc.context.nextRef();
    this.subset = face.font.createSubset();
  }

  /** Whether any glyph has been drawn. */
  get used(): boolean {
    return this.entries.length > 0;
  }

  /** Draws the glyphs of one or more clusters from a baseline start, in a colour. */
  draw(page: PdfLib.PDFPage, glyphs: readonly EmojiGlyph[], x: number, y: number, size: number, ink: { r: number; g: number; b: number }): void {
    const { pushGraphicsState, popGraphicsState, beginText, endText, setFontAndSize, setFillingRgbColor, moveText, showText, PDFHexString } = this.lib;
    let key = this.keys.get(page);
    if (key === undefined) {
      key = page.node.newFontDictionary('NotoEmoji', this.ref);
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

  private cidOf(glyph: EmojiGlyph): number {
    const key = `${glyph.id}\u0000${glyph.text}`;
    const known = this.cids.get(key);
    if (known !== undefined) return known;
    const gid = this.subset.includeGlyph(glyph.id);
    this.entries.push({ gid, advance: glyph.advance, text: glyph.text });
    const cid = this.entries.length;
    this.cids.set(key, cid);
    return cid;
  }

  /**
   * Writes the font objects: the subset program, its widths, the CID-to-glyph map and the ToUnicode map. Writes nothing when no
   * glyph was drawn, since no page points at {@link ref} then, and a font with no glyphs is no font to embed.
   */
  async finish(): Promise<void> {
    if (!this.used) return;
    const { PDFString } = this.lib;
    const context = this.doc.context;
    const font = this.face.font;
    const scale = 1000 / font.unitsPerEm;
    const name = `CAOTEM+${font.postscriptName ?? 'NotoEmoji-Regular'}`;

    const program = await encodeSubset(this.subset);

    const cidToGid = new Uint8Array((this.entries.length + 1) * 2);
    this.entries.forEach((entry, index) => {
      cidToGid[(index + 1) * 2] = entry.gid >> 8;
      cidToGid[(index + 1) * 2 + 1] = entry.gid & 0xff;
    });

    const mapped = this.entries.flatMap((entry, index) => (entry.text === '' ? [] : [`<${hex4(index + 1)}> <${utf16Hex(entry.text)}>`]));
    const blocks: string[] = [];
    for (let i = 0; i < mapped.length; i += BFCHAR_BLOCK) {
      const block = mapped.slice(i, i + BFCHAR_BLOCK);
      blocks.push(`${block.length} beginbfchar\n${block.join('\n')}\nendbfchar`);
    }
    const toUnicode = [
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

    const fontFile = context.register(context.flateStream(program));
    const descriptor = context.register(
      context.obj({
        Type: 'FontDescriptor',
        FontName: name,
        Flags: 4,
        FontBBox: [font.bbox.minX * scale, font.bbox.minY * scale, font.bbox.maxX * scale, font.bbox.maxY * scale],
        ItalicAngle: font.italicAngle,
        Ascent: font.ascent * scale,
        Descent: font.descent * scale,
        CapHeight: (font.capHeight || font.ascent) * scale,
        StemV: 0,
        FontFile2: fontFile,
      }),
    );
    const widths = this.entries.map((entry) => Math.round(entry.advance * scale * 1000) / 1000);
    const cidFont = context.register(
      context.obj({
        Type: 'Font',
        Subtype: 'CIDFontType2',
        BaseFont: name,
        CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
        FontDescriptor: descriptor,
        DW: 0,
        W: widths.length === 0 ? [] : [1, widths],
        CIDToGIDMap: context.register(context.flateStream(cidToGid)),
      }),
    );
    context.assign(
      this.ref,
      context.obj({
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: name,
        Encoding: 'Identity-H',
        DescendantFonts: [cidFont],
        ToUnicode: context.register(context.flateStream(toUnicode)),
      }),
    );
  }
}
