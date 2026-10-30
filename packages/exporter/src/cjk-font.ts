/**
 * The CJK fallback font of the contact-sheet PDF ([storyboard.md](../../../docs/architecture/storyboard.md) §6): the first
 * fallback, after Helvetica.
 *
 * The font is Noto Sans Mono CJK SC Regular (OFL-1.1) as a TrueType WOFF file in `@caotang/font-noto-cjk` (vendor/noto-sans-cjk,
 * where its source, checksum and build are written down), the file the screenplay PDF embeds too. It covers Chinese (simplified
 * and traditional), Japanese kana and kanji, Korean Hangul, Greek and Cyrillic. The host passes a `FontLoader` for it, and the
 * emitter calls it only when a sheet holds a character Helvetica cannot encode, so a Latin-only export never reads the font.
 *
 * Its Bold (`NotoSansMonoCJKsc-Bold.woff`, the same build of the upstream Bold) sets CJK text in a bold place (the title, the page
 * label, the chip) when the host passes `loadBoldFallbackFont`: a second {@link CjkFace} and {@link CjkEmbedding}, a font of its own
 * in the file. Without it, or when it cannot be read, that text is the Regular with the synthetic stroke (embolden.ts).
 *
 * Its text is laid out one code point to a glyph, a Han character in the forms of the project's language (`hanLocaleTag`: the
 * font's `locl` feature, the build keeps no other), and embedded as the emoji font is (cid-embedding.ts): a CID for each
 * distinct glyph-and-text pair.
 */

import { hanGlyph, hanLocaleTag, type HanLanguageTag } from '@caotang/pdf-fonts';

import type * as PdfLib from 'pdf-lib';

import { CidEmbedding, type CidGlyph, type FontkitFont } from './cid-embedding.js';

/** The CJK font, with the lookups the emitter needs. */
export class CjkFace {
  private readonly tag: HanLanguageTag | undefined;

  constructor(
    readonly font: FontkitFont,
    /** The project's language (a BCP 47 tag): the forms Han characters take. */
    language?: string,
  ) {
    this.tag = hanLocaleTag(language);
  }

  /** Whether the font has a glyph for a code point. */
  covers(code: number): boolean {
    return this.font.hasGlyphForCodePoint(code);
  }

  /** The glyphs of a text, one to a code point, each carrying its own character; `null` when a code point has none. */
  glyphsOf(text: string): readonly CidGlyph[] | null {
    const glyphs: CidGlyph[] = [];
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (!this.covers(code)) return null;
      const glyph = hanGlyph(this.font, char, this.tag);
      glyphs.push({ id: glyph.id, advance: glyph.advanceWidth, text: char });
    }
    return glyphs;
  }

  /** The width of glyphs at a size, in points. */
  widthOf(glyphs: readonly CidGlyph[], size: number): number {
    return (glyphs.reduce((sum, glyph) => sum + glyph.advance, 0) * size) / this.font.unitsPerEm;
  }
}

/** The CJK font as it is embedded in one PDF (cid-embedding.ts): the Regular, or with `bold` the Bold, each a font of its own. */
export class CjkEmbedding extends CidEmbedding {
  constructor(lib: typeof PdfLib, doc: PdfLib.PDFDocument, readonly face: CjkFace, bold = false) {
    super(
      lib,
      doc,
      face.font,
      bold
        ? { resource: 'NotoCjkBold', tag: 'CAOTCB', postscriptName: face.font.postscriptName ?? 'NotoSansMonoCJKsc-Bold' }
        : { resource: 'NotoCjk', tag: 'CAOTCJ', postscriptName: face.font.postscriptName ?? 'NotoSansMonoCJKsc-Regular' },
    );
  }
}
