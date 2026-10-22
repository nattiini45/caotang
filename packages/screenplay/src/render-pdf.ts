/**
 * The PDF renderer — [screenplay.md §5.3](../../../docs/architecture/screenplay.md), the paginated artifact.
 *
 * The blocks become Fountain text through the same path as the Fountain renderer, that text is
 * parsed, paginated and drawn. The PDF therefore cannot disagree with the Fountain it came
 * from, and the element path is the only path through the pipeline.
 *
 * The work is split in two. {@link layoutPdf} is synchronous and pure: it paginates, so the page
 * count and every page-break rule are known before anything is drawn, and the exporter can refuse
 * or log a compile without loading the font. {@link drawPdf} writes the file with Courier Prime
 * embedded (A3). The font is about 70 KB, so it is loaded by a dynamic import ({@link loadCourierPrime}),
 * the lazy-import pattern the DOCX and EPUB renderers use: the editor bundle never carries it, and
 * nothing is fetched from outside the app.
 *
 * A character WinAnsi cannot encode is printed in the CJK fallback, Noto Sans Mono CJK SC, when the font has it
 * (cjk-font.ts). The layout knows which characters those are without loading the font (the coverage table in
 * `@caotang/pdf-fonts`), so the compile log can name the ones that still print as "?" before anything is drawn.
 * {@link loadCjkFallback} loads the font and fontkit by a dynamic import, and only for a layout that needs them.
 *
 * Emoji print in the emoji fallback, Noto Emoji, after both (emoji.ts, emoji-font.ts). The layout reads that font's
 * coverage too, so it knows which emoji print whole, which print as their first emoji (a sequence newer than the font),
 * and which print as "?". {@link loadEmojiFallback} loads it, by a dynamic import, only for a layout with an emoji it prints.
 *
 * Arabic, Hebrew and Devanagari print in Noto Sans Arabic, Noto Sans Hebrew and Noto Sans Devanagari (rtl-font.ts). A word is
 * shaped, and takes the whole columns its width needs, so the layout of a document with any of the scripts asks the fonts for the
 * width of each word: {@link layoutPdf} takes a `measure` for it, and {@link preparePdf} loads the fonts and the shapers first and
 * lays out again with it. Without a measure a word counts a column for each of its letters (for Devanagari, of its clusters),
 * which is the layout a compile plans with before any font is read; the file is drawn from the measured one.
 * {@link loadRtlFallback} cuts the subsets and plans the lines.
 *
 * None of the font files belongs to this package. The host passes a {@link FontLoader} for each (the app fetches the files from
 * its own origin, Node reads them from their packages), the same files and loaders the contact sheet uses.
 */

import {
  countMarks,
  devanagariFontMaps,
  devanagariFontPrints,
  emojiFontMaps,
  emojiPrint,
  fallbackCovers,
  firstCodePoint,
  hasDevanagari,
  hasRtlScript,
  isBidiControl,
  isEmojiCluster,
  rtlFontPrints,
  rtlScriptOf,
  isRtlMark,
  type FontLoader,
  type RtlScript,
  type ShapedScript,
} from '@caotang/pdf-fonts';
import { languageDirection } from '@caotang/pdf-fonts/bidi';

import type { FlatBlock } from './flat-block.js';
import { paginate, type LayoutPage, type PaginateOptions } from './paginate.js';
import { parseFountain } from './parse.js';
import { isPrintable, writePdf, type PdfCidFont, type PdfEmojiFont, type PdfFont, type PdfRtlFonts } from './pdf.js';
import { renderFountain, type FountainRenderOptions } from './render-fountain.js';
import type { RtlFontLoaders, RtlSupport } from './rtl-font.js';
import { textUnits, withMeasure, type MeasureRun } from './width.js';

export const PDF_MIME = 'application/pdf';

export type PdfRenderOptions = FountainRenderOptions &
  Pick<PaginateOptions, 'titlePage' | 'sceneNumbers' | 'continued'> & {
    /**
     * The project's language (a BCP 47 tag). In a right-to-left one, a paragraph with no strong character is laid out right to
     * left. Devanagari is shaped in it: Marathi and Nepali use other forms of some letters than Hindi does.
     */
    readonly language?: string;
  };

