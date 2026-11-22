/**
 * What the fallback fonts print, known before either font loads, so a PDF can name the characters that print as "?" before it
 * reads a font ([screenplay.md §5.3](../../../docs/architecture/screenplay.md)). The tables are generated from the font files
 * (scripts/cjk-coverage.mjs, scripts/emoji-coverage.mjs, scripts/script-font-coverage.mjs: Arabic, Hebrew, Devanagari), and the tests check them against the files.
 */

import { NOTO_ARABIC_RANGES } from './coverage/noto-arabic-coverage.js';
import { NOTO_BENGALI_RANGES } from './coverage/noto-bengali-coverage.js';
import { NOTO_DEVANAGARI_RANGES } from './coverage/noto-devanagari-coverage.js';
import { NOTO_GURMUKHI_RANGES } from './coverage/noto-gurmukhi-coverage.js';
import { NOTO_GUJARATI_RANGES } from './coverage/noto-gujarati-coverage.js';
import { NOTO_KANNADA_RANGES } from './coverage/noto-kannada-coverage.js';
import { NOTO_MALAYALAM_RANGES } from './coverage/noto-malayalam-coverage.js';
import { NOTO_ORIYA_RANGES } from './coverage/noto-oriya-coverage.js';
import { NOTO_SINHALA_RANGES } from './coverage/noto-sinhala-coverage.js';
import { NOTO_TAMIL_RANGES } from './coverage/noto-tamil-coverage.js';
import { NOTO_TELUGU_RANGES } from './coverage/noto-telugu-coverage.js';
import { NOTO_CJK_RANGES } from './coverage/noto-cjk-coverage.js';
import { NOTO_EMOJI_LAYOUT, NOTO_EMOJI_RANGES, NOTO_EMOJI_SEQUENCES, NOTO_EMOJI_TONED } from './coverage/noto-emoji-coverage.js';
import { NOTO_HEBREW_RANGES } from './coverage/noto-hebrew-coverage.js';

export type Ranges = readonly (readonly [number, number])[];

/** A "gap.length" range table (base 36) decoded to inclusive ranges in code point order. */
export function decodeRanges(table: string): Ranges {
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
let layout: ReadonlyMap<string, number> | undefined;

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

/** The Noto script-font tables, by Indic script. */
const INDIC_TABLES = {
  devanagari: NOTO_DEVANAGARI_RANGES,
  bengali: NOTO_BENGALI_RANGES,
  gurmukhi: NOTO_GURMUKHI_RANGES,
  gujarati: NOTO_GUJARATI_RANGES,
  oriya: NOTO_ORIYA_RANGES,
  tamil: NOTO_TAMIL_RANGES,
  telugu: NOTO_TELUGU_RANGES,
  kannada: NOTO_KANNADA_RANGES,
  malayalam: NOTO_MALAYALAM_RANGES,
  sinhala: NOTO_SINHALA_RANGES,
} as const;

/** The Indic scripts a font covers. */
export type IndicScriptName = keyof typeof INDIC_TABLES;

const indicDecoded = new Map<string, Ranges>();

/** Whether the font of an Indic script maps a character. */
export function indicFontMaps(script: IndicScriptName, ch: string): boolean {
  let ranges = indicDecoded.get(script);
  if (ranges === undefined) {
    ranges = decodeRanges(INDIC_TABLES[script]);
    indicDecoded.set(script, ranges);
  }
  return inRanges(ch.codePointAt(0) ?? 0, ranges);
}

/** Whether Noto Sans Devanagari maps a character. */
export function devanagariFontMaps(ch: string): boolean {
  return indicFontMaps('devanagari', ch);
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

/** The glyph the emoji font draws for a sequence key (emoji.ts `emojiKey`) that fontkit lays out as more than one glyph, or undefined. */
export function emojiFontLayoutGlyph(key: string): number | undefined {
  layout ??= new Map(
    NOTO_EMOJI_LAYOUT.split(' ').map((entry): [string, number] => {
      const [seq = '', glyph = ''] = entry.split('=');
      return [String.fromCodePoint(...seq.split('.').map((part) => parseInt(part, 36))), parseInt(glyph, 36)];
    }),
  );
  return layout.get(key);
}
