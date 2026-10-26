/**
 * The coherence module's tools, wired to its engine — [coherence.md §7](../../../../docs/architecture/coherence.md).
 *
 * The three tools are declared in `@caotang/coherence` (`tools.ts`) in the entry shape the registry
 * reads, and `table.ts` joins them to this file's ports. Two of the three have a port here:
 *
 * - `coherence.scan` (read) runs the deterministic checks. Its findings and run are appended to the
 *   coherence file the state holds. That append is the appender side-effect of coherence.md §7
 *   tool 15, the same class as `sessions.jsonl`, so it is not a bus command and has no undo entry. The port
 *   reports that change as an effect (`recordEffect`), so the runtime caches its answer by callId and a
 *   replay does not run the scan again (command-bus §6). It writes its turn-report row through `logRow`
 *   (coherence.md §9), and it reads the turn's approvals (`permission`), so a scope over the guard runs once
 *   the writer has agreed to it. The port fits its own answer to the cap, so a run with many finding groups
 *   is not refused after it has been recorded.
 * - `coherence.setFindingStatus` (write-auto, restricted to `fixed`) runs the engine's refusals and
 *   its postcondition (`setFindingStatusTool`), then dispatches the bus command
 *   `coherence.setFindingStatus` under the tool's own grant (`dispatchInherited`), so the change is
 *   undoable and logged. The gate refuses a dismissal before the grant is read (permission.ts).
 *
 * A scope over the document guard is refused, with the way a read caller can proceed: one document at
 * a time. The engine's own sentence offers a confirmation, but this port has no confirmation to pass it
 * (`PortContext` carries none), so the port does not repeat the offer.
 *
 * `coherence.review` has no port here. Its pipeline awaits a model call, and a port is synchronous, so the review
 * is an async tool (`asyncPorts`, runtime.ts): the agent runs it after the writer approves its plan card, and the app
 * supplies the model (coherence.md §5.3, §7 tool 16).
 *
 * The scan reads the writer's Coherence settings through `source.checks` (Settings › Coherence): a check the writer turned
 * off does not run, even when the model names it, and the answer says which checks were left out. It reads the dialogue
 * module's findings through `source.dialogue`, so the branch checks run on a full scan (coherence.md §5.1,
 * dialogue-narrative.md §5). The app supplies both, because the settings and the dialogue validation live in the app.
 */

import { err, ok, type CommandError, type Result } from '@caotang/bus';
import { compileCodex, countMentions } from '@caotang/codex';
import { withheldState } from '@caotang/context';
import {
  DETERMINISTIC_CHECK_IDS,
  SCAN_DOC_GUARD,
  emptyCoherenceFile,
  executeReviewTool,
  previewReviewTool,
  scanTool,
  setFindingStatusTool,
  type CoherenceFile,
  type CoherenceModel,
  type DeterministicCheckId,
  type DialogueFacts,
  type MentionDetector,
  type ReviewContext,
  type ReviewPlan,
  type ScanData,
  type ToolFailure,
} from '@caotang/coherence';
import type { ProjectState, TreeNode } from '@caotang/store';

import { refusal } from '../errors.js';
import { capOf } from '../metadata.js';
import { fitsCap } from '../tokens.js';
import type { AsyncToolPort, CallParams, PortToolName, ToolPort, ToolOutcome, ToolValue } from '../types.js';

/**
 * What the app tells the coherence tools about its own settings and data, read at each call so a change in Settings applies to
 * the next scan. Absent, every deterministic check runs and no dialogue facts are read: the scan of a bare harness.
 */
export interface CoherenceSource {
  /** The deterministic checks the writer has turned on. Absent, all of them are on. */
  readonly checks?: () => readonly DeterministicCheckId[];
  /** The dialogue module's findings for the open project (dialogue-narrative.md §5), or undefined when the app has none to give. */
  readonly dialogue?: (state: ProjectState) => DialogueFacts | undefined;
  /**
   * The model the review runs through, read at each call (provider-gateway §2: the active profile). Undefined when no provider is
   * active, and then the review is refused with the sentence that names the provider. Absent, `coherence.review` is not wired.
   */
  readonly model?: () => CoherenceModel | undefined;
  /** The review's context, the codex and the story so far (coherence.md §5.3), for the state it is planned against. */
  readonly review?: (state: ProjectState) => ReviewContext;
}

/**
 * The checks one scan runs: what the model named (or every check), kept to the ones the writer has on. `checks` is what the
 * scan is given, or undefined for every check (the engine's default, which is only used when nothing is turned off).
 */
