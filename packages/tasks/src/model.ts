/**
 * `tasks.json` — the model of a project's recurring tasks (agent-harness.md §12).
 *
 * The file holds definitions only: what to do, when it is due, how much it may do. It holds no key, no URL, no consent and
 * no last-run state. Whether a model task may start by itself is a record on the writer's machine, and when a task last ran
 * is the app database's (`TaskRunRecord`), so a shared folder, a bundle or a template can neither spend a writer's key nor
 * say what the writer has already seen.
 */

import type { DeterministicCheckId } from '@caotang/coherence';
import type { PlanStep } from '@caotang/harness';

export const TASKS_FILE = 'tasks.json';
export const TASKS_FORMAT_VERSION = 1 as const;
/** project-format §4's depth for a rolling snapshot: `tasks.json.bak.1` to `.bak.3`. */
export const TASKS_SNAPSHOT_COUNT = 3;

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** When a task is due. There is no cron syntax: `at` is a local wall-clock time, `HH:MM`. */
export type TaskSchedule =
  /** Never due by itself; the writer starts it. */
  | { readonly kind: 'manual' }
  /** Due once each time the project is opened. */
  | { readonly kind: 'on-open' }
  | { readonly kind: 'daily'; readonly at: string }
  | { readonly kind: 'weekly'; readonly day: Weekday; readonly at: string };

export const SCHEDULE_KINDS = ['manual', 'on-open', 'daily', 'weekly'] as const;

/** What a task does. A scan is the deterministic check of coherence.md §5.1 and calls no model. */
export type TaskBody =
  | { readonly kind: 'intent'; readonly text: string }
  | { readonly kind: 'plan'; readonly steps: readonly PlanStep[] }
  | { readonly kind: 'scan'; readonly scope: 'full' | 'changed'; readonly checks?: readonly DeterministicCheckId[] };

export const BODY_KINDS = ['intent', 'plan', 'scan'] as const;

/**
 * What the task may do, in the vocabulary of the permission modes: `read-only` is Plan only, `ask` is Ask. The file can name
 * no more than that. A larger value read from a file is capped when it is loaded.
 */
export type TaskPermission = 'read-only' | 'ask';

export type WhenDue = 'offer' | 'run';

export interface AgentTask {
  /** `t_` and ten Crockford base32 characters. */
  readonly id: string;
  readonly name: string;
  /** A disabled task is kept and never due. */
  readonly enabled: boolean;
  readonly schedule: TaskSchedule;
  /** `offer` shows a card (Run now, Skip) when the task is due; `run` starts it by itself where that is allowed (check.ts). */
  readonly whenDue: WhenDue;
  readonly body: TaskBody;
  readonly permission: TaskPermission;
  /** The most model calls one run may make. Required of a model task that starts by itself. */
  readonly maxModelCalls?: number;
  /**
   * Why the task cannot run, in words, set when the file is read and never written: a plan with a step that does not parse. The task
   * is kept as written so a save does not lose it, and it is never due.
   */
  readonly problem?: string;
}

export interface TasksFile {
  readonly formatVersion: typeof TASKS_FORMAT_VERSION;
  readonly tasks: readonly AgentTask[];
}

export const emptyTasksFile = (): TasksFile => ({ formatVersion: TASKS_FORMAT_VERSION, tasks: [] });

export const NAME_LIMIT = 80;
export const INTENT_LIMIT = 4000;
export const TASKS_LIMIT = 50;
/** The most model calls a task may be capped at. */
export const MAX_MODEL_CALLS = 100;
export const DEFAULT_MAX_MODEL_CALLS = 8;

/** How a run ended. `skipped` is the writer declining an offer; it is a record so the offer is not made again before the next occurrence. */
export type TaskRunStatus = 'done' | 'failed' | 'stopped' | 'skipped';
export const TASK_RUN_STATUSES: readonly TaskRunStatus[] = ['done', 'failed', 'stopped', 'skipped'];

/** One run of a task, kept on the writer's machine (the app database), never in the project. */
export interface TaskRunRecord {
  readonly taskId: string;
  /** ISO-8601 instant the run, or the skip, was recorded. */
  readonly at: string;
  readonly status: TaskRunStatus;
  /** `due` is a run the schedule offered or started; `manual` is the writer's Run now on a task that was not due. */
  readonly trigger: 'due' | 'manual';
  /** One sentence about what the run did or why it did not. */
  readonly summary: string;
  /** Model requests the run made, and its tokens. A scan makes none. */
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** The run's undo group, while a Restore to before the run is meant to be offered. */
  readonly undoGroupId?: string;
}

/** The most records kept for one task. */
export const RUN_HISTORY_LIMIT = 20;
