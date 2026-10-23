/**
 * What a reader copies from a right-to-left word the file draws glyph by glyph: the text of each glyph (its CID's ToUnicode entry)
 * in the order the glyphs are drawn, left to right, and that order reversed, which is the logical order of a word of a script
 * written right to left. The writer carries no `/ActualText` for such a word: this is all a reader has, and the bidirectional
 * algorithm of the reader puts the glyphs back in order.
 */

import type { CidSubset } from '@caotang/pdf-fonts';

import type { PdfRtlItem } from '../../src/pdf.js';

/** The entry of a CID: the one numbered with it, or the one at its place in the list when the entries carry no CID of their own. */
export const entryOf = (subset: CidSubset, cid: number): CidSubset['entries'][number] | undefined =>
  subset.entries.find((entry) => entry.cid === cid) ?? (subset.entries.every((entry) => entry.cid === undefined) ? subset.entries[cid - 1] : undefined);

/** The ToUnicode text of the glyphs of a shaped item, in the order they are drawn (left to right). */
export function drawnTexts(item: PdfRtlItem | undefined, subset: CidSubset | undefined): string[] {
  if (item?.kind !== 'shaped' || subset === undefined) return [];
  return item.glyphs.map((glyph) => entryOf(subset, glyph.cid)?.text ?? '');
}

/** The text of a word of a right-to-left script as a reader puts it together: the drawn glyphs' texts, last drawn first. */
export function copiedRtl(item: PdfRtlItem | undefined, subset: CidSubset | undefined): string {
  return drawnTexts(item, subset).reverse().join('');
}
