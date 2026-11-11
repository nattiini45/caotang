/**
 * L2 — the codex layer — [context-assembly.md §2](../../../../docs/architecture/context-assembly.md)
 * and [codex.md §4–§6](../../../../docs/architecture/codex.md).
 *
 * Detection and candidate selection are `@caotang/codex`'s. This file decides only what the
 * layer does with them: the rank that the budget prunes by, the display order, the
 * suppressions the preview names, and the rendered entry.
 *
 * The rank is codex.md §6's prune order read from the top. The `always` entries hold the
 * first ranks, so the total-budget pass never removes them. Detected entries come next, and
 * manual attachments hold the last ranks, so they are the first to go. Within a group the
 * codex order holds, so the tail of a group is its last entry in codex order.
 */

import {
  compareCodex,
  detect,
  selectCandidates,
  type Candidate,
  type CandidateReason,
  type DetectionDoc,
  type DetectionHit,
  type DetectionResult,
  type IndexedDoc,
  type MentionIndex,
  type Suppressed,
} from '@caotang/codex';
import type { CodexEntry, TreeNode } from '@caotang/store';

import { newBlock, type Block, type BlockItem } from '../block.js';
import { dropRecord } from '../drops.js';
import { LAYER_NAMES, type DropRecord, type DropReason } from '../types.js';

/** The text surfaces and the scope documents that detection scans (codex.md §4, rule 6). */
export interface DetectionSurfaces {
  /** Instruction, selection and tail: uncached, small strings. */
  readonly texts: readonly DetectionDoc[];
  /** Whole scope documents, for continuity.scan. Read from the mention cache when one is given. */
  readonly bodies: readonly IndexedDoc[];
}

/** Mention counts for a call, merged across its surfaces. */
export function detectCodex(
  entries: readonly CodexEntry[],
  surfaces: DetectionSurfaces,
  mentions: MentionIndex | undefined,
): DetectionResult {
  if (mentions === undefined) {
    const docs = [...surfaces.texts, ...surfaces.bodies.map((doc) => ({ id: doc.id, text: doc.body }))];
    return detect(docs, entries);
  }
  return mergeDetections([
    detect(surfaces.texts, entries),
    ...surfaces.bodies.map((doc) => mentions.detectionFor(doc, entries)),
  ]);
}

function mergeDetections(parts: readonly DetectionResult[]): Map<string, DetectionHit> {
  const merged = new Map<string, { count: number; where: string[] }>();
  for (const part of parts) {
    for (const [entryId, hit] of part) {
      const slot = merged.get(entryId) ?? { count: 0, where: [] };
      slot.count += hit.count;
      for (const where of hit.where) if (!slot.where.includes(where)) slot.where.push(where);
      merged.set(entryId, slot);
    }
  }
  return new Map([...merged].map(([entryId, slot]) => [entryId, { count: slot.count, where: slot.where }]));
}

export interface CodexPlanInput {
  readonly include?: ReadonlySet<string>;
  readonly exclude?: ReadonlySet<string>;
  readonly entries: readonly CodexEntry[];
  /** The manifest's binder tree, as `selectCandidates` reads it. */
  readonly tree: readonly TreeNode[];
  /** The documents whose focus scope the attachments are matched against. */
  readonly focusDocs: readonly string[];
  readonly detected: DetectionResult;
  /** A surface id or a node id, as a reader sees it: `tail`, `instruction`, or a title. */
  readonly labelOf: (where: string) => string;
}

export interface CodexPlan {
  readonly block: Block;
  /** Entries that matched or applied and were removed before the budget, for the preview. */
  readonly suppressed: readonly DropRecord[];
}

/**
 * Candidate selection across a scope. A single focus gives one `selectCandidates` call. A
 * continuity scope gives one call per document and a union, so a `manual` entry attached
 * to any scoped folder reaches every document beneath it. The first document in scope order
 * supplies the reason when several reach an entry.
 */
