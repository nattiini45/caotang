/**
 * The queue of background tasks of one open project (agent-harness §2, "Background runs").
 *
 * A writer can send a big plan to the background. The queue stages it, one model call at a time, while the writer keeps writing, and
 * holds the drafts until the writer reviews them as a normal turn (agent.ts `reviewTask`). It never applies anything and never
 * issues a bus command: staging reads the project and calls the model, and that is all.
 *
 * ## One runner, on the main thread
 *
 * Only the session that holds the project's lease has a queue, so the tab with the project open is the one runner; a second tab is
 * refused at open (project-lease.ts). Where the browser has no Web Locks API there is no such guarantee, and the queue is
 * unavailable rather than risk two runners. The runner is sequential and waits before each next call while a foreground turn is busy;
 * a call already in flight is never cut short for it, so it still counts against a rate-limited key (provider-gateway §6).
 *
 * ## A task survives a reload, and a run does not
 *
 * Every change is saved (task-store.ts). A task that was running or waiting when the tab went away is `interrupted` when the project
 * opens again, and Resume stages only the items still pending, inside the cap the task has left.
 */

import { backgroundEligibility, estimatedModelCalls, type AgentSession, type PlanStep, type StageOnlyResult } from '@caotang/harness';

import {
  callsOfItem,
  itemsOf,
  newTaskId,
  reviewOf,
  stepOfItem,
  type TaskItem,
  type TaskRecord,
  type TaskReview,
  type TaskStatus,
  type TaskStore,
} from './task-store.js';

/** How long the runner waits before it asks again whether the foreground turn is still busy. */
export const FOREGROUND_POLL_MS = 250;

/** What the queue asks of an agent session: staging, and nothing else. */
export type TaskAgent = Pick<AgentSession, 'stageOnly'>;

/**
 * Builds the session a run stages with, or says why there is none. `sessionId` names the run's turns in the ledger, and `maxModelCalls`
 * is what the task has left.
 */
export type TaskAgentFactory = (task: TaskRecord, sessionId: string, maxModelCalls: number) => TaskAgent | string;

export interface TaskQueueOptions {
  readonly projectId: string;
  readonly store: TaskStore;
  readonly agentFor: TaskAgentFactory;
  /** Whether a foreground turn is running. The runner makes no call while it is. */
  readonly foregroundBusy: () => boolean;
  /** Whether the browser can guarantee one runner (Web Locks). Default: `navigator.locks` exists. */
  readonly locksAvailable?: () => boolean;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly newId?: () => string;
}

export type EnqueueResult = { readonly ok: true; readonly task: TaskRecord } | { readonly ok: false; readonly reason: string };

const NO_LOCKS = 'Background tasks need a browser feature this one does not have, so this plan can only run now.';
const NO_STORAGE = 'This browser would not keep the task, so this plan can only run now.';

function browserHasLocks(): boolean {
  return (globalThis as { navigator?: { locks?: unknown } }).navigator?.locks !== undefined;
}

export class TaskQueue {
  private tasks: TaskRecord[] = [];
  private readonly listeners = new Set<() => void>();
  /** Closed until `open` has read the project's tasks, and again after `close`. */
  private closed = true;
  private active: { readonly id: string; readonly abort: AbortController; reason: 'cancelled' | 'interrupted' } | null = null;
  private pumping: Promise<void> | null = null;

  constructor(private readonly options: TaskQueueOptions) {}

  private now = (): number => (this.options.now ?? Date.now)();
  private sleep = (ms: number): Promise<void> => (this.options.sleep ?? ((wait: number) => new Promise<void>((resolve) => setTimeout(resolve, wait))))(ms);

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The project's tasks, oldest first. */
  snapshot = (): readonly TaskRecord[] => this.tasks;

  /** Why the queue cannot take a plan, in a sentence, or `null` when it can. */
  unavailable(): string | null {
    if (!(this.options.locksAvailable ?? browserHasLocks)()) return NO_LOCKS;
    if (!this.options.store.available) return NO_STORAGE;
    return null;
  }

  /** Whether a task is being staged or waits to be: what the leave prompt warns about. */
  working(): boolean {
    return this.tasks.some((task) => task.status === 'running' || task.status === 'queued');
  }

