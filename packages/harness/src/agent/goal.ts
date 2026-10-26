/**
 * Goal runs (agent-harness §7.2): the agent works turn after turn until the checks the writer chose pass, and stops when it stalls,
 * breaks something that passed, leaves its write scope, or reaches a limit.
 *
 * The runner chooses the next intent and evaluates the checks; it applies nothing itself. Each iteration is an ordinary
 * `session.submit` turn, so it has its own cards, its own checkpoint and its own entry in the run log, and it is held to the mode, the
 * rules and the run limits the session carries. A goal adds no approval shortcut: every card the mode does not approve still asks.
 *
 * The record of a run (`GoalRun`) is held in memory. Nothing here survives a reload.
 */

import type { CommandError, Result, UndoOutcome } from '@caotang/bus';
import { DETERMINISTIC_CHECK_IDS, runDeterministic, type DeterministicCheckId, type ScopeSpec } from '@caotang/coherence';
import type { ProjectState, TreeNode } from '@caotang/store';

import { metadataFor } from '../metadata.js';
import type { AskBack } from '../plan.js';
import { NO_RULES, type RulesProvider, type SourcedRule } from '../rules.js';
import { TOOL_TARGETS } from '../targets.js';
import { countIn, heldFile } from '../tools/coherence.js';
import { canonicalJson } from '../util.js';
import type { BudgetMeter, BudgetStop, RunLimits } from './budget.js';
import { checkKey, checkSpecProblem, evaluateChecks, largeScopes, type CheckOptions, type CheckResult, type CheckSpec } from './checks.js';
import type { TurnReport } from './events.js';
import type { AgentSession, SubmitOptions } from './loop.js';

/** Which binder nodes a run may write: the whole project, or the named documents and everything under the named folders. */
export type WriteScope = { readonly mode: 'full' } | { readonly mode: 'doc'; readonly docIds: readonly string[] };

export const DEFAULT_MAX_ITERATIONS = 10;
export const HARD_MAX_ITERATIONS = 50;
export const DEFAULT_STALL_AFTER = 2;
/** The failing documents one iteration's request names: what one turn can do within its model-call bound. */
export const DEFAULT_DOCS_PER_ITERATION = 5;

export interface Goal {
  readonly id: string;
  /** The writer's words. Every iteration's request begins with them. */
  readonly intent: string;
  /** What "done" means: all of them must pass. */
  readonly checks: readonly CheckSpec[];
  /** The limits of the whole run. At least one is required: a goal with no limit is refused before its first turn. */
  readonly limits: RunLimits;
  /** Default 10, at most 50. */
  readonly maxIterations?: number;
  /** Iterations without a strictly lower total distance before the run stops. Default 2. */
  readonly stallAfter?: number;
  /** Default: the whole project. */
  readonly writeScope?: WriteScope;
  /** The failing documents one iteration's request names. Default 5. */
  readonly perIteration?: number;
}

export type GoalStatus =
  | 'passed'
  | 'stalled'
  | 'regressed'
  | 'budget'
  | 'max-iterations'
  | 'out-of-scope'
  | 'cancelled'
  | 'failed'
  /** Refused before the first turn: nothing ran. */
  | 'refused';

export interface IterationRecord {
  readonly n: number;
  readonly turnId: string;
  readonly intent: string;
  readonly before: readonly CheckResult[];
  readonly after: readonly CheckResult[];
  readonly report: TurnReport;
  /** The sum of the checks' distance before and after the iteration. */
  readonly distance: { readonly before: number; readonly after: number };
  /** The writes the iteration applied outside the write scope, named as the report names them. */
  readonly outOfScope: readonly string[];
}

export interface GoalRun {
  readonly goal: Goal;
  readonly status: GoalStatus;
  /** One sentence for the writer: why the run ended. */
  readonly reason: string;
  readonly iterations: readonly IterationRecord[];
  /** The checks as the project stands when the run ended. */
  readonly results: readonly CheckResult[];
  /** Present when the run ended on a regression: restore, continue or stop. */
  readonly askBack?: AskBack;
  /** Present when the run ended on a run limit. */
  readonly budgetStop?: BudgetStop;
  /** The one coherence run the goal recorded when it ended, when one of its checks is a coherence check. */
  readonly scanRunId?: string;
  readonly notes: readonly string[];
}

