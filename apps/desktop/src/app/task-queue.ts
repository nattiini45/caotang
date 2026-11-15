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

import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg, plural, t } from '@lingui/core/macro';
import { backgroundEligibility, contextOverridesOk, estimatedModelCalls, reviewCallBoundOk, type AgentSession, type ContextOverrides, type PlanStep, type ReviewCallBound, type StageOnlyResult } from '@caotang/harness';
import type { ReviewCheckpoint } from '@caotang/coherence';
import { canMove } from '@caotang/machine';
import { newId } from '@caotang/ids';
import { copyContext } from './context-choices.js';
import { reviewCallCap, type QueuedReviewApproval } from './queued-review.js';

import {
  callsOfItem,
  itemsOf,
  newTaskId,
  reviewOf,
  stepOfItem,
  taskStatusTable,
  type TaskItem,
  type TaskKind,
  type TaskRecord,
  type TaskReview,
  type TaskReviewPhase,
  type TaskReviewReport,
  type TaskQueueStatus,
  type TaskStatusEvent,
  type TaskStore,
} from './task-store.js';

/** How long the runner waits before it asks again whether the foreground turn is still busy. */
export const FOREGROUND_POLL_MS = 250;

const newReviewRunId = (): string => newId('r');

/** What the queue asks of an agent session: staging, and nothing else. */
export type TaskAgent = Pick<AgentSession, 'stageOnly'>;

/**
 * Builds the session a run stages with, or says why there is none. `sessionId` names the run's turns in the ledger, and `maxModelCalls`
 * is what the task has left.
 */
export type TaskAgentFactory = (task: TaskRecord, sessionId: string, maxModelCalls: number) => TaskAgent | string | Promise<TaskAgent | string>;

export interface TaskReviewHost {
  readonly signal: AbortSignal;
  reserve(): Promise<void>;
  fence(): void;
  checkpoint(checkpoint: ReviewCheckpoint): Promise<void>;
  phase(phase: TaskReviewPhase, done: number, total: number): Promise<void>;
}

export type TaskReviewRunner = (task: TaskRecord, host: TaskReviewHost) => Promise<{ readonly status: 'complete' | 'partial' | 'cancelled' | 'failed'; readonly report?: TaskReviewReport; readonly error?: string }>;

export type TaskReviewFactory = (task: TaskRecord, sessionId: string) => TaskReviewRunner | string | Promise<TaskReviewRunner | string>;

export interface TaskQueueOptions {
  readonly projectId: string;
  readonly store: TaskStore;
  readonly agentFor: TaskAgentFactory;
  readonly reviewFor?: TaskReviewFactory;
  /** Whether a foreground turn is running. The runner makes no call while it is. */
  readonly foregroundBusy: () => boolean;
  /** Whether the browser can guarantee one runner (Web Locks). Default: `navigator.locks` exists. */
  readonly locksAvailable?: () => boolean;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly newId?: () => string;
}

export type EnqueueResult = { readonly ok: true; readonly task: TaskRecord } | { readonly ok: false; readonly reason: string; readonly cancelled?: true };

export interface TaskSnapshot extends TaskRecord {
  readonly phase?: TaskQueueStatus;
}

/* lingui-set comment="Interpolated values: calls, cap, error" */

const NO_LOCKS: MessageDescriptor = msg`Background tasks need a browser feature this one does not have, so this plan can only run now.`;
const NO_STORAGE: MessageDescriptor = msg`This browser would not keep the task, so this plan can only run now.`;

function browserHasLocks(): boolean {
  return (globalThis as { navigator?: { locks?: unknown } }).navigator?.locks !== undefined;
}

export class TaskQueue {
  private tasks: TaskRecord[] = [];
  private readonly listeners = new Set<() => void>();
  /** Closed until `open` has read the project's tasks, and again after `close`. */
  private closed = true;
  private active: { readonly id: string; readonly abort: AbortController; kind: TaskQueueStatus } | null = null;
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
  snapshot = (): readonly TaskSnapshot[] => this.tasks.map((task) => ({ ...task, phase: this.phase(task) }));

