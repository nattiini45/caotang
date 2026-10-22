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
 * Neither font file belongs to this package. The host passes a {@link FontLoader} for each (the app fetches the files from
 * its own origin, Node reads them from their packages), the same two files and loaders the contact sheet uses.
 */

import { emojiFontMaps, fallbackCovers, type FontLoader } from '@caotang/pdf-fonts';

import type { FlatBlock } from './flat-block.js';
import { paginate, type LayoutPage, type PaginateOptions } from './paginate.js';
import { parseFountain } from './parse.js';
import { emojiPrint, firstCodePoint, isEmojiCluster } from './emoji.js';
import { isPrintable, writePdf, type PdfCidFont, type PdfEmojiFont, type PdfFont } from './pdf.js';
import { renderFountain, type FountainRenderOptions } from './render-fountain.js';
import { textUnits } from './width.js';

export const PDF_MIME = 'application/pdf';

export type PdfRenderOptions = FountainRenderOptions & Pick<PaginateOptions, 'titlePage' | 'sceneNumbers' | 'continued'>;

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
}

function unprintable(pages: readonly LayoutPage[]): Unprintable {
  const seen = new Set<string>();
  const found: Unprintable = { cjk: [], emoji: [], partial: [], missing: [] };
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
        if (fallbackCovers(base)) {
          if (!found.cjk.includes(base)) found.cjk.push(base);
        } else if (emojiFontMaps(base)) found.emoji.push(unit);
        else if (!found.missing.includes(base)) found.missing.push(base);
      }
    }
  }
  return found;
}

/** "this character … it is" or "these N characters … they are", for the log. */
function counted(list: readonly string[], one: string, many: string): { what: string; verb: string; shown: string } {
  return {
    what: list.length === 1 ? `this ${one}` : `these ${list.length} ${many}`,
    verb: list.length === 1 ? 'it is' : 'they are',
    shown: `${list.slice(0, 10).join(' ')}${list.length > 10 ? ' …' : ''}`,
  };
}

/** Paginates the blocks. Pure and synchronous: the same blocks and options always give the same pages. */
export function layoutPdf(blocks: readonly FlatBlock[], opts: PdfRenderOptions): PdfLayout {
  const fountain = renderFountain(blocks, opts);
  const parsed = parseFountain(fountain.text);
  const pages = paginate(parsed.elements, {
    titlePage: opts.titlePage,
    title: opts.title,
    author: opts.author,
    date: opts.date,
    sceneNumbers: opts.sceneNumbers,
    continued: opts.continued,
  });
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
  return {
    pages,
    scriptPageCount: pages.filter((page) => page.kind === 'script').length,
    title: opts.title,
    ...(opts.author === undefined ? {} : { author: opts.author }),
    notes,
    fallbackCharacters: outside.cjk,
    emojiCharacters: outside.emoji,
  };
}

/**
 * Draws a layout as a PDF. With a font, the font is embedded; without one the file names the base-14 Courier. With a
 * fallback ({@link loadCjkFallback}), the characters WinAnsi cannot encode print in it; with an emoji font
 * ({@link loadEmojiFallback}), the emoji print in it; without them they print as "?".
 */
export function drawPdf(layout: PdfLayout, font?: PdfFont, fallback?: PdfCidFont, emoji?: PdfEmojiFont): Uint8Array<ArrayBuffer> {
  return writePdf(
    layout.pages.map((page) => page.lines.map((line) => ({ text: line.text, x: line.x, y: line.y }))),
    { title: layout.title, ...(layout.author === undefined ? {} : { author: layout.author }) },
    font,
    fallback,
    emoji,
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
 * for the same blocks and options. A character whose fallback the call does not pass, or that the fallback has no glyph
 * for, is not printed as written (a plain "?", or the base character of a keycap- or VS16-style unit, such as © for ©️), and the notes name it.
 */
export function renderPdf(
  blocks: readonly FlatBlock[],
  opts: PdfRenderOptions,
  font?: PdfFont,
  fallback?: PdfCidFont,
  emoji?: PdfEmojiFont,
): PdfRenderResult {
  const layout = layoutPdf(blocks, opts);
  const notes = [...layout.notes];
  const cjkMissing = layout.fallbackCharacters.filter((ch) => fallback?.glyphs.has(ch) !== true);
  const emojiMissing = layout.emojiCharacters.filter((unit) => emoji?.glyphs.has(unit) !== true);
  const unprinted = [...cjkMissing, ...emojiMissing];
  if (unprinted.length > 0) {
    const { what, verb, shown } = counted(unprinted, 'character', 'characters');
    notes.push(`pdf: the CJK or emoji fallback font that prints ${what} was not passed to renderPdf, or has no glyph for ${unprinted.length === 1 ? 'it' : 'them'}, so ${verb} not printed as written: ${shown}`);
  }
  // A script that prints nothing writes one blank page (writePdf), so the reported count agrees with the file.
  return { bytes: drawPdf(layout, font, fallback, emoji), pageCount: Math.max(1, layout.pages.length), notes };
}

export interface PdfRenderer {
  emit(blocks: readonly FlatBlock[], opts: PdfRenderOptions): Promise<Blob>;
}

/** The loaders of the two fallback fonts. A font without one is not loaded, and what it would print is printed as "?". */
export interface PdfFontLoaders {
  readonly cjk?: FontLoader;
  readonly emoji?: FontLoader;
}

/** The renderer seam of screenplay.md §5.3. Its files always embed Courier Prime, and the CJK and emoji fallbacks when the script needs them and the host gave a loader. */
export function createPdfRenderer(loaders: PdfFontLoaders = {}): PdfRenderer {
  return {
    async emit(blocks, opts) {
      const layout = layoutPdf(blocks, opts);
      const [font, cjk, emoji] = await Promise.all([loadCourierPrime(), loadCjkFallback(layout, loaders.cjk), loadEmojiFallback(layout, loaders.emoji)]);
      const bytes = drawPdf(layout, font, cjk, emoji);
      return new Blob([bytes], { type: PDF_MIME });
    },
  };
}