interface RunnableChecks {
  readonly checks?: readonly DeterministicCheckId[];
  /** The named checks the writer has turned off, which this scan leaves out. */
  readonly skipped: readonly DeterministicCheckId[];
}

/**
 * The codex's own detector, run over one body with the spellings the body adds (a screenplay's cue names). The scan counts
 * mentions with it, as the Findings tab's scan does (session.ts countInEntries), so the two scans agree.
 */
export const countIn: MentionDetector = (body, entries, terms) => countMentions(body, compileCodex(entries), terms);

/** The checks a scan runs, or the refusal when the writer has turned every one of them off. */
function runnableChecks(requested: unknown, enabled: readonly DeterministicCheckId[] | undefined): RunnableChecks | ToolFailure {
  if (enabled === undefined) return { skipped: [] };
  const named = Array.isArray(requested) ? (requested as DeterministicCheckId[]) : [...DETERMINISTIC_CHECK_IDS];
  const checks = named.filter((id) => enabled.includes(id));
  const skipped = named.filter((id) => !enabled.includes(id));
  if (checks.length === 0) {
    return {
      ok: false,
      code: 'checks-off',
      message:
        'Every check this scan would run is turned off in Settings, under Coherence, so nothing ran. Turn a check on there, or ask the writer which checks to run.',
    };
  }
  return { checks, skipped };
}

/** Whether a checks answer is a refusal rather than the checks to run. */
function isRefusal(value: RunnableChecks | ToolFailure): value is ToolFailure {
  return 'ok' in value;
}

/**
 * What a read rule keeps out of a scan or a review (agent-harness §4): the withheld documents are left out like archived ones, so
 * no finding quotes them. Undefined when nothing is withheld, which leaves the engine's own rule.
 */
function excludedBy(withheld: ReadonlySet<string> | undefined): ((node: TreeNode) => boolean) | undefined {
  return withheld === undefined || withheld.size === 0 ? undefined : (node) => node.status === 'archived' || withheld.has(node.id);
}

/**
 * The coherence file the state holds, or an empty one for a project that has none yet. The engine
 * takes a `CoherenceFile`, and the state holds the store's structural copy of it (coherence-state.ts):
 * the coherence module's file is assignable to that copy, so the downcast below is the only one.
 */
export function heldFile(state: ProjectState): CoherenceFile {
  return (state.coherence as CoherenceFile | undefined) ?? emptyCoherenceFile();
}

/**
 * An engine refusal as the bus's error shape, with the engine's own sentence as the message. A dismissal
 * is `hard-denied`, the code the bus gives the same refusal at its gate (coherence.md §6.3, permission.ts):
 * the engine answers it first here, so the port says what the gate would say. Every other refusal is a
 * parameter the model got wrong, or a finding it cannot change, so it is `invalid-params`; an engine
 * failure with no code of its own is `internal`.
 */
function refusalOf(failed: ToolFailure, name: PortToolName): CommandError {
  if (failed.code === 'dismissal-is-writer-judgment') return refusal('hard-denied', failed.message, { target: name, risk: 'never' });
  if (failed.code === 'confirmation-required') return overGuard(name);
  return refusal(failed.code === 'failed' ? 'internal' : 'invalid-params', failed.message, { target: name });
}

/** The `details` key, and its value, that marks a refusal a one-step card can answer: a scope over the document guard. */
export const LARGE_SCOPE_APPROVAL_KEY = 'approval';
export const LARGE_SCOPE_APPROVAL = 'large-scope';

/**
 * The refusal for a scope over the document guard (coherence.md §6.2, §7 tool 15). A read has no
 * confirmation step, and the port has no approval to hand the engine, so the sentence names only what
 * the caller can do: scan the scope a document at a time, which each `mode: "doc"` call allows.
 */
function overGuard(name: PortToolName): CommandError {
  return refusal(
    'invalid-params',
    `This scope is over the ${SCAN_DOC_GUARD}-document guard, and ${name} has no confirmation step, so it cannot run the whole scope in one call. ` +
      `Scan one document at a time: call ${name} with scope {"mode": "doc", "docIds": ["<id>"]} for each document in the scope.`,
    {
      target: name,
      correctiveHint: 'binder.read_tree lists the document ids, and each call scans one of them',
      // The agent loop reads this mark and puts the scope in front of the writer on a one-step card (agent/loop.ts). An
      // external caller holds no card, so for it the message above is the whole answer.
      details: { [LARGE_SCOPE_APPROVAL_KEY]: LARGE_SCOPE_APPROVAL },
    },
  );
}