  /** Why the queue cannot take a plan, in a sentence, or `null` when it can. */
  unavailable(): string | null {
    if (!(this.options.locksAvailable ?? browserHasLocks)()) return i18n._(NO_LOCKS);
    if (!this.options.store.available) return i18n._(NO_STORAGE);
    return null;
  }

  /** Whether a task is being staged or waits to be: what the leave prompt warns about. */
  working(): boolean {
    return this.active !== null || this.tasks.some((task) => task.status === 'running' || task.status === 'queued');
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
      if (canMove(taskStatusTable, task.status, 'reload')) await this.move(task.id, 'reload');
    }
    this.closed = false;
    this.notify();
  }

  /** Stops the runner. The task in flight is interrupted at its next boundary and can be resumed when the project is opened again. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.active !== null) {
      const moving = this.move(this.active.id, 'close');
      this.active.abort.abort();
      await moving;
    }
    await this.pumping;
    for (const task of this.tasks) {
      await this.move(task.id, 'close');
    }
  }

  /** Queues a plan. It is refused, with the reason in words, when it cannot run unattended or the browser cannot guarantee one runner. */
  async enqueue(intent: string, steps: readonly PlanStep[], contextOverrides?: ContextOverrides, review?: QueuedReviewApproval, signal?: AbortSignal): Promise<EnqueueResult> {
    const cancelled = (): boolean => signal?.aborted === true;
    if (cancelled()) return { ok: false, reason: t`Cancelled before it started.`, cancelled: true };
    const unavailable = this.unavailable();
    if (unavailable !== null) return { ok: false, reason: unavailable };
    if (this.closed) return { ok: false, reason: t`The project is not open here, so the plan can only run now.` };
    if ((contextOverrides !== undefined && !contextOverridesOk(contextOverrides)) || steps.some((step) => step.contextOverrides !== undefined && !contextOverridesOk(step.contextOverrides))) {
      return { ok: false, reason: t`The context choices could not be kept. Run this plan here, or send the request again.` };
    }
    const reviewSteps = steps.filter((step) => step.tool === 'coherence.review');
    if (reviewSteps.length > 1) return { ok: false, reason: t`Queue one coherence review at a time. Split this plan into one review per task.` };
    if (reviewSteps.length === 1 && review === undefined) return { ok: false, reason: t`A coherence review needs its approved estimate before it can be queued. Run it here, or approve the queue preview.` };
    if (review !== undefined && reviewSteps.length === 0) return { ok: false, reason: t`This plan has no coherence review to queue.` };
    if (review !== undefined && this.options.reviewFor === undefined) return { ok: false, reason: t`This browser cannot run a queued review here, so the review can only run now.` };
    const bounds: (ReviewCallBound | undefined)[] = steps.map((step) => (step.tool === 'coherence.review' ? review?.callBound : undefined));
    const eligible = backgroundEligibility(steps, bounds);
    if (!eligible.eligible) return { ok: false, reason: eligible.reason };
    const cap = estimatedModelCalls(steps, bounds);
    if (cap < 1) return { ok: false, reason: t`No step of this plan needs a model call.` };
    if (review !== undefined && (!reviewCallBoundOk(review.callBound) || reviewCallCap(review.callBound) < 1 || review.fingerprint === '')) {
      return { ok: false, reason: t`The review's approval could not be kept. Approve the queue preview again.` };
    }
    const kind: TaskKind = review === undefined ? 'draft' : steps.some((step) => step.tool !== 'coherence.review') ? 'mixed' : 'review';
    const at = this.now();
    const task: TaskRecord = {
      id: (this.options.newId ?? newTaskId)(),
      projectId: this.options.projectId,
      intent,
      steps: structuredClone(steps),
      ...(contextOverrides === undefined ? {} : { contextOverrides: copyContext(contextOverrides) }),
      status: 'queued',
      items: itemsOf(steps),
      cap,
      used: 0,
      promptTokens: 0,
      completionTokens: 0,
      runs: 0,
      createdAt: at,
      updatedAt: at,
      kind,
      ...(review === undefined ? {} : { review: structuredClone(review), reviewRunId: newReviewRunId() }),
    };
    if (review !== undefined) {
      try {
        await this.options.store.save(task);
      } catch {
        return { ok: false, reason: t`This browser would not keep the review, so it can only run now.` };
      }
    } else {
      await this.persist(task);
    }
    if (cancelled() || this.closed) {
      const reason = cancelled() ? t`Cancelled before it started.` : t`The project closed before the review could start.`;
      try {
        await this.options.store.save({ ...task, status: 'cancelled', updatedAt: this.now() });
      } catch {
        return { ok: false, reason: t`The review will not run here, but this browser could not keep that record. Check Tasks after reopening the project.` };
      }
      return { ok: false, reason, cancelled: true };
    }
    this.tasks = [...this.tasks, task];
    this.notify();
    this.start();
    return { ok: true, task };
  }

  /** Stops a task that is running or waiting. A cancelled task is over: its drafts are not offered for review. */
  async cancel(id: string): Promise<void> {
    const task = this.find(id);
    if (task === undefined) return;
    if (this.active?.id === id) {
      if (!canMove(taskStatusTable, this.active.kind, 'cancel')) return;
      const moving = this.move(id, 'cancel');
      this.active.abort.abort();
      await moving;
    } else if (canMove(taskStatusTable, task.status, 'cancel') && task.status === 'queued') {
      await this.move(id, 'cancel');
    }
  }

  /** Puts an interrupted task back in the queue. Only its pending items are staged again, within the calls it has left. */
  async resume(id: string): Promise<void> {
    const task = this.find(id);
    if (task === undefined || !canMove(taskStatusTable, this.phase(task), 'resume') || this.active?.id === id || this.closed || this.unavailable() !== null) return;
    await this.move(id, 'resume');
    this.start();
  }

  /** Removes a task that is not being staged. */
  async dismiss(id: string): Promise<void> {
    const task = this.find(id);
    if (task === undefined || this.active?.id === id || canMove(taskStatusTable, task.status, 'pump')) return;
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
    await this.move(id, 'apply');
  }

  async acknowledge(id: string): Promise<void> {
    const task = this.find(id);
    if (task === undefined || task.report === undefined || task.acknowledged === true) return;
    await this.update(id, { acknowledged: true });
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

  private phase(task: TaskRecord): TaskQueueStatus {
    return this.active?.id === task.id ? this.active.kind : task.status;
  }

  private async move(id: string, event: TaskStatusEvent): Promise<void> {
    const task = this.find(id);
    if (task === undefined) return;
    const from = this.phase(task);
    if (!canMove(taskStatusTable, from, event)) return;
    const to = taskStatusTable.on[from][event]?.[0];
    if (to === undefined) return;
    if (this.active?.id === id) this.active.kind = to;
    if (to === 'starting' || to === 'cancelling' || task.status === to) {
      this.notify();
      return;
    }
    await this.update(id, { status: to });
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

  private async updateStrict(id: string, patch: Partial<Omit<TaskRecord, 'id' | 'projectId'>>): Promise<TaskRecord | undefined> {
    const task = this.find(id);
    if (task === undefined) return undefined;
    const next: TaskRecord = { ...task, ...patch, updatedAt: this.now() };
    await this.options.store.save(next);
    this.tasks = this.tasks.map((entry) => (entry.id === id ? next : entry));
    this.notify();
    return next;
  }

  private async updateItem(id: string, key: string, patch: Partial<TaskItem>, extra: Partial<TaskRecord> = {}): Promise<void> {
    const task = this.find(id);
    if (task === undefined) return;
    await this.update(id, { ...extra, items: task.items.map((item) => (item.key === key ? { ...item, ...patch } : item)) });
  }

  private start(): void {
    if (this.pumping !== null || this.closed) return;
    this.pumping = Promise.resolve().then(() => this.pump()).finally(() => {
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
    const abort = new AbortController();
    const active: NonNullable<TaskQueue['active']> = { id, abort, kind: 'queued' };
    this.active = active;
    try {
      await this.move(id, 'pump');
      const started = await this.update(id, { status: 'running', runs: (this.find(id)?.runs ?? 0) + 1 });
      if (started === undefined || abort.signal.aborted) return;
      const sessionId = started.runs === 1 ? started.id : started.id + '.run' + started.runs;
      const bounds = started.steps.map((step) => (step.tool === 'coherence.review' ? started.review?.callBound : undefined));
      const eligible = backgroundEligibility(started.steps, bounds);
      const pending = started.items.filter((item) => item.state === 'pending');
      const hasDrafts = pending.some((item) => started.steps[item.step]?.tool !== 'coherence.review');
      let agent: TaskAgent | string | undefined;
      try {
        if (!eligible.eligible) agent = eligible.reason;
        else if (hasDrafts) agent = await this.options.agentFor(started, sessionId, Math.max(0, started.cap - started.used));
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        agent = t`The agent could not be started: ${{ error: errorText }}`;
      }
      if (abort.signal.aborted) return;
      if (!eligible.eligible) {
        for (const item of pending) await this.updateItem(id, item.key, { state: 'failed', error: agent as string });
        return;
      }
      await this.move(id, 'agent-ready');
      for (const item of pending) {
        if (abort.signal.aborted) break;
        await this.waitForForeground(abort.signal);
        if (abort.signal.aborted) break;
        const step = stepOfItem(started, item);
        if (step.tool === 'coherence.review') {
          if (!(await this.runReviewItem(id, item.key, sessionId, abort.signal))) break;
          continue;
        }
        if (agent === undefined || typeof agent === 'string') {
          await this.updateItem(id, item.key, { state: 'failed', error: agent ?? t`The agent could not be started.` });
          continue;
        }
        if (!(await this.stageItem(agent, id, item.key, abort.signal))) break;
      }
    } finally {
      await this.finish(id);
      this.active = null;
    }
  }

  private async runReviewItem(id: string, key: string, sessionId: string, signal: AbortSignal): Promise<boolean> {
    const task = this.find(id);
    const review = task?.review;
    const factory = this.options.reviewFor;
    if (task === undefined || review === undefined || factory === undefined) return true;
    let runner: TaskReviewRunner | string;
    try {
      runner = await factory(task, sessionId);
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      runner = t`The review could not be started: ${{ error: errorText }}`;
    }
    if (signal.aborted) return false;
    if (typeof runner === 'string') {
      await this.updateItem(id, key, { state: 'failed', error: runner });
      return true;
    }
    // The checkpoint's tokens cover the review alone; the task's totals also hold any drafting staged before it.
    // On resume the stored totals already include the checkpoint's earlier review tokens, so subtract them once.
    const basePrompt = Math.max(0, task.promptTokens - (task.reviewCheckpoint?.promptTokens ?? 0));
    const baseCompletion = Math.max(0, task.completionTokens - (task.reviewCheckpoint?.completionTokens ?? 0));
    const host: TaskReviewHost = {
      signal,
      reserve: async () => {
        await this.waitForForeground(signal);
        const current = this.find(id);
        if (current === undefined || signal.aborted || this.closed) throw new Error(t`The project closed before the review could continue.`);
        if (current.used >= current.cap) throw new Error(t`The review reached its approved limit of ${{ cap: current.cap }} model calls.`);
        await this.updateStrict(id, { used: current.used + 1 });
      },
      fence: () => {
        if (signal.aborted || this.closed) throw new Error(t`The project closed before the review could continue.`);
      },
      checkpoint: async (checkpoint) => {
        await this.updateStrict(id, { reviewCheckpoint: checkpoint, promptTokens: basePrompt + checkpoint.promptTokens, completionTokens: baseCompletion + checkpoint.completionTokens });
      },
      phase: async (phase, done, totalCalls) => {
        await this.updateStrict(id, { reviewPhase: phase, reviewProgress: { done, total: totalCalls } });
      },
    };
    let outcome: Awaited<ReturnType<TaskReviewRunner>>;
    try {
      outcome = await runner(task, host);
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      outcome = { status: signal.aborted ? 'cancelled' : 'failed', error: errorText };
    }
    if (outcome.status === 'cancelled' || (signal.aborted && outcome.report === undefined)) {
      return false;
    }
    if (outcome.status === 'failed') {
      await this.updateItem(id, key, { state: 'failed', error: outcome.error ?? t`The review failed.` });
      return true;
    }
    await this.updateItem(id, key, { state: 'staged', ...(outcome.report === undefined ? {} : { proposal: outcome.report }) }, {
      ...(outcome.report === undefined ? {} : { report: outcome.report }),
      reviewPhase: undefined,
    });
    return true;
  }

  /** Stages one item and records its outcome. Returns false when the stop ended it, so the run does not go on. */
  private async stageItem(agent: TaskAgent, id: string, key: string, signal: AbortSignal): Promise<boolean> {
    const task = this.find(id);
    const item = task?.items.find((entry) => entry.key === key);
    if (task === undefined || item === undefined) return true;
    const calls = callsOfItem(task, item);
    if (task.used + calls > task.cap) {
      const cap = task.cap;
      await this.updateItem(id, key, {
        state: 'failed',
        error: t`This step needs ${{ calls }} model ${plural(calls, { one: 'call', other: 'calls' })}, which would go past the task's limit of ${{ cap }}.`,
      });
      return true;
    }
    let result: StageOnlyResult;
    try {
      result = await agent.stageOnly([stepOfItem(task, item)], { signal, ...(task.contextOverrides === undefined ? {} : { contextOverrides: copyContext(task.contextOverrides) }) });
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      await this.updateItem(id, key, { state: 'failed', error: t`The model call failed: ${{ error: errorText }}` });
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
      const why = result.refusals[0]?.message ?? t`The model returned nothing for this step.`;
      await this.updateItem(id, key, { state: 'failed', error: why }, spent);
    } else {
      await this.updateItem(id, key, { state: 'staged', proposal, revisions: result.revisions[0] ?? {} }, spent);
    }
    return true;
  }

  /** Settles a task after its run: over, if the writer or the tab ended it, otherwise ready to review or failed. */
  private async finish(id: string): Promise<void> {
    const task = this.find(id);
    if (task === undefined) return;
    const phase = this.phase(task);
    if (phase === 'cancelling' && task.report !== undefined) {
      await this.move(id, task.kind === 'review' ? 'complete' : 'ready');
      return;
    }
    if (phase === 'cancelling' || phase === 'interrupted') {
      await this.move(id, 'settle');
      return;
    }
    if (task.kind === 'review') {
      await this.move(id, task.report !== undefined ? 'complete' : 'fail');
      return;
    }
    if (task.kind === 'mixed') {
      const draftStaged = task.items.some((item) => item.state === 'staged' && task.steps[item.step]?.tool !== 'coherence.review');
      const hasDeferred = task.steps.some((step, index) => step.tool !== 'coherence.review' && !task.items.some((item) => item.step === index));
      await this.move(id, task.report !== undefined || draftStaged || hasDeferred ? 'ready' : 'fail');
      return;
    }
    await this.move(id, task.items.some((item) => item.state === 'staged') ? 'ready' : 'fail');
  }
}
