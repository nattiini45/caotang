import { RUN_HISTORY_LIMIT, type TaskRunRecord } from './model.js';

/** `history` with `record` added as the newest, newest first, bounded to {@link RUN_HISTORY_LIMIT}. */
export function withRun(history: readonly TaskRunRecord[], record: TaskRunRecord): TaskRunRecord[] {
  return [record, ...history].slice(0, RUN_HISTORY_LIMIT);
}

/** The instant each task was last handled, by task id, from per-task histories (newest first): the `lastRuns` that `dueTasks` takes. */
export function lastRunsOf(histories: Readonly<Record<string, readonly TaskRunRecord[]>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [taskId, history] of Object.entries(histories)) {
    const newest = history[0];
    if (newest !== undefined) out[taskId] = newest.at;
  }
  return out;
}
