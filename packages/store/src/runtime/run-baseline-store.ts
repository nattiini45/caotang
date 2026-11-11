import { guarded, transact, RUN_STORE, type RuntimeStore } from './store.js';
import { readRun, readRuns, RunNotFoundError, type RunRow } from './run-log-store.js';

export interface RunBaseline {
  readonly version: 1;
  readonly capturedAt: number;
  readonly textFiles: Readonly<Record<string, string>>;
  readonly binaryFiles: Readonly<Record<string, Uint8Array>>;
  readonly revisions: Readonly<Record<string, number>>;
  readonly coherence?: string;
}

function baselineOf(row: RunRow): RunBaseline | undefined {
  const value = (row as RunRow & { readonly baseline?: unknown }).baseline;
  if (value === undefined) return undefined;
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
  const plain = (input: unknown): input is Record<string, unknown> => typeof input === 'object' && input !== null && !Array.isArray(input);
  if (record?.['version'] !== 1 || typeof record['capturedAt'] !== 'number' || !Number.isFinite(record['capturedAt'])
    || !plain(record['textFiles']) || !Object.values(record['textFiles']).every((text) => typeof text === 'string')
    || !plain(record['binaryFiles']) || !Object.values(record['binaryFiles']).every((bytes) => bytes instanceof Uint8Array)
    || !plain(record['revisions']) || !Object.values(record['revisions']).every((revision) => typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0)
    || (record['coherence'] !== undefined && typeof record['coherence'] !== 'string')) throw new Error('the run restore point is damaged or from another version');
  return value as RunBaseline;
}

export async function readRunBaseline(store: RuntimeStore, projectId: string, runId: string): Promise<RunBaseline | undefined> {
  const row = await readRun(store, runId);
  if (row === undefined || row.projectId !== projectId) throw new RunNotFoundError(runId);
  return baselineOf(row);
}

export async function readRunBaselines(store: RuntimeStore, projectId: string): Promise<readonly RunBaseline[]> {
  return (await readRuns(store, projectId)).flatMap((row) => {
    const baseline = baselineOf(row);
    return baseline === undefined ? [] : [baseline];
  });
}

export function writeRunBaseline(store: RuntimeStore, projectId: string, runId: string, baseline: RunBaseline): Promise<boolean> {
  return transact<boolean>(store.db, [RUN_STORE], 'readwrite', (tx, done, fail) => {
    const runs = tx.objectStore(RUN_STORE);
    const request = runs.get(runId);
    request.onsuccess = guarded(fail, () => {
      const row = request.result as RunRow | undefined;
      if (row === undefined || row.projectId !== projectId) { fail(new RunNotFoundError(runId)); return; }
      if (baselineOf(row) !== undefined) { done(false); return; }
      if (row.status !== 'running' && row.status !== 'awaiting-approval') throw new Error('the run no longer owns a writing step');
      baselineOf({ ...row, baseline } as RunRow);
      runs.put({ ...row, baseline });
      done(true);
    });
  });
}
