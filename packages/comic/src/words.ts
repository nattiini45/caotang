/**
 * Script-aware word counting for the density lint.
 *
 * This restates the rule of `packages/store/src/word-count.ts` (editor-engine.md §9: split on whitespace, and
 * segment a token that holds an unspaced script). It is restated, not imported, because `@caotang/comic` must not
 * depend on the store. If that rule changes, change this one with it.
 */

const UNSPACED =
  /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

let segmenterCache: Intl.Segmenter | undefined | null = null;

function segmenter(): Intl.Segmenter | undefined {
  if (segmenterCache === null) {
    try {
      segmenterCache = new Intl.Segmenter('und', { granularity: 'word' });
    } catch {
      segmenterCache = undefined;
    }
  }
  return segmenterCache;
}

function segmentedWords(token: string): number {
  const seg = segmenter();
  let n = 0;
  if (seg !== undefined) {
    for (const part of seg.segment(token)) if (part.isWordLike) n += 1;
    return n;
  }
  let inRun = false;
  for (const ch of token) {
    if (UNSPACED.test(ch)) {
      n += 1;
      inRun = false;
    } else if (!inRun) {
      n += 1;
      inRun = true;
    }
  }
  return n;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  const tokens = trimmed.split(/\s+/);
  if (!UNSPACED.test(trimmed)) return tokens.length;
  let words = 0;
  for (const token of tokens) words += UNSPACED.test(token) ? segmentedWords(token) : 1;
  return words;
}
