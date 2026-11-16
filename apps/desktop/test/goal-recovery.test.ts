/**
 * Goal recovery in the app's controller (agent-harness §7.2): a goal record left behind by a reload is offered for an explicit
 * resume and starts nothing on its own; the writer's Resume settles it; Discard removes the record and nothing else.
 *
 * The provider here answers nothing (no script matches), so any model call would be visible as a failure: a run that settles
 * `passed` without one proves recovery spends nothing until the writer asks.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore } from '@caotang/gateway';
import { createMockProvider } from '@caotang/gateway/mock';
import { appendGoalCheckpoint, createGoalRun, createRunLogPort, deleteGoalRun, markGoalsInterrupted, openRuntimeStore, readGoalRun, readRun, recordGoalIteration, writeProjectState, MemoryIndexedDb, type GoalCheckpoint } from '@caotang/store';

import { AgentController, type AgentSnapshot } from '../src/app/agent.js';
import type { AppDb } from '../src/app/app-db.js';
import { sampleProjectState } from '../src/app/demo.js';
import type { ProviderService } from '../src/app/providers.js';
import { ProjectSession } from '../src/app/session.js';
import { TaskStore } from '../src/app/task-store.js';

const GOAL = 'g_7QK4M2N8RT';
const sessions: { session: ProjectSession; controller: AgentController }[] = [];

beforeEach(() => {
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { session, controller } of sessions.splice(0)) {
    controller.stop();
    controller.detach();
    await controller.tasksIdle();
    await session.close();
  }
  vi.unstubAllGlobals();
});

function memoryDb(): AppDb {
  const rows = new Map<string, unknown>();
  return {
    async get<T>(key: string) { return structuredClone(rows.get(key)) as T | undefined; },
    async put(key, value) { rows.set(key, structuredClone(value)); },
    async list<T>(prefix: string) {
      return [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T }));
    },
    async delete(key) { rows.delete(key); },
    close() {},
  };
}

function when(controller: AgentController, ready: (snapshot: AgentSnapshot) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (!ready(controller.snapshot())) return;
      unsubscribe();
      resolve();
    };
    const unsubscribe = controller.subscribe(check);
    check();
  });
}

/** A goal whose only check the sample project already meets, so a resume settles without a turn. */
function passedGoal() {
  return {
    id: GOAL,
    intent: 'Keep every scene as it is.',
    checks: [{ kind: 'synopsis.filled' as const, scope: { mode: 'full' as const } }],
    limits: { maxModelCalls: 10 },
  };
}

async function fixture(reply = false) {
  const state = sampleProjectState();
  for (const node of state.manifest.tree) if (node.type === 'document') node.synopsis = 'Already written.';
  const store = await openRuntimeStore(new MemoryIndexedDb());
  await writeProjectState(store, state);
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const profile = await profiles.create({ name: 'Mock', kind: 'mock', isActive: true });
  const providers = {
    gateway: createGateway({ profiles, keys, clock: createManualClock(0), mock: createMockProvider({ scripts: reply ? [{ match: () => true, respond: () => ({ content: JSON.stringify({ reply: 'Nothing to change.' }) }) }] : [] }) }),
    active: () => profile,
    persist: async () => undefined,
  } as unknown as ProviderService;
  const controller: AgentController = new AgentController(session, providers, () => ({}), () => false, {
    store: new TaskStore(memoryDb()),
    locksAvailable: () => false,
    sleep: () => when(controller, (snapshot) => !snapshot.busy),
  });
  sessions.push({ session, controller });
  await controller.loadSessions();
  await controller.newSession();
  const goal = passedGoal();
  const checkpoint: GoalCheckpoint = { goal, iterations: [], results: [], nextIteration: 1, spend: { modelCalls: 0, promptTokens: 0, completionTokens: 0, estimatedTokens: 0, steps: 0, activeMs: 0 } };
  await createGoalRun(store, { goalId: GOAL, projectId: session.projectId, sessionId: controller.snapshot().sessionId, checkpoint, at: 100 });
  await appendGoalCheckpoint(store, GOAL, { checkpoint: { ...checkpoint, nextIteration: 2 }, at: 200 });
  return { session, controller, store, providers };
}

