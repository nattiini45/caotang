/**
 * What the export dialog's Proof shows (exporter.md §4, the Proof): the start of the file the compile would write, cut where a long file
 * would make the dialog slow, and the words for the formats that have no Proof. Pure, so the cut and the words are tested without a page.
 */

/** The most characters a Proof shows. A cut may end earlier, at a line end; a longer file says how much of it is shown, and the compile writes it all. */
export const PROOF_CHAR_CAP = 60_000;

export interface ProofExcerpt {
  /** The text shown: the whole file, or its start, ending at a line's end when one is near the cap. */
  readonly text: string;
  /** Characters (UTF-16 code units, as the browser counts them) shown, and in the whole file. They differ when the file is cut. */
  readonly shownChars: number;
  readonly totalChars: number;
}

/**
 * The start of a file, up to `cap` characters. A cut ends at the last line break inside the cap when there is one in its last quarter, so
 * a line is not cut in half, and never between the two halves of a character outside the Basic Multilingual Plane.
 */
export function proofExcerpt(text: string, cap: number = PROOF_CHAR_CAP): ProofExcerpt {
  if (text.length <= cap) return { text, shownChars: text.length, totalChars: text.length };
  let end = cap;
  const lineEnd = text.lastIndexOf('\n', cap - 1);
  if (lineEnd >= Math.floor(cap * 0.75)) end = lineEnd + 1;
  else {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return { text: text.slice(0, end), shownChars: end, totalChars: text.length };
}
