/**
 * Durable goal records in the runtime store — [agent-harness.md §7.2](docs/architecture/agent-harness.md), and
 * [project-format.md](docs/architecture/project-format.md) for the version-6 upgrade.
 *
 * A goal run outlives a turn: it works iteration after iteration until its checks pass. Its record therefore has to outlive a
 * reload too, or a laptop that slept mid-goal would silently spend money on work nobody can account for. The record holds the
 * checkpoint the harness saved before an iteration, the turns that iteration ran, and whether the run is still going. It holds no
 * provider key, no request body and no conversation: the checkpoint is the goal, its checks and its spend, and each iteration's
 * messages live in the run log as any turn's do.
 *
 * Nothing here resumes a goal. A row left `running` when a tab died is marked `interrupted` when the project opens, and stays so
 * until the writer explicitly resumes it: recovery is never automatic.
 */

import { AGENT_SESSION_STORE, GOAL_RUN_PROJECT_INDEX, GOAL_RUN_STORE, RUN_STORE, guarded, transact, type RuntimeStore } from './store.js';

/** One goal's record. `schema` is the record's own version: a row this build does not know is not offered for recovery. */
export interface GoalRunRow {
  readonly schema: 1;
  readonly goalId: string;
  readonly projectId: string;
  /** The conversation the goal belongs to, so a resume lands in the turns the writer expects. */
  readonly sessionId: string;
  /**
   * `running` while a turn works or the next one may start, `interrupted` after a reload or a closed tab, `settled` when the run
   * ended. Only `interrupted` is offered for an explicit resume.
   */
  readonly status: GoalRunStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The checkpoint the harness saved before the latest iteration; read back untyped and validated before use. */
  readonly checkpoint: unknown;
  /** The turns the goal's iterations ran, oldest first. */
  readonly iterationRunIds: readonly string[];
  /** How the run ended, for a settled record. */
  readonly result?: GoalRunResult;
}

export type GoalRunStatus = 'running' | 'interrupted' | 'settled';

export interface GoalRunResult {
  readonly status: string;
  readonly reason: string;
}

/** What a recovery offer says: a record to resume, nothing, or a record this build may only be discarded. */
export type GoalRecovery =
  | { readonly kind: 'offer'; readonly row: GoalRunRow }
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable'; readonly row: GoalRunRow };

const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isCount = (value: unknown): value is number => isAmount(value) && Number.isSafeInteger(value);

const isId = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

const isStatus = (value: unknown): value is GoalRunStatus => value === 'running' || value === 'interrupted' || value === 'settled';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether a stored checkpoint is one this build can read. The harness owns the checkpoint's contents; what the store can say is that
 * it is an object with a goal, an iteration list, a result list, a next iteration and a spend — enough that a resume would be about a
 * real run rather than a guess at a damaged row.
 */
export function checkpointReadable(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const goal = value['goal'];
  const iterations = value['iterations'];
  const results = value['results'];
  const spend = value['spend'];
  if (!isRecord(goal) || !isId(goal['id']) || typeof goal['intent'] !== 'string' || !Array.isArray(goal['checks'])) return false;
  const limits = goal['limits'];
  if (!isRecord(limits)) return false;
  const fields = ['maxModelCalls', 'maxTokens', 'maxCostUsd', 'maxSteps', 'maxActiveMs', 'deadline'];
  const entries = Object.entries(limits);
  if (!entries.some(([, limit]) => limit !== undefined)) return false;
  for (const [field, limit] of entries) {
    if (!fields.includes(field)) return false;
    if (limit === undefined) continue;
    if (!isAmount(limit) || ((field === 'maxModelCalls' || field === 'maxSteps') && !isCount(limit))) return false;
  }
  if (!Array.isArray(iterations) || !Array.isArray(results)) return false;
  if (!Number.isSafeInteger(value['nextIteration']) || (value['nextIteration'] as number) < 1) return false;
  if (!isRecord(spend) || !isCount(spend['modelCalls']) || !isCount(spend['steps'])) return false;
  if (!['promptTokens', 'completionTokens', 'estimatedTokens', 'activeMs'].every((key) => isAmount(spend[key]))) return false;
  if (spend['costUsd'] !== undefined && !isAmount(spend['costUsd'])) return false;
  const progress = value['progress'];
  if (progress !== undefined && (!isRecord(progress) || !isAmount(progress['best']) || !isCount(progress['sinceBest']) || !Array.isArray(progress['passed']) || !progress['passed'].every(isId))) return false;
  return iterations.every((iteration) => isRecord(iteration) && Number.isSafeInteger(iteration['n']));
}

function rowReadable(row: GoalRunRow): boolean {
  return row.schema === 1 && isId(row.goalId) && isId(row.projectId) && isId(row.sessionId) && isStatus(row.status) &&
    isAmount(row.createdAt) && isAmount(row.updatedAt) && Array.isArray(row.iterationRunIds) && row.iterationRunIds.every(isId);
}

