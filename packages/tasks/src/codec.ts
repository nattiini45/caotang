/**
 * `tasks.json` text ⇄ {@link TasksFile} (agent-harness.md §12), with the project-format §2/§6 tolerance rules per item.
 *
 * - **Whole file.** Text that is not JSON, or has a `formatVersion` that is not a whole number from 1, is `corrupt` and the caller
 *   runs the recovery posture (file.ts). A file from a newer format is `newer`, and valid JSON that is not an object or has no
 *   `formatVersion` at all is `foreign`, most likely another program's file: neither is ever overwritten.
 * - **Per task.** A task that fails its field contract is dropped and named in a notice. One bad task never blocks the load.
 *   A plan with a step that does not parse is kept as written and marked with a `problem`, so the writer sees it and a save
 *   does not lose it.
 * - **Per field.** A permission above `ask` is capped to `ask` with a notice: a file can lower what a task may do and never raise it.
 */

import { DETERMINISTIC_CHECK_IDS, type DeterministicCheckId } from '@caotang/coherence';
import { parsePlan, type PlanStep } from '@caotang/harness';
import { ID_BODY_PATTERN } from '@caotang/ids';

import {
  BODY_KINDS,
  INTENT_LIMIT,
  MAX_MODEL_CALLS,
  NAME_LIMIT,
  SCHEDULE_KINDS,
  TASKS_FORMAT_VERSION,
  TASKS_LIMIT,
  WEEKDAYS,
  type AgentTask,
  type TaskBody,
  type TaskPermission,
  type TaskSchedule,
  type TasksFile,
  type WhenDue,
} from './model.js';

export type LoadNoticeCode =
  | 'unknown-field'
  | 'dropped-task'
  | 'permission-capped'
  | 'defaulted-field'
  | 'too-many-tasks'
  | 'corrupt-file'
  | 'restored-from-snapshot'
  | 'newer-format'
  | 'foreign-file';

/** One line for the load report. Plain language: it is shown to the writer. */
export interface LoadNotice {
  readonly code: LoadNoticeCode;
  readonly message: string;
}

export type ParseOutcome =
  | { readonly kind: 'ok'; readonly file: TasksFile; readonly notices: LoadNotice[] }
  | { readonly kind: 'corrupt'; readonly reason: string }
  | { readonly kind: 'newer'; readonly formatVersion: number }
  | { readonly kind: 'foreign' };

type Obj = Record<string, unknown>;

const TOP_KEYS = ['formatVersion', 'tasks'] as const;
const TASK_KEYS = ['id', 'name', 'enabled', 'schedule', 'whenDue', 'body', 'permission', 'maxModelCalls'] as const;

const TASK_ID = new RegExp(`^t_${ID_BODY_PATTERN}$`);
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isTaskId = (value: unknown): value is string => typeof value === 'string' && TASK_ID.test(value);
export const isClock = (value: unknown): value is string => typeof value === 'string' && CLOCK.test(value);

const isRecord = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

const unknownKeys = (obj: Obj, allowed: readonly string[]): string[] => Object.keys(obj).filter((key) => !allowed.includes(key));

/** Permission words a file may use, and what each is read as. A word above `ask` is a cap, not an error. */
const PERMISSION_WORDS: Readonly<Record<string, TaskPermission>> = {
  'read-only': 'read-only',
  'plan-only': 'read-only',
  ask: 'ask',
};
const ABOVE_ASK = new Set(['accept-edits', 'auto', 'approve-all']);

type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };
const good = <T>(value: T): Read<T> => ({ ok: true, value });
const bad = (reason: string): Read<never> => ({ ok: false, reason });

