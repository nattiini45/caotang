/**
 * The metrics of Cousine Regular that a PDF font descriptor states (PDF 1.7 §9.8), in the PDF's glyph space of 1000
 * units to the em. They are read from the font's own `head`, `hhea`, `OS/2` and `hmtx` tables (2048 units to the em) and
 * scaled; test/pdf-font.test.ts reads the same tables from the embedded file and checks every figure here.
 *
 * Cousine is monospaced and metric-compatible with Courier New. Every glyph is 1229 of 2048 units wide (600.1 of 1000),
 * which the PDF states as 600, so the layout's 7.2 points a character at 12 points holds.
 */
export const COUSINE_METRICS = Object.freeze({
  /** The PostScript name, as the font's `name` table gives it. */
  postScriptName: 'Cousine-Regular',
  unitsPerEm: 2048,
  /** The advance of every glyph, in font units. */
  advanceUnits: 1229,
  /** The advance the PDF states, in glyph space. */
  width: 600,
  bbox: [-482, -300, 743, 981] as const,
  ascent: 833,
  descent: -300,
  capHeight: 659,
  xHeight: 528,
  italicAngle: 0,
  /** Not stored in a TrueType font. 80 is a regular weight's figure; viewers use it only when they substitute a font. */
  stemV: 80,
  /** FixedPitch (bit 1) and Nonsymbolic (bit 6). */
  flags: 33,
});
