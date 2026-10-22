/**
 * A deterministic run, end to end — [coherence.md §4.1, §6.2, §7](../../../docs/architecture/coherence.md).
 *
 * The function is pure with respect to its inputs. It returns a new file and
 * the run it recorded; it writes nothing, and the caller persists the result.
 * The scan is zero-model-call work, so it can run as often as the writer asks.
 */

import type { RandomBytes } from '@caotang/ids';
import type { ProjectState } from '@caotang/store';

import type { DraftFinding } from './checks/common.js';
import { runChecks } from './checks/index.js';
import { mintCoherenceId } from './ids.js';
import { assembleInput, type AssembleOptions } from './input.js';
import {
  BRANCH_CHECK_IDS,
  DETERMINISTIC_CHECK_IDS,
  RUN_HISTORY_LIMIT,
  type CoherenceFile,
  type CoherenceRun,
  type DeterministicCheckId,
} from './model.js';
import { resolveScope, type ScopeSpec } from './scope.js';
import { recurredAfterFixedNote, upsertFindings, type UpsertDraft } from './upsert.js';

export interface DeterministicOptions extends AssembleOptions {
  readonly scope: ScopeSpec;
  /** Defaults to all eight checks (§7 tool 15). */
  readonly checks?: readonly DeterministicCheckId[];
  readonly now: Date;
  readonly randomBytes?: RandomBytes;
}

export interface DeterministicResult {
  readonly file: CoherenceFile;
  readonly run: CoherenceRun;
}

const EMPTY_DOC_NAMING = 10;

const SPEAKER_PARITY = 'medium.speaker-parity';

function toUpsertDraft(draft: DraftFinding): UpsertDraft {
  return {
    class: 'deterministic',
    checkId: draft.checkId,
    type: draft.type,
    severity: draft.severity,
    factGroup: draft.factGroup,
    evidence: [...draft.evidence],
    message: draft.message,
    ...(draft.expected !== undefined ? { expected: draft.expected } : {}),
  };
}

/**
 * Runs the selected checks over the scope, upserts what they found, records the
 * run, and advances the review state of every document the run evaluated.
 *
 * A document whose mention count is unavailable is not evaluated, so it does not
 * advance the review state. The run is then `partial`, and the next `changed`
 * scope still includes that document.
 */
