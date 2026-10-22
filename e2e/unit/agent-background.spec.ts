import { expect, test } from '@playwright/test';

import { addDocument, getRevision, MemoryIndexedDb, openRuntimeStore, type ProjectState } from '../../packages/store/src/index.js';
import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore } from '../../packages/gateway/src/index.js';
import { createMockProvider, isDraftCall, isPlannerCall, userTextOf, type MockScript } from '../../packages/gateway/src/mock/index.js';

import { ProjectSession } from '../../apps/desktop/src/app/session.js';
import { AgentController } from '../../apps/desktop/src/app/agent.js';
import type { AppDb } from '../../apps/desktop/src/app/app-db.js';
import type { ProviderService } from '../../apps/desktop/src/app/providers.js';
import { sampleProjectState } from '../../apps/desktop/src/app/demo.js';
import { TaskStore } from '../../apps/desktop/src/app/task-store.js';

/**
 * A big plan sent to the background through the agent controller (agent-harness §2, "Background runs"): the offer before any draft is
 * made, the queue that stages it while the controller is free, the review that applies it as one turn, and what none of that may do.
 * The loop, the queue and the project are the app's own; only the provider is scripted.
 */

const globals = globalThis as unknown as Record<string, unknown>;
let previous: { document: unknown; window: unknown } | null = null;

test.beforeAll(() => {
  previous = { document: globals['document'], window: globals['window'] };
  globals['document'] = new EventTarget();
  globals['window'] = new EventTarget();
});

test.afterAll(() => {
  if (previous === null) return;
  globals['document'] = previous.document;
  globals['window'] = previous.window;
});

const INTENT = 'Fill in the synopses of the whole act.';
const TITLES = ['The Landing', 'The Storm', 'The Friend', 'Scene 4', 'Scene 5'];

function memoryDb(): AppDb {
  const rows = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return rows.has(key) ? (structuredClone(rows.get(key)) as T) : undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      rows.set(key, structuredClone(value));
    },
    async list<T>(prefix: string) {
      return [...rows.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T }));
    },
    async delete(key: string): Promise<void> {
      rows.delete(key);
    },
    close(): void {},
  };
}

