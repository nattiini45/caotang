import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore } from '@caotang/gateway';
import { createMockProvider, isPlannerCall, type MockScript } from '@caotang/gateway/mock';
import { addDocument, MemoryIndexedDb, openRuntimeStore } from '@caotang/store';
import { createTraceStore, type PlanStep } from '@caotang/harness';

import { AgentController } from '../src/app/agent.js';
import { ProjectSession } from '../src/app/session.js';
import type { ProviderService } from '../src/app/providers.js';
import { sampleProjectState } from '../src/app/demo.js';
import type * as LazyHarness from '../src/app/lazy-harness.js';

const clock = vi.hoisted(() => ({ current: null as ReturnType<typeof createManualClock> | null, beforeSubmit: null as (() => Promise<void>) | null }));

vi.mock('../src/app/lazy-harness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof LazyHarness>();
  return {
    ...actual,
    createAgentSession: (...args: Parameters<typeof actual.createAgentSession>) => {
      const session = actual.createAgentSession(...args);
      return {
        ...session,
        submitPlan: async (...args: Parameters<typeof session.submitPlan>) => {
          await clock.beforeSubmit?.();
          return session.submitPlan(...args);
        },
      };
    },
    createBudgetMeter: (limits: Parameters<typeof actual.createBudgetMeter>[0], options: Parameters<typeof actual.createBudgetMeter>[1]) =>
      actual.createBudgetMeter(clock.current === null ? limits : { ...limits, deadline: clock.current.now() + 60_000 }, {
        ...options,
        ...(clock.current === null ? {} : { clock: clock.current }),
      }),
  };
});

