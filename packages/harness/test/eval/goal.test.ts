/**
 * Goal-run scenarios (agent-harness §7.2, §9) on the real session, the real bus and the mock provider, on both wires: the planner speaks
 * the JSON envelope, or native tool calls. The checks are deterministic and so is the model, so a run is the same bytes twice.
 *
 * The model is scripted by iteration: the goal's request says "This is iteration N of at most M", and the scripted planner answers
 * that iteration's steps, then a plain reply if the turn goes back to it.
 */

import { describe, expect, it } from 'vitest';

import type { ChatRequest, Gateway } from '@caotang/gateway';
import { isPlannerCall, plannerScript, userTextOf, type MockResponse, type MockScript } from '@caotang/gateway/mock';
import type { ProjectState } from '@caotang/store';

import {
  PLANNER_SYSTEM_PREFIX,
  createAgentPorts,
  createAgentSession,
  createBudgetMeter,
  createContextPort,
  createGoalRunner,
  createHarness,
  goalRules,
  restoreGoal,
  type CheckSpec,
  type Decision,
  type AgentSessionOptions,
  type Goal,
  type GoalOptions,
  type GoalRun,
  type PendingCard,
  type RulesProvider,
  type RunLimits,
  type WriteScope,
} from '../../src/index.js';
import { mockGateway } from '../agent/gateway.js';
import { answer, steps } from '../agent/scripts.js';
import { FRIEND, LANDING, STORM, clock, makeState, snapshotOf } from '../fixtures.js';

type Wire = 'json' | 'native';

interface Call {
  readonly tool: string;
  readonly params: Record<string, unknown>;
}

const NOW = new Date('2026-10-26T09:00:00.000Z');
const FULL = { mode: 'full' } as const;

const final = (...targets: string[]): Call => ({ tool: 'meta.set', params: { targets, status: 'final' } });
const keywords = (...targets: string[]): Call => ({ tool: 'meta.set', params: { targets, keywords_add: ['noted'] } });

/** The iteration a request is for: the number after "This is iteration" in the last request the conversation carries. */
function iterationOf(req: ChatRequest): number {
  const text = userTextOf(req);
  const marker = 'This is iteration ';
  const at = text.lastIndexOf(marker);
  if (at === -1) return 0;
  let end = at + marker.length;
  while (end < text.length && text.charCodeAt(end) >= 48 && text.charCodeAt(end) <= 57) end += 1;
  return Number(text.slice(at + marker.length, end));
}

const repliesSoFar = (req: ChatRequest): number => req.messages.filter((message) => message.role === 'assistant').length;

const isNativePlanner = (req: ChatRequest): boolean => (req.tools?.length ?? 0) > 0 && (req.messages[0]?.content ?? '').startsWith(PLANNER_SYSTEM_PREFIX);

/** The planner on either wire: iteration n's calls, then a plain reply when the turn comes back to the model (a refusal, a result). */
function planner(wire: Wire, plan: (iteration: number) => readonly Call[]): MockScript[] {
  if (wire === 'json') {
    return [
      plannerScript((req) => {
        if (repliesSoFar(req) > 0) return answer('Understood.');
        const calls = plan(iterationOf(req));
        return calls.length === 0 ? answer('Nothing to change.') : steps(...calls.map((call) => ({ ...call, expect: `${call.tool} is applied` })));
      }),
    ];
  }
  return [
    {
      match: isNativePlanner,
      respond: (req): MockResponse => {
        if (repliesSoFar(req) > 0) return { content: 'Understood.' };
        const calls = plan(iterationOf(req));
        return calls.length === 0
          ? { content: 'Nothing to change.' }
          : { content: '', toolCalls: calls.map((call, index) => ({ id: `call_${iterationOf(req)}_${index}`, name: call.tool, argumentsJson: JSON.stringify(call.params) })) };
      },
    },
  ];
}

