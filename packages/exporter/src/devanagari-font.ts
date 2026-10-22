/**
 * The Devanagari font of the contact-sheet PDF ([storyboard.md](../../../docs/architecture/storyboard.md) §6): after Helvetica and
 * before Noto Sans Mono CJK and the emoji font, with Arabic and Hebrew.
 *
 * The font is Noto Sans Devanagari (OFL-1.1), the static TrueType file in `@caotang/font-noto-devanagari`
 * (vendor/noto-sans-devanagari), the file the screenplay PDF embeds too. The host passes a {@link FontLoader}, and the emitter calls
 * it only when a sheet holds a Devanagari character.
 *
 * A word is shaped by upstream fontkit 2.0.4 (`@caotang/pdf-fonts/indic-shaper`, loaded here and for Devanagari alone), in the
 * project's language, marks and all: the conjuncts, the short i drawn before its consonant, reph and the stacked marks. The run is
 * drawn glyph by glyph at the positions the shaper gave, not with pdf-lib's `drawText`, which writes only advances and so drops the
 * offsets (cid-embedding.ts `drawPlaced`), inside marked content that carries the word's typed text as `/ActualText`. The font is
 * cut by `@pdf-lib/fontkit` from the same bytes.
 */

import type * as PdfLib from 'pdf-lib';
import { loadFontWithBytes, type FontLoader } from '@caotang/pdf-fonts';
import { createFontkitShaper, shapeWord, type BrahmicShaper, type ShapedWord } from '@caotang/pdf-fonts/indic-shaper';

import { CidEmbedding, type FontkitFont } from './cid-embedding.js';

/** The font, with the shaper that lays a word out in it. */
export class DevanagariFace {
  private readonly cache = new Map<string, ShapedWord | null>();

  private constructor(
    readonly font: FontkitFont,
    private readonly shaper: BrahmicShaper,
    private readonly language: string | undefined,
  ) {}

  /** Reads the font through the host's loader and makes the shaper over its bytes. */
  static async load(load: FontLoader, language: string | undefined): Promise<DevanagariFace> {
    const { font, bytes } = await loadFontWithBytes(load, 'the Devanagari font');
    return new DevanagariFace(font as unknown as FontkitFont, await createFontkitShaper({ devanagari: bytes }), language);
  }

  /** A word shaped, or `null` when the engine cannot shape it (the word is then drawn as "?"). */
  shapeRun(text: string): ShapedWord | null {
    const known = this.cache.get(text);
    if (known !== undefined) return known;
    const word = shapeWord(this.shaper, text, { fontId: 'devanagari', script: 'deva', ...(this.language === undefined ? {} : { lang: this.language }) });
    const shaped = word.failed !== undefined || word.glyphs.length === 0 ? null : word;
    this.cache.set(text, shaped);
    return shaped;
  }

  /** The width of a shaped word at a size, in points. */
  widthOf(word: ShapedWord, size: number): number {
    return (word.advance * size) / this.font.unitsPerEm;
  }
}

/** The Devanagari font as it is embedded in one PDF (cid-embedding.ts). */
export class DevanagariEmbedding extends CidEmbedding {
  constructor(lib: typeof PdfLib, doc: PdfLib.PDFDocument, readonly face: DevanagariFace) {
    super(lib, doc, face.font, {
      resource: 'NotoDevanagari',
      tag: 'CAOTDV',
      postscriptName: face.font.postscriptName ?? 'NotoSansDevanagari-Regular',
    });
  }
}
