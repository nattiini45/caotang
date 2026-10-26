/**
 * What a task may do and what the writer is told about it (agent-harness.md §12).
 *
 * Whether a task starts by itself is decided here, and only here: {@link effectiveWhenDue}. A scan calls no model, so it may start
 * on its own; a task that calls a model is offered, unless the writer's machine holds a consent for exactly this task as it is now.
 * That consent is a record the app keeps outside the project (it is never read from `tasks.json`) and is keyed by {@link bodyHash},
 * so editing what the task does, when it runs or how much it may do voids it.
 */

import { canonicalJson } from '@caotang/ids';
import { MODEL_BACKED_TOOLS, type PermissionMode } from '@caotang/harness';
import { sha256HexOfText } from '@caotang/skills';

import { isClock } from './codec.js';
import { INTENT_LIMIT, MAX_MODEL_CALLS, NAME_LIMIT, type AgentTask, type TaskPermission, type TaskSchedule, type WhenDue } from './model.js';

/** Whether a run of the task calls a model. An instruction does; a scan does not; a plan does when one of its steps is model-backed. */
export function usesModel(task: AgentTask): boolean {
  switch (task.body.kind) {
    case 'intent':
      return true;
    case 'scan':
      return false;
    case 'plan':
      return task.body.steps.some((step) => MODEL_BACKED_TOOLS.has(step.tool));
  }
}

/**
 * The sentence the editor shows when a task cannot be saved as it stands, or `undefined` when it can. A task that starts by itself
 * with a model needs a call cap; a scan needs neither a cap nor a consent.
 */
export function checkTask(task: AgentTask): string | undefined {
  if (task.name.trim() === '') return 'Give the task a name.';
  if ([...task.name.trim()].length > NAME_LIMIT) return `Keep the name under ${NAME_LIMIT} characters.`;
  if (task.problem !== undefined) return task.problem;
  if (task.body.kind === 'intent') {
    if (task.body.text.trim() === '') return 'Say what the task should do.';
    if ([...task.body.text].length > INTENT_LIMIT) return `Keep the instruction under ${INTENT_LIMIT} characters.`;
  }
  if (task.body.kind === 'plan' && task.body.steps.length === 0) return 'A plan needs at least one step.';
  const schedule = task.schedule;
  if ((schedule.kind === 'daily' || schedule.kind === 'weekly') && !isClock(schedule.at)) return 'Write the time of day as HH:MM.';
  if (task.maxModelCalls !== undefined && (!Number.isInteger(task.maxModelCalls) || task.maxModelCalls < 1 || task.maxModelCalls > MAX_MODEL_CALLS)) {
    return `Limit model calls to a whole number from 1 to ${MAX_MODEL_CALLS}.`;
  }
  if (task.whenDue === 'run' && usesModel(task) && task.maxModelCalls === undefined) {
    return 'A task that starts by itself and uses the model needs a limit on its model calls.';
  }
  return undefined;
}

/** `hash` is {@link bodyHash} of the task the writer allowed to start by itself. */
export interface TaskConsent {
  readonly hash: string;
}

/**
 * `run` when the task starts without a click, `offer` when the writer is asked. A scan starts by itself when it says so. A model task
 * does only with a consent whose hash is the task's hash now and a call cap; without one it is offered, whatever the file says. The
 * app does not keep consents in this build, so it never passes one and a model task is always offered.
 */
export function effectiveWhenDue(task: AgentTask, consent?: TaskConsent): WhenDue {
  if (task.whenDue !== 'run' || task.problem !== undefined) return 'offer';
  if (!usesModel(task)) return 'run';
  return consent !== undefined && consent.hash === bodyHash(task) && task.maxModelCalls !== undefined ? 'run' : 'offer';
}

/**
 * A hash of what a consent covers: the body, the schedule, the permission and the call cap. The name, the switch that enables the task
 * and `whenDue` itself are not in it, so renaming or pausing a task keeps its consent and changing what it does does not.
 */
export function bodyHash(task: AgentTask): string {
  return sha256HexOfText(
    canonicalJson({ body: task.body, schedule: task.schedule, permission: task.permission, maxModelCalls: task.maxModelCalls ?? null }),
  );
}

const MODE_ORDER: readonly PermissionMode[] = ['plan-only', 'ask', 'accept-edits', 'auto'];

const MODE_OF: Readonly<Record<TaskPermission, PermissionMode>> = { 'read-only': 'plan-only', ask: 'ask' };

/**
 * The permission mode a run of the task is held to: the lowest of the file's permission and every other mode in play (the app's
 * setting, and for a run the writer starts, the panel's current mode). The file can only lower what a run may do.
 */
export function effectiveMode(permission: TaskPermission, ...others: readonly PermissionMode[]): PermissionMode {
  return [MODE_OF[permission], ...others].reduce((low, mode) => (MODE_ORDER.indexOf(mode) < MODE_ORDER.indexOf(low) ? mode : low));
}

const WEEKDAY_WORDS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' } as const;

/** The schedule in the words the panel shows. */
export function scheduleWords(schedule: TaskSchedule): string {
  switch (schedule.kind) {
    case 'manual':
      return 'Only when you run it';
    case 'on-open':
      return 'Each time the project opens';
    case 'daily':
      return `Every day from ${schedule.at}`;
    case 'weekly':
      return `Every ${WEEKDAY_WORDS[schedule.day]} from ${schedule.at}`;
  }
}
