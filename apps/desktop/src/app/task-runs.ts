/**
 * When each recurring task of a project last ran on this machine, and what the runs did (agent-harness.md §12).
 *
 * The history is kept in the app database (`caotang-app`, the `task-runs` store), keyed by project and task, and **never in the
 * project, a bundle or an export**: what a writer has already run or skipped is theirs, so a project opened on another machine
 * offers its due tasks afresh. A run is a record with the model requests and tokens it spent, which is how a writer sees what a
 * task costs. With no app database (a private window that will not open one) the history is kept for the session only, and a due
 * task is offered again after a reload: failing to remember is never a reason to run something unasked.
 */

import { lastRunsOf, withRun, type TaskRunRecord } from '@caotang/tasks';

import { activeAppDb, type TaskRunDb } from './app-db.js';

const keyOf = (projectId: string, taskId: string): string => `${projectId}:${taskId}`;

export class TaskRuns {
  private readonly histories = new Map<string, readonly TaskRunRecord[]>();
  /** Why the last read or write of the app database failed, or `null`. The history still holds for the session. */
  failure: string | null = null;

  private constructor(
    readonly projectId: string,
    private readonly db: TaskRunDb | null,
  ) {}

  /** The histories kept for a project. A database that cannot be read gives none, and says why in {@link failure}. */
  static async open(projectId: string, db: { readonly taskRuns?: TaskRunDb } | null = activeAppDb()): Promise<TaskRuns> {
    const runs = new TaskRuns(projectId, db?.taskRuns ?? null);
    if (runs.db === null) return runs;
    try {
      for (const row of await runs.db.list(projectId)) runs.histories.set(row.taskId, row.history);
    } catch (error) {
      runs.failure = error instanceof Error ? error.message : String(error);
    }
    return runs;
  }

  /** A project's runs with nowhere to keep them. */
  static none(projectId: string): TaskRuns {
    return new TaskRuns(projectId, null);
  }

  /** The runs of one task, newest first. */
  history(taskId: string): readonly TaskRunRecord[] {
    return this.histories.get(taskId) ?? [];
  }

  /** The instant each task was last handled (run or skipped), by task id: what `dueTasks` reads. */
  lastRuns(): Record<string, string> {
    return lastRunsOf(Object.fromEntries(this.histories));
  }

  /** Adds a run to its task's history. */
  async record(record: TaskRunRecord): Promise<void> {
    const history = withRun(this.history(record.taskId), record);
    this.histories.set(record.taskId, history);
    if (this.db === null) return;
    try {
      await this.db.put({ key: keyOf(this.projectId, record.taskId), projectId: this.projectId, taskId: record.taskId, history });
      this.failure = null;
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
    }
  }

  /** Forgets a task's history, when the task is deleted. */
  async forget(taskId: string): Promise<void> {
    this.histories.delete(taskId);
    if (this.db === null) return;
    try {
      await this.db.delete([keyOf(this.projectId, taskId)]);
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
    }
  }
}

/** Removes every history kept for a project, when the project is removed. A database that cannot be reached leaves them: they name no project that exists. */
export async function dropTaskRunsOf(projectId: string, db: { readonly taskRuns?: TaskRunDb } | null = activeAppDb()): Promise<void> {
  const runs = db?.taskRuns;
  if (runs === undefined) return;
  try {
    const kept = await runs.list(projectId);
    await runs.delete(kept.map((row) => row.key));
  } catch {
    // A history of a project that is gone is never read, so a failed sweep costs a few bytes and nothing else.
  }
}
