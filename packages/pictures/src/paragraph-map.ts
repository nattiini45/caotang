/**
 * Carrying paragraph anchors across a body write — pictures.md §2.3, the mapping half.
 *
 * `paragraphs.ts` captures and checks one anchor against one body. This module takes the **old and
 * new bodies of one write** and answers, for every paragraph link of that document, where the
 * anchored paragraph went: rewritten in place (`mapped`), found somewhere else (`moved`, please
 * confirm), or gone (`orphaned`, kept and listed, never dropped and never guessed).
 *
 * The shape §2.3 fixes, in order:
 *
 * 1. One **bounded** diff per write, computed once for the whole document (never per link). It runs
 *    at line granularity with a work cap; a cap hit is a *timeout* and falls through to step 3 for
 *    every link, exactly as `Diff_Timeout` does for `diff_main`.
 * 2. Each link's old block maps through the diff; the mapped block must score ≥
 *    `SIMILARITY_FLOOR` against the captured `exact` quote, **or** the mapped range must overlap
 *    characters of the old block that survived the diff. On success the anchor is recaptured at the
 *    mapped block with the write's revision.
 * 3. When the old block's characters are all gone (or there was no old body, or the diff timed
 *    out), the **guarded resolver** runs once: it refuses when the runner-up scores within
 *    `LOOKALIKE_MARGIN` of the best candidate, and any success that is not the block sitting at the
 *    captured offsets is `moved`. Otherwise the link is `orphaned` with the anchor as captured.
 *
 * Everything is UTF-16 offsets over the body projection, the same coordinates `paragraphs.ts` and
 * the editor's projection use. This module imports nothing from the store or the editor, so the store
 * can hand it to the bus as the `AnchorPort` operation.
 */

import type { ParagraphAnchor } from './model.js';
import { blockHashOf, captureParagraphAnchor, normalizeBlockText, paragraphBlocks, type ParagraphBlock } from './paragraphs.js';

/** §2.3 step 2's verify floor, the same number edit-anchors.ts's ladder uses (`FUZZY_SIMILARITY_FLOOR`). */
export const SIMILARITY_FLOOR = 0.85;

/** §2.3 step 3's guard: a runner-up this close to the best is a lookalike, and the resolver refuses. */
export const LOOKALIKE_MARGIN = 0.05;

/**
 * The diff's work cap, in (lines compared) × (edit distance) cells. §2.3 asks for `Diff_Timeout`;
 * a wall-clock timeout cannot be tested deterministically, so the bound here is the amount of work
 * the diff is allowed to do, and a cap hit is the same outcome a timeout is: step 3.
 */
export const DIFF_WORK_CAP = 4_000_000;

/** How much of a block the resolver's similarity scores. Keeps one score O(cap²) at worst. */
const SCORE_CHARS = 400;

/** A paragraph link as the mapper sees it: the id and the anchor, nothing else. */
export interface ParagraphLinkRef {
  readonly linkId: string;
  readonly anchor: ParagraphAnchor;
}

export type AnchorOutcome =
  | { readonly status: 'mapped'; readonly anchor: ParagraphAnchor }
  | { readonly status: 'moved'; readonly anchor: ParagraphAnchor }
  | { readonly status: 'orphaned'; readonly anchor: ParagraphAnchor };

export interface AnchorResult {
  readonly linkId: string;
  readonly outcome: AnchorOutcome;
}

export interface AnchorMapping {
  readonly results: readonly AnchorResult[];
  /** `timeout` when the bounded diff gave up and every link fell to the guarded resolver. */
  readonly diff: 'computed' | 'timeout';
}

export interface MapParagraphLinksInput {
  readonly docId: string;
  readonly oldBody: string;
  readonly newBody: string;
  /** The revision the write leaves behind; the recaptured anchors carry it. */
  readonly revision: number;
  readonly links: readonly ParagraphLinkRef[];
  /** Test seam: a smaller work cap forces the timeout path deterministically. */
  readonly diffWorkCap?: number;
}

/**
 * The `AnchorPort` operation (pictures.md §2.3): one call per body write, taking the document, the
 * old and new bodies, the new revision and **that document's** links, returning the mapped links
 * plus explicit `orphaned`/`moved` outcomes. Never a silently dropped link, never a guess.
 */
