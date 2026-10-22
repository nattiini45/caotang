import { expect, test } from '@playwright/test';

import type { StageOnlyResult } from '../../packages/harness/src/index.js';
import type { PlanStep } from '../../packages/harness/src/index.js';
import type { AppDb } from '../../apps/desktop/src/app/app-db.js';
import { TaskQueue, type TaskAgent, type TaskAgentFactory } from '../../apps/desktop/src/app/task-queue.js';
import {
  TASK_KEEP_FINISHED,
  TASK_KEEP_MS,
  TaskStore,
  asTaskRecord,
  dropTasksOf,
  itemsOf,
  reviewOf,
  taskKey,
  type TaskRecord,
} from '../../apps/desktop/src/app/task-store.js';

/**
 * The background task queue and the records it keeps (agent-harness §2, "Background runs"), run without a browser: an in-memory app
 * database stands in for IndexedDB, and a scripted agent stands in for the harness's staging, so what is checked is the queue's own
 * logic: what it saves, what it runs and when, what a reload does to a task, and what the cap allows.
 */

const PROJECT = 'p_TASKPROJ01';

function memoryDb(): AppDb & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    async get<T>(key: string): Promise<T | undefined> {
      return rows.has(key) ? (structuredClone(rows.get(key)) as T) : undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      rows.set(key, structuredClone(value));
    },
    async list<T>(prefix: string) {
      return [...rows.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, value]) => ({ key, value: structuredClone(value) as T }));
    },
    async delete(key: string): Promise<void> {
      rows.delete(key);
    },
    close(): void {},
  };
}

const synopses = (docs: readonly string[]): PlanStep => ({ tool: 'synopsis.fill', params: { docs, source: 'text', max_words: 20 }, expect: 'synopses' });
const scene = (doc: string): PlanStep => ({ tool: 'scene.draft', params: { doc, instruction: 'Open.', mode: 'draft' }, expect: 'a draft' });
const label: PlanStep = { tool: 'meta.set', params: { targets: ['n_BRAVE00001'], label: 'act-2' }, expect: 'a label' };

/** What staging one step returns when it works: a draft shaped like the tool's own, and the revisions it read. */
function staged(step: PlanStep, calls = 1): StageOnlyResult {
  const docs = step.tool === 'synopsis.fill' ? (step.params['docs'] as string[]) : [];
  const proposal =
    step.tool === 'synopsis.fill'
      ? { items: docs.map((doc) => ({ docId: `id-${doc}`, synopsis: `About ${doc}.` })) }
      : { text: 'Drafted.', words: 1, revision: 3 };
  return {
    proposals: [proposal],
    revisions: [Object.fromEntries((docs.length === 0 ? ['scene'] : docs).map((doc) => [`id-${doc}`, 1]))],
    refusals: [],
    stopped: false,
    modelCalls: calls,
    tokens: { promptTokens: 10 * calls, completionTokens: 5 * calls, requests: calls },
  };
}

interface Harness {
  readonly db: ReturnType<typeof memoryDb>;
  readonly queue: TaskQueue;
  readonly staged: PlanStep[];
  readonly sessions: { readonly id: string; readonly cap: number }[];
  busy: boolean;
}

/** A queue over `db`, whose agent answers each staging call with `answer` (default: it works). */
function queueOver(
  db: ReturnType<typeof memoryDb>,
  options: {
    readonly answer?: (step: PlanStep, signal: AbortSignal | undefined) => Promise<StageOnlyResult> | StageOnlyResult;
    readonly locks?: boolean;
    readonly noProvider?: boolean;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): Harness {
  const state: Harness = { db, staged: [], sessions: [], busy: false, queue: undefined as unknown as TaskQueue };
  const agentFor: TaskAgentFactory = (_task, id, cap): TaskAgent | string => {
    if (options.noProvider === true) return 'No provider is active, so this task could not be staged.';
    state.sessions.push({ id, cap });
    return {
      stageOnly: async (steps, turn) => {
        const step = steps[0] as PlanStep;
        state.staged.push(step);
        return options.answer === undefined ? staged(step) : options.answer(step, turn?.signal);
      },
    };
  };
  let counter = 0;
  const queue = new TaskQueue({
    projectId: PROJECT,
    store: new TaskStore(db),
    agentFor,
    foregroundBusy: () => state.busy,
    locksAvailable: () => options.locks !== false,
    newId: () => `task_TEST${String((counter += 1)).padStart(6, '0')}`,
    ...(options.now === undefined ? {} : { now: options.now }),
    sleep: options.sleep ?? (async () => undefined),
  });
  return Object.assign(state, { queue });
}

const statusOf = (queue: TaskQueue, id: string): string | undefined => queue.snapshot().find((task) => task.id === id)?.status;

test('a queued plan is saved under its project and id, with an item for each drafting step and each synopsis document', async () => {
  const db = memoryDb();
  const { queue } = queueOver(db);
  await queue.open();

  const result = await queue.enqueue('Synopsize the act.', [label, synopses(['The Storm', 'The Friend']), scene('The Friend')]);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.task.cap).toBe(3);
  expect(result.task.items.map((item) => item.key)).toEqual(['1:The Storm', '1:The Friend', '2']);
  expect([...db.rows.keys()]).toEqual([taskKey(PROJECT, result.task.id)]);
  expect(taskKey(PROJECT, result.task.id)).toMatch(/^task:p_TASKPROJ01:task_/);
  await queue.idle();
});

