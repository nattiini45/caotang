/**
 * `agent.plan` — agent-harness.md §2's plan protocol, as data and as two functions.
 *
 * A plan is `{ steps: [{ tool, params, expect }] }`. It is not a tool the model
 * calls mid-reasoning; it is the protocol for a multi-step turn, and the harness
 * runs it in two phases:
 *
 * 1. **Preflight** (`preflight`) checks every step with its tool's pure
 *    `prepare`, so every step's bus `validate` has run before the card is shown.
 *    Nothing is written. A plan with a refused step cannot be approved.
 * 2. **Execution** (`runPlan`) runs the approved steps in order under one turn,
 *    with `approvedPlan` set, so every write-confirm step passes its gate because
 *    the user approved the card. The first failing step stops the plan, and the
 *    result is an ask-back envelope (agent-harness §2) naming what completed and
 *    the undo group that reverses it. Nothing is undone automatically.
 *
 * **One deferral, and the only one.** A step can name something an *earlier* step
 * creates (a document imported in step 1, titled in step 2). At preflight that
 * step's lookup fails, although it may succeed at execution. Such a step is
 * `deferred` and checked again when it runs, rather than refused. A deferral is
 * only granted when an earlier step can create nodes, so a typo in a plan with no
 * creating step is still refused. The edit-time dependency badge of agent-harness
 * §2 is not implemented: it needs a card UI, which this package does not have.
 *
 * **Plans are data.** The validated plan is the one that runs, and it is what the
 * replay cache (`runtime.ts`) keys on the plan's canonical form.
 */

import { ok, type CommandError, type CommandErrorCode, type CommandErrorDetails, type Result } from '@caotang/bus';

import { invalidParams, refusal } from './errors.js';
import { param, type ObjectSpec } from './schema.js';
import { checkParams } from './validate.js';
import type { CallParams, ToolCall, ToolOutcome, ToolValue, TurnContext } from './types.js';

/** The plan step bound, one number for every batch surface the planner can carry. `OPS_MAX` is the structural batch limit. */
export const PLAN_STEPS_MAX = 30;

/** The plan's own schema. A step's params are checked by the step's tool, so the plan says only "an object". */
export const planParams: ObjectSpec = param.object(
  'A plan: an ordered list of tool calls, each with the effect it expects.',
  {
    steps: param.list(
      'The steps, in order. At least one.',
      param.object(
        'One step: a tool call and the effect it should have.',
        {
          tool: param.string('The tool this step calls, by name.', { nonBlank: true }),
          params: param.freeObject('The tool’s params. The tool checks them when the plan is preflighted.'),
          expect: param.string('The effect the step should have, in words, shown on the card.', { nonBlank: true }),
        },
        ['tool', 'params', 'expect'],
      ),
      { minItems: 1, maxItems: PLAN_STEPS_MAX },
    ),
  },
  ['steps'],
);

export interface PlanStep {
  readonly tool: string;
  readonly params: CallParams;
  readonly expect: string;
}

export interface Plan {
  readonly steps: readonly PlanStep[];
}

export interface PlanStepPreflight {
  readonly index: number;
  readonly tool: string;
  readonly expect: string;
  readonly status: 'ready' | 'deferred' | 'refused';
  /** The tool's preview for the card, when its prepare produced one. */
  readonly preview?: unknown;
  /** Refused: the refusal. Deferred: the lookup failure that was deferred. */
  readonly error?: CommandError;
  /** Deferred: why the refusal was not final. */
  readonly reason?: string;
}

export interface PlanPreflight {
  /** True when no step is refused. A deferred step does not stop approval. */
  readonly ok: boolean;
  readonly steps: readonly PlanStepPreflight[];
}

export interface StepResult {
  readonly index: number;
  readonly tool: string;
  readonly expect: string;
  readonly value: ToolValue;
}

/** `budget_exhausted`: the run reached a limit the writer set (agent-harness §7.1). */
export type AskBackCode = 'verify_failed' | 'anchor_unresolvable' | 'needs_input' | 'conflict' | 'budget_exhausted';