/** A paginated screenplay, ready to draw. */
export interface PdfLayout {
  readonly pages: readonly LayoutPage[];
  /** The script pages, the title page left out. */
  readonly scriptPageCount: number;
  readonly title: string;
  readonly author?: string;
  /** What the Fountain step left out, and the characters neither font can print, in order. */
  readonly notes: readonly string[];
  /** The characters WinAnsi cannot encode that the CJK fallback prints, in order of first use. Empty: no fallback is loaded. */
  readonly fallbackCharacters: readonly string[];
  /**
   * The units the emoji fallback prints (emoji clusters, and characters only it has), in order of first use. Empty: the
   * emoji font is not loaded.
   */
  readonly emojiCharacters: readonly string[];
  /** The scripts of the text that the Arabic, Hebrew and Devanagari fonts print. Empty: none of them is loaded. */
  readonly shapedScripts: readonly ShapedScript[];
}

export interface PdfRenderResult {
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** The pages the written file holds. A script that prints nothing still writes one blank page, and this counts it. */
  readonly pageCount: number;
  /** What the Fountain step left out, then any font-coverage notes from layout (neither font can print a character; an emoji sequence the emoji font lacks), then, when a fallback font is missing or incomplete, one note naming up to ten of the characters it leaves unprinted (CJK first, then emoji units, each in order of first use, with an ellipsis past ten). */
  readonly notes: readonly string[];
}

/** What the pages hold that Courier Prime cannot print, once each, in order of first use, sorted by the font that prints it. */
interface Unprintable {
  readonly cjk: string[];
  readonly emoji: string[];
  /** Emoji sequences the emoji font has no glyph for, which print as their first emoji. */
  readonly partial: string[];
  /** What no font has: printed as "?". */
  readonly missing: string[];
  /** The scripts the Arabic, Hebrew and Devanagari fonts print, in order of first use. */
  readonly scripts: ShapedScript[];
}

function unprintable(pages: readonly LayoutPage[]): Unprintable {
  const seen = new Set<string>();
  const found: Unprintable = { cjk: [], emoji: [], partial: [], missing: [], scripts: [] };
  for (const page of pages) {
    for (const line of page.lines) {
      for (const unit of textUnits(line.text)) {
        if (seen.has(unit)) continue;
        seen.add(unit);
        if ((unit.length > 1 || unit.charCodeAt(0) >= 0x231a) && isEmojiCluster(unit)) {
          const print = emojiPrint(unit);
          if (print === 'none') found.missing.push(unit);
          else found.emoji.push(unit);
          if (print === 'base') found.partial.push(unit);
          continue;
        }
        const base = firstCodePoint(unit);
        if (isPrintable(base)) continue;
        // A bidirectional control character prints nothing, and the Arabic, Hebrew and Devanagari fonts print their own scripts.
        if (isBidiControl(base)) continue;
        const script = rtlFontPrints(base) ?? (devanagariFontPrints(base) ? 'devanagari' : undefined);
        if (script === 'devanagari') {
          if (!found.scripts.includes(script)) found.scripts.push(script);
          // A character of the cluster the font has no glyph for (a Vedic sign it lacks) is printed as the font's own empty glyph: named.
          for (const ch of unit) if (!devanagariFontMaps(ch) && !found.missing.includes(ch)) found.missing.push(ch);
        } else if (script !== undefined) {
          if (!found.scripts.includes(script)) found.scripts.push(script);
        } else if (fallbackCovers(base)) {
          if (!found.cjk.includes(base)) found.cjk.push(base);
        } else if (emojiFontMaps(base)) found.emoji.push(unit);
        else if (!found.missing.includes(base)) found.missing.push(base);
      }
    }
  }
  return found;
}

/** What the compile log calls each script. */
const SCRIPT_NAMES: Readonly<Record<ShapedScript, string>> = { arabic: 'Arabic', hebrew: 'Hebrew', devanagari: 'Devanagari' };

