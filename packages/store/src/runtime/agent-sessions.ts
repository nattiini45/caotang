import type { RunEventRow, RunRow } from './run-log-store.js';
import {
  AGENT_SESSION_PROJECT_INDEX, AGENT_SESSION_STORE, PROJECT_STORE, ProjectNotFoundError,
  RUN_EVENT_RUN_INDEX, RUN_EVENT_STORE, RUN_STORE, guarded, transact, type RuntimeStore,
} from './store.js';

export interface AgentSessionTurnRef {
  readonly runId: string;
  readonly role: 'chat' | 'drafting' | 'background';
  readonly rewound?: boolean;
  readonly restoredAt?: number;
  readonly restoredFromStep?: number;
}

export interface AgentSessionRow {
  readonly projectId: string;
  readonly sessionId: string;
  readonly formatVersion: 1;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly active: boolean;
  readonly turns: readonly AgentSessionTurnRef[];
  readonly nextTurn?: Readonly<Partial<Record<AgentSessionTurnRef['role'], number>>>;
  readonly forkedFrom?: { readonly sessionId: string; readonly turnSeq: number };
}

export interface AgentSessionRetention {
  readonly days: number;
  readonly count: number;
}

export const DEFAULT_AGENT_SESSION_RETENTION: AgentSessionRetention = Object.freeze({ days: 30, count: 50 });

function byUpdated(a: AgentSessionRow, b: AgentSessionRow): number {
  return b.updatedAt - a.updatedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);
}

export function readAgentSessions(store: RuntimeStore, projectId: string): Promise<AgentSessionRow[]> {
  return transact<AgentSessionRow[]>(store.db, [AGENT_SESSION_STORE], 'readonly', (tx, done, fail) => {
    const request = tx.objectStore(AGENT_SESSION_STORE).index(AGENT_SESSION_PROJECT_INDEX).getAll(projectId);
    request.onsuccess = guarded(fail, () => done((request.result as AgentSessionRow[]).sort(byUpdated)));
  });
}

