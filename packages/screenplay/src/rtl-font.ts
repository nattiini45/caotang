/**
 * The Arabic and Hebrew fonts of the screenplay PDF ([screenplay.md §5.3](../../../docs/architecture/screenplay.md)).
 *
 * Text in either script prints in Noto Sans Arabic or Noto Sans Hebrew (OFL), the static TrueType files of
 * `@caotang/font-noto-arabic` and `@caotang/font-noto-hebrew` (vendor/noto-sans-arabic, vendor/noto-sans-hebrew), read through the
 * host's {@link FontLoader}s. The fonts are proportional and the page is a grid of Courier columns, so a word is shaped (the
 * joining forms; `@caotang/pdf-fonts/shaper`) and takes the whole columns its width needs, rounded up, with the spare room on
 * the side the word ends (the left, for a right-to-left word). {@link RtlSupport.measure} is that width, and the layout asks for
 * it (width.ts `withMeasure`), so the lines break where the words really are as wide as they print.
 *
 * Each line that holds either script, or belongs to a right-to-left paragraph, is resolved by the bidirectional algorithm of
 * UAX #9 (`@caotang/pdf-fonts/bidi`) into runs in the order they are drawn, and planned: a shaped run is a word with each glyph
 * at the position the shaper gave, and the other runs are the line's other text. The plan is what pdf.ts writes. Marks
 * (harakat, Hebrew points) are left out of the shaped word, which fontkit 1.1.1 cannot be shown to place as HarfBuzz does
 * (`@caotang/pdf-fonts` test/fixtures/shaping), and the text a reader copies keeps them.
 *
 * Every distinct (glyph, text) pair has a CID of its own, so a ligature copies back as the letters it stands for.
 *
 * This module is reached only by the dynamic import in render-pdf.ts, and only for a layout with Arabic or Hebrew text. A
 * document without either loads neither this module, nor the shaper, nor a font file.
 */

import { cutCidSubset, loadFont, needsBidi, rtlFontPrints, withoutMarks, type CidUnit, type FontLoader, type RtlScript } from '@caotang/pdf-fonts';
import { visualRuns } from '@caotang/pdf-fonts/bidi';
import { fontkitShape, type Shape } from '@caotang/pdf-fonts/shaper';
import type { Font } from '@pdf-lib/fontkit';

import { LAYOUT, type LayoutPage } from './paginate.js';
import { rtlLineKey, type PdfRtlFonts, type PdfRtlItem } from './pdf.js';
import { textUnits, unitColumns, type MeasureRun } from './width.js';

/** The PostScript names the fonts' `name` tables give. */
const POSTSCRIPT_NAMES: Readonly<Record<RtlScript, string>> = { arabic: 'NotoSansArabic-Regular', hebrew: 'NotoSansHebrew-Regular' };

/** The size the script fonts are set in, the grid's own: 12 points. */
const SIZE = 12;

/** The loaders of the two fonts. A script without one is not loaded, and its text prints as "?". */
export interface RtlFontLoaders {
  readonly arabic?: FontLoader;
  readonly hebrew?: FontLoader;
}

/** The parsed fonts and the shaper, ready to measure and to plan. */
export interface RtlSupport {
  readonly fonts: Readonly<Partial<Record<RtlScript, Font>>>;
  readonly shape: Shape;
  /** The columns a run of letters takes: the width of the shaped run in the font, rounded up to whole columns. */
  readonly measure: MeasureRun;
}

const loaded = new WeakMap<FontLoader, Promise<Font>>();

/** A parsed font. Loaded once per loader. */
function loadRtlFont(load: FontLoader, label: string): Promise<Font> {
  let font = loaded.get(load);
  if (font === undefined) {
    font = loadFont(load, label).catch((error: unknown) => {
      loaded.delete(load);
      throw error;
    });
    loaded.set(load, font);
  }
  return font;
}

/** The whole columns an advance (font units) takes at the grid's size: never fewer than one. */
function columnsOf(advance: number, unitsPerEm: number): number {
  return Math.max(1, Math.ceil((advance * SIZE) / (unitsPerEm * LAYOUT.charWidth) - 1e-9));
}

