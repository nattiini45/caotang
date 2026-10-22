/**
 * The Unicode Bidirectional Algorithm (UAX #9) for the lines of both PDFs
 * ([screenplay.md §5.3](../../../docs/architecture/screenplay.md)): a paragraph's direction, the embedding levels of a line,
 * its reordering into visual order (rules L1 and L2) and the mirroring of brackets (L4). The levels come from `bidi-js`
 * 1.1.0; the reordering of runs is done here, so one function orders code points (the conformance test) and runs (the PDFs).
 *
 * This module is not in the package index: it holds `bidi-js`, which only a document with Arabic or Hebrew text needs.
 * Import it as `@caotang/pdf-fonts/bidi`.
 *
 * What a line is drawn as is {@link visualRuns}: runs in visual order, left to right as drawn. The text of a run of letters of
 * the Arabic or Hebrew font stays in logical order, because the shaper reverses it; every other run is written out in visual
 * order already, with its brackets mirrored when its level is odd. The line is resolved on its own with the paragraph's base
 * direction, so an embedding or isolate that spans two lines of one paragraph is resolved on each line: a screenplay's lines
 * hold none, and the base direction, which is the part that matters, is the paragraph's.
 */

import bidiFactory, { type Bidi } from 'bidi-js';

import { graphemesOf } from './emoji.js';
import { isBidiControl, rtlFontPrints, rtlRunKind, type RtlScript } from './rtl-script.js';

export type Direction = 'ltr' | 'rtl';

let engine: Bidi | undefined;
const bidi = (): Bidi => (engine ??= bidiFactory());

/**
 * The direction of a paragraph from its first strong character (rules P2 and P3): right to left for Hebrew, Arabic and the
 * other R and AL letters, left to right for any L letter, skipping what an isolate holds. A paragraph with no strong
 * character takes `neutral`, which is the project's language direction (`languageDirection`).
 */
export function paragraphDirection(text: string, neutral: Direction = 'ltr'): Direction {
  const engineOf = bidi();
  let isolates = 0;
  for (const ch of text) {
    const type = engineOf.getBidiCharTypeName(ch);
    if (type === 'LRI' || type === 'RLI' || type === 'FSI') isolates += 1;
    else if (type === 'PDI') isolates = Math.max(0, isolates - 1);
    else if (isolates === 0 && type === 'L') return 'ltr';
    else if (isolates === 0 && (type === 'R' || type === 'AL')) return 'rtl';
  }
  return neutral;
}

/** The languages written right to left: Arabic, Persian, Urdu, Hebrew and Yiddish (BCP 47 primary subtags). */
const RTL_LANGUAGES: ReadonlySet<string> = new Set(['ar', 'fa', 'ur', 'he', 'yi']);

/** The direction a language is written in, from its tag (`ar`, `he-IL`, `fa_IR`): `rtl` for the languages above, `ltr` for the rest and for no language. */
export function languageDirection(language: string | undefined): Direction {
  const primary = (language ?? '').trim().toLowerCase().split(/[-_]/, 1)[0] ?? '';
  return RTL_LANGUAGES.has(primary) ? 'rtl' : 'ltr';
}

/** The resolved levels of a text, one for each code point, and the level of its paragraph. */
export interface Levels {
  readonly levels: readonly number[];
  readonly paragraphLevel: number;
}

/**
 * A character of each bidi class that is outside the Basic Multilingual Plane (an emoji is ON, a Phoenician letter R, an
 * Adlam letter AL), and a character of the plane to stand for it. bidi-js reads a string by UTF-16 unit and takes an unknown
 * unit for a strong L, so a pair of surrogates would be a strong left-to-right letter: the text it is given has one unit
 * for each code point, of the class the code point has.
 */
const STAND_IN: Readonly<Record<string, string>> = {
  L: 'a',
  R: '\u05d0',
  AL: '\u0627',
  EN: '0',
  ES: '+',
  ET: '$',
  AN: '\u0660',
  CS: ',',
  NSM: '\u0300',
  BN: '\u00ad',
  ON: '!',
};

function oneUnitEach(text: string): string {
  let out = '';
  for (const ch of text) out += ch.length === 1 ? ch : (STAND_IN[bidi().getBidiCharTypeName(ch)] ?? 'a');
  return out;
}