it('offers a goal a reload abandoned as interrupted, resumes it only when the writer asks, then settles it', async () => {
  const f = await fixture();
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot.goals.length === 1);
  const offered = f.controller.snapshot().goals[0]!;
  expect(offered).toMatchObject({ goalId: GOAL, status: 'interrupted', resumable: true, unreadable: false, intent: 'Keep every scene as it is.', nextIteration: 2 });
  expect((await readGoalRun(f.store, GOAL))?.status).toBe('interrupted');
  // Nothing ran: the record waited for the writer, and no turn was started for it.
  expect(f.controller.snapshot().turns).toEqual([]);
  expect((await readGoalRun(f.store, GOAL))?.iterationRunIds).toEqual([]);

  const originalSession = f.controller.snapshot().sessionId;
  await f.controller.newSession();
  expect(f.controller.snapshot().sessionId).not.toBe(originalSession);
  await f.controller.resumeGoal(GOAL);
  expect(f.controller.snapshot().sessionId).toBe(originalSession);
  const settled = await readGoalRun(f.store, GOAL);
  expect(settled?.status).toBe('settled');
  expect(settled?.result?.status).toBe('passed');
  expect(f.controller.snapshot().goals[0]).toMatchObject({ status: 'settled', resumable: false });
  expect(f.controller.snapshot().turns).toEqual([]);
});

it('discards a goal record without touching the project or anything it ran', async () => {
  const f = await fixture();
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot.goals.length === 1);
  const before = JSON.stringify(f.session.state.manifest);
  await f.controller.discardGoal(GOAL);
  expect(await readGoalRun(f.store, GOAL)).toBeUndefined();
  expect(f.controller.snapshot().goals).toEqual([]);
  expect(JSON.stringify(f.session.state.manifest)).toBe(before);
});

it('Stop owns the goal between turns and prevents its next provider request', async () => {
  const f = await fixture();
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot.goals.length === 1);
  let stopped = false;
  const unsubscribe = f.controller.subscribe(() => {
    if (stopped || f.controller.snapshot().goalAction !== 'running') return;
    stopped = true;
    expect(f.controller.snapshot().stoppable).toBe(true);
    f.controller.stop();
  });
  try {
    await f.controller.startGoal({ ...passedGoal(), id: 'g_7QK4M2N8RV', checks: [{ kind: 'status.all', status: 'final', scope: { mode: 'full' } }] });
    expect(stopped, f.controller.snapshot().message ?? undefined).toBe(true);
    expect((await readGoalRun(f.store, 'g_7QK4M2N8RV'))?.result?.status).toBe('cancelled');
    expect(f.controller.snapshot().turns).toEqual([]);
  } finally {
    unsubscribe();
  }
});

it('runs goal iterations through the normal conversation lifecycle and retains their run-log ids', async () => {
  const f = await fixture(true);
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot.goals.length === 1);
  const id = 'g_7QK4M2N8RW';
  await f.controller.startGoal({ ...passedGoal(), id, checks: [{ kind: 'status.all', status: 'final', scope: { mode: 'full' } }] });
  const row = await readGoalRun(f.store, id);
  expect(row?.result?.status, row?.result?.reason).toBe('stalled');
  const turns = f.controller.snapshot().turns;
  expect(turns).toHaveLength(2);
  expect(turns.map((turn) => turn.intent)).toEqual([
    expect.stringContaining('This is iteration 1 of at most 10'),
    expect.stringContaining('This is iteration 2 of at most 10'),
  ]);
  expect(row?.iterationRunIds).toHaveLength(2);
  for (const runId of row?.iterationRunIds ?? []) expect(await readRun(f.store, runId)).toMatchObject({ projectId: f.session.projectId });
});

