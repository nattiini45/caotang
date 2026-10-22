/**
 * Brahmic text in the two PDFs ([screenplay.md §5.3](../../../docs/architecture/screenplay.md)): which characters the Devanagari
 * font prints, and how Indic text is cut into the units a line is measured, broken and cut in. Pure, and known before the font loads.
 *
 * A unit of Brahmic text is an extended grapheme cluster: a consonant with its virama-joined consonants, its vowel signs, its
 * nukta and its other marks (क्ष, त्रि, न्दी, क़), never a bare code point, so a line never splits a consonant from its virama
 * or a vowel sign from its consonant. `Intl.Segmenter` finds the clusters; Unicode 15.1 added the rule that keeps a conjunct whole
 * (GB9c), and an older engine lacks it, so {@link joinConjuncts} joins a cluster that ends in a virama to the consonant after it
 * whatever the engine knows. Correctness never rests on the engine's rule. Text without a Brahmic character is not touched.
 *
 * Only Devanagari has a font. Another Brahmic script (Bengali, Tamil, ...) is cut into clusters too, and still prints as "?".
 */

import { devanagariFontMaps, inRanges } from './coverage.js';
import { graphemesOf } from './emoji.js';
import type { RtlScript } from './rtl-script.js';

/** The scripts that are shaped glyph by glyph in a font of their own: Arabic and Hebrew, and Devanagari. */
export type ShapedScript = RtlScript | 'devanagari';

/** Devanagari, Devanagari Extended, and the Vedic Extensions that the Devanagari font may map. */
const DEVANAGARI_BLOCKS: readonly (readonly [number, number])[] = [
  [0x0900, 0x097f],
  [0x1cd0, 0x1cff],
  [0xa8e0, 0xa8ff],
];

/** Any Brahmic script with its own block between Devanagari and Sinhala, and the Devanagari Extended and Vedic blocks. */
// eslint-disable-next-line no-misleading-character-class -- block ranges: the combining marks at their ends are meant
const BRAHMIC = /[\u0900-\u0dff\u1cd0-\u1cff\ua8e0-\ua8ff]/;
// eslint-disable-next-line no-misleading-character-class -- block ranges: the combining marks at their ends are meant
const DEVANAGARI = /[\u0900-\u097f\u1cd0-\u1cff\ua8e0-\ua8ff]/;

/** Whether a text holds a character of a Brahmic block: the cheap test that decides whether anything here applies. */
export function hasBrahmic(text: string): boolean {
  return BRAHMIC.test(text);
}

/** Whether a code point lies in a Brahmic block. */
export function isBrahmic(code: number): boolean {
  return (code >= 0x0900 && code <= 0x0dff) || (code >= 0x1cd0 && code <= 0x1cff) || (code >= 0xa8e0 && code <= 0xa8ff);
}

/** Whether a text holds a character of a Devanagari block. */
export function hasDevanagari(text: string): boolean {
  return DEVANAGARI.test(text);
}

/** Whether a character lies in a Devanagari block and the font has a glyph for it. */
export function devanagariFontPrints(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return inRanges(code, DEVANAGARI_BLOCKS) && devanagariFontMaps(ch);
}

/** The viramas (halants) of the Brahmic scripts: the sign that joins the consonant before it to the one after. */
const VIRAMAS = new Set([0x094d, 0x09cd, 0x0a4d, 0x0acd, 0x0b4d, 0x0bcd, 0x0c4d, 0x0ccd, 0x0d4d, 0x0dca]);

const ZERO_WIDTH_JOINERS = new Set([0x200c, 0x200d]);

/** Whether a cluster ends in a virama, with any joiner after it. */
function endsInVirama(cluster: string): boolean {
  const codes = Array.from(cluster, (ch) => ch.codePointAt(0) ?? 0);
  let last = codes.length - 1;
  while (last > 0 && ZERO_WIDTH_JOINERS.has(codes[last] ?? 0)) last -= 1;
  return VIRAMAS.has(codes[last] ?? 0);
}

const LETTER = /^\p{Lo}/u;

/**
 * Clusters with the conjuncts joined: a cluster that ends in a virama and the cluster after it, when that begins with a Brahmic
 * letter, are one (the rule of UAX #29 GB9c, applied here so an engine without it gives the same units).
 */
export function joinConjuncts(clusters: readonly string[]): string[] {
  const out: string[] = [];
  for (const cluster of clusters) {
    const last = out[out.length - 1];
    if (last !== undefined && endsInVirama(last) && LETTER.test(cluster) && isBrahmic(cluster.codePointAt(0) ?? 0)) out[out.length - 1] = last + cluster;
    else out.push(cluster);
  }
  return out;
}

/** The grapheme clusters of a text, with the conjuncts of Brahmic text whole. Text without a Brahmic character is cut as `graphemesOf` cuts it. */
export function clustersOf(text: string): string[] {
  const clusters = graphemesOf(text);
  return hasBrahmic(text) ? joinConjuncts(clusters) : clusters;
}

/** A text cut into runs by font: a run of `letters` the Devanagari font prints, or the `other` text between them. */
export interface DevanagariRun {
  readonly kind: 'letters' | 'other';
  readonly text: string;
}

/** Whether a unit is drawn by the Devanagari font: it begins with a character that font prints. */
export function isDevanagariUnit(unit: string): boolean {
  return devanagariFontPrints(String.fromCodePoint(unit.codePointAt(0) ?? 0));
}

/**
 * Units (clusters) cut into runs: consecutive units the Devanagari font prints are one run, which is the unit that is shaped
 * and whose width is snapped to whole Courier columns. In practice a run is a word.
 */
export function devanagariRuns(units: readonly string[]): DevanagariRun[] {
  const runs: { kind: 'letters' | 'other'; text: string }[] = [];
  for (const unit of units) {
    const kind = isDevanagariUnit(unit) ? 'letters' : 'other';
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === kind) last.text += unit;
    else runs.push({ kind, text: unit });
  }
  return runs;
}

const MARK = /^\p{M}/u;

/** Whether a unit begins with a combining mark (an orphan one: a mark with no consonant before it) in a Brahmic block. */
export function startsWithBrahmicMark(unit: string): boolean {
  return MARK.test(unit) && isBrahmic(unit.codePointAt(0) ?? 0);
}
