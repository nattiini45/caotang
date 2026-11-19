/**
 * The recurring tasks of one open project (agent-harness.md §12): which are due, what the writer is offered, and the runs.
 *
 * ## Offered, never sprung
 *
 * A task that is due shows a card with Run now and Skip. Nothing the card offers starts until the writer clicks, with two exceptions
 * (`effectiveWhenDue`): a `scan` task whose file says `run` starts by itself, because it reads the project, calls no model and sends
 * nothing anywhere; and a `plan` task whose file says `run` starts by itself once the writer has allowed exactly that task on this
 * machine (task-consents.ts, keyed by its `bodyHash`) and it has a call cap. Such a run is staged in the background queue: its drafts
 * wait in the Inbox for the writer's ordinary approval, and nothing applies by itself. An `intent` task is always offered: planning an
 * instruction unattended is not built yet (#685), and the panel says so on the task.
 *
 * ## Only while the project is open
 *
 * There is no background process. Due tasks are evaluated as the project opens and then every minute while the tab is visible, so a
 * task that came due while the tab was closed or hidden is offered when the writer is back. A task missed for days is due once.
 *
 * ## What a run may do
 *
 * A run the writer starts is an ordinary agent turn under the Background role, in the lowest of the task's permission, the app's mode
 * setting and the panel's mode (`effectiveMode`): the file can only lower a run. Its cards are the writer's, as in any turn. A scan
 * honours the same read rules the agent's scans do (`harness.withheld`), and appends its findings through the session like the
 * Findings tab's scan. When a run ends it is recorded on this machine (task-runs.ts) with the model requests and tokens it used.
 *
 * The tasks themselves are definitions in `tasks.json` and are changed here, by the writer. The agent has no tool for them.
 */

import { plural, t } from '@lingui/core/macro';
import { DETERMINISTIC_CHECK_IDS, type DeterministicCheckId } from '@caotang/coherence';
import type { PlanStep } from '@caotang/harness';
import { recurringRunTable, stepRecurringRun, type RecurringRunState, type RecurringRunEvent } from './recurring-state.js';
import { requestInkCompilerFor } from './ink-compiler.js';
import {
  TASKS_LIMIT,
  bodyHash,
  checkTask,
  dueTasks,
  effectiveMode,
  effectiveWhenDue,
  newTaskId,
  planText,
  readPlanText,
  selfStartProblem,
  usesModel,
  type AgentTask,
  type TaskBody,
  type TaskPermission,
  type TaskRunRecord,
  type TaskSchedule,
  type TasksFile,
  type Weekday,
  type WhenDue,
} from '@caotang/tasks';

import type { AgentController } from './agent.js';
import type { ProjectSession } from './session.js';
import { TaskConsents } from './task-consents.js';
import { TaskRuns } from './task-runs.js';
import type { TasksStatus } from './tasks-io.js';

/** How often the due tasks are looked at while the tab is visible. */
export const EVALUATE_EVERY_MS = 60_000;

/** The sentence an instruction saved as `run` gets in the panel: planning it unattended is not built yet. */
export function selfStartNote(): string {
  return t`An instruction needs a plan before it can start by itself. Give this task a plan, or run it when it is offered.`;
}

/** A valid first plan for the editor: a scan step, so a writer who chooses Run a plan starts from steps that parse and can edit them. */
export function planStarter(): string {
  return planText([{ tool: 'coherence.scan', params: { scope: { mode: 'changed' } }, expect: t`A scan is recorded` }]);
}

/** What a plan saved as `run` is told about its allowance: none yet, or voided by an edit. */
export function planSelfStartNote(consent: 'none' | 'stale' = 'none'): string {
  return consent === 'none'
    ? t`This plan is offered when it is due. Allow it to start by itself to stage its drafts in the Inbox for your review.`
    : t`This task changed since you allowed it to start by itself, so it is offered until you allow it again.`;
}

/** What the writer fills in to make or change a task. Every field is the text of a control. */
export interface TaskDraft {
  readonly name: string;
  readonly body: TaskBody['kind'];
  /** The instruction of an `intent` task. */
  readonly text: string;
  /** The steps of a `plan` task, as the JSON the writer edits (`planText`). */
  readonly steps: string;
  /** What a `scan` task looks at. */
  readonly scope: 'full' | 'changed';
  readonly schedule: TaskSchedule['kind'];
  readonly at: string;
  readonly day: Weekday;
  readonly whenDue: WhenDue;
  readonly permission: TaskPermission;
  /** The cap on model calls, as typed; empty means none. */
  readonly maxModelCalls: string;
}

