/**
 * Synthetic bold for the fallback fonts of both PDFs ([storyboard.md](../../../docs/architecture/storyboard.md) §6). The contact
 * sheet uses it today (`packages/exporter/src/cid-embedding.ts`, `render-contact-sheet.ts`); the screenplay PDF draws no bold yet,
 * and a bold heading there would take its fallback runs from here too.
 *
 * Noto Sans Mono CJK SC and Noto Emoji are embedded in their Regular weight only. A run set in bold (on the contact sheet, the header
 * title, the page label, the number chip) is drawn in the same glyphs with text rendering mode 2 (`2 Tr`: fill and stroke), the
 * stroke in the ink of the fill, with round joins (`1 j`), so the glyph grows by half the line width on every side. Mode 2 changes
 * no advance, so each glyph also takes a character spacing (`Tc`) of one line width, which gives back what the stroke took from the
 * gap between two glyphs; a writer that fits text to a box adds {@link emboldenedExtra} to the run's regular width. Glyphs, CIDs and
 * ToUnicode entries are the regular run's, so copying the text gives it back unchanged. The writer pushes the graphics state before
 * the run and pops it after (`q` … `Q`), so neither the mode nor the line width reaches the text after it.
 *
 * The line width is {@link EMBOLDEN_RATIO} of the font size, 0.025 em. It was chosen from renders of the header (title and page label,
 * 11 pt) and the chip (8 pt) at 0.02, 0.025, 0.035 and 0.05 in pdf.js and MuPDF, and checked in Poppler (`pdftocairo`, 300 dpi) at
 * 8, 11 and 14 pt: 0.02 is the least that reads as bold beside Helvetica-Bold, 0.025 is clearly bold at every size with the counters
 * of 鬱 and 龘 still open, from 0.035 those counters start to close (in Poppler 龘 fills in at 14 pt) and at 0.05 the dense characters
 * are blots. A real Bold weight of the font would be a second vendored file and a second download; it is not built.
 */

/** The stroke's line width as a fraction of the font size. */
export const EMBOLDEN_RATIO = 0.025;

/** The line width and the character spacing of a bold run at a size, in points. */
export function emboldenOf(size: number): { readonly lineWidth: number; readonly spacing: number } {
  const lineWidth = size * EMBOLDEN_RATIO;
  return { lineWidth, spacing: lineWidth };
}

/** The width a bold run of `glyphs` glyphs adds to its regular width at a size: one character spacing after each. */
export function emboldenedExtra(glyphs: number, size: number): number {
  return glyphs * emboldenOf(size).spacing;
}