async function providersFor(scripts: readonly MockScript[]): Promise<ProviderService> {
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const profile = await profiles.create({ name: 'Scripted', kind: 'mock', isActive: true });
  const gateway = createGateway({ profiles, keys, clock: createManualClock(0), mock: createMockProvider({ scripts: [...scripts] }) });
  return { gateway, active: () => profile, demoProfile: async () => profile, persist: async () => undefined } as unknown as ProviderService;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean, label: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

/** The sample project with two more scenes, so a synopsis plan over the act needs five model calls. */
function fiveScenes(): ProjectState {
  const state = sampleProjectState();
  for (const title of ['Scene 4', 'Scene 5']) addDocument(state, { parentId: 'manuscript', title, body: `${title} text.`, now: new Date() });
  return state;
}

/** A planner that proposes the five-document synopsis, and drafts that count themselves. */
function scripts(drafts: { count: number }): MockScript[] {
  return [
    {
      match: (req) => isPlannerCall(req) && userTextOf(req).includes(`Request: ${INTENT}`),
      respond: () => ({
        content: JSON.stringify({ steps: [{ tool: 'synopsis.fill', params: { docs: TITLES, source: 'text', max_words: 20 }, expect: 'Every scene has a synopsis' }] }),
      }),
    },
    {
      match: (req) => isDraftCall(req) && req.responseFormat === 'text',
      respond: () => {
        drafts.count += 1;
        return { content: 'A background synopsis.' };
      },
    },
  ];
}

async function open(options: { locks?: boolean } = {}) {
  const state = fiveScenes();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  const drafts = { count: 0 };
  const db = memoryDb();
  const controller = new AgentController(session, await providersFor(scripts(drafts)), () => ({}), () => false, {
    store: new TaskStore(db),
    locksAvailable: () => options.locks !== false,
    sleep: async () => sleep(1),
  });
  controller.attach();
  await sleep(20);
  return { state, session, controller, drafts, db };
}

const synopsisOf = (state: ProjectState, title: string): string => state.manifest.tree.find((node) => node.title === title)?.synopsis ?? '';

test('a plan of five calls is offered before any draft is made, and Run now stages it as every plan is', async () => {
  const { state, session, controller, drafts } = await open();

  const running = controller.submit(INTENT);
  await until(() => controller.snapshot().offer !== null, 'the offer');
  expect(drafts.count).toBe(0);
  expect(controller.snapshot().offer).toMatchObject({ unavailable: null, offer: { estimatedCalls: 5, turnCap: 8 } });
  expect(controller.snapshot().announcement).toContain('5 model calls');

  await controller.answerOffer('now');
  await until(() => controller.snapshot().pending !== null, 'the card');
  expect(drafts.count).toBe(5);
  expect(controller.snapshot().offer).toBeNull();
  controller.answer({ action: 'approve' });
  const report = await running;

  expect(report?.status).toBe('applied');
  expect(synopsisOf(state, 'The Storm')).toBe('A background synopsis.');
  await controller.tasksIdle();
  expect(controller.snapshot().tasks).toEqual([]);
  controller.detach();
  await session.close();
});

test('Cancel on the offer, and Stop while it waits, end the turn with nothing drafted', async () => {
  const { state, session, controller, drafts } = await open();

  const first = controller.submit(INTENT);
  await until(() => controller.snapshot().offer !== null, 'the offer');
  await controller.answerOffer('cancel');
  expect((await first)?.status).toBe('cancelled');

  const second = controller.submit(INTENT);
  await until(() => controller.snapshot().offer !== null, 'the offer again');
  controller.stop();
  const report = await second;
  expect(report?.status).toBe('cancelled');
  expect(report?.stop?.by).toBe('user');
  expect(controller.snapshot().offer).toBeNull();
  expect(drafts.count).toBe(0);
  expect(synopsisOf(state, 'The Storm')).toBe('');
  controller.detach();
  await session.close();
});

test('Run in background frees the controller at once, drafts without touching the project, and the review applies it as one undo group', async () => {
  const { state, session, controller, drafts, db } = await open();
  const logged = session.log.entries().length;
  const revisions = state.manifest.tree.map((node) => getRevision(state, node.id));
  const tree = JSON.stringify(state.manifest.tree);

  const running = controller.submit(INTENT);
  await until(() => controller.snapshot().offer !== null, 'the offer');
  await controller.answerOffer('background');
  const queued = await running;

  expect(queued?.status).toBe('replied');
  expect(queued?.text).toBe('Queued in the background: 5 model calls. Results appear in Tasks when ready.');
  expect(controller.snapshot().busy).toBe(false);
  expect(controller.snapshot().tasks).toHaveLength(1);
  expect(db).toBeDefined();

  await controller.tasksIdle();
  const ready = controller.snapshot().tasks[0];
  expect(ready).toMatchObject({ status: 'ready', done: 5, total: 5, used: 5, cap: 5, outdated: 0 });
  expect(ready?.statusText).toBe('Ready to review: 5 of 5 drafted');
  expect(drafts.count).toBe(5);
  // The queue only stages: no command ran, no revision moved, nothing in the tree changed.
  expect(session.log.entries().length).toBe(logged);
  expect(state.manifest.tree.map((node) => getRevision(state, node.id))).toEqual(revisions);
  expect(JSON.stringify(state.manifest.tree)).toBe(tree);
  expect(controller.snapshot().announcement).toContain('ready to review');

  const review = controller.reviewTask(ready?.id ?? '');
  await until(() => controller.snapshot().pending !== null, 'the review card');
  const card = controller.snapshot().pending?.card;
  expect(card?.steps[0]).toMatchObject({ tool: 'synopsis.fill', stale: false });
  expect(card?.approvable).toBe(true);
  controller.answer({ action: 'approve' });
  const report = await review;

  expect(report?.status).toBe('applied');
  // The held drafts were applied: no new model call was made for them.
  expect(drafts.count).toBe(5);
  for (const title of TITLES) expect(synopsisOf(state, title)).toBe('A background synopsis.');
  expect(controller.snapshot().tasks[0]?.status).toBe('applied');
  const checkpoint = controller.snapshot().turns.at(-1)?.checkpoint;
  expect(checkpoint).not.toBeNull();
  expect((await controller.restore(report?.turnId ?? '')).ok).toBe(true);
  expect(synopsisOf(state, 'The Storm')).toBe('');
  controller.detach();
  await session.close();
});

test('a scene changed since it was drafted is out of date in the row and in the review, and cannot be approved', async () => {
  const { state, session, controller } = await open();
  const running = controller.submit(INTENT);
  await until(() => controller.snapshot().offer !== null, 'the offer');
  await controller.answerOffer('background');
  await running;
  await controller.tasksIdle();

  const storm = state.manifest.tree.find((node) => node.title === 'The Storm');
  session.dispatch('doc.write', { docId: storm?.id ?? '', body: 'A new storm.', expectedRevision: getRevision(state, storm?.id ?? '') });
  expect(controller.taskViews()[0]).toMatchObject({ status: 'ready', outdated: 1 });
  expect(controller.taskViews()[0]?.statusText).toBe('Ready to review: 5 of 5 drafted, 1 out of date');

  const review = controller.reviewTask(controller.snapshot().tasks[0]?.id ?? '');
  await until(() => controller.snapshot().pending !== null, 'the review card');
  expect(controller.snapshot().pending?.card.steps[0]?.stale).toBe(true);
  expect(controller.snapshot().approvable).toBe(false);
  controller.answer({ action: 'cancel' });
  expect((await review)?.status).toBe('cancelled');
  expect(controller.snapshot().tasks[0]?.status).toBe('ready');
  expect(synopsisOf(state, 'The Landing')).toBe('Elena returns to the island.');
  controller.detach();
  await session.close();
});

test('Review while a turn runs says so and starts nothing', async () => {
  const { session, controller } = await open();
  const running = controller.submit(INTENT);
  await until(() => controller.snapshot().offer !== null, 'the offer');
  await controller.answerOffer('background');
  await running;
  await controller.tasksIdle();

  const holding = controller.submit(INTENT);
  await until(() => controller.snapshot().offer !== null, 'the next offer');
  expect(await controller.reviewTask(controller.snapshot().tasks[0]?.id ?? '')).toBeNull();
  expect(controller.snapshot().message).toBe('The agent is working on another turn. Open this task when it has finished.');
  await controller.answerOffer('cancel');
  await holding;
  controller.detach();
  await session.close();
});

test('where the browser cannot guarantee one runner the offer says so and has no background button to press', async () => {
  const { session, controller, drafts } = await open({ locks: false });
  const running = controller.submit(INTENT);
  await until(() => controller.snapshot().offer !== null, 'the offer');
  const offer = controller.snapshot().offer;
  expect(offer?.unavailable).toContain('can only run now');

  await controller.answerOffer('background');
  expect(controller.snapshot().offer).not.toBeNull();
  expect(controller.snapshot().tasks).toEqual([]);
  expect(drafts.count).toBe(0);
  await controller.answerOffer('cancel');
  await running;
  controller.detach();
  await session.close();
});

test('a task is read back when the project is opened again, ready to review with what it drafted', async () => {
  const state = fiveScenes();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const drafts = { count: 0 };
  const db = memoryDb();
  const make = async () => {
    const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
    const controller = new AgentController(session, await providersFor(scripts(drafts)), () => ({}), () => false, {
      store: new TaskStore(db),
      locksAvailable: () => true,
      sleep: async () => sleep(1),
    });
    return { session, controller };
  };

  const first = await make();
  first.controller.attach();
  await sleep(20);
  const running = first.controller.submit(INTENT);
  await until(() => first.controller.snapshot().offer !== null, 'the offer');
  await first.controller.answerOffer('background');
  await running;
  await first.controller.tasksIdle();
  first.controller.detach();
  await first.session.close();

  const second = await make();
  second.controller.attach();
  await until(() => second.controller.snapshot().tasks.length === 1, 'the task to be read back');
  expect(second.controller.snapshot().tasks[0]).toMatchObject({ status: 'ready', done: 5, used: 5 });
  const review = second.controller.reviewTask(second.controller.snapshot().tasks[0]?.id ?? '');
  await until(() => second.controller.snapshot().pending !== null, 'the review card');
  second.controller.answer({ action: 'approve' });
  expect((await review)?.status).toBe('applied');
  expect(drafts.count).toBe(5);
  second.controller.detach();
  await second.session.close();
});