export const EMPTY_DRAFT: TaskDraft = {
  name: '',
  body: 'intent',
  text: '',
  steps: '',
  scope: 'changed',
  schedule: 'daily',
  at: '09:00',
  day: 'mon',
  whenDue: 'offer',
  permission: 'ask',
  maxModelCalls: '',
};

export function draftOf(task: AgentTask): TaskDraft {
  return {
    name: task.name,
    body: task.body.kind,
    text: task.body.kind === 'intent' ? task.body.text : '',
    steps: task.body.kind === 'plan' ? planText(task.body.steps) : '',
    scope: task.body.kind === 'scan' ? task.body.scope : 'changed',
    schedule: task.schedule.kind,
    at: task.schedule.kind === 'daily' || task.schedule.kind === 'weekly' ? task.schedule.at : '09:00',
    day: task.schedule.kind === 'weekly' ? task.schedule.day : 'mon',
    whenDue: task.whenDue,
    permission: task.permission,
    maxModelCalls: task.maxModelCalls === undefined ? '' : String(task.maxModelCalls),
  };
}

/** The task a draft describes. `steps` are the plan's, already read from `draft.steps` by `readPlanText`; `existing` supplies the enabled switch and a scan's checks. */
export function taskOf(draft: TaskDraft, id: string, existing?: AgentTask, steps: readonly PlanStep[] = []): AgentTask {
  const body: TaskBody =
    draft.body === 'intent'
      ? { kind: 'intent', text: draft.text.trim() }
      : draft.body === 'scan'
        ? { kind: 'scan', scope: draft.scope, ...(existing?.body.kind === 'scan' && existing.body.checks !== undefined ? { checks: existing.body.checks } : {}) }
        : { kind: 'plan', steps };
  const schedule: TaskSchedule =
    draft.schedule === 'daily'
      ? { kind: 'daily', at: draft.at }
      : draft.schedule === 'weekly'
        ? { kind: 'weekly', day: draft.day, at: draft.at }
        : { kind: draft.schedule };
  // A scan calls no model, so a cap typed before the writer chose a scan is not kept.
  const cap = draft.body === 'scan' || draft.maxModelCalls.trim() === '' ? undefined : Number(draft.maxModelCalls);
  return {
    id,
    name: draft.name.trim(),
    enabled: existing?.enabled ?? true,
    schedule,
    whenDue: draft.whenDue,
    body,
    permission: draft.permission,
    ...(cap === undefined ? {} : { maxModelCalls: cap }),
  };
}

export interface RunView extends TaskRunRecord {
  /** A Restore to before this run can be offered: the app still holds the turn and it wrote something. */
  readonly canRestore: boolean;
}

export interface TaskRowView {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly body: TaskBody['kind'];
  /** What the task does, in a line. */
  readonly doing: string;
  readonly schedule: string;
  readonly usesModel: boolean;
  /** Why the task cannot run or be saved as it is, or `null`. */
  readonly problem: string | null;
  /** Said when the file asks for more than this build gives (a model task saved as `run`). */
  readonly note: string | null;
  readonly permission: TaskPermission;
  readonly maxModelCalls: number | null;
  readonly running: boolean;
  /** A consented run of this task is staging its drafts in the background queue. */
  readonly staging: boolean;
  /** Whether the task starts by itself as it stands: a scan that says so, or a consented, capped plan. */
  readonly selfStart: boolean;
  /** The writer's allowance for this task: none, current, or voided by an edit. `null` for a task that needs none. */
  readonly consent: 'none' | 'current' | 'stale' | null;
  /** Whether Allow to start by itself can be asked for: a capped plan that says `run` and can run. */
  readonly canAllow: boolean;
  readonly fingerprint: string;
  readonly history: readonly RunView[];
  readonly draft: TaskDraft;
}

export interface OfferView {
  readonly id: string;
  readonly name: string;
  readonly doing: string;
  readonly usesModel: boolean;
  readonly maxModelCalls: number | null;
}

export interface RecurringSnapshot {
  readonly attached: boolean;
  readonly tasks: readonly TaskRowView[];
  readonly offers: readonly OfferView[];
  /** The id of the task a run is under way for. */
  readonly running: string | null;
  readonly status: TasksStatus;
  /** What a screen reader should hear: a task newly due, a run's end. */
  readonly announcement: string;
  /** Why the last action did not do what was asked. */
  readonly message: string | null;
}

