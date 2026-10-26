/**
 * The agent run log in the runtime store — [agent-harness.md §5.1](docs/architecture/agent-harness.md).
 *
 * Two object stores hold it: `runs` (one record per run, keyed by `runId`) and `runEvents` (one row per event, keyed
 * `[runId, seq]`). The harness writes the events ahead of the work they describe; this file knows nothing of what they mean
 * beyond a `seq` and a type name, so the harness owns the event shapes and a reader validates every row it takes back.
 *
 * ## One transaction per append, and nothing awaited inside it
 *
 * `appendRunEvents` adds a batch of rows, and the run's status change that goes with them, in one transaction. The body is
 * callbacks only (see `transact`): a promise that settles on a later task would close the transaction under it.
 *
 * ## The log is runtime state
 *
 * It lives in the `caotang` database beside the project it belongs to and goes with it (`deleteProject`). It is never a project
 * file, never in a bundle, and never in the key vault. Retention is the checkpoints' clock: thirty days, fifty runs (`pruneRuns`).
 */

import { guarded, transact, RUN_EVENT_RUN_INDEX, RUN_EVENT_STORE, RUN_PROJECT_INDEX, RUN_STORE, type RuntimeStore } from './store.js';

/** Where a run stands. `interrupted` is a run a reload, a crash or a closed tab left unfinished; only the writer resumes or discards it. */
export type RunStatus = 'running' | 'awaiting-approval' | 'interrupted' | 'finished' | 'failed';

/** The statuses of a run that has not settled. */
export const OPEN_RUN_STATUSES: readonly RunStatus[] = ['running', 'awaiting-approval', 'interrupted'];

/** The statuses a tab that holds the project's lease finds only after a tab died: nobody is running them. */
const LIVE_RUN_STATUSES: readonly RunStatus[] = ['running', 'awaiting-approval'];

/** One run's record. Counts and spend are read from its events; the record carries only what a list needs without them. */
export interface RunRow {
  /** The record's own version. A row with a version this build does not know is not offered for resume. */
  readonly schema: number;
  readonly runId: string;
  readonly projectId: string;
  readonly kind: 'turn';
  /** The writer's request, for the card that offers the resume. */
  readonly intent: string;
  readonly createdAt: number;
  /** Epoch ms of the last write to the run. Retention reads it. */
  readonly updatedAt: number;
  /** The provider profile's id. Never a key. */
  readonly profileId?: string;
  readonly model?: string;
  readonly status: RunStatus;
  /** A write to the log failed, so the log no longer describes the run and it is not offered for resume. */
  readonly cannotResume?: true;
}

/** What an append may change on the run record. */
export interface RunPatch {
  readonly status?: RunStatus;
  readonly cannotResume?: true;
  readonly updatedAt?: number;
}

/** One event as the store holds it: the harness's own shape, with the run it belongs to. */
export type RunEventRow = { readonly runId: string; readonly seq: number; readonly t: string } & Readonly<Record<string, unknown>>;

/** What the store takes for an event: the harness's shape, without the run, which the call names. */
export type RunEventInput = { readonly seq: number; readonly t: string } & Readonly<Record<string, unknown>>;

export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`no run "${runId}" in the runtime store`);
    this.name = 'RunNotFoundError';
  }
}

export class RunExistsError extends Error {
  constructor(readonly runId: string) {
    super(`run "${runId}" already exists in the runtime store`);
    this.name = 'RunExistsError';
  }
}

/** Starts a run's record. One transaction; a run id already taken is refused by name. */
export function createRun(store: RuntimeStore, run: RunRow): Promise<void> {
  return transact<void>(store.db, [RUN_STORE], 'readwrite', (tx, done, fail) => {
    const runs = tx.objectStore(RUN_STORE);
    const existing = runs.get(run.runId);
    existing.onsuccess = guarded(fail, () => {
      if (existing.result !== undefined) {
        fail(new RunExistsError(run.runId));
        return;
      }
      runs.add(run);
      done();
    });
  });
}

/**
 * Appends events to a run, and applies `patch` to its record, in one transaction. A `[runId, seq]` already taken aborts the whole
 * append, so a batch is all in or all out and two writers can never interleave one run's sequence.
 */
export function appendRunEvents(store: RuntimeStore, runId: string, events: readonly RunEventInput[], patch: RunPatch = {}): Promise<void> {
  return transact<void>(store.db, [RUN_STORE, RUN_EVENT_STORE], 'readwrite', (tx, done, fail) => {
    const runs = tx.objectStore(RUN_STORE);
    const rows = tx.objectStore(RUN_EVENT_STORE);
    const found = runs.get(runId);
    found.onsuccess = guarded(fail, () => {
      const run = found.result as RunRow | undefined;
      if (run === undefined) {
        fail(new RunNotFoundError(runId));
        return;
      }
      for (const event of events) rows.add({ ...event, runId } satisfies RunEventRow);
      if (events.length > 0 || Object.keys(patch).length > 0) runs.put({ ...run, ...patch } satisfies RunRow);
      done();
    });
  });
}

