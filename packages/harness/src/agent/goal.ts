/**
 * Goal runs (agent-harness §7.2): the agent works turn after turn until the checks the writer chose pass, and stops when it stalls,
 * breaks something that passed, leaves its write scope, or reaches a limit.
 *
 * The runner chooses the next intent and evaluates the checks; it applies nothing itself. Each iteration is an ordinary
 * `session.submit` turn, so it has its own cards, its own checkpoint and its own entry in the run log, and it is held to the mode, the
 * rules and the run limits the session carries. A goal adds no approval shortcut: every card the mode does not approve still asks.
 *
 * A host can keep the checkpoint ahead of each iteration. The host owns its durable storage and explicit recovery.
 */

import type { CommandError, Result, UndoOutcome } from '@caotang/bus';
import { DETERMINISTIC_CHECK_IDS, runDeterministic, type CoherenceFile, type DeterministicCheckId, type ScopeSpec } from '@caotang/coherence';
import { GOAL_VERIFIER_LIMITS, checkpointReadable, type ProjectState, type TreeNode } from '@caotang/store';

import { metadataFor } from '../metadata.js';
import { projectScanInput } from '../scan-worker.js';
import type { AskBack } from '../plan.js';
import { NO_RULES, type RulesProvider, type SourcedRule } from '../rules.js';
import { TOOL_TARGETS } from '../targets.js';
import { countIn, heldFile } from '../tools/coherence.js';
import { canonicalJson, firstCodePoints } from '../util.js';
import type { BudgetMeter, BudgetSpend, BudgetStop, RunLimits } from './budget.js';
import { checkLabel, checkSpecProblem, documentsInScope, evaluateChecks, excludedBy, largeScopes, type CheckOptions, type CheckResult, type CheckSpec } from './checks.js';
import type { TurnReport } from './events.js';
import type { AgentSession, SubmitOptions } from './loop.js';
import { goalVerifierSources, goalVerifierSpecProblem, snapshotGoalVerifierState, type GoalVerificationResult, type GoalVerifierCheck, type GoalVerifierPort, type GoalVerifierUnavailableCode, type PendingGoalVerification } from './goal-verification.js';
import { GoalVerifierPersistenceError } from './goal-verifier-call.js';
import { parseGoalVerifierVerdict, prepareGoalVerifierInput } from './goal-verifier.js';

export type GoalCheckSpec = CheckSpec | GoalVerifierCheck;

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
  /** What "done" means: deterministic checks and explicitly gated verification must pass. */
  readonly checks: readonly GoalCheckSpec[];
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
  readonly verification?: GoalVerificationResult;
}