interface Rig {
  readonly state: ProjectState;
  readonly before: string;
  readonly cards: PendingCard[];
  readonly requests: ChatRequest[];
  readonly start: (goal: Goal, extra?: Partial<GoalOptions>) => Promise<GoalRun>;
  readonly session: ReturnType<typeof createAgentSession>;
}

/** What a goal inherits from the app: its session options (a mode) and its rules (#52). */
interface Held {
  readonly session?: Partial<AgentSessionOptions>;
  readonly rules?: RulesProvider;
}

async function rig(wire: Wire, plan: (iteration: number) => readonly Call[], limits: RunLimits, decide: (card: PendingCard) => Decision = () => ({ action: 'approve' }), scope?: WriteScope, held: Held = {}): Promise<Rig> {
  const state = makeState();
  const requests: ChatRequest[] = [];
  const base = await mockGateway(planner(wire, plan));
  const gateway: Gateway = {
    ...base,
    ...(wire === 'native' ? { modelCaps: () => ({ tools: true }) } : {}),
    complete: (request, signal) => {
      requests.push(request);
      return base.complete(request, signal);
    },
  };
  const meter = createBudgetMeter(limits);
  const harness = createHarness({
    state,
    ports: createAgentPorts(),
    clock: clock.now,
    ...(scope !== undefined ? { rules: goalRules(held.rules, scope, state) } : held.rules !== undefined ? { rules: held.rules } : {}),
  });
  const cards: PendingCard[] = [];
  const session = createAgentSession({
    harness,
    gateway,
    context: createContextPort({ state }),
    decide: async (card) => {
      cards.push(card);
      return decide(card);
    },
    meter,
    sessionId: 'goal',
    ...(held.session ?? {}),
  });
  return {
    state,
    before: snapshotOf(state),
    cards,
    requests,
    session,
    start: (goal, extra = {}) => createGoalRunner().start(goal, { session, state, meter, now: () => NOW, withheld: () => harness.withheldAnywhere(), ...extra }),
  };
}

const goalOf = (checks: readonly CheckSpec[], limits: RunLimits, extra: Partial<Goal> = {}): Goal => ({
  id: 'goal-1',
  intent: 'Mark the manuscript final.',
  checks,
  limits,
  ...extra,
});

const statusOf = (state: ProjectState, id: string): string | null => state.manifest.tree.find((node) => node.id === id)?.status ?? null;
const ALL_FINAL: CheckSpec = { kind: 'status.all', scope: FULL, status: 'final' };

