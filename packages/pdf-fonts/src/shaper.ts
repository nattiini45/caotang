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
 * fontkit 1.1.1 does not say which characters a glyph stands for, so the text of each glyph, which a reader copies, is matched
 * here ({@link clusterTexts}) and not read from the engine; the glyphs of marks and joiners that are not drawn are added by
 * {@link withMarkGlyphs}.
 *
 * A failure inside the engine is not a failed export: {@link fontkitShape} reports it as a result with no glyphs and the error
 * in `failed`, and the caller prints the run as "?" and logs it.
 *
 * Like fontkit.ts, this module loads nothing until it is called.
 */

import type { Font, GlyphRun } from '@pdf-lib/fontkit';

import { isRtlMark, withoutMarks, type RtlScript } from './rtl-script.js';

/** One glyph of a shaped run. Advance and offsets are in font units. */
export interface ShapedGlyph {
  readonly id: number;
  /** The distance the pen moves after the glyph. */
  readonly advance: number;
  /** The glyph's offset from the pen, right and up. */
  readonly dx: number;
  readonly dy: number;
  /**
   * The text the glyph stands for, for the ToUnicode map: the character of the cluster it draws, or '' for a glyph that draws part
   * of another's (the positioned dot of an Arabic letter, a zero-width joiner's blank). See {@link clusterTexts}. Its CID is one that pdf.js
   * skips (`CidNumbering`, cid-font.ts).
   */
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

/** A zero-width joiner or non-joiner: it joins or separates letters and draws nothing, and the text keeps it. */
const isJoiner = (ch: string): boolean => ch === '\u200c' || ch === '\u200d';

/** The characters of a text that have a glyph of their own: all but the marks of the scripts and the joiners. */
const lettersOf = (text: string): string[] => [...text].filter((ch) => !isRtlMark(ch) && !isJoiner(ch));

/**
 * The text of each glyph of a shaped run, from the glyph advances (left to right as drawn) and the text that was shaped.
 *
 * fontkit 1.1.1 does not say which characters a glyph stands for: a glyph's `codePoints` come from its shared, cached object,
 * so they are those of the first text the font ever shaped with that glyph (a medial beh that was first a noon is reported as a
 * noon), and the pieces a letter is split into (Noto Sans Arabic draws a dotted letter as a skeleton and a positioned dot) have
 * none. So the characters are matched to the glyphs by the one fact the shaping does keep: a letter has one glyph that advances,
 * and the glyphs that draw part of it or nothing (dots, a joiner's blank) have no advance. The letters, in the order of the
 * text, are the texts of the advancing glyphs in the order of the text (the drawn order reversed for a right-to-left run); the
 * other glyphs have none. A run in which the counts differ (a ligature of the font) is one cluster: the first advancing glyph
 * has the whole text, and the others none, which copies right and never splits a ligature. Marks and joiners are not letters:
 * {@link withMarkGlyphs} puts their text back.
 */
export function clusterTexts(advances: readonly number[], text: string, direction: 'ltr' | 'rtl'): string[] {
  const texts = advances.map(() => '');
  const letters = lettersOf(text);
  const order = advances.map((_, index) => index);
  if (direction === 'rtl') order.reverse();
  const advancing = order.filter((index) => advances[index] !== 0);
  if (advancing.length === letters.length) advancing.forEach((glyph, at) => void (texts[glyph] = letters[at] ?? ''));
  else if (letters.length > 0) texts[advancing[0] ?? order[0] ?? 0] = letters.join('');
  return texts;
}

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
        text: '',
      };
    });
    const texts = clusterTexts(glyphs.map((glyph) => glyph.advance), text, direction);
    const texted = glyphs.map((glyph, index): ShapedGlyph => ({ ...glyph, text: texts[index] ?? '' }));
    return { glyphs: texted, advance: texted.reduce((sum, glyph) => sum + glyph.advance, 0) };
  } catch (error) {
    return { glyphs: [], advance: 0, failed: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * The glyphs of a run shaped without its marks, with the text of the marks and joiners of `source` put back for a reader: each
 * is a glyph of its own that draws nothing (`blank`, a glyph with no outline, advancing 0) and whose ToUnicode text is that
 * character, set where it belongs among the glyphs: after the glyph of the letter before it in the text's logical order, which for
 * a right-to-left run is on its left in the drawn order. One at the start follows nothing and comes first in the logical order.
 * The run is drawn without the marks ({@link withoutMarks}), but what a reader copies keeps them and the joiners, as it did when
 * marked content carried the text; and because each glyph's text is one character, a reader that reverses a right-to-left word
 * character by character puts a mark back after its letter.
 *
 * The texts of the glyphs in logical order (the drawn order reversed for a right-to-left run) are the letters of `source`
 * ({@link clusterTexts}); if they are not, the glyphs come back as they were.
 */
export function withMarkGlyphs(glyphs: readonly ShapedGlyph[], source: string, direction: 'ltr' | 'rtl', blank: number): readonly ShapedGlyph[] {
  const hidden = [...source].filter((ch) => isRtlMark(ch) || isJoiner(ch));
  if (hidden.length === 0) return glyphs;
  const logical = direction === 'rtl' ? [...glyphs].reverse() : [...glyphs];
  if (logical.map((glyph) => glyph.text).join('') !== lettersOf(source).join('')) return glyphs;
  // The logical glyph that owns each letter of the source.
  const owner: number[] = [];
  logical.forEach((glyph, index) => {
    for (let i = 0; i < [...glyph.text].length; i += 1) owner.push(index);
  });
  const hiddenGlyph = (ch: string): ShapedGlyph => ({ id: blank, advance: 0, dx: 0, dy: 0, text: ch });
  const lead: ShapedGlyph[] = [];
  const after = logical.map((): ShapedGlyph[] => []);
  let seen = 0;
  for (const ch of source) {
    if (!isRtlMark(ch) && !isJoiner(ch)) seen += 1;
    else if (seen === 0) lead.push(hiddenGlyph(ch));
    else after[owner[seen - 1] ?? 0]?.push(hiddenGlyph(ch));
  }
  const inLogicalOrder = [...lead, ...logical.flatMap((glyph, index) => [glyph, ...(after[index] ?? [])])];
  return direction === 'rtl' ? inLogicalOrder.reverse() : inLogicalOrder;
}

/**
 * An engine that takes a text with its marks. The marks are left out of what the engine shapes (it cannot be shown to place them
 * as HarfBuzz does, and fontkit 1.1.1 throws on some) and come back as glyphs that draw nothing and carry their text
 * ({@link withMarkGlyphs}); the advance is the bare text's. A host that cannot import this module before it is needed (the
 * contact sheet's emitter loads the shaper on demand) gets the marks' text through the one function it is handed.
 */
export function shapeKeepingMarks(shape: Shape): Shape {
  return (text, font, direction, script) => {
    const run = shape(withoutMarks(text), font, direction, script);
    return run.failed === undefined && run.glyphs.length > 0 ? { ...run, glyphs: withMarkGlyphs(run.glyphs, text, direction, blankGlyphOf(font)) } : run;
  };
}

/** The id of the glyph a font draws for a space: empty, so the glyph of a mark can borrow it ({@link withMarkGlyphs}). */
export function blankGlyphOf(font: Font): number {
  return font.glyphForCodePoint(0x20).id;
}