export interface RecurringOptions {
  readonly session: ProjectSession;
  readonly agent: AgentController;
  /** The checks Settings › Coherence has on, read at each scan. */
  readonly enabledChecks?: () => readonly DeterministicCheckId[];
  /** The histories, when the caller has them open already; otherwise they are read from the app database when the controller attaches. */
  readonly runs?: TaskRuns;
  /** The consents, when the caller has them open already; otherwise they are read from the app database when the controller attaches. */
  readonly consents?: TaskConsents;
  readonly now?: () => Date;
  readonly timeZone?: () => string;
  readonly visible?: () => boolean;
  /** Calls `tick` every `ms` until the returned function is called. Default: `setInterval`. */
  readonly every?: (tick: () => void, ms: number) => () => void;
}

const NO_TASKS: TasksStatus = { writable: false, notices: [], saveFailure: null };

const defaultVisible = (): boolean => typeof document === 'undefined' || (document as { visibilityState?: string }).visibilityState !== 'hidden';

function defaultEvery(tick: () => void, ms: number): () => void {
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
}

const cut = (text: string, limit = 280): string => (text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`);

/* lingui-set comment="Recurring tasks' notices. Interpolated values: name and names are task names, count is a number of tasks, problem and error are refusal and failure messages, skipped is a list of check names." */

export class RecurringTasks {
  private runs: TaskRuns | null;
  private consents: TaskConsents | null;
  private readonly listeners = new Set<() => void>();
  private snapshotValue: RecurringSnapshot;
  private attached = false;
  /** Counts the attaches, so one that was overtaken by a detach and a new attach (React runs an effect twice in development) does nothing. */
  private generation = 0;
  private runsOpening: Promise<TaskRuns> | null = null;
  private consentsOpening: Promise<TaskConsents> | null = null;
  /** Consented runs staging in the background queue: recurring task id to queue task id. Settled ones are recorded and removed. */
  private recordWork: Promise<void> = Promise.resolve();
  private readonly starting = new Map<string, AbortController>();
  private readonly disabling = new Set<string>();
  private opened = false;
  private stopTimer: (() => void) | null = null;
  private stopVisibility: (() => void) | null = null;
  private stopAgent: (() => void) | null = null;
  /** The tasks the writer has been offered and has not yet run or skipped. */
  private readonly offered = new Set<string>();
  /** The offers a screen reader has been told about. */
  private readonly announced = new Set<string>();
  private run: RecurringRunState = { kind: 'idle' };
  private get running(): string | null { return this.run.kind === 'idle' ? null : this.run.taskId; }
  private announcement = '';
  private message: string | null = null;
  private evaluating = false;

  private moveRun(event: RecurringRunEvent): void {
    const previous = this.run;
    this.run = stepRecurringRun(previous, event);
    if (this.run !== previous) this.options.agent.traceMachine({ machine: recurringRunTable.id, subjectId: event.taskId, from: previous.kind, event: event.type, to: this.run.kind });
  }

  constructor(private readonly options: RecurringOptions) {
    this.runs = options.runs ?? null;
    this.consents = options.consents ?? null;
    this.snapshotValue = this.build();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = (): RecurringSnapshot => this.snapshotValue;

  private bump(): void {
    this.snapshotValue = this.build();
    for (const listener of this.listeners) listener();
  }

  /** The panel that shows the tasks is on screen: read the histories, look at what is due as the project opens, and keep looking while the tab is visible. */
  async attach(): Promise<void> {
    if (this.attached) return;
    this.attached = true;
    const generation = (this.generation += 1);
    if (this.runs === null) {
      // One read of the histories however many times the panel attaches.
      this.runsOpening ??= TaskRuns.open(this.options.session.projectId);
      const runs = await this.runsOpening;
      if (generation !== this.generation) return;
      this.runs = runs;
    }
    if (this.consents === null) {
      this.consentsOpening ??= TaskConsents.open(this.options.session.projectId);
      const consents = await this.consentsOpening;
      if (generation !== this.generation) return;
      this.consents = consents;
    }
    const every = this.options.every ?? defaultEvery;
    this.stopTimer = every(() => void this.tick(), EVALUATE_EVERY_MS);
    // Back in the tab after a while away: look at once rather than at the next minute.
    const onVisible = (): void => void this.tick();
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisible);
      this.stopVisibility = () => document.removeEventListener('visibilitychange', onVisible);
    }
    // A turn that ends, or a restore, changes what a run's row can offer.
    this.stopAgent = this.options.agent.subscribe(() => {
      void this.recordSettledStaging();
      this.bump();
    });
    const opening = !this.opened;
    this.opened = true;
    await this.evaluate(opening);
  }

  /** The panel is gone. A run already started finishes and is recorded; nothing new starts. */
  detach(): void {
    this.attached = false;
    for (const abort of this.starting.values()) abort.abort();
    this.generation += 1;
    this.stopTimer?.();
    this.stopTimer = null;
    this.stopVisibility?.();
    this.stopVisibility = null;
    this.stopAgent?.();
    this.stopAgent = null;
  }

  private async tick(): Promise<void> {
    if (!this.attached || !(this.options.visible ?? defaultVisible)()) return;
    await this.evaluate(false);
  }

  private file(): TasksFile {
    return this.options.session.tasksHome()?.current() ?? { formatVersion: 1, tasks: [] };
  }

  private taskById(id: string): AgentTask | undefined {
    return this.file().tasks.find((task) => task.id === id);
  }

  /** Whether this build can start the task unattended: a scan, or a plan with model-backed steps and the cap the consent covers. */
  private stageable(task: AgentTask): boolean {
    if (task.body.kind === 'scan') return true;
    return task.body.kind === 'plan' && selfStartProblem(task) === undefined;
  }

  /**
   * Looks at what is due. A scan whose file says `run` starts now, and so does a consented, capped plan — staged in the background queue,
   * never applied. Every other due task becomes an offer. An offer stays until the writer runs or skips it, or the task is gone, switched
   * off or no longer readable. A run already staging is not started again; a staged run from an earlier visit is adopted and recorded.
   */
  async evaluate(opening = false): Promise<void> {
    if (this.runs === null || this.evaluating) return;
    const starting: AgentTask[] = [];
    this.evaluating = true;
    try {
      await this.recordSettledStaging();
      const file = this.file();
      const now = (this.options.now ?? (() => new Date()))();
      const timeZone = (this.options.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone))();
      const live = new Set(file.tasks.filter((task) => task.enabled && task.problem === undefined).map((task) => task.id));
      for (const id of [...this.offered]) if (!live.has(id)) this.offered.delete(id);
      // An offer that has gone (run, skipped, removed or switched off) is announced again when its task comes due again.
      for (const id of [...this.announced]) if (!this.offered.has(id)) this.announced.delete(id);
      for (const task of dueTasks(file, this.runs.lastRuns(), now, timeZone, opening)) {
        if (task.id === this.running || this.isStaging(task.id) || this.disabling.has(task.id)) continue;
        if (effectiveWhenDue(task, this.consents?.get(task.id)) === 'run' && this.stageable(task)) starting.push(task);
        else if (!this.offered.has(task.id)) this.offered.add(task.id);
      }
      const news = [...this.offered].filter((id) => !this.announced.has(id));
      for (const id of news) this.announced.add(id);
      if (news.length > 0) {
        const names = news.map((id) => this.taskById(id)?.name ?? '').filter((name) => name !== '');
        this.announcement = names.length === 1 ? t`Task due: ${{ name: names[0] ?? '' }}. Run now or Skip.` : t`${{ count: names.length }} tasks are due: ${{ names: names.join(', ') }}.`;
      }
      this.bump();
    } finally {
      this.evaluating = false;
    }
    for (const task of starting) {
      if (task.body.kind === 'plan') {
        await this.stageTask(task);
        continue;
      }
      if (this.running !== null) break;
      await this.runTask(task.id, 'due');
    }
  }

  /**
   * Stages a consented plan's drafts in the background queue. The queue's cap is the task's call cap; nothing applies, and the run is
   * recorded when staging settles. A refusal offers the task instead and records nothing, so it is still due next time.
   */
  private async stageTask(task: AgentTask): Promise<void> {
    const current = this.taskById(task.id);
    if (current === undefined || !current.enabled || current.body.kind !== 'plan' || this.isStaging(task.id) || this.disabling.has(task.id)) return;
    if (effectiveWhenDue(current, this.consents?.get(task.id)) !== 'run') return;
    const abort = new AbortController();
    this.starting.set(task.id, abort);
    this.message = null;
    let queued: Awaited<ReturnType<AgentController['queueRecurringPlan']>>;
    try {
      queued = await this.options.agent.queueRecurringPlan(current, abort.signal);
    } finally {
      this.starting.delete(task.id);
    }
    if (!queued.ok) {
      if (queued.cancelled === true) { this.bump(); return; }
      this.offered.add(task.id);
      this.message = queued.reason;
      this.bump();
      return;
    }
    await this.recordSettledStaging();
    this.offered.delete(task.id);
    this.announcement = t`${{ name: task.name }} is staging its drafts in the background. They will wait in the Inbox for your review.`;
    this.bump();
  }

  private recordSettledStaging(): Promise<void> {
    this.recordWork = this.recordWork.catch(() => undefined).then(async () => {
      if (this.runs === null) return;
      for (const view of this.options.agent.taskViews()) {
        const taskId = view.recurringTaskId;
        if (taskId === null || this.taskById(taskId) === undefined) continue;
        const status: TaskRunRecord['status'] =
          view.status === 'ready' ? 'ready' : view.status === 'applied' || view.status === 'completed' ? 'done'
          : view.status === 'failed' ? 'failed' : view.status === 'cancelled' || view.status === 'interrupted' ? 'stopped' : 'queued';
        const record = this.recordOf({ id: taskId }, 'due', status, view.statusText, {
          at: new Date(view.createdAt).toISOString(), queueTaskId: view.id,
          requests: view.used, promptTokens: view.promptTokens, completionTokens: view.completionTokens,
        });
        const previous = this.runs.history(taskId).find((run) => run.queueTaskId === view.id);
        if (JSON.stringify(previous) !== JSON.stringify(record)) await this.runs.record(record);
      }
      this.bump();
    });
    return this.recordWork;
  }

  private isStaging(taskId: string): boolean {
    return this.starting.has(taskId) || this.options.agent.taskViews().some((view) =>
      view.recurringTaskId === taskId && ['queued', 'starting', 'running', 'cancelling', 'interrupted'].includes(view.status));
  }

  private async cancelStaging(taskId: string): Promise<void> {
    this.starting.get(taskId)?.abort();
    for (const view of this.options.agent.taskViews()) {
      if (view.recurringTaskId === taskId && view.canCancel) await this.options.agent.cancelTask(view.id);
    }
  }

  /** Runs a task now: a due offer the writer accepted, or a task the writer started from the list. */
  async runNow(id: string): Promise<void> {
    await this.runTask(id, this.offered.has(id) ? 'due' : 'manual');
  }

  /** Declines an offer: it is not made again before the task's next occurrence. */
  async skip(id: string): Promise<void> {
    const task = this.taskById(id);
    if (task === undefined || this.runs === null) return;
    await this.cancelStaging(id);
    this.offered.delete(id);
    await this.runs.record({
      taskId: id,
      at: (this.options.now ?? (() => new Date()))().toISOString(),
      status: 'skipped',
      trigger: 'due',
      summary: t`Skipped by you.`,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
    });
    this.announcement = t`Skipped ${{ name: task.name }}.`;
    this.bump();
  }

  private async runTask(id: string, trigger: TaskRunRecord['trigger']): Promise<void> {
    const task = this.taskById(id);
    if (task === undefined || this.runs === null) return;
    this.message = null;
    if (this.running !== null || this.isStaging(id)) {
      this.message = t`Another task is running. Run this one when it has finished.`;
      this.bump();
      return;
    }
    const problem = task.problem ?? checkTask(task);
    if (problem !== undefined) {
      this.message = t`${{ name: task.name }} cannot run: ${problem}`;
      this.bump();
      return;
    }
    const blocked = task.body.kind === 'scan' ? this.scanBlockReason() : null;
    if (blocked !== null) {
      this.message = blocked;
      this.bump();
      return;
    }
    this.moveRun({ type: 'start', taskId: id });
    let record: TaskRunRecord;
    try {
      const execution = this.execute(task, trigger);
      if (execution === null) {
        this.moveRun({ type: 'finish', taskId: id });
        this.message = t`The agent is working on another turn. Run the task when it has finished.`;
        this.bump();
        return;
      }
      const wasOffered = this.offered.has(id);
      this.offered.delete(id);
      this.bump();
      const completed = await execution;
      if (completed === null) {
        if (wasOffered) this.offered.add(id);
        this.moveRun({ type: 'finish', taskId: id });
        this.bump();
        return;
      }
      record = completed;
    } catch (error) {
      record = this.recordOf(task, trigger, 'failed', t`The run stopped unexpectedly: ${{ error: error instanceof Error ? error.message : String(error) }}`);
    }
    this.moveRun({ type: 'record', taskId: id });
    try {
      await this.runs.record(record);
      this.announcement = `${task.name}: ${record.summary}`;
    } finally {
      this.moveRun({ type: 'finish', taskId: id });
      this.bump();
    }
  }

  private recordOf(task: { readonly id: string }, trigger: TaskRunRecord['trigger'], status: TaskRunRecord['status'], summary: string, extra: Partial<TaskRunRecord> = {}): TaskRunRecord {
    return {
      taskId: task.id,
      at: (this.options.now ?? (() => new Date()))().toISOString(),
      status,
      trigger,
      summary: cut(summary),
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      ...extra,
    };
  }

  private execute(task: AgentTask, trigger: TaskRunRecord['trigger']): Promise<TaskRunRecord | null> | null {
    const { agent } = this.options;
    if (task.body.kind === 'scan') return this.scan(task, task.body, trigger);
    // The file can only lower what a run may do: the lowest of its permission, the app's setting and the panel's mode.
    const mode = effectiveMode(task.permission, agent.settingMode(), agent.mode());
    const options = { role: 'background' as const, mode, ...(task.maxModelCalls === undefined ? {} : { maxModelCalls: task.maxModelCalls }) };
    const admitted = agent.trySubmit(task.body.kind === 'intent' ? task.body.text : task.name, options,
      task.body.kind === 'plan' ? { steps: task.body.steps } : undefined);
    if (!admitted.started) return null;
    return admitted.report.then((report) => {
      if (report === null) return this.recordOf(task, trigger, 'failed', agent.snapshot().message ?? t`The turn did not run.`);
      const status = report.status === 'failed' ? 'failed' : report.status === 'cancelled' ? 'stopped' : 'done';
      return this.recordOf(task, trigger, status, report.summary, {
        requests: report.tokens.requests,
        promptTokens: report.tokens.promptTokens,
        completionTokens: report.tokens.completionTokens,
        turnId: report.turnId,
      });
    });
  }

  /** A scan: the deterministic checks over the project as the agent may read it. It calls no model, so it sends nothing anywhere. */
  private scanBlockReason(): string | null {
    if (this.options.session.scanInFlight()) return t`A scan is already running. Wait for it to finish, or cancel it.`;
    if (this.options.session.coherenceReview.snapshot().kind === 'running') return t`A review is running. Wait for it to finish before scanning.`;
    return null;
  }

  private async scan(task: AgentTask, body: Extract<TaskBody, { kind: 'scan' }>, trigger: TaskRunRecord['trigger']): Promise<TaskRunRecord | null> {
    const { session } = this.options;
    const on = (this.options.enabledChecks ?? (() => DETERMINISTIC_CHECK_IDS))();
    const asked = body.checks ?? DETERMINISTIC_CHECK_IDS;
    const checks = asked.filter((id) => on.includes(id));
    if (checks.length === 0) return this.recordOf(task, trigger, 'failed', t`Every check this scan would run is turned off in Settings › Coherence, so nothing ran.`);
    // A document a read rule keeps from the agent is left out of this scan, as it is of the agent's own.
    // The harness is loaded on first use (lazy-harness.ts); a scan that starts as the project opens may come before any turn.
    const withheld = (await session.harnessReady()).withheld('coherence.scan');
    const browser = typeof document !== 'undefined' && typeof document.createElement === 'function';
    if (!browser) await requestInkCompilerFor(session.state);
    const blocked = this.scanBlockReason();
    if (blocked !== null) { this.message = blocked; return null; }
    const options = {
      approvedLargeScope: false,
      scope: body.scope === 'full' ? { mode: 'full' as const } : { mode: 'changed' as const },
      checks,
      withheld,
    };
    const result = browser ? await session.scanCoherenceAsync(options) : session.scanCoherence(options);
    if (!result.ok) return this.recordOf(task, trigger, result.code === 'cancelled' || result.code === 'closed' ? 'stopped' : 'failed', result.message);
    // A whole-project scan that had no document to read found nothing because it looked at nothing, which is not a clean result.
    if (body.scope === 'full' && result.data.documents === 0) {
      const why = withheld.size > 0 ? t` A rule in this project may be keeping the manuscript from the agent.` : '';
      return this.recordOf(task, trigger, 'failed', t`Nothing was scanned: no document was open to this scan.${why}`);
    }
    // The checks Settings › Coherence has off are left out, and the record says so, as the agent's own scan does.
    const skipped = asked.filter((id) => !on.includes(id));
    const left = skipped.length === 0 ? '' : t` Not run, because they are turned off in Settings › Coherence: ${{ skipped: skipped.join(', ') }}.`;
    return this.recordOf(task, trigger, 'done', `${result.summary}${left}`);
  }

  /* ------------------------------------------------------------------ *
   * Editing the definitions
   * ------------------------------------------------------------------ */

  /** Makes a task, or changes `id`. Resolves with why it was not saved, or `null`. */
  async save(draft: TaskDraft, id?: string): Promise<string | null> {
    const home = this.options.session.tasksHome();
    if (home === null) return t`This project has no tasks file to save to.`;
    const file = this.file();
    const existing = id === undefined ? undefined : file.tasks.find((task) => task.id === id);
    if (id !== undefined && existing === undefined) return t`That task is gone.`;
    if (existing === undefined && file.tasks.length >= TASKS_LIMIT) return t`A project keeps at most ${TASKS_LIMIT} tasks.`;
    const plan = draft.body === 'plan' ? readPlanText(draft.steps) : undefined;
    if (plan?.ok === false) return plan.message;
    const task = taskOf(draft, existing?.id ?? newTaskId(new Set(file.tasks.map((entry) => entry.id))), existing, plan?.steps);
    if (draft.maxModelCalls.trim() !== '' && !/^\d+$/.test(draft.maxModelCalls.trim())) return t`Limit model calls to a whole number from 1 to 100.`;
    const refusal = checkTask(task);
    if (refusal !== undefined) return refusal;
    if (existing !== undefined && bodyHash(existing) !== bodyHash(task)) {
      await this.cancelStaging(task.id);
      const revokeFailure = await this.consents?.revoke(task.id);
      if (revokeFailure !== undefined && revokeFailure !== null) return revokeFailure;
    }
    const failure = await home.save({ ...file, tasks: existing === undefined ? [...file.tasks, task] : file.tasks.map((entry) => (entry.id === task.id ? task : entry)) });
    this.bump();
    return failure;
  }

  async setEnabled(id: string, enabled: boolean): Promise<string | null> {
    const home = this.options.session.tasksHome();
    const file = this.file();
    if (home === null || !file.tasks.some((task) => task.id === id)) return t`That task is gone.`;
    if (!enabled) this.disabling.add(id);
    try {
      if (!enabled) await this.cancelStaging(id);
      return await home.save({ ...file, tasks: file.tasks.map((task) => (task.id === id ? { ...task, enabled } : task)) });
    } finally {
      this.disabling.delete(id);
      this.bump();
    }
  }

  async remove(id: string): Promise<string | null> {
    const home = this.options.session.tasksHome();
    const file = this.file();
    if (home === null || !file.tasks.some((task) => task.id === id)) return t`That task is gone.`;
    if (this.running === id) {
      this.message = t`That task is running. Delete it when it has finished.`;
      this.bump();
      return this.message;
    }
    this.offered.delete(id);
    await this.cancelStaging(id);
    const revokeFailure = await this.consents?.revoke(id);
    if (revokeFailure !== undefined && revokeFailure !== null) return revokeFailure;
    const failure = await home.save({ ...file, tasks: file.tasks.filter((task) => task.id !== id) });
    if (failure !== null) { this.bump(); return failure; }
    await this.runs?.forget(id);
    await this.consents?.forget(id);
    this.bump();
    return failure;
  }

  /**
   * The writer allows this task to start by itself, as it stands now: the consent names its body hash, so an edit to what it does, when,
   * with what permission or under what cap voids it. Only a capped plan that says `run` can be allowed; a scan needs no allowance, and an
   * instruction cannot start by itself yet. Resolves with why it was not kept, or `null`.
   */
  async allowSelfStart(id: string, expectedHash: string): Promise<string | null> {
    const task = this.taskById(id);
    if (task === undefined || this.consents === null) return t`That task is gone.`;
    if (bodyHash(task) !== expectedHash) return t`This task changed while its allowance was open. Review it again before allowing it.`;
    if (task.body.kind !== 'plan' || selfStartProblem(task) !== undefined || task.whenDue !== 'run') {
      return t`Only an eligible plan set to start by itself can be allowed. Model plans also need a call limit.`;
    }
    const failure = await this.consents.grant(id, bodyHash(task), (this.options.now ?? (() => new Date()))().toISOString());
    const current = this.taskById(id);
    if (failure === null && (current === undefined || bodyHash(current) !== expectedHash)) {
      const revokeFailure = await this.consents.revoke(id);
      this.bump();
      return revokeFailure ?? t`This task changed while its allowance was open. Review it again before allowing it.`;
    }
    if (failure === null) this.announcement = t`${{ name: task.name }} may start by itself. Its drafts will wait in the Inbox for your review.`;
    this.bump();
    return failure;
  }

  /** Takes the allowance back: the task is offered when due again. Resolves with why it was not taken back, or `null`. */
  async revokeSelfStart(id: string): Promise<string | null> {
    if (this.consents === null) return null;
    await this.cancelStaging(id);
    const failure = await this.consents.revoke(id);
    if (failure === null) {
      const task = this.taskById(id);
      if (task !== undefined) this.announcement = t`${{ name: task.name }} is offered when it is due again.`;
    }
    this.bump();
    return failure;
  }

  /** Restores the project to before a task's run, through the agent's own restore. */
  async restoreRun(turnId: string): Promise<string | null> {
    const outcome = await this.options.agent.restore(turnId);
    this.bump();
    return outcome.ok ? null : outcome.message;
  }

  /** Re-reads what the panel shows from the agent and the session: a turn that ended, a file that was saved. */
  refresh(): void {
    this.bump();
  }

  /* ------------------------------------------------------------------ *
   * The snapshot
   * ------------------------------------------------------------------ */

  private doing(task: AgentTask): string {
    switch (task.body.kind) {
      case 'intent':
        return cut(task.body.text, 160);
      case 'scan':
        return task.body.scope === 'full' ? t`Scan the whole manuscript for continuity problems` : t`Scan what changed since the last scan for continuity problems`;
      case 'plan': {
        const steps = task.body.steps.length;
        return plural(steps, { one: 'Run a plan of # step', other: 'Run a plan of # steps' });
      }
    }
  }

  /* The schedule in the words the panel shows. `scheduleWords` in @caotang/tasks
   * stays English; the panel's copy lives here so it goes through the catalogue. */
  private scheduleWords(schedule: TaskSchedule): string {
    switch (schedule.kind) {
      case 'manual':
        return t`Only when you run it`;
      case 'on-open':
        return t`Each time the project opens`;
      case 'daily':
        return t`Every day from ${{ at: schedule.at }}`;
      case 'weekly': {
        const day = { mon: t`Monday`, tue: t`Tuesday`, wed: t`Wednesday`, thu: t`Thursday`, fri: t`Friday`, sat: t`Saturday`, sun: t`Sunday` }[schedule.day];
        return t`Every ${{ day }} from ${{ at: schedule.at }}`;
      }
    }
  }

  private build(): RecurringSnapshot {
    const { session, agent } = this.options;
    const home = session.tasksHome();
    const runs = this.runs;
    const tasks = (home?.current().tasks ?? []).map((task): TaskRowView => {
      const model = usesModel(task);
      const history: RunView[] = (runs?.history(task.id) ?? []).map((run) => ({
        ...run,
        canRestore: run.turnId !== undefined && agent.canRestore(run.turnId),
      }));
      const held = this.consents?.get(task.id);
      const consent: 'none' | 'current' | 'stale' | null =
        task.whenDue !== 'run' || task.body.kind === 'scan' ? null : held === undefined ? 'none' : held.hash === bodyHash(task) ? 'current' : 'stale';
      const problem = task.problem ?? checkTask(task) ?? null;
      const selfStart = effectiveWhenDue(task, held) === 'run' && this.stageable(task);
      return {
        id: task.id,
        name: task.name,
        enabled: task.enabled,
        body: task.body.kind,
        doing: this.doing(task),
        schedule: this.scheduleWords(task.schedule),
        usesModel: model,
        problem,
        note:
          task.whenDue !== 'run'
            ? null
            : task.body.kind === 'intent'
              ? selfStartNote()
              : task.body.kind === 'plan' && consent !== 'current'
                ? selfStartProblem(task) ?? planSelfStartNote(consent === 'stale' ? 'stale' : 'none')
                : null,
        permission: task.permission,
        maxModelCalls: task.maxModelCalls ?? null,
        running: this.running === task.id,
        staging: this.isStaging(task.id),
        selfStart,
        consent,
        canAllow: task.whenDue === 'run' && task.body.kind === 'plan' && selfStartProblem(task) === undefined && problem === null,
        fingerprint: bodyHash(task),
        history,
        draft: draftOf(task),
      };
    });
    const byId = new Map(tasks.map((task) => [task.id, task] as const));
    const offers = [...this.offered].flatMap((id): OfferView[] => {
      const row = byId.get(id);
      return row === undefined ? [] : [{ id, name: row.name, doing: row.doing, usesModel: row.usesModel, maxModelCalls: row.maxModelCalls }];
    });
    return {
      attached: home !== null,
      tasks,
      offers,
      running: this.running,
      status: home?.status() ?? NO_TASKS,
      announcement: this.announcement,
      message: this.message,
    };
  }
}