export function runDeterministic(state: ProjectState, file: CoherenceFile, options: DeterministicOptions): DeterministicResult {
  const requested = [...new Set(options.checks ?? DETERMINISTIC_CHECK_IDS)];
  const includeDocIds = options.scope.mode === 'doc' ? new Set(options.scope.docIds) : undefined;
  const assembled = assembleInput(state, file, { ...options, includeDocIds });
  const scope = resolveScope(assembled.snapshot, file, options.scope);
  const scopeDocIds = new Set(scope.map((scene) => scene.docId));
  const unavailable = new Set(assembled.unavailable);

  // The dialogue branch checks read the containers, which are not documents, so they take part only in a full scan
  // (dialogue-narrative.md §5). A scope over documents names no container, and a `changed` scan keeps no review
  // state for containers, so it cannot say which of them changed. Without the app's dialogue facts there is nothing to read.
  const branchIds = requested.filter((id) => (BRANCH_CHECK_IDS as readonly string[]).includes(id));
  const branchReads = branchIds.length > 0 && options.scope.mode === 'full' && assembled.input.dialogue !== undefined;
  if (branchReads) for (const id of assembled.input.dialogue?.containerIds ?? []) scopeDocIds.add(id);

  // `medium.speaker-parity` compares a scene with a container the scene points at. Like the branch checks it runs on a full scan
  // only: a scan of some documents would raise or clear findings for scenes whose container it did not read.
  const parityRequested = requested.includes(SPEAKER_PARITY);
  const parityReads = parityRequested && options.scope.mode === 'full' && assembled.input.dialogue?.speakersByContainer !== undefined;

  const output = runChecks(assembled.input, requested.filter((id) => id !== SPEAKER_PARITY || parityReads));
  // A draft is kept when the run reads at least one of its quoted documents, or when it quotes none.
  const drafts = output.drafts.filter(
    (draft) => draft.evidence.length === 0 || draft.evidence.some((passage) => scopeDocIds.has(passage.docId)),
  );

  // Without a full count for every scanned document, a codex-wide total is not a fact, so that check does not run.
  const neverEvaluated = assembled.snapshot.scanned.length === 0 || unavailable.size > 0;
  const ranIds = requested.filter(
    (id) =>
      !(id === 'codex.never-mentioned' && neverEvaluated) &&
      !((BRANCH_CHECK_IDS as readonly string[]).includes(id) && !branchReads) &&
      !(id === SPEAKER_PARITY && !parityReads),
  );

  const next = structuredClone(file);
  const runId = mintCoherenceId('r', new Set(next.runs.map((run) => run.id)), options.randomBytes);
  const at = options.now.toISOString();
  const report = upsertFindings(
    next,
    drafts.map(toUpsertDraft),
    {
      runId,
      now: at,
      randomBytes: options.randomBytes,
      clear: {
        checkIds: new Set(ranIds),
        scopeDocIds,
        unevaluatedDocIds: unavailable,
      },
    },
  );

  const titles = (ids: readonly string[]): string => {
    const named = ids.slice(0, EMPTY_DOC_NAMING).map((id) => state.manifest.tree.find((node) => node.id === id)?.title ?? id);
    return named.join(', ') + (ids.length > EMPTY_DOC_NAMING ? `, and ${ids.length - EMPTY_DOC_NAMING} more` : '');
  };

  const notes: string[] = [...output.notes];
  if (branchIds.length > 0 && !branchReads) {
    const reason =
      options.scope.mode !== 'full'
        ? 'they run on a full scan'
        : 'the dialogue containers were not read for this run';
    notes.push(`dialogue checks not run: ${reason}`);
  }
  if (parityRequested && !parityReads) {
    notes.push(`speaker parity not run: ${options.scope.mode !== 'full' ? 'it runs on a full scan' : 'the dialogue speakers were not read for this run'}`);
  }
  if (scope.length === 0) notes.push('no documents in scope');
  if (assembled.snapshot.emptyDocIds.length > 0) {
    notes.push(`${assembled.snapshot.emptyDocIds.length} empty document(s) skipped: ${titles(assembled.snapshot.emptyDocIds)}`);
  }
  if (assembled.snapshot.excludedDocIds.length > 0) {
    notes.push(`${assembled.snapshot.excludedDocIds.length} archived or excluded document(s) not scanned`);
  }
  if (unavailable.size > 0) {
    notes.push(`mention counts unavailable for ${unavailable.size} document(s); presence and coverage checks skipped for them`);
  }
  if (report.redetectedDismissed > 0) notes.push(`${report.redetectedDismissed} previously dismissed finding(s) still present`);
  if (report.redetectedFixed.length > 0) notes.push(recurredAfterFixedNote(next, report.redetectedFixed));
  if (report.cleared > 0) notes.push(`${report.cleared} open finding(s) no longer detected were cleared`);

  const run: CoherenceRun = {
    id: runId,
    at,
    kind: 'deterministic',
    checkIds: ranIds,
    scope: { docIds: [...scopeDocIds].sort(), mode: options.scope.mode },
    findingsUpserted: report.upserted,
    status: unavailable.size > 0 ? 'partial' : 'complete',
    notes,
  };
  next.runs.push(run);
  if (next.runs.length > RUN_HISTORY_LIMIT) next.runs.splice(0, next.runs.length - RUN_HISTORY_LIMIT);

  for (const scene of scope) {
    if (unavailable.has(scene.docId)) continue;
    next.reviewState[scene.docId] = { lastReviewedRevision: scene.revision, lastReviewedAt: at };
  }
  return { file: next, run };
}