/** Changes a run's record: its status, or that it cannot resume. */
export function updateRun(store: RuntimeStore, runId: string, patch: RunPatch): Promise<void> {
  return appendRunEvents(store, runId, [], patch);
}

/** One run's record, or `undefined`. */
export function readRun(store: RuntimeStore, runId: string): Promise<RunRow | undefined> {
  return transact<RunRow | undefined>(store.db, [RUN_STORE], 'readonly', (tx, done, fail) => {
    const request = tx.objectStore(RUN_STORE).get(runId);
    request.onsuccess = guarded(fail, () => done(request.result as RunRow | undefined));
  });
}

/** Every run of a project, oldest first. */
export function readRuns(store: RuntimeStore, projectId: string): Promise<RunRow[]> {
  return transact<RunRow[]>(store.db, [RUN_STORE], 'readonly', (tx, done, fail) => {
    const request = tx.objectStore(RUN_STORE).index(RUN_PROJECT_INDEX).getAll(projectId);
    request.onsuccess = guarded(fail, () => done((request.result as RunRow[]).sort(byCreated)));
  });
}

/** The runs of a project that have not settled, oldest first. */
export async function readOpenRuns(store: RuntimeStore, projectId: string): Promise<RunRow[]> {
  return (await readRuns(store, projectId)).filter((run) => OPEN_RUN_STATUSES.includes(run.status));
}

/** One run's events in the order they were appended. */
export function readRunEvents(store: RuntimeStore, runId: string): Promise<RunEventRow[]> {
  return transact<RunEventRow[]>(store.db, [RUN_EVENT_STORE], 'readonly', (tx, done, fail) => {
    const request = tx.objectStore(RUN_EVENT_STORE).index(RUN_EVENT_RUN_INDEX).getAll(runId);
    request.onsuccess = guarded(fail, () => done((request.result as RunEventRow[]).sort((a, b) => a.seq - b.seq)));
  });
}

/**
 * Marks every run of the project that still says it is running as interrupted, and answers how many it marked. A tab that has just
 * taken the project's lease calls it: the lease allows one live tab per project, so a run found running is one whose tab is gone.
 */
export function markRunsInterrupted(store: RuntimeStore, projectId: string, now: number = Date.now()): Promise<number> {
  return transact<number>(store.db, [RUN_STORE], 'readwrite', (tx, done, fail) => {
    const runs = tx.objectStore(RUN_STORE);
    const request = runs.index(RUN_PROJECT_INDEX).getAll(projectId);
    request.onsuccess = guarded(fail, () => {
      let marked = 0;
      for (const run of request.result as RunRow[]) {
        if (!LIVE_RUN_STATUSES.includes(run.status)) continue;
        runs.put({ ...run, status: 'interrupted', updatedAt: now } satisfies RunRow);
        marked += 1;
      }
      done(marked);
    });
  });
}

/** Deletes one run and its events: the writer's "Discard log". The writes the run made stay in the project. */
export function deleteRun(store: RuntimeStore, runId: string): Promise<void> {
  return transact<void>(store.db, [RUN_STORE, RUN_EVENT_STORE], 'readwrite', (tx, done, fail) => {
    const events = tx.objectStore(RUN_EVENT_STORE);
    const request = events.index(RUN_EVENT_RUN_INDEX).getAll(runId);
    request.onsuccess = guarded(fail, () => {
      for (const event of request.result as RunEventRow[]) events.delete([event.runId, event.seq]);
      tx.objectStore(RUN_STORE).delete(runId);
      done();
    });
  });
}

/** How long a settled run is kept, and how many a project keeps: the checkpoints' thirty days, and fifty runs. */
export interface RunRetention {
  readonly days: number;
  readonly count: number;
}

export const DEFAULT_RUN_RETENTION: RunRetention = Object.freeze({ days: 30, count: 50 });

const DAY_MS = 86_400_000;

/**
 * Deletes the runs a project no longer keeps and answers how many went. A run that is running or waiting on a card is never evicted:
 * a live run is not stale. Every other run is kept while it is newer than `days` and among the newest `count`.
 */
export async function pruneRuns(store: RuntimeStore, projectId: string, now: number = Date.now(), keep: RunRetention = DEFAULT_RUN_RETENTION): Promise<number> {
  const runs = await readRuns(store, projectId);
  const cutoff = now - keep.days * DAY_MS;
  const settled = runs.filter((run) => !LIVE_RUN_STATUSES.includes(run.status)).sort((a, b) => b.createdAt - a.createdAt);
  const evict = settled.filter((run, index) => index >= keep.count || run.updatedAt < cutoff);
  for (const run of evict) await deleteRun(store, run.runId);
  return evict.length;
}

function byCreated(a: RunRow, b: RunRow): number {
  return a.createdAt - b.createdAt;
}
