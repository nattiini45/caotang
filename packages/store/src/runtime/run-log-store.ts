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
 * file, never in a bundle, and never in the key vault. Unreferenced runs use the checkpoints' clock: thirty days, fifty runs
 * (`pruneRuns`). A retained session or fork keeps its referenced runs.
 */

import { canMove, type Machine, type MachineTable } from '@caotang/machine';

import { guarded, transact, AGENT_SESSION_PROJECT_INDEX, AGENT_SESSION_STORE, RUN_EVENT_RUN_INDEX, RUN_EVENT_STORE, RUN_PROJECT_INDEX, RUN_STORE, type RuntimeStore } from './store.js';
import { deleteRunRecords, type AgentSessionRow } from './agent-sessions.js';

/** Where a run stands. `interrupted` is a run a reload, a crash or a closed tab left unfinished; only the writer resumes or discards it. */
export type RunStatus = 'running' | 'awaiting-approval' | 'interrupted' | 'finished' | 'failed';

type RunStatusState = { [K in RunStatus]: { readonly kind: K } }[RunStatus];
type RunStatusEvent = { [K in RunStatus]: { readonly type: K } }[RunStatus];

export const runStatusTable: MachineTable<RunStatusState, RunStatusEvent> = {
  id: 'run.status',
  initial: 'running',
  final: ['finished', 'failed'],
  on: {
    running: {
      running: ['running'], 'awaiting-approval': ['awaiting-approval'], interrupted: ['interrupted'],
      finished: ['finished'], failed: ['failed'],
    },
    'awaiting-approval': {
      running: ['running'], 'awaiting-approval': ['awaiting-approval'], interrupted: ['interrupted'],
      finished: ['finished'], failed: ['failed'],
    },
    interrupted: { running: ['running'], interrupted: ['interrupted'], finished: ['finished'], failed: ['failed'] },
    finished: {},
    failed: {},
  },
};

export const runStatusMachine: Machine<RunStatusState, RunStatusEvent> = {
  table: runStatusTable,
  step: (state, event) => canMove(runStatusTable, state.kind, event.type) ? { kind: event.type } : state,
};

export class RunStatusTransitionError extends Error {
  constructor(readonly runId: string, readonly from: RunStatus, readonly to: RunStatus) {
    super(`run "${runId}" cannot change status from ${from} to ${to}`);
    this.name = 'RunStatusTransitionError';
  }
}

/** Accepts same-state writes, including terminal rows, but refuses an illegal lifecycle move. */
export function assertRunStatusTransition(runId: string, from: RunStatus, to: RunStatus): void {
  if (runStatusMachine.step({ kind: from }, { type: to }).kind !== to) throw new RunStatusTransitionError(runId, from, to);
}

/** How the turn ended. Older records can omit this without changing their lifecycle status. */
export type RunOutcome = 'replied' | 'applied' | 'failed' | 'cancelled' | 'stopped';

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
  readonly outcome?: RunOutcome;
  /** A write to the log failed, so the log no longer describes the run and it is not offered for resume. */
  readonly cannotResume?: true;
  readonly presentation?: unknown;
}

/** What an append may change on the run record. */
export interface RunPatch {
  readonly status?: RunStatus;
  readonly outcome?: RunOutcome;
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
      if (patch.status !== undefined) assertRunStatusTransition(runId, run.status, patch.status);
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
  return transact<void>(store.db, [RUN_STORE, RUN_EVENT_STORE, AGENT_SESSION_STORE], 'readwrite', (tx, done, fail) => {
    const sessions = tx.objectStore(AGENT_SESSION_STORE);
    const request = sessions.getAll();
    request.onsuccess = guarded(fail, () => {
      for (const row of request.result as AgentSessionRow[]) {
        if (row.turns.some((ref) => ref.runId === runId)) sessions.put({ ...row, turns: row.turns.filter((ref) => ref.runId !== runId) } satisfies AgentSessionRow);
      }
      deleteRunRecords(tx, runId, fail);
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
 * Deletes the runs a project no longer keeps and answers how many went. An open run, including an interrupted run, is never evicted.
 * Referenced runs are retained without consuming the unreferenced cap. An unreferenced settled run is kept while it is newer than
 * `days` and among the newest `count` unreferenced runs.
 */
export function pruneRuns(store: RuntimeStore, projectId: string, now: number = Date.now(), keep: RunRetention = DEFAULT_RUN_RETENTION): Promise<number> {
  return transact<number>(store.db, [RUN_STORE, RUN_EVENT_STORE, AGENT_SESSION_STORE], 'readwrite', (tx, done, fail) => {
    const runs = tx.objectStore(RUN_STORE).index(RUN_PROJECT_INDEX).getAll(projectId);
    runs.onsuccess = guarded(fail, () => {
      const sessions = tx.objectStore(AGENT_SESSION_STORE).index(AGENT_SESSION_PROJECT_INDEX).getAll(projectId);
      sessions.onsuccess = guarded(fail, () => {
        const referenced = new Set((sessions.result as AgentSessionRow[]).flatMap((row) => row.turns.map((ref) => ref.runId)));
        const cutoff = now - keep.days * DAY_MS;
        const settled = (runs.result as RunRow[]).filter((run) => !OPEN_RUN_STATUSES.includes(run.status) && !referenced.has(run.runId))
          .sort((a, b) => b.createdAt - a.createdAt);
        const evict = settled.filter((run, index) => index >= keep.count || run.updatedAt < cutoff);
        for (const run of evict) deleteRunRecords(tx, run.runId, fail);
        done(evict.length);
      });
    });
  });
}

function byCreated(a: RunRow, b: RunRow): number {
  return a.createdAt - b.createdAt;
}

/** The run log as the harness's `RunLogPort` takes it: the functions above over one runtime store, with retention's clock. */
export interface RunLogStorePort {
  create(run: RunRow): Promise<void>;
  append(runId: string, events: readonly RunEventInput[], patch?: RunPatch): Promise<void>;
  update(runId: string, patch: RunPatch): Promise<void>;
  open(projectId: string, options?: { readonly includeSettled?: boolean }): Promise<readonly RunRow[]>;
  events(runId: string): Promise<readonly RunEventRow[]>;
  discard(runId: string): Promise<void>;
  prune(projectId: string, keep: RunRetention): Promise<number>;
}

export function createRunLogPort(store: RuntimeStore): RunLogStorePort {
  return {
    create: (run) => createRun(store, run),
    append: (runId, events, patch) => appendRunEvents(store, runId, events, patch),
    update: (runId, patch) => updateRun(store, runId, patch),
    open: (projectId, options) => options?.includeSettled === true ? readRuns(store, projectId) : readOpenRuns(store, projectId),
    events: (runId) => readRunEvents(store, runId),
    discard: (runId) => deleteRun(store, runId),
    prune: (projectId, keep) => pruneRuns(store, projectId, Date.now(), keep),
  };
}
