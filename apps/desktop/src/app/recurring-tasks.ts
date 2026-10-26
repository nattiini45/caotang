/**
 * The recurring tasks of one open project (agent-harness.md §12): which are due, what the writer is offered, and the runs.
 *
 * ## Offered, never sprung
 *
 * A task that is due shows a card with Run now and Skip. Nothing the card offers starts until the writer clicks, with one exception:
 * a `scan` task whose file says `run` starts by itself, because it reads the project, calls no model and sends nothing anywhere
 * (`effectiveWhenDue`). A task that uses a model is offered whatever its file says: the consent a model task would need to start by
 * itself, and the Inbox its results would stage into, are not part of this build, and the panel says so on the task.
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

import { DETERMINISTIC_CHECK_IDS, type DeterministicCheckId } from '@caotang/coherence';
import {
  TASKS_LIMIT,
  checkTask,
  dueTasks,
  effectiveMode,
  effectiveWhenDue,
  newTaskId,
  scheduleWords,
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
import { requestInkCompilerFor } from './ink-compiler.js';
import type { ProjectSession } from './session.js';
import { TaskRuns } from './task-runs.js';
import type { TasksStatus } from './tasks-io.js';

/** How often the due tasks are looked at while the tab is visible. */
export const EVALUATE_EVERY_MS = 60_000;

/** The sentence a task saved as `run` with a model gets in the panel. */
export const SELF_START_NOTE = 'Starting by itself is not built for tasks that use the model yet, so this one is offered when it is due.';

/** What the writer fills in to make or change a task. Every field is the text of a control. */
export interface TaskDraft {
  readonly name: string;
  readonly body: TaskBody['kind'];
  /** The instruction of an `intent` task. */
  readonly text: string;
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
    scope: task.body.kind === 'scan' ? task.body.scope : 'changed',
    schedule: task.schedule.kind,
    at: task.schedule.kind === 'daily' || task.schedule.kind === 'weekly' ? task.schedule.at : '09:00',
    day: task.schedule.kind === 'weekly' ? task.schedule.day : 'mon',
    whenDue: task.whenDue,
    permission: task.permission,
    maxModelCalls: task.maxModelCalls === undefined ? '' : String(task.maxModelCalls),
  };
}

