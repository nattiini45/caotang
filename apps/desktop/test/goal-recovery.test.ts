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
import { appendGoalCheckpoint, createGoalRun, openRuntimeStore, readGoalRun, MemoryIndexedDb, type GoalCheckpoint } from '@caotang/store';

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

async function fixture() {
  const state = sampleProjectState();
  for (const node of state.manifest.tree) if (node.type === 'document') node.synopsis = 'Already written.';
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const profile = await profiles.create({ name: 'Mock', kind: 'mock', isActive: true });
  const providers = {
    gateway: createGateway({ profiles, keys, clock: createManualClock(0), mock: createMockProvider({ scripts: [] }) }),
    active: () => profile,
    persist: async () => undefined,
  } as unknown as ProviderService;
  let controller: AgentController;
  controller = new AgentController(session, providers, () => ({}), () => false, {
    store: new TaskStore(memoryDb()),
    locksAvailable: () => false,
    sleep: () => when(controller, (snapshot) => !snapshot.busy),
  });
  sessions.push({ session, controller });
  const goal = passedGoal();
  const checkpoint: GoalCheckpoint = { goal, iterations: [], results: [], nextIteration: 1, spend: { modelCalls: 0, promptTokens: 0, completionTokens: 0, estimatedTokens: 0, steps: 0, activeMs: 0 } };
  await createGoalRun(store, { goalId: GOAL, projectId: session.projectId, sessionId: 'conversation', checkpoint, at: 100 });
  await appendGoalCheckpoint(store, GOAL, { checkpoint: { ...checkpoint, nextIteration: 2 }, at: 200 });
  return { session, controller, store };
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

  await f.controller.resumeGoal(GOAL);
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