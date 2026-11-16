/**
 * Candidate pairs for Stage 2 — [coherence.md §5.3](../../../../docs/architecture/coherence.md).
 *
 * Pairs are formed only within a category, because the spec pairs spans "of the
 * same category". Within that, every unordered pair is a candidate: the spec sets
 * no narrower rule, and the plan card's cost estimate has to be an honest bound.
 * Pair ids are assigned in a deterministic order, so the same spans always yield
 * the same batches and the same evals.
 */

import { LLM_CATEGORIES, type LlmCategory } from '../model.js';

import type { ExtractedSpan } from './parse.js';
import { PAIR_CONTEXT_CHARS, PAIRS_PER_CALL, type PairBlock } from './prompts.js';

export interface PairRef {
  readonly pairId: string;
  /** The pair's place in the run, from 1: the number a run note names it by ("pair 3"), since the id is for the model. */
  readonly ordinal: number;
  readonly category: LlmCategory;
  readonly a: ExtractedSpan;
  readonly b: ExtractedSpan;
}

/** Spans sorted by document, then offset, with exact duplicates removed. */
export function orderedSpans(spans: readonly ExtractedSpan[]): ExtractedSpan[] {
  const seen = new Set<string>();
  const unique: ExtractedSpan[] = [];
  for (const span of spans) {
    const key = `${span.docId}\u0000${span.from}\u0000${span.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(span);
  }
  return unique.sort((a, b) => (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : a.from - b.from || a.to - b.to));
}

export function* pairSequence(spans: readonly ExtractedSpan[], categories: readonly LlmCategory[] = LLM_CATEGORIES): Generator<PairRef> {
  const ordered = orderedSpans(spans);
  let count = 0;
  for (const category of LLM_CATEGORIES) {
    if (!categories.includes(category)) continue;
    const group = ordered.filter((span) => span.category === category);
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        if (a === undefined || b === undefined) continue;
        count += 1;
        yield { pairId: `p${count}`, ordinal: count, category, a, b };
      }
    }
  }
}

/** Every unordered pair of same-category spans, in category order, with sequential ids `p1`, `p2`, … */
export function candidatePairs(spans: readonly ExtractedSpan[], categories: readonly LlmCategory[] = LLM_CATEGORIES): PairRef[] {
  return [...pairSequence(spans, categories)];
}

/** A pair's identity across compositions: its category and both spans' document and offsets, in the order `orderedSpans` puts them. Pair ids are sequential over one composition, so a resume that extracts further spans renumbers them; this key does not change. */
export function pairKey(pair: PairRef): string {
  const span = (s: ExtractedSpan): string => `${s.docId}\u0000${s.from}\u0000${s.to}`;
  return `${pair.category}\u0000${span(pair.a)}\u0000${span(pair.b)}`;
}

/** Splits pairs into calls of at most {@link PAIRS_PER_CALL}. */
export function batchPairs(pairs: readonly PairRef[], size: number = PAIRS_PER_CALL): PairRef[][] {
  const batches: PairRef[][] = [];
  for (let i = 0; i < pairs.length; i += size) batches.push(pairs.slice(i, i + size));
  return batches;
}

/** Number of unordered pairs among `n` items. The plan's upper bound is built from it. */
export function pairCount(n: number): number {
  return n < 2 ? 0 : (n * (n - 1)) / 2;
}

/** A span with ±{@link PAIR_CONTEXT_CHARS} of its document on each side (§5.3 Stage 2). */
export function blockFor(pair: PairRef, bodies: ReadonlyMap<string, string>): PairBlock | undefined {
  const side = (span: ExtractedSpan): PairBlock['a'] | undefined => {
    const body = bodies.get(span.docId);
    if (body === undefined) return undefined;
    return {
      docId: span.docId,
      from: span.from,
      to: span.to,
      quote: span.quote,
      before: body.slice(Math.max(0, span.from - PAIR_CONTEXT_CHARS), span.from),
      after: body.slice(span.to, span.to + PAIR_CONTEXT_CHARS),
    };
  };
  const a = side(pair.a);
  const b = side(pair.b);
  if (a === undefined || b === undefined) return undefined;
  return { pairId: pair.pairId, category: pair.category, a, b };
}
