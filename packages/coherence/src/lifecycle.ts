/**
 * Changing what a finding says about itself — [coherence.md §6.3 and §7](../../../docs/architecture/coherence.md).
 *
 * Who may do what, in one place:
 *  - **Dismiss** is the writer's (D5). The reason must come from the picker.
 *  - **Re-open** is the writer's.
 *  - **Mark fixed** is the writer's, and it is also the agent's, but only with the
 *    postcondition below: the agent marks a finding fixed only after the text
 *    that produced it has actually changed.
 *  - **Discard run** is the writer's. It removes what the run made and the writer
 *    never touched.
 *
 * Each function returns a new file and never mutates its input.
 */

import { findingsDiscardedWith } from '@caotang/bus';
import { getBody, type ProjectState } from '@caotang/store';

import { validateDismissal } from './dismissal.js';
import { CoherenceError } from './errors.js';
import type { CoherenceFile, DeterministicCheckId, Finding } from './model.js';
import { runChecks } from './checks/index.js';
import { assembleInput, type AssembleOptions } from './input.js';
import { identityOf } from './upsert.js';
import { noteLengthProblem, trimNote } from './text.js';

function findingOrThrow(file: CoherenceFile, id: string): Finding {
  const finding = file.findings.find((candidate) => candidate.id === id);
  if (finding === undefined) throw new CoherenceError('finding-not-found', `no finding has id "${id}"`);
  return finding;
}

/** §6.3: dismissal from the picker, with an optional note. Only an open finding can be dismissed. */
export function dismissFinding(
  file: CoherenceFile,
  id: string,
  request: { readonly reason: unknown; readonly note?: string },
  now: Date,
): CoherenceFile {
  const verdict = validateDismissal(request.reason, request.note);
  if (!verdict.ok) throw new CoherenceError('dismissal-invalid', verdict.error);
  const next = structuredClone(file);
  const finding = findingOrThrow(next, id);
  if (finding.status !== 'open') {
    throw new CoherenceError('finding-not-open', `finding ${id} is ${finding.status}; re-open it before dismissing`);
  }
  finding.status = 'dismissed';
  finding.dismissedReason = request.reason as string;
  const note = trimNote(request.note);
  if (note !== undefined) finding.note = note;
  else delete finding.note;
  finding.updatedAt = now.toISOString();
  finding.touchedAt = now.toISOString();
  return next;
}

/** §6.3: "re-open is one click". Clears the verdict, so a re-opened finding carries no stale reason. */
export function reopenFinding(file: CoherenceFile, id: string, now: Date): CoherenceFile {
  const next = structuredClone(file);
  const finding = findingOrThrow(next, id);
  if (finding.status === 'open') throw new CoherenceError('finding-already-open', `finding ${id} is already open`);
  finding.status = 'open';
  delete finding.dismissedReason;
  delete finding.note;
  finding.updatedAt = now.toISOString();
  finding.touchedAt = now.toISOString();
  return next;
}

/** The writer's own "mark fixed". No postcondition: the writer is the judge of their own text. */
export function markFindingFixed(file: CoherenceFile, id: string, note: string | undefined, now: Date): CoherenceFile {
  const problem = noteLengthProblem(note);
  if (problem !== undefined) throw new CoherenceError('note-too-long', `the note is ${problem}`);
  const trimmed = trimNote(note);
  const next = structuredClone(file);
  const finding = findingOrThrow(next, id);
  if (finding.status !== 'open') throw new CoherenceError('finding-not-open', `finding ${id} is ${finding.status}`);
  finding.status = 'fixed';
  if (trimmed !== undefined) finding.note = trimmed;
  finding.updatedAt = now.toISOString();
  finding.touchedAt = now.toISOString();
  return next;
}

/** A refusal the model can act on. `message` is the text it reads, so it names the next move. */
export type AgentRefusal =
  | 'status-not-settable'
  | 'dismissal-is-writer-judgment'
  | 'note-too-long'
  | 'unknown-finding'
  | 'finding-dismissed'
  | 'evidence-still-present'
  | 'cannot-verify';

export type AgentStatusOutcome =
  | { readonly ok: true; readonly file: CoherenceFile; readonly finding: Finding; readonly alreadyFixed: boolean }
  | { readonly ok: false; readonly refusal: AgentRefusal; readonly message: string };

export interface AgentStatusRequest {
  readonly findingId: string;
  readonly status: string;
  readonly note?: string;
}

export interface PostconditionCheck {
  readonly present: boolean;
  readonly refusal?: AgentRefusal;
  readonly message?: string;
}

const STILL_PRESENT = 'evidence still present — apply the fix first';

/**
 * §5.1 checks that read mention counts. When a count they need is missing, the check
 * reports "not evaluated" and produces no finding (checks/codex.ts, checks/presence.ts),
 * so its silence proves nothing and the postcondition must not read it as proof.
 */
const READS_MENTION_COUNTS: ReadonlySet<string> = new Set(['codex.never-mentioned', 'pov.coverage', 'presence.expected']);

