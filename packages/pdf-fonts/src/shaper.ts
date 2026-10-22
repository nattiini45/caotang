/**
 * Shaping a run of Arabic or Hebrew text into glyphs ([screenplay.md §5.3](../../../docs/architecture/screenplay.md)): which
 * glyph of the font draws each part of the text (the joining forms, the lam-alef ligatures), how far each advances, and where
 * it is placed. The PDFs call {@link Shape} and nothing else of the engine, so a backend that shapes with HarfBuzz can replace
 * {@link fontkitShape} by replacing this one module.
 *
 * The backend is `@pdf-lib/fontkit` 1.1.1, the version pinned for subsetting (not fontkit 2.x, which throws on Arabic with
 * harakat). A scratch comparison with HarfBuzz 1.6.3 on the vendored fonts (scripts/shaping-spike.mjs, with its result in
 * test/fixtures/shaping/) found the glyphs, advances and offsets of unmarked Arabic and Hebrew identical, and those of runs with
 * marks different in about half the samples (one throws). The caller therefore shapes a text without its marks
 * (rtl-script.ts `withoutMarks`).
 *
 * A failure inside the engine is not a failed export: {@link fontkitShape} reports it as a result with no glyphs and the error
 * in `failed`, and the caller prints the run as "?" and logs it.
 *
 * Like fontkit.ts, this module loads nothing until it is called.
 */

import type { Font, GlyphRun } from '@pdf-lib/fontkit';

import type { RtlScript } from './rtl-script.js';

/** One glyph of a shaped run. Advance and offsets are in font units. */
export interface ShapedGlyph {
  readonly id: number;
  /** The distance the pen moves after the glyph. */
  readonly advance: number;
  /** The glyph's offset from the pen, right and up. */
  readonly dx: number;
  readonly dy: number;
  /** The text the glyph stands for: the code points it came from, for the ToUnicode map. */
  readonly text: string;
}

/** A shaped run: its glyphs from left to right as drawn, whatever the direction of the text. */
export interface ShapedRun {
  readonly glyphs: readonly ShapedGlyph[];
  /** The sum of the glyphs' advances, in font units. */
  readonly advance: number;
  /** Why the engine could not shape the text; the run then has no glyphs. */
  readonly failed?: string;
}

/** `font.layout` takes the script, language and direction too (fontkit 1.1.1, Font#layout), which its typings leave out. */
interface ScriptedLayout {
  layout(text: string, features: undefined, script: string, language: string, direction: 'ltr' | 'rtl'): GlyphRun;
}

/** The OpenType tags of the scripts, as the engine lays them out. */
const SCRIPT_TAGS: Readonly<Record<RtlScript, { readonly script: string; readonly language: string }>> = {
  arabic: { script: 'arab', language: 'ar' },
  hebrew: { script: 'hebr', language: 'he' },
};

/**
 * Shapes `text` in `font`. `direction` is the run's own: `rtl` for a word of Arabic or Hebrew in a right-to-left level. The
 * glyphs come back in visual order, left to right.
 */
export type Shape = (text: string, font: Font, direction: 'ltr' | 'rtl', script: RtlScript) => ShapedRun;

export const fontkitShape: Shape = (text, font, direction, script) => {
  const tags = SCRIPT_TAGS[script];
  try {
    const run = (font as unknown as ScriptedLayout).layout(text, undefined, tags.script, tags.language, direction);
    const glyphs = run.glyphs.map((glyph, index): ShapedGlyph => {
      const position = run.positions[index];
      return {
        id: glyph.id,
        advance: position?.xAdvance ?? glyph.advanceWidth,
        dx: position?.xOffset ?? 0,
        dy: position?.yOffset ?? 0,
        text: String.fromCodePoint(...glyph.codePoints),
      };
    });
    return { glyphs, advance: glyphs.reduce((sum, glyph) => sum + glyph.advance, 0) };
  } catch (error) {
    return { glyphs: [], advance: 0, failed: error instanceof Error ? error.message : String(error) };
  }
};
