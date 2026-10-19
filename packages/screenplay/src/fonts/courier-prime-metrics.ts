/**
 * The metrics of Courier Prime Regular that a PDF font descriptor states (PDF 1.7 §9.8), in the PDF's glyph space of
 * 1000 units to the em. They are read from the font's own `head`, `hhea`, `OS/2` and `hmtx` tables (2048 units to the
 * em) and scaled; test/pdf-font.test.ts reads the same tables from the embedded file and checks every figure here.
 *
 * Courier Prime is monospaced. Every glyph WinAnsi can name is 1228 of 2048 units wide (599.6 of 1000), which the
 * PDF states as 600, the width of Courier. So the layout's 7.2 points a character at 12 points holds for both fonts.
 */
export const COURIER_PRIME_METRICS = Object.freeze({
  /** The PostScript name, as the font's `name` table gives it. */
  postScriptName: 'CourierPrime',
  unitsPerEm: 2048,
  /** The advance of every glyph, in font units. */
  advanceUnits: 1228,
  /** The advance the PDF states, in glyph space. */
  width: 600,
  bbox: [-371, -257, 1568, 892] as const,
  ascent: 781,
  descent: -342,
  capHeight: 580,
  xHeight: 451,
  italicAngle: 0,
  /** Not stored in a TrueType font. 80 is a regular weight's figure; viewers use it only when they substitute a font. */
  stemV: 80,
  /** FixedPitch (bit 1) and Nonsymbolic (bit 6): a monospaced text font whose glyphs the standard Latin set names. */
  flags: 33,
});
