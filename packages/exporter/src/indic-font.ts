/**
 * The Indic fonts of the contact-sheet PDF ([storyboard.md](../../../docs/architecture/storyboard.md) §6): after Helvetica and
 * before Noto Sans Mono CJK and the emoji font, with Arabic and Hebrew.
 *
 * The fonts are Noto Sans Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam and Sinhala
 * (OFL-1.1), the static TrueType files of the `@caotang/font-noto-*` packages (vendor/noto-sans-*), the files the screenplay
 * PDF embeds too. The host passes a {@link FontLoader} for each script in {@link FontLoaderMap}, and the emitter calls one
 * only when a sheet holds a character of its script.
 *
 * A word is shaped by upstream fontkit 2.0.4 (`@caotang/pdf-fonts/indic-shaper`, loaded here and for Indic text alone), in the
 * project's language, marks and all: the conjuncts, a short i drawn before its consonant, reph and the stacked marks. The run is
 * drawn glyph by glyph at the positions the shaper gave, not with pdf-lib's `drawText`, which writes only advances and so drops the
 * offsets (cid-embedding.ts `drawPlaced`), inside marked content that carries the word's typed text as `/ActualText`. The font is
 * cut by `@pdf-lib/fontkit` from the same bytes.
 */

import type * as PdfLib from 'pdf-lib';
import { INDIC_SCRIPTS, loadFontWithBytes, type FontLoader, type IndicScript } from '@caotang/pdf-fonts';
import { createFontkitShaper, shapeWord, type BrahmicShaper, type ShapedWord } from '@caotang/pdf-fonts/indic-shaper';

import { CidEmbedding, type FontkitFont } from './cid-embedding.js';

/** The Indic fonts' loaders, by script: each is called only when a file holds its script's text. */
export type IndicFontLoaders = Partial<Record<IndicScript, FontLoader>>;

/** What each font's resource, subset tag and PostScript name are in the file, and what the compile log calls it. */
export const INDIC_FONT_INFO: Readonly<Record<IndicScript, { resource: string; tag: string; postscriptName: string; name: string }>> = {
  devanagari: { resource: 'NotoDevanagari', tag: 'CAOTDV', postscriptName: 'NotoSansDevanagari-Regular', name: 'Noto Sans Devanagari' },
  bengali: { resource: 'NotoBengali', tag: 'CAOTBN', postscriptName: 'NotoSansBengali-Regular', name: 'Noto Sans Bengali' },
  gurmukhi: { resource: 'NotoGurmukhi', tag: 'CAOTGM', postscriptName: 'NotoSansGurmukhi-Regular', name: 'Noto Sans Gurmukhi' },
  gujarati: { resource: 'NotoGujarati', tag: 'CAOTGJ', postscriptName: 'NotoSansGujarati-Regular', name: 'Noto Sans Gujarati' },
  oriya: { resource: 'NotoOriya', tag: 'CAOTOR', postscriptName: 'NotoSansOriya-Regular', name: 'Noto Sans Oriya' },
  tamil: { resource: 'NotoTamil', tag: 'CAOTTM', postscriptName: 'NotoSansTamil-Regular', name: 'Noto Sans Tamil' },
  telugu: { resource: 'NotoTelugu', tag: 'CAOTTL', postscriptName: 'NotoSansTelugu-Regular', name: 'Noto Sans Telugu' },
  kannada: { resource: 'NotoKannada', tag: 'CAOTKN', postscriptName: 'NotoSansKannada-Regular', name: 'Noto Sans Kannada' },
  malayalam: { resource: 'NotoMalayalam', tag: 'CAOTML', postscriptName: 'NotoSansMalayalam-Regular', name: 'Noto Sans Malayalam' },
  sinhala: { resource: 'NotoSinhala', tag: 'CAOTSN', postscriptName: 'NotoSansSinhala-Regular', name: 'Noto Sans Sinhala' },
};

/** A script's font, with the shaper that lays a word out in it. */
export class IndicFace {
  private readonly cache = new Map<string, ShapedWord | null>();

  private constructor(
    readonly script: IndicScript,
    readonly font: FontkitFont,
    private readonly shaper: BrahmicShaper,
    private readonly language: string | undefined,
  ) {}

  /** Reads the font through the host's loader and makes the shaper over its bytes. */
  static async load(load: FontLoader, script: IndicScript, language: string | undefined): Promise<IndicFace> {
    const { font, bytes } = await loadFontWithBytes(load, `the ${INDIC_FONT_INFO[script].name} font`);
    return new IndicFace(script, font as unknown as FontkitFont, await createFontkitShaper({ [script]: bytes }), language);
  }

  /** A word shaped, or `null` when the engine cannot shape it (the word is then drawn as "?"). */
  shapeRun(text: string): ShapedWord | null {
    const known = this.cache.get(text);
    if (known !== undefined) return known;
    const word = shapeWord(this.shaper, text, {
      fontId: this.script,
      script: INDIC_SCRIPTS[this.script].tag,
      ...(this.language === undefined ? {} : { lang: this.language }),
    });
    const shaped = word.failed !== undefined || word.glyphs.length === 0 ? null : word;
    this.cache.set(text, shaped);
    return shaped;
  }

  /** The width of a shaped word at a size, in points. */
  widthOf(word: ShapedWord, size: number): number {
    return (word.advance * size) / this.font.unitsPerEm;
  }
}

/** An Indic font as it is embedded in one PDF (cid-embedding.ts). */
export class IndicEmbedding extends CidEmbedding {
  constructor(lib: typeof PdfLib, doc: PdfLib.PDFDocument, readonly face: IndicFace) {
    const info = INDIC_FONT_INFO[face.script];
    super(lib, doc, face.font, {
      resource: info.resource,
      tag: info.tag,
      postscriptName: face.font.postscriptName ?? info.postscriptName,
    });
  }
}