/**
 * The scan's answer with as many finding groups as its cap admits, and the number left out. The groups
 * keep the order the engine gave them. The cut is found by bisection, because a longer prefix of the
 * groups never fits where a shorter one does not.
 */
function fitGroups(data: ScanData, cap: number): { readonly data: Record<string, unknown>; readonly omitted: number } {
  const fits = (count: number): boolean => fitsCap({ ...data, groups: data.groups.slice(0, count) }, cap);
  let low = 0;
  let high = data.groups.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return { data: { ...data, groups: data.groups.slice(0, low) }, omitted: data.groups.length - low };
}

/**
 * The two engine-backed ports, keyed by tool name. `clock` stamps the run and the status change, so
 * a test reads the same times the rest of the harness reads.
 */
export function coherencePorts(clock: () => number, source: CoherenceSource = {}): Readonly<Partial<Record<PortToolName, ToolPort>>> {
  const scan: ToolPort = (params, context) => {
    // The writer's agreement to a scope over the guard, from the turn's approvals (coherence.md §7 tool 15):
    // a plan approved as a whole, or a one-step card for this call. An external caller holds neither.
    const approvedLargeScope = context.permission?.confirmed === true || context.permission?.approvedPlan === true;
    // The checks the writer has on (Settings › Coherence), and the checks the model named among them (coherence.md §5.1).
    const runnable = runnableChecks(params['checks'], source.checks?.());
    if (isRefusal(runnable)) return failure(refusal('invalid-params', runnable.message, { target: 'coherence.scan' }));
    // The dialogue facts are read from the project as the agent may read it, so a container in a withheld subtree yields none.
    const dialogue = source.dialogue?.(context.withheld === undefined ? context.state : withheldState(context.state, context.withheld));
    const excluded = excludedBy(context.withheld);
    const scanParams: Readonly<Record<string, unknown>> = runnable.checks === undefined ? params : { ...params, checks: [...runnable.checks] };
    const outcome = scanTool(scanParams, {
      state: context.state,
      file: heldFile(context.state),
      now: new Date(clock()),
      approvedLargeScope,
      detector: countIn,
      ...(dialogue === undefined ? {} : { dialogue }),
      ...(excluded === undefined ? {} : { isExcluded: excluded }),
    });
    if (!outcome.ok) return failure(refusalOf(outcome, 'coherence.scan'));
    // The appender side-effect of coherence.md §7 tool 15: the run and its findings join the held file. The
    // change is held state the bus does not see, so it is reported as an effect and the answer is cached by callId.
    if (outcome.file !== undefined) {
      context.state.coherence = outcome.file;
      context.recordEffect();
    }
    // The turn report's row (coherence.md §9): the run, in one line, under the turn that asked for it.
    context.logRow(outcome.summary);
    // The answer is fitted to its cap here, after the run is held. The runtime measures a read's answer
    // only when nothing was written, so an over-cap answer would be refused after its run was recorded.
    const fitted = fitGroups(outcome.data, capOf('coherence.scan'));
    const notes = [
      ...(runnable.skipped.length === 0
        ? []
        : [`These checks are turned off in Settings, so this scan did not run them: ${runnable.skipped.join(', ')}.`]),
      ...(fitted.omitted === 0
        ? []
        : [
            `${fitted.omitted} of the ${outcome.data.groups.length} finding groups are left out of this answer to keep it within its cap. The run and every finding are recorded in full, and the findings inbox shows them.`,
          ]),
    ];
    const value: ToolValue = {
      data: { ...fitted.data },
      summary: outcome.summary,
      affected: [],
      ...(notes.length === 0 ? {} : { notes }),
    };
    return ok(value);
  };

  const setStatus: ToolPort = (params, context) => {
    const outcome = setFindingStatusTool(params, { state: context.state, file: heldFile(context.state), now: new Date(clock()), detector: countIn });
    if (!outcome.ok) return failure(refusalOf(outcome, 'coherence.setFindingStatus'));
    if (outcome.data.alreadyFixed) {
      const value: ToolValue = { data: { ...outcome.data }, summary: outcome.summary, affected: [] };
      return ok(value);
    }
    // The engine has accepted the change, so the bus command makes it, under the tool's grant.
    const note = typeof params['note'] === 'string' ? params['note'] : undefined;
    const dispatched = context.dispatchInherited('coherence.setFindingStatus', {
      findingId: outcome.data.findingId,
      status: 'fixed',
      ...(note === undefined ? {} : { note }),
    });
    if (!dispatched.ok) return failure(dispatched.error);
    const value: ToolValue = {
      data: { ...outcome.data },
      summary: outcome.summary,
      affected: [...dispatched.value.affected],
      ...(dispatched.value.undoGroupId === undefined ? {} : { undoGroupId: dispatched.value.undoGroupId }),
    };
    return ok(value);
  };

  return { 'coherence.scan': scan, 'coherence.setFindingStatus': setStatus };
}

