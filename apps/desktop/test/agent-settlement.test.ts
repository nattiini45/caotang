import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore } from '@caotang/gateway';
import { createMockProvider, isPlannerCall, type MockScript } from '@caotang/gateway/mock';
import { addDocument, MemoryIndexedDb, openRuntimeStore } from '@caotang/store';
import type { PlanStep } from '@caotang/harness';

import { AgentController } from '../src/app/agent.js';
import { ProjectSession } from '../src/app/session.js';
import type { ProviderService } from '../src/app/providers.js';
import { sampleProjectState } from '../src/app/demo.js';
import type * as LazyHarness from '../src/app/lazy-harness.js';

const clock = vi.hoisted(() => ({ current: null as ReturnType<typeof createManualClock> | null }));

vi.mock('../src/app/lazy-harness.js', async (importOriginal) => {
  const actual = await importOriginal<typeof LazyHarness>();
  return {
    ...actual,
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
  const profiles = createProfileStore({ keys });
  const profile = await profiles.create({ name: 'Mock', kind: 'mock', isActive: true });
  const providers = {
    gateway: createGateway({ profiles, keys, clock: createManualClock(0), mock: createMockProvider({ scripts: [...scripts] }) }),
    active: () => profile,
    persist: async () => undefined,
  } as unknown as ProviderService;
  const controller = new AgentController(session, providers);
  const target = state.manifest.tree.find((node) => node.title === 'The Storm')!.id;
  const steps: PlanStep[] = [{ tool: 'meta.set', params: { targets: [target], keywords_add: ['storm'] }, expect: 'The Storm is tagged' }];
  return { session, providers, controller, steps, target };
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
