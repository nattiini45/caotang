/**
 * The pure half of the P14 transcription review gate (pictures.md §8.4 step 3): which approved text a
 * re-transcription is diffed against, the ghost's highlight spans, and the writer's answer as one
 * validated result in the plan's order.
 *
 * No React, no session, no writes: the dialog (`TranscriptionReviewDialog.tsx`) renders with these, and the
 * broker (`../app/transcription-review.ts`) holds the transient proposal. Nothing here dispatches anything —
 * the harness port publishes `asset.transcribe` only after the writer approves.
 */

import { compareTranscriptionReads } from '@caotang/harness';
import type {
  PictureTranscriptionPlan,
  PictureTranscriptionReviewedPage,
  PictureTranscriptionReviewResult,
  PictureTranscriptionReviewPage,
  TranscriptionDisagreement,
} from '@caotang/harness';
import type { AssetLink, AssetTranscription, ReadAssetLink } from '@caotang/pictures';

/* ------------------------------------------------------------------ *
 * The approved text a re-transcription is diffed against (§8.4 steps 3–4)
 * ------------------------------------------------------------------ */

/** Where the document bodies and the link list come from, so this module stays free of the store. */
export interface ApprovedTextSource {
  /** The current body of one document, or `undefined` when the project holds none for that id. */
  readonly bodyOf: (docId: string) => string | undefined;
  /** The project's `assetLinks` list, as the manifest holds it. */
  readonly links: readonly (AssetLink | ReadAssetLink)[] | undefined;
}

/** A loose structural read of a link's target, so a link from a newer build still reads (§2.1 load rules). */
interface LooseTarget {
  readonly kind?: unknown;
  readonly nodeId?: unknown;
  readonly anchor?: { readonly from?: unknown };
}

/**
 * The approved text of one page, for the re-transcription diff of §8.4 step 3 — never an overwrite of it.
 *
 * - `into: 'searchable'`: the record's `expect.text` is the approved text.
 * - `into: 'new-document'`: the page's current section of the document its `expect.docId` names — from this
 *   page's anchor start to the next `source`-role paragraph link's start in that document, else the body's
 *   end — so edits made after the approval are what the diff compares against.
 * - `null` when there is honestly none: no prior transcription, a missing document, or no anchor to start from.
 */
export function approvedTextOf(
  assetId: string,
  expect: AssetTranscription | null,
  body: string | undefined,
  links: readonly (AssetLink | ReadAssetLink)[] | undefined,
): string | null {
  if (expect === null) return null;
  if (typeof expect.text === 'string' && expect.text !== '') return expect.text;
  const docId = expect.docId;
  if (typeof docId !== 'string' || docId === '' || body === undefined) return null;
  // Every `source`-role paragraph link into that document, with its anchor start.
  const starts: { readonly assetId: string; readonly from: number }[] = [];
  for (const link of links ?? []) {
    if (link.role !== 'source') continue;
    const target = link.target as LooseTarget;
    if (target.kind !== 'paragraph' || target.nodeId !== docId) continue;
    if (typeof target.anchor?.from !== 'number') continue;
    starts.push({ assetId: link.assetId, from: target.anchor.from });
  }
  starts.sort((a, b) => a.from - b.from);
  const ownStart = starts.find((candidate) => candidate.assetId === assetId)?.from;
  const start = typeof expect.anchor?.from === 'number' ? expect.anchor.from : ownStart;
  if (start === undefined || start < 0 || start > body.length) return null;
  let end = body.length;
  for (const candidate of starts) {
    if (candidate.from > start && candidate.from < end) end = candidate.from;
  }
  return body.slice(start, end);
}

/** The same, read through a {@link ApprovedTextSource} (the dialog passes the session's state). */
export function approvedTextFromSource(assetId: string, expect: AssetTranscription | null, source: ApprovedTextSource): string | null {
  const docId = expect?.docId;
  return approvedTextOf(assetId, expect, typeof docId === 'string' ? source.bodyOf(docId) : undefined, source.links);
}

/**
 * The word-level spans where a new read differs from the approved text: `compareTranscriptionReads` with the
 * approved text as the first read, so every span's `start`/`end` index into `approved` and `first` is the
 * approved word, `second` what the new read says instead.
 */
export function diffSpansOf(approved: string, ghost: string): readonly TranscriptionDisagreement[] {
  return compareTranscriptionReads(approved, ghost);
}

/* ------------------------------------------------------------------ *
 * The ghost's highlight spans
 * ------------------------------------------------------------------ */

