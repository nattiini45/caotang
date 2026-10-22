/**
 * What the fallback fonts print, known before either font loads, so a PDF can name the characters that print as "?" before it
 * reads a font ([screenplay.md §5.3](../../../docs/architecture/screenplay.md)). The tables are generated from the font files
 * (scripts/cjk-coverage.mjs, scripts/emoji-coverage.mjs, scripts/arabic-hebrew-coverage.mjs), and the tests check them against the files.
 */

import { NOTO_ARABIC_RANGES } from './coverage/noto-arabic-coverage.js';
import { NOTO_CJK_RANGES } from './coverage/noto-cjk-coverage.js';
import { NOTO_EMOJI_RANGES, NOTO_EMOJI_SEQUENCES, NOTO_EMOJI_TONED } from './coverage/noto-emoji-coverage.js';
import { NOTO_HEBREW_RANGES } from './coverage/noto-hebrew-coverage.js';

type Ranges = readonly (readonly [number, number])[];

/** A "gap.length" range table (base 36) decoded to inclusive ranges in code point order. */
function decodeRanges(table: string): Ranges {
  const ranges: [number, number][] = [];
  let end = -1;
  for (const token of table.split(' ')) {
    const [gap, length] = token.split('.').map((part) => parseInt(part, 36)) as [number, number];
    const start = end + 1 + gap;
    end = start + length - 1;
    ranges.push([start, end]);
  }
  return ranges;
}

/** A sequence table (code points in base 36 joined by dots, space-separated) decoded to a set of strings. */
function decodeSequences(table: string): ReadonlySet<string> {
  return new Set(table.split(' ').map((seq) => String.fromCodePoint(...seq.split('.').map((part) => parseInt(part, 36)))));
}

export function inRanges(code: number, ranges: Ranges): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid] as readonly [number, number];
    if (code < range[0]) hi = mid - 1;
    else if (code > range[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

let cjk: Ranges | undefined;
let arabic: Ranges | undefined;
let hebrew: Ranges | undefined;
let emoji: Ranges | undefined;
let sequences: ReadonlySet<string> | undefined;
let toned: ReadonlySet<string> | undefined;

/** Whether the CJK fallback font (Noto Sans Mono CJK SC) has a glyph for a character. */
export function fallbackCovers(ch: string): boolean {
  cjk ??= decodeRanges(NOTO_CJK_RANGES);
  return inRanges(ch.codePointAt(0) ?? 0, cjk);
}

/** Whether Noto Sans Arabic maps a character. */
export function arabicFontMaps(ch: string): boolean {
  arabic ??= decodeRanges(NOTO_ARABIC_RANGES);
  return inRanges(ch.codePointAt(0) ?? 0, arabic);
}

/** Whether Noto Sans Hebrew maps a character. */
export function hebrewFontMaps(ch: string): boolean {
  hebrew ??= decodeRanges(NOTO_HEBREW_RANGES);
  return inRanges(ch.codePointAt(0) ?? 0, hebrew);
}

/** Whether the emoji fallback font (Noto Emoji) maps a code point to a glyph of its own. */
export function emojiFontMaps(ch: string): boolean {
  emoji ??= decodeRanges(NOTO_EMOJI_RANGES);
  return inRanges(ch.codePointAt(0) ?? 0, emoji);
}

/** Whether the emoji font lays out a sequence key (emoji.ts `emojiKey`) as one glyph. */
export function emojiFontHasSequence(key: string): boolean {
  sequences ??= decodeSequences(NOTO_EMOJI_SEQUENCES);
  return sequences.has(key);
}

/** Whether the emoji font lays out a key as one glyph only when its skin-tone modifiers are kept. */
export function emojiFontHasTonedSequence(key: string): boolean {
  toned ??= decodeSequences(NOTO_EMOJI_TONED);
  return toned.has(key);
}