export type AnchorPortOp = (input: MapParagraphLinksInput) => AnchorMapping;

export interface AnchorPort {
  readonly op: AnchorPortOp;
}

/** The pure implementation the desktop and Node composition roots inject as `ProjectCommandOptions.anchors`. */
export function paragraphAnchorPort(): AnchorPort {
  return { op: mapParagraphLinks };
}

/* ------------------------------------------------------------------ *
 * Similarity — normalized edit distance, capped
 * ------------------------------------------------------------------ */

/** Normalized similarity in [0, 1], symmetric, 1 for identical strings. Slices past `SCORE_CHARS` keep it bounded. */
export function similarity(left: string, right: string): number {
  if (left === right) return 1;
  const a = left.length > SCORE_CHARS ? left.slice(0, SCORE_CHARS) : left;
  const b = right.length > SCORE_CHARS ? right.slice(0, SCORE_CHARS) : right;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j += 1) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length]!;
}

/* ------------------------------------------------------------------ *
 * The bounded diff — Myers over lines, with a work cap
 * ------------------------------------------------------------------ */

interface Line {
  /** Start offset of the line's text, terminator excluded. */
  readonly start: number;
  /** End offset of the line's text, terminator excluded. */
  readonly end: number;
  /** Length of the line's terminator (`\n`, `\r\n`, `\r`, or 0 at the end of the body). */
  readonly term: number;
  readonly text: string;
}

function splitLines(body: string): Line[] {
  const lines: Line[] = [];
  let i = 0;
  while (i <= body.length) {
    let lineEnd = i;
    while (lineEnd < body.length && body[lineEnd] !== '\n' && body[lineEnd] !== '\r') lineEnd += 1;
    const term = lineEnd >= body.length ? 0 : body[lineEnd] === '\r' && body[lineEnd + 1] === '\n' ? 2 : 1;
    lines.push({ start: i, end: lineEnd, term, text: body.slice(i, lineEnd) });
    if (lineEnd >= body.length) break;
    i = lineEnd + term;
  }
  return lines;
}

interface DiffOp {
  readonly type: 'equal' | 'delete' | 'insert';
  readonly oldLine: number;
  readonly newLine: number;
}

/**
 * Myers O(ND) over line texts, storing one V per d for the backtrack. Returns `null` when the work
 * cap is hit — the caller treats that as the timeout and falls to the guarded resolver.
 */
function diffLines(a: readonly string[], b: readonly string[], workCap: number): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const width = n + m;
  const offset = width + 1;
  const v = new Int32Array(2 * width + 3);
  const trace: Int32Array[] = [];
  let work = 0;
  for (let d = 0; d <= width; d += 1) {
    work += width;
    if (work > workCap) return null;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        const ops: DiffOp[] = [];
        let ox = n;
        let oy = m;
        for (let dd = d; dd > 0; dd -= 1) {
          const vv = trace[dd]!;
          const kk = ox - oy;
          const prevK = kk === -dd || (kk !== dd && vv[offset + kk - 1]! < vv[offset + kk + 1]!) ? kk + 1 : kk - 1;
          const prevX = vv[offset + prevK]!;
          const prevY = prevX - prevK;
          while (ox > prevX && oy > prevY) {
            ops.push({ type: 'equal', oldLine: ox - 1, newLine: oy - 1 });
            ox -= 1;
            oy -= 1;
          }
          if (ox > prevX) {
            ops.push({ type: 'delete', oldLine: ox - 1, newLine: oy });
            ox -= 1;
          } else {
            ops.push({ type: 'insert', oldLine: ox, newLine: oy - 1 });
            oy -= 1;
          }
        }
        while (ox > 0 && oy > 0) {
          ops.push({ type: 'equal', oldLine: ox - 1, newLine: oy - 1 });
          ox -= 1;
          oy -= 1;
        }
        ops.reverse();
        return ops;
      }
    }
  }
  return null;
}

/**
 * One run of the mapping: either `equal` (the old range maps linearly onto the new range) or `point`
 * (the old range was deleted; every offset in it maps to `at`). The segments tile the old body.
 */
