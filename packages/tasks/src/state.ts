/**
 * The machine's task state (agent-harness.md §12, "The command line"): when each task was last handled on this machine, kept outside
 * the project so a folder under git does not churn on every run. Pure: the caller reads and writes the file; this is its shape and
 * its recovery posture, which is `tasks.json`'s.
 */

import { isTaskId } from './codec.js';

export const TASK_STATE_FORMAT_VERSION = 1;

export interface TaskStateFile {
  readonly formatVersion: typeof TASK_STATE_FORMAT_VERSION;
  /** The ISO-8601 instant each task was last handled (a run that settled, or a skip), by task id. */
  readonly lastRuns: Readonly<Record<string, string>>;
}

export const emptyTaskState = (): TaskStateFile => ({ formatVersion: TASK_STATE_FORMAT_VERSION, lastRuns: {} });

export type StateParseOutcome =
  | { readonly kind: 'ok'; readonly file: TaskStateFile }
  | { readonly kind: 'corrupt'; readonly reason: string }
  | { readonly kind: 'newer'; readonly formatVersion: number }
  | { readonly kind: 'foreign' };

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A missing file is an empty state, not a corrupt one: the first run on a machine has no history. */
export function parseTaskState(text: string | undefined): StateParseOutcome {
  if (text === undefined) return { kind: 'ok', file: emptyTaskState() };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { kind: 'corrupt', reason: error instanceof Error ? error.message : 'not JSON' };
  }
  if (!isRecord(raw) || !('formatVersion' in raw)) return { kind: 'foreign' };
  const version = raw['formatVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return { kind: 'corrupt', reason: 'its formatVersion is not a whole number from 1' };
  if (version > TASK_STATE_FORMAT_VERSION) return { kind: 'newer', formatVersion: version };
  const runs = raw['lastRuns'];
  if (runs !== undefined && !isRecord(runs)) return { kind: 'corrupt', reason: 'lastRuns is not an object' };
  const lastRuns: Record<string, string> = {};
  for (const [id, at] of Object.entries(runs ?? {})) {
    if (!isTaskId(id) || typeof at !== 'string' || !ISO.test(at)) return { kind: 'corrupt', reason: `lastRuns holds an entry that is not a task id and an ISO-8601 instant: ${JSON.stringify(id)}` };
    lastRuns[id] = at;
  }
  return { kind: 'ok', file: { formatVersion: TASK_STATE_FORMAT_VERSION, lastRuns } };
}

/** The file as it is written: two-space JSON, ids sorted, a trailing newline. */
export function serializeTaskState(file: TaskStateFile): string {
  const lastRuns = Object.fromEntries(Object.keys(file.lastRuns).sort().map((id) => [id, file.lastRuns[id]]));
  return `${JSON.stringify({ formatVersion: file.formatVersion, lastRuns }, null, 2)}\n`;
}

/** The state with one task handled at `at`. The instant is the caller's clock, never read here. */
export function withHandled(file: TaskStateFile, taskId: string, at: string): TaskStateFile {
  return { formatVersion: file.formatVersion, lastRuns: { ...file.lastRuns, [taskId]: at } };
}

/** The name a corrupt state file is kept under, so the next run starts empty without losing what was there. */
export function corruptStateFile(when: Date): string {
  return `.corrupt-${when.toISOString().replace(/[:.]/g, '-')}`;
}