/**
 * The review's plan for a step the loop is staging (coherence.md §7 tool 16, the plan half). Pure: nothing is sent to a model, so
 * the plan is what the card shows before the writer approves it: the documents, the cost estimate and the first prompt. Refused,
 * with the sentence the writer can act on, when no provider is active.
 */
export function stageReviewPlan(
  params: CallParams,
  state: ProjectState,
  clock: () => number,
  source: CoherenceSource,
  withheld?: ReadonlySet<string>,
): Result<ReviewPlan, CommandError> {
  const model = source.model?.();
  const excluded = excludedBy(withheld);
  const outcome = previewReviewTool(params, {
    state,
    file: heldFile(state),
    now: new Date(clock()),
    ...(model === undefined ? {} : { model }),
    ...(source.review === undefined ? {} : { review: source.review(withheld === undefined ? state : withheldState(state, withheld)) }),
    ...(excluded === undefined ? {} : { isExcluded: excluded }),
  });
  if (!outcome.ok) return err(refusalOf(outcome, 'coherence.review'));
  return ok(outcome.data.plan);
}

/**
 * The async port for `coherence.review`, the run half (coherence.md §7 tool 16): the approved plan runs through the engine with the
 * model the app supplies, and the findings file is written the way a scan writes it. The turn's log carries the run's row. The
 * port is absent without a model source, so the tool is then not wired.
 */
export function coherenceAsyncPorts(clock: () => number, source: CoherenceSource = {}): Readonly<Partial<Record<PortToolName, AsyncToolPort>>> {
  if (source.model === undefined) return {};
  const review: AsyncToolPort = async (_params, context) => {
    const plan = context.proposal as ReviewPlan | undefined;
    if (plan === undefined || !Array.isArray(plan.documents)) {
      return failure(
        refusal('invalid-params', 'coherence.review has no plan to run: the agent plans it before its card is shown, and none was staged for this call', {
          correctiveHint: 'plan the review again, and wait for the writer to approve the card',
          target: 'coherence.review',
        }),
      );
    }
    const model = source.model?.();
    if (model === undefined) {
      return failure(refusal('invalid-params', 'No provider is active, so the review cannot run. Add a provider in Settings, then run the review again.', { target: 'coherence.review' }));
    }
    // The model awaits take a while, and a scan or a fix made meanwhile replaces the held file. The run is written into the file
    // as it stands when the model has answered (`currentFile`), so that change is kept and not overwritten by this copy.
    const result = await executeReviewTool(plan, true, {
      state: context.state,
      file: heldFile(context.state),
      now: new Date(clock()),
      model,
      ...(source.review === undefined ? {} : { review: source.review(context.withheld === undefined ? context.state : withheldState(context.state, context.withheld)) }),
      ...(excludedBy(context.withheld) === undefined ? {} : { isExcluded: excludedBy(context.withheld) }),
      currentFile: () => heldFile(context.state),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    if (!result.ok) return failure(refusalOf(result, 'coherence.review'));
    // The appender side-effect of coherence.md §7 tool 16, as the scan makes it: the run and its findings join the held file.
    if (result.file !== undefined) {
      context.state.coherence = result.file;
      context.recordEffect();
    }
    context.logRow(result.summary);
    const fitted = fitGroups(result.data, capOf('coherence.review'));
    const notes = [
      ...result.data.notes,
      ...(fitted.omitted === 0
        ? []
        : [`${fitted.omitted} of the ${result.data.groups.length} finding groups are left out of this answer to keep it within its cap. The findings inbox shows them all.`]),
    ];
    return ok({ data: { ...fitted.data }, summary: result.summary, affected: [], ...(notes.length === 0 ? {} : { notes }) });
  };
  return { 'coherence.review': review };
}

/** A refusal as an outcome, for a port that has none to give. */
function failure(error: CommandError): ToolOutcome {
  return { ok: false, error };
}
