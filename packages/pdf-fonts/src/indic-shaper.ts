// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- the package ships no types; this file declares the part read, and a file that imports this one needs the declaration too
/// <reference path="./fontkit-2.d.ts" />
/**
 * Shaping a run of Indic text into glyphs ([screenplay.md §5.3](../../../docs/architecture/screenplay.md)): the conjuncts, the
 * vowel sign that is typed after its consonant and drawn before it, reph, and the stacked marks, which a font draws only through
 * GSUB and GPOS. The PDFs call {@link BrahmicShaper.shape} and nothing else of the engine, so a HarfBuzz backend can replace
 * {@link createFontkitShaper} by replacing this one module.
 *
 * The backend is upstream `fontkit` 2.0.4, exact-pinned, loaded by a dynamic `import()` only for a document that holds Indic text.
 * It is not `@pdf-lib/fontkit` 1.1.1, which cuts the subsets and whose Indic shaper throws `regeneratorRuntime is not defined`.
 * Glyph ids belong to the font, so a glyph shaped by one library is cut by the other. HarfBuzz (harfbuzzjs 1.6.3, a
 * devDependency, never shipped) is the reference: test/indic-shaper.test.ts shapes a fixture set with both and compares the glyph
 * ids, advances and offsets; docs/decisions.md has the gate this module passed.
 *
 * Two things about fontkit 2.0.4 are handled here:
 *
 * - **History.** Its glyph cache is keyed by glyph id and keeps the code points of the first glyph made, and the Indic shaper
 *   reads them, so a run shaped after another could differ from the same run shaped first. A run starts with the cache empty,
 *   and the same text gives the same glyphs whatever was shaped before.
 * - **Clusters.** It reports no cluster for a glyph. A run is shaped whole, and again one grapheme cluster at a time; when the
 *   clusters' glyphs put together are the glyphs of the whole (the usual case), each glyph is known to its cluster, as HarfBuzz
 *   would give it; when they are not, the run is one cluster, which is a coarser answer and never a wrong one.
 */

import type { Font as LayoutFont } from 'fontkit';

import { clustersOf } from './brahmic.js';
import type { ShapedGlyph } from './shaper.js';

/** What a shape call needs to know. */
export interface BrahmicShapeOptions {
  /** A font the shaper was given. */
  readonly fontId: string;
  /** The OpenType script tag: `deva` for Devanagari. */
  readonly script: string;
  /** The language, a BCP 47 tag (`hi`, `mr`, `ne`, `sa`): it selects the font's language forms (`locl`). */
  readonly lang?: string;
}

/** One glyph of a shaped run, in font units. `cluster` is the UTF-16 offset in the run of the cluster the glyph belongs to. */
export interface BrahmicGlyph {
  readonly gid: number;
  readonly cluster: number;
  readonly xAdvance: number;
  readonly xOffset: number;
  readonly yOffset: number;
}

export interface BrahmicShaper {
  /** Throws when the engine cannot shape the run ({@link shapeWord} does not). */
  shape(run: string, options: BrahmicShapeOptions): BrahmicGlyph[];
}

/** The OpenType language system tags of the languages written in Devanagari that the font selects forms for. */
const LANGUAGE_TAGS: Readonly<Record<string, string>> = { hi: 'HIN ', mr: 'MAR ', ne: 'NEP ', sa: 'SAN ' };

/** The language system tag for a BCP 47 tag, or undefined for the font's default forms. */
export function languageTag(lang: string | undefined): string | undefined {
  if (lang === undefined) return undefined;
  const primary = lang.toLowerCase().split('-')[0] ?? '';
  return LANGUAGE_TAGS[primary];
}

interface Laid {
  readonly gid: number;
  readonly xAdvance: number;
  readonly xOffset: number;
  readonly yOffset: number;
}

function layout(font: LayoutFont, run: string, script: string, lang: string | undefined): Laid[] {
  // See the header: a run is laid out with the glyph cache empty.
  font._glyphs = {};
  const laid = font.layout(run, undefined, script, languageTag(lang), 'ltr');
  return laid.glyphs.map((glyph, index) => {
    const position = laid.positions[index];
    return { gid: glyph.id, xAdvance: position?.xAdvance ?? 0, xOffset: position?.xOffset ?? 0, yOffset: position?.yOffset ?? 0 };
  });
}

