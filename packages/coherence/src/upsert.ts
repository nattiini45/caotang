/**
 * The findings lifecycle's upsert — [coherence.md §6.1](../../../docs/architecture/coherence.md).
 *
 * Identity. §6.1 matches findings by `checkId` and `factGroup`. §4.2 lets several
 * findings share one `factGroup` (one card, several citations), so a key of those
 * two alone would merge distinct findings. The identity used here adds the set of
 * documents the finding quotes. For a deterministic finding that set is the scene
 * or scenes it is about, so the spec's rule holds where it names a single fact.
 * Codex-level findings quote nothing, and their factGroup already names the entry or pair.
 *
 * Outcomes, per draft:
 *  1. open match → updated in place, `runId` moved to this run
 *  2. dismissed match → stays dismissed; the new evidence is appended as a redetection
 *  3. fixed match → stays fixed; the redetection is reported, and it never re-opens
 *  4. no match → a new open finding
 *
 * Clearing. A deterministic run that checked a scope owns that scope's open
 * findings. An open finding the check no longer produces is cleared, because the
 * finding is derived state and a stale card would mislead. Dismissed and fixed
 * findings are kept, since they are the writer's history. An llm run never clears.
 */

import type { MessageRef } from '@caotang/i18n';
import type { RandomBytes } from '@caotang/ids';

import { mintCoherenceId } from './ids.js';
import { REDETECTION_LIMIT, type CoherenceFile, type Evidence, type Finding, type FindingClass, type FindingSeverity, type ModelMeta } from './model.js';

/** What a run hands the lifecycle: a finding without the fields the lifecycle owns. */
export interface UpsertDraft {
  readonly class: FindingClass;
  readonly checkId: string;
  readonly type: string;
  readonly severity: FindingSeverity;
  readonly factGroup: string;
  readonly evidence: readonly Evidence[];
  readonly message: string;
  /** A deterministic check's additive message reference (I7); absent on model-authored drafts. */
  readonly messageRef?: MessageRef;
  readonly expected?: string;
  readonly reasoning?: string;
  readonly modelMeta?: ModelMeta;
}

/** The identity §6.1 matches on, with the document set that §4.2's shared key needs added. */
export function identityOf(finding: { checkId: string; factGroup: string; evidence: readonly { docId: string }[] }): string {
  const docs = [...new Set(finding.evidence.map((passage) => passage.docId))].sort().join(',');
  return JSON.stringify([finding.checkId, finding.factGroup, docs]);
}

export interface ClearOptions {
  /** Checks that ran over the scope. Only findings of these checks may be cleared. */
  readonly checkIds: ReadonlySet<string>;
  /** Documents the run read. A finding quoting none of them is outside the run. */
  readonly scopeDocIds: ReadonlySet<string>;
  /** Documents whose counts were unavailable. Findings quoting them are not cleared, because they were not evaluated. */
  readonly unevaluatedDocIds?: ReadonlySet<string>;
}

export interface UpsertOptions {
  readonly runId: string;
  /** ISO-8601 instant for every timestamp this run writes. */
  readonly now: string;
  readonly randomBytes?: RandomBytes;
  /** Present for deterministic runs only (see the module header). */
  readonly clear?: ClearOptions;
}

export interface UpsertReport {
  /** Ids created or updated by this run, in draft order. Matches §4.1 `findingsUpserted`. */
  readonly upserted: string[];
  /** Dismissed findings found again. Counted for the run report. */
  readonly redetectedDismissed: number;
  /** Fixed findings found again. Named in the run report (§6.1 case 3). */
  readonly redetectedFixed: string[];
  /** Open findings no longer detected and removed. */
  readonly cleared: number;
}

/**
 * Applies drafts to a file in place. The caller passes a clone, because the
 * function is the one place the lifecycle mutates a file.
 */