test('a plan that cannot run unattended is refused with the reason, and nothing is saved', async () => {
  const db = memoryDb();
  const { queue } = queueOver(db);
  await queue.open();

  const external = await queue.enqueue('x', [synopses(['A']), { tool: 'mcp__srv__write', params: {}, expect: 'x' }]);
  const review = await queue.enqueue('x', [synopses(['A']), { tool: 'coherence.review', params: {}, expect: 'x' }]);
  const nothing = await queue.enqueue('x', [label]);

  for (const refused of [external, review, nothing]) expect(refused.ok).toBe(false);
  expect(external.ok === false && external.reason).toContain('external');
  expect(db.rows.size).toBe(0);
});

test('without Web Locks, or without a database, no plan is queued', async () => {
  const noLocks = queueOver(memoryDb(), { locks: false });
  await noLocks.queue.open();
  expect(noLocks.queue.unavailable()).toContain('browser feature');
  expect((await noLocks.queue.enqueue('x', [synopses(['A'])])).ok).toBe(false);

  const queue = new TaskQueue({
    projectId: PROJECT,
    store: new TaskStore(null),
    agentFor: () => 'none',
    foregroundBusy: () => false,
    locksAvailable: () => true,
  });
  await queue.open();
  expect(queue.unavailable()).toContain('would not keep');
});

test('the runner stages one item at a time, in order, and a finished task is ready with its calls and tokens', async () => {
  const db = memoryDb();
  let running = 0;
  let overlapped = false;
  const h = queueOver(db, {
    answer: async (step) => {
      running += 1;
      overlapped ||= running > 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return staged(step);
    },
  });
  await h.queue.open();
  const result = await h.queue.enqueue('Synopsize the act.', [synopses(['A', 'B', 'C']), scene('D')]);
  await h.queue.idle();

  expect(result.ok).toBe(true);
  const task = h.queue.snapshot()[0] as TaskRecord;
  expect(overlapped).toBe(false);
  expect(h.staged.map((step) => step.tool + (step.tool === 'synopsis.fill' ? `:${String((step.params['docs'] as string[])[0])}` : ''))).toEqual([
    'synopsis.fill:A',
    'synopsis.fill:B',
    'synopsis.fill:C',
    'scene.draft',
  ]);
  expect(task.status).toBe('ready');
  expect(task).toMatchObject({ used: 4, cap: 4, promptTokens: 40, completionTokens: 20, runs: 1 });
  expect(h.sessions).toEqual([{ id: task.id, cap: 4 }]);
  // What is on disk is what is in memory.
  expect(db.rows.get(taskKey(PROJECT, task.id))).toMatchObject({ status: 'ready', used: 4 });
});

test('a review gets the synopsis documents back as one batch, and a scene draft as its own proposal', async () => {
  const h = queueOver(memoryDb());
  await h.queue.open();
  await h.queue.enqueue('x', [synopses(['A', 'B']), scene('D')]);
  await h.queue.idle();

  const id = (h.queue.snapshot()[0] as TaskRecord).id;
  const reviewed = h.queue.review(id);

  expect(reviewed?.review.steps.map((step) => step.tool)).toEqual(['synopsis.fill', 'scene.draft']);
  expect(reviewed?.review.proposals[0]).toEqual({
    items: [
      { docId: 'id-A', synopsis: 'About A.' },
      { docId: 'id-B', synopsis: 'About B.' },
    ],
  });
  expect(reviewed?.review.proposals[1]).toMatchObject({ text: 'Drafted.' });
  expect(reviewed?.review.revisions[0]).toEqual({ 'id-A': 1, 'id-B': 1 });
  expect(reviewed?.review.omitted).toBe(0);
});

