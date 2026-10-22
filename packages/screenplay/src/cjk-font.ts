/**
 * The CJK fallback font of the screenplay PDF ([screenplay.md §5.3](../../../docs/architecture/screenplay.md)).
 *
 * Courier Prime prints what WinAnsi encodes. Every other character the script holds is printed in Noto Sans Mono CJK
 * SC (OFL), a Pan-CJK font: Hanzi, kana, Hangul, and more. The file is the one the contact sheet uses too: the TrueType
 * WOFF in `@caotang/font-noto-cjk` (vendor/noto-sans-cjk, where its source, checksum and build are written down), read
 * through the host's {@link FontLoader}. Only the glyphs the script uses are written into the PDF: the subset is cut with
 * @pdf-lib/fontkit and written by the writer both PDFs share (`@caotang/pdf-fonts`, cid-font.ts).
 *
 * This module is reached only by the dynamic import in render-pdf.ts, and only for a script with a character WinAnsi
 * cannot encode. A Latin-only compile loads neither this module, nor fontkit, nor the font file.
 */

import { cutCidSubset, loadFont, type FontLoader } from '@caotang/pdf-fonts';
import type { Font } from '@pdf-lib/fontkit';

import type { PdfCidFont, PdfCidGlyph } from './pdf.js';
import { charColumns } from './width.js';

/** The PostScript name the font's `name` table gives. */
export const NOTO_CJK_POSTSCRIPT_NAME = 'NotoSansMonoCJKsc-Regular';

const loaded = new WeakMap<FontLoader, Promise<Font>>();

/** The parsed fallback font. Loaded once per loader. */
export function loadNotoCjk(load: FontLoader): Promise<Font> {
  let font = loaded.get(load);
  if (font === undefined) {
    font = loadFont(load, 'the CJK fallback font').catch((error: unknown) => {
      loaded.delete(load);
      throw error;
    });
    loaded.set(load, font);
  }
  return font;
}

/**
 * The fallback subset for a set of characters: the glyphs of the ones the font maps, in code point order, as a TrueType
 * font program. A character the font does not map is left out; the writer prints it as "?". Each character has its own
 * CID, so two characters the font draws with one glyph (‧ U+2027 and ・ U+30FB, ① U+2460 and ➀ U+2780) copy back as
 * themselves, each with its own width.
 */
export async function subsetNotoCjk(font: Font, characters: Iterable<string>): Promise<PdfCidFont> {
  const codeOf = (ch: string): number => ch.codePointAt(0) ?? 0;
  const chars = [...new Set(characters)].filter((ch) => font.hasGlyphForCodePoint(codeOf(ch))).sort((a, b) => codeOf(a) - codeOf(b));
  // The stated advance is the character's cell on the grid, 600 a column, whatever the glyph's own advance.
  const units = chars.map((ch) => ({ glyphId: font.glyphForCodePoint(codeOf(ch)).id, width: charColumns(ch) * 600, text: ch }));
  const subset = await cutCidSubset(font, units, NOTO_CJK_POSTSCRIPT_NAME);
  const glyphs = new Map<string, PdfCidGlyph>();
  units.forEach((unit, index) => glyphs.set(unit.text, { cid: index + 1, width: unit.width }));
  return { ...subset, glyphs };
}