/** Loads the fonts the scripts need that the host has a loader for, and makes the measure over them. */
export async function loadRtlSupport(scripts: readonly RtlScript[], loaders: RtlFontLoaders, shape: Shape = fontkitShape): Promise<RtlSupport> {
  const fonts: Partial<Record<RtlScript, Font>> = {};
  await Promise.all(
    scripts.map(async (script) => {
      const load = loaders[script];
      if (load !== undefined) fonts[script] = await loadRtlFont(load, script === 'arabic' ? 'the Arabic font' : 'the Hebrew font');
    }),
  );
  const cache = new Map<string, number>();
  const measure: MeasureRun = (run) => {
    let columns = cache.get(run);
    if (columns === undefined) {
      const script = rtlFontPrints(run) ?? 'arabic';
      const font = fonts[script];
      const shaped = font === undefined ? undefined : shape(withoutMarks(run), font, 'rtl', script);
      // A run that cannot be shaped prints as "?", a column for each unit.
      columns = font === undefined || shaped === undefined || shaped.failed !== undefined ? textUnits(run).length : columnsOf(shaped.advance, font.unitsPerEm);
      cache.set(run, columns);
    }
    return columns;
  };
  return { fonts, shape, measure };
}

/** The glyphs of one font that the lines use, one CID for each distinct (glyph, text) pair, CID 1 first. */
interface Collected {
  readonly units: CidUnit[];
  readonly cids: Map<string, number>;
}

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * The plan of one line: the runs of its text in the order they are drawn, each at its column. Undefined when a font the line
 * needs is not loaded, and the line is then written as it is (its Arabic and Hebrew print as "?").
 */
function planLine(text: string, rtl: boolean, support: RtlSupport, collected: Record<RtlScript, Collected>): PdfRtlItem[] | undefined {
  const items: PdfRtlItem[] = [];
  let column = 0;
  for (const run of visualRuns(text, rtl ? 'rtl' : 'ltr')) {
    if (run.kind === 'other' || run.script === undefined) {
      items.push({ kind: 'plain', column, text: run.text, source: run.source, order: run.order });
      for (const unit of textUnits(run.text)) column += unitColumns(unit);
      continue;
    }
    const font = support.fonts[run.script];
    if (font === undefined) return undefined;
    const bare = withoutMarks(run.source);
    const direction = run.level % 2 === 1 ? 'rtl' : 'ltr';
    const shaped = support.shape(bare, font, direction, run.script);
    const columns = run.kind === 'single' ? 1 : support.measure(run.source);
    if (shaped.failed !== undefined || shaped.glyphs.length === 0) {
      // The engine could not shape the run: it prints as "?", the columns the layout counted.
      items.push({ kind: 'plain', column, text: run.source, source: run.source, order: run.order });
      column += columns;
      continue;
    }
    const scale = SIZE / font.unitsPerEm;
    // The room left in the cell goes to the side the run ends: the left of a right-to-left word.
    let x = direction === 'rtl' ? Math.max(0, columns * LAYOUT.charWidth - shaped.advance * scale) : 0;
    const target = collected[run.script];
    const glyphs = shaped.glyphs.map((glyph) => {
      const key = `${glyph.id}:${glyph.text}`;
      let cid = target.cids.get(key);
      if (cid === undefined) {
        target.units.push({ glyphId: glyph.id, width: Math.round(glyph.advance * (1000 / font.unitsPerEm)), text: glyph.text });
        cid = target.units.length;
        target.cids.set(key, cid);
      }
      const placed = { cid, x: round(x + glyph.dx * scale), y: round(glyph.dy * scale) };
      x += glyph.advance * scale;
      return placed;
    });
    items.push({ kind: 'shaped', font: run.script, column, glyphs, source: run.source, order: run.order });
    column += columns;
  }
  return items;
}

/**
 * The Arabic and Hebrew subsets a layout needs, and the plan of every line that holds either script or belongs to a
 * right-to-left paragraph. A font that is not loaded is not cut, and the lines that need it are left unplanned.
 */
export async function subsetRtl(pages: readonly LayoutPage[], support: RtlSupport): Promise<PdfRtlFonts> {
  const collected: Record<RtlScript, Collected> = {
    arabic: { units: [], cids: new Map() },
    hebrew: { units: [], cids: new Map() },
  };
  const lines = new Map<string, readonly PdfRtlItem[]>();
  for (const page of pages) {
    for (const line of page.lines) {
      const rtl = line.rtl === true;
      if (!rtl && !needsBidi(line.text)) continue;
      const key = rtlLineKey(line.text, rtl);
      if (lines.has(key)) continue;
      const plan = planLine(line.text, rtl, support, collected);
      if (plan !== undefined) lines.set(key, plan);
    }
  }
  const cut = async (script: RtlScript) => {
    const font = support.fonts[script];
    const { units } = collected[script];
    return font === undefined || units.length === 0 ? undefined : cutCidSubset(font, units, POSTSCRIPT_NAMES[script]);
  };
  const [arabic, hebrew] = await Promise.all([cut('arabic'), cut('hebrew')]);
  return { ...(arabic === undefined ? {} : { arabic }), ...(hebrew === undefined ? {} : { hebrew }), lines };
}
