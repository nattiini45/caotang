/**
 * The Arabic and Hebrew fonts of the contact-sheet PDF ([storyboard.md](../../../docs/architecture/storyboard.md) §6): after
 * Helvetica, before Noto Sans Mono CJK and the emoji font.
 *
 * The fonts are Noto Sans Arabic and Noto Sans Hebrew (OFL-1.1), static TrueType files in `@caotang/font-noto-arabic` and
 * `@caotang/font-noto-hebrew` (vendor/noto-sans-arabic, vendor/noto-sans-hebrew), the files the screenplay PDF embeds too. The host
 * passes a {@link FontLoader} for each, and the emitter calls it only when a sheet holds a character of its script.
 *
 * A word is shaped by the shaper `@caotang/pdf-fonts/shaper` (the joining forms; fontkit 1.1.1 today, and the only module a
 * HarfBuzz backend would replace), as the text without its marks: fontkit cannot be shown to place Arabic tashkeel or Hebrew
 * points as HarfBuzz does, so they are left out of what is drawn (test/fixtures/shaping in `@caotang/pdf-fonts`) and the log
 * counts them. The run is drawn glyph by glyph at the positions the shaper gave, not with pdf-lib's `drawText`, which writes
 * only advances and so drops the offsets of a joined or marked word (cid-embedding.ts `drawPlaced`), inside marked content that
 * carries the run's logical text as `/ActualText`.
 */

import type * as PdfLib from 'pdf-lib';
import { withoutMarks, type RtlScript } from '@caotang/pdf-fonts';
import type { Shape } from '@caotang/pdf-fonts/shaper';
import type { Font } from '@pdf-lib/fontkit';

import { CidEmbedding, type CidGlyph, type FontkitFont } from './cid-embedding.js';

/** A glyph of a shaped run: a CID glyph with its offset from the pen, in font units. */
export interface PlacedGlyph extends CidGlyph {
  readonly dx: number;
  readonly dy: number;
}

/** A shaped run: its glyphs left to right as drawn, and the sum of their advances in font units. */
export interface ShapedWord {
  readonly glyphs: readonly PlacedGlyph[];
  readonly advance: number;
}

/** One script's font, with the shaper that lays a run out in it. */
export class RtlFace {
  private readonly cache = new Map<string, ShapedWord | null>();

  constructor(
    readonly script: RtlScript,
    readonly font: FontkitFont,
    private readonly shape: Shape,
  ) {}

  /**
   * A run shaped without its marks, or `null` when the engine cannot shape it (the run is then drawn as "?"). `direction` is the
   * run's own: `rtl` for a word at an odd bidi level.
   */
  shapeRun(text: string, direction: 'ltr' | 'rtl'): ShapedWord | null {
    const key = `${direction}${text}`;
    const known = this.cache.get(key);
    if (known !== undefined) return known;
    const run = this.shape(withoutMarks(text), this.font as unknown as Font, direction, this.script);
    const word = run.failed !== undefined || run.glyphs.length === 0 ? null : { glyphs: run.glyphs, advance: run.advance };
    this.cache.set(key, word);
    return word;
  }

  /** The width of a shaped run at a size, in points. */
  widthOf(word: ShapedWord, size: number): number {
    return (word.advance * size) / this.font.unitsPerEm;
  }
}

/** An Arabic or Hebrew font as it is embedded in one PDF (cid-embedding.ts). */
export class RtlEmbedding extends CidEmbedding {
  constructor(lib: typeof PdfLib, doc: PdfLib.PDFDocument, readonly face: RtlFace) {
    super(lib, doc, face.font, {
      resource: face.script === 'arabic' ? 'NotoArabic' : 'NotoHebrew',
      tag: face.script === 'arabic' ? 'CAOTAR' : 'CAOTHE',
      postscriptName: face.font.postscriptName ?? (face.script === 'arabic' ? 'NotoSansArabic-Regular' : 'NotoSansHebrew-Regular'),
    });
  }
}