/** Every goal of a project, oldest first. A row this build cannot read is still returned, so the writer can discard it. */
export function readGoalRuns(store: RuntimeStore, projectId: string): Promise<GoalRunRow[]> {
  return transact<GoalRunRow[]>(store.db, [GOAL_RUN_STORE], 'readonly', (tx, done, fail) => {
    const request = tx.objectStore(GOAL_RUN_STORE).index(GOAL_RUN_PROJECT_INDEX).getAll(projectId);
    request.onsuccess = guarded(fail, () => done((request.result as GoalRunRow[]).sort((a, b) => a.createdAt - b.createdAt || (a.goalId < b.goalId ? -1 : a.goalId > b.goalId ? 1 : 0))));
  });
}

export function readGoalRun(store: RuntimeStore, goalId: string): Promise<GoalRunRow | undefined> {
  return transact<GoalRunRow | undefined>(store.db, [GOAL_RUN_STORE], 'readonly', (tx, done, fail) => {
    const request = tx.objectStore(GOAL_RUN_STORE).get(goalId);
    request.onsuccess = guarded(fail, () => done(request.result as GoalRunRow | undefined));
  });
}

/** The goals of a project that have not settled, oldest first: what a reopen has to account for. */
export async function readOpenGoalRuns(store: RuntimeStore, projectId: string): Promise<GoalRunRow[]> {
  return (await readGoalRuns(store, projectId)).filter((row) => row.status !== 'settled');
}

/** What a recovery offers for one goal: nothing, a run to resume explicitly, or a damaged record to discard. */
export async function openGoalRecovery(store: RuntimeStore, goalId: string): Promise<GoalRecovery> {
  const row = await readGoalRun(store, goalId);
  if (row === undefined) return { kind: 'none' };
  if (!rowReadable(row) || !checkpointReadable(row.checkpoint)) return { kind: 'unreadable', row };
  if (row.status === 'settled') return { kind: 'none' };
  return { kind: 'offer', row };
}

export function createGoalRun(
  store: RuntimeStore,
  run: { readonly goalId: string; readonly projectId: string; readonly sessionId: string; readonly checkpoint: unknown; readonly at: number },
): Promise<void> {
  const row: GoalRunRow = {
    schema: 1, goalId: run.goalId, projectId: run.projectId, sessionId: run.sessionId, status: 'running',
    createdAt: run.at, updatedAt: run.at, checkpoint: run.checkpoint, iterationRunIds: [],
  };
  return transact<void>(store.db, [GOAL_RUN_STORE], 'readwrite', (tx, done, fail) => {
    const goals = tx.objectStore(GOAL_RUN_STORE);
    const existing = goals.get(run.goalId);
    existing.onsuccess = guarded(fail, () => {
      if (existing.result !== undefined) {
        fail(new Error(`goal "${run.goalId}" already has a record`));
        return;
      }
      goals.add(row);
      done();
    });
  });
}

/**
 * Saves the checkpoint before an iteration starts and names the turn it will run. A settled record is history and takes no further
 * iterations, so a late save cannot revive a run the writer has finished with.
 */
export function appendGoalCheckpoint(
  store: RuntimeStore,
  goalId: string,
  change: { readonly checkpoint: unknown; readonly at: number; readonly runId?: string },
): Promise<void> {
  return transact<void>(store.db, [GOAL_RUN_STORE, RUN_STORE], 'readwrite', (tx, done, fail) => {
    const goals = tx.objectStore(GOAL_RUN_STORE);
    const request = goals.get(goalId);
    request.onsuccess = guarded(fail, () => {
      const row = request.result as GoalRunRow | undefined;
      if (row === undefined) {
        fail(new Error(`no goal "${goalId}" in the runtime store`));
        return;
      }
      if (row.status === 'settled') {
        fail(new Error(`goal "${goalId}" is settled and runs no further iteration`));
        return;
      }
      if (!checkpointReadable(change.checkpoint)) {
        fail(new Error('the goal checkpoint cannot be read'));
        return;
      }
      goals.put({ ...row, status: 'running', updatedAt: change.at, checkpoint: change.checkpoint,
        iterationRunIds: change.runId === undefined || row.iterationRunIds.includes(change.runId) ? row.iterationRunIds : [...row.iterationRunIds, change.runId],
      } satisfies GoalRunRow);
      done();
    });
  });
}

/** Names the turn an iteration ran, after it settled. A turn the record already holds is not added twice. */
export function recordGoalIteration(store: RuntimeStore, goalId: string, runId: string, at: number = Date.now()): Promise<void> {
  return transact<void>(store.db, [GOAL_RUN_STORE], 'readwrite', (tx, done, fail) => {
    const goals = tx.objectStore(GOAL_RUN_STORE);
    const request = goals.get(goalId);
    request.onsuccess = guarded(fail, () => {
      const row = request.result as GoalRunRow | undefined;
      if (row === undefined) { fail(new Error(`no goal "${goalId}" in the runtime store`)); return; }
      if (row.iterationRunIds.includes(runId)) { done(); return; }
      if (row.status !== 'running') { fail(new Error(`goal "${goalId}" is not running`)); return; }
      goals.put({ ...row, updatedAt: at, iterationRunIds: [...row.iterationRunIds, runId] } satisfies GoalRunRow);
      done();
    });
  });
}