/** Why one span of the ghost is marked. */
export type GhostMark = 'uncertain' | 'illegible' | 'disagree';

/** One run of the ghost text, marked or not. Joining all segments' `text` returns the original exactly. */
export interface GhostSegment {
  readonly text: string;
  readonly mark: GhostMark | null;
  /** The second read's word, when the mark is a disagreement. */
  readonly second?: string;
}

/** `[?word?]` (an uncertain word) and `[illegible]`, as §8.4 step 2's prompt asks the model to mark them. */
const INK_MARK_RE = /\[\?[^\][]*\?\]|\[illegible\]/gi;

/**
 * The ghost of one read as marked segments: `[?…?]` and `[illegible]` spans, plus the second read's
 * disagreement spans (UTF-16 offsets into `text`, from `compareTranscriptionReads`). An explicit ink mark
 * wins where the two overlap. The second read is never merged into the text — a disagreement only carries its
 * `second` word beside the first read's.
 */
export function ghostSegmentsOf(text: string, disagreements?: readonly TranscriptionDisagreement[]): readonly GhostSegment[] {
  interface Range {
    readonly start: number;
    readonly end: number;
    readonly mark: GhostMark;
    readonly second?: string;
    /** Explicit ink marks sort before disagreements at the same offset. */
    readonly rank: number;
  }
  const ranges: Range[] = [];
  for (const match of text.matchAll(INK_MARK_RE)) {
    const at = match.index ?? 0;
    const raw = match[0];
    ranges.push({ start: at, end: at + raw.length, mark: raw.toLowerCase().startsWith('[illegible]') ? 'illegible' : 'uncertain', rank: 0 });
  }
  for (const disagreement of disagreements ?? []) {
    if (disagreement.end <= disagreement.start) continue; // a word only in the second read has no span in the first
    ranges.push({ start: disagreement.start, end: disagreement.end, mark: 'disagree', second: disagreement.second, rank: 1 });
  }
  ranges.sort((a, b) => a.start - b.start || a.rank - b.rank);
  const segments: GhostSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor || range.end > text.length) continue;
    if (range.start > cursor) segments.push({ text: text.slice(cursor, range.start), mark: null });
    segments.push({
      text: text.slice(range.start, range.end),
      mark: range.mark,
      ...(range.second === undefined ? {} : { second: range.second }),
    });
    cursor = range.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), mark: null });
  return segments;
}

/* ------------------------------------------------------------------ *
 * The writer's answer, validated and in the plan's order
 * ------------------------------------------------------------------ */

/** One page's edit in the dialog: whether it is included, and its (possibly edited) text. Both default. */
export interface PageEdit {
  readonly included?: boolean;
  readonly text?: string;
}

/** The answer of {@link answerOf}: a ready result, or why Approve must stay disabled. */
export type ReviewAnswer =
  | { readonly ok: true; readonly result: PictureTranscriptionReviewResult }
  | { readonly ok: false; readonly reason: 'no-pages-selected' | 'blank-text'; readonly assetId?: string };

/**
 * The writer's answer as one result: the selected pages **in the plan's order** (however the edits were
 * entered), each with its edited text, plus the title when the plan publishes into a new document. Every page
 * is included by default and starts from its first read; `no-pages-selected` when nothing is included, and
 * `blank-text` naming the page when an included page's text is blank — the port refuses either, so the dialog
 * disables Approve on them.
 */
export function answerOf(
  plan: PictureTranscriptionPlan,
  pages: readonly PictureTranscriptionReviewPage[],
  edits: ReadonlyMap<string, PageEdit>,
  title: string | undefined,
): ReviewAnswer {
  const readOf = new Map(pages.map((page) => [page.assetId, page]));
  const selected: PictureTranscriptionReviewedPage[] = [];
  for (const planPage of plan.pages) {
    const read = readOf.get(planPage.assetId);
    if (read === undefined) continue;
    const edit = edits.get(planPage.assetId);
    if (edit?.included === false) continue;
    const text = edit?.text ?? read.text;
    if (text.trim() === '') return { ok: false, reason: 'blank-text', assetId: planPage.assetId };
    selected.push({ assetId: planPage.assetId, text });
  }
  if (selected.length === 0) return { ok: false, reason: 'no-pages-selected' };
  const trimmed = title?.trim();
  const named = plan.into === 'new-document' && trimmed !== undefined && trimmed !== '' ? trimmed : undefined;
  return { ok: true, result: { pages: selected, ...(named === undefined ? {} : { title: named }) } };
}