function selectAcrossScope(input: CodexPlanInput): { candidates: Candidate[]; suppressed: Suppressed[] } {
  const byId = new Map<string, Candidate>();
  const suppressed = new Map<string, Suppressed>();
  const scopes: (string | undefined)[] = input.focusDocs.length > 0 ? [...input.focusDocs] : [undefined];
  for (const focusDocId of scopes) {
    const result = selectCandidates({
      entries: input.entries,
      tree: input.tree,
      focusDocId,
      detected: input.detected,
    });
    for (const candidate of result.candidates) {
      if (!byId.has(candidate.entry.id)) byId.set(candidate.entry.id, candidate);
    }
    for (const item of result.suppressed) {
      if (!suppressed.has(item.entry.id)) suppressed.set(item.entry.id, item);
    }
  }
  for (const id of byId.keys()) suppressed.delete(id);
  return {
    candidates: [...byId.values()],
    suppressed: [...suppressed.values()].sort((a, b) => compareCodex(a.entry, b.entry)),
  };
}

function rankGroup(reason: CandidateReason): number {
  if (reason.kind === 'always') return 0;
  if (reason.kind === 'detected') return 1;
  return 2;
}

function reasonText(candidate: Candidate, labelOf: (where: string) => string): string {
  const reason = candidate.reason;
  if (reason.kind === 'always') return 'always';
  if (reason.kind === 'detected') {
    return `matched ×${reason.count} in ${reason.where.map(labelOf).join(', ')}`;
  }
  return `attached to ${labelOf(reason.via)}`;
}

/** codex.md §6 step 4: `## name (type)` and the description. Aliases are detection keys, not payload. */
function entryBody(entry: CodexEntry): string {
  return `## ${entry.name} (${entry.type})\n${(entry.description ?? '').trim()}`;
}

function suppressionReason(reason: Suppressed['reason']): DropReason {
  if (reason === 'never') return { kind: 'never' };
  if (reason === 'empty-description') return { kind: 'empty-description' };
  return { kind: 'manual-unattached' };
}

export function codexBlock(input: CodexPlanInput): CodexPlan {
  const selected = selectAcrossScope({
    ...input,
    entries: input.entries.map((entry) => input.include?.has(entry.id) && entry.includePolicy !== 'never'
      ? { ...entry, includePolicy: 'always' as const }
      : entry),
  });
  const originals = new Map(input.entries.map((entry) => [entry.id, entry]));
  const excluded: DropRecord[] = [];
  const candidates = selected.candidates.filter(({ entry }) => {
    if (!input.exclude?.has(entry.id)) return true;
    excluded.push(dropRecord(entry.name, { kind: 'writer-excluded' }, 'codex', { kind: 'codex', id: entry.id }));
    return false;
  }).map((candidate) => ({ ...candidate, entry: originals.get(candidate.entry.id) ?? candidate.entry }));
  const suppressed = [...selected.suppressed];
  for (const entry of input.entries) {
    if (input.include?.has(entry.id) && entry.includePolicy === 'never' && !suppressed.some((item) => item.entry.id === entry.id)) {
      suppressed.push({ entry, reason: 'never' });
    }
  }
  suppressed.sort((a, b) => compareCodex(a.entry, b.entry));
  const ordered = [...candidates].sort((a, b) => compareCodex(a.entry, b.entry));
  // Array.prototype.sort is stable, so each group keeps the codex order it was given.
  const ranked = [...ordered].sort((a, b) => rankGroup(a.reason) - rankGroup(b.reason));

  const position = new Map<string, number>();
  ranked.forEach((candidate, index) => position.set(candidate.entry.id, index));

  const items: BlockItem[] = ranked.map((candidate) => ({
    ref: { kind: 'codex', id: candidate.entry.id },
    label: candidate.entry.name,
    reason: input.include?.has(candidate.entry.id) ? 'pinned by the writer for this request' : reasonText(candidate, input.labelOf),
    body: entryBody(candidate.entry),
    protected: candidate.reason.kind === 'always',
    group: candidate.reason.kind,
  }));
  const display = ordered.map((candidate) => position.get(candidate.entry.id) ?? 0);

  const block = newBlock({
    id: 'L2',
    header: `# ${LAYER_NAMES.L2}`,
    empty: '(no codex entries apply to this call)',
    cut: '(codex entries not sent)',
    items,
    display,
  });
  return {
    block,
    suppressed: [
      ...suppressed.map((item) => dropRecord(item.entry.name, suppressionReason(item.reason), 'codex', { kind: 'codex', id: item.entry.id })),
      ...excluded,
    ],
  };
}