  /**
   * Reads the project's tasks. A task a closed tab left running or waiting is interrupted, and the tasks no one will open are pruned.
   * Safe to call again after `close`: a project shown again reads its tasks anew.
   */
  async open(): Promise<void> {
    const { store, projectId } = this.options;
    try {
      await store.prune(projectId, this.now());
      this.tasks = await store.list(projectId);
    } catch {
      // An unreadable database means no tasks are shown; the app keeps working without them.
      this.tasks = [];
    }
    for (const task of this.tasks) {
      if (task.status === 'running' || task.status === 'queued') await this.update(task.id, { status: 'interrupted' });
    }
    this.closed = false;
    this.notify();
  }

  /** Stops the runner. The task in flight is interrupted at its next boundary and can be resumed when the project is opened again. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.active !== null) {
      this.active.reason = 'interrupted';
      this.active.abort.abort();
    }
    await this.pumping;
    for (const task of this.tasks) {
      if (task.status === 'running' || task.status === 'queued') await this.update(task.id, { status: 'interrupted' });
    }
  }

  /** Queues a plan. It is refused, with the reason in words, when it cannot run unattended or the browser cannot guarantee one runner. */
  async enqueue(intent: string, steps: readonly PlanStep[]): Promise<EnqueueResult> {
    const unavailable = this.unavailable();
    if (unavailable !== null) return { ok: false, reason: unavailable };
    if (this.closed) return { ok: false, reason: 'The project is not open here, so the plan can only run now.' };
    const eligible = backgroundEligibility(steps);
    if (!eligible.eligible) return { ok: false, reason: eligible.reason };
    const cap = estimatedModelCalls(steps);
    if (cap < 1) return { ok: false, reason: 'No step of this plan needs a model call.' };
    const at = this.now();
    const task: TaskRecord = {
      id: (this.options.newId ?? newTaskId)(),
      projectId: this.options.projectId,
      intent,
      steps,
      status: 'queued',
      items: itemsOf(steps),
      cap,
      used: 0,
      promptTokens: 0,
      completionTokens: 0,
      runs: 0,
      createdAt: at,
      updatedAt: at,
    };
    this.tasks = [...this.tasks, task];
    await this.persist(task);
    this.notify();
    this.start();
    return { ok: true, task };
  }

  /** Stops a task that is running or waiting. A cancelled task is over: its drafts are not offered for review. */
  async cancel(id: string): Promise<void> {
    const task = this.find(id);
    if (task === undefined) return;
    if (this.active?.id === id) {
      this.active.reason = 'cancelled';
      this.active.abort.abort();
    } else if (task.status === 'queued') {
      await this.update(id, { status: 'cancelled' });
    }
  }

  /** Puts an interrupted task back in the queue. Only its pending items are staged again, within the calls it has left. */
  async resume(id: string): Promise<void> {
    if (this.find(id)?.status !== 'interrupted' || this.closed || this.unavailable() !== null) return;
    await this.update(id, { status: 'queued' });
    this.start();
  }

  /** Removes a task that is not being staged. */
  async dismiss(id: string): Promise<void> {
    const task = this.find(id);
    if (task === undefined || task.status === 'running' || task.status === 'queued') return;
    this.tasks = this.tasks.filter((entry) => entry.id !== id);
    this.notify();
    try {
      await this.options.store.remove(this.options.projectId, id);
    } catch {
      // The record stays in the database until the next prune; it is gone from the list.
    }
  }

  /** The writer approved the task's review. */
  async markApplied(id: string): Promise<void> {
    if (this.find(id)?.status === 'ready') await this.update(id, { status: 'applied' });
  }

  /** What a review of a ready task is given, or `undefined` when the task is not ready. */
  review(id: string): { readonly task: TaskRecord; readonly review: TaskReview } | undefined {
    const task = this.find(id);
    return task?.status === 'ready' ? { task, review: reviewOf(task) } : undefined;
  }

  /** Resolves when the runner has nothing left to do. A test waits on it. */
  idle(): Promise<void> {
    return this.pumping ?? Promise.resolve();
  }

  /* ------------------------------------------------------------------ *
   * The runner
   * ------------------------------------------------------------------ */

