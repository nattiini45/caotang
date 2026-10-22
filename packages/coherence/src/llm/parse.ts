/**
 * Reads model replies back in — [coherence.md §5.3](../../../../docs/architecture/coherence.md).
 *
 * The rule that runs through this file: a quote in a finding is a verbatim slice
 * of the body projection, and an offset that does not match the quote is never
 * kept as it stands. A quote that appears exactly once in the document is
 * relocated to where it is. A quote that appears nowhere, or more than once, is
 * dropped with a note. The spec's Stage 1 contract says "character-level offsets";
 * this is how the engine makes them true instead of trusting them.
 */

import { EVIDENCE_QUOTE_LIMIT, LLM_CATEGORIES, type Evidence, type LlmCategory } from '../model.js';
import { MalformedReplyError } from '../errors.js';
import { codePointLength, codePointPrefix } from '../text.js';

import { SPANS_PER_DOCUMENT } from './prompts.js';

type Obj = Record<string, unknown>;

const FENCE = '```';
const JSON_TAG = /^json$/i;
const NOTE_CHARS = 300;

function isRecord(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * The text inside a code fence that spans all of `text`, or `undefined` when it is not
 * one. Scans for the two fences directly: a single regex with `\s*` and a lazy group
 * between them backtracks quadratically on a long run of whitespace. The result is
 * not trimmed.
 */
function unfence(text: string): string | undefined {
  if (text.length < 2 * FENCE.length || !text.startsWith(FENCE) || !text.endsWith(FENCE)) return undefined;
  const tagEnd = FENCE.length + 4;
  const start = JSON_TAG.test(text.slice(FENCE.length, tagEnd)) ? tagEnd : FENCE.length;
  return text.slice(start, text.length - FENCE.length);
}

/**
 * Parses a reply to a JSON object. A fenced block is unwrapped, since providers
 * often wrap one. Anything else that is not an object is a malformed reply.
 */
export function parseJsonReply(content: string, stage: string): Obj {
  let text = content.trim();
  const fenced = unfence(text);
  if (fenced !== undefined) text = fenced.trim();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new MalformedReplyError(stage, 'the reply is not JSON');
  }
  if (!isRecord(value)) throw new MalformedReplyError(stage, 'the top level is not an object');
  return value;
}

/** The one place a quote's offsets are verified. Returns the offsets the quote actually has, or `undefined`. */
export function locateQuote(body: string, quote: string, from: number, to: number): { from: number; to: number } | undefined {
  if (quote === '') return undefined;
  if (from <= to && body.slice(from, to) === quote) return { from, to };
  const first = body.indexOf(quote);
  if (first < 0) return undefined;
  if (body.indexOf(quote, first + 1) >= 0) return undefined;
  return { from: first, to: first + quote.length };
}

export interface ExtractedSpan {
  readonly docId: string;
  readonly from: number;
  readonly to: number;
  readonly quote: string;
  readonly category: LlmCategory;
  readonly note: string;
}

export interface ExtractionParse {
  readonly spans: ExtractedSpan[];
  readonly notes: string[];
}

/** A scene in a run note: its title in quotes, or a plain phrase when the run was not given one. */
function sceneNameOf(document: { readonly title?: string }): string {
  return document.title === undefined || document.title.trim() === '' ? 'the scene' : `"${document.title}"`;
}

/** A pair in a run note: `pair 3`, the number the writer can count. A pair without a number is `a pair`. */
export function pairLabelOf(pair: { readonly ordinal?: number } | undefined): string {
  return pair?.ordinal === undefined ? 'a pair' : `pair ${pair.ordinal}`;
}

/**
 * Stage 1 reply. Each span is checked on its own, so one bad span costs one span
 * and the note says which. Duplicates of the same range are dropped, and the
 * spec's per-document cap of twenty is enforced here as well as in the prompt.
 */