/** agent-harness §2's envelope, shared by a failed check and an unresolvable anchor. */
export interface AskBack {
  readonly code: AskBackCode;
  readonly reason: string;
  readonly revisionDrift?: number;
  /** edit-anchors §3 step 5: up to three re-match hits, offered when an anchor could not be placed. */
  readonly candidates?: readonly { readonly from: number; readonly to: number; readonly similarity: number }[];
  /** Two or three next actions, rendered as buttons on the card. */
  readonly options: readonly string[];
}

/**
 * How a plan is checked or run. `from` resumes a plan at a step, which the verify ladder uses to
 * retry the step that failed without re-running the steps before it. `proposals` is one entry per
 * step, aligned by index, holding what the agent loop staged for a model-backed step. `signal` is the writer's
 * stop: it is read before each step, never inside one, so a started step finishes and the steps after it do not run.
 * `until` ends the run before that step (exclusive): the agent loop runs a logged plan one step at a time, so each step's record is
 * written before it runs and after it is saved (agent-harness §5.1). A run with `until` is not recorded in the plan replay cache.
 */
export interface PlanOptions {
  readonly from?: number;
  readonly until?: number;
  readonly proposals?: readonly unknown[];
  readonly signal?: AbortSignal;
}

export type PlanOutcome =
  | { readonly status: 'refused'; readonly preflight: PlanPreflight }
  | {
      readonly status: 'failed';
      readonly completed: readonly StepResult[];
      readonly failedAt: number;
      readonly error: CommandError;
      readonly askBack: AskBack;
      readonly undoGroupId?: string;
    }
  | { readonly status: 'applied'; readonly steps: readonly StepResult[]; readonly undoGroupId?: string }
  /** The signal fired before step `stoppedAt`: the steps before it are applied, and it and the rest did not run. */
  | { readonly status: 'stopped'; readonly completed: readonly StepResult[]; readonly stoppedAt: number; readonly undoGroupId?: string };

/** What the plan needs from the harness: whether a tool exists, a pure check of one step, and a call. */
export interface PlanHost {
  known(tool: string): boolean;
  /** A pure check of one step. `proposal` is what the loop staged for it, for a step whose content the model drafts (`shots.derive`). */
  check(tool: string, params: unknown, proposal?: unknown): Result<{ readonly preview?: unknown }, CommandError>;
  run(call: ToolCall, turn: TurnContext): ToolOutcome;
}

/** The step index a plan starts at, read from its options. Nothing before it is checked or run. */
function startOf(plan: Plan, options: PlanOptions): number {
  const from = options.from ?? 0;
  if (!Number.isInteger(from) || from < 0 || from > plan.steps.length) return 0;
  return from;
}

/** The step index a run stops before: the plan's end unless `until` names an earlier step. */
function endOf(plan: Plan, options: PlanOptions): number {
  const until = options.until;
  if (until === undefined || !Number.isInteger(until) || until < 0 || until > plan.steps.length) return plan.steps.length;
  return until;
}

/** A plan as the model sent it, checked against the plan schema. */
export function parsePlan(input: unknown): Result<Plan, CommandError> {
  const checked = checkParams('agent.plan', planParams, input);
  if (!checked.ok) return checked as Result<Plan, CommandError>;
  return ok(checked.value as unknown as Plan);
}

/** What a lookup failure could not find: a node, or a status or label. */
type LookupKind = 'node' | 'term';

/**
 * Whether a step can create something of `kind` that a later step may name.
 *
 * `doc.import` always creates a node. `binder.restructure` does when one of its ops is a create. `vocabulary.upsert` creates a
 * term when it names no id, and a `meta.set` or `filter.save` after it may name the term it makes. Nothing else in the registry
 * creates anything a step names.
 */
function mayCreate(step: PlanStep, kind: LookupKind): boolean {
  if (kind === 'term') return step.tool === 'vocabulary.upsert' && step.params['id'] === undefined;
  if (step.tool === 'doc.import') return true;
  if (step.tool !== 'binder.restructure') return false;
  const ops = step.params['ops'];
  return Array.isArray(ops) && ops.some((op) => typeof op === 'object' && op !== null && (op as { action?: unknown }).action === 'create');
}

/**
 * An ambiguous name: `resolveNode` refuses it as `invalid-params` carrying the
 * `candidates` it matched, so a caller can pick one without reading the prose.
 *
 * The anchor refusal carries `candidates` too, and it is not one: it names its
 * own case in `details.askBackCode`, and its candidates may be empty. A name
 * that matched nothing is not an ambiguous name either, so the array has to hold
 * at least one candidate to count.
 */
