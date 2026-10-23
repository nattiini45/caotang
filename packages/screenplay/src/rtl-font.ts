/**
 * The Arabic, Hebrew and Devanagari fonts of the screenplay PDF ([screenplay.md §5.3](../../../docs/architecture/screenplay.md)).
 *
 * Text in these scripts prints in Noto Sans Arabic, Noto Sans Hebrew or Noto Sans Devanagari (OFL), the static TrueType files of
 * `@caotang/font-noto-arabic`, `@caotang/font-noto-hebrew` and `@caotang/font-noto-devanagari` (vendor/noto-sans-arabic,
 * vendor/noto-sans-hebrew, vendor/noto-sans-devanagari), read through the host's {@link FontLoader}s. The fonts are proportional and
 * the page is a grid of Courier columns, so a word is shaped (the joining forms, the conjuncts; `@caotang/pdf-fonts/shaper` and
 * `@caotang/pdf-fonts/indic-shaper`) and takes the whole columns its width needs, rounded up, with the spare room on the side the
 * word ends (the left, for a right-to-left word). {@link RtlSupport.measure} is that width, and the layout asks for it (width.ts
 * `withMeasure`), so the lines break where the words really are as wide as they print.
 *
 * Each line that holds either right-to-left script, or belongs to a right-to-left paragraph, is resolved by the bidirectional
 * algorithm of UAX #9 (`@caotang/pdf-fonts/bidi`) into runs in the order they are drawn, and planned: a shaped run is a word with each
 * glyph at the position the shaper gave, and the other runs are the line's other text. The plan is what pdf.ts writes. Marks
 * (harakat, Hebrew points) are left out of the shaped word, which fontkit 1.1.1 cannot be shown to place as HarfBuzz does
 * (`@caotang/pdf-fonts` test/fixtures/shaping), and the text a reader copies keeps them: each mark, and each zero-width joiner, is a
 * glyph of its own that draws nothing and carries the character as its text (`withMarkGlyphs`; the ones after a word's last letter are
 * flagged `final`, which pdf.ts writes after the word). The words have no `/ActualText`:
 * the glyphs are drawn in visual order with the letter each draws in ToUnicode, and a reader puts the word in logical order.
 *
 * Devanagari is left to right and needs no bidirectional algorithm. A line that holds it is planned too: each Devanagari word is
 * shaped by upstream fontkit 2.0.4 (`@caotang/pdf-fonts/indic-shaper`, in the project's language, which selects the Marathi and
 * Nepali forms), marks and all, and the rest of the line is plain. The word is wrapped in `/ActualText` with its typed text, and
 * each cluster's text is the ToUnicode text of the first glyph drawn of it (the clusters the shaper gave).
 *
 * Every distinct (glyph, text) pair has a CID of its own, so a glyph that is drawn for two different letters copies back as the
 * letter it was drawn for.
 *
 * This module is reached only by the dynamic import in render-pdf.ts, and only for a layout with Arabic, Hebrew or Devanagari
 * text. A document without any loads neither this module, nor a shaper, nor a font file; fontkit 2.0.4 is loaded for Devanagari
 * alone.
 */

import {
  CidNumbering,
  cutCidSubset,
  devanagariFontPrints,
  devanagariRuns,
  hasDevanagari,
  loadFont,
  loadFontWithBytes,
  needsBidi,
  rtlFontPrints,
  withoutMarks,
  type CidUnit,
  type FontLoader,
  type ShapedScript,
} from '@caotang/pdf-fonts';
import { visualRuns } from '@caotang/pdf-fonts/bidi';
import { createFontkitShaper, shapeWord, type BrahmicShaper, type ShapedWord } from '@caotang/pdf-fonts/indic-shaper';
import { blankGlyphOf, fontkitShape, withMarkGlyphs, type ShapedGlyph, type Shape } from '@caotang/pdf-fonts/shaper';
import type { Font } from '@pdf-lib/fontkit';

import { LAYOUT, type LayoutPage } from './paginate.js';
import { rtlLineKey, type PdfRtlFonts, type PdfRtlItem } from './pdf.js';
import { textUnits, unitColumns, type MeasureRun } from './width.js';

/** The PostScript names the fonts' `name` tables give. */
const POSTSCRIPT_NAMES: Readonly<Record<ShapedScript, string>> = {
  arabic: 'NotoSansArabic-Regular',
  hebrew: 'NotoSansHebrew-Regular',
  devanagari: 'NotoSansDevanagari-Regular',
};

/** The size the script fonts are set in, the grid's own: 12 points. */
const SIZE = 12;

/** The OpenType script tag Devanagari is shaped under, and the id the shaper knows its font by. */
const DEVANAGARI_TAG = 'deva';
const DEVANAGARI_ID = 'devanagari';

/** The loaders of the three fonts. A script without one is not loaded, and its text prints as "?". */
export interface RtlFontLoaders {
  readonly arabic?: FontLoader;
  readonly hebrew?: FontLoader;
  readonly devanagari?: FontLoader;
}