/**
 * The embedding levels of a text, one for each code point (UAX #9 rules P through I, and L1). `base` forces the paragraph's
 * direction; `auto` takes it from the first strong character.
 */
export function embeddingLevels(text: string, base: Direction | 'auto' = 'auto'): Levels {
  const result = bidi().getEmbeddingLevels(oneUnitEach(text), base === 'auto' ? undefined : base);
  return { levels: Array.from(result.levels), paragraphLevel: result.paragraphs[0]?.level ?? 0 };
}

/**
 * Rule L2: the order the items of a line are drawn in. From the highest level to the lowest odd level, every contiguous
 * sequence of items at that level or higher is reversed. `order[v]` is the logical index of the item at visual position `v`.
 * Rule L1 is already in the levels (a line's trailing white space is at the paragraph's level).
 */
export function visualOrder(levels: readonly number[]): number[] {
  const order = levels.map((_, index) => index);
  let highest = 0;
  let lowestOdd = Infinity;
  for (const level of levels) {
    highest = Math.max(highest, level);
    lowestOdd = Math.min(lowestOdd, level | 1);
  }
  for (let level = highest; level >= lowestOdd; level -= 1) {
    for (let i = 0; i < order.length; i += 1) {
      if ((levels[order[i] as number] as number) < level) continue;
      let end = i;
      while (end + 1 < order.length && (levels[order[end + 1] as number] as number) >= level) end += 1;
      for (let lo = i, hi = end; lo < hi; lo += 1, hi -= 1) [order[lo], order[hi]] = [order[hi] as number, order[lo] as number];
      i = end;
    }
  }
  return order;
}

/** The mirror image of a bracket or other mirrored character (rule L4), or the character itself. */
export function mirrored(ch: string): string {
  return bidi().getMirroredCharacter(ch) ?? ch;
}

/** One run of a line, in visual order. */
export interface VisualRun {
  /**
   * What `kind` `letters` and `single` hold: the run's text in logical order (the shaper reverses a right-to-left run). What
   * `other` holds: the text left to right as drawn, brackets mirrored where the level is odd.
   */
  readonly text: string;
  /** The run's text in logical order, whatever `text` holds: what a reader copies. */
  readonly source: string;
  /** The run's place among the line's runs in logical order, from 0. */
  readonly order: number;
  readonly level: number;
  /** `letters`: a word of the Arabic or Hebrew font, `single`: one other character of it, `other`: everything else (Courier Prime, CJK, emoji). */
  readonly kind: 'letters' | 'single' | 'other';
  /** The font of a `letters` or `single` run. */
  readonly script?: RtlScript;
}

/**
 * A line cut into the runs it is drawn as, left to right (see the header). The bidirectional control characters print
 * nothing and are not in any run.
 */
export function visualRuns(text: string, base: Direction): VisualRun[] {
  const clusters = graphemesOf(text);
  const { levels } = embeddingLevels(text, base);
  const logical: { run: VisualRun; clusters: string[] }[] = [];
  // A cluster is one code point or more; its level is its first code point's.
  let codePoint = 0;
  for (const cluster of clusters) {
    const level = levels[codePoint] ?? 0;
    codePoint += Array.from(cluster).length;
    if (isBidiControl(cluster)) continue;
    const kind = rtlRunKind(cluster) ?? 'other';
    const script = kind === 'other' ? undefined : rtlFontPrints(cluster);
    const last = logical[logical.length - 1];
    if (last !== undefined && kind !== 'single' && last.run.kind === kind && last.run.level === level && last.run.script === script) {
      last.clusters.push(cluster);
    } else {
      logical.push({ run: { text: '', source: '', order: logical.length, level, kind, ...(script === undefined ? {} : { script }) }, clusters: [cluster] });
    }
  }
  return visualOrder(logical.map(({ run }) => run.level)).map((position) => {
    const { run, clusters: held } = logical[position] as (typeof logical)[number];
    const source = held.join('');
    if (run.kind !== 'other') return { ...run, text: source, source };
    // The characters of a right-to-left run are written in visual order, and a bracket in it is turned (L4).
    const ordered = run.level % 2 === 1 ? held.map((cluster) => (cluster.length <= 2 ? mirrored(cluster) : cluster)).reverse() : held;
    return { ...run, text: ordered.join(''), source };
  });
}