type Segment =
  | { readonly kind: 'equal'; readonly oldStart: number; readonly oldEnd: number; readonly newStart: number; readonly newEnd: number }
  | { readonly kind: 'point'; readonly oldStart: number; readonly oldEnd: number; readonly at: number };

/** A changed line region is refined at character level only while it stays inside these bounds. */
const CHAR_REGION_MAX = 10_000;
const CHAR_WORK_CAP = 500_000;

/**
 * Builds the old→new offset map. Line ops give the coarse shape; each run of delete+insert between
 * surviving lines is a *change region*, and a region small enough is refined with a second,
 * character-level Myers so an edit inside one paragraph still leaves its surviving characters
 * (the whole point of "the mapped range must overlap surviving characters of the old block").
 * A region too big to refine is one `point` segment — the guarded resolver decides those.
 */
function buildSegments(oldBody: string, newBody: string, ops: DiffOp[] | null): Segment[] {
  const oldLines = splitLines(oldBody);
  const newLines = splitLines(newBody);
  const segments: Segment[] = [];
  if (ops === null) {
    segments.push({ kind: 'point', oldStart: 0, oldEnd: oldBody.length, at: newBody.length });
    return segments;
  }
  const pushEqual = (oldStart: number, oldEnd: number, newStart: number, newEnd: number): void => {
    const last = segments[segments.length - 1];
    if (last !== undefined && last.kind === 'equal' && last.oldEnd === oldStart && last.newEnd === newStart) {
      segments[segments.length - 1] = { kind: 'equal', oldStart: last.oldStart, oldEnd, newStart: last.newStart, newEnd };
      return;
    }
    segments.push({ kind: 'equal', oldStart, oldEnd, newStart, newEnd });
  };
  let index = 0;
  let oldCursor = 0;
  let newCursor = 0;
  while (index < ops.length) {
    const op = ops[index]!;
    if (op.type === 'equal') {
      const ol = oldLines[op.oldLine]!;
      const nl = newLines[op.newLine]!;
      pushEqual(ol.start, ol.end + ol.term, nl.start, nl.end + nl.term);
      oldCursor = ol.end + ol.term;
      newCursor = nl.end + nl.term;
      index += 1;
      continue;
    }
    // A change region: the consecutive delete/insert ops between two surviving lines.
    let oldEnd = oldCursor;
    let newEnd = newCursor;
    while (index < ops.length && ops[index]!.type !== 'equal') {
      const current = ops[index]!;
      if (current.type === 'delete') {
        const ol = oldLines[current.oldLine]!;
        oldEnd = Math.max(oldEnd, ol.end + ol.term);
      } else {
        const nl = newLines[current.newLine]!;
        newEnd = Math.max(newEnd, nl.end + nl.term);
      }
      index += 1;
    }
    const oldStart = oldCursor;
    const newStart = newCursor;
    const oldText = oldBody.slice(oldStart, oldEnd);
    const newText = newBody.slice(newStart, newEnd);
    if (oldText.length > 0 && oldText.length <= CHAR_REGION_MAX && newText.length <= CHAR_REGION_MAX) {
      const charOps = diffLines(oldText.split(''), newText.split(''), CHAR_WORK_CAP);
      if (charOps !== null) {
        let oi = oldStart;
        let ni = newStart;
        for (const cop of charOps) {
          if (cop.type === 'equal') {
            pushEqual(oi, oi + 1, ni, ni + 1);
            oi += 1;
            ni += 1;
          } else if (cop.type === 'delete') {
            segments.push({ kind: 'point', oldStart: oi, oldEnd: oi + 1, at: ni });
            oi += 1;
          } else {
            ni += 1;
          }
        }
        oldCursor = oldEnd;
        newCursor = newEnd;
        continue;
      }
    }
    segments.push({ kind: 'point', oldStart, oldEnd, at: newStart });
    oldCursor = oldEnd;
    newCursor = newEnd;
  }
  return segments;
}

/** Where an old character went in the new body, over the segment map. */
interface OffsetMap {
  readonly segments: readonly Segment[];
  readonly map: (oldOffset: number) => number;
}

