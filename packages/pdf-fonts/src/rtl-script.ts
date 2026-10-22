/**
 * Which characters the Arabic and Hebrew fonts print, and how a line of such text is cut into runs
 * ([screenplay.md §5.3](../../../docs/architecture/screenplay.md)). Pure, and known before either font loads.
 *
 * A character belongs to the Arabic font when it lies in an Arabic block and the font maps it, and to the Hebrew font when it
 * lies in the Hebrew block or the Hebrew presentation forms and that font maps it. Two kinds of character make a run:
 *
 * - `letters`: a letter, with its marks and any joiner (ZWNJ, ZWJ) that follows it. A run is the unit that is shaped, and so the
 *   unit whose width is snapped to whole Courier columns: consecutive letters of one font, which in practice is one word.
 * - `single`: any other character of the script (a digit, a comma, a question mark, a full stop). Each is a run of its own, so
 *   a run never mixes characters of different bidi levels.
 *
 * A mark (Unicode category Mn) is not drawn: fontkit 1.1.1 cannot be shown to place Arabic tashkeel or Hebrew points as
 * HarfBuzz does (test/fixtures/shaping/README.md), so they are left out of the drawn run and named in the compile log. The
 * text a reader copies keeps them: each is a glyph of its own that draws nothing, with the mark as its ToUnicode text
 * (shaper.ts `withMarkGlyphs`).
 */

import { arabicFontMaps, hebrewFontMaps } from './coverage.js';

export type RtlScript = 'arabic' | 'hebrew';

/** Arabic blocks: Arabic, Arabic Supplement, Arabic Extended-B and -A, and the two presentation forms. */
const ARABIC_BLOCKS: readonly (readonly [number, number])[] = [
  [0x0600, 0x06ff],
  [0x0750, 0x077f],
  [0x0870, 0x08ff],
  [0xfb50, 0xfdff],
  [0xfe70, 0xfeff],
];

/** The Hebrew block, and the Hebrew presentation forms. */
const HEBREW_BLOCKS: readonly (readonly [number, number])[] = [
  [0x0590, 0x05ff],
  [0xfb1d, 0xfb4f],
];

const within = (code: number, blocks: readonly (readonly [number, number])[]): boolean => blocks.some(([lo, hi]) => code >= lo && code <= hi);

/** The script whose block holds a code point, or undefined. Whether the font has a glyph is {@link rtlFontPrints}. */
export function rtlScriptOf(code: number): RtlScript | undefined {
  if (within(code, ARABIC_BLOCKS)) return 'arabic';
  if (within(code, HEBREW_BLOCKS)) return 'hebrew';
  return undefined;
}

/** Whether a text holds a character of an Arabic or Hebrew block: the cheap test that decides whether anything here applies. */
const RTL_BLOCK = /[\u0590-\u05ff\u0600-\u06ff\u0750-\u077f\u0870-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;

export function hasRtlScript(text: string): boolean {
  return RTL_BLOCK.test(text);
}

/** Whether the font of a script has a glyph for a character. */
export function rtlFontMaps(script: RtlScript, ch: string): boolean {
  return script === 'arabic' ? arabicFontMaps(ch) : hebrewFontMaps(ch);
}

/** The script of a character the Arabic or Hebrew font prints, or undefined when it lies outside both blocks or the font has no glyph. */
export function rtlFontPrints(ch: string): RtlScript | undefined {
  const script = rtlScriptOf(ch.codePointAt(0) ?? 0);
  return script !== undefined && rtlFontMaps(script, ch) ? script : undefined;
}

const MARK = /^\p{Mn}/u;

/** Whether a character is a combining mark of the scripts: left out of the drawn run (see the header). */
export function isRtlMark(ch: string): boolean {
  return MARK.test(ch) && rtlScriptOf(ch.codePointAt(0) ?? 0) !== undefined;
}

/** A text without its marks: the text that is shaped and measured. */
export function withoutMarks(text: string): string {
  let out = '';
  for (const ch of text) if (!isRtlMark(ch)) out += ch;
  return out;
}

/** How many marks a text holds. */
export function countMarks(text: string): number {
  let n = 0;
  for (const ch of text) if (isRtlMark(ch)) n += 1;
  return n;
}

const LETTER = /^[\p{L}\p{M}]/u;

/**
 * The kind of a grapheme cluster that starts with a character of the Arabic or Hebrew font: `letters` for a letter or a mark,
 * `single` for the rest (digits, punctuation). A cluster the fonts do not print has no kind.
 */
export function rtlRunKind(cluster: string): 'letters' | 'single' | undefined {
  if (rtlFontPrints(cluster) === undefined) return undefined;
  return LETTER.test(cluster) ? 'letters' : 'single';
}

/** The characters that steer the bidirectional algorithm and print nothing: LRM, RLM, ALM, the embeddings, overrides and isolates. */
const ANY_BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const BIDI_CONTROL = /^[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

export function isBidiControl(cluster: string): boolean {
  return BIDI_CONTROL.test(cluster);
}

/** Whether a text holds a bidirectional control character anywhere. */
export function hasBidiControl(text: string): boolean {
  return ANY_BIDI_CONTROL.test(text);
}

/** Whether a text needs the bidirectional algorithm at all: it holds a character of Arabic or Hebrew, or a control character. */
export function needsBidi(text: string): boolean {
  return hasRtlScript(text) || hasBidiControl(text);
}

/**
 * A text cut into runs by script: each element is a run of `letters` of one font, a `single` character of a font, or the text
 * between them (`script` undefined). `clusters` are the text's grapheme clusters (emoji.ts `graphemesOf`).
 */
export interface ScriptRun {
  readonly script: RtlScript | undefined;
  readonly kind: 'letters' | 'single' | 'other';
  readonly text: string;
}

export function scriptRuns(clusters: readonly string[]): ScriptRun[] {
  const runs: { script: RtlScript | undefined; kind: 'letters' | 'single' | 'other'; text: string }[] = [];
  for (const cluster of clusters) {
    const kind = rtlRunKind(cluster) ?? 'other';
    const script = kind === 'other' ? undefined : rtlFontPrints(cluster);
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === kind && last.script === script && kind !== 'single') last.text += cluster;
    else runs.push({ script, kind, text: cluster });
  }
  return runs;
}