export function upsertFindings(file: CoherenceFile, drafts: readonly UpsertDraft[], options: UpsertOptions): UpsertReport {
  const taken = new Set<string>(file.findings.map((finding) => finding.id));
  const byIdentity = new Map<string, Finding>();
  for (const finding of file.findings) {
    const key = identityOf(finding);
    if (!byIdentity.has(key)) byIdentity.set(key, finding);
  }

  const upserted: string[] = [];
  const redetectedFixed: string[] = [];
  let redetectedDismissed = 0;
  const detected = new Set<string>();

  for (const draft of drafts) {
    const key = identityOf(draft);
    if (detected.has(key)) continue;
    detected.add(key);
    const existing = byIdentity.get(key);

    if (existing === undefined) {
      const id = mintCoherenceId('f', taken, options.randomBytes);
      taken.add(id);
      const created: Finding = {
        id,
        runId: options.runId,
        createdByRunId: options.runId,
        class: draft.class,
        checkId: draft.checkId,
        type: draft.type,
        severity: draft.severity,
        status: 'open',
        factGroup: draft.factGroup,
        message: draft.message,
        evidence: [...draft.evidence],
        createdAt: options.now,
        updatedAt: options.now,
      };
      if (draft.messageRef !== undefined) created.messageRef = draft.messageRef;
      if (draft.expected !== undefined) created.expected = draft.expected;
      if (draft.reasoning !== undefined) created.reasoning = draft.reasoning;
      if (draft.modelMeta !== undefined) created.modelMeta = draft.modelMeta;
      file.findings.push(created);
      byIdentity.set(key, created);
      upserted.push(id);
      continue;
    }

    if (existing.status === 'open') {
      existing.runId = options.runId;
      existing.type = draft.type;
      existing.severity = draft.severity;
      existing.message = draft.message;
      if (draft.messageRef === undefined) delete existing.messageRef;
      else existing.messageRef = draft.messageRef;
      existing.evidence = [...draft.evidence];
      if (draft.expected !== undefined) existing.expected = draft.expected;
      if (draft.reasoning !== undefined) existing.reasoning = draft.reasoning;
      if (draft.modelMeta !== undefined) existing.modelMeta = draft.modelMeta;
      existing.updatedAt = options.now;
      upserted.push(existing.id);
      continue;
    }

    // Dismissed or fixed: the verdict stands. The new passage is recorded beside it.
    const redetections = existing.redetections ?? [];
    redetections.push({ runId: options.runId, at: options.now, evidence: [...draft.evidence] });
    existing.redetections = redetections.slice(-REDETECTION_LIMIT);
    existing.updatedAt = options.now;
    if (existing.status === 'fixed') redetectedFixed.push(existing.id);
    else redetectedDismissed += 1;
  }

  let cleared = 0;
  if (options.clear !== undefined) {
    const clear = options.clear;
    file.findings = file.findings.filter((finding) => {
      if (finding.status !== 'open') return true;
      if (!clear.checkIds.has(finding.checkId)) return true;
      const quotesScope = finding.evidence.length === 0 || finding.evidence.some((passage) => clear.scopeDocIds.has(passage.docId));
      if (!quotesScope) return true;
      if (finding.evidence.some((passage) => clear.unevaluatedDocIds?.has(passage.docId) === true)) return true;
      if (detected.has(identityOf(finding))) return true;
      cleared += 1;
      return false;
    });
  }

  return { upserted, redetectedDismissed, redetectedFixed, cleared };
}

/** How many recurred findings the run note names before it counts the rest. */
const RECURRED_NAMING = 3;

/**
 * §6.1 case 3's run-report line, "recurred after marked fixed". The Findings tab shows run notes as they are, so each finding
 * is named by the statement its card shows, never by its id.
 */
export function recurredAfterFixedNote(file: CoherenceFile, ids: readonly string[]): string {
  const named = ids
    .slice(0, RECURRED_NAMING)
    .map((id) => file.findings.find((finding) => finding.id === id)?.message ?? 'a finding')
    .map((message) => `“${message}”`);
  const more = ids.length > RECURRED_NAMING ? `, and ${ids.length - RECURRED_NAMING} more` : '';
  return `recurred after marked fixed: ${named.join('; ')}${more}`;
}
