/**
 * Goal recovery in the app's controller (agent-harness §7.2): a goal record left behind by a reload is offered for an explicit
 * resume and starts nothing on its own; the writer's Resume settles it; Discard removes the record and nothing else.
 *
 * The provider here answers nothing (no script matches), so any model call would be visible as a failure: a run that settles
 * `passed` without one proves recovery spends nothing until the writer asks.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emptyCoherenceFile, type DeterministicCheckId } from '@caotang/coherence';
import type { Goal, GoalCheckpoint } from '@caotang/harness';
import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore } from '@caotang/gateway';
import { createMockProvider } from '@caotang/gateway/mock';
import { addDocument, appendGoalCheckpoint, createGoalRun, createRunLogPort, deleteGoalRun, markGoalsInterrupted, openRuntimeStore, readGoalRun, readRun, recordGoalIteration, removeAgentSession, resumeGoalRun, writeProjectState, MemoryIndexedDb } from '@caotang/store';

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
  vi.stubGlobal('navigator', { locks: { request: vi.fn() } });
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

async function fixture(reply = false, response: unknown = { reply: 'Nothing to change.' }, coherenceChecks?: () => readonly DeterministicCheckId[], extraDocuments = 0) {
  const state = sampleProjectState();
  for (let index = 0; index < extraDocuments; index += 1) addDocument(state, { parentId: 'manuscript', title: `Extra scene ${index + 1}`, body: 'The boat returned.', now: new Date(0) });
  for (const node of state.manifest.tree) if (node.type === 'document') node.synopsis = 'Already written.';
  const store = await openRuntimeStore(new MemoryIndexedDb());
  await writeProjectState(store, state);
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const profile = await profiles.create({ name: 'Mock', kind: 'mock', isActive: true });
  const providers = {
    gateway: createGateway({ profiles, keys, clock: createManualClock(0), mock: createMockProvider({ scripts: reply ? [{ match: () => true, respond: () => ({ content: JSON.stringify(response) }) }] : [] }) }),
    active: () => profile,
    persist: async () => undefined,
  } as unknown as ProviderService;
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null, ...(coherenceChecks === undefined ? {} : { coherence: { checks: coherenceChecks, providers } }) });
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

it('keeps the final no-turn check table in the recovery view', async () => {
  const f = await fixture();
  await f.controller.loadGoals();
  await f.controller.resumeGoal(GOAL);
  expect(f.controller.snapshot().goals[0]).toMatchObject({ watch: { checks: [{ kind: 'synopsis.filled', pass: true, distance: 0 }] } });
});

it.each([false, true])('runs an isolated Background verifier through the production controller (gate %s)', async gate => {
  const f = await fixture(true, { steps: [{ tool: 'synopsis.set', params: { doc: 'The Storm', synopsis: 'The ferry departs at dawn.' }, expect: 'The departure is named.' }] });
  const node = f.session.state.manifest.tree.find(candidate => candidate.title === 'The Storm');
  if (node === undefined) throw new Error('missing fixture document');
  node.synopsis = '';
  const reviewProfile = await f.providers.gateway.profiles.create({ name: 'Independent mock', kind: 'mock' });
  f.providers.resolveForRole = role => role === 'background' ? { profile: reviewProfile, model: reviewProfile.defaultModel } : undefined;
  const complete = f.providers.gateway.complete.bind(f.providers.gateway);
  let reviews = 0;
  let reserved: GoalCheckpoint | undefined;
  let actorRunIds: readonly string[] = [];
  const id = gate ? 'g_7QK4M2N8RX' : 'g_7QK4M2N8RZ';
  vi.spyOn(f.providers.gateway, 'complete').mockImplementation(async function* (request, signal, beforeSend) {
    if (request.role !== 'background') { yield* complete(request, signal, beforeSend); return; }
    const row = await readGoalRun(f.store, id);
    expect(row?.checkpoint).toMatchObject({ pendingVerification: { phase: 'reserved' } });
    reserved = structuredClone(row!.checkpoint as GoalCheckpoint);
    actorRunIds = [...row!.iterationRunIds];
    expect(row?.iterationRunIds).toHaveLength(1);
    expect((await readRun(f.store, row!.iterationRunIds[0]!))?.status).toBe('finished');
    expect(request.profileId).toBe(reviewProfile.id);
    expect(request.messages.map(message => message.role)).toEqual(['system', 'user']);
    expect(request.tools).toBeUndefined();
    expect(JSON.stringify(request.messages)).toContain('The ferry departs at dawn.');
    expect(JSON.stringify(request.messages)).not.toContain(node.id);
    beforeSend?.();
    reviews += 1;
    yield { delta: JSON.stringify({ pass: gate, reasons: gate ? [] : ['The wording could be clearer.'] }), finishReason: 'stop' as const };
  });
  f.controller.attach();
  await when(f.controller, snapshot => snapshot.goals.length === 1);
  const unsubscribe = f.controller.subscribe(() => { if (f.controller.snapshot().pending !== null) f.controller.answer({ action: 'approve' }); });
  try {
    const scope = { mode: 'doc', docIds: [node.id] } as const;
    const goal: Goal = { ...passedGoal(), id, checks: [{ kind: 'synopsis.filled', scope }, { kind: 'verifier', scope, rubric: 'The synopsis names the departure time.', gate }] };
    await f.controller.startGoal(goal);
    const row = await readGoalRun(f.store, id);
    expect(row?.result, JSON.stringify(row?.checkpoint)).toMatchObject({ status: 'passed' });
    expect(row?.schema).toBe(2);
    expect(row?.checkpoint).toMatchObject({ verification: { status: 'complete', verdict: { pass: gate } } });
    expect(reviews).toBe(1);
    expect((row!.checkpoint as GoalCheckpoint).spend.modelCalls).toBe(f.providers.gateway.ledger.turnRows().length + 1);
    const savedReservation = reserved;
    if (savedReservation?.pendingVerification?.reservation === undefined) throw new Error('missing saved verifier reservation');
    const actorCalls = f.providers.gateway.ledger.turnRows().length;
    for (const phase of ['prepared', 'reserved'] as const) {
      const pending = savedReservation.pendingVerification;
      const { reservation: _reservation, ...prepared } = pending;
      const checkpoint: GoalCheckpoint = phase === 'reserved' ? structuredClone(savedReservation) : {
        ...savedReservation, spend: { ...savedReservation.spend, modelCalls: savedReservation.spend.modelCalls - 1 }, pendingVerification: { ...prepared, phase: 'prepared' },
      };
      await deleteGoalRun(f.store, id);
      await createGoalRun(f.store, { goalId: id, projectId: f.session.projectId, sessionId: f.controller.snapshot().sessionId, checkpoint, at: 500 });
      for (const runId of actorRunIds) await recordGoalIteration(f.store, id, runId, 501);
      await markGoalsInterrupted(f.store, f.session.projectId, 502);
      await f.controller.resumeGoal(id);
      const restored = await readGoalRun(f.store, id);
      expect(restored?.result).toMatchObject({ status: phase === 'reserved' && gate ? 'failed' : 'passed' });
      expect(f.providers.gateway.ledger.turnRows()).toHaveLength(actorCalls);
      expect(reviews).toBe(2);
      if (phase === 'reserved') {
        expect(restored?.checkpoint).toMatchObject({ verification: { status: 'unavailable', code: 'interrupted', uncertainUsage: true } });
        const spend = (restored!.checkpoint as GoalCheckpoint).spend;
        expect(spend.modelCalls).toBe(savedReservation.spend.modelCalls);
        expect(spend.estimatedTokens).toBeGreaterThanOrEqual(pending.reservation!.promptTokens + pending.reservation!.maxOutputTokens);
      }
    }
  } finally {
    unsubscribe();
  }
});

it('forwards the prepared goal read boundary through asynchronous controller setup', async () => {
  const f = await fixture(true);
  await f.session.harnessReady();
  const node = f.session.state.manifest.tree.find(candidate => candidate.title === 'The Storm');
  if (node === undefined) throw new Error('missing fixture document');
  let tightened = false;
  let setups = 0;
  const ready = f.session.harnessReady.bind(f.session);
  vi.spyOn(f.session, 'harnessReady').mockImplementation(async () => {
    await ready();
    setups += 1;
    if (setups === 2) tightened = true;
  });
  vi.spyOn(f.session.harness, 'withheldAnywhere').mockImplementation(() => new Set(tightened ? [node.id] : []));
  f.controller.attach();
  await when(f.controller, snapshot => snapshot.goals.length === 1);
  const id = 'g_7QK4M2N8RZ';
  const scope = { mode: 'doc', docIds: [node.id] } as const;
  await f.controller.startGoal({ ...passedGoal(), id, checks: [{ kind: 'status.all', scope, status: 'final' }, { kind: 'verifier', scope, rubric: 'The departure is clear.', gate: true }] });
  const row = await readGoalRun(f.store, id);
  expect(row?.result).toMatchObject({ status: 'failed' });
  expect((row!.checkpoint as GoalCheckpoint).iterations[0]?.report.askBack?.code).toBe('needs_input');
  expect(f.providers.gateway.ledger.turnRows()).toEqual([]);
});

it('lets Stop settle an in-flight verifier without starting another actor or review', async () => {
  const f = await fixture(true, { steps: [{ tool: 'synopsis.set', params: { doc: 'The Storm', synopsis: 'The ferry departs at dawn.' }, expect: 'The departure is named.' }] });
  const node = f.session.state.manifest.tree.find(candidate => candidate.title === 'The Storm');
  if (node === undefined) throw new Error('missing fixture document');
  node.synopsis = '';
  const complete = f.providers.gateway.complete.bind(f.providers.gateway);
  let entered = () => {};
  let reviews = 0;
  const reviewing = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(f.providers.gateway, 'complete').mockImplementation(async function* (request, signal, beforeSend) {
    if (request.role !== 'background') { yield* complete(request, signal, beforeSend); return; }
    if (signal === undefined) throw new Error('missing verifier signal');
    beforeSend?.();
    reviews += 1;
    entered();
    await new Promise<void>(resolve => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    signal.throwIfAborted();
  });
  f.controller.attach();
  await when(f.controller, snapshot => snapshot.goals.length === 1);
  const unsubscribe = f.controller.subscribe(() => { if (f.controller.snapshot().pending !== null) f.controller.answer({ action: 'approve' }); });
  const id = 'g_7QK4M2N8RZ';
  const scope = { mode: 'doc', docIds: [node.id] } as const;
  const work = f.controller.startGoal({ ...passedGoal(), id, checks: [{ kind: 'synopsis.filled', scope }, { kind: 'verifier', scope, rubric: 'The departure is clear.', gate: true }] });
  try {
    await Promise.race([reviewing, work]);
    expect(reviews).toBe(1);
    f.controller.stop();
    await work;
    const row = await readGoalRun(f.store, id);
    expect(row?.result).toMatchObject({ status: 'cancelled' });
    expect(row?.checkpoint).toMatchObject({ verification: { status: 'unavailable', code: 'stopped' }, spend: { modelCalls: 2 } });
    expect((row!.checkpoint as GoalCheckpoint).spend.estimatedTokens).toBeGreaterThan(0);
    expect(f.providers.gateway.ledger.turnRows()).toHaveLength(1);
    expect(reviews).toBe(1);
  } finally {
    f.controller.stop();
    await work;
    unsubscribe();
  }
});

it('offers a Findings goal draft without starting it or borrowing an approval', async () => {
  const f = await fixture();
  const scope = { mode: 'doc' as const, docIds: [f.session.state.manifest.tree.find((node) => node.type === 'document')!.id] };
  f.controller.offerGoal({ intent: 'Fix the findings in this scope.', scope, coherenceChecks: ['timeline.order-drift'] });
  const draft = f.controller.snapshot().goalDraft;
  expect(draft).toMatchObject({ intent: 'Fix the findings in this scope.', scope, coherenceChecks: ['timeline.order-drift'] });
  expect(f.controller.snapshot()).toMatchObject({ busy: false, activeGoalId: null });
  expect(f.providers.gateway.ledger.turnRows()).toEqual([]);
  expect(await readGoalRun(f.store, GOAL)).toMatchObject({ status: 'running' });
  scope.docIds.length = 0;
  expect(draft?.scope).toMatchObject({ docIds: [expect.any(String)] });
  f.controller.clearGoalDraft(draft!.id + 1);
  expect(f.controller.snapshot().goalDraft).toBe(draft);
  f.controller.clearGoalDraft(draft!.id);
  expect(f.controller.snapshot().goalDraft).toBeNull();
});

it('publishes the owned running checkpoint while its ordinary approval card waits', async () => {
  const f = await fixture(true, { steps: [{ tool: 'synopsis.fill', params: { docs: ['The Storm'], source: 'text', max_words: 30 }, expect: 'The storm has a synopsis.' }] });
  f.controller.attach();
  f.controller.setMode('ask');
  await when(f.controller, (snapshot) => snapshot.goals.length === 1);
  const id = 'g_7QK4M2N8RZ';
  const work = f.controller.startGoal({ ...passedGoal(), id, checks: [{ kind: 'status.all', scope: { mode: 'full' }, status: 'final' }] });
  try {
    await Promise.race([when(f.controller, (snapshot) => snapshot.pending !== null || snapshot.offer !== null), work]);
    expect(f.controller.snapshot().pending ?? f.controller.snapshot().offer).not.toBeNull();
    expect(f.controller.snapshot()).toMatchObject({ activeGoalId: id });
    expect(f.controller.snapshot().goals.find((goal) => goal.goalId === id)).toMatchObject({ status: 'running', watch: { checks: [{ kind: 'status.all', pass: false }] } });
  } finally {
    f.controller.stop();
    await work;
  }
});

it('passes the current coherence settings to each explicitly started goal', async () => {
  let enabled: readonly DeterministicCheckId[] = [];
  const f = await fixture(false, undefined, () => enabled);
  const checks = [{ kind: 'coherence.clean' as const, scope: { mode: 'full' as const }, checks: ['timeline.order-drift' as const] }];
  const first = 'g_7QK4M2N8RZ';
  await f.controller.startGoal({ ...passedGoal(), id: first, checks });
  expect((await readGoalRun(f.store, first))?.result).toMatchObject({ status: 'failed', reason: expect.stringContaining('turned off in Settings') });
  enabled = ['timeline.order-drift'];
  const second = 'g_7QK4M2N8RX';
  await f.controller.startGoal({ ...passedGoal(), id: second, checks });
  expect((await readGoalRun(f.store, second))?.result?.status).toBe('passed');
  expect(f.providers.gateway.ledger.turnRows()).toEqual([]);
});

it('requires explicit approval for a large coherence scope and retains it in the final checkpoint', async () => {
  const f = await fixture(false, undefined, () => ['timeline.order-drift'], 20);
  const goal = { ...passedGoal(), id: 'g_7QK4M2N8RZ', checks: [{ kind: 'coherence.clean' as const, scope: { mode: 'full' as const }, checks: ['timeline.order-drift' as const] }] };
  await f.controller.startGoal(goal);
  expect((await readGoalRun(f.store, goal.id))?.result?.status).toBe('refused');
  const approved = { ...goal, id: 'g_7QK4M2N8RX' };
  await f.controller.startGoal(approved, { approvedLargeScope: true });
  const row = await readGoalRun(f.store, approved.id);
  expect(row?.result?.status).toBe('passed');
  expect(row?.checkpoint).toMatchObject({ approvedLargeScope: true, results: [{ pass: true }] });
  expect(f.providers.gateway.ledger.turnRows()).toEqual([]);
});

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

it.each(['start', 'resume'] as const)('allows Stop as soon as goal %s claims the controller', async (action) => {
  const f = await fixture();
  await f.controller.loadGoals();
  await f.controller.resumeGoal('g_0000000000');
  expect(f.controller.snapshot().message).not.toBeNull();
  const id = action === 'start' ? 'g_7QK4M2N8RZ' : GOAL;
  const work = action === 'start' ? f.controller.startGoal({ ...passedGoal(), id }) : f.controller.resumeGoal(id);
  const stoppable = f.controller.snapshot().stoppable;
  const message = f.controller.snapshot().message;
  f.controller.stop();
  await work;
  expect(stoppable).toBe(true);
  expect(message).toBeNull();
  expect(f.controller.snapshot()).toMatchObject({ busy: false, stoppable: false });
  expect((await readGoalRun(f.store, id))?.status).toBe(action === 'start' ? undefined : 'interrupted');
  expect(f.controller.snapshot().turns).toEqual([]);
});

it.each(['start', 'resume'] as const)('cancels goal %s while harness setup is pending without a paid turn', async (action) => {
  const f = await fixture();
  await f.controller.loadGoals();
  let entered = () => {};
  let release = () => {};
  const setupEntered = new Promise<void>((resolve) => { entered = resolve; });
  const setupReleased = new Promise<void>((resolve) => { release = resolve; });
  const ready = f.session.harnessReady.bind(f.session);
  vi.spyOn(f.session, 'harnessReady').mockImplementationOnce(async () => {
    entered();
    await setupReleased;
    return ready();
  });
  const id = action === 'start' ? 'g_7QK4M2N8RZ' : GOAL;
  const work = action === 'start' ? f.controller.startGoal({ ...passedGoal(), id }) : f.controller.resumeGoal(id);
  let stoppable = false;
  try {
    await setupEntered;
    stoppable = f.controller.snapshot().stoppable;
    f.controller.stop();
  } finally {
    release();
    await work;
  }
  expect(stoppable).toBe(true);
  expect(await readGoalRun(f.store, id)).toMatchObject({ status: 'settled', result: { status: 'cancelled' } });
  expect(f.controller.snapshot()).toMatchObject({ busy: false, stoppable: false });
  expect(f.controller.snapshot().turns).toEqual([]);
  expect(f.providers.gateway.ledger.turnRows()).toEqual([]);
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

it.each([
  { limits: { maxTokens: 1_000_000 }, field: 'promptTokens', limit: 1_000_000 },
  { limits: { maxCostUsd: 10 }, field: 'costUsd', limit: 10 },
  { limits: { maxActiveMs: 1_000_000 }, field: 'activeMs', limit: 1_000_000 },
] as const)('treats unresolved model usage as spent for $field before resuming', async ({ limits, field, limit }) => {
  const f = await fixture(true);
  const goal = { ...passedGoal(), checks: [{ kind: 'status.all' as const, status: 'final', scope: { mode: 'full' as const } }], limits };
  const spend = { modelCalls: 0, promptTokens: 0, completionTokens: 0, estimatedTokens: 0, steps: 0, activeMs: 0 };
  await appendGoalCheckpoint(f.store, GOAL, { checkpoint: { goal, iterations: [], results: [], nextIteration: 1, spend }, at: 200 });
  const port = createRunLogPort(f.store);
  await port.create({ schema: 3, runId: 'unresolved-model', projectId: f.session.projectId, kind: 'turn', intent: goal.intent, createdAt: 200, updatedAt: 200, status: 'interrupted' });
  await port.append('unresolved-model', [
    { t: 'turn.start', v: 3, turnId: 'unresolved-turn', intent: goal.intent, wire: 'planner', native: false, seq: 0, at: 200 },
    { t: 'spend', turnId: 'unresolved-turn', spend, reservedCalls: 1, seq: 1, at: 201 },
  ]);
  await recordGoalIteration(f.store, GOAL, 'unresolved-model', 200);
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot.goals.length === 1);
  const offered = f.controller.snapshot().goals[0];
  await f.controller.resumeGoal(GOAL);
  const saved = await readGoalRun(f.store, GOAL);
  expect(saved?.result?.status).toBe('budget');
  expect((saved?.checkpoint as GoalCheckpoint).spend[field]).toBeGreaterThanOrEqual(limit);
  expect(f.controller.snapshot().turns).toEqual([]);
  expect(f.providers.gateway.ledger.turnRows()).toEqual([]);
  expect(offered).toMatchObject({ note: expect.stringContaining('treated as spent') });
});

it('does not mark running goals interrupted when Web Locks are missing', async () => {
  const f = await fixture();
  vi.stubGlobal('navigator', {});
  await f.controller.loadGoals();
  expect((await readGoalRun(f.store, GOAL))?.status).toBe('running');
  expect(f.controller.snapshot()).toMatchObject({ goalUnavailable: expect.stringContaining('Web Locks') });
});

it('settles recovery as failed when conservative spend cannot be persisted', async () => {
  const f = await fixture();
  const checkpoint = (await readGoalRun(f.store, GOAL))!.checkpoint as GoalCheckpoint;
  const port = createRunLogPort(f.store);
  await port.create({ schema: 3, runId: 'pending-budget-save', projectId: f.session.projectId, kind: 'turn', intent: checkpoint.goal.intent, createdAt: 200, updatedAt: 200, status: 'interrupted' });
  await port.append('pending-budget-save', [
    { t: 'turn.start', v: 3, turnId: 'pending-turn', intent: checkpoint.goal.intent, wire: 'planner', native: false, seq: 0, at: 200 },
    { t: 'spend', turnId: 'pending-turn', spend: checkpoint.spend, reservedCalls: 1, seq: 1, at: 201 },
  ]);
  await recordGoalIteration(f.store, GOAL, 'pending-budget-save', 200);
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot.goals.length === 1);
  const transaction = f.store.db.transaction.bind(f.store.db);
  vi.spyOn(f.store.db, 'transaction').mockImplementation((names, mode, options) => {
    const stores = typeof names === 'string' ? [names] : [...names];
    if (mode === 'readwrite' && stores.includes('goalRuns') && stores.includes('runs')) throw new Error('Conservative checkpoint refused.');
    return transaction(names, mode, options);
  });
  await f.controller.resumeGoal(GOAL);
  expect(await readGoalRun(f.store, GOAL)).toMatchObject({ status: 'settled', result: { status: 'failed', reason: 'Conservative checkpoint refused.' } });
  expect(f.controller.snapshot().turns).toEqual([]);
  expect(f.providers.gateway.ledger.turnRows()).toEqual([]);
});

it('keeps goals discardable when their conversations cannot be read', async () => {
  const f = await fixture();
  await f.controller.loadGoals();
  const transaction = f.store.db.transaction.bind(f.store.db);
  const failure = vi.spyOn(f.store.db, 'transaction').mockImplementation((names, mode, options) => {
    const stores = typeof names === 'string' ? [names] : [...names];
    if (mode === 'readonly' && stores.includes('agentSessions')) throw new Error('Conversation read refused.');
    return transaction(names, mode, options);
  });
  await f.controller.loadGoals();
  expect(f.controller.snapshot().goals).toHaveLength(1);
  expect(f.controller.snapshot().goals[0]).toMatchObject({ resumable: false, note: expect.stringContaining('conversation') });
  failure.mockRestore();
  await f.controller.discardGoal(GOAL);
  expect(await readGoalRun(f.store, GOAL)).toBeUndefined();
});

it('refuses goal Start and Resume without Web Locks while ordinary turns and Discard still work', async () => {
  const f = await fixture(true);
  await markGoalsInterrupted(f.store, f.session.projectId, 300);
  vi.stubGlobal('navigator', {});
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot.goals.length === 1);
  const id = 'g_7QK4M2N8RZ';
  await f.controller.startGoal({ ...passedGoal(), id });
  expect(await readGoalRun(f.store, id)).toBeUndefined();
  await f.controller.resumeGoal(GOAL);
  expect((await readGoalRun(f.store, GOAL))?.status).toBe('interrupted');
  expect(f.controller.snapshot().message).toContain('Web Locks');
  expect(f.controller.snapshot().turns).toEqual([]);
  await f.controller.submit('Explain the next scene.');
  expect(f.controller.snapshot().turns).toHaveLength(1);
  await f.controller.discardGoal(GOAL);
  expect(await readGoalRun(f.store, GOAL)).toBeUndefined();
});

it('makes a goal discard-only when its owning conversation is deleted', async () => {
  const f = await fixture();
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot.goals.length === 1);
  await f.controller.deleteSession(f.controller.snapshot().sessionId);
  expect(f.controller.snapshot().goals[0]).toMatchObject({ resumable: false, note: expect.stringContaining('conversation') });
  await f.controller.discardGoal(GOAL);
  expect(await readGoalRun(f.store, GOAL)).toBeUndefined();
});

it('refuses Resume when the currently selected owning conversation is no longer stored', async () => {
  const f = await fixture();
  await markGoalsInterrupted(f.store, f.session.projectId, 300);
  await removeAgentSession(f.store, f.session.projectId, f.controller.snapshot().sessionId);
  await f.controller.loadGoals();
  expect(f.controller.snapshot().goals[0]).toMatchObject({ resumable: false });
  await f.controller.resumeGoal(GOAL);
  expect((await readGoalRun(f.store, GOAL))?.status).toBe('interrupted');
  expect(f.controller.snapshot().turns).toEqual([]);
});

it.each(['current', 'stale'] as const)('does not offer or resume a goal-owned iteration through a %s independent-turn view', async (view) => {
  const f = await fixture(true);
  const checkpoint = (await readGoalRun(f.store, GOAL))!.checkpoint as GoalCheckpoint;
  await appendGoalCheckpoint(f.store, GOAL, { checkpoint: { ...checkpoint, goal: { ...checkpoint.goal, limits: { maxModelCalls: 0 } } }, at: 200 });
  const port = createRunLogPort(f.store);
  await port.create({ schema: 3, runId: 'goal-owned-turn', projectId: f.session.projectId, kind: 'turn', intent: 'An iteration of the goal.', createdAt: 200, updatedAt: 200, status: 'interrupted' });
  await port.append('goal-owned-turn', [
    { t: 'turn.start', v: 3, turnId: 'owned-turn', intent: 'An iteration of the goal.', wire: 'planner', native: false, seq: 0, at: 200 },
    { t: 'skills.loaded', turnId: 'owned-turn', skills: [], seq: 1, at: 201 },
    { t: 'messages', turnId: 'owned-turn', appended: [{ role: 'user', content: 'An iteration of the goal.' }], seq: 2, at: 202 },
  ]);
  if (view === 'current') await recordGoalIteration(f.store, GOAL, 'goal-owned-turn', 200);
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot.goals.length === 1);
  if (view === 'stale') {
    await resumeGoalRun(f.store, GOAL, 300);
    await recordGoalIteration(f.store, GOAL, 'goal-owned-turn', 300);
    await markGoalsInterrupted(f.store, f.session.projectId, 400);
  }
  expect(await f.controller.resumeRun('goal-owned-turn')).toBeNull();
  await f.controller.loadInterrupted();
  expect(f.controller.snapshot().interrupted.some((run) => run.runId === 'goal-owned-turn')).toBe(false);
  expect(f.controller.snapshot().runHistory.find((run) => run.runId === 'goal-owned-turn')).toMatchObject({ resumable: false });
  expect(f.providers.gateway.ledger.turnRows()).toEqual([]);
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
  expect(f.controller.snapshot().goals[0]).toMatchObject({ resumable: false, note: expect.stringContaining('server may already have acted') });
  await f.controller.resumeGoal(GOAL);
  expect((await readGoalRun(f.store, GOAL))?.status).toBe('interrupted');
  expect(f.controller.snapshot().message).toContain('server may already have acted');
  expect(f.controller.snapshot().turns).toEqual([]);
});

it('keeps a goal discard-only after an unfinished iteration completed an MCP action', async () => {
  const f = await fixture();
  const port = createRunLogPort(f.store);
  await port.create({ schema: 3, runId: 'completed-mcp', projectId: f.session.projectId, kind: 'turn', intent: 'Send the scene.', createdAt: 200, updatedAt: 202, status: 'interrupted' });
  await port.append('completed-mcp', [
    { t: 'turn.start', v: 3, turnId: 'external-turn', intent: 'Send the scene.', wire: 'planner', native: false, seq: 0, at: 200 },
    { t: 'step.intent', turnId: 'external-turn', callId: 'external-write', index: 0, tool: 'mcp__test__write', expect: {}, structure: 'unchanged', seq: 1, at: 201 },
    { t: 'step.applied', turnId: 'external-turn', callId: 'external-write', index: 0, tool: 'mcp__test__write', after: {}, seq: 2, at: 202 },
  ]);
  await recordGoalIteration(f.store, GOAL, 'completed-mcp', 202);
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot.goals.length === 1);
  const offered = f.controller.snapshot().goals[0];
  await f.controller.resumeGoal(GOAL);
  expect((await readGoalRun(f.store, GOAL))?.status).toBe('interrupted');
  expect(offered).toMatchObject({ resumable: false, note: expect.stringContaining('MCP action') });
  expect(f.controller.snapshot().turns).toEqual([]);
});

it('keeps a goal discard-only when its linked iteration has no readable log', async () => {
  const f = await fixture();
  const port = createRunLogPort(f.store);
  await port.create({ schema: 3, runId: 'empty-iteration', projectId: f.session.projectId, kind: 'turn', intent: 'Missing events.', createdAt: 200, updatedAt: 200, status: 'interrupted' });
  await recordGoalIteration(f.store, GOAL, 'empty-iteration', 200);
  await f.controller.loadGoals();
  expect(f.controller.snapshot().goals[0]).toMatchObject({ resumable: false, note: expect.any(String) });
});

it('persists the closing coherence scan when a goal passes without an iteration', async () => {
  const f = await fixture();
  const save = vi.fn(async () => undefined);
  f.session.attachCoherence({ file: emptyCoherenceFile(), writable: true, notices: [] }, { save, attachFolder: async () => undefined });
  await f.controller.startGoal({ ...passedGoal(), id: 'g_7QK4M2N8RZ', checks: [{ kind: 'coherence.clean', scope: { mode: 'full' }, checks: ['timeline.order-drift'] }] });
  await f.session.saved();
  const result = (await readGoalRun(f.store, 'g_7QK4M2N8RZ'))?.result;
  expect(result, result?.reason).toMatchObject({ status: 'passed' });
  expect(f.controller.snapshot().turns).toEqual([]);
  expect(save).toHaveBeenCalled();
  expect(f.session.coherenceFile()?.runs.length).toBeGreaterThan(0);
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

it.each(['start', 'resume', 'discard'] as const)('drains queued messages after a goal %s releases the controller', async (action) => {
  const f = await fixture(true);
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot.goals.length === 1);
  let queued = false;
  const unsubscribe = f.controller.subscribe(() => {
    if (queued || f.controller.snapshot().goalAction === null) return;
    queued = true;
    f.controller.enqueue('Explain the next scene.');
  });
  try {
    if (action === 'start') await f.controller.startGoal({ ...passedGoal(), id: 'g_7QK4M2N8RZ' });
    else if (action === 'resume') await f.controller.resumeGoal(GOAL);
    else await f.controller.discardGoal(GOAL);
    expect(queued).toBe(true);
    await vi.waitFor(() => expect(f.controller.snapshot().queue).toHaveLength(0));
    await when(f.controller, (snapshot) => !snapshot.busy && snapshot.turns.length === 1);
    expect(f.controller.snapshot().turns[0]?.intent).toBe('Explain the next scene.');
  } finally {
    unsubscribe();
  }
});

it('settles a resumed goal when harness setup fails instead of leaving it running', async () => {
  const f = await fixture();
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot.goals.length === 1);
  vi.spyOn(f.session, 'harnessReady').mockRejectedValueOnce(new Error('The harness could not load.'));
  await f.controller.resumeGoal(GOAL);
  expect(await readGoalRun(f.store, GOAL)).toMatchObject({ status: 'settled', result: { status: 'failed', reason: 'The harness could not load.' } });
  expect(f.controller.snapshot()).toMatchObject({ busy: false, goalAction: null });
  expect(f.controller.snapshot().message).toContain('The harness could not load.');
  expect(f.controller.snapshot().turns).toEqual([]);
  expect(f.providers.gateway.ledger.turnRows()).toEqual([]);
});

it('retries a transient interruption-mark failure on the next recovery load', async () => {
  const f = await fixture();
  const transaction = f.store.db.transaction.bind(f.store.db);
  const failed = vi.spyOn(f.store.db, 'transaction').mockImplementationOnce(() => { throw new Error('Storage is temporarily unavailable.'); });
  await f.controller.loadGoals();
  expect((await readGoalRun(f.store, GOAL))?.status).toBe('running');
  expect(f.controller.snapshot().goals[0]).toMatchObject({ resumable: false, note: expect.stringContaining('interruption could not be saved') });
  failed.mockImplementation(transaction);
  await f.controller.loadGoals();
  expect(f.controller.snapshot().goals[0]).toMatchObject({ status: 'interrupted', resumable: true });
});

it('does not retry interruption marking while this controller owns a goal action', async () => {
  const f = await fixture();
  vi.spyOn(f.store.db, 'transaction').mockImplementationOnce(() => { throw new Error('Storage is temporarily unavailable.'); });
  await f.controller.loadGoals();
  let entered = () => {};
  let release = () => {};
  const setupEntered = new Promise<void>((resolve) => { entered = resolve; });
  const setupReleased = new Promise<void>((resolve) => { release = resolve; });
  const ready = f.session.harnessReady.bind(f.session);
  vi.spyOn(f.session, 'harnessReady').mockImplementationOnce(async () => {
    entered();
    await setupReleased;
    return ready();
  });
  const id = 'g_7QK4M2N8RZ';
  const starting = f.controller.startGoal({ ...passedGoal(), id });
  try {
    await setupEntered;
    await f.controller.loadGoals();
    expect((await readGoalRun(f.store, id))?.status).toBe('running');
  } finally {
    release();
    await starting;
  }
  expect((await readGoalRun(f.store, GOAL))?.status).toBe('interrupted');
});

it('keeps a malformed goal row available for Discard without breaking the recovery list', async () => {
  const f = await fixture();
  const row = await readGoalRun(f.store, GOAL);
  const { iterationRunIds: _removed, ...damaged } = row!;
  await new Promise<void>((resolve, reject) => {
    const tx = f.store.db.transaction('goalRuns', 'readwrite');
    tx.objectStore('goalRuns').put(damaged);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  await f.controller.loadGoals();
  expect(f.controller.snapshot().goals[0]).toMatchObject({ goalId: GOAL, unreadable: true, resumable: false, turns: 0 });
  await f.controller.discardGoal(GOAL);
  expect(await readGoalRun(f.store, GOAL)).toBeUndefined();
});

it.each(['start', 'resume'] as const)('refuses an out-of-scope goal %s write before any approval or project mutation', async (action) => {
  const f = await fixture(true, { steps: [{ tool: 'meta.set', params: { targets: ['The Friend'], status: 'final' }, expect: 'The friend is final.' }] });
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot.goals.length === 1);
  const allowed = f.session.state.manifest.tree.find((node) => node.title === 'The Storm')!;
  const target = f.session.state.manifest.tree.find((node) => node.title === 'The Friend')!;
  const before = structuredClone(target);
  let approvals = 0;
  const unsubscribe = f.controller.subscribe(() => {
    if (f.controller.snapshot().pending === null) return;
    approvals += 1;
    f.controller.answer({ action: 'approve' });
  });
  try {
    const goal = { ...passedGoal(), id: action === 'resume' ? GOAL : 'g_7QK4M2N8RZ', maxIterations: 1,
      checks: [{ kind: 'status.all', status: 'final', scope: { mode: 'full' } }],
      writeScope: { mode: 'doc', docIds: [allowed.id] },
    } as const;
    if (action === 'start') await f.controller.startGoal(goal);
    else {
      const checkpoint = (await readGoalRun(f.store, GOAL))!.checkpoint as GoalCheckpoint;
      await appendGoalCheckpoint(f.store, GOAL, { checkpoint: { ...checkpoint, goal, nextIteration: 1 }, at: 300 });
      await markGoalsInterrupted(f.store, f.session.projectId, 400);
      await f.controller.resumeGoal(GOAL);
    }
    expect(f.session.state.manifest.tree.find((node) => node.id === target.id)).toEqual(before);
    expect(approvals).toBe(0);
    expect(f.session.harness.ruleCheck('meta.set', { targets: [target.id], status: 'final' }).denied).toBeUndefined();
    const ordinary = await f.controller.submit('Mark the friend as final.');
    expect(ordinary?.status).toBe('applied');
    expect(f.session.state.manifest.tree.find((node) => node.id === target.id)?.status).toBe('final');
  } finally {
    unsubscribe();
  }
});