/** "this character … it is" or "these N characters … they are", for the log. */
function counted(list: readonly string[], one: string, many: string): { what: string; verb: string; shown: string } {
  return {
    what: list.length === 1 ? `this ${one}` : `these ${list.length} ${many}`,
    verb: list.length === 1 ? 'it is' : 'they are',
    shown: `${list.slice(0, 10).join(' ')}${list.length > 10 ? ' …' : ''}`,
  };
}

/** The marks of Arabic and Hebrew the pages hold, by script: they are left out of the print (rtl-script.ts). */
function marksOf(pages: readonly LayoutPage[]): Record<RtlScript, number> {
  const counts = { arabic: 0, hebrew: 0 };
  for (const page of pages) {
    for (const line of page.lines) {
      if (!hasRtlScript(line.text) || countMarks(line.text) === 0) continue;
      for (const ch of line.text) if (isRtlMark(ch)) counts[rtlScriptOf(ch.codePointAt(0) ?? 0) ?? 'arabic'] += 1;
    }
  }
  return counts;
}

/**
 * Paginates the blocks. Pure and synchronous: the same blocks, options and measure always give the same pages. `measure` is the
 * width of a shaped word of Arabic or Hebrew in columns ({@link RtlSupport.measure}); without one a word counts a column for each letter.
 */
export function layoutPdf(blocks: readonly FlatBlock[], opts: PdfRenderOptions, measure?: MeasureRun): PdfLayout {
  const fountain = renderFountain(blocks, opts);
  const parsed = parseFountain(fountain.text);
  const holdsRtl = hasRtlScript(fountain.text);
  const pages = withMeasure(holdsRtl || hasDevanagari(fountain.text) ? measure : undefined, () =>
    paginate(parsed.elements, {
      titlePage: opts.titlePage,
      title: opts.title,
      author: opts.author,
      date: opts.date,
      sceneNumbers: opts.sceneNumbers,
      continued: opts.continued,
      // A paragraph with no strong character takes the language's direction, in a document that holds Arabic or Hebrew at all.
      neutralDirection: holdsRtl ? languageDirection(opts.language) : 'ltr',
    }),
  );
  const notes = [...fountain.notes];
  const outside = unprintable(pages);
  if (outside.missing.length > 0) {
    const { what, verb, shown } = counted(outside.missing, 'character', 'characters');
    notes.push(`pdf: neither Courier Prime nor the CJK or emoji fallback font can print ${what}, so ${verb} printed as "?": ${shown}`);
  }
  if (outside.partial.length > 0) {
    const { what, verb, shown } = counted(outside.partial, 'emoji sequence', 'emoji sequences');
    notes.push(`pdf: the emoji font has no glyph for ${what}, so ${verb} printed as ${outside.partial.length === 1 ? 'its' : 'their'} first emoji: ${shown}`);
  }
  const marks = outside.scripts.length === 0 ? { arabic: 0, hebrew: 0 } : marksOf(pages);
  if (marks.hebrew > 0) {
    const n = marks.hebrew;
    notes.push(`pdf: ${n} Hebrew ${n === 1 ? 'point or cantillation mark is' : 'points and cantillation marks are'} left out of the print, because the font's placement of marks cannot be checked; the text of the file still holds ${n === 1 ? 'it' : 'them'}`);
  }
  if (marks.arabic > 0) {
    const n = marks.arabic;
    notes.push(`pdf: ${n} Arabic ${n === 1 ? 'mark (a haraka, shadda or the like) is' : 'marks (harakat, shadda and the like) are'} left out of the print, because the font's placement of marks cannot be checked; the text of the file still holds ${n === 1 ? 'it' : 'them'}`);
  }
  return {
    pages,
    scriptPageCount: pages.filter((page) => page.kind === 'script').length,
    title: opts.title,
    ...(opts.author === undefined ? {} : { author: opts.author }),
    notes,
    fallbackCharacters: outside.cjk,
    emojiCharacters: outside.emoji,
    shapedScripts: outside.scripts,
  };
}