function readSchedule(raw: unknown): Read<TaskSchedule> {
  if (!isRecord(raw) || typeof raw['kind'] !== 'string' || !(SCHEDULE_KINDS as readonly string[]).includes(raw['kind'])) {
    return bad(`its schedule is not one of ${SCHEDULE_KINDS.join(', ')}`);
  }
  const kind = raw['kind'];
  if (kind === 'manual' || kind === 'on-open') return good({ kind });
  const at = raw['at'] === undefined ? '00:00' : raw['at'];
  if (!isClock(at)) return bad('its time of day is not written as HH:MM');
  if (kind === 'daily') return good({ kind, at });
  const day = raw['day'];
  if (typeof day !== 'string' || !(WEEKDAYS as readonly string[]).includes(day)) return bad(`its weekday is not one of ${WEEKDAYS.join(', ')}`);
  return good({ kind: 'weekly', day: day as (typeof WEEKDAYS)[number], at });
}

/** The body, and the reason it cannot run when it reads as a body but not as work (a plan step that does not check, an unknown check). */
function readBody(raw: unknown): Read<{ body: TaskBody; problem?: string }> {
  if (!isRecord(raw) || typeof raw['kind'] !== 'string' || !(BODY_KINDS as readonly string[]).includes(raw['kind'])) {
    return bad(`its body is not one of ${BODY_KINDS.join(', ')}`);
  }
  if (raw['kind'] === 'intent') {
    const text = raw['text'];
    if (typeof text !== 'string' || text.trim() === '') return bad('its instruction is empty');
    if ([...text].length > INTENT_LIMIT) return bad(`its instruction is over ${INTENT_LIMIT} characters`);
    return good({ body: { kind: 'intent', text } });
  }
  if (raw['kind'] === 'plan') {
    const steps = raw['steps'];
    if (!Array.isArray(steps)) return bad('its plan has no steps');
    const parsed = parsePlan({ steps });
    if (parsed.ok) return good({ body: { kind: 'plan', steps: parsed.value.steps as readonly PlanStep[] } });
    return good({ body: { kind: 'plan', steps: steps as readonly PlanStep[] }, problem: `Its plan does not parse: ${parsed.error.message}` });
  }
  const scope = raw['scope'] === undefined ? 'full' : raw['scope'];
  if (scope !== 'full' && scope !== 'changed') return bad('its scan scope is not full or changed');
  if (raw['checks'] === undefined) return good({ body: { kind: 'scan', scope } });
  if (!Array.isArray(raw['checks']) || !raw['checks'].every((id) => typeof id === 'string')) return bad('its scan checks are not a list of check ids');
  const checks = raw['checks'] as string[];
  const unknown = checks.filter((id) => !(DETERMINISTIC_CHECK_IDS as readonly string[]).includes(id));
  return good({
    body: { kind: 'scan', scope, checks: checks as DeterministicCheckId[] },
    ...(unknown.length === 0 ? {} : { problem: `Its scan names a check that does not exist: ${unknown.join(', ')}.` }),
  });
}