export interface GoalCheckpoint {
  readonly goal: Goal;
  readonly approvedLargeScope?: boolean;
  readonly iterations: readonly IterationRecord[];
  readonly results: readonly CheckResult[];
  readonly nextIteration: number;
  readonly spend: BudgetSpend;
  readonly progress?: { readonly best: number; readonly sinceBest: number; readonly passed: readonly string[] };
  readonly outcome?: Pick<GoalRun, 'status' | 'reason' | 'askBack' | 'budgetStop'>;
  readonly verification?: GoalVerificationResult;
  readonly pendingVerification?: PendingGoalVerification;
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
  readonly verifier?: GoalVerifierPort;
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
  readonly checks?: Omit<CheckOptions, 'now' | 'withheld'>;
  /**
   * The nodes a read rule keeps from the agent (agent-harness §4), read afresh at each evaluation: `() => harness.withheldAnywhere()`.
   * The goal path is a second route to the prompt, so it takes the same view as the rest of the harness: a withheld node is not
   * measured by a check, not scanned, not counted toward the scope guard and never named in an iteration's request. Required, so a
   * caller with no rules says so (`() => new Set()`) and one with rules cannot forget.
   */
  readonly withheld: () => ReadonlySet<string>;
  /** The profile, model and thinking level every iteration runs on. */
  readonly turn?: Pick<SubmitOptions, 'profileId' | 'model' | 'thinking'>;
  /** The writer agreed to a coherence scope over the document guard when the goal was set. The guard is satisfied once, here. */
  readonly approvedLargeScope?: boolean;
  /** Asked once when an iteration broke a check that passed. Absent, the run stops and says what it offers. */
  readonly onRegression?: (regression: Regression) => Promise<RegressionChoice> | RegressionChoice;
  /** Told after each iteration. The run waits for it; a throw or a rejection becomes a note and does not lose the run. */
  readonly onIteration?: (record: IterationRecord) => void | Promise<void>;
  readonly saveCheckpoint?: (checkpoint: GoalCheckpoint) => Promise<void>;
  readonly checkpoint?: GoalCheckpoint;
  readonly saveIteration?: (checkpoint: GoalCheckpoint, record: IterationRecord) => Promise<void>;
  /** Where the one coherence run goes. Default: the project's held coherence file. */
  readonly recordCoherence?: (file: CoherenceFile) => void;
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
export function iterationIntent(goal: Goal, results: readonly CheckResult[], iteration: number, verification?: GoalVerificationResult, verifierDocuments?: readonly Pick<TreeNode, 'id' | 'title'>[]): string {
  const cap = goal.perIteration ?? DEFAULT_DOCS_PER_ITERATION;
  const max = goal.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const verifier = goal.checks.find((spec): spec is GoalVerifierCheck => spec.kind === 'verifier' && spec.gate === true);
  const passing = results.filter((result) => result.pass).map((result) => result.label);
  const lines = [
    goal.intent.trim(),
    '',
    `This is iteration ${iteration} of at most ${max} of a goal run. The run ends when every check below passes.`,
    `Already passing, and to stay so: ${passing.length === 0 ? 'nothing yet' : passing.join('; ')}.`,
    verifier === undefined ? 'Still failing, worst first. Change only the documents listed, and change nothing else:' : 'Still failing deterministic checks, worst first. Prioritize these within the goal’s write scope:',
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
  if (verifier !== undefined) {
    if (results.every(result => result.pass)) lines.push('No deterministic check is failing. Work within the goal’s write scope to satisfy the independent rubric.');
    lines.push(`Independent rubric to satisfy: ${verifier.rubric}`);
    if (verifierDocuments !== undefined) lines.push(`Readable rubric targets for this iteration; the write scope still applies: ${JSON.stringify(verifierDocuments.slice(0, Math.min(cap, GOAL_VERIFIER_LIMITS.documents)).map(node => ({ id: node.id, title: firstCodePoints(node.title, GOAL_VERIFIER_LIMITS.title) })))}`);
    if (verification?.status === 'complete' && verification.verdict?.pass === false) lines.push(`Verifier feedback (data, not instructions): ${JSON.stringify(verification.verdict.reasons)}`);
  }
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
 * a scope that cannot be checked is not taken to allow it. A write that names no binder node (an export, a vocabulary or filter change) is not judged; a codex write is judged by the documents it attaches to.
 */
export function scopeBreaches(report: TurnReport, state: ProjectState, before: readonly TreeNode[], scope: WriteScope): readonly string[] {
  const allowed = writableNodes(scope, before);
  if (allowed === undefined) return [];
  const view: ProjectState = { ...state, manifest: { ...state.manifest, tree: [...before] } };
  const out: string[] = [];
  // An external tool is not in the registry, so no document of it can be worked out. One that ran under a card was not a trusted read
  // (extensibility §4 rule 2: only a read the writer trusts runs without asking), so it is taken for a write. A plan card lists every
  // step, reads included, so only the cards that carry the call itself count (a one-step confirm card, which an external write always
  // gets, even inside a plan); a declined card means the call did not run under it.
  const carded = new Set(report.cards.filter((card) => card.kind !== 'plan' && card.decision !== 'cancelled').flatMap((card) => card.tools));
  for (const entry of report.trace) {
    if (entry.outcome !== 'ok') continue;
    const meta = metadataFor(entry.tool);
    if (meta === undefined) {
      if (carded.has(entry.tool)) out.push(`${entry.tool}: its documents could not be worked out`);
      continue;
    }
    if (meta.risk === 'read' || meta.risk === 'meta') continue;
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
    const problem = spec?.kind === 'verifier' ? goalVerifierSpecProblem(spec) : checkSpecProblem(spec);
    if (problem !== undefined) return `a check cannot run: ${problem}`;
  }
  const verifiers = goal.checks.filter((spec): spec is GoalVerifierCheck => spec.kind === 'verifier');
  if (verifiers.length > 1) return 'a goal supports one independent verifier; combine its criteria in one rubric';
  if (goal.checks.every(spec => spec.kind === 'verifier' && spec.gate !== true)) return 'Choose another check or require the independent review to pass.';
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

/** True when every check still failing is one a setting or its scope, not the manuscript, keeps from passing. */
const onlyUnmeetable = (results: readonly CheckResult[]): boolean => {
  const failing = results.filter((result) => !result.pass);
  return failing.length > 0 && failing.every((result) => result.unmeetable === true);
};

/** Why the run ends without another turn: what each check that cannot be met says, in its own words. */
const unmeetableReason = (results: readonly CheckResult[]): string => {
  const said = results.filter((result) => !result.pass).map((result) => result.failures[0]?.detail ?? result.label);
  return `a check cannot be met: ${[...new Set(said)].join('; ')}; no turn could change that`;
};

export function createGoalRunner(): GoalRunner {
  return {
    async start(goal, options) {
      const { session, state, meter } = options;
      const now = options.now ?? ((): Date => new Date());
      const refuse = (reason: string): GoalRun => ({ goal, status: 'refused', reason, iterations: [], results: [], notes: [] });
      const problem = goalProblem(goal, meter);
      if (problem !== undefined) return refuse(problem);
      if (goal.checks.some(spec => spec.kind === 'verifier')) {
        if (typeof options.saveIteration !== 'function' || typeof options.saveCheckpoint !== 'function') return refuse('Configure durable iteration and checkpoint saves before starting an independent review.');
        try { goal = structuredClone(goal); } catch { return refuse('the verifier goal must contain only plain saved data'); }
      }

      const seen = new Set<string>();
      const definitions = goal.checks.filter((spec) => {
        const key = canonicalJson(spec);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (options.checkpoint !== undefined && !checkpointReadable(options.checkpoint, goal.id)) return refuse('the saved goal checkpoint cannot be read safely');
      if (options.checkpoint?.pendingVerification?.phase === 'reserved') return refuse('the unresolved verifier reservation needs conservative recovery before the goal can resume');
      const checks = definitions.filter((spec): spec is CheckSpec => spec.kind !== 'verifier');
      const verifier = definitions.find((spec): spec is GoalVerifierCheck => spec.kind === 'verifier');
      if (verifier !== undefined && options.checkpoint !== undefined) {
        if (canonicalJson(options.checkpoint.goal.checks) !== canonicalJson(goal.checks)) return refuse('the saved goal’s check definitions cannot change during verifier recovery');
        const spent = meter.spend();
        if ((['modelCalls', 'promptTokens', 'completionTokens', 'estimatedTokens', 'steps', 'activeMs', 'costUsd'] as const).some(key => (spent[key] ?? 0) < (options.checkpoint?.spend[key] ?? 0))) return refuse('the verifier goal’s meter does not retain its saved spend');
      }
      const approvedLargeScope = options.approvedLargeScope === true ||
        (options.checkpoint?.approvedLargeScope === true && canonicalJson(options.checkpoint.goal.checks) === canonicalJson(goal.checks));

      // The scope guard (coherence.md §6.2) is satisfied here, once. The scan the run ends with reads a scope too, so it counts.
      const plan = scanPlan(checks, options.checks?.enabled);
      const large = largeScopes(plan === undefined ? checks : [...checks, { kind: 'coherence.clean', scope: plan.scope }], state, options.withheld());
      if (large.length > 0 && !approvedLargeScope) {
        return refuse(`a coherence scope of this goal reads ${large[0]?.documents} documents, over the guard that asks first; approve the scope when setting the goal, or narrow it`);
      }
      // A words, status or synopsis check over a scope that holds nothing would pass without measuring anything: the writer probably aimed
      // it wrong. The `changed` scope is legitimately empty when nothing has changed, so it stays vacuous.
      for (const spec of checks) {
        if (spec.kind === 'coherence.clean' || spec.scope.mode === 'changed') continue;
        const read = documentsInScope(state, spec.scope, options.withheld());
        if (read.nodes.length === 0 && read.missing.length === 0) {
          // Say what keeps the scope empty, by count: the documents exist, and a rule or the archive is the cause. Never a title or an id.
          const causes = [
            ...(read.withheld > 0 ? [`${plural(read.withheld, 'document')} of its scope ${read.withheld === 1 ? 'is' : 'are'} withheld from the agent by a rule`] : []),
            ...(read.archived.length > 0 ? [`${plural(read.archived.length, 'document')} of its scope ${read.archived.length === 1 ? 'is' : 'are'} archived, which a goal does not read`] : []),
          ];
          const why =
            causes.length === 0
              ? 'its scope holds nothing a goal can read; name a scope with documents, or add them first'
              : `${causes.join(' and ')}; name a scope with documents the agent may read`;
          return refuse(`check "${checkLabel(spec)}" reads no document: ${why}`);
        }
      }

      const maxIterations = goal.maxIterations ?? DEFAULT_MAX_ITERATIONS;
      const stallAfter = goal.stallAfter ?? DEFAULT_STALL_AFTER;
      const writeScope: WriteScope = goal.writeScope ?? { mode: 'full' };
      const evaluate = (): readonly CheckResult[] => evaluateChecks(checks, state, { ...(options.checks ?? {}), now: now(), withheld: options.withheld() });

      const iterations: IterationRecord[] = structuredClone([...(options.checkpoint?.iterations ?? [])]);
      const notes: string[] = [];
      // Said once: a failure that recurs on every iteration is one clause in `notes` and in `reason`, not one per iteration.
      const note = (text: string): void => {
        if (!notes.includes(text)) notes.push(text);
      };
      let results = evaluate();
      const passedBefore = new Set([...(options.checkpoint?.progress?.passed ?? []), ...results.filter((result) => result.pass).map((result) => result.key)]);
      let best = options.checkpoint?.progress?.best ?? sum(iterations[0]?.before ?? results);
      let sinceBest = options.checkpoint?.progress?.sinceBest ?? 0;
      if (options.checkpoint?.progress === undefined) for (const iteration of iterations) {
        if (iteration.distance.after < best) {
          best = iteration.distance.after;
          sinceBest = 0;
        } else sinceBest += 1;
      }
      let nextIteration = options.checkpoint?.nextIteration ?? 1;
      let completed: IterationRecord | undefined;
      let verification = options.checkpoint?.verification;
      let pendingVerification = options.checkpoint?.pendingVerification;
      let feedbackFence: (() => void) | undefined;
      let verificationBudgetStop: BudgetStop | undefined;
      const checkpoint = (outcome?: GoalCheckpoint['outcome']): GoalCheckpoint => structuredClone({
        goal, approvedLargeScope, iterations, results, nextIteration, spend: meter.spend(),
        progress: { best, sinceBest, passed: [...passedBefore] }, ...(outcome === undefined ? {} : { outcome }),
        ...(verification === undefined ? {} : { verification }), ...(pendingVerification === undefined ? {} : { pendingVerification }),
      });
      const commitIteration = async (outcome?: GoalCheckpoint['outcome']): Promise<string | undefined> => {
        const record = completed;
        completed = undefined;
        if (record === undefined || options.saveIteration === undefined) return undefined;
        try {
          await options.saveIteration(checkpoint(outcome), record);
          return undefined;
        } catch (error) {
          return `the completed goal checkpoint could not be saved after iteration ${record.n}: ${error instanceof Error ? error.message : 'storage refused'}`;
        }
      };

      const finish = async (status: GoalStatus, reason: string, extra: Pick<GoalRun, 'askBack' | 'budgetStop'> = {}): Promise<GoalRun> => {
        let scanRunId: string | undefined;
        if (plan !== undefined) {
          let scanned: ReturnType<typeof runDeterministic> | undefined;
          try {
            // As the scan port runs it: the dialogue facts from the project as the agent may read it, the withheld documents excluded.
            const hidden = options.withheld();
            const held = heldFile(state);
            const projected = hidden.size === 0 ? undefined : projectScanInput(state, held, hidden, plan.scope);
            const view = projected?.state ?? state;
            const dialogue = options.checks?.dialogue?.(view);
            const excluded = excludedBy(hidden);
            scanned = runDeterministic(view, held, {
              scope: plan.scope,
              excludedDocIds: projected?.excludedDocIds,
              checks: plan.checks,
              now: now(),
              detector: countIn,
              ...(dialogue === undefined ? {} : { dialogue }),
              ...(excluded === undefined ? {} : { isExcluded: excluded }),
            });
          } catch (error) {
            note(`the closing coherence scan did not run: ${error instanceof Error ? error.message : 'the scope could not be read'}`);
          }
          // Recording is a second step with its own failure: the scan ran, but it is not the last scan in Findings.
          if (scanned !== undefined) {
            try {
              const file = scanned.file;
              if (options.recordCoherence === undefined) state.coherence = file;
              else options.recordCoherence(file);
              scanRunId = scanned.run.id;
            } catch (error) {
              note(
                `the closing coherence scan ran but could not be recorded, so it is not the last scan in Findings: ${error instanceof Error ? error.message : 'it could not be saved'}`,
              );
            }
          }
        }
        // The status stays what the checks say; the notes ride along in the one sentence the host shows the writer.
        const said = [reason, ...notes].join('; ');
        const outcome = { status, reason: said, ...extra };
        const savesIteration = completed !== undefined && options.saveIteration !== undefined;
        let failed = await commitIteration(outcome);
        if (!savesIteration && options.saveCheckpoint !== undefined) {
          try {
            await options.saveCheckpoint(checkpoint(outcome));
          } catch (error) {
            failed = `the final goal checkpoint could not be saved: ${error instanceof Error ? error.message : 'storage refused'}`;
          }
        }
        return { goal, status: failed === undefined ? status : 'failed', reason: failed ?? said, iterations, results, notes, ...extra, ...(scanRunId === undefined ? {} : { scanRunId }), ...(verification === undefined ? {} : { verification }) };
      };

      const unavailable = (reason: string, code: GoalVerifierUnavailableCode): void => {
        verification = {
          key: canonicalJson(verifier), iteration: pendingVerification?.iteration ?? verification?.iteration ?? Math.max(0, nextIteration - 1), status: 'unavailable', reason, code,
          omitted: pendingVerification?.input.omitted ?? verification?.omitted ?? 0, truncated: pendingVerification?.input.truncated ?? verification?.truncated ?? false, sources: [],
          ...(pendingVerification?.uncertainUsage === true || verification?.uncertainUsage === true ? { uncertainUsage: true as const } : {}),
        };
        pendingVerification = undefined;
        feedbackFence = undefined;
      };
      const saveVerification = async (): Promise<void> => {
        try {
          await options.saveCheckpoint?.(checkpoint());
        } catch {
          throw new GoalVerifierPersistenceError('settlement');
        }
      };
      const verifyPending = async (): Promise<'complete' | 'cancelled' | 'budget'> => {
        verificationBudgetStop = undefined;
        const pending = pendingVerification;
        if (pending === undefined || verifier === undefined) return 'complete';
        if (pending.key !== canonicalJson(verifier)) throw new Error('The saved verifier definition no longer matches the goal.');
        if (pending.phase !== 'prepared') {
          unavailable('The verifier may already have been sent, but no verdict was saved. It was not repeated.', 'interrupted');
          await saveVerification();
          return 'complete';
        }
        const limit = meter.stopped();
        if (limit !== undefined) {
          verificationBudgetStop = limit;
          unavailable('The verifier could not run within the shared run limits.', 'budget');
          await saveVerification();
          return 'budget';
        }
        if (options.signal?.aborted === true) return 'cancelled';
        if (pending.input.excerpts.length === 0) {
          unavailable('There are no changed readable text passages to verify.', 'no-changes');
          await saveVerification();
          return 'complete';
        }
        if (options.verifier === undefined) {
          unavailable('The Background verifier is unavailable.', 'route');
          await saveVerification();
          return 'complete';
        }
        let captured: Awaited<ReturnType<typeof goalVerifierSources>>;
        try {
          captured = await goalVerifierSources(verifier, pending.sources.map(source => source.docId), state, options.withheld);
          if (canonicalJson(captured.sources) !== canonicalJson(pending.sources)) throw new Error('changed sources');
        } catch {
          unavailable('The verifier passages changed or are no longer readable in their scope.', 'source');
          await saveVerification();
          return 'complete';
        }
        let call;
        try {
          call = await options.verifier(pending.input, async admission => {
            pendingVerification = {
              ...pending, phase: admission.phase === 'reserved' ? 'reserved' : admission.phase === 'released' ? 'prepared' : 'settled',
              ...(admission.reservation === undefined ? {} : { reservation: admission.reservation }),
            };
            try {
              await options.saveCheckpoint?.(checkpoint());
            } catch {
              throw new GoalVerifierPersistenceError(admission.phase === 'reserved' ? 'reservation' : 'settlement');
            }
          }, () => {
            options.signal?.throwIfAborted();
            captured.fence();
          });
        } catch (error) {
          if (error instanceof GoalVerifierPersistenceError) throw error;
          unavailable('The verifier request could not finish.', 'route');
          await saveVerification();
          return 'complete';
        }
        if (call.kind === 'cancelled' || call.kind === 'budget') {
          if (call.kind === 'budget') verificationBudgetStop = call.stop;
          unavailable(call.kind === 'cancelled' ? 'The writer stopped verification.' : 'The verifier could not run within the shared run limits.', call.kind === 'cancelled' ? 'stopped' : 'budget');
          await saveVerification();
          return call.kind;
        }
        if (call.kind === 'failed') unavailable(call.reason, 'route');
        else {
          try {
            captured.fence();
          } catch {
            unavailable('The verified passages changed or are no longer readable.', 'source');
            await saveVerification();
            return 'complete';
          }
          try {
            verification = {
              key: pending.key, iteration: pending.iteration, status: 'complete', verdict: parseGoalVerifierVerdict(call.content),
              omitted: pending.input.omitted, truncated: pending.input.truncated, sources: pending.sources,
            };
            pendingVerification = undefined;
            feedbackFence = captured.fence;
          } catch {
            unavailable('The verifier reply could not be validated.', 'reply');
          }
        }
        await saveVerification();
        return 'complete';
      };
      const gatePasses = (): boolean => {
        try { feedbackFence?.(); } catch { unavailable('The verified passages changed or are no longer readable.', 'source'); }
        return verifier?.gate !== true || verification?.status === 'complete' && verification.verdict?.pass === true;
      };
      const unavailableGateReason = (): string | undefined => verifier?.gate === true && verification?.status === 'unavailable' ? verification.reason ?? 'the required verifier is unavailable' : undefined;
      const remaining = (): string => sum(results) === 0 && verifier?.gate === true ? 'the required verifier is still unmet' : `${sum(results)} left`;
      const verifiedStop = async (): Promise<GoalRun | undefined> => {
        try {
          const outcome = await verifyPending();
          if (outcome === 'cancelled') return finish('cancelled', 'the writer stopped the run');
          try { feedbackFence?.(); } catch {
            unavailable('The verified passages changed or are no longer readable.', 'source');
            await saveVerification();
          }
          results = evaluate();
          const currentStop = meter.stopped();
          const stop = verificationBudgetStop ?? currentStop;
          if ((outcome === 'budget' && verifier?.gate === true) || (currentStop !== undefined && (verifier?.gate === true || !results.every(result => result.pass)))) {
            return finish('budget', 'the verifier reached a shared run limit', stop === undefined ? {} : { budgetStop: stop });
          }
        } catch (error) {
          return finish('failed', error instanceof GoalVerifierPersistenceError ? error.message : 'the saved verification could not be read safely');
        }
        return undefined;
      };

      if (options.checkpoint?.outcome !== undefined) return { goal, ...options.checkpoint.outcome, iterations, results, notes, ...(verification === undefined ? {} : { verification }) };
      if (verifier !== undefined && pendingVerification === undefined && verification !== undefined) {
        try {
          const captured = await goalVerifierSources(verifier, verification.sources.map(source => source.docId), state, options.withheld);
          if (verification.key !== canonicalJson(verifier) || canonicalJson(captured.sources) !== canonicalJson(verification.sources)) throw new Error('changed sources');
          feedbackFence = captured.fence;
        } catch {
          unavailable('The saved verifier result no longer matches the readable passages.', 'source');
        }
      }
      if (pendingVerification !== undefined) {
        const stopped = await verifiedStop();
        if (stopped !== undefined) return stopped;
        const reason = unavailableGateReason();
        if (reason !== undefined) return finish('failed', reason);
      }
      if (results.every((result) => result.pass) && gatePasses()) {
        if (verifier !== undefined && verification === undefined) unavailable('There are no changed text passages: every deterministic check already passes.', 'no-changes');
        return finish('passed', 'every check already passes, so no turn was needed');
      }
      if (onlyUnmeetable(results)) return finish('failed', unmeetableReason(results));

      for (;;) {
        if (options.signal?.aborted === true) return finish('cancelled', 'the writer stopped the run');
        const limit = meter.stopped();
        if (limit !== undefined) return finish('budget', `the run reached its ${limit.dimension} limit before iteration ${nextIteration}`, { budgetStop: limit });

        const n = nextIteration;
        if (n > maxIterations) return finish('max-iterations', `the run made its ${plural(maxIterations, 'iteration')} without every check passing (${remaining()})`);
        if (options.saveCheckpoint !== undefined) {
          try {
            await options.saveCheckpoint(checkpoint());
          } catch (error) {
            return { goal, status: 'failed', reason: `the goal checkpoint could not be saved before iteration ${n}: ${error instanceof Error ? error.message : 'storage refused'}`, iterations, results, notes };
          }
          const stoppedAfterSave = Boolean(options.signal?.aborted);
          if (stoppedAfterSave) return finish('cancelled', 'the writer stopped the run');
          const savedLimit = meter.stopped();
          if (savedLimit !== undefined) return finish('budget', `the run reached its ${savedLimit.dimension} limit before iteration ${n}`, { budgetStop: savedLimit });
        }
        const preparedWithheld = canonicalJson([...options.withheld()].sort());
        results = evaluate();
        if (onlyUnmeetable(results)) return finish('failed', unmeetableReason(results));
        const before = results;
        let feedback = verification;
        try { feedbackFence?.(); } catch { feedback = undefined; }
        const verifierDocuments = verifier?.gate === true ? documentsInScope(state, verifier.scope, options.withheld()).nodes : undefined;
        const intent = iterationIntent(goal, before, n, feedback, verifierDocuments);
        const preparedTargets = verifierDocuments?.slice(0, Math.min(goal.perIteration ?? DEFAULT_DOCS_PER_ITERATION, GOAL_VERIFIER_LIMITS.documents)).map(node => ({ id: node.id, title: node.title })) ?? [];
        const preparedFeedbackFence = verifier?.gate === true && feedback?.status === 'complete' && feedback.verdict?.pass === false ? feedbackFence : undefined;
        const treeBefore = state.manifest.tree.map((node) => ({ ...node }));
        const verifierWithheldBefore = verifier === undefined ? undefined : new Set(options.withheld());
        const verifierBefore = verifier === undefined ? undefined : snapshotGoalVerifierState(state);
        let report: TurnReport;
        try {
          report = await session.submit(intent, {
            ...(options.turn ?? {}),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            preparedReadBoundary: hasSentRequest => {
              const hidden = options.withheld();
              if (canonicalJson([...hidden].sort()) !== preparedWithheld) return false;
              if (hasSentRequest) return true;
              try { preparedFeedbackFence?.(); } catch { return false; }
              if (verifier === undefined || preparedTargets.length === 0) return true;
              const current = documentsInScope(state, verifier.scope, hidden).nodes;
              return preparedTargets.every(target => state.documents.has(target.id) && current.some(node => node.id === target.id && node.title === target.title));
            },
          });
        } catch (error) {
          return finish('failed', `iteration ${n} could not run: ${error instanceof Error ? error.message : 'the turn threw'}`);
        }
        results = evaluate();
        const breaches = scopeBreaches(report, state, treeBefore, writeScope);
        const record: IterationRecord = { n, turnId: report.turnId, intent, before, after: results, report, distance: { before: sum(before), after: sum(results) }, outOfScope: breaches };
        iterations.push(record);
        nextIteration = n + 1;
        completed = record;
        let broken = results.filter((result) => !result.pass && passedBefore.has(result.key));
        for (const result of results) if (result.pass) passedBefore.add(result.key);
        const total = sum(results);
        if (total < best) {
          best = total;
          sinceBest = 0;
        } else {
          sinceBest += 1;
        }
        try {
          await options.onIteration?.(record);
        } catch (error) {
          note(`the iteration observer failed: ${error instanceof Error ? error.message : 'it threw'}`);
        }

        if (breaches.length > 0) {
          return finish('out-of-scope', `iteration ${n} wrote outside the goal’s write scope (${breaches.join('; ')}); restore it, or widen the scope and run again`);
        }
        if (verifier !== undefined && broken.length > 0) {
          verification = undefined;
          unavailable('Independent review was skipped because a deterministic check regressed.', 'stopped');
        }
        if (verifier !== undefined && verifierBefore !== undefined && broken.length === 0) {
          if (Boolean(options.signal?.aborted) || report.status === 'cancelled') return finish('cancelled', 'the writer stopped the run');
          const stop = report.budgetStop ?? meter.stopped();
          if (stop !== undefined) return finish('budget', 'the shared run limit was reached before verification', { budgetStop: stop });
          if (report.status === 'failed') return finish('failed', `iteration ${n} failed: ${report.summary}`);
          try {
            const hidden = new Set([...(verifierWithheldBefore ?? []), ...options.withheld()]);
            const input = prepareGoalVerifierInput(verifier, verifierBefore, state, hidden);
            const captured = await goalVerifierSources(verifier, input.excerpts.map(excerpt => excerpt.docId), state, options.withheld);
            verification = undefined;
            pendingVerification = { key: canonicalJson(verifier), iteration: n, phase: 'prepared', input, sources: captured.sources };
          } catch {
            unavailable('The verifier passages could not be prepared under the current read boundary.', 'source');
          }
          const failed = await commitIteration();
          if (failed !== undefined) return finish('failed', failed);
          const stopped = await verifiedStop();
          if (stopped !== undefined) return stopped;
          broken = results.filter(result => !result.pass && passedBefore.has(result.key));
          const reason = unavailableGateReason();
          if (broken.length === 0 && reason !== undefined) return finish('failed', reason);
        }
        if (results.every((result) => result.pass) && gatePasses()) return finish('passed', `every check passes after ${plural(n, 'iteration')}`);
        // A limit the turn reported, or the meter's time limit passing while it worked: both rank before the writer's Stop and a stall.
        const stoppedOn = report.budgetStop ?? meter.stopped();
        if (stoppedOn !== undefined) {
          return finish('budget', `iteration ${n} stopped on the run’s ${stoppedOn.dimension} limit`, { budgetStop: stoppedOn });
        }
        if (report.status === 'cancelled') {
          return finish('cancelled', report.stop === undefined ? `iteration ${n} was cancelled: a card was declined` : 'the writer stopped the run');
        }
        if (report.status === 'failed') return finish('failed', `iteration ${n} failed: ${report.summary}`);
        // What is left cannot be done by writing: another turn would be paid for and could not help.
        if (onlyUnmeetable(results)) return finish('failed', unmeetableReason(results));

        if (broken.length > 0) {
          const askBack: AskBack = {
            code: 'needs_input',
            reason: `iteration ${n} broke a check that passed: ${broken.map((result) => result.label).join('; ')}`,
            options: [...REGRESSION_OPTIONS],
          };
          let choice: RegressionChoice;
          try {
            choice = options.onRegression === undefined ? 'stop' : await options.onRegression({ iteration: n, turnId: report.turnId, broken });
          } catch (error) {
            // An unanswerable question is a stop, never a guess: the iteration stays applied and nothing is restored.
            return finish(
              'regressed',
              `${askBack.reason}; the question could not be answered (${error instanceof Error ? error.message : 'the callback threw'}), so the run stopped and nothing was restored`,
              { askBack },
            );
          }
          if (choice === 'restore') {
            const restored = session.restore(report.turnId);
            results = evaluate();
            // The bus undo is ok even when some compensations failed: those writes are still in the project.
            const left = restored.ok ? restored.value.failures : [];
            const said = !restored.ok
              ? `restoring iteration ${n} failed: ${restored.error.message}`
              : left.length === 0
                ? `iteration ${n} was restored`
                : `restoring iteration ${n} left ${plural(left.length, 'write')} in place: ${left.map((failure) => failure.target).join(', ')}`;
            return finish('regressed', `${askBack.reason}; ${said}`, { askBack });
          }
          if (choice === 'stop') return finish('regressed', askBack.reason, { askBack });
          // Continue anyway: the writer has seen it, so it is not a regression again unless the check is fixed and breaks once more.
          for (const result of broken) passedBefore.delete(result.key);
        }

        if (sinceBest >= stallAfter) return finish('stalled', total === 0 && verifier?.gate === true
          ? `the required verifier still does not pass after ${plural(stallAfter, 'iteration')} without deterministic improvement, so the run stopped`
          : `the checks are no closer after ${plural(stallAfter, 'iteration')} (${total} left), so the run stopped`);
        if (n >= maxIterations) return finish('max-iterations', `the run made its ${plural(maxIterations, 'iteration')} without every check passing (${remaining()})`);
        const failed = await commitIteration();
        if (failed !== undefined) return finish('failed', failed);
      }
    },
  };
}

export interface RestoredTurn {
  readonly turnId: string;
  readonly result: Result<UndoOutcome, CommandError>;
  /** True when the whole iteration was taken back: the undo was ok and no write was left in place. */
  readonly complete: boolean;
}

/**
 * Restores the whole run at once: every iteration's undo group, newest first, which is "restore to before this goal". It stops after the
 * first iteration it could not take back completely, so an older iteration is not undone under newer writes that are still in the
 * project. The failed entries stay in that group, so the restore can be tried again. An iteration that was taken back completely has no
 * group left, so a second call skips it (`not-found`) and carries on with the older iterations; the result lists only those it tried.
 *
 * A `not-found` is read as "already taken back", the only way a group leaves the undo store during a goal run. The same skip happens if
 * the session handed in does not own these turns, or if the group was forgotten by other means: the list is then shorter than the run,
 * or empty, and nothing in it says why. Pass the session that ran the goal, and compare the entries with `run.iterations` to be sure.
 */
export function restoreGoal(session: AgentSession, run: GoalRun): readonly RestoredTurn[] {
  const out: RestoredTurn[] = [];
  for (const record of [...run.iterations].reverse()) {
    if (record.report.undoGroupId === undefined) continue;
    const result = session.restore(record.turnId);
    if (!result.ok && result.error.code === 'not-found') continue;
    const complete = result.ok && result.value.failures.length === 0;
    out.push({ turnId: record.turnId, result, complete });
    if (!complete) break;
  }
  return out;
}
