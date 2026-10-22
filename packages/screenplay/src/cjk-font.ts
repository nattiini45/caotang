/**
 * The CJK fallback font of the screenplay PDF ([screenplay.md §5.3](../../../docs/architecture/screenplay.md)).
 *
 * Courier Prime prints what WinAnsi encodes. Every other character the script holds is printed in Noto Sans Mono CJK
 * SC (OFL), a Pan-CJK font: Hanzi, kana, Hangul, and more. The font file sits beside this module
 * (src/fonts/NotoSansMonoCJKsc-Regular.otf, byte for byte as notofonts/noto-cjk publishes it; the source URL and the
 * SHA-256 are in src/fonts/README.md). Only the glyphs the script uses are written into the PDF: the subset is cut with
 * @pdf-lib/fontkit.
 *
 * This module is reached only by the dynamic import in render-pdf.ts, and only for a script with a character WinAnsi
 * cannot encode. A Latin-only compile loads neither this module, nor fontkit, nor the font file. The file is loaded
 * from the app's own origin (the build emits it as an asset beside the code), or from disk under Node, so nothing is
 * fetched from another host.
 */

import { encodeSubset, openFont, subsetTag } from '@caotang/pdf-fonts';
import type { Font } from '@pdf-lib/fontkit';

import { fontFileBytes } from './font-file.js';
import type { PdfCidFont, PdfCidGlyph } from './pdf.js';
import { charColumns } from './width.js';

/** The font file, resolved against this module: an asset URL in the browser build, a file URL under Node. */
const FONT_URL = new URL('./fonts/NotoSansMonoCJKsc-Regular.otf', import.meta.url);

/** The PostScript name the font's `name` table gives. */
export const NOTO_CJK_POSTSCRIPT_NAME = 'NotoSansMonoCJKsc-Regular';

let loaded: Promise<Font> | undefined;

/** The parsed fallback font. Loaded once per session. */
export function loadNotoCjk(): Promise<Font> {
  loaded ??= fontFileBytes(FONT_URL, 'CJK fallback font').then(
    (bytes) => openFont(bytes),
    (error: unknown) => {
      loaded = undefined;
      throw error;
    },
  );
  return loaded;
}

/** The font dictionary a glyph of a CID-keyed CFF font uses (0 for a font with one). */
function fontDictOf(font: Font): (gid: number) => number {
  const cff = (font as unknown as { 'CFF '?: { fdForGlyph(gid: number): number | null } })['CFF '];
  return (gid) => cff?.fdForGlyph(gid) ?? 0;
}

/**
 * fontkit 1.1.1 writes the source font's table length into the CFF header's offSize byte (CFFSubset.encode), which must be
 * 1 to 4 (CFF spec §6), and poppler refuses the font for it. The byte is set to the size this file's offsets need.
 */
function withOffSize(program: Uint8Array): Uint8Array {
  const out = program.slice();
  out[3] = out.length < 0x100 ? 1 : out.length < 0x10000 ? 2 : out.length < 0x1000000 ? 3 : 4;
  return out;
}

interface SubsetGlyphs {
  /** The source glyph of each glyph in the subset, in order: the index is the CID (the CFF subset's charset is 0, 1, 2, …). */
  glyphs: number[];
}

/**
 * A new CID for one character, drawn with the given source glyph. `includeGlyph` would give a glyph already in the subset
 * its existing CID, so two characters the font draws with one glyph (‧ U+2027 and ・ U+30FB, ① U+2460 and ➀ U+2780) would
 * share a CID: the ToUnicode map could name only one of them, and only one width could be stated for both. The glyph's
 * charstring is written once for each CID instead, as the emoji subset gives each unit its own CID (emoji-font.ts).
 */
function mintCid(subset: ReturnType<Font['createSubset']>, gid: number): number {
  const internals = subset as unknown as SubsetGlyphs;
  internals.glyphs.push(gid);
  return internals.glyphs.length - 1;
}

/**
 * The fallback subset for a set of characters: the glyphs of the ones the font maps, in code point order, as a CFF
 * font program. A character the font does not map is left out; the writer prints it as "?".
 */
export async function subsetNotoCjk(font: Font, characters: Iterable<string>): Promise<PdfCidFont> {
  const scale = 1000 / font.unitsPerEm;
  const codeOf = (ch: string): number => ch.codePointAt(0) ?? 0;
  const fdOf = fontDictOf(font);
  const notdef = fdOf(0);
  // fontkit 1.1.1 gives each glyph of a CID-keyed subset the font dictionary added last, not its own (CFFSubset.subsetFontdict).
  // The glyphs are therefore included grouped by font dictionary, .notdef's first, which makes the two the same.
  const chars = [...new Set(characters)]
    .filter((ch) => font.hasGlyphForCodePoint(codeOf(ch)))
    .map((ch) => ({ ch, glyph: font.glyphForCodePoint(codeOf(ch)) }))
    .map((entry) => ({ ...entry, fd: fdOf(entry.glyph.id) }))
    .sort((a, b) => Number(b.fd === notdef) - Number(a.fd === notdef) || a.fd - b.fd || codeOf(a.ch) - codeOf(b.ch));
  const subset = font.createSubset();
  const glyphs = new Map<string, PdfCidGlyph>();
  const widths: number[] = [];
  for (const { ch, glyph } of chars) {
    const cid = mintCid(subset, glyph.id);
    // The stated advance is the character's cell on the grid, 600 a column, whatever the glyph's own advance.
    const width = charColumns(ch) * 600;
    widths[cid] = width;
    glyphs.set(ch, { cid, width });
  }
  const key = chars.map((entry) => entry.ch).join('');
  const bbox = font.bbox;
  return {
    baseFont: `${subsetTag(key)}+${NOTO_CJK_POSTSCRIPT_NAME}`,
    program: withOffSize(await encodeSubset(subset)),
    glyphs,
    widths: widths.slice(1).map((w) => w ?? 1000),
    bbox: [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY].map((v) => Math.round(v * scale)) as [number, number, number, number],
    ascent: Math.round(font.ascent * scale),
    descent: Math.round(font.descent * scale),
    capHeight: Math.round(font.capHeight * scale),
  };
}
