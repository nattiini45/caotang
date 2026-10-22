/**
 * The emoji font of the contact-sheet PDF ([storyboard.md](../../../docs/architecture/storyboard.md) §6): the last fallback,
 * after Helvetica and Noto Sans Mono CJK.
 *
 * The font is Noto Emoji Regular 3.006 (OFL-1.1), the monochrome Noto emoji font, as a static TrueType WOFF file in
 * `@caotang/font-noto-emoji` (vendor/noto-emoji, where its source, checksum and build are written down). It draws every
 * fully-qualified emoji of Unicode Emoji 17.0. Like the CJK font, the host passes a {@link FontLoader} for it, and the emitter
 * calls it only when a sheet holds an emoji, so a sheet without one never reads it.
 *
 * ## Layout
 *
 * An emoji can be many code points that draw as one picture: a ZWJ sequence (👨‍👩‍👧), a skin tone (👍🏽), a flag (🇩🇪), a
 * keycap (1️⃣), a tag sequence (🏴󠁧󠁢󠁳󠁣󠁴󠁿). The font draws each through its GSUB ligatures (`ccmp`), so each grapheme cluster
 * is laid out with fontkit's `font.layout`, and the glyphs it gives are what is drawn. A ZWJ sequence the font has no ligature
 * for is drawn as its parts, as Unicode's emoji spec recommends: of Emoji 17.0's people "facing right", the woman and man walking,
 * kneeling or running (🚶‍♀️‍➡️ as 🚶, ♀️ and ➡️; fontkit does not lay them out as one glyph, though the font has them); every other
 * person facing right (🚶‍➡️, or with a white cane or in a wheelchair) is one glyph.
 *
 * ## Embedding
 *
 * The font is embedded by hand, as the CJK font is (cid-embedding.ts, over the CID-font writer both PDFs share): a CID for each
 * distinct glyph-and-text pair, so copying a 👍🏽 gives 👍🏽 back, and 👍 gives 👍, though the two draw the same glyph.
 */

import type * as PdfLib from 'pdf-lib';

import { CidEmbedding, type CidGlyph, type FontkitFont, type FontkitGlyph } from './cid-embedding.js';

export type { FontkitFont };

/** One glyph an emoji draws: its id in the font, its advance in font units, and the text it stands for when copied. */
export type EmojiGlyph = CidGlyph;

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

/** The emoji font as it is embedded in one PDF (cid-embedding.ts), with the face that lays its clusters out. */
export class EmojiEmbedding extends CidEmbedding {
  constructor(lib: typeof PdfLib, doc: PdfLib.PDFDocument, readonly face: EmojiFace) {
    super(lib, doc, face.font, { resource: 'NotoEmoji', tag: 'CAOTEM', postscriptName: face.font.postscriptName ?? 'NotoEmoji-Regular' });
  }
}