/** The task a draft describes. `existing` supplies the body a draft cannot write itself (a plan) and the id. */
export function taskOf(draft: TaskDraft, id: string, existing?: AgentTask): AgentTask {
  const body: TaskBody =
    draft.body === 'intent'
      ? { kind: 'intent', text: draft.text.trim() }
      : draft.body === 'scan'
        ? { kind: 'scan', scope: draft.scope, ...(existing?.body.kind === 'scan' && existing.body.checks !== undefined ? { checks: existing.body.checks } : {}) }
        : (existing?.body ?? { kind: 'plan', steps: [] });
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
    ...(existing?.problem !== undefined && draft.body === 'plan' ? { problem: existing.problem } : {}),
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
  readonly history: readonly RunView[];
  readonly draft: TaskDraft;
  /** A plan's steps are not edited here. */
  readonly bodyEditable: boolean;
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

export class RecurringTasks {
  private runs: TaskRuns | null;
  private readonly listeners = new Set<() => void>();
  private snapshotValue: RecurringSnapshot;
  private attached = false;
  /** Counts the attaches, so one that was overtaken by a detach and a new attach (React runs an effect twice in development) does nothing. */
  private generation = 0;
  private runsOpening: Promise<TaskRuns> | null = null;
  private opened = false;
  private stopTimer: (() => void) | null = null;
  private stopVisibility: (() => void) | null = null;
  private stopAgent: (() => void) | null = null;
  /** The tasks the writer has been offered and has not yet run or skipped. */
  private readonly offered = new Set<string>();
  /** The offers a screen reader has been told about. */
  private readonly announced = new Set<string>();
  private running: string | null = null;
  private announcement = '';
  private message: string | null = null;
  private evaluating = false;

  constructor(private readonly options: RecurringOptions) {
    this.runs = options.runs ?? null;
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
    const every = this.options.every ?? defaultEvery;
    this.stopTimer = every(() => void this.tick(), EVALUATE_EVERY_MS);
    // Back in the tab after a while away: look at once rather than at the next minute.
    const onVisible = (): void => void this.tick();
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisible);
      this.stopVisibility = () => document.removeEventListener('visibilitychange', onVisible);
    }
    // A turn that ends, or a restore, changes what a run's row can offer.
    this.stopAgent = this.options.agent.subscribe(() => this.bump());
    const opening = !this.opened;
    this.opened = true;
    await this.evaluate(opening);
  }

  /** The panel is gone. A run already started finishes and is recorded; nothing new starts. */
  detach(): void {
    this.attached = false;
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

  /**
   * Looks at what is due. A scan whose file says `run` starts now; every other due task becomes an offer. An offer stays until the writer
   * runs or skips it, or the task is gone, switched off or no longer readable.
   */
  async evaluate(opening = false): Promise<void> {
    if (this.runs === null || this.evaluating) return;
    this.evaluating = true;
    try {
      const file = this.file();
      const now = (this.options.now ?? (() => new Date()))();
      const timeZone = (this.options.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone))();
      const live = new Set(file.tasks.filter((task) => task.enabled && task.problem === undefined).map((task) => task.id));
      for (const id of [...this.offered]) if (!live.has(id)) this.offered.delete(id);
      const starting: AgentTask[] = [];
      for (const task of dueTasks(file, this.runs.lastRuns(), now, timeZone, opening)) {
        if (task.id === this.running) continue;
        if (effectiveWhenDue(task) === 'run') starting.push(task);
        else if (!this.offered.has(task.id)) this.offered.add(task.id);
      }
      const news = [...this.offered].filter((id) => !this.announced.has(id));
      for (const id of news) this.announced.add(id);
      if (news.length > 0) {
        const names = news.map((id) => this.taskById(id)?.name ?? '').filter((name) => name !== '');
        this.announcement = names.length === 1 ? `Task due: ${names[0]}. Run now or Skip.` : `${names.length} tasks are due: ${names.join(', ')}.`;
      }
      this.bump();
      for (const task of starting) await this.runTask(task.id, 'due');
    } finally {
      this.evaluating = false;
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
    this.offered.delete(id);
    await this.runs.record({
      taskId: id,
      at: (this.options.now ?? (() => new Date()))().toISOString(),
      status: 'skipped',
      trigger: 'due',
      summary: 'Skipped by you.',
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
    });
    this.announcement = `Skipped ${task.name}.`;
    this.bump();
  }

  private async runTask(id: string, trigger: TaskRunRecord['trigger']): Promise<void> {
    const task = this.taskById(id);
    if (task === undefined || this.runs === null) return;
    this.message = null;
    if (this.running !== null) {
      this.message = 'Another task is running. Run this one when it has finished.';
      this.bump();
      return;
    }
    const problem = task.problem ?? checkTask(task);
    if (problem !== undefined) {
      this.message = `${task.name} cannot run: ${problem}`;
      this.bump();
      return;
    }
    if (task.body.kind !== 'scan' && this.options.agent.snapshot().busy) {
      this.message = 'The agent is working on another turn. Run the task when it has finished.';
      this.bump();
      return;
    }
    this.running = id;
    this.offered.delete(id);
    this.bump();
    let record: TaskRunRecord;
    try {
      record = await this.execute(task, trigger);
    } catch (error) {
      record = this.recordOf(task, trigger, 'failed', `The run stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.running = null;
    await this.runs.record(record);
    this.announcement = `${task.name}: ${record.summary}`;
    this.bump();
  }

  private recordOf(task: AgentTask, trigger: TaskRunRecord['trigger'], status: TaskRunRecord['status'], summary: string, extra: Partial<TaskRunRecord> = {}): TaskRunRecord {
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

  private async execute(task: AgentTask, trigger: TaskRunRecord['trigger']): Promise<TaskRunRecord> {
    const { agent } = this.options;
    if (task.body.kind === 'scan') return this.scan(task, task.body, trigger);
    // The file can only lower what a run may do: the lowest of its permission, the app's setting and the panel's mode.
    const mode = effectiveMode(task.permission, agent.settingMode(), agent.mode());
    const options = { role: 'background' as const, mode, ...(task.maxModelCalls === undefined ? {} : { maxModelCalls: task.maxModelCalls }) };
    const report =
      task.body.kind === 'intent'
        ? await agent.submit(task.body.text, options)
        : await agent.submitPlan(task.name, { steps: task.body.steps }, options);
    if (report === null) return this.recordOf(task, trigger, 'failed', agent.snapshot().message ?? 'The turn did not run.');
    const status = report.status === 'failed' ? 'failed' : report.status === 'cancelled' ? 'stopped' : 'done';
    return this.recordOf(task, trigger, status, report.summary, {
      requests: report.tokens.requests,
      promptTokens: report.tokens.promptTokens,
      completionTokens: report.tokens.completionTokens,
      turnId: report.turnId,
    });
  }

  /** A scan: the deterministic checks over the project as the agent may read it. It calls no model, so it sends nothing anywhere. */
  private async scan(task: AgentTask, body: Extract<TaskBody, { kind: 'scan' }>, trigger: TaskRunRecord['trigger']): Promise<TaskRunRecord> {
    const { session } = this.options;
    await requestInkCompilerFor(session.state);
    const on = (this.options.enabledChecks ?? (() => DETERMINISTIC_CHECK_IDS))();
    const checks = (body.checks ?? DETERMINISTIC_CHECK_IDS).filter((id) => on.includes(id));
    if (checks.length === 0) return this.recordOf(task, trigger, 'failed', 'Every check this scan would run is turned off in Settings › Coherence, so nothing ran.');
    const result = session.scanCoherence({
      approvedLargeScope: false,
      scope: body.scope === 'full' ? { mode: 'full' } : { mode: 'changed' },
      checks,
      // A document a read rule keeps from the agent is left out of this scan, as it is of the agent's own.
      withheld: session.harness.withheld('coherence.scan'),
    });
    return result.ok ? this.recordOf(task, trigger, 'done', result.summary) : this.recordOf(task, trigger, 'failed', result.message);
  }

  /* ------------------------------------------------------------------ *
   * Editing the definitions
   * ------------------------------------------------------------------ */

  /** Makes a task, or changes `id`. Resolves with why it was not saved, or `null`. */
  async save(draft: TaskDraft, id?: string): Promise<string | null> {
    const home = this.options.session.tasksHome();
    if (home === null) return 'This project has no tasks file to save to.';
    const file = this.file();
    const existing = id === undefined ? undefined : file.tasks.find((task) => task.id === id);
    if (id !== undefined && existing === undefined) return 'That task is gone.';
    if (existing === undefined && file.tasks.length >= TASKS_LIMIT) return `A project keeps at most ${TASKS_LIMIT} tasks.`;
    const task = taskOf(draft, existing?.id ?? newTaskId(new Set(file.tasks.map((entry) => entry.id))), existing);
    if (draft.maxModelCalls.trim() !== '' && !/^\d+$/.test(draft.maxModelCalls.trim())) return 'Limit model calls to a whole number from 1 to 100.';
    const refusal = checkTask(task);
    if (refusal !== undefined) return refusal;
    const failure = await home.save({ ...file, tasks: existing === undefined ? [...file.tasks, task] : file.tasks.map((entry) => (entry.id === task.id ? task : entry)) });
    this.bump();
    return failure;
  }

  async setEnabled(id: string, enabled: boolean): Promise<string | null> {
    const home = this.options.session.tasksHome();
    const file = this.file();
    if (home === null || !file.tasks.some((task) => task.id === id)) return 'That task is gone.';
    const failure = await home.save({ ...file, tasks: file.tasks.map((task) => (task.id === id ? { ...task, enabled } : task)) });
    this.bump();
    return failure;
  }

  async remove(id: string): Promise<string | null> {
    const home = this.options.session.tasksHome();
    const file = this.file();
    if (home === null || !file.tasks.some((task) => task.id === id)) return 'That task is gone.';
    this.offered.delete(id);
    const failure = await home.save({ ...file, tasks: file.tasks.filter((task) => task.id !== id) });
    await this.runs?.forget(id);
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
        return task.body.scope === 'full' ? 'Scan the whole manuscript for continuity problems' : 'Scan what changed since the last scan for continuity problems';
      case 'plan':
        return task.body.steps.length === 1 ? 'Run a plan of 1 step' : `Run a plan of ${task.body.steps.length} steps`;
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
      return {
        id: task.id,
        name: task.name,
        enabled: task.enabled,
        body: task.body.kind,
        doing: this.doing(task),
        schedule: scheduleWords(task.schedule),
        usesModel: model,
        problem: task.problem ?? checkTask(task) ?? null,
        note: task.whenDue === 'run' && effectiveWhenDue(task) === 'offer' && model ? SELF_START_NOTE : null,
        permission: task.permission,
        maxModelCalls: task.maxModelCalls ?? null,
        running: this.running === task.id,
        history,
        draft: draftOf(task),
        bodyEditable: task.body.kind !== 'plan',
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
