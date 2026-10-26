/**
 * Synthetic bold for the fallback fonts of the contact-sheet PDF ([storyboard.md](../../../docs/architecture/storyboard.md) §6).
 *
 * Noto Sans Mono CJK SC and Noto Emoji are embedded in their Regular weight only. A run set in bold (the header title, the page
 * label, the number chip) is drawn in the same glyphs with text rendering mode 2 (`2 Tr`: fill and stroke), the stroke in the
 * ink of the fill, with round joins, so the glyph grows by half the line width on every side. Mode 2 changes no advance, so each
 * glyph also takes a character spacing (`Tc`) of one line width, which gives back what the stroke took from the gap between
 * two glyphs. Glyphs, CIDs and ToUnicode entries are the regular run's, so copying the text gives it back unchanged; the graphics
 * state is pushed before the run and popped after it, so neither the mode nor the line width reaches the Helvetica text after it.
 *
 * The line width is {@link EMBOLDEN_RATIO} of the font size, 0.025 em. It was chosen from renders of the header (title and page label,
 * 11 pt) and the chip (8 pt) at 0.02, 0.025, 0.035 and 0.05 in pdf.js and MuPDF: 0.02 is the least that reads as bold beside
 * Helvetica-Bold, 0.025 is clearly bold at both sizes with the counters of 鬱 and 龘 still open, and from 0.035 those counters
 * start to close and at 0.05 the dense characters are blots. The real Bold font is a follow-up (issue #39).
 */

/** The stroke's line width as a fraction of the font size. */
export const EMBOLDEN_RATIO = 0.025;

/** The line width and the character spacing of a bold run at a size, in points. */
export function emboldenOf(size: number): { readonly lineWidth: number; readonly spacing: number } {
  const lineWidth = size * EMBOLDEN_RATIO;
  return { lineWidth, spacing: lineWidth };
}

/** The width a bold run of `glyphs` code points adds to its regular width at a size: one character spacing after each. */
export function emboldenedExtra(glyphs: number, size: number): number {
  return glyphs * emboldenOf(size).spacing;
}