/**
 * Draws a layout as a PDF. With a font, the font is embedded; without one the file names the base-14 Courier. With a
 * fallback ({@link loadCjkFallback}), the characters WinAnsi cannot encode print in it; with an emoji font
 * ({@link loadEmojiFallback}), the emoji print in it; with the Arabic, Hebrew and Devanagari fonts ({@link loadRtlFallback}), the
 * scripts print in them; without them they print as "?".
 */
export function drawPdf(layout: PdfLayout, font?: PdfFont, fallback?: PdfCidFont, emoji?: PdfEmojiFont, rtl?: PdfRtlFonts): Uint8Array<ArrayBuffer> {
  return writePdf(
    layout.pages.map((page) => page.lines.map((line) => ({ text: line.text, x: line.x, y: line.y, ...(line.rtl === true ? { rtl: true as const } : {}) }))),
    { title: layout.title, ...(layout.author === undefined ? {} : { author: layout.author }) },
    font,
    fallback,
    emoji,
    rtl,
  );
}

/**
 * The CJK fallback subset a layout needs, or undefined when it needs none, or when the host passes no loader for the font.
 * Only a layout with a character WinAnsi cannot encode, and the fallback font can print, loads cjk-font.ts, fontkit and the
 * font file, by a dynamic import.
 */
export async function loadCjkFallback(layout: PdfLayout, load?: FontLoader): Promise<PdfCidFont | undefined> {
  if (layout.fallbackCharacters.length === 0 || load === undefined) return undefined;
  const { loadNotoCjk, subsetNotoCjk } = await import('./cjk-font.js');
  return subsetNotoCjk(await loadNotoCjk(load), layout.fallbackCharacters);
}

/**
 * The emoji subset a layout needs, or undefined when it needs none, or when the host passes no loader for the font. Only a
 * layout with an emoji the font prints loads emoji-font.ts, fontkit and the font file, by a dynamic import.
 */
export async function loadEmojiFallback(layout: PdfLayout, load?: FontLoader): Promise<PdfEmojiFont | undefined> {
  if (layout.emojiCharacters.length === 0 || load === undefined) return undefined;
  const { loadNotoEmoji, subsetNotoEmoji } = await import('./emoji-font.js');
  return subsetNotoEmoji(await loadNotoEmoji(load), layout.emojiCharacters);
}

/**
 * The Arabic, Hebrew and Devanagari subsets a layout needs and the plan of its lines, or undefined when it needs none or the host
 * passes no loader for a font it needs. Only a layout with one of the scripts loads rtl-font.ts, the shapers, bidi-js and the font
 * files, by a dynamic import. `support` is what {@link loadRtlSupport} gave for the same document; the layout must have been laid out with
 * its measure ({@link preparePdf} does both).
 */
export async function loadRtlFallback(layout: PdfLayout, support: RtlSupport | undefined): Promise<PdfRtlFonts | undefined> {
  if (layout.shapedScripts.length === 0 || support === undefined) return undefined;
  const { subsetRtl } = await import('./rtl-font.js');
  return subsetRtl(layout.pages, support);
}