/**
 * The §7 postcondition. A finding counts as still present when its text is still
 * in the manuscript (for llm findings) or when the check that produced it still
 * produces the same finding (for deterministic ones). The recompute is the honest
 * test for a deterministic finding, since its evidence is the scene's opening and
 * it can be fixed without that opening changing. A recompute that could not run the
 * check is not a pass: the answer is "cannot verify", never "absent".
 */
export function stillPresent(
  state: ProjectState,
  file: CoherenceFile,
  finding: Finding,
  options: AssembleOptions,
): PostconditionCheck {
  if (finding.class === 'llm') {
    const found = finding.evidence.some((passage) => passage.quote !== '' && getBody(state, passage.docId).includes(passage.quote));
    return found ? { present: true, refusal: 'evidence-still-present', message: STILL_PRESENT } : { present: false };
  }
  const assembled = assembleInput(state, file, options);
  const evaluated =
    !READS_MENTION_COUNTS.has(finding.checkId) ||
    (assembled.unavailable.length === 0 && (finding.checkId !== 'codex.never-mentioned' || assembled.snapshot.scanned.length > 0));
  if (!evaluated || finding.evidence.some((passage) => assembled.unavailable.includes(passage.docId))) {
    return {
      present: true,
      refusal: 'cannot-verify',
      message: 'the mention counts this check needs are not all available, so the fix cannot be checked yet',
    };
  }
  // The parity check compares against the dialogue's speakers; without them it is silent, and silence is not a fix.
  if (finding.checkId === 'medium.speaker-parity' && assembled.input.dialogue?.speakersByContainer === undefined) {
    return { present: true, refusal: 'cannot-verify', message: 'the dialogue speakers this check needs are not available, so the fix cannot be checked yet' };
  }
  const drafts = runChecks(assembled.input, [finding.checkId as DeterministicCheckId]).drafts;
  const key = identityOf(finding);
  return drafts.some((draft) => identityOf(draft) === key)
    ? { present: true, refusal: 'evidence-still-present', message: STILL_PRESENT }
    : { present: false };
}

/**
 * §7 tool 17 and §7.1: the agent may set `fixed` and nothing else. A dismissal
 * is refused with the spec's own wording, because the model's next step is to
 * put it in a report, not to try again.
 */
export function setFindingStatusForAgent(
  state: ProjectState,
  file: CoherenceFile,
  request: AgentStatusRequest,
  options: AssembleOptions & { readonly now: Date },
): AgentStatusOutcome {
  if (request.status === 'dismissed') {
    return { ok: false, refusal: 'dismissal-is-writer-judgment', message: 'dismissal is a writer judgment; propose it in your report' };
  }
  if (request.status !== 'fixed') {
    return { ok: false, refusal: 'status-not-settable', message: `the agent can set only "fixed"; "${request.status}" is not available to it` };
  }
  // Checked before the finding is read, and against the same limit the writer's path uses, so a note the file
  // could not hold on its next load is never written.
  const problem = noteLengthProblem(request.note);
  if (problem !== undefined) {
    return { ok: false, refusal: 'note-too-long', message: `the note is ${problem}. Shorten it and try again.` };
  }
  const found = file.findings.find((candidate) => candidate.id === request.findingId);
  if (found === undefined) {
    return {
      ok: false,
      refusal: 'unknown-finding',
      message: `no finding has id "${request.findingId}"; use an id from a recent run report or the findings inbox`,
    };
  }
  if (found.status === 'fixed') return { ok: true, file, finding: found, alreadyFixed: true };
  if (found.status === 'dismissed') {
    return { ok: false, refusal: 'finding-dismissed', message: "the finding is dismissed; re-opening it is the writer's call" };
  }

  const check = stillPresent(state, file, found, options);
  if (check.present) {
    return { ok: false, refusal: check.refusal ?? 'evidence-still-present', message: check.message ?? STILL_PRESENT };
  }

  const next = structuredClone(file);
  const target = findingOrThrow(next, request.findingId);
  target.status = 'fixed';
  const note = trimNote(request.note);
  if (note !== undefined) target.note = note;
  target.updatedAt = options.now.toISOString();
  target.touchedAt = options.now.toISOString();
  return { ok: true, file: next, finding: target, alreadyFixed: false };
}

/**
 * §7.1 `coherence.discardRun`: removes the run and the findings it created that
 * nobody has touched. A touched finding stays, with its history, and so does one
 * the run only updated. "Created" is the run that made the finding, recorded when
 * it was made, and "touched" is the writer's or the agent's recorded touch. Neither
 * is inferred from the current status or from timestamps.
 */
export function discardRun(file: CoherenceFile, runId: string): { file: CoherenceFile; removedFindingIds: string[] } {
  const next = structuredClone(file);
  const run = next.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) throw new CoherenceError('run-not-found', `no run has id "${runId}"`);
  // The rule is the bus's (`findingsDiscardedWith`), the one the store applies, so the two cannot disagree.
  const { kept, removed } = findingsDiscardedWith(next.findings, runId);
  next.findings = kept;
  const removedFindingIds = removed.map((finding) => finding.id);
  next.runs = next.runs.filter((candidate) => candidate.id !== runId);
  return { file: next, removedFindingIds };
}