describe.each<Wire>(['json', 'native'])('goal runs on the %s wire', (wire) => {
  it('passes in two iterations, asking for every card each time, and the whole run restores at once', async () => {
    const limits = { maxModelCalls: 20 };
    const f = await rig(wire, (n) => (n === 1 ? [final(STORM), final(FRIEND)] : [final(LANDING), keywords(LANDING)]), limits);
    const run = await f.start(goalOf([ALL_FINAL], limits));

    expect(run.status).toBe('passed');
    expect(run.iterations.map((record) => record.distance)).toEqual([
      { before: 3, after: 1 },
      { before: 1, after: 0 },
    ]);
    expect([LANDING, STORM, FRIEND].map((id) => statusOf(f.state, id))).toEqual(['final', 'final', 'final']);
    // Each iteration was an ordinary turn: its plan card went to the writer, and the second request named only what still failed.
    expect(f.cards.map((card) => card.kind)).toEqual(['plan', 'plan']);
    const second = run.iterations[1]?.intent ?? '';
    expect(second).toContain('iteration 2 of at most 10');
    expect(second).toContain('"The Landing"');
    expect(second).not.toContain('"The Storm"');
    expect(run.iterations.every((record) => record.report.undoGroupId !== undefined)).toBe(true);

    const restored = restoreGoal(f.session, run);
    expect(restored.every((entry) => entry.result.ok)).toBe(true);
    expect(snapshotOf(f.state)).toBe(f.before);
  });

  it('stalls when the changes do not bring the checks closer', async () => {
    const limits = { maxModelCalls: 20 };
    const f = await rig(wire, () => [keywords(STORM)], limits);
    const run = await f.start(goalOf([ALL_FINAL], limits));
    expect(run.status).toBe('stalled');
    expect(run.iterations).toHaveLength(2);
    expect(run.iterations.map((record) => record.distance.after)).toEqual([3, 3]);
  });

  it('stops with the restore, continue or stop ask-back when an iteration breaks a check that passed', async () => {
    const limits = { maxModelCalls: 20 };
    const checks: CheckSpec[] = [
      { kind: 'status.all', scope: { mode: 'doc', docIds: [STORM] }, status: 'final' },
      { kind: 'status.all', scope: { mode: 'doc', docIds: [FRIEND] }, status: 'final' },
      { kind: 'status.all', scope: { mode: 'doc', docIds: [LANDING] }, status: 'draft' },
    ];
    // Iteration 1 finishes The Storm. Iteration 2 finishes The Friend and, with it, takes The Landing off draft.
    const plan = (n: number): readonly Call[] => (n === 1 ? [final(STORM), keywords(STORM)] : [final(FRIEND), final(LANDING)]);
    const f = await rig(wire, plan, limits);
    const run = await f.start(goalOf(checks, limits));
    expect(run.status).toBe('regressed');
    expect(run.iterations).toHaveLength(2);
    expect(run.askBack).toMatchObject({ code: 'needs_input', options: ['restore to before this iteration', 'continue anyway', 'stop here and keep what was applied'] });

    // Choosing restore puts the project back to what it was after iteration 1, before the one that broke it.
    const g = await rig(wire, plan, limits);
    let afterFirst = '';
    const restoredRun = await g.start(goalOf(checks, limits), {
      onIteration: (record) => {
        if (record.n === 1) afterFirst = snapshotOf(g.state);
      },
      onRegression: () => 'restore',
    });
    expect(restoredRun.status).toBe('regressed');
    expect(restoredRun.reason).toContain('iteration 2 was restored');
    expect(snapshotOf(g.state)).toBe(afterFirst);
  });

  it('stops on the run’s limit in the middle of the goal, with what was applied kept', async () => {
    const limits = { maxModelCalls: 1 };
    const f = await rig(wire, () => [final(STORM)], limits);
    const run = await f.start(goalOf([ALL_FINAL], limits));
    expect(run.status).toBe('budget');
    expect(run.budgetStop).toMatchObject({ dimension: 'model-calls', limit: 1 });
    expect(run.iterations).toHaveLength(2);
    expect(statusOf(f.state, STORM)).toBe('final');
    expect(run.iterations[1]?.report.status).toBe('failed');
  });

  it('stops at maxIterations while the distance is still falling', async () => {
    const limits = { maxModelCalls: 20 };
    const f = await rig(wire, (n) => [[final(STORM), keywords(STORM)], [final(FRIEND), keywords(FRIEND)], [final(LANDING)]][n - 1] ?? [], limits);
    const run = await f.start(goalOf([ALL_FINAL], limits, { maxIterations: 2 }));
    expect(run.status).toBe('max-iterations');
    expect(run.iterations.map((record) => record.distance.after)).toEqual([2, 1]);
  });

  it('refuses a write outside the write scope at the preflight, before anything is drafted or carded', async () => {
    const limits = { maxModelCalls: 20 };
    const scope: WriteScope = { mode: 'doc', docIds: [STORM] };
    const f = await rig(wire, () => [final(FRIEND), keywords(FRIEND)], limits, undefined, scope);
    const run = await f.start(goalOf([ALL_FINAL], limits, { writeScope: scope }));

    expect(f.cards).toEqual([]);
    expect(snapshotOf(f.state)).toBe(f.before);
    expect(run.iterations[0]?.report.trace.map((entry) => [entry.outcome, entry.code])).toEqual([
      ['refused', 'permission-denied'],
      ['refused', 'permission-denied'],
    ]);
    // The model was told why, and by which rule.
    const told = f.requests
      .filter((request) => (wire === 'json' ? isPlannerCall(request) : isNativePlanner(request)))
      .map((request) => userTextOf(request))
      .join('\n');
    expect(told).toContain('outside the write scope of the goal run');
    // Nothing moved, so the run stalls instead of writing anywhere else.
    expect(run.status).toBe('stalled');
    expect(run.iterations.every((record) => record.outOfScope.length === 0)).toBe(true);
  });

  it('ends a run whose iteration wrote outside the scope when no rule stopped it, and the run restores', async () => {
    const limits = { maxModelCalls: 20 };
    const scope: WriteScope = { mode: 'doc', docIds: [STORM] };
    const f = await rig(wire, () => [final(FRIEND), keywords(FRIEND)], limits);
    const run = await f.start(goalOf([ALL_FINAL], limits, { writeScope: scope }));
    expect(run.status).toBe('out-of-scope');
    expect(run.iterations[0]?.outOfScope).toEqual(['meta.set: The Friend', 'meta.set: The Friend']);
    restoreGoal(f.session, run);
    expect(snapshotOf(f.state)).toBe(f.before);
  });

  it('is held to the permission mode like any turn: in plan-only mode no iteration changes anything, so the run stalls', async () => {
    const limits = { maxModelCalls: 20 };
    const f = await rig(wire, () => [final(STORM), keywords(STORM)], limits, undefined, undefined, { session: { mode: 'plan-only' } });
    const run = await f.start(goalOf([ALL_FINAL], limits));
    expect(run.status).toBe('stalled');
    expect(f.cards).toEqual([]);
    expect(snapshotOf(f.state)).toBe(f.before);
    expect(run.iterations[0]?.report.heldSteps).toHaveLength(2);
  });

  it('is held to the writer’s deny rules like any turn: a locked document stays as it was while the others are finished', async () => {
    const limits = { maxModelCalls: 20 };
    const rules: RulesProvider = () => ({
      rules: [{ effect: 'deny', tool: '*', access: 'write', scope: { subtree: STORM }, note: 'the writer locked The Storm', source: 'app' }],
    });
    const f = await rig(wire, (n) => (n === 1 ? [final(FRIEND), final(LANDING)] : [final(STORM), keywords(STORM)]), limits, undefined, undefined, { rules });
    const run = await f.start(goalOf([ALL_FINAL], limits));
    expect(statusOf(f.state, STORM)).toBeNull();
    expect([LANDING, FRIEND].map((id) => statusOf(f.state, id))).toEqual(['final', 'final']);
    expect(run.status).toBe('stalled');
    expect(run.results[0]?.failures.map((failure) => failure.title)).toEqual(['The Storm']);
  });

  it('keeps a document a read rule withholds out of the goal’s requests and out of the provider’s, and does not make it a reason to fail', async () => {
    const limits = { maxModelCalls: 20 };
    const rules: RulesProvider = () => ({
      rules: [{ effect: 'deny', tool: '*', access: 'read', scope: { subtree: STORM }, note: 'the writer withheld The Storm', source: 'app' }],
    });
    const f = await rig(wire, () => [final(FRIEND), final(LANDING)], limits, undefined, undefined, { rules });
    const run = await f.start(goalOf([ALL_FINAL], limits));
    expect(run.status).toBe('passed');
    expect(statusOf(f.state, STORM)).toBeNull();
    for (const intent of run.iterations.map((record) => record.intent)) {
      expect(intent).not.toContain('The Storm');
      expect(intent).not.toContain(STORM);
    }
    const sent = JSON.stringify(f.requests);
    expect(sent).not.toContain('The Storm');
    expect(sent).not.toContain('The lamp failed');
    expect(JSON.stringify(run.results)).not.toContain('The Storm');
  });

  it('is refused before the first turn when it has no limit', async () => {
    const f = await rig(wire, () => [final(STORM)], {});
    const run = await f.start(goalOf([ALL_FINAL], {}));
    expect(run.status).toBe('refused');
    expect(f.requests).toEqual([]);
    expect(snapshotOf(f.state)).toBe(f.before);
  });
});