beforeEach(() => {
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
  clock.current = null;
  clock.beforeSubmit = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(scripts: readonly MockScript[] = []) {
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  const keys = createKeyStore(createMemoryVaultPort());
  const traceClock = createManualClock(0);
  const profiles = createProfileStore({ keys });
  const profile = await profiles.create({ name: 'Mock', kind: 'mock', isActive: true });
  const providers = {
    gateway: createGateway({ profiles, keys, clock: traceClock, mock: createMockProvider({ scripts: [...scripts] }) }),
    now: () => { const at = traceClock.now(); traceClock.advance(1); return at; },
    active: () => profile,
    persist: async () => undefined,
  } as unknown as ProviderService;
  const controller = new AgentController(session, providers);
  const target = state.manifest.tree.find((node) => node.title === 'The Storm')!.id;
  const steps: PlanStep[] = [{ tool: 'meta.set', params: { targets: [target], keywords_add: ['storm'] }, expect: 'The Storm is tagged' }];
  return { session, providers, controller, steps, target, traceClock };
}

function when(controller: AgentController, ready: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (ready()) {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = controller.subscribe(check);
    check();
  });
}

const cardShown = (controller: AgentController) => when(controller, () => controller.snapshot().pending !== null);

it('publishes loading and stopping before a lazy turn starts, then returns to idle', async () => {
  const f = await fixture();
  const held = deferred();
  const ready = f.session.harnessReady.bind(f.session);
  vi.spyOn(f.session, 'harnessReady').mockImplementationOnce(async () => { await held.promise; return ready(); });
  try {
    const running = f.controller.submitPlan('Tag the storm.', { steps: f.steps });
    expect(f.controller.snapshot()).toMatchObject({ phase: 'starting', busy: true, stoppable: true });
    f.controller.stop();
    expect(f.controller.snapshot().phase).toBe('stopping');
    held.resolve();
    expect((await running)?.status).toBe('cancelled');
    expect(f.controller.snapshot()).toMatchObject({ phase: 'idle', busy: false, stoppable: false });
  } finally {
    held.resolve();
    await f.session.close();
  }
});

it('exports the controller phases through idle before the final turn-end record', async () => {
  const f = await fixture();
  const trace = createTraceStore({ sessionId: 'controller' });
  Object.assign(f.providers, { trace: { sink: () => trace } });
  clock.beforeSubmit = async () => { f.traceClock.advance(100); };
  try {
    const shown = cardShown(f.controller);
    const running = f.controller.submitPlan('Tag the storm.', { steps: f.steps }, { forcePlan: true });
    await shown;
    expect(f.controller.snapshot().phase).toBe('parked-on-card');
    f.controller.answer({ action: 'approve' });
    expect(f.controller.snapshot().phase).toBe('approving');
    await running;
    const rows = trace.records().filter((record) => record.kind === 'machine' && record.machine === 'agent.controller');
    expect(rows.map((row) => row.to)).toEqual(expect.arrayContaining(['starting', 'running', 'parked-on-card', 'approving', 'idle']));
    expect(rows.at(-1)).toMatchObject({ event: 'finish', to: 'idle' });
    expect(trace.records()[0]).toMatchObject({ kind: 'turn.start', at: 0 });
    expect(trace.records().at(-1)?.kind).toBe('turn.end');
    const times = trace.records().filter((record) => record.kind !== 'message').map((record) => record.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  } finally {
    await f.session.close();
  }
});

it.each(['turn', 'finish', 'turn.end'] as const)('keeps both turns settled when a trace subscriber throws on %s', async (fault) => {
  const f = await fixture();
  const trace = createTraceStore({ sessionId: 'throwing-controller' });
  Object.assign(f.providers, { trace: { sink: () => trace } });
  let failures = 0;
  trace.subscribe(() => {
    const record = trace.records().at(-1);
    if ((record?.kind === 'machine' && record.machine === 'agent.controller' && record.event === fault)
      || (fault === 'turn.end' && record?.kind === 'turn.end')) {
      failures += 1;
      throw new Error('The trace subscriber failed.');
    }
  });
  try {
    for (let turn = 0; turn < 2; turn += 1) {
      expect((await f.controller.submitPlan('Tag the storm.', { steps: f.steps }, { mode: 'accept-edits' }))?.status).toBe('applied');
      expect(f.controller.snapshot()).toMatchObject({ phase: 'idle', busy: false, stoppable: false });
    }
    expect(failures).toBeGreaterThanOrEqual(2);
    expect(trace.records().at(-1)?.kind).toBe('turn.end');
  } finally {
    await f.session.close();
  }
});

it('retires the approval and Stop controls when the deadline ends a parked turn', async () => {
  clock.current = createManualClock(1_000_000);
  const f = await fixture();
  try {
    const shown = cardShown(f.controller);
    const running = f.controller.submitPlan('Tag the storm.', { steps: f.steps }, { forcePlan: true });
    await shown;
    clock.current.advance(60_000);
    expect((await running)?.budgetStop?.dimension).toBe('deadline');
    expect(f.controller.snapshot().pending).toBeNull();
    expect(f.controller.snapshot().stoppable).toBe(false);
    expect(f.controller.snapshot().busy).toBe(false);
    expect(f.controller.snapshot().offer).toBeNull();
    f.controller.answer({ action: 'approve' });
    expect(f.session.state.manifest.tree.find((node) => node.id === f.target)?.keywords ?? []).not.toContain('storm');
  } finally {
    await f.session.close();
  }
});

it.each(['missing provider', 'failed harness'] as const)('keeps a held plan retryable and its mode unchanged after a %s', async (failure) => {
  const f = await fixture();
  try {
    f.controller.setMode('plan-only');
    const held = await f.controller.submitPlan('Tag the storm.', { steps: f.steps });
    expect(held?.heldSteps).toHaveLength(1);
    const turnId = f.controller.snapshot().turns[0]!.turnId;
    const unavailable = failure === 'missing provider'
      ? vi.spyOn(f.providers, 'active').mockReturnValue(undefined)
      : vi.spyOn(f.session, 'harnessReady').mockRejectedValueOnce(new Error('Harness unavailable.'));
    expect(await f.controller.runHeldPlan(turnId)).toBeNull();
    expect(f.controller.snapshot().mode).toBe('plan-only');
    expect(f.controller.snapshot().heldRun).not.toContain(turnId);
    unavailable.mockRestore();
    const running = f.controller.runHeldPlan(turnId);
    expect((await running)?.status).toBe('applied');
    expect(f.controller.snapshot().mode).toBe('ask');
    expect(f.controller.snapshot().heldRun).toContain(turnId);
  } finally {
    f.controller.stop();
    await f.session.close();
  }
});

it('retires a background offer when its turn reaches the deadline', async () => {
  clock.current = createManualClock(1_000_000);
  const steps = [{ tool: 'synopsis.fill', params: { docs: ['The Landing', 'The Storm', 'The Friend', 'Scene 4', 'Scene 5'], source: 'text', max_words: 20 }, expect: 'Five synopses' }];
  const f = await fixture([{ match: isPlannerCall, respond: () => ({ content: JSON.stringify({ steps }) }) }]);
  try {
    for (const title of ['Scene 4', 'Scene 5']) {
      addDocument(f.session.state, { parentId: 'manuscript', title, body: `${title} text.`, now: new Date() });
    }
    const offered = when(f.controller, () => f.controller.snapshot().offer !== null);
    const running = f.controller.submit('Summarise the scenes.');
    await offered;
    clock.current.advance(60_000);
    expect((await running)?.budgetStop?.dimension).toBe('deadline');
    expect(f.controller.snapshot().offer).toBeNull();
    expect(f.controller.snapshot().pending).toBeNull();
    expect(f.controller.snapshot().stoppable).toBe(false);
  } finally {
    f.controller.stop();
    await f.session.close();
  }
});

it('publishes Ask when the held turn starts, before its first harness event', async () => {
  const f = await fixture();
  const starting = deferred();
  const release = deferred();
  try {
    f.controller.setMode('plan-only');
    await f.controller.submitPlan('Tag the storm.', { steps: f.steps });
    const turnId = f.controller.snapshot().turns[0]!.turnId;
    clock.beforeSubmit = async () => {
      starting.resolve();
      await release.promise;
    };
    const running = f.controller.runHeldPlan(turnId);
    await starting.promise;
    expect(f.controller.mode()).toBe('ask');
    expect(f.controller.snapshot().mode).toBe('ask');
    release.resolve();
    expect((await running)?.status).toBe('applied');
  } finally {
    release.resolve();
    f.controller.stop();
    await f.session.close();
  }
});

it.each([false, true])('rolls back a failed start without overwriting a newer Ask choice (%s)', async (chooseAgain) => {
  const f = await fixture();
  const starting = deferred();
  const release = deferred();
  try {
    f.controller.setMode('plan-only');
    await f.controller.submitPlan('Tag the storm.', { steps: f.steps });
    const turnId = f.controller.snapshot().turns[0]!.turnId;
    clock.beforeSubmit = async () => {
      starting.resolve();
      await release.promise;
      throw new Error('The turn could not start.');
    };
    const running = f.controller.runHeldPlan(turnId);
    await starting.promise;
    if (chooseAgain) f.controller.setMode('ask');
    release.resolve();
    expect(await running).toBeNull();
    expect(f.controller.snapshot().heldRun).not.toContain(turnId);
    expect(f.controller.snapshot().mode).toBe(chooseAgain ? 'ask' : 'plan-only');
    expect(f.controller.snapshot().busy).toBe(false);
  } finally {
    release.resolve();
    await f.session.close();
  }
});

it('names an approval already saving typing and never reparks it after its deadline', async () => {
  clock.current = createManualClock(1_000_000);
  const f = await fixture();
  const save = deferred();
  const saving = deferred();
  try {
    const shown = cardShown(f.controller);
    const running = f.controller.submitPlan('Tag the storm.', { steps: f.steps }, { forcePlan: true });
    await shown;
    const flush = vi.spyOn(f.session.autosave, 'flush').mockImplementation(async () => {
      saving.resolve();
      await save.promise;
      throw new Error('Save failed.');
    });
    f.controller.answer({ action: 'approve' });
    await saving.promise;
    f.controller.answer({ action: 'approve' });
    expect(f.controller.snapshot().message).toBe('This approval is already saving your typing. Wait for it to finish.');
    clock.current.advance(60_000);
    await running;
    expect(f.controller.snapshot().message).toBeNull();
    save.resolve();
    await flush.mock.results[0]!.value.catch(() => undefined);
    await Promise.resolve();
    expect(f.controller.snapshot().pending).toBeNull();
    expect(f.controller.snapshot().stoppable).toBe(false);
  } finally {
    save.resolve();
    vi.restoreAllMocks();
    await f.session.close();
  }
});

it.each([true, false])('retires the wait notice but preserves a newer save failure (%s)', async (saved) => {
  const f = await fixture();
  const saving = deferred();
  const release = deferred();
  try {
    const shown = cardShown(f.controller);
    const running = f.controller.submitPlan('Tag the storm.', { steps: f.steps }, { forcePlan: true });
    await shown;
    vi.spyOn(f.session.autosave, 'flush').mockImplementation(async () => {
      saving.resolve();
      await release.promise;
      if (!saved) throw new Error('Save failed.');
      return [];
    });
    f.controller.answer({ action: 'approve' });
    await saving.promise;
    f.controller.answer({ action: 'approve' });
    expect(f.controller.snapshot().message).toBe('This approval is already saving your typing. Wait for it to finish.');
    const parked = saved ? Promise.resolve() : cardShown(f.controller);
    release.resolve();
    await parked;
    if (!saved) {
      await Promise.resolve();
      expect(f.controller.snapshot().message).toBe('Your typing could not be saved, so the card was not applied. Approve it again once your words are saved.');
      f.controller.answer({ action: 'cancel' });
    }
    await running;
    expect(f.controller.snapshot().message).toBeNull();
    expect(f.controller.snapshot().pending).toBeNull();
    expect(f.controller.snapshot().stoppable).toBe(false);
  } finally {
    release.resolve();
    f.controller.stop();
    vi.restoreAllMocks();
    await f.session.close();
  }
});

it('keeps an image-listing failure after Stop factual instead of offering approval of a retired card', async () => {
  const f = await fixture();
  const listing = deferred();
  const fail = deferred();
  try {
    vi.spyOn(f.session, 'exportsReady').mockImplementation(async () => {
      listing.resolve();
      await fail.promise;
      throw new Error('the listing failed');
    });
    const shown = cardShown(f.controller);
    const running = f.controller.submitPlan('Compile the manuscript.', { steps: [{
      tool: 'export.compile', params: { selection: { root: 'manuscript' }, format: 'md' }, expect: 'The manuscript is compiled',
    }] });
    await shown;
    f.controller.answer({ action: 'approve' });
    await listing.promise;
    f.controller.stop();
    fail.resolve();
    expect((await running)?.status).toBe('cancelled');
    expect(f.controller.snapshot().message).toBe('The project’s images could not be listed again (the listing failed). The turn was stopped, so nothing was exported.');
    expect(f.controller.snapshot().pending).toBeNull();
    expect(f.controller.snapshot().stoppable).toBe(false);
    expect(f.session.harness.log.entries().some((entry) => entry.command.startsWith('export.'))).toBe(false);
  } finally {
    fail.resolve();
    await f.session.close();
  }
});