/** Courier Prime Regular's bytes. The module that holds them is imported here and nowhere else. */
export async function loadCourierPrime(): Promise<PdfFont> {
  const { COURIER_PRIME_REGULAR_BASE64 } = await import('./fonts/courier-prime-regular.js');
  return { bytes: decodeBase64(COURIER_PRIME_REGULAR_BASE64) };
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Lays out and draws in one call, synchronously. `font` embeds it; without one the file names the base-14 Courier. The
 * fallbacks are drawn as {@link drawPdf} draws them: pass what {@link loadCjkFallback} and {@link loadEmojiFallback} give
 * for the same blocks and options; `rtl` and `measure` are what {@link loadRtlFallback} and {@link RtlSupport.measure} give. A character whose fallback the call does not pass, or that the fallback has no glyph
 * for, is not printed as written (a plain "?", or the base character of a keycap- or VS16-style unit, such as © for ©️), and the notes name it.
 */
export function renderPdf(
  blocks: readonly FlatBlock[],
  opts: PdfRenderOptions,
  font?: PdfFont,
  fallback?: PdfCidFont,
  emoji?: PdfEmojiFont,
  rtl?: PdfRtlFonts,
  measure?: MeasureRun,
): PdfRenderResult {
  const layout = layoutPdf(blocks, opts, measure);
  const notes = [...layout.notes];
  const cjkMissing = layout.fallbackCharacters.filter((ch) => fallback?.glyphs.has(ch) !== true);
  const emojiMissing = layout.emojiCharacters.filter((unit) => emoji?.glyphs.has(unit) !== true);
  const unprinted = [...cjkMissing, ...emojiMissing];
  if (unprinted.length > 0) {
    const { what, verb, shown } = counted(unprinted, 'character', 'characters');
    notes.push(`pdf: the CJK or emoji fallback font that prints ${what} was not passed to renderPdf, or has no glyph for ${unprinted.length === 1 ? 'it' : 'them'}, so ${verb} not printed as written: ${shown}`);
  }
  for (const script of layout.shapedScripts) {
    if (rtl?.[script] === undefined) {
      notes.push(`pdf: the ${SCRIPT_NAMES[script]} font was not passed to renderPdf, so its text is printed as "?"`);
    }
  }
  // A script that prints nothing writes one blank page (writePdf), so the reported count agrees with the file.
  return { bytes: drawPdf(layout, font, fallback, emoji, rtl), pageCount: Math.max(1, layout.pages.length), notes };
}

export interface PdfRenderer {
  emit(blocks: readonly FlatBlock[], opts: PdfRenderOptions): Promise<Blob>;
}

/** The loaders of the fallback fonts. A font without one is not loaded, and what it would print is printed as "?". */
export interface PdfFontLoaders extends RtlFontLoaders {
  readonly cjk?: FontLoader;
  readonly emoji?: FontLoader;
}

/** Everything {@link drawPdf} needs, loaded: the layout (measured with the Arabic, Hebrew and Devanagari fonts when it needs them) and the fonts. */
export interface PreparedPdf {
  readonly layout: PdfLayout;
  readonly font: PdfFont;
  readonly cjk?: PdfCidFont;
  readonly emoji?: PdfEmojiFont;
  readonly rtl?: PdfRtlFonts;
}

/**
 * Lays the blocks out, loads the fonts the layout needs, and lays them out again when the Arabic or Hebrew fonts change the
 * widths: a document with Arabic, Hebrew or Devanagari is measured with the shaper before its lines are broken. A document
 * without any is laid out once, with no shaper and no such font loaded.
 */
export async function preparePdf(blocks: readonly FlatBlock[], opts: PdfRenderOptions, loaders: PdfFontLoaders = {}): Promise<PreparedPdf> {
  let layout = layoutPdf(blocks, opts);
  let support: RtlSupport | undefined;
  if (layout.shapedScripts.length > 0 && (loaders.arabic !== undefined || loaders.hebrew !== undefined || loaders.devanagari !== undefined)) {
    const { loadRtlSupport } = await import('./rtl-font.js');
    support = await loadRtlSupport(layout.shapedScripts, loaders, undefined, opts.language === undefined ? {} : { language: opts.language });
    layout = layoutPdf(blocks, opts, support.measure);
  }
  const [font, cjk, emoji, rtl] = await Promise.all([
    loadCourierPrime(),
    loadCjkFallback(layout, loaders.cjk),
    loadEmojiFallback(layout, loaders.emoji),
    loadRtlFallback(layout, support),
  ]);
  return { layout, font, ...(cjk === undefined ? {} : { cjk }), ...(emoji === undefined ? {} : { emoji }), ...(rtl === undefined ? {} : { rtl }) };
}

/** The renderer seam of screenplay.md §5.3. Its files always embed Courier Prime, and the CJK, emoji, Arabic, Hebrew and Devanagari fonts when the script needs them and the host gave a loader. */
export function createPdfRenderer(loaders: PdfFontLoaders = {}): PdfRenderer {
  return {
    async emit(blocks, opts) {
      const { layout, font, cjk, emoji, rtl } = await preparePdf(blocks, opts, loaders);
      const bytes = drawPdf(layout, font, cjk, emoji, rtl);
      return new Blob([bytes], { type: PDF_MIME });
    },
  };
}
