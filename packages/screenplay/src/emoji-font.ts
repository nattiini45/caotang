/**
 * The emoji fallback font of the screenplay PDF ([screenplay.md §5.3](../../../docs/architecture/screenplay.md)).
 *
 * After Courier Prime and the CJK fallback, emoji print in Noto Emoji Regular (OFL), Google's monochrome emoji font. The
 * file sits beside this module (src/fonts/NotoEmoji-Regular.ttf, the static Regular instance of the variable font
 * google/fonts publishes; the source URL, the instancing step and the SHA-256s are in src/fonts/README.md). Its outlines
 * are TrueType, so the subset fontkit cuts is a `glyf` font and none of the CFF subset workarounds of cjk-font.ts apply.
 *
 * Each emoji is one grapheme cluster (emoji.ts). fontkit's layout engine (`font.layout`, the font's GSUB) turns the
 * cluster into one glyph: a ZWJ sequence, a skin-tone sequence, a flag, a keycap, a tag sequence. Every distinct cluster
 * gets its own CID, so the ToUnicode map gives a reader the whole sequence back, even where two clusters share a glyph
 * (👍 and 👍🏽: the font has no skin tones).
 *
 * This module is reached only by the dynamic import in render-pdf.ts, and only for a script with an emoji the font
 * prints. The file is loaded from the app's own origin in the browser, or from disk under Node.
 */

import type { Font, Glyph } from '@pdf-lib/fontkit';

import { emojiKey, firstCodePoint, isEmojiCluster } from './emoji.js';
import { encodeSubset, fontFileBytes, fontkit, subsetTag } from './font-file.js';
import type { PdfEmojiFont, PdfEmojiGlyph } from './pdf.js';
import { LAYOUT } from './paginate.js';
import { unitColumns } from './width.js';

/** The font file, resolved against this module: an asset URL in the browser build, a file URL under Node. */
const FONT_URL = new URL('./fonts/NotoEmoji-Regular.ttf', import.meta.url);

/** The PostScript name the font's `name` table gives. */
export const NOTO_EMOJI_POSTSCRIPT_NAME = 'NotoEmoji-Regular';

/**
 * The size an emoji is set in, in points. Noto Emoji's glyphs are 1.27 em wide and 1.17 em tall: at 10 points one fits a
 * cell of two columns (14.4 points) and the 12-point line.
 */
export const EMOJI_SIZE = 10;

let loaded: Promise<Font> | undefined;

/** The parsed emoji font. Loaded once per session. */
export function loadNotoEmoji(): Promise<Font> {
  loaded ??= fontFileBytes(FONT_URL, 'emoji fallback font').then(
    (bytes) => fontkit.create(bytes),
    (error: unknown) => {
      loaded = undefined;
      throw error;
    },
  );
  return loaded;
}

/** The one glyph fontkit's layout gives a text, or undefined when it gives more than one or the font lacks it. */
function oneGlyph(font: Font, text: string): Glyph | undefined {
  const glyphs = font.layout(text).glyphs;
  return glyphs.length === 1 && glyphs[0] !== undefined && glyphs[0].id !== 0 ? glyphs[0] : undefined;
}

/**
 * The glyph a unit prints with. An emoji cluster is laid out whole, then without its variation selectors, then by its key
 * (emoji.ts), then as its first code point. Any other character is looked up in the cmap.
 */
export function emojiGlyph(font: Font, unit: string): Glyph | undefined {
  if (!isEmojiCluster(unit)) {
    const code = unit.codePointAt(0) ?? 0;
    return font.hasGlyphForCodePoint(code) ? font.glyphForCodePoint(code) : undefined;
  }
  for (const form of [unit, unit.replace(/\uFE0F/g, ''), emojiKey(unit), firstCodePoint(unit)]) {
    const glyph = oneGlyph(font, form);
    if (glyph !== undefined) return glyph;
  }
  return undefined;
}

interface TtfSubsetInternals {
  _addGlyph(gid: number): number;
  glyf: Uint8Array[];
  offset: number;
}

/**
 * fontkit 1.1.1 writes a TrueType subset's `loca` in the short format, which stores each offset halved, whenever the
 * glyph data is under 128 KB (loca.preEncode), but copies each glyph's bytes as the source font has them
 * (TTFSubset._addGlyph). Noto Emoji's glyphs are not padded, so a glyph of odd length would shift every glyph after it
 * by a byte. Each glyph copied into the subset is padded to an even length here; a pad byte after a glyph is ignored.
 */
function padGlyphs(subset: ReturnType<Font['createSubset']>): void {
  const internals = subset as unknown as TtfSubsetInternals;
  const add = internals._addGlyph.bind(subset);
  internals._addGlyph = (gid) => {
    const index = add(gid);
    const last = internals.glyf[internals.glyf.length - 1];
    if (last !== undefined && last.length % 2 === 1) {
      // The copy is a Buffer under Node; the same type is used for the padded one.
      const make = (last.constructor as { alloc?: (size: number) => Uint8Array }).alloc;
      const padded = typeof make === 'function' ? make(last.length + 1) : new Uint8Array(last.length + 1);
      padded.set(last);
      internals.glyf[internals.glyf.length - 1] = padded;
      internals.offset += 1;
    }
    return index;
  };
}

/** Code point order, so the same units always give the same subset. */
function byCodePoints(a: string, b: string): number {
  const x = [...a].map((ch) => ch.codePointAt(0) ?? 0);
  const y = [...b].map((ch) => ch.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return x.length - y.length;
}

/**
 * The emoji subset for a set of units (render-pdf.ts collects them): one CID per unit, in code point order, each mapped to
 * the glyph it prints with, and the glyphs as a TrueType font program. A unit the font cannot print is left out; the
 * writer prints it as "?".
 */
export async function subsetNotoEmoji(font: Font, units: Iterable<string>): Promise<PdfEmojiFont> {
  const scale = 1000 / font.unitsPerEm;
  const subset = font.createSubset();
  padGlyphs(subset);
  const glyphs = new Map<string, PdfEmojiGlyph>();
  const gids: number[] = [];
  const widths: number[] = [];
  const kept: string[] = [];
  for (const unit of [...new Set(units)].sort(byCodePoints)) {
    const glyph = emojiGlyph(font, unit);
    if (glyph === undefined) continue;
    const cid = kept.length + 1;
    kept.push(unit);
    gids.push(subset.includeGlyph(glyph));
    // The stated advance is the unit's cell on the grid, in the glyph space of the emoji size: two columns at 12 points.
    const cell = unitColumns(unit) * LAYOUT.charWidth;
    const width = Math.round((cell / EMOJI_SIZE) * 1000);
    widths.push(width);
    // The glyph is centred in its cell.
    const dx = (cell - (glyph.advanceWidth * EMOJI_SIZE) / font.unitsPerEm) / 2;
    glyphs.set(unit, { cid, width, dx: Math.round(dx * 100) / 100 });
  }
  const bbox = font.bbox;
  return {
    baseFont: `${subsetTag(kept.join(''))}+${NOTO_EMOJI_POSTSCRIPT_NAME}`,
    program: await encodeSubset(subset),
    size: EMOJI_SIZE,
    glyphs,
    gids,
    widths,
    bbox: [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY].map((v) => Math.round(v * scale)) as [number, number, number, number],
    ascent: Math.round(font.ascent * scale),
    descent: Math.round(font.descent * scale),
    capHeight: Math.round((font.capHeight || font.ascent) * scale),
  };
}
