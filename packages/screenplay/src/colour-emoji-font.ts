/**
 * The colour emoji of the screenplay PDF ([screenplay.md §5.3](../../../docs/architecture/screenplay.md)): Noto Color Emoji's
 * vector pictures (`@caotang/font-noto-color-emoji`, opened by `@caotang/pdf-fonts/colour`), written as Type 3 fonts by
 * `@caotang/pdf-fonts` (type3.ts).
 *
 * Placement is the monochrome emoji font's (emoji-font.ts): each emoji is one code, set at {@link EMOJI_SIZE} and centred in the
 * two-column cell of its unit, so a line wraps and counts the same whichever font draws it. The emoji of a document are numbered
 * in code point order, 255 to a font, so the same emoji always give the same file.
 *
 * This module is reached only by the dynamic import in render-pdf.ts, and only for a script with an emoji the colour set has.
 */

import { type3Objects, type3Place, type Type3Glyph } from '@caotang/pdf-fonts';
import type { ColourEmoji } from '@caotang/pdf-fonts/colour';

import { EMOJI_SIZE } from './emoji-font.js';
import { LAYOUT } from './paginate.js';
import type { PdfColourEmojiFont, PdfColourGlyph } from './pdf.js';
import { unitColumns } from './width.js';

/** Code point order, so the same units always give the same fonts. */
function byCodePoints(a: string, b: string): number {
  const x = [...a].map((ch) => ch.codePointAt(0) ?? 0);
  const y = [...b].map((ch) => ch.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return x.length - y.length;
}

/**
 * The Type 3 fonts for a set of emoji units (render-pdf.ts collects them). A unit the asset has no picture for is left out, and
 * the writer prints it in the monochrome font; `deflate` compresses the glyph procedures when the host can.
 */
export function subsetColourEmoji(asset: ColourEmoji, units: Iterable<string>, deflate?: (data: Uint8Array) => Uint8Array): PdfColourEmojiFont {
  const placed: { unit: string; width: number; dx: number }[] = [];
  const glyphs: Type3Glyph[] = [];
  for (const unit of [...new Set(units)].sort(byCodePoints)) {
    // The stated advance is the unit's cell on the grid, in the glyph space of the emoji size: two columns at 12 points.
    const cell = unitColumns(unit) * LAYOUT.charWidth;
    const width = Math.round((cell / EMOJI_SIZE) * 1000);
    const glyph = asset.type3Glyph(unit, width);
    if (glyph === undefined) continue;
    const advance = asset.glyph(unit)?.advance ?? 1000;
    placed.push({ unit, width, dx: Math.round(((cell - (advance * EMOJI_SIZE) / 1000) / 2) * 100) / 100 });
    glyphs.push(glyph);
  }
  const fonts = type3Objects(glyphs, (id) => asset.pool(id));
  const places = new Map<string, PdfColourGlyph>();
  placed.forEach(({ unit, width, dx }, index) => places.set(unit, { ...type3Place(index), width, dx }));
  return { size: EMOJI_SIZE, fonts, glyphs: places, ...(deflate === undefined ? {} : { deflate }) };
}