/** Marks a project's running goals interrupted: the tab that held them is gone. Answers how many changed. */
export function markGoalsInterrupted(store: RuntimeStore, projectId: string, at: number = Date.now()): Promise<number> {
  return transact<number>(store.db, [GOAL_RUN_STORE], 'readwrite', (tx, done, fail) => {
    const goals = tx.objectStore(GOAL_RUN_STORE);
    const request = goals.index(GOAL_RUN_PROJECT_INDEX).getAll(projectId);
    request.onsuccess = guarded(fail, () => {
      let changed = 0;
      for (const row of request.result as GoalRunRow[]) {
        if (row.status !== 'running') continue;
        goals.put({ ...row, status: 'interrupted', updatedAt: at } satisfies GoalRunRow);
        changed += 1;
      }
      done(changed);
    });
  });
}

/** The writer's explicit resume: an interrupted goal becomes running again, with its checkpoint unchanged. */
export function resumeGoalRun(store: RuntimeStore, goalId: string, at: number = Date.now()): Promise<void> {
  return transact<void>(store.db, [GOAL_RUN_STORE], 'readwrite', (tx, done, fail) => {
    const goals = tx.objectStore(GOAL_RUN_STORE);
    const request = goals.get(goalId);
    request.onsuccess = guarded(fail, () => {
      const row = request.result as GoalRunRow | undefined;
      if (row === undefined) {
        fail(new Error(`no goal "${goalId}" in the runtime store`));
        return;
      }
      if (row.status !== 'interrupted') {
        fail(new Error(`goal "${goalId}" is ${row.status}, so there is nothing to resume`));
        return;
      }
      goals.put({ ...row, status: 'running', updatedAt: at } satisfies GoalRunRow);
      done();
    });
  });
}

/** Ends a goal for good: its status and the sentence the writer is shown. An interrupted goal can settle too (discarded, refused). */
export function settleGoalRun(store: RuntimeStore, goalId: string, result: GoalRunResult & { readonly at: number }): Promise<void> {
  return transact<void>(store.db, [GOAL_RUN_STORE], 'readwrite', (tx, done, fail) => {
    const goals = tx.objectStore(GOAL_RUN_STORE);
    const request = goals.get(goalId);
    request.onsuccess = guarded(fail, () => {
      const row = request.result as GoalRunRow | undefined;
      if (row === undefined) {
        fail(new Error(`no goal "${goalId}" in the runtime store`));
        return;
      }
      goals.put({ ...row, status: 'settled', updatedAt: result.at, result: { status: result.status, reason: result.reason } } satisfies GoalRunRow);
      done();
    });
  });
}

/** Deletes one goal's record and nothing else: what its turns wrote stays in the project. */
export function deleteGoalRun(store: RuntimeStore, goalId: string): Promise<void> {
  return transact<void>(store.db, [GOAL_RUN_STORE], 'readwrite', (tx, done) => {
    tx.objectStore(GOAL_RUN_STORE).delete(goalId);
    done();
  });
}

export interface GoalRetention {
  readonly days: number;
  /** How many settled goals a project keeps. An unsettled goal is never evicted. */
  readonly count: number;
}

export const DEFAULT_GOAL_RETENTION: GoalRetention = Object.freeze({ days: 30, count: 50 });

/**
 * Deletes the settled goals a project no longer keeps and answers how many went. A running or interrupted goal is never evicted:
 * it is the record a recovery needs, however old it is.
 */
export function pruneGoalRuns(store: RuntimeStore, projectId: string, now: number = Date.now(), keep: GoalRetention = DEFAULT_GOAL_RETENTION): Promise<number> {
  const cutoff = now - keep.days * 86_400_000;
  return transact<number>(store.db, [GOAL_RUN_STORE, AGENT_SESSION_STORE], 'readwrite', (tx, done, fail) => {
    const goals = tx.objectStore(GOAL_RUN_STORE);
    const request = goals.index(GOAL_RUN_PROJECT_INDEX).getAll(projectId);
    request.onsuccess = guarded(fail, () => {
      const settled = (request.result as GoalRunRow[]).filter((row) => row.status === 'settled').sort((a, b) => b.updatedAt - a.updatedAt);
      const evict = settled.filter((row, index) => index >= keep.count || row.updatedAt < cutoff);
      for (const row of evict) goals.delete(row.goalId);
      done(evict.length);
    });
  });
}

/** Removes every goal record of a project. Project deletion calls this inside its own transaction body. */
export function deleteGoalsOf(tx: IDBTransaction, projectId: string): void {
  const goals = tx.objectStore(GOAL_RUN_STORE);
  const request = goals.index(GOAL_RUN_PROJECT_INDEX).getAll(projectId);
  request.onsuccess = () => {
    for (const row of request.result as GoalRunRow[]) goals.delete(row.goalId);
  };
}