/** A check that passed earlier and fails now. */
export interface Regression {
  readonly iteration: number;
  readonly turnId: string;
  readonly broken: readonly CheckResult[];
}

export type RegressionChoice = 'restore' | 'continue' | 'stop';

export const REGRESSION_OPTIONS = ['restore to before this iteration', 'continue anyway', 'stop here and keep what was applied'] as const;

export interface GoalOptions {
  readonly session: AgentSession;
  readonly state: ProjectState;
  /**
   * The meter the session was made with (`AgentSessionOptions.meter`), carrying the goal's limits: every iteration spends from it, so a
   * limit is the run's and not each turn's. The runner reads it between turns; the session enforces it inside them.
   */
  readonly meter: BudgetMeter;
  /** The stamp of the discarded evaluations and of the one coherence run. Default: now. */
  readonly now?: () => Date;
  /** The writer's Stop for the whole run: it is passed to every turn. */
  readonly signal?: AbortSignal;
  /** The checks the writer has on and the dialogue facts, as the scan port reads them. */
  readonly checks?: Omit<CheckOptions, 'now'>;
  /** The profile, model and thinking level every iteration runs on. */
  readonly turn?: Pick<SubmitOptions, 'profileId' | 'model' | 'thinking'>;
  /** The writer agreed to a coherence scope over the document guard when the goal was set. The guard is satisfied once, here. */
  readonly approvedLargeScope?: boolean;
  /** Asked once when an iteration broke a check that passed. Absent, the run stops and says what it offers. */
  readonly onRegression?: (regression: Regression) => Promise<RegressionChoice> | RegressionChoice;
  readonly onIteration?: (record: IterationRecord) => void;
  /** Where the one coherence run goes. Default: the project's held coherence file. */
  readonly recordCoherence?: (file: NonNullable<ProjectState['coherence']>) => void;
}

export interface GoalRunner {
  start(goal: Goal, options: GoalOptions): Promise<GoalRun>;
}

const sum = (results: readonly CheckResult[]): number => results.reduce((total, result) => total + result.distance, 0);

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * The request of one iteration: the writer's words, where the run stands, and the failing documents worst first, capped to what one turn
 * can do. A check that passes is named so the model leaves it alone; a failure beyond the cap is counted, not listed.
 */