function buildOffsetMap(oldBody: string, newBody: string, segments: readonly Segment[]): OffsetMap {
  const map = (oldOffset: number): number => {
    if (oldOffset <= 0) return 0;
    if (oldOffset >= oldBody.length) return newBody.length;
    let lo = 0;
    let hi = segments.length - 1;
    let at = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid]!.oldStart <= oldOffset) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const segment = segments[at]!;
    if (segment.oldEnd <= oldOffset) return segment.kind === 'equal' ? segment.newEnd : segment.at;
    if (segment.kind === 'equal') return Math.min(segment.newStart + (oldOffset - segment.oldStart), segment.newEnd);
    return segment.at;
  };
  return { segments, map };
}

/** How many characters of `[from, to)` in the old body survived the diff and landed in `[newFrom, newTo)`. */
function survivingOverlap(map: OffsetMap, from: number, to: number, newFrom: number, newTo: number): number {
  let count = 0;
  for (const segment of map.segments) {
    if (segment.kind !== 'equal') continue;
    const lo = Math.max(from, segment.oldStart);
    const hi = Math.min(to, segment.oldEnd);
    if (hi <= lo) continue;
    const mappedLo = segment.newStart + (lo - segment.oldStart);
    const mappedHi = segment.newStart + (hi - segment.oldStart);
    const overlapLo = Math.max(mappedLo, newFrom);
    const overlapHi = Math.min(mappedHi, newTo);
    if (overlapHi > overlapLo) count += overlapHi - overlapLo;
  }
  return count;
}

/* ------------------------------------------------------------------ *
 * The guarded resolver — §2.3 step 3
 * ------------------------------------------------------------------ */

interface Candidate {
  readonly block: ParagraphBlock;
  readonly score: number;
}

/**
 * The resolver for a block whose old characters are gone. It proposes the blocks that contain the
 * captured quote verbatim, plus the blocks that begin like the old block (the cheap pre-filter a
 * whole-document fuzzy search would need the library for), scores them against the old block's
 * text, and accepts only a clear winner: `score ≥ SIMILARITY_FLOOR` and no runner-up within
 * `LOOKALIKE_MARGIN`. Two parallel lookalikes score alike, so the resolver refuses and the link is
 * orphaned — never a guess between them.
 */
function guardedResolve(
  newBody: string,
  anchor: ParagraphAnchor,
  oldBlockText: string | undefined,
  revision: number,
): AnchorOutcome {
  const blocks = paragraphBlocks(newBody);
  if (blocks.length === 0) return { status: 'orphaned', anchor };
  const wanted = anchor.exact;
  const oldNormalized = oldBlockText === undefined ? '' : normalizeBlockText(oldBlockText).slice(0, SCORE_CHARS);
  const oldHead = oldNormalized.slice(0, 32);

  const candidates: Candidate[] = [];
  const seen = new Set<number>();
  const consider = (block: ParagraphBlock): void => {
    if (seen.has(block.ordinal)) return;
    seen.add(block.ordinal);
    const text = normalizeBlockText(block.text).slice(0, SCORE_CHARS);
    const score = blockHashOf(block.text) === anchor.blockHash ? 1 : oldNormalized === '' ? 0 : similarity(text, oldNormalized);
    candidates.push({ block, score });
  };

  if (wanted.length > 0) {
    let at = newBody.indexOf(wanted);
    while (at !== -1) {
      const block = blocks.find((b) => at >= b.start && at < b.end) ?? blocks.find((b) => b.start > at);
      if (block !== undefined) consider(block);
      at = newBody.indexOf(wanted, at + 1);
    }
  }
  if (oldHead.length > 0) {
    for (const block of blocks) {
      const normalized = normalizeBlockText(block.text);
      if (normalized.slice(0, Math.min(32, oldHead.length)) === oldHead) consider(block);
    }
  }

  if (candidates.length === 0) return { status: 'orphaned', anchor };
  candidates.sort((a, b) => b.score - a.score || a.block.start - b.block.start);
  const best = candidates[0]!;
  const runnerUp = candidates[1];
  if (best.score < SIMILARITY_FLOOR) return { status: 'orphaned', anchor };
  if (runnerUp !== undefined && runnerUp.score >= best.score - LOOKALIKE_MARGIN) {
    // Never guess between lookalikes: two blocks this close, and the anchor cannot say which.
    return { status: 'orphaned', anchor };
  }
  const recaptured = captureParagraphAnchor(newBody, best.block.start, revision);
  if (recaptured === undefined) return { status: 'orphaned', anchor };
  // The block was not sitting at the captured offsets (those characters are gone), so any success
  // here is a move: "moved, please confirm".
  return { status: 'moved', anchor: recaptured };
}

