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
 * Every Brahmic script has a font. A script the text holds that has no loader still prints as "?".
 */

import { indicFontMaps, inRanges, type IndicScriptName, type Ranges } from './coverage.js';
import { graphemesOf } from './emoji.js';
import type { RtlScript } from './rtl-script.js';

/** The Indic scripts a font covers: Devanagari and the nine that follow it in the Brahmic block run. */
export type IndicScript = IndicScriptName;

/** The scripts that are shaped glyph by glyph in a font of their own: Arabic and Hebrew, and the Indic scripts. */
export type ShapedScript = RtlScript | IndicScript;

/** The Unicode blocks of each Indic script a font prints, and the OpenType script tag it is shaped under. */
export const INDIC_SCRIPTS: Readonly<Record<IndicScript, { readonly blocks: Ranges; readonly tag: string }>> = {
  devanagari: { blocks: [[0x0900, 0x097f], [0x1cd0, 0x1cff], [0xa8e0, 0xa8ff]], tag: 'deva' },
  bengali: { blocks: [[0x0980, 0x09ff]], tag: 'beng' },
  gurmukhi: { blocks: [[0x0a00, 0x0a7f]], tag: 'guru' },
  gujarati: { blocks: [[0x0a80, 0x0aff]], tag: 'gujr' },
  oriya: { blocks: [[0x0b00, 0x0b7f]], tag: 'orya' },
  tamil: { blocks: [[0x0b80, 0x0bff]], tag: 'taml' },
  telugu: { blocks: [[0x0c00, 0x0c7f]], tag: 'telu' },
  kannada: { blocks: [[0x0c80, 0x0cff]], tag: 'knda' },
  malayalam: { blocks: [[0x0d00, 0x0d7f]], tag: 'mlym' },
  sinhala: { blocks: [[0x0d80, 0x0dff]], tag: 'sinh' },
};

/** The Indic scripts in the order their fonts are embedded. */
export const INDIC_SCRIPT_NAMES: readonly IndicScript[] = Object.keys(INDIC_SCRIPTS) as IndicScript[];

/** Devanagari, Devanagari Extended, and the Vedic Extensions that the Devanagari font may map. */
const DEVANAGARI_BLOCKS = INDIC_SCRIPTS.devanagari.blocks;

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

/** The Indic script of a code point, or undefined when it lies in no Indic block. */
export function indicScriptOf(code: number): IndicScript | undefined {
  for (const script of INDIC_SCRIPT_NAMES) {
    if (inRanges(code, INDIC_SCRIPTS[script].blocks)) return script;
  }
  return undefined;
}

/** The Indic script whose block holds a character and whose font maps it, or undefined. */
export function indicFontPrints(ch: string): IndicScript | undefined {
  const script = indicScriptOf(ch.codePointAt(0) ?? 0);
  return script !== undefined && indicFontMaps(script, ch) ? script : undefined;
}

/** Whether a character lies in a Devanagari block and the font has a glyph for it. */
export function devanagariFontPrints(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return inRanges(code, DEVANAGARI_BLOCKS) && indicFontMaps('devanagari', ch);
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

/** A text cut into runs by font: a run of `letters` one Indic font prints, or the `other` text between them. */
export interface IndicRun {
  readonly kind: 'letters' | 'other';
  /** The script a `letters` run is shaped in. */
  readonly script?: IndicScript;
  readonly text: string;
}

/** Compatibility alias for the run a compile of Devanagari-only text produced. */
export type DevanagariRun = IndicRun;

/** Whether a unit is drawn by the Devanagari font: it begins with a character that font prints. */
export function isDevanagariUnit(unit: string): boolean {
  return devanagariFontPrints(String.fromCodePoint(unit.codePointAt(0) ?? 0));
}

/** The Indic script of a unit: it begins with a character that font prints. */
export function indicUnitScript(unit: string): IndicScript | undefined {
  return indicFontPrints(String.fromCodePoint(unit.codePointAt(0) ?? 0));
}

/**
 * Units (clusters) cut into runs: consecutive units the same Indic font prints are one run, which is the unit that is
 * shaped and whose width is snapped to whole Courier columns. In practice a run is a word.
 */
export function indicRuns(units: readonly string[]): IndicRun[] {
  const runs: { kind: 'letters' | 'other'; script?: IndicScript; text: string }[] = [];
  for (const unit of units) {
    const script = indicUnitScript(unit);
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === (script === undefined ? 'other' : 'letters') && last.script === script) {
      last.text += unit;
    } else if (script === undefined) {
      runs.push({ kind: 'other', text: unit });
    } else {
      runs.push({ kind: 'letters', script, text: unit });
    }
  }
  return runs;
}

/**
 * Units (clusters) cut into runs: consecutive units the Devanagari font prints are one run, which is the unit that is shaped
 * and whose width is snapped to whole Courier columns. In practice a run is a word.
 */
export function devanagariRuns(units: readonly string[]): IndicRun[] {
  return indicRuns(units);
}

const MARK = /^\p{M}/u;

/** Whether a unit begins with a combining mark (an orphan one: a mark with no consonant before it) in a Brahmic block. */
export function startsWithBrahmicMark(unit: string): boolean {
  return MARK.test(unit) && isBrahmic(unit.codePointAt(0) ?? 0);
}