function readTask(raw: unknown, index: number, taken: Set<string>, notices: LoadNotice[]): AgentTask | undefined {
  const drop = (reason: string): undefined => {
    notices.push({ code: 'dropped-task', message: `Task ${index + 1} was dropped: ${reason}.` });
    return undefined;
  };
  if (!isRecord(raw)) return drop('it is not an object');
  const id = raw['id'];
  if (!isTaskId(id)) return drop('its id is not a task id');
  if (taken.has(id)) return drop('its id is used by an earlier task');
  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  if (name === '') return drop('it has no name');
  if ([...name].length > NAME_LIMIT) return drop(`its name is over ${NAME_LIMIT} characters`);
  const named = `Task “${name}”`;
  const schedule = readSchedule(raw['schedule']);
  if (!schedule.ok) return drop(schedule.reason);
  const body = readBody(raw['body']);
  if (!body.ok) return drop(body.reason);

  let whenDue: WhenDue = 'offer';
  if (raw['whenDue'] === 'run' || raw['whenDue'] === 'offer') whenDue = raw['whenDue'];
  else if (raw['whenDue'] !== undefined) notices.push({ code: 'defaulted-field', message: `${named} names a whenDue that is not offer or run, so it is offered when due.` });

  let permission: TaskPermission = 'ask';
  const word = raw['permission'];
  if (typeof word === 'string' && Object.hasOwn(PERMISSION_WORDS, word)) permission = PERMISSION_WORDS[word] as TaskPermission;
  else if (typeof word === 'string' && ABOVE_ASK.has(word)) {
    notices.push({ code: 'permission-capped', message: `${named} asked for “${word}”. A file cannot raise what a task may do, so it runs as “ask”.` });
  } else if (word !== undefined) {
    notices.push({ code: 'defaulted-field', message: `${named} names a permission that is not read-only or ask, so it runs as “ask”.` });
  }

  let maxModelCalls: number | undefined;
  const cap = raw['maxModelCalls'];
  if (typeof cap === 'number' && Number.isInteger(cap) && cap >= 1 && cap <= MAX_MODEL_CALLS) maxModelCalls = cap;
  else if (cap !== undefined) notices.push({ code: 'defaulted-field', message: `${named} names a maxModelCalls that is not a whole number from 1 to ${MAX_MODEL_CALLS}, so it has no cap.` });

  const extra = unknownKeys(raw, TASK_KEYS);
  if (extra.length > 0) notices.push({ code: 'unknown-field', message: `${named} has fields this version does not know (${extra.join(', ')}); the next save drops them.` });

  taken.add(id);
  return {
    id,
    name,
    enabled: raw['enabled'] !== false,
    schedule: schedule.value,
    whenDue,
    body: body.value.body,
    permission,
    ...(maxModelCalls === undefined ? {} : { maxModelCalls }),
    ...(body.value.problem === undefined ? {} : { problem: body.value.problem }),
  };
}

/** Reads `tasks.json` text. Never throws on content. */
export function parseTasksFile(text: string): ParseOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { kind: 'corrupt', reason: error instanceof Error ? error.message : 'not JSON' };
  }
  // Well-formed JSON that does not claim to be a Caotang tasks file is someone else's, and is left as it is.
  if (!isRecord(raw) || !('formatVersion' in raw)) return { kind: 'foreign' };
  const version = raw['formatVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return { kind: 'corrupt', reason: 'its formatVersion is not a whole number from 1' };
  if (version > TASKS_FORMAT_VERSION) return { kind: 'newer', formatVersion: version };
  if (raw['tasks'] !== undefined && !Array.isArray(raw['tasks'])) return { kind: 'corrupt', reason: 'tasks is not a list' };

  const notices: LoadNotice[] = [];
  const extra = unknownKeys(raw, TOP_KEYS);
  if (extra.length > 0) notices.push({ code: 'unknown-field', message: `tasks.json has fields this version does not know (${extra.join(', ')}); the next save drops them.` });
  const items = (raw['tasks'] as unknown[] | undefined) ?? [];
  const taken = new Set<string>();
  const tasks: AgentTask[] = [];
  items.forEach((item, index) => {
    const task = readTask(item, index, taken, notices);
    if (task === undefined) return;
    if (tasks.length >= TASKS_LIMIT) {
      notices.push({ code: 'too-many-tasks', message: `A project keeps at most ${TASKS_LIMIT} tasks. “${task.name}” and any after it were dropped.` });
      return;
    }
    tasks.push(task);
  });
  return { kind: 'ok', file: { formatVersion: TASKS_FORMAT_VERSION, tasks }, notices };
}

/** The file as it is written: two-space JSON, keys in a fixed order, a trailing newline. `problem` is derived and never written. */
export function serializeTasksFile(file: TasksFile): string {
  const tasks = file.tasks.map((task) => ({
    id: task.id,
    name: task.name,
    enabled: task.enabled,
    schedule: task.schedule,
    whenDue: task.whenDue,
    body: task.body,
    permission: task.permission,
    ...(task.maxModelCalls === undefined ? {} : { maxModelCalls: task.maxModelCalls }),
  }));
  return `${JSON.stringify({ formatVersion: file.formatVersion, tasks }, null, 2)}\n`;
}