const same = (a: readonly Laid[], b: readonly Laid[]): boolean =>
  a.length === b.length &&
  a.every((glyph, i) => glyph.gid === b[i]?.gid && glyph.xAdvance === b[i]?.xAdvance && glyph.xOffset === b[i]?.xOffset && glyph.yOffset === b[i]?.yOffset);

/** The shaper over upstream fontkit, with the fonts it is given (font id to font bytes). Loads fontkit by a dynamic import. */
export async function createFontkitShaper(fonts: Readonly<Record<string, Uint8Array>>): Promise<BrahmicShaper> {
  const { create } = await import('fontkit');
  const opened = new Map<string, LayoutFont>();
  const cache = new Map<string, BrahmicGlyph[]>();
  const fontOf = (id: string): LayoutFont => {
    let font = opened.get(id);
    if (font === undefined) {
      const bytes = fonts[id];
      if (bytes === undefined) throw new Error(`the shaper has no font ${id}`);
      font = create(bytes);
      opened.set(id, font);
    }
    return font;
  };
  return {
    shape(run, options) {
      const key = `${options.fontId}\u0000${options.script}\u0000${options.lang ?? ''}\u0000${run}`;
      const known = cache.get(key);
      if (known !== undefined) return known;
      const font = fontOf(options.fontId);
      const whole = layout(font, run, options.script, options.lang);
      const clusters = clustersOf(run);
      let glyphs: BrahmicGlyph[] = whole.map((glyph) => ({ ...glyph, cluster: 0 }));
      if (clusters.length > 1) {
        const parts = clusters.map((cluster) => layout(font, cluster, options.script, options.lang));
        if (same(whole, parts.flat())) {
          let offset = 0;
          glyphs = parts.flatMap((part, index) => {
            const start = offset;
            offset += clusters[index]?.length ?? 0;
            return part.map((glyph) => ({ ...glyph, cluster: start }));
          });
        }
      }
      cache.set(key, glyphs);
      return glyphs;
    },
  };
}

/** A shaped word: its glyphs left to right and its advance in font units. */
export interface ShapedWord {
  readonly glyphs: readonly ShapedGlyph[];
  readonly advance: number;
  /** Why the engine could not shape the word; the word then has no glyphs. */
  readonly failed?: string;
}

/**
 * Shapes a word and gives each glyph the text it stands for, from the clusters the shaper gave and never from the glyph order: a
 * reordered vowel sign or a reph is drawn out of its place in the text. The first glyph drawn of a cluster carries the cluster's
 * text for the ToUnicode map and the others none, so a reader that ignores `/ActualText` still gets the typed text, and the texts
 * of the glyphs in drawing order are the typed text. An engine failure is a word with no glyphs and the error in `failed`, never
 * a throw.
 */
export function shapeWord(shaper: BrahmicShaper, word: string, options: BrahmicShapeOptions): ShapedWord {
  let raw: BrahmicGlyph[];
  try {
    raw = shaper.shape(word, options);
  } catch (error) {
    return { glyphs: [], advance: 0, failed: error instanceof Error ? error.message : String(error) };
  }
  const starts = [...new Set(raw.map((glyph) => glyph.cluster))].sort((a, b) => a - b);
  const textOf = (start: number): string => word.slice(start, starts[starts.indexOf(start) + 1] ?? word.length);
  // A cluster must be one stretch of the drawing order, or the word is one cluster.
  const order: number[] = [];
  for (const glyph of raw) if (order[order.length - 1] !== glyph.cluster) order.push(glyph.cluster);
  const contiguous = new Set(order).size === order.length;
  const glyphs: ShapedGlyph[] = [];
  let previous: number | undefined;
  for (const glyph of raw) {
    const cluster = contiguous ? glyph.cluster : 0;
    const first = cluster !== previous;
    previous = cluster;
    const text = contiguous ? textOf(cluster) : word;
    glyphs.push({ id: glyph.gid, advance: glyph.xAdvance, dx: glyph.xOffset, dy: glyph.yOffset, text: first ? text : '' });
  }
  return { glyphs, advance: glyphs.reduce((sum, glyph) => sum + glyph.advance, 0) };
}