  private find(id: string): TaskRecord | undefined {
    return this.tasks.find((task) => task.id === id);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private async persist(task: TaskRecord): Promise<void> {
    try {
      await this.options.store.save(task);
    } catch {
      // The task stays in this visit; it is lost to a reload. Staging goes on, because the drafts are still reviewable here.
    }
  }

  private async update(id: string, patch: Partial<Omit<TaskRecord, 'id' | 'projectId'>>): Promise<TaskRecord | undefined> {
    const task = this.find(id);
    if (task === undefined) return undefined;
    const next: TaskRecord = { ...task, ...patch, updatedAt: this.now() };
    this.tasks = this.tasks.map((entry) => (entry.id === id ? next : entry));
    this.notify();
    await this.persist(next);
    return next;
  }

  private async updateItem(id: string, key: string, patch: Partial<TaskItem>, extra: Partial<TaskRecord> = {}): Promise<void> {
    const task = this.find(id);
    if (task === undefined) return;
    await this.update(id, { ...extra, items: task.items.map((item) => (item.key === key ? { ...item, ...patch } : item)) });
  }

  private start(): void {
    if (this.pumping !== null || this.closed) return;
    this.pumping = this.pump().finally(() => {
      this.pumping = null;
    });
  }

  private async pump(): Promise<void> {
    while (!this.closed) {
      const next = this.tasks.find((task) => task.status === 'queued');
      if (next === undefined) return;
      await this.run(next.id);
    }
  }

  /** Waits while a foreground turn is busy. An in-flight call is never preempted; the next one waits its turn. */
  private async waitForForeground(signal: AbortSignal): Promise<void> {
    while (this.options.foregroundBusy() && !signal.aborted) await this.sleep(FOREGROUND_POLL_MS);
  }

  private async run(id: string): Promise<void> {
    const started = await this.update(id, { status: 'running', runs: (this.find(id)?.runs ?? 0) + 1 });
    if (started === undefined) return;
    const sessionId = started.runs === 1 ? started.id : `${started.id}.run${started.runs}`;
    const agent = this.options.agentFor(started, sessionId, Math.max(0, started.cap - started.used));
    const abort = new AbortController();
    const active: NonNullable<TaskQueue['active']> = { id, abort, reason: 'interrupted' };
    this.active = active;
    try {
      if (typeof agent === 'string') {
        for (const item of started.items) if (item.state === 'pending') await this.updateItem(id, item.key, { state: 'failed', error: agent });
      } else {
        for (const pending of started.items.filter((item) => item.state === 'pending')) {
          if (abort.signal.aborted) break;
          await this.waitForForeground(abort.signal);
          if (abort.signal.aborted) break;
          if (!(await this.stageItem(agent, id, pending.key, abort.signal))) break;
        }
      }
    } finally {
      this.active = null;
      await this.finish(id, abort.signal.aborted ? active.reason : undefined);
    }
  }

  /** Stages one item and records its outcome. Returns false when the stop ended it, so the run does not go on. */
  private async stageItem(agent: TaskAgent, id: string, key: string, signal: AbortSignal): Promise<boolean> {
    const task = this.find(id);
    const item = task?.items.find((entry) => entry.key === key);
    if (task === undefined || item === undefined) return true;
    const calls = callsOfItem(task, item);
    if (task.used + calls > task.cap) {
      await this.updateItem(id, key, {
        state: 'failed',
        error: `This step needs ${calls} model ${calls === 1 ? 'call' : 'calls'}, which would go past the task's limit of ${task.cap}.`,
      });
      return true;
    }
    let result: StageOnlyResult;
    try {
      result = await agent.stageOnly([stepOfItem(task, item)], { signal });
    } catch (error) {
      await this.updateItem(id, key, { state: 'failed', error: `The model call failed: ${error instanceof Error ? error.message : String(error)}` });
      return !signal.aborted;
    }
    const spent = {
      used: (this.find(id)?.used ?? 0) + result.modelCalls,
      promptTokens: (this.find(id)?.promptTokens ?? 0) + result.tokens.promptTokens,
      completionTokens: (this.find(id)?.completionTokens ?? 0) + result.tokens.completionTokens,
    };
    if (result.stopped) {
      await this.update(id, spent);
      return false;
    }
    const proposal = result.proposals[0];
    if (proposal === undefined || result.refusals.length > 0) {
      const why = result.refusals[0]?.message ?? 'The model returned nothing for this step.';
      await this.updateItem(id, key, { state: 'failed', error: why }, spent);
    } else {
      await this.updateItem(id, key, { state: 'staged', proposal, revisions: result.revisions[0] ?? {} }, spent);
    }
    return true;
  }

  /** Settles a task after its run: over, if the writer or the tab ended it, otherwise ready to review or failed. */
  private async finish(id: string, ended: 'cancelled' | 'interrupted' | undefined): Promise<void> {
    const task = this.find(id);
    if (task === undefined) return;
    const status: TaskStatus = ended ?? (task.items.some((item) => item.state === 'staged') ? 'ready' : 'failed');
    await this.update(id, { status });
  }
}
