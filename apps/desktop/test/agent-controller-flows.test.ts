import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore, type ChatChunk } from '@caotang/gateway';
import { createMockProvider, isDraftCall, isPlannerCall, userTextOf, type MockScript } from '@caotang/gateway/mock';
import { RUN_LOG_VERSION, type PlanStep } from '@caotang/harness';
import { addDocument, createRunLogPort, MemoryIndexedDb, openRuntimeStore, type RunEventInput, type RunRow } from '@caotang/store';

import { AgentController, queuePausedText, type AgentSnapshot } from '../src/app/agent.js';
import type { AppDb } from '../src/app/app-db.js';
import { sampleProjectState } from '../src/app/demo.js';
import type { ProviderService } from '../src/app/providers.js';
import { ProjectSession } from '../src/app/session.js';
import { TaskStore } from '../src/app/task-store.js';

const sessions: { session: ProjectSession; controller: AgentController }[] = [];
const releases: (() => void)[] = [];

beforeEach(() => {
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  vi.restoreAllMocks();
  for (const { session, controller } of sessions.splice(0)) {
    controller.stop();
    controller.detach();
    await controller.tasksIdle();
    await session.close();
  }
  vi.unstubAllGlobals();
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  releases.push(resolve);
  return { promise, resolve };
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

const planner = (intent: string) => (req: Parameters<MockScript['match']>[0]) => isPlannerCall(req) && userTextOf(req).includes(`Request: ${intent}`);
const reply = (intent: string, text: string): MockScript => ({ match: planner(intent), respond: () => ({ content: JSON.stringify({ reply: text }) }) });

function heldReply(intent: string) {
  const reached = deferred();
  const release = deferred();
  const script: MockScript = {
    match: planner(intent),
    respond: () => (async function* (): AsyncGenerator<ChatChunk> {
      reached.resolve();
      await release.promise;
      yield { delta: JSON.stringify({ reply: 'Done.' }) };
      yield { finishReason: 'stop' };
    })(),
  };
  return { script, reached: reached.promise, release: release.resolve };
}

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

async function fixture(scripts: readonly MockScript[] = [], options: { fiveScenes?: boolean; locks?: boolean } = {}) {
  const state = sampleProjectState();
  if (options.fiveScenes) {
    for (const title of ['Scene 4', 'Scene 5']) addDocument(state, { parentId: 'manuscript', title, body: `${title} text.`, now: new Date() });
  }
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
  const controller: AgentController = new AgentController(session, providers, () => ({}), () => false, {
    store: new TaskStore(memoryDb()),
    locksAvailable: () => options.locks !== false,
    sleep: () => when(controller, (snapshot) => !snapshot.busy),
  });
  sessions.push({ session, controller });
  const node = (title: string) => state.manifest.tree.find((entry) => entry.title === title)!;
  const steps: PlanStep[] = [{ tool: 'meta.set', params: { targets: [node('The Storm').id], keywords_add: ['storm'] }, expect: 'The Storm is tagged' }];
  return { state, session, controller, node, steps, port: createRunLogPort(store) };
}

it('runs edited queued turns in order, putting an undelivered note ahead of them only after the current turn settles', async () => {
  const hold = heldReply('First.');
  const f = await fixture([hold.script, reply('Note.', 'Noted.'), reply('Second.', 'Two.'), reply('Third.', 'Three.')]);
  const seen: AgentSnapshot[] = [];
  const counts: number[] = [];
  f.controller.subscribe(() => {
    seen.push(f.controller.snapshot());
    counts.push(f.controller.turnCount());
  });
  const running = f.controller.submit('First.');
  await hold.reached;
  f.controller.enqueue('Wrong.');
  f.controller.enqueue('Remove.');
  f.controller.enqueue('Third.');
  const [second, remove, third] = f.controller.snapshot().queue;
  f.controller.editQueued(second!.id, 'Second.');
  f.controller.removeQueued(remove!.id);
  f.controller.moveQueued(third!.id, 0);
  expect(f.controller.steer('Note.')).toBe('sent');
  expect(f.controller.snapshot().notes).toMatchObject([{ text: 'Note.', lands: 'next-model-call' }]);
  expect(f.controller.turnCount()).toBe(1);
  expect(f.controller.snapshot().queue.map((entry) => entry.intent)).toEqual(['Third.', 'Second.']);

  hold.release();
  await running;
  await when(f.controller, (snapshot) => snapshot.turns.length === 4 && !snapshot.busy);
  expect(f.controller.snapshot().turns.map((turn) => [turn.intent, turn.report?.text])).toEqual([
    ['First.', 'Done.'], ['Note.', 'Noted.'], ['Third.', 'Three.'], ['Second.', 'Two.'],
  ]);
  expect(seen.find((snapshot) => snapshot.queue.some((entry) => entry.fromUndeliveredNote))?.queue).toMatchObject([
    { intent: 'Note.', fromUndeliveredNote: true }, { intent: 'Third.' }, { intent: 'Second.' },
  ]);
  for (let index = 1; index < seen.length; index += 1) {
    if (counts[index]! > counts[index - 1]!) expect(seen[index - 1]!.busy).toBe(false);
  }
  expect(f.controller.snapshot()).toMatchObject({ queue: [], notes: [] });
});

it('pauses queued turns after an ask-back and runs them only when the writer resumes the queue', async () => {
  const f = await fixture([
    { match: planner('Fail.'), respond: () => ({ content: '', error: { kind: 'network' } }) },
    reply('Next.', 'Ready.'),
  ]);
  const running = f.controller.submit('Fail.');
  f.controller.enqueue('Next.');
  expect(await running).toMatchObject({ status: 'failed', askBack: expect.anything() });
  expect(f.controller.snapshot()).toMatchObject({ busy: false, queuePaused: true, announcement: queuePausedText() });
  expect(f.controller.snapshot().turns).toHaveLength(1);
  expect(f.controller.snapshot().queue.map((entry) => entry.intent)).toEqual(['Next.']);
  f.controller.runQueue();
  await when(f.controller, (snapshot) => snapshot.turns.length === 2 && !snapshot.busy);
  expect(f.controller.snapshot().queuePaused).toBe(false);
  expect(f.controller.snapshot().turns[1]?.report?.text).toBe('Ready.');
});

it('lets a queued turn start after Stop settles the approval it cancelled', async () => {
  const f = await fixture([reply('Next.', 'Ready.')]);
  const running = f.controller.submitPlan('Tag the storm.', { steps: f.steps }, { forcePlan: true });
  await when(f.controller, (snapshot) => snapshot.pending !== null);
  f.controller.enqueue('Next.');
  f.controller.stop();
  expect(await running).toMatchObject({ status: 'cancelled', stop: { by: 'user', during: 'awaiting-approval' } });
  await when(f.controller, (snapshot) => snapshot.turns.length === 2 && !snapshot.busy);
  expect(f.controller.snapshot().turns[1]?.report?.text).toBe('Ready.');
  expect(f.node('The Storm').keywords ?? []).not.toContain('storm');
  expect(f.controller.snapshot()).toMatchObject({ pending: null, stoppable: false, queuePaused: false });
});

it('cancels a detached approval, never parks another while detached, and accepts decisions after re-attachment', async () => {
  const f = await fixture();
  const first = f.controller.submitPlan('Tag the storm.', { steps: f.steps }, { forcePlan: true });
  await when(f.controller, (snapshot) => snapshot.pending !== null);
  f.controller.detach();
  expect((await first)?.status).toBe('cancelled');
  expect(f.controller.snapshot().pending).toBeNull();
  expect((await f.controller.submitPlan('Still detached.', { steps: f.steps }, { forcePlan: true }))?.status).toBe('cancelled');
  expect(f.node('The Storm').keywords ?? []).not.toContain('storm');

  f.controller.attach();
  const next = f.controller.submitPlan('Attached again.', { steps: f.steps }, { forcePlan: true });
  await when(f.controller, (snapshot) => snapshot.pending !== null);
  f.controller.answer({ action: 'approve' });
  expect((await next)?.status).toBe('applied');
  expect(f.node('The Storm').keywords).toContain('storm');
});

const TITLES = ['The Landing', 'The Storm', 'The Friend', 'Scene 4', 'Scene 5'];
const SYNOPSES = 'Fill the synopses.';

async function backgroundFixture(locks = true) {
  let drafts = 0;
  const f = await fixture([
    { match: planner(SYNOPSES), respond: () => ({ content: JSON.stringify({ steps: [{ tool: 'synopsis.fill', params: { docs: TITLES, source: 'text', max_words: 20 }, expect: 'Five synopses' }] }) }) },
    { match: isDraftCall, respond: () => { drafts += 1; return { content: 'A background synopsis.' }; } },
  ], { fiveScenes: true, locks });
  const before = f.controller.snapshot();
  f.controller.attach();
  await when(f.controller, (snapshot) => snapshot !== before);
  return { ...f, drafts: () => drafts };
}

it('offers a large plan before drafting and Run now still needs the normal approval', async () => {
  const f = await backgroundFixture();
  const running = f.controller.submit(SYNOPSES);
  await when(f.controller, (snapshot) => snapshot.offer !== null);
  expect(f.drafts()).toBe(0);
  expect(f.controller.snapshot().offer).toMatchObject({ unavailable: null, offer: { estimatedCalls: 5, turnCap: 8 } });
  await f.controller.answerOffer('now');
  await when(f.controller, (snapshot) => snapshot.pending !== null);
  expect(f.drafts()).toBe(5);
  expect(f.node('The Storm').synopsis ?? '').toBe('');
  f.controller.answer({ action: 'approve' });
  expect((await running)?.status).toBe('applied');
  expect(f.node('The Storm').synopsis).toBe('A background synopsis.');
  expect(f.controller.snapshot()).toMatchObject({ offer: null, tasks: [] });
});

it('stages in the background without project writes, reloads the task on re-attachment, and reviews without redrafting', async () => {
  const f = await backgroundFixture();
  const before = JSON.stringify(f.state.manifest.tree);
  const logged = f.session.log.entries().length;
  const running = f.controller.submit(SYNOPSES);
  await when(f.controller, (snapshot) => snapshot.offer !== null);
  await f.controller.answerOffer('background');
  expect(await running).toMatchObject({ status: 'replied', text: expect.stringContaining('Queued in the background') });
  expect(f.controller.snapshot().busy).toBe(false);
  await f.controller.tasksIdle();
  expect(f.controller.snapshot().tasks).toMatchObject([{ status: 'ready', done: 5, used: 5, cap: 5 }]);
  expect(JSON.stringify(f.state.manifest.tree)).toBe(before);
  expect(f.session.log.entries()).toHaveLength(logged);

  f.controller.detach();
  const detached = f.controller.snapshot();
  const reloaded = when(f.controller, (snapshot) => snapshot !== detached && snapshot.tasks[0]?.status === 'ready');
  f.controller.attach();
  await reloaded;
  const task = f.controller.snapshot().tasks[0]!;
  const review = f.controller.reviewTask(task.id);
  await when(f.controller, (snapshot) => snapshot.pending !== null);
  f.controller.answer({ action: 'approve' });
  expect((await review)?.status).toBe('applied');
  expect(f.drafts()).toBe(5);
  expect(TITLES.map((title) => f.node(title).synopsis)).toEqual(TITLES.map(() => 'A background synopsis.'));
  expect(f.controller.snapshot().tasks[0]?.status).toBe('applied');
});

it('keeps an unavailable background offer parked, then cancels or stops it without any draft', async () => {
  const f = await backgroundFixture(false);
  for (const choice of ['cancel', 'stop'] as const) {
    const running = f.controller.submit(SYNOPSES);
    await when(f.controller, (snapshot) => snapshot.offer !== null);
    expect(f.controller.snapshot().offer?.unavailable).toContain('can only run now');
    await f.controller.answerOffer('background');
    expect(f.controller.snapshot().offer).not.toBeNull();
    if (choice === 'stop') f.controller.stop();
    else await f.controller.answerOffer('cancel');
    expect((await running)?.status).toBe('cancelled');
    expect(f.controller.snapshot()).toMatchObject({ offer: null, pending: null, tasks: [] });
  }
  expect(f.drafts()).toBe(0);
});

async function seedWaiting(f: Awaited<ReturnType<typeof fixture>>, runId: string, options: Partial<RunRow> = {}) {
  const intent = 'Label the landing.';
  await f.port.create({ schema: RUN_LOG_VERSION, runId, projectId: f.session.projectId, kind: 'turn', intent, createdAt: 1_000, updatedAt: 1_000, status: 'interrupted', ...options });
  const events = [
    { t: 'turn.start', v: RUN_LOG_VERSION, turnId: 't1', intent, wire: 'planner', native: false },
    { t: 'skills.loaded', turnId: 't1', skills: [] },
    { t: 'messages', turnId: 't1', appended: [{ role: 'user', content: `Request: ${intent}` }] },
    { t: 'spend', turnId: 't1', spend: { modelCalls: 3, promptTokens: 100, completionTokens: 40, estimatedTokens: 0, steps: 0, activeMs: 500 }, reservedCalls: 1 },
    { t: 'card.pending', turnId: 't1', kind: 'plan', steps: [{ tool: 'meta.set', params: { targets: [f.node('The Landing').id], label: 'act-2' }, expect: 'The Landing is labelled' }], proposals: [null], revisions: [null], done: [] },
  ];
  await f.port.append(runId, events.map((event, seq) => ({ ...event, seq, at: 1_000 + seq })) as unknown as RunEventInput[]);
}

it('lists only interrupted logs, refuses a discard-only log, and discards the log without undoing project writes', async () => {
  const called = vi.fn(() => ({ content: JSON.stringify({ reply: 'Unexpected.' }) }));
  const f = await fixture([{ match: () => true, respond: called }]);
  for (const status of ['running', 'awaiting-approval', 'finished'] as const) await seedWaiting(f, `run_${status}`, { status });
  await seedWaiting(f, 'run_NOLOG', { cannotResume: true });
  await seedWaiting(f, 'run_OTHER', { projectId: 'p_OTHER' });
  await seedWaiting(f, 'run_GOOD');
  await seedWaiting(f, 'run_FUTURE', { schema: RUN_LOG_VERSION + 1 });
  await f.controller.loadInterrupted();
  expect(Object.fromEntries(f.controller.snapshot().interrupted.map((run) => [run.runId, run.resumable]))).toEqual({ run_GOOD: true, run_FUTURE: false });
  expect(await f.controller.resumeRun('run_FUTURE')).toBeNull();
  expect(f.controller.snapshot().turns).toEqual([]);
  expect(called).not.toHaveBeenCalled();
  f.session.dispatch('doc.write', { docId: f.node('The Storm').id, body: 'Words already written.' });
  const tree = JSON.stringify(f.state.manifest.tree);
  await f.controller.discardRun('run_FUTURE');
  expect(f.controller.snapshot().interrupted.map((run) => run.runId)).toEqual(['run_GOOD']);
  expect(await f.port.events('run_FUTURE')).toEqual([]);
  expect(JSON.stringify(f.state.manifest.tree)).toBe(tree);
  expect(f.state.documents.get(f.node('The Storm').id)?.body).toBe('Words already written.');
});

it('defers interrupted-load while busy, refuses concurrent Resume, then restores the approval and logged spend', async () => {
  const hold = heldReply('Think.');
  const called = vi.fn(() => ({ content: JSON.stringify({ reply: 'Unexpected.' }) }));
  const f = await fixture([hold.script, { match: () => true, respond: called }]);
  await seedWaiting(f, 'run_GOOD');
  const running = f.controller.submit('Think.');
  await hold.reached;
  await f.controller.loadInterrupted();
  expect(f.controller.snapshot().interrupted).toEqual([]);
  expect(await f.controller.resumeRun('run_GOOD')).toBeNull();
  expect(f.controller.snapshot().turns).toHaveLength(1);
  expect(f.controller.snapshot().message).toContain('working on another turn');
  hold.release();
  await running;
  await when(f.controller, (snapshot) => snapshot.interrupted.length === 1);
  const resumed = f.controller.resumeRun('run_GOOD');
  await when(f.controller, (snapshot) => snapshot.pending !== null);
  expect(f.node('The Landing').label).not.toBe('act-2');
  f.controller.answer({ action: 'cancel' });
  expect(await resumed).toMatchObject({ status: 'cancelled', modelCalls: 4, spend: { modelCalls: 4, promptTokens: 100, completionTokens: 40 } });
  expect(called).not.toHaveBeenCalled();
});

async function applyPlan(f: Awaited<ReturnType<typeof fixture>>, intent: string, steps: PlanStep[]) {
  const running = f.controller.submitPlan(intent, { steps }, { forcePlan: true });
  await when(f.controller, (snapshot) => snapshot.pending !== null);
  f.controller.answer({ action: 'approve' });
  const report = await running;
  expect(report?.status).toBe('applied');
  return report!;
}

it('restores an earlier turn and its later turn, marking both restored without rewinding their conversation', async () => {
  const f = await fixture();
  const first = await applyPlan(f, 'Tag the storm.', f.steps);
  await applyPlan(f, 'Tag the friend.', [{ tool: 'meta.set', params: { targets: [f.node('The Friend').id], keywords_add: ['friend'] }, expect: 'The Friend is tagged' }]);
  expect(await f.controller.restore(first.turnId)).toMatchObject({ ok: true, later: 1 });
  expect(f.node('The Storm').keywords ?? []).not.toContain('storm');
  expect(f.node('The Friend').keywords ?? []).not.toContain('friend');
  expect(f.controller.snapshot().turns.map((turn) => [turn.restoredAt !== null, turn.rewound])).toEqual([[true, false], [true, false]]);
});

it('restores the project but refuses to rewind if another turn starts while restore is saving typing', async () => {
  const hold = heldReply('Later.');
  const f = await fixture([hold.script]);
  const first = await applyPlan(f, 'Tag the storm.', f.steps);
  const saving = deferred();
  const release = deferred();
  const flush = f.session.autosave.flush.bind(f.session.autosave);
  vi.spyOn(f.session.autosave, 'flush').mockImplementationOnce(async () => {
    saving.resolve();
    await release.promise;
    return flush();
  });
  const restoring = f.controller.restoreBoth(first.turnId);
  await saving.promise;
  const running = f.controller.submit('Later.');
  await hold.reached;
  expect(f.controller.canRewind(first.turnId)).toBe(false);
  expect(f.controller.rewindConversation(first.turnId)).toBeNull();
  release.resolve();
  expect(await restoring).toMatchObject({ ok: false, projectRestored: true, message: expect.stringContaining('conversation was not rewound') });
  expect(f.node('The Storm').keywords ?? []).not.toContain('storm');
  expect(f.controller.snapshot().turns[0]).toMatchObject({ restoredAt: expect.any(Number), rewound: false });
  hold.release();
  await running;
});