it('reserves the controller while Resume is awaiting its durable record', async () => {
  const f = await fixture();
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot.goals.length === 1);
  const resuming = f.controller.resumeGoal(GOAL);
  expect(f.controller.snapshot().busy).toBe(true);
  const ordinary = await f.controller.submit('A separate request must wait.');
  await resuming;
  expect(ordinary).toBeNull();
  expect(f.controller.snapshot().turns).toEqual([]);
});

it('counts a crash-lost reserved call from the active iteration before resuming the goal', async () => {
  const f = await fixture();
  const goal = { ...passedGoal(), checks: [{ kind: 'status.all' as const, status: 'final', scope: { mode: 'full' as const } }], limits: { maxModelCalls: 1 } };
  const spend = { modelCalls: 0, promptTokens: 0, completionTokens: 0, estimatedTokens: 0, steps: 0, activeMs: 0 };
  await appendGoalCheckpoint(f.store, GOAL, { checkpoint: { goal, iterations: [], results: [], nextIteration: 1, spend }, at: 200 });
  const port = createRunLogPort(f.store);
  await port.create({ schema: 3, runId: 'active-iteration', projectId: f.session.projectId, kind: 'turn', intent: goal.intent, createdAt: 200, updatedAt: 200, status: 'interrupted' });
  await port.append('active-iteration', [
    { t: 'turn.start', v: 3, turnId: 'active-turn', intent: goal.intent, wire: 'planner', native: false, seq: 0, at: 200 },
    { t: 'spend', turnId: 'active-turn', spend, reservedCalls: 1, seq: 1, at: 201 },
  ]);
  await recordGoalIteration(f.store, GOAL, 'active-iteration', 200);
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot.goals.length === 1);
  await f.controller.resumeGoal(GOAL);
  expect((await readGoalRun(f.store, GOAL))?.result?.status).toBe('budget');
  expect(f.controller.snapshot().turns).toEqual([]);
});

it('keeps a goal interrupted when its linked iteration may already have written to an MCP server', async () => {
  const f = await fixture();
  const port = createRunLogPort(f.store);
  await port.create({ schema: 3, runId: 'uncertain-mcp', projectId: f.session.projectId, kind: 'turn', intent: 'Send the scene.', createdAt: 200, updatedAt: 200, status: 'interrupted' });
  await port.append('uncertain-mcp', [
    { t: 'turn.start', v: 3, turnId: 'external-turn', intent: 'Send the scene.', wire: 'planner', native: false, seq: 0, at: 200 },
    { t: 'step.intent', turnId: 'external-turn', callId: 'external-write', index: 0, tool: 'mcp__test__write', expect: {}, structure: 'unchanged', seq: 1, at: 201 },
  ]);
  await recordGoalIteration(f.store, GOAL, 'uncertain-mcp', 200);
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot.goals.length === 1);
  await f.controller.resumeGoal(GOAL);
  expect((await readGoalRun(f.store, GOAL))?.status).toBe('interrupted');
  expect(f.controller.snapshot().message).toContain('server may already have acted');
  expect(f.controller.snapshot().turns).toEqual([]);
});

it('sends no model request when the active goal-to-run link fails in storage', async () => {
  const f = await fixture(true);
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot.goals.length === 1);
  const transaction = f.store.db.transaction.bind(f.store.db);
  let writes = 0;
  vi.spyOn(f.store.db, 'transaction').mockImplementation((names, mode, options) => {
    const stores = typeof names === 'string' ? [names] : [...names];
    if (mode === 'readwrite' && stores.length === 1 && stores[0] === 'goalRuns' && ++writes === 2) throw new Error('goal link refused');
    return transaction(names, mode, options);
  });
  const id = 'g_7QK4M2N8RX';
  await f.controller.startGoal({ ...passedGoal(), id, checks: [{ kind: 'status.all', status: 'final', scope: { mode: 'full' } }] });
  expect(writes).toBeGreaterThanOrEqual(2);
  expect((await readGoalRun(f.store, id))?.result?.status).toBe('failed');
  expect(f.providers.gateway.ledger.turnRows()).toEqual([]);
  expect(f.controller.snapshot().turns[0]?.report?.modelCalls).toBe(0);
});

