/**
 * Stage 4 — [coherence.md §5.3](../../../../docs/architecture/coherence.md): deterministic
 * assembly. No model call happens here. Contradictory verdicts become llm-class
 * findings, their factGroups are normalised against the codex (§4.2), duplicates
 * fold into one, and the cap applies.
 *
 * Severity follows the spec's category table. Factual and timeline-plot findings
 * are errors, characterization and world-building are warnings, and narrative
 * style is information. The writer adjusts a finding by dismissing it, and the
 * severity itself is never re-weighted per run (§5.3).
 */

import type { CodexEntry } from '@caotang/store';

import { groupKey } from '../checks/common.js';
import { isCoherenceId } from '../ids.js';
import { type Evidence, type FindingSeverity, type LlmCategory, type ModelMeta } from '../model.js';
import { codePointLength, codePointPrefix } from '../text.js';
import { identityOf, type UpsertDraft } from '../upsert.js';

import type { ModelUsage } from './port.js';
import type { PairRef } from './pairs.js';
import type { ExtractedSpan } from './parse.js';
import type { ParsedVerdict } from './parse.js';

/** The category table from §5.3. */
export const SEVERITY_BY_CATEGORY: Readonly<Record<LlmCategory, FindingSeverity>> = {
  'timeline-plot': 'error',
  factual: 'error',
  characterization: 'warning',
  'world-building': 'warning',
  'narrative-style': 'info',
};

/**
 * A world-rule id, as the shape check the module owns: **`isCoherenceId`**, the
 * same check `mintCoherenceId`'s output goes through.
 *
 * A second copy of the alphabet and the length here would be a second thing to
 * get wrong — an alphabet or a length that changed in `@caotang/ids` would
 * split this check from the mint, and the two would disagree about what a
 * world-rule id is without either of them failing loudly.
 */
function isRuleId(value: string): boolean {
  return isCoherenceId('w', value);
}

const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = { error: 0, warning: 1, info: 2 };
const MESSAGE_CHARS = 200;

/**
 * §4.2: an entity that names a codex entry by exact name or alias becomes that
 * entry's id. A world-rule id is kept as it is. Anything else, including an
 * ambiguous name, becomes the lowercased name, since guessing the entry would
 * merge two different problems.
 */
export function normalizeEntity(entity: string, entries: readonly CodexEntry[]): string {
  const trimmed = entity.trim();
  if (isRuleId(trimmed)) return trimmed;
  const wanted = trimmed.toLowerCase();
  const matches = entries.filter((entry) => [entry.name, ...entry.aliases].some((term) => term.trim().toLowerCase() === wanted));
  return matches.length === 1 && matches[0] !== undefined ? matches[0].id : wanted;
}

export function normalizeFactGroup(entity: string, attribute: string, entries: readonly CodexEntry[]): string {
  return groupKey(normalizeEntity(entity, entries), attribute.trim().toLowerCase());
}

/** The span's quote as Stage 1 verified it: already within the limit, so it is kept whole, never cut. */
function toEvidence(span: ExtractedSpan): Evidence {
  return { docId: span.docId, quote: span.quote, from: span.from, to: span.to };
}

/** The card's one-line statement: the first sentence of the reasoning, or a plain default. */
function messageFor(reasoning: string, category: LlmCategory): string {
  const first = reasoning.split(/(?<=[.!?])\s/)[0]?.trim() ?? '';
  if (first === '') return `Possible ${category} contradiction`;
  return codePointLength(first) > MESSAGE_CHARS ? `${codePointPrefix(first, MESSAGE_CHARS - 1)}…` : first;
}

export interface AssemblyContext {
  readonly pairs: ReadonlyMap<string, PairRef>;
  readonly entries: readonly CodexEntry[];
  readonly model: string;
  /** Binder position per document. Ties on severity are ordered by it, so the cut-off is reproducible. */
  readonly docOrder: ReadonlyMap<string, number>;
  readonly maxFindings: number;
  /** Usage of the call that produced each pair's verdict (§3 `modelMeta`). */
  readonly usageByPair: ReadonlyMap<string, ModelUsage | undefined>;
}

export interface AssemblyResult {
  readonly drafts: UpsertDraft[];
  /** Repeat verdicts merged into an earlier one with the same identity. */
  readonly folded: number;
  /** Contradictions beyond the cap, which were not recorded. */
  readonly overflow: number;
  readonly notes: string[];
}

export function assembleFindings(verdicts: readonly ParsedVerdict[], context: AssemblyContext): AssemblyResult {
  const candidates: { draft: UpsertDraft; rank: number; order: number; at: number; key: string }[] = [];
  const seen = new Set<string>();
  let folded = 0;

  for (const verdict of verdicts) {
    if (verdict.verdict !== 'contradictory') continue;
    const pair = context.pairs.get(verdict.pairId);
    if (pair === undefined) continue;
    const evidence = verdict.evidence !== undefined ? [...verdict.evidence] : [toEvidence(pair.a), toEvidence(pair.b)];
    const usage = context.usageByPair.get(verdict.pairId);
    const modelMeta: ModelMeta = {
      model: context.model,
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
    };
    const draft: UpsertDraft = {
      class: 'llm',
      checkId: `llm:${pair.category}`,
      type: pair.category,
      severity: SEVERITY_BY_CATEGORY[pair.category],
      factGroup: normalizeFactGroup(verdict.entity, verdict.attribute, context.entries),
      evidence,
      message: messageFor(verdict.reasoning, pair.category),
      reasoning: verdict.reasoning,
      modelMeta,
    };
    const key = identityOf(draft);
    if (seen.has(key)) {
      folded += 1;
      continue;
    }
    seen.add(key);
    const first = evidence[0];
    candidates.push({
      draft,
      rank: SEVERITY_RANK[draft.severity],
      order: first === undefined ? Number.MAX_SAFE_INTEGER : (context.docOrder.get(first.docId) ?? Number.MAX_SAFE_INTEGER),
      at: first?.from ?? 0,
      key: draft.factGroup,
    });
  }

  candidates.sort((a, b) => a.rank - b.rank || a.order - b.order || a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const kept = candidates.slice(0, context.maxFindings);
  const overflow = candidates.length - kept.length;

  const notes: string[] = [];
  if (folded > 0) notes.push(`${folded} repeated verdict(s) merged into an earlier finding`);
  if (overflow > 0) notes.push(`${overflow} further contradiction(s) not recorded; raise maxFindings or narrow the scope`);
  return { drafts: kept.map((candidate) => candidate.draft), folded, overflow, notes };
}