function persistSession(store: RuntimeStore, row: AgentSessionRow, turn?: { runId: string; presentation: unknown }): Promise<void> {
  return transact<void>(store.db, [PROJECT_STORE, RUN_STORE, AGENT_SESSION_STORE], 'readwrite', (tx, done, fail) => {
    const project = tx.objectStore(PROJECT_STORE).get(row.projectId);
    project.onsuccess = guarded(fail, () => {
      if (project.result === undefined) throw new ProjectNotFoundError(row.projectId);
      if (row.formatVersion !== 1) throw new Error('unsupported agent session version');
      if (row.nextTurn !== undefined && Object.values(row.nextTurn).some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error('agent session counters need positive whole numbers');
      if (turn !== undefined && !row.turns.some((ref) => ref.runId === turn.runId)) throw new Error('the settled turn must be referenced by its session');
      const runs = tx.objectStore(RUN_STORE);
      const ids = [...new Set(row.turns.map((ref) => ref.runId))];
      let left = ids.length;
      const write = (): void => {
        const sessions = tx.objectStore(AGENT_SESSION_STORE);
        const request = sessions.index(AGENT_SESSION_PROJECT_INDEX).getAll(row.projectId);
        request.onsuccess = guarded(fail, () => {
          if (row.active) {
            for (const prior of request.result as AgentSessionRow[]) {
              if (prior.active && prior.sessionId !== row.sessionId) sessions.put({ ...prior, active: false } satisfies AgentSessionRow);
            }
          }
          sessions.put(row);
          done();
        });
      };
      if (left === 0) write();
      for (const id of ids) {
        const request = runs.get(id);
        request.onsuccess = guarded(fail, () => {
          const run = request.result as RunRow | undefined;
          if (run === undefined || run.projectId !== row.projectId) throw new Error(`run "${id}" does not belong to project "${row.projectId}"`);
          if (run.status !== 'finished' && run.status !== 'failed') throw new Error(`run "${id}" has not settled`);
          if (turn?.runId === id) runs.put({ ...run, presentation: turn.presentation } satisfies RunRow);
          left -= 1;
          if (left === 0) write();
        });
      }
    });
  });
}

export function saveAgentSession(store: RuntimeStore, row: AgentSessionRow): Promise<void> {
  return persistSession(store, row);
}

export function settleAgentSessionTurn(store: RuntimeStore, row: AgentSessionRow, runId: string, presentation: unknown): Promise<void> {
  return persistSession(store, row, { runId, presentation });
}

export function agentSessionReferences(store: RuntimeStore, projectId: string, runId: string): Promise<number> {
  return transact<number>(store.db, [AGENT_SESSION_STORE], 'readonly', (tx, done, fail) => {
    const request = tx.objectStore(AGENT_SESSION_STORE).index(AGENT_SESSION_PROJECT_INDEX).getAll(projectId);
    request.onsuccess = guarded(fail, () => done((request.result as AgentSessionRow[]).filter((row) => row.turns.some((ref) => ref.runId === runId)).length));
  });
}

export function deleteRunRecords(tx: IDBTransaction, runId: string, fail: (error: unknown) => void): void {
  tx.objectStore(RUN_STORE).delete(runId);
  const events = tx.objectStore(RUN_EVENT_STORE);
  const request = events.index(RUN_EVENT_RUN_INDEX).getAll(runId);
  request.onsuccess = guarded(fail, () => {
    for (const event of request.result as RunEventRow[]) events.delete([event.runId, event.seq]);
  });
}

function removeSessions(tx: IDBTransaction, projectId: string, rows: readonly AgentSessionRow[], removed: readonly AgentSessionRow[], fail: (error: unknown) => void): void {
  const sessions = tx.objectStore(AGENT_SESSION_STORE);
  const removedIds = new Set(removed.map((row) => row.sessionId));
  const retainedRuns = new Set(rows.filter((row) => !removedIds.has(row.sessionId)).flatMap((row) => row.turns.map((ref) => ref.runId)));
  const candidates = new Set(removed.flatMap((row) => row.turns.map((ref) => ref.runId)));
  for (const row of removed) sessions.delete([projectId, row.sessionId]);
  for (const runId of candidates) {
    if (retainedRuns.has(runId)) continue;
    const request = tx.objectStore(RUN_STORE).get(runId);
    request.onsuccess = guarded(fail, () => {
      const run = request.result as RunRow | undefined;
      if (run?.projectId === projectId && (run.status === 'finished' || run.status === 'failed')) deleteRunRecords(tx, runId, fail);
    });
  }
}

export function removeAgentSession(store: RuntimeStore, projectId: string, sessionId: string): Promise<void> {
  return transact<void>(store.db, [AGENT_SESSION_STORE, RUN_STORE, RUN_EVENT_STORE], 'readwrite', (tx, done, fail) => {
    const request = tx.objectStore(AGENT_SESSION_STORE).index(AGENT_SESSION_PROJECT_INDEX).getAll(projectId);
    request.onsuccess = guarded(fail, () => {
      const rows = request.result as AgentSessionRow[];
      removeSessions(tx, projectId, rows, rows.filter((row) => row.sessionId === sessionId), fail);
      done();
    });
  });
}

export function planAgentSessionEviction(rows: readonly AgentSessionRow[], now: number, keep: AgentSessionRetention = DEFAULT_AGENT_SESSION_RETENTION): AgentSessionRow[] {
  if (!Number.isFinite(now)) throw new Error('agent session retention needs a finite clock');
  if (!Number.isSafeInteger(keep.days) || keep.days <= 0 || !Number.isSafeInteger(keep.count) || keep.count <= 0) throw new Error('agent session retention needs positive whole-number days and count');
  const ordered = [...rows].sort((a, b) => Number(b.active) - Number(a.active) || byUpdated(a, b));
  return ordered.filter((row, index) => !(index === 0 && row.active) && (index >= keep.count || row.updatedAt < now - keep.days * 86_400_000));
}

export function pruneAgentSessions(store: RuntimeStore, projectId: string, now: number, keep: AgentSessionRetention = DEFAULT_AGENT_SESSION_RETENTION): Promise<number> {
  return transact<number>(store.db, [AGENT_SESSION_STORE, RUN_STORE, RUN_EVENT_STORE], 'readwrite', (tx, done, fail) => {
    const request = tx.objectStore(AGENT_SESSION_STORE).index(AGENT_SESSION_PROJECT_INDEX).getAll(projectId);
    request.onsuccess = guarded(fail, () => {
      const rows = request.result as AgentSessionRow[];
      const removed = planAgentSessionEviction(rows, now, keep);
      removeSessions(tx, projectId, rows, removed, fail);
      done(removed.length);
    });
  });
}
