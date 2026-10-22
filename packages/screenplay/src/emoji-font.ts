/**
 * The emoji fallback font of the screenplay PDF ([screenplay.md §5.3](../../../docs/architecture/screenplay.md)).
 *
 * After Courier Prime and the CJK fallback, emoji print in Noto Emoji Regular (OFL), Google's monochrome emoji font. The
 * file is the one the contact sheet uses too: the static Regular instance in `@caotang/font-noto-emoji` (vendor/noto-emoji,
 * where its source, the instancing step and the SHA-256s are written down), read through the host's {@link FontLoader}.
 * Its outlines are TrueType, so the subset fontkit cuts is a `glyf` font.
 *
 * Each emoji is one grapheme cluster (emoji.ts). fontkit's layout engine (`font.layout`, the font's GSUB) turns the
 * cluster into one glyph: a ZWJ sequence, a skin-tone sequence, a flag, a keycap, a tag sequence. Every distinct cluster
 * gets its own CID, so the ToUnicode map gives a reader the whole sequence back, even where two clusters share a glyph
 * (👍 and 👍🏽: the font has no skin tones).
 *
 * This module is reached only by the dynamic import in render-pdf.ts, and only for a script with an emoji the font
 * prints.
 */

import { cutCidSubset, emojiKey, firstCodePoint, isEmojiCluster, loadFont, type FontLoader } from '@caotang/pdf-fonts';
import type { Font, Glyph } from '@pdf-lib/fontkit';

import type { PdfEmojiFont, PdfEmojiGlyph } from './pdf.js';
import { LAYOUT } from './paginate.js';
import { unitColumns } from './width.js';

/** The PostScript name the font's `name` table gives. */
export const NOTO_EMOJI_POSTSCRIPT_NAME = 'NotoEmoji-Regular';

/**
 * The size an emoji is set in, in points. Noto Emoji's glyphs are 1.27 em wide and 1.17 em tall: at 10 points one fits a
 * cell of two columns (14.4 points) and the 12-point line.
 */
export const EMOJI_SIZE = 10;

const loaded = new WeakMap<FontLoader, Promise<Font>>();

/** The parsed emoji font. Loaded once per loader. */
export function loadNotoEmoji(load: FontLoader): Promise<Font> {
  let font = loaded.get(load);
  if (font === undefined) {
    font = loadFont(load, 'the emoji fallback font').catch((error: unknown) => {
      loaded.delete(load);
      throw error;
    });
    loaded.set(load, font);
  }
  return font;
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
  const placed: { unit: string; glyph: Glyph; width: number; dx: number }[] = [];
  for (const unit of [...new Set(units)].sort(byCodePoints)) {
    const glyph = emojiGlyph(font, unit);
    if (glyph === undefined) continue;
    // The stated advance is the unit's cell on the grid, in the glyph space of the emoji size: two columns at 12 points.
    const cell = unitColumns(unit) * LAYOUT.charWidth;
    const width = Math.round((cell / EMOJI_SIZE) * 1000);
    // The glyph is centred in its cell.
    const dx = (cell - (glyph.advanceWidth * EMOJI_SIZE) / font.unitsPerEm) / 2;
    placed.push({ unit, glyph, width, dx: Math.round(dx * 100) / 100 });
  }
  const subset = await cutCidSubset(
    font,
    placed.map(({ unit, glyph, width }) => ({ glyphId: glyph.id, width, text: unit })),
    NOTO_EMOJI_POSTSCRIPT_NAME,
  );
  const glyphs = new Map<string, PdfEmojiGlyph>();
  placed.forEach(({ unit, width, dx }, index) => glyphs.set(unit, { cid: index + 1, width, dx }));
  return { ...subset, size: EMOJI_SIZE, glyphs };
}