test('the runner makes no call while a foreground turn is busy, and goes on once it is not', async () => {
  const h = queueOver(memoryDb(), {
    sleep: async () => {
      // Each wait the runner makes is a poll: the foreground turn ends after the third.
      polls += 1;
      if (polls === 3) h.busy = false;
    },
  });
  let polls = 0;
  h.busy = true;
  await h.queue.open();
  await h.queue.enqueue('x', [synopses(['A'])]);
  await h.queue.idle();

  expect(polls).toBe(3);
  expect(h.staged).toHaveLength(1);
  expect(statusOf(h.queue, (h.queue.snapshot()[0] as TaskRecord).id)).toBe('ready');
});

test('a call that is in flight is not cut short when a foreground turn starts; the next item waits', async () => {
  let release: () => void = () => undefined;
  const flight = new Promise<void>((resolve) => (release = resolve));
  const h = queueOver(memoryDb(), {
    answer: async (step) => {
      if (h.staged.length === 1) await flight;
      return staged(step);
    },
    // A real turn of the event loop, so the test's own polling gets to run while the runner waits.
    sleep: async () => {
      waits += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
  });
  let waits = 0;
  await h.queue.open();
  await h.queue.enqueue('x', [synopses(['A', 'B'])]);
  await expect.poll(() => h.staged.length).toBe(1);
  h.busy = true;
  release();
  await expect.poll(() => waits).toBeGreaterThan(2);
  expect(h.staged).toHaveLength(1);
  h.busy = false;
  await h.queue.idle();
  expect(h.staged).toHaveLength(2);
});

test('closing the queue stops the runner at once: the task is interrupted, saved, and no later item starts', async () => {
  const db = memoryDb();
  const h = queueOver(db, {
    answer: (step, signal) =>
      new Promise<StageOnlyResult>((resolve) => {
        if (h.staged.length > 1) return resolve(staged(step));
        signal?.addEventListener('abort', () => resolve({ ...staged(step, 0), proposals: [undefined], stopped: true, modelCalls: 0 }), { once: true });
      }),
  });
  await h.queue.open();
  const queued = await h.queue.enqueue('x', [synopses(['A', 'B', 'C'])]);
  await expect.poll(() => h.staged.length).toBe(1);

  await h.queue.close();

  expect(h.staged).toHaveLength(1);
  const id = queued.ok ? queued.task.id : '';
  expect(statusOf(h.queue, id)).toBe('interrupted');
  expect((db.rows.get(taskKey(PROJECT, id)) as TaskRecord).items.map((item) => item.state)).toEqual(['pending', 'pending', 'pending']);
});

test('after a reload a task that was running is interrupted, and a resume stages only the items still pending', async () => {
  const db = memoryDb();
  const first = queueOver(db, {
    answer: (step) => {
      if (first.staged.length === 2) return { ...staged(step, 0), proposals: [undefined], stopped: true, modelCalls: 0 };
      return staged(step);
    },
  });
  await first.queue.open();
  const queued = await first.queue.enqueue('x', [synopses(['A', 'B', 'C'])]);
  await first.queue.idle();
  const id = queued.ok ? queued.task.id : '';
  // The stop left A staged; B and C are pending. The record on disk says the task was running when the page went away.
  const left = db.rows.get(taskKey(PROJECT, id)) as TaskRecord;
  expect(left.items.map((item) => item.state)).toEqual(['staged', 'pending', 'pending']);
  db.rows.set(taskKey(PROJECT, id), { ...left, status: 'running' });

  const second = queueOver(db);
  await second.queue.open();
  expect(statusOf(second.queue, id)).toBe('interrupted');
  await second.queue.resume(id);
  await second.queue.idle();

  expect(second.staged.map((step) => (step.params['docs'] as string[])[0])).toEqual(['B', 'C']);
  const done = second.queue.snapshot()[0] as TaskRecord;
  expect(done.status).toBe('ready');
  expect(done.used).toBe(3);
  expect(done.runs).toBe(2);
  // A resume is a run of its own, with the calls the task has left, and a session name the ledger can tell from the first run's.
  expect(second.sessions).toEqual([{ id: `${id}.run2`, cap: 2 }]);
});

test('an item that would go past the cap fails in words, and the others still run', async () => {
  const db = memoryDb();
  // Each staging call spends two calls where the estimate said one, so the third item has no room left.
  const h = queueOver(db, { answer: (step) => staged(step, 2) });
  await h.queue.open();
  await h.queue.enqueue('x', [synopses(['A', 'B', 'C'])]);
  await h.queue.idle();

  const task = h.queue.snapshot()[0] as TaskRecord;
  expect(task.used).toBe(4);
  expect(task.items.map((item) => item.state)).toEqual(['staged', 'staged', 'failed']);
  expect(task.items[2]?.error).toBe("This step needs 1 model call, which would go past the task's limit of 3.");
  expect(task.status).toBe('ready');
});

test('a document that could not be drafted is left out of the review and counted; a task that staged nothing has failed', async () => {
  const partial = queueOver(memoryDb(), {
    answer: (step) =>
      (step.params['docs'] as string[])[0] === 'B'
        ? { ...staged(step), proposals: [undefined], refusals: [{ index: 0, tool: step.tool, message: 'the provider refused the request: rate limited' }] }
        : staged(step),
  });
  await partial.queue.open();
  await partial.queue.enqueue('x', [synopses(['A', 'B', 'C'])]);
  await partial.queue.idle();
  const task = partial.queue.snapshot()[0] as TaskRecord;
  expect(task.status).toBe('ready');
  expect(task.items[1]).toMatchObject({ state: 'failed', error: 'the provider refused the request: rate limited' });
  const reviewed = reviewOf(task);
  expect(reviewed.steps[0]?.params['docs']).toEqual(['A', 'C']);
  expect(reviewed.omitted).toBe(1);

  const none = queueOver(memoryDb(), { answer: (step) => ({ ...staged(step), proposals: [undefined], refusals: [{ index: 0, tool: step.tool, message: 'no such document' }] }) });
  await none.queue.open();
  await none.queue.enqueue('x', [scene('Nowhere')]);
  await none.queue.idle();
  expect(none.queue.snapshot()[0]).toMatchObject({ status: 'failed' });
  expect(none.queue.review(none.queue.snapshot()[0]?.id ?? '')).toBeUndefined();
});

test('a task with no provider to stage with fails every item in words', async () => {
  const h = queueOver(memoryDb(), { noProvider: true });
  await h.queue.open();
  await h.queue.enqueue('x', [synopses(['A', 'B'])]);
  await h.queue.idle();
  const task = h.queue.snapshot()[0] as TaskRecord;
  expect(task.status).toBe('failed');
  expect(task.items.every((item) => item.error === 'No provider is active, so this task could not be staged.')).toBe(true);
});

test('cancel stops a running task and a waiting one; a cancelled task cannot be reviewed', async () => {
  const h = queueOver(memoryDb(), {
    answer: (step, signal) =>
      new Promise<StageOnlyResult>((resolve) => {
        signal?.addEventListener('abort', () => resolve({ ...staged(step, 0), proposals: [undefined], stopped: true, modelCalls: 0 }), { once: true });
      }),
  });
  await h.queue.open();
  const running = await h.queue.enqueue('first', [synopses(['A'])]);
  const waiting = await h.queue.enqueue('second', [synopses(['B'])]);
  await expect.poll(() => h.staged.length).toBe(1);

  await h.queue.cancel(waiting.ok ? waiting.task.id : '');
  await h.queue.cancel(running.ok ? running.task.id : '');
  await h.queue.idle();

  expect(h.queue.snapshot().map((task) => task.status)).toEqual(['cancelled', 'cancelled']);
  expect(h.staged).toHaveLength(1);
  expect(h.queue.review(running.ok ? running.task.id : '')).toBeUndefined();
});

test('dismiss removes a finished task from the list and the database, and leaves a running one alone', async () => {
  const db = memoryDb();
  const h = queueOver(db);
  await h.queue.open();
  const queued = await h.queue.enqueue('x', [synopses(['A'])]);
  await h.queue.idle();
  const id = queued.ok ? queued.task.id : '';

  await h.queue.dismiss(id);

  expect(h.queue.snapshot()).toEqual([]);
  expect(db.rows.size).toBe(0);
});

test('approving a review marks the task applied, and only a ready task can be', async () => {
  const h = queueOver(memoryDb());
  await h.queue.open();
  const queued = await h.queue.enqueue('x', [scene('A')]);
  await h.queue.idle();
  const id = queued.ok ? queued.task.id : '';
  await h.queue.markApplied(id);
  expect(statusOf(h.queue, id)).toBe('applied');
  await h.queue.resume(id);
  expect(statusOf(h.queue, id)).toBe('applied');
});

test('opening prunes tasks older than 14 days and finished tasks beyond the newest 50, and keeps a waiting one', async () => {
  const db = memoryDb();
  const store = new TaskStore(db);
  const now = 10 * TASK_KEEP_MS;
  const record = (id: string, status: TaskRecord['status'], updatedAt: number): TaskRecord => ({
    id,
    projectId: PROJECT,
    intent: 'x',
    steps: [synopses(['A'])],
    status,
    items: itemsOf([synopses(['A'])]),
    cap: 1,
    used: 0,
    promptTokens: 0,
    completionTokens: 0,
    runs: 0,
    createdAt: updatedAt,
    updatedAt,
  });
  for (let index = 0; index < TASK_KEEP_FINISHED + 5; index += 1) await store.save(record(`task_FIN${String(index).padStart(7, '0')}`, 'applied', now - 1000 - index));
  await store.save(record('task_OLD0000001', 'ready', now - TASK_KEEP_MS - 1));
  await store.save(record('task_INT0000001', 'interrupted', now - 5));
  // Another project's task is never touched.
  await db.put(taskKey('p_OTHER00001', 'task_OTHER00001'), record('task_OTHER00001', 'applied', 0));

  const h = queueOver(db, { now: () => now });
  await h.queue.open();

  const ids = h.queue.snapshot().map((task) => task.id);
  expect(ids).toHaveLength(TASK_KEEP_FINISHED + 1);
  expect(ids).toContain('task_INT0000001');
  expect(ids).not.toContain('task_OLD0000001');
  expect(ids).not.toContain(`task_FIN${String(TASK_KEEP_FINISHED + 4).padStart(7, '0')}`);
  expect(db.rows.has(taskKey('p_OTHER00001', 'task_OTHER00001'))).toBe(true);
});

test('a stored value that is not shaped like a task is skipped, not trusted', async () => {
  const db = memoryDb();
  await db.put(taskKey(PROJECT, 'task_BAD0000001'), { id: 'task_BAD0000001', status: 'ready', projectId: PROJECT });
  await db.put(taskKey(PROJECT, 'task_BAD0000002'), 'text');
  await db.put(taskKey(PROJECT, 'task_BAD0000003'), { ...(asTaskRecord({}, PROJECT) ?? {}), id: 'task_BAD0000003' });
  const h = queueOver(db);
  await h.queue.open();
  expect(h.queue.snapshot()).toEqual([]);
});

test('removing a project removes its tasks and no one else’s', async () => {
  const db = memoryDb();
  await db.put(taskKey(PROJECT, 'task_AAAAAAAAAA'), {});
  await db.put(taskKey(PROJECT, 'task_BBBBBBBBBB'), {});
  await db.put(taskKey('p_OTHER00001', 'task_CCCCCCCCCC'), {});

  await dropTasksOf(PROJECT, db);

  expect([...db.rows.keys()]).toEqual([taskKey('p_OTHER00001', 'task_CCCCCCCCCC')]);
});

test('a database that fails costs the saved copy and nothing else: the task still stages and can be reviewed', async () => {
  const db = memoryDb();
  const broken = { ...db, put: async () => Promise.reject(new Error('quota')), list: db.list } as AppDb;
  const queue = new TaskQueue({
    projectId: PROJECT,
    store: new TaskStore(broken),
    agentFor: () => ({ stageOnly: async (steps) => staged(steps[0] as PlanStep) }),
    foregroundBusy: () => false,
    locksAvailable: () => true,
    sleep: async () => undefined,
  });
  await queue.open();
  await queue.enqueue('x', [scene('A')]);
  await queue.idle();
  expect(queue.snapshot()[0]?.status).toBe('ready');
});