export function parseExtraction(
  content: string,
  document: { readonly docId: string; readonly body: string; readonly title?: string },
): ExtractionParse {
  const root = parseJsonReply(content, 'extraction');
  if (!Array.isArray(root.spans)) throw new MalformedReplyError('extraction', 'spans is not a list');
  const notes: string[] = [];
  const spans: ExtractedSpan[] = [];
  const seen = new Set<string>();
  root.spans.forEach((raw: unknown, index: number) => {
    if (spans.length >= SPANS_PER_DOCUMENT) return;
    const span = readSpan(raw, document, index, notes);
    if (span === undefined) return;
    const key = `${span.from}:${span.to}`;
    if (seen.has(key)) return;
    seen.add(key);
    spans.push(span);
  });
  if (root.spans.length > SPANS_PER_DOCUMENT) {
    notes.push(`${sceneNameOf(document)} returned ${root.spans.length} spans; only the first ${SPANS_PER_DOCUMENT} are kept`);
  }
  return { spans, notes };
}

function readSpan(
  raw: unknown,
  document: { readonly docId: string; readonly body: string; readonly title?: string },
  index: number,
  notes: string[],
): ExtractedSpan | undefined {
  if (!isRecord(raw)) {
    notes.push(`span ${index} is not an object and was dropped`);
    return undefined;
  }
  if (raw.docId !== undefined && raw.docId !== document.docId) {
    notes.push(`span ${index} names another document, not ${sceneNameOf(document)}; dropped`);
    return undefined;
  }
  if (!(LLM_CATEGORIES as readonly unknown[]).includes(raw.category)) {
    notes.push(`span ${index} has a category outside the enum; dropped`);
    return undefined;
  }
  if (typeof raw.quote !== 'string' || raw.quote === '' || codePointLength(raw.quote) > EVIDENCE_QUOTE_LIMIT) {
    notes.push(`span ${index} has an empty or over-long quote; dropped`);
    return undefined;
  }
  if (!isOffset(raw.from) || !isOffset(raw.to)) {
    notes.push(`span ${index} has non-integer offsets; dropped`);
    return undefined;
  }
  const located = locateQuote(document.body, raw.quote, raw.from, raw.to);
  if (located === undefined) {
    notes.push(`span ${index} is not a verbatim slice of the document; dropped`);
    return undefined;
  }
  return {
    docId: document.docId,
    from: located.from,
    to: located.to,
    quote: raw.quote,
    category: raw.category as LlmCategory,
    note: typeof raw.note === 'string' ? codePointPrefix(raw.note, NOTE_CHARS) : '',
  };
}

/** A span as the verification stage knows it: where it is, and which document holds it. */
export interface SpanRange {
  readonly docId: string;
  readonly from: number;
  readonly to: number;
}

export interface ParsedVerdict {
  readonly pairId: string;
  readonly verdict: 'contradictory' | 'consistent' | 'unclear';
  readonly reasoning: string;
  /** Raw entity and attribute from the model. Normalised later against the codex (§4.2). */
  readonly entity: string;
  readonly attribute: string;
  /**
   * The model's two passages, when they check out verbatim and are the pair's own two
   * spans, in the pair's order (first `a`, then `b`). `undefined` means the caller uses
   * the pair's own spans, which Stage 1 already verified.
   */
  readonly evidence?: readonly Evidence[];
}

export interface VerificationParse {
  readonly verdicts: ParsedVerdict[];
  readonly notes: string[];
}

/** What verification reads back against: the bodies the run holds, and each pair of the batch that was sent. */
export interface VerificationKnown {
  readonly bodies: ReadonlyMap<string, string>;
  /** The pairs of this batch, by id. A verdict for any other pair is dropped. `ordinal` is the number a note names the pair by. */
  readonly pairs: ReadonlyMap<string, { readonly a: SpanRange; readonly b: SpanRange; readonly ordinal?: number }>;
}

const VERDICTS = ['contradictory', 'consistent', 'unclear'] as const;

/** Two ranges overlap when they share a character in the same document. */
function overlaps(passage: SpanRange, span: SpanRange): boolean {
  return passage.docId === span.docId && passage.from < span.to && span.from < passage.to;
}

type EvidenceCheck =
  | { readonly ok: true; readonly evidence: Evidence[] }
  | { readonly ok: false; readonly reason: 'not-verbatim' | 'not-the-pair' };