function isAmbiguousName(error: { readonly code?: CommandErrorCode; readonly details?: CommandErrorDetails }): boolean {
  return (
    error.code === 'invalid-params' &&
    error.details?.['askBackCode'] !== 'anchor_unresolvable' &&
    Array.isArray(error.details?.['candidates']) &&
    error.details['candidates'].length > 0
  );
}

/**
 * What a refusal could not find, as the kinds a creating step could supply. A batch tool wraps its per-op
 * failures in `invalid-params`, so the lookup failure sits in `details.failures`, and both shapes count. An ambiguous name
 * counts too: `resolveNode` refuses it as `invalid-params` carrying the `candidates` it matched, and a step earlier in the
 * plan may still create the document that makes the name exact by the time this step runs. A status or label the project
 * does not hold (`details.unknownVocabulary`) is a `term`, which an earlier `vocabulary.upsert` may add.
 */
function lookupKinds(error: CommandError): readonly LookupKind[] {
  const own: LookupKind[] = [];
  if (error.code === 'not-found' || isAmbiguousName(error)) own.push('node');
  if (error.details?.unknownVocabulary !== undefined) own.push('term');
  const failures = error.details?.['failures'];
  if (!Array.isArray(failures)) return own;
  for (const failure of failures) {
    if (failure.code === 'not-found' || isAmbiguousName(failure)) own.push('node');
    if (failure.details?.['unknownVocabulary'] !== undefined) own.push('term');
  }
  return own;
}

/** Checks every step from the plan's start, in order, with no effect. */
export function preflight(plan: Plan, host: PlanHost, options: PlanOptions = {}): PlanPreflight {
  const steps: PlanStepPreflight[] = [];
  const end = endOf(plan, options);
  for (let index = startOf(plan, options); index < end; index += 1) {
    const step = plan.steps[index] as PlanStep;
    const base = { index, tool: step.tool, expect: step.expect };
    if (!host.known(step.tool)) {
      steps.push({
        ...base,
        status: 'refused',
        error: refusal('not-found', `"${step.tool}" is not a tool in this build`, {
          correctiveHint: 'use one of the tool names in the registry, or drop this step',
          target: `steps[${index}].tool`,
        }),
      });
      continue;
    }
    const checked = host.check(step.tool, step.params, options.proposals?.[index]);
    if (checked.ok) {
      steps.push({ ...base, status: 'ready', ...(checked.value.preview === undefined ? {} : { preview: checked.value.preview }) });
      continue;
    }
    const kinds = lookupKinds(checked.error);
    const creator = plan.steps.slice(0, index).findIndex((earlier) => kinds.some((kind) => mayCreate(earlier, kind)));
    if (creator !== -1) {
      steps.push({
        ...base,
        status: 'deferred',
        error: checked.error,
        reason: `this step names something step ${creator + 1} may create. It is checked again when it runs, and it fails then if the thing is still missing.`,
      });
      continue;
    }
    steps.push({ ...base, status: 'refused', error: checked.error });
  }
  return { ok: steps.every((step) => step.status !== 'refused'), steps };
}

/**
 * The ask-back a failed step produces. The code is chosen from the bus's own error code, except
 * for an anchor a port could not place: a port names that case with `details.askBackCode`, because
 * the bus has no error code for it (edit-anchors §3 step 5).
 */
export function askBackFor(error: CommandError): AskBack {
  const anchored = error.details?.['askBackCode'] === 'anchor_unresolvable';
  const code: AskBackCode = anchored ? 'anchor_unresolvable' : askBackCodeFor(error.code);
  const reason = error.message;
  const drift =
    typeof error.details?.['actualRevision'] === 'number' && typeof error.details['expectedRevision'] === 'number'
      ? error.details['actualRevision'] - error.details['expectedRevision']
      : typeof error.details?.['revisionDrift'] === 'number'
        ? error.details['revisionDrift']
        : undefined;
  const candidates = anchored && Array.isArray(error.details?.['candidates']) ? (error.details['candidates'] as AskBack['candidates']) : undefined;
  return {
    code,
    reason,
    ...(drift === undefined ? {} : { revisionDrift: drift }),
    ...(candidates === undefined ? {} : { candidates }),
    options: optionsFor(code),
  };
}