/* ------------------------------------------------------------------ *
 * The mapping itself
 * ------------------------------------------------------------------ */

function blockAtOffset(blocks: readonly ParagraphBlock[], offset: number): ParagraphBlock | undefined {
  return blocks.find((b) => offset >= b.start && offset <= b.end) ?? blocks.find((b) => b.start > offset) ?? blocks[blocks.length - 1];
}

function mapOne(
  newBody: string,
  anchor: ParagraphAnchor,
  revision: number,
  offsets: OffsetMap | undefined,
  oldBlocks: readonly ParagraphBlock[],
): AnchorOutcome {
  const oldBlock = blockAtOffset(oldBlocks, anchor.from);
  if (oldBlock === undefined || offsets === undefined) {
    // No old body to diff (an external adoption, a reload): straight to the guarded resolver.
    return guardedResolve(newBody, anchor, oldBlock?.text, revision);
  }
  const mappedFrom = offsets.map(oldBlock.start);
  const mappedTo = offsets.map(oldBlock.end);
  const newBlocks = paragraphBlocks(newBody);
  const newBlock = blockAtOffset(newBlocks, mappedFrom);
  // §2.3's trigger order: when the old block's characters are ALL gone, the guarded ladder runs —
  // a surviving quote elsewhere is exactly the lookalike case the ladder's runner-up guard exists
  // for, so it must not be accepted as a step-2 verify.
  const survived = survivingOverlap(offsets, oldBlock.start, oldBlock.end, mappedFrom, mappedTo);
  if (survived === 0) return guardedResolve(newBody, anchor, oldBlock.text, revision);
  if (newBlock !== undefined) {
    const quoteLength = anchor.to - anchor.from;
    const candidate = newBody.slice(newBlock.start, Math.min(newBlock.end, newBlock.start + quoteLength));
    const quoteScore = similarity(candidate, anchor.exact);
    if (quoteScore >= SIMILARITY_FLOOR || survived > 0) {
      const recaptured = captureParagraphAnchor(newBody, newBlock.start, revision);
      if (recaptured !== undefined) return { status: 'mapped', anchor: recaptured };
    }
  }
  return guardedResolve(newBody, anchor, oldBlock.text, revision);
}

/**
 * Maps every paragraph link of one document across one body write. One diff for the whole call;
 * only documents that have paragraph links ever reach here.
 */
export function mapParagraphLinks(input: MapParagraphLinksInput): AnchorMapping {
  const { oldBody, newBody, revision, links } = input;
  if (links.length === 0) return { results: [], diff: 'computed' };
  if (oldBody === newBody) {
    return {
      results: links.map((link) => ({ linkId: link.linkId, outcome: { status: 'mapped' as const, anchor: { ...link.anchor, capturedRevision: revision } } })),
      diff: 'computed',
    };
  }
  const oldLines = splitLines(oldBody);
  const newLines = splitLines(newBody);
  const ops = diffLines(
    oldLines.map((l) => l.text),
    newLines.map((l) => l.text),
    input.diffWorkCap ?? DIFF_WORK_CAP,
  );
  const offsets = ops === null ? undefined : buildOffsetMap(oldBody, newBody, buildSegments(oldBody, newBody, ops));
  const oldBlocks = paragraphBlocks(oldBody);
  const results: AnchorResult[] = links.map((link) => ({
    linkId: link.linkId,
    outcome: mapOne(newBody, link.anchor, revision, offsets, oldBlocks),
  }));
  return { results, diff: ops === null ? 'timeout' : 'computed' };
}
