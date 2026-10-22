/**
 * editor-engine.md [§9](docs/architecture/editor-engine.md)'s counting rule, in
 * exactly one place.
 *
 * **§9, quoted:** *"Word/char counts computed from the PM doc per revision
 * (words = block text split on whitespace, except that a token in an unspaced
 * script is counted by word segmentation; chars = body-projection length)"*.
 *
 * **Why this file exists rather than a `countWords` inside whichever module
 * happens to need it.** docs/decisions.md rejected a word count inside
 * `sessions.ts` on one ground and one only: *"two word-count rules is the drift
 * the corpus spends its §2 discipline preventing, and the wrong one would be the
 * one that shipped first."* That reasoning names the duplicate, not this
 * function — so the fix is a single exported rule that both the live producer
 * (`setBody`) and the loader's rebuild call, rather than each computing its own.
 *
 * **Why it lives in the store, where §9 says the ProseMirror document is.** The
 * direction is fixed by the manifests: `@caotang/store` does not depend on
 * `@caotang/editor`, and `@caotang/editor` depends on the store. A rule the loader
 * can reach therefore cannot live in the editor — and `project-format.md` §2's
 * *"loader recomputes on open if absent"* has no editor to ask, on load, at all.
 *
 * **What is counted is the body projection, and that is already decided rather
 * than open here.** docs/decisions.md measured and pinned the awkward half:
 * *"§9's word count counts a blockquote marker as a word. §9 says 'words = block
 * text split on whitespace', and the body projection's block text carries the
 * `>`. Measured (`> quoted` → 2 words) and pinned rather than quietly fixed,
 * because a count that excluded it is a different rule and §9 does not state
 * one."* This module is that rule, so the reading has one implementation instead
 * of one per caller.
 *
 * **The counts are a cache, and §2's own words are why that is safe.** "Derived,
 * rebuildable, allowed stale. Never a reason to reject a manifest."
 */

/** §9's two numbers for one body. */
export interface BodyCount {
  /** block text split on whitespace; an unspaced-script token is segmented */
  readonly words: number;
  /** body-projection length */
  readonly chars: number;
}

/**
 * Version of the words rule a cache was counted with (`derived.ruleVersion`,
 * absent = 1). 1 is the plain whitespace split; 2 adds the segmentation below.
 */
export const WORD_RULE_VERSION = 2;

/**
 * Han, kana, Thai, Lao, Khmer and Myanmar write words without spaces between
 * them. `scx` for the CJK scripts so their own punctuation (`。`, `ー`) takes the
 * same path as the text around it. Hangul, Latin, Greek, Cyrillic and Vietnamese
 * are spaced and never match.
 */
const UNSPACED = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

let cached: { readonly ctor: unknown; readonly instance: Intl.Segmenter | undefined } | undefined;

/**
 * One word segmenter for the process, with a fixed locale so the browser and
 * Node/MCP count the same text the same way. Rebuilt only if `Intl.Segmenter` is
 * replaced; `undefined` where the engine has none.
 */
function segmenter(): Intl.Segmenter | undefined {
  const ctor: unknown = typeof Intl === 'undefined' ? undefined : (Intl as { Segmenter?: unknown }).Segmenter;
  if (cached !== undefined && cached.ctor === ctor) return cached.instance;
  let instance: Intl.Segmenter | undefined;
  if (typeof ctor === 'function') {
    try {
      instance = new Intl.Segmenter('und', { granularity: 'word' });
    } catch {
      instance = undefined;
    }
  }
  cached = { ctor, instance };
  return instance;
}

/** The rule this engine counts with: 2 when `Intl.Segmenter` is available, else 1. */
export function wordRuleInUse(): 1 | 2 {
  return segmenter() === undefined ? 1 : 2;
}

/** Words in one whitespace-free token that contains an unspaced-script character. */
function segmentedWords(token: string, seg: Intl.Segmenter | undefined): number {
  let n = 0;
  if (seg !== undefined) {
    for (const part of seg.segment(token)) if (part.isWordLike) n++;
    return n;
  }
  // No segmenter: each unspaced character is a word, and so is each run of the
  // rest. Never throws and never counts fewer than the whitespace split.
  let inRun = false;
  for (const ch of token) {
    if (UNSPACED.test(ch)) {
      n++;
      inRun = false;
    } else if (!inRun) {
      n++;
      inRun = true;
    }
  }
  return n;
}

/**
 * §9's rule over one body projection.
 *
 * A body of only whitespace is **0 words**, not 1: `''.split(/\s+/)` is `['']`,
 * so the empty case has to be named or an empty document counts as a word. The
 * same is true of a body of only a separator, which is why the trim comes before
 * the split rather than the split being filtered afterwards.
 *
 * Every token counts 1 unless it holds an unspaced-script character, so spaced
 * scripts count as the whitespace split always has (`well-known` and `don't` are
 * one word, a `>` marker is another) and only Han, kana, Thai, Lao, Khmer and
 * Myanmar text goes through the segmenter. That count is approximate: engines'
 * dictionaries differ.
 */
export function countBody(body: string): BodyCount {
  const trimmed = body.trim();
  if (trimmed.length === 0) return { words: 0, chars: body.length };
  const tokens = trimmed.split(/\s+/);
  if (!UNSPACED.test(trimmed)) return { words: tokens.length, chars: body.length };
  const seg = segmenter();
  let words = 0;
  for (const token of tokens) words += UNSPACED.test(token) ? segmentedWords(token, seg) : 1;
  return { words, chars: body.length };
}