export function iterationIntent(goal: Goal, results: readonly CheckResult[], iteration: number): string {
  const cap = goal.perIteration ?? DEFAULT_DOCS_PER_ITERATION;
  const max = goal.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const passing = results.filter((result) => result.pass).map((result) => result.label);
  const lines = [
    goal.intent.trim(),
    '',
    `This is iteration ${iteration} of at most ${max} of a goal run. The run ends when every check below passes.`,
    `Already passing, and to stay so: ${passing.length === 0 ? 'nothing yet' : passing.join('; ')}.`,
    'Still failing, worst first. Change only the documents listed, and change nothing else:',
  ];
  let left = cap;
  let unlisted = 0;
  for (const result of results.filter((candidate) => !candidate.pass)) {
    lines.push(`- ${result.label} (${plural(result.distance, 'thing')} to fix)`);
    const ordered = [...result.failures].sort((a, b) => b.weight - a.weight || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
    for (const failure of ordered) {
      if (left === 0) {
        unlisted += 1;
        continue;
      }
      left -= 1;
      lines.push(`  - "${failure.title}"${failure.docId === undefined ? '' : ` (${failure.docId})`}: ${failure.detail}`);
    }
  }
  if (unlisted > 0) lines.push(`${plural(unlisted, 'more item')} remain for later iterations; leave them for now.`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * The write scope.
 * ------------------------------------------------------------------ */

/** The nodes a write scope covers: the named nodes and everything under them. `undefined` is the whole project. */
export function writableNodes(scope: WriteScope, tree: readonly TreeNode[]): ReadonlySet<string> | undefined {
  if (scope.mode === 'full') return undefined;
  const children = new Map<string, string[]>();
  for (const node of tree) {
    if (node.parentId === null) continue;
    const list = children.get(node.parentId);
    if (list === undefined) children.set(node.parentId, [node.id]);
    else list.push(node.id);
  }
  const known = new Set(tree.map((node) => node.id));
  const out = new Set<string>();
  const queue = scope.docIds.filter((id) => known.has(id));
  for (let at = 0; at < queue.length; at += 1) {
    const id = queue[at] as string;
    if (out.has(id)) continue;
    out.add(id);
    queue.push(...(children.get(id) ?? []));
  }
  return out;
}

const SCOPE_NOTE = 'outside the write scope of the goal run';

/**
 * The rules that keep a goal run inside its write scope, in the rules' own terms: a write-deny on every subtree that holds no node of the
 * scope. They join the session's rules (`goalRules`), so the harness refuses an out-of-scope write at the preflight, before it is drafted or
 * carded, as it refuses any rule's. A folder that only contains the scope is not denied itself (a subtree rule covers the whole subtree),
 * so a write to such a folder is caught after the turn by `scopeBreaches`.
 */
export function writeScopeRules(scope: WriteScope, state: Pick<ProjectState, 'manifest'>): readonly SourcedRule[] {
  const tree = state.manifest.tree;
  const allowed = writableNodes(scope, tree);
  if (allowed === undefined) return [];
  const byId = new Map(tree.map((node) => [node.id, node]));
  const holds = new Set(allowed);
  for (const id of allowed) {
    for (let parent = byId.get(id)?.parentId; parent !== null && parent !== undefined && !holds.has(parent); parent = byId.get(parent)?.parentId) holds.add(parent);
  }
  const rules: SourcedRule[] = [];
  const visit = (parentId: string): void => {
    for (const node of tree) {
      if (node.parentId !== parentId || allowed.has(node.id)) continue;
      if (holds.has(node.id)) visit(node.id);
      else rules.push({ effect: 'deny', tool: '*', access: 'write', scope: { subtree: node.id }, note: SCOPE_NOTE, source: 'session' });
    }
  };
  const root = tree.find((node) => node.parentId === null);
  if (root !== undefined) visit(root.id);
  return rules;
}

/** The session's rules with a goal's write scope added, read at each call so a node added mid-run is inside or outside the scope as it lands. */
export function goalRules(base: RulesProvider | undefined, scope: WriteScope, state: ProjectState): RulesProvider {
  return () => {
    const set = base?.() ?? NO_RULES;
    const extra = writeScopeRules(scope, state);
    return extra.length === 0 ? set : { ...set, rules: [...set.rules, ...extra] };
  };
}

/**
 * The writes a finished turn applied outside the write scope, one sentence each. A call's nodes are worked out against the tree as it was
 * before the turn (`before`), so a rename the turn made does not hide its own target. A write whose nodes cannot be worked out is a breach:
 * a scope that cannot be checked is not taken to allow it. A write that names no node (the codex, an export) is not a binder write.
 */
export function scopeBreaches(report: TurnReport, state: ProjectState, before: readonly TreeNode[], scope: WriteScope): readonly string[] {
  const allowed = writableNodes(scope, before);
  if (allowed === undefined) return [];
  const view: ProjectState = { ...state, manifest: { ...state.manifest, tree: [...before] } };
  const out: string[] = [];
  for (const entry of report.trace) {
    const meta = metadataFor(entry.tool);
    if (entry.outcome !== 'ok' || meta === undefined || meta.risk === 'read' || meta.risk === 'meta') continue;
    const targets = TOOL_TARGETS[meta.name];
    if (targets === 'project') continue;
    const worked = targets(entry.params, view);
    if (!worked.ok) {
      out.push(`${entry.tool}: its documents could not be worked out`);
      continue;
    }
    const outside = worked.value.writes.find((id) => !allowed.has(id));
    if (outside !== undefined) out.push(`${entry.tool}: ${before.find((node) => node.id === outside)?.title ?? outside}`);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The run.
 * ------------------------------------------------------------------ */

const limitsSet = (limits: RunLimits): boolean => Object.values(limits).some((value) => typeof value === 'number');

/** Why a goal cannot start, or undefined. Everything here is known before the first model call. */
export function goalProblem(goal: Goal, meter: BudgetMeter): string | undefined {
  if (goal.intent.trim() === '') return 'the goal has no intent';
  if (goal.checks.length === 0) return 'the goal has no checks, so nothing could say when it is done';
  for (const spec of goal.checks) {
    const problem = checkSpecProblem(spec);
    if (problem !== undefined) return `a check cannot run: ${problem}`;
  }
  if (!limitsSet(goal.limits)) return 'a goal needs at least one limit (model calls, tokens, cost, steps, time or a deadline): a run with none could go on without end';
  if (canonicalJson(goal.limits) !== canonicalJson(meter.limits)) return 'the meter the session was made with does not carry this goal’s limits, so they would not be enforced';
  const max = goal.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (!Number.isInteger(max) || max < 1 || max > HARD_MAX_ITERATIONS) return `the goal may run at least one iteration and at most ${HARD_MAX_ITERATIONS}`;
  const stall = goal.stallAfter ?? DEFAULT_STALL_AFTER;
  if (!Number.isInteger(stall) || stall < 1) return 'stallAfter must be a whole number of iterations, at least one';
  const per = goal.perIteration ?? DEFAULT_DOCS_PER_ITERATION;
  if (!Number.isInteger(per) || per < 1) return 'perIteration must be a whole number of documents, at least one';
  if (goal.writeScope?.mode === 'doc' && goal.writeScope.docIds.length === 0) return 'the write scope names no document, so the run could write nothing';
  return undefined;
}

/**
 * The one coherence run a goal records. Its scope is the checks' scope when they share one, else the whole manuscript, and its checks are
 * theirs together; the Findings tab shows it as the last scan.
 */
function scanPlan(
  checks: readonly CheckSpec[],
  enabled: readonly DeterministicCheckId[] | undefined,
): { readonly scope: ScopeSpec; readonly checks: readonly DeterministicCheckId[] } | undefined {
  const coherence = checks.flatMap((spec) => (spec.kind === 'coherence.clean' ? [spec] : []));
  const first = coherence[0];
  if (first === undefined) return undefined;
  const scope: ScopeSpec = new Set(coherence.map((spec) => canonicalJson(spec.scope))).size === 1 ? first.scope : { mode: 'full' };
  const named = new Set(coherence.flatMap((spec) => spec.checks ?? DETERMINISTIC_CHECK_IDS));
  const picked = DETERMINISTIC_CHECK_IDS.filter((id) => named.has(id) && (enabled === undefined || enabled.includes(id)));
  return picked.length === 0 ? undefined : { scope, checks: picked };
}

export function createGoalRunner(): GoalRunner {
  return {
    async start(goal, options) {
      const { session, state, meter } = options;
      const now = options.now ?? ((): Date => new Date());
      const refuse = (reason: string): GoalRun => ({ goal, status: 'refused', reason, iterations: [], results: [], notes: [] });

      const seen = new Set<string>();
      const checks = goal.checks.filter((spec) => {
        const key = checkKey(spec);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const problem = goalProblem({ ...goal, checks }, meter);
      if (problem !== undefined) return refuse(problem);

      // The scope guard (coherence.md §6.2) is satisfied here, once. The scan the run ends with reads a scope too, so it counts.
      const plan = scanPlan(checks, options.checks?.enabled);
      const large = largeScopes(plan === undefined ? checks : [...checks, { kind: 'coherence.clean', scope: plan.scope }], state);
      if (large.length > 0 && options.approvedLargeScope !== true) {
        return refuse(`a coherence scope of this goal reads ${large[0]?.documents} documents, over the guard that asks first; approve the scope when setting the goal, or narrow it`);
      }

      const maxIterations = goal.maxIterations ?? DEFAULT_MAX_ITERATIONS;
      const stallAfter = goal.stallAfter ?? DEFAULT_STALL_AFTER;
      const writeScope: WriteScope = goal.writeScope ?? { mode: 'full' };
      const evaluate = (): readonly CheckResult[] => evaluateChecks(checks, state, { ...(options.checks ?? {}), now: now() });

      const iterations: IterationRecord[] = [];
      const notes: string[] = [];
      let results = evaluate();
      const passedBefore = new Set(results.filter((result) => result.pass).map((result) => result.key));
      let best = sum(results);
      let sinceBest = 0;

      const finish = (status: GoalStatus, reason: string, extra: Pick<GoalRun, 'askBack' | 'budgetStop'> = {}): GoalRun => {
        let scanRunId: string | undefined;
        if (plan !== undefined) {
          try {
            const dialogue = options.checks?.dialogue?.(state);
            const scanned = runDeterministic(state, heldFile(state), {
              scope: plan.scope,
              checks: plan.checks,
              now: now(),
              detector: countIn,
              ...(dialogue === undefined ? {} : { dialogue }),
            });
            const file = scanned.file as NonNullable<ProjectState['coherence']>;
            if (options.recordCoherence === undefined) state.coherence = file;
            else options.recordCoherence(file);
            scanRunId = scanned.run.id;
          } catch (error) {
            notes.push(`the closing coherence scan did not run: ${error instanceof Error ? error.message : 'the scope could not be read'}`);
          }
        }
        return { goal, status, reason, iterations, results, notes, ...extra, ...(scanRunId === undefined ? {} : { scanRunId }) };
      };

      if (results.every((result) => result.pass)) return finish('passed', 'every check already passes, so no turn was needed');

      for (;;) {
        if (options.signal?.aborted === true) return finish('cancelled', 'the writer stopped the run');
        const limit = meter.stopped();
        if (limit !== undefined) return finish('budget', `the run reached its ${limit.dimension} limit before iteration ${iterations.length + 1}`, { budgetStop: limit });

        const n = iterations.length + 1;
        const before = results;
        const intent = iterationIntent(goal, before, n);
        const treeBefore = state.manifest.tree.map((node) => ({ ...node }));
        let report: TurnReport;
        try {
          report = await session.submit(intent, { ...(options.turn ?? {}), ...(options.signal === undefined ? {} : { signal: options.signal }) });
        } catch (error) {
          return finish('failed', `iteration ${n} could not run: ${error instanceof Error ? error.message : 'the turn threw'}`);
        }
        results = evaluate();
        const breaches = scopeBreaches(report, state, treeBefore, writeScope);
        const record: IterationRecord = { n, turnId: report.turnId, intent, before, after: results, report, distance: { before: sum(before), after: sum(results) }, outOfScope: breaches };
        iterations.push(record);
        options.onIteration?.(record);

        if (breaches.length > 0) {
          return finish('out-of-scope', `iteration ${n} wrote outside the goal’s write scope (${breaches.join('; ')}); restore it, or widen the scope and run again`);
        }
        if (results.every((result) => result.pass)) return finish('passed', `every check passes after ${plural(n, 'iteration')}`);
        if (report.budgetStop !== undefined) {
          return finish('budget', `iteration ${n} stopped on the run’s ${report.budgetStop.dimension} limit`, { budgetStop: report.budgetStop });
        }
        if (report.status === 'cancelled') {
          return finish('cancelled', report.stop === undefined ? `iteration ${n} was cancelled: a card was declined` : 'the writer stopped the run');
        }
        if (report.status === 'failed') return finish('failed', `iteration ${n} failed: ${report.summary}`);

        const broken = results.filter((result) => !result.pass && passedBefore.has(result.key));
        for (const result of results) if (result.pass) passedBefore.add(result.key);
        if (broken.length > 0) {
          const askBack: AskBack = {
            code: 'needs_input',
            reason: `iteration ${n} broke a check that passed: ${broken.map((result) => result.label).join('; ')}`,
            options: [...REGRESSION_OPTIONS],
          };
          const choice = options.onRegression === undefined ? 'stop' : await options.onRegression({ iteration: n, turnId: report.turnId, broken });
          if (choice === 'restore') {
            const restored = session.restore(report.turnId);
            results = evaluate();
            return finish('regressed', restored.ok ? `${askBack.reason}; iteration ${n} was restored` : `${askBack.reason}; restoring iteration ${n} failed: ${restored.error.message}`, { askBack });
          }
          if (choice === 'stop') return finish('regressed', askBack.reason, { askBack });
          // Continue anyway: the writer has seen it, so it is not a regression again unless the check is fixed and breaks once more.
          for (const result of broken) passedBefore.delete(result.key);
        }

        const total = sum(results);
        if (total < best) {
          best = total;
          sinceBest = 0;
        } else {
          sinceBest += 1;
        }
        if (sinceBest >= stallAfter) return finish('stalled', `the checks are no closer after ${plural(stallAfter, 'iteration')} (${total} left), so the run stopped`);
        if (n >= maxIterations) return finish('max-iterations', `the run made its ${plural(maxIterations, 'iteration')} without every check passing (${total} left)`);
      }
    },
  };
}

export interface RestoredTurn {
  readonly turnId: string;
  readonly result: Result<UndoOutcome, CommandError>;
}

/** Restores the whole run at once: every iteration's undo group, newest first, which is "restore to before this goal". */
export function restoreGoal(session: AgentSession, run: GoalRun): readonly RestoredTurn[] {
  return [...run.iterations]
    .reverse()
    .filter((record) => record.report.undoGroupId !== undefined)
    .map((record) => ({ turnId: record.turnId, result: session.restore(record.turnId) }));
}
