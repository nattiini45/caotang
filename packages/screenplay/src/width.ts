/**
 * Character widths on the screenplay grid ([screenplay.md §5.3](../../../docs/architecture/screenplay.md)).
 *
 * The grid is Courier at 10 characters to the inch: one column is 7.2 points at 12 points. A character whose Unicode
 * East Asian Width is Wide or Fullwidth (Hanzi, kana, Hangul, the fullwidth forms, CJK punctuation, most emoji) takes
 * two columns. Every other character takes one. An emoji takes two columns too: one grapheme cluster (emoji.ts), however
 * many code points it holds, such as 👨‍👩‍👧 or 🇩🇪, is one unit of the line, two columns wide, and is never split. A character
 * only Noto Emoji prints (a text-style pictograph neither Courier Prime nor the CJK font has) also takes two. The rule reads
 * the text and the fonts' coverage tables, so the layout is known before any font is loaded.
 *
 * A line is measured and broken in units: a code point, as before, or an emoji cluster, or a character with the variation
 * selector after it (U+FE0E, U+FE0F), which adds no width. Text with no emoji and no selector has one unit a code point,
 * so its layout is what it was before emoji.
 *
 * Line breaks: text breaks at white space, as before. Between Chinese or Japanese characters (Han, kana, CJK
 * punctuation, the fullwidth forms) the line may also break with no space, except before a closing mark (`。`, `、`,
 * `」`, small kana, `ー` and the like) and after an opening mark (`「`, `（` and the like). Korean is written with
 * spaces, so Hangul breaks at spaces like Latin text; a Hangul word wider than the column breaks between syllables.
 * A line may break before or after an emoji with no space, as between Hanzi, and never inside one.
 */

import { emojiFontMaps, fallbackCovers, inRanges } from '@caotang/pdf-fonts';
import { isEmojiCluster } from './emoji.js';
import { isPrintable } from './winansi.js';

/** Wide and Fullwidth ranges (UAX #11), inclusive, in code point order. */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x3247],
  [0x3250, 0x4dbf],
  [0x4e00, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff],
  [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

/** The columns one character takes on the grid: 2 for East Asian Wide and Fullwidth, 1 for everything else. */
export function charColumns(ch: string): 1 | 2 {
  return inRanges(ch.codePointAt(0) ?? 0, WIDE) ? 2 : 1;
}

/** Characters that can start or join an emoji cluster, or are a variation selector. Text with none is split by code point. */
const CLUSTERED = /\u200D|\u20E3|[\uFE00-\uFE0F]|[\u{E0020}-\u{E007F}]|\p{Extended_Pictographic}|\p{Emoji_Presentation}/u;

let segmenter: Intl.Segmenter | undefined;

/**
 * A text cut into the units a line is measured and broken in: each emoji cluster whole, each other character on its own
 * with any variation selector after it. Text with no emoji and no selector is cut into its code points.
 */
export function textUnits(text: string): string[] {
  if (!CLUSTERED.test(text)) return [...text];
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const units: string[] = [];
  for (const { segment } of segmenter.segment(text)) {
    if (isEmojiCluster(segment)) {
      units.push(segment);
      continue;
    }
    let first = true;
    for (const ch of segment) {
      const code = ch.codePointAt(0) ?? 0;
      if (!first && code >= 0xfe00 && code <= 0xfe0f) units[units.length - 1] += ch;
      else units.push(ch);
      first = false;
    }
  }
  return units;
}

/**
 * The columns one unit (textUnits) takes: 2 for an emoji, and for a character only Noto Emoji prints; otherwise its
 * character's columns (charColumns). A variation selector adds none.
 */
export function unitColumns(unit: string): 1 | 2 {
  // No emoji starts below U+231A (⌚), so Latin text skips the emoji test.
  if ((unit.length > 1 || unit.charCodeAt(0) >= 0x231a) && isEmojiCluster(unit)) return 2;
  const base = String.fromCodePoint(unit.codePointAt(0) ?? 0);
  if (!isPrintable(base) && !fallbackCovers(base) && emojiFontMaps(base)) return 2;
  return charColumns(base);
}

/** The columns a run of text takes on the grid. For text with no wide character and no emoji this is its length in code points. */
export function textColumns(text: string): number {
  let n = 0;
  for (const unit of textUnits(text)) n += unitColumns(unit);
  return n;
}

/** Hangul: wide, but broken at spaces like Latin text. */
const HANGUL: readonly (readonly [number, number])[] = [
  [0x1100, 0x11ff],
  [0x3130, 0x318f],
  [0xa960, 0xa97f],
  [0xac00, 0xd7ff],
];

/** Whether a line may break before or after this unit with no space: Han, kana, the other wide CJK forms, and emoji. */
function breaksFreely(unit: string): boolean {
  const code = unit.codePointAt(0) ?? 0;
  if (code >= 0xff61 && code <= 0xff9f) return true; // halfwidth katakana and punctuation
  return unitColumns(unit) === 2 && !inRanges(code, HANGUL);
}

/** Marks a line never starts with (kinsoku): closing punctuation, small kana, the prolonged sound mark. */
const NO_BREAK_BEFORE = new Set(
  '、。，．：；？！）］｝〕〉》」』】〙〗〟’”ゝゞヽヾーァィゥェォッャュョヮヵヶぁぃぅぇぉっゃゅょゎ々・…‥｡､｣ﾞﾟ,.:;!?)]}%'.split(''),
);

/** Marks a line never ends with: opening punctuation. */
const NO_BREAK_AFTER = new Set('（［｛〔〈《「『【〘〖〝‘“｢([{'.split(''));

/** Whether a line may break between two adjacent units (textUnits) of one space-free run. */
export function breakBetween(before: string, after: string): boolean {
  if (!breaksFreely(before) && !breaksFreely(after)) return false;
  return !NO_BREAK_BEFORE.has(after) && !NO_BREAK_AFTER.has(before);
}

/** A space-free word cut into the pieces a line may break between. A word with no CJK character and no emoji is one piece. */
export function breakPieces(word: string): string[] {
  const chars = textUnits(word);
  const pieces: string[] = [];
  let current = '';
  chars.forEach((ch, i) => {
    const prev = chars[i - 1];
    if (prev !== undefined && breakBetween(prev, ch)) {
      pieces.push(current);
      current = '';
    }
    current += ch;
  });
  if (current !== '') pieces.push(current);
  return pieces;
}

/** The longest head of a text that fits `width` columns, at least one unit, and the rest. An emoji is never split. */
export function splitColumns(text: string, width: number): readonly [string, string] {
  let cols = 0;
  let head = '';
  for (const ch of textUnits(text)) {
    const c = unitColumns(ch);
    if (head !== '' && cols + c > width) break;
    head += ch;
    cols += c;
  }
  return [head, text.slice(head.length)];
}
