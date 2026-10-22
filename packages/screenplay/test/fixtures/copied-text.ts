/**
 * What a reader copies from a right-to-left word the file draws glyph by glyph: the text of each glyph (its CID's ToUnicode entry)
 * in the order the glyphs are drawn, left to right, and that order reversed, which is the logical order of a word of a script
 * written right to left. The writer carries no `/ActualText` for such a word: this is all a reader has, and the bidirectional
 * algorithm of the reader puts the glyphs back in order.
 */

import type { CidSubset } from '@caotang/pdf-fonts';

import type { PdfRtlItem } from '../../src/pdf.js';

/** The ToUnicode text of the glyphs of a shaped item, in the order they are drawn (left to right). */
export function drawnTexts(item: PdfRtlItem | undefined, subset: CidSubset | undefined): string[] {
  if (item?.kind !== 'shaped' || subset === undefined) return [];
  return item.glyphs.map((glyph) => subset.entries[glyph.cid - 1]?.text ?? '');
}

/** The text of a word of a right-to-left script as a reader puts it together: the drawn glyphs' texts, last drawn first. */
export function copiedRtl(item: PdfRtlItem | undefined, subset: CidSubset | undefined): string {
  return drawnTexts(item, subset).reverse().join('');
}