/**
 * A verdict's passages are kept only when they are verbatim, and when they are the
 * pair's own two passages, in either order, each overlapping the span it stands for.
 * Passages from another document or another part of one would make the finding quote
 * text the pair does not contain (§5.3 Stage 2: the evidence is the pair).
 */
function checkedEvidence(raw: unknown, known: VerificationKnown, pair: { readonly a: SpanRange; readonly b: SpanRange }): EvidenceCheck {
  if (!Array.isArray(raw) || raw.length !== 2) return { ok: false, reason: 'not-verbatim' };
  const items: Evidence[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.docId !== 'string' || typeof item.quote !== 'string') return { ok: false, reason: 'not-verbatim' };
    if (!isOffset(item.from) || !isOffset(item.to)) return { ok: false, reason: 'not-verbatim' };
    const body = known.bodies.get(item.docId);
    if (body === undefined || item.quote === '' || codePointLength(item.quote) > EVIDENCE_QUOTE_LIMIT) return { ok: false, reason: 'not-verbatim' };
    if (body.slice(item.from, item.to) !== item.quote) return { ok: false, reason: 'not-verbatim' };
    items.push({ docId: item.docId, quote: item.quote, from: item.from, to: item.to });
  }
  const [first, second] = items;
  if (first === undefined || second === undefined) return { ok: false, reason: 'not-verbatim' };
  if (overlaps(first, pair.a) && overlaps(second, pair.b)) return { ok: true, evidence: [first, second] };
  if (overlaps(second, pair.a) && overlaps(first, pair.b)) return { ok: true, evidence: [second, first] };
  return { ok: false, reason: 'not-the-pair' };
}

/**
 * Stage 2 reply. A verdict for a pair that was not in the batch is dropped. A
 * contradiction with no reasoning or no factGroup is dropped too, because a
 * finding the writer cannot read or group is not worth recording.
 */
export function parseVerification(content: string, known: VerificationKnown): VerificationParse {
  const root = parseJsonReply(content, 'verification');
  if (!Array.isArray(root.verdicts)) throw new MalformedReplyError('verification', 'verdicts is not a list');
  const notes: string[] = [];
  const verdicts: ParsedVerdict[] = [];
  for (const raw of root.verdicts as unknown[]) {
    if (!isRecord(raw)) {
      notes.push('a verdict is not an object and was dropped');
      continue;
    }
    const pair = typeof raw.pairId === 'string' ? known.pairs.get(raw.pairId) : undefined;
    if (typeof raw.pairId !== 'string' || pair === undefined) {
      notes.push('a verdict names a pair that is not in its batch; dropped');
      continue;
    }
    const label = pairLabelOf(pair);
    if (!(VERDICTS as readonly unknown[]).includes(raw.verdict)) {
      notes.push(`${label} has a verdict outside the enum; dropped`);
      continue;
    }
    const verdict = raw.verdict as ParsedVerdict['verdict'];
    const reasoning = typeof raw.reasoning === 'string' ? raw.reasoning.trim() : '';
    const group = isRecord(raw.factGroup) ? raw.factGroup : {};
    const entity = typeof group.entity === 'string' ? group.entity.trim() : '';
    const attribute = typeof group.attribute === 'string' ? group.attribute.trim() : '';
    if (verdict === 'contradictory' && (reasoning === '' || entity === '' || attribute === '')) {
      notes.push(`${label} is contradictory but has no reasoning or no factGroup; dropped`);
      continue;
    }
    const checked = checkedEvidence(raw.evidence, known, pair);
    if (verdict === 'contradictory' && !checked.ok) {
      notes.push(
        checked.reason === 'not-the-pair'
          ? `${label}: the model's passages are not the pair's two passages; the pair's own passages are used`
          : `${label}: the model's passages were not verbatim; the pair's own passages are used`,
      );
    }
    verdicts.push({
      pairId: raw.pairId,
      verdict,
      reasoning,
      entity,
      attribute,
      ...(checked.ok ? { evidence: checked.evidence } : {}),
    });
  }
  return { verdicts, notes };
}