function askBackCodeFor(code: CommandError['code']): AskBackCode {
  switch (code) {
    case 'revision-conflict':
      return 'conflict';
    case 'postcondition':
    case 'internal':
      return 'verify_failed';
    default:
      return 'needs_input';
  }
}

function optionsFor(code: AskBackCode): readonly string[] {
  switch (code) {
    case 'conflict':
      return [
        'read the document again with doc.read and rebuild this step against its current text',
        'drop this step and approve the rest of the plan',
        'undo this turn to restore the state before it',
      ];
    case 'verify_failed':
      return [
        'undo this turn to restore the state before it',
        'report the failed check to the user and keep the turn as it is',
        'approve a corrected plan for the remaining work',
      ];
    case 'anchor_unresolvable':
      return [
        're-select the text in the editor',
        'read the document again with doc.read',
        'drop this step',
      ];
    case 'needs_input':
      return [
        'fix the params named in the reason and approve a corrected plan',
        're-read the project with binder.read_tree or project.overview',
        'drop this step and approve the rest of the plan',
      ];
    case 'budget_exhausted':
      return ['raise the limit in Settings › Agent, then send the request again', 'stop here and keep what was applied'];
  }
}

/** The call id a plan's step is dispatched under: the plan's own id and the step's index in the whole plan. */
export function planStepCallId(planCallId: string, index: number): string {
  return `${planCallId}.${index}`;
}

/**
 * Runs an approved plan as one turn.
 *
 * The caller's turn is used as given. Every step is a call under that turn, so the
 * steps share its undo group (command-bus §5), and every step carries
 * `approvedPlan: true`, which is the approval the card gave. The executor does not
 * end the turn: the caller does, with `endTurn`, once the turn is over.
 */
export function runPlan(
  plan: Plan,
  turn: TurnContext & { readonly callId: string },
  host: PlanHost,
  options: PlanOptions = {},
): PlanOutcome {
  const pre = preflight(plan, host, options);
  if (!pre.ok) return { status: 'refused', preflight: pre };

  const completed: StepResult[] = [];
  const end = endOf(plan, options);
  for (let index = startOf(plan, options); index < end; index += 1) {
    if (options.signal?.aborted === true) {
      const stopped = completed.find((entry) => entry.value.undoGroupId !== undefined)?.value.undoGroupId;
      return { status: 'stopped', completed, stoppedAt: index, ...(stopped === undefined ? {} : { undoGroupId: stopped }) };
    }
    const step = plan.steps[index] as PlanStep;
    // A step's call id carries its index in the whole plan, so a resumed run names the same calls the first run did.
    const proposal = options.proposals?.[index];
    const outcome = host.run(
      {
        name: step.tool,
        callId: planStepCallId(turn.callId, index),
        params: step.params,
        ...(proposal === undefined || proposal === null ? {} : { proposal }),
      },
      { turnId: turn.turnId, ...(turn.source === undefined ? {} : { source: turn.source }), permission: { approvedPlan: true } },
    );
    if (!outcome.ok) {
      const group = completed.find((entry) => entry.value.undoGroupId !== undefined)?.value.undoGroupId ?? outcome.error.details?.['undoGroupId'];
      return {
        status: 'failed',
        completed,
        failedAt: index,
        error: outcome.error,
        askBack: askBackFor(outcome.error),
        ...(typeof group === 'string' ? { undoGroupId: group } : {}),
      };
    }
    completed.push({ index, tool: step.tool, expect: step.expect, value: outcome.value });
  }
  const group = completed.find((entry) => entry.value.undoGroupId !== undefined)?.value.undoGroupId;
  return { status: 'applied', steps: completed, ...(group === undefined ? {} : { undoGroupId: group }) };
}

/** A plan whose callId was used for a different plan. Refused, not merged. */
export function planReplayRefusal(callId: string, turnId: string): CommandError {
  return invalidParams(
    `callId "${callId}" in turn "${turnId}" was already used by a different plan, so this plan was not run and nothing was written`,
    'give the second plan its own callId — one id names one plan',
    'callId',
  );
}