it('does not repeat a completed iteration whose goal checkpoint did not reach storage', async () => {
  const f = await fixture();
  const port = createRunLogPort(f.store);
  await port.create({ schema: 3, runId: 'completed-with-stale-goal', projectId: f.session.projectId, kind: 'turn', intent: 'Finished work.', createdAt: 200, updatedAt: 200, status: 'finished' });
  await port.append('completed-with-stale-goal', [
    { t: 'turn.start', v: 3, turnId: 'completed-turn', intent: 'Finished work.', wire: 'planner', native: false, seq: 0, at: 200 },
    { t: 'turn.end', turnId: 'completed-turn', status: 'replied', summary: 'Finished work.', seq: 1, at: 201 },
  ]);
  await recordGoalIteration(f.store, GOAL, 'completed-with-stale-goal', 200);
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot.goals.length === 1);
  await f.controller.resumeGoal(GOAL);
  expect((await readGoalRun(f.store, GOAL))?.status).toBe('interrupted');
  expect(f.controller.snapshot().message).toContain('completed iteration has no saved goal checkpoint');
  expect(f.providers.gateway.ledger.turnRows()).toEqual([]);
});

it('settles a committed terminal checkpoint after a crash without another iteration', async () => {
  const f = await fixture(true);
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot.goals.length === 1);
  const id = 'g_7QK4M2N8RY';
  await f.controller.startGoal({ ...passedGoal(), id, maxIterations: 1, checks: [{ kind: 'status.all', status: 'final', scope: { mode: 'full' } }] });
  const completed = (await readGoalRun(f.store, id))!;
  expect(completed.result?.status).toBe('max-iterations');
  expect(completed.checkpoint).toMatchObject({ nextIteration: 2, outcome: { status: 'max-iterations' } });
  const calls = f.providers.gateway.ledger.turnRows().length;
  await deleteGoalRun(f.store, id);
  await createGoalRun(f.store, { goalId: id, projectId: f.session.projectId, sessionId: completed.sessionId, checkpoint: completed.checkpoint, at: 300 });
  for (const runId of completed.iterationRunIds) await recordGoalIteration(f.store, id, runId, 300);
  await markGoalsInterrupted(f.store, f.session.projectId, 301);
  await f.controller.loadGoals();
  await f.controller.resumeGoal(id);
  expect((await readGoalRun(f.store, id))?.result?.status).toBe('max-iterations');
  expect(f.controller.snapshot().turns).toHaveLength(1);
  expect(f.providers.gateway.ledger.turnRows()).toHaveLength(calls);
});

it('offers a checkpoint with invalid cost spend only for discarding, without constructing a resumed turn', async () => {
  const f = await fixture();
  const id = 'g_7QK4M2N8RZ';
  const checkpoint = {
    goal: { ...passedGoal(), id, limits: { maxCostUsd: 0.01 } }, iterations: [], results: [], nextIteration: 1,
    spend: { modelCalls: 0, promptTokens: 0, completionTokens: 0, estimatedTokens: 0, steps: 0, activeMs: 0, costUsd: NaN },
  };
  await createGoalRun(f.store, { goalId: id, projectId: f.session.projectId, sessionId: f.controller.snapshot().sessionId, checkpoint, at: 100 });
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot.goals.length === 2);
  expect(f.controller.snapshot().goals.find((goal) => goal.goalId === id)).toMatchObject({ unreadable: true, resumable: false });
  await f.controller.resumeGoal(id);
  expect(f.controller.snapshot().turns).toEqual([]);
  expect(f.providers.gateway.ledger.turnRows()).toEqual([]);
  expect((await readGoalRun(f.store, id))?.status).toBe('interrupted');
  await f.controller.discardGoal(id);
  expect(await readGoalRun(f.store, id)).toBeUndefined();
  expect(await readGoalRun(f.store, GOAL)).toBeDefined();
});