/** The parsed fonts and the shapers, ready to measure and to plan. */
export interface RtlSupport {
  readonly fonts: Readonly<Partial<Record<ShapedScript, Font>>>;
  readonly shape: Shape;
  /** The Devanagari shaper, once that font is loaded. */
  readonly indic?: BrahmicShaper;
  /** The project's language: it selects the Devanagari font's language forms. */
  readonly language?: string;
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

/** The Devanagari word shaped in the project's language, or undefined when no Devanagari font is loaded. */
function shapeDevanagari(support: Pick<RtlSupport, 'indic' | 'language'>, word: string): ShapedWord | undefined {
  if (support.indic === undefined) return undefined;
  return shapeWord(support.indic, word, { fontId: DEVANAGARI_ID, script: DEVANAGARI_TAG, ...(support.language === undefined ? {} : { lang: support.language }) });
}

/**
 * Loads the fonts the scripts need that the host has a loader for, and makes the measure over them. `language` is the project's:
 * the Devanagari font's forms for Marathi and Nepali are not Hindi's.
 */
export async function loadRtlSupport(
  scripts: readonly ShapedScript[],
  loaders: RtlFontLoaders,
  shape: Shape = fontkitShape,
  options: { readonly language?: string } = {},
): Promise<RtlSupport> {
  const fonts: Partial<Record<ShapedScript, Font>> = {};
  let indic: BrahmicShaper | undefined;
  await Promise.all(
    scripts.map(async (script) => {
      const load = loaders[script];
      if (load === undefined) return;
      if (script === 'devanagari') {
        // @pdf-lib/fontkit cuts the subset, and upstream fontkit shapes from the same bytes.
        const { font, bytes } = await loadFontWithBytes(load, 'the Devanagari font');
        fonts.devanagari = font;
        indic = await createFontkitShaper({ [DEVANAGARI_ID]: bytes });
        return;
      }
      fonts[script] = await loadRtlFont(load, script === 'arabic' ? 'the Arabic font' : 'the Hebrew font');
    }),
  );
  const base = { fonts, shape, ...(indic === undefined ? {} : { indic }), ...(options.language === undefined ? {} : { language: options.language }) };
  const cache = new Map<string, number>();
  const measure: MeasureRun = (run) => {
    let columns = cache.get(run);
    if (columns === undefined) {
      if (devanagariFontPrints(String.fromCodePoint(run.codePointAt(0) ?? 0))) {
        const font = fonts.devanagari;
        const word = font === undefined ? undefined : shapeDevanagari(base, run);
        // A word that cannot be shaped prints as "?", a column for each cluster.
        columns = font === undefined || word === undefined || word.failed !== undefined ? textUnits(run).length : columnsOf(word.advance, font.unitsPerEm);
      } else {
        const script = rtlFontPrints(run) ?? 'arabic';
        const font = fonts[script];
        const shaped = font === undefined ? undefined : shape(withoutMarks(run), font, 'rtl', script);
        // A run that cannot be shaped prints as "?", a column for each unit.
        columns = font === undefined || shaped === undefined || shaped.failed !== undefined ? textUnits(run).length : columnsOf(shaped.advance, font.unitsPerEm);
      }
      cache.set(run, columns);
    }
    return columns;
  };
  return { ...base, measure };
}

/** The glyphs of one font that the lines use, one CID for each distinct (glyph, text) pair, CID 1 first. */
interface Collected {
  readonly units: CidUnit[];
  readonly cids: Map<string, number>;
  readonly numbering: CidNumbering;
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** The glyphs of a shaped run placed from `start` (points from the run's left edge), each with the CID of its (glyph, text) pair. */
function placeGlyphs(glyphs: readonly ShapedGlyph[], font: Font, start: number, target: Collected): { cid: number; x: number; y: number; final?: true }[] {
  const scale = SIZE / font.unitsPerEm;
  let x = start;
  return glyphs.map((glyph) => {
    const key = `${glyph.id}:${glyph.text}`;
    let cid = target.cids.get(key);
    if (cid === undefined) {
      cid = target.numbering.next(glyph.text);
      target.units.push({ glyphId: glyph.id, width: Math.round(glyph.advance * (1000 / font.unitsPerEm)), text: glyph.text, cid });
      target.cids.set(key, cid);
    }
    const placed = { cid, x: round(x + glyph.dx * scale), y: round(glyph.dy * scale), ...(glyph.final === true ? { final: true as const } : {}) };
    x += glyph.advance * scale;
    return placed;
  });
}

/**
 * Plans one text that may hold Devanagari into `items`: its Devanagari words shaped, each at its column, and the rest plain. `text`
 * is what is drawn and `source` its logical text, which differ only where the algorithm mirrored a character. False when a word
 * needs the Devanagari font and it is not loaded.
 */
function planText(
  text: string,
  source: string,
  at: { column: number; order: number },
  support: RtlSupport,
  collected: Record<ShapedScript, Collected>,
  items: PdfRtlItem[],
): boolean {
  if (!hasDevanagari(text)) {
    items.push({ kind: 'plain', column: at.column, text, source, order: at.order });
    for (const unit of textUnits(text)) at.column += unitColumns(unit);
    return true;
  }
  const font = support.fonts.devanagari;
  if (font === undefined) return false;
  for (const run of devanagariRuns(textUnits(text))) {
    if (run.kind === 'other') {
      items.push({ kind: 'plain', column: at.column, text: run.text, source: run.text, order: at.order });
      for (const unit of textUnits(run.text)) at.column += unitColumns(unit);
      continue;
    }
    const word = shapeDevanagari(support, run.text);
    if (word === undefined || word.failed !== undefined || word.glyphs.length === 0) {
      // The engine could not shape the word: it prints as "?", the columns the layout counted.
      items.push({ kind: 'plain', column: at.column, text: run.text, source: run.text, order: at.order });
    } else {
      const glyphs = placeGlyphs(word.glyphs, font, 0, collected.devanagari);
      items.push({ kind: 'shaped', font: 'devanagari', column: at.column, glyphs, source: run.text, order: at.order });
    }
    at.column += support.measure(run.text);
  }
  return true;
}

/**
 * The plan of one line that holds Arabic or Hebrew or belongs to a right-to-left paragraph: the runs of its text in the order
 * they are drawn, each at its column. Undefined when a font the line needs is not loaded, and the line is then written as it is (its
 * Arabic, Hebrew and Devanagari print as "?").
 */
function planLine(text: string, rtl: boolean, support: RtlSupport, collected: Record<ShapedScript, Collected>): PdfRtlItem[] | undefined {
  const items: PdfRtlItem[] = [];
  const at = { column: 0, order: 0 };
  for (const run of visualRuns(text, rtl ? 'rtl' : 'ltr')) {
    at.order = run.order;
    if (run.kind === 'other' || run.script === undefined) {
      if (!planText(run.text, run.source, at, support, collected, items)) return undefined;
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
      items.push({ kind: 'plain', column: at.column, text: run.source, source: run.source, order: run.order });
      at.column += columns;
      continue;
    }
    // The room left in the cell goes to the side the run ends: the left of a right-to-left word.
    const start = direction === 'rtl' ? Math.max(0, columns * LAYOUT.charWidth - shaped.advance * (SIZE / font.unitsPerEm)) : 0;
    const glyphs = placeGlyphs(withMarkGlyphs(shaped.glyphs, run.source, direction, blankGlyphOf(font)), font, start, collected[run.script]);
    items.push({ kind: 'shaped', font: run.script, column: at.column, glyphs, source: run.source, order: run.order });
    at.column += columns;
  }
  return items;
}

/** The plan of a left-to-right line with Devanagari and no Arabic or Hebrew: no algorithm is needed, the line is its own visual order. */
function planDevanagariLine(text: string, support: RtlSupport, collected: Record<ShapedScript, Collected>): PdfRtlItem[] | undefined {
  const items: PdfRtlItem[] = [];
  return planText(text, text, { column: 0, order: 0 }, support, collected, items) ? items : undefined;
}

/**
 * The subsets a layout needs and the plan of every line that holds Arabic, Hebrew or Devanagari or belongs to a right-to-left
 * paragraph. A font that is not loaded is not cut, and the lines that need it are left unplanned.
 */
export async function subsetRtl(pages: readonly LayoutPage[], support: RtlSupport): Promise<PdfRtlFonts> {
  const collected: Record<ShapedScript, Collected> = {
    // A glyph with no text takes a CID pdf.js skips in the two scripts that carry no /ActualText (cid-font.ts CidNumbering).
    arabic: { units: [], cids: new Map(), numbering: new CidNumbering(true) },
    hebrew: { units: [], cids: new Map(), numbering: new CidNumbering(true) },
    devanagari: { units: [], cids: new Map(), numbering: new CidNumbering(false) },
  };
  const lines = new Map<string, readonly PdfRtlItem[]>();
  for (const page of pages) {
    for (const line of page.lines) {
      const rtl = line.rtl === true;
      const bidi = rtl || needsBidi(line.text);
      if (!bidi && !hasDevanagari(line.text)) continue;
      const key = rtlLineKey(line.text, rtl);
      if (lines.has(key)) continue;
      const plan = bidi ? planLine(line.text, rtl, support, collected) : planDevanagariLine(line.text, support, collected);
      if (plan !== undefined) lines.set(key, plan);
    }
  }
  const cut = async (script: ShapedScript) => {
    const font = support.fonts[script];
    const { units } = collected[script];
    return font === undefined || units.length === 0 ? undefined : cutCidSubset(font, units, POSTSCRIPT_NAMES[script]);
  };
  const [arabic, hebrew, devanagari] = await Promise.all([cut('arabic'), cut('hebrew'), cut('devanagari')]);
  return {
    ...(arabic === undefined ? {} : { arabic }),
    ...(hebrew === undefined ? {} : { hebrew }),
    ...(devanagari === undefined ? {} : { devanagari }),
    lines,
  };
}
