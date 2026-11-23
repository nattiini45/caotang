
import { t } from '@lingui/core/macro';

import type { ScanComputeOutcome } from '@caotang/coherence';
import type { AssembledCall, LanguagePolicy, ProjectedContextInput, ScanWorkerInput } from '@caotang/harness';

import type { HarnessWorkerReply, HarnessWorkerRequest } from './harness-protocol.js';
import { harnessWorkerUrl } from './harness-worker-url.js';

export interface HarnessWorkerHandle {
  assemble(input: ProjectedContextInput, role: string, languages: LanguagePolicy | undefined, signal?: AbortSignal): Promise<AssembledCall>;
  scan(input: ScanWorkerInput, signal?: AbortSignal): Promise<ScanComputeOutcome>;
  dispose(): void;
}

const unavailable = (): Error => new Error(t`Background preparation is unavailable. Nothing was written. Try again, or reopen the project in a browser with worker support.`);
const cancelled = (): Error => new Error(t`The background preparation was cancelled.`);

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function createHarnessWorker(): HarnessWorkerHandle {
  let worker: Worker | undefined;
  let closed = false;
  let nextId = 0;
  const pending = new Map<number, (reply: HarnessWorkerReply | null) => void>();

  const terminate = (): void => {
    if (worker === undefined) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
    worker = undefined;
  };
  const failAll = (): void => {
    terminate();
    for (const settle of [...pending.values()]) settle(null);
  };
  const ensureWorker = (): void => {
    if (worker !== undefined) return;
    worker = new Worker(new URL(harnessWorkerUrl, import.meta.url), { type: 'module' });
    worker.onmessage = async ({ data }: MessageEvent<HarnessWorkerReply>): Promise<void> => {
      if (!record(data) || !Number.isSafeInteger(data.id) || data.id <= 0 || data.id > nextId) {
        failAll();
        return;
      }
      const settle = pending.get(data.id);
      if (settle === undefined) return;
      if (data.ok === false && typeof data.error === 'string') {
        settle(data);
        return;
      }
      const replyingWorker = worker;
      try {
        const { callOk, outcomeOk } = await import('./harness-worker-validation.js');
        if (worker !== replyingWorker || pending.get(data.id) !== settle) return;
        if (data.ok !== true || (data.op === 'assemble' ? !callOk(data.call) : data.op !== 'scan' || !outcomeOk(data.outcome))) {
          failAll();
          return;
        }
        settle(data);
      } catch {
        if (worker === replyingWorker) failAll();
      }
    };
    worker.onerror = (): void => failAll();
    worker.onmessageerror = (): void => failAll();
  };

  const send = <T>(build: (id: number) => HarnessWorkerRequest, signal: AbortSignal | undefined, handle: (reply: HarnessWorkerReply | null) => T): Promise<T> => {
    if (signal?.aborted === true) return Promise.reject(cancelled());
    if (closed) return Promise.reject(unavailable());
    try {
      ensureWorker();
    } catch {
      return Promise.reject(unavailable());
    }
    return new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      const cleanup = (): void => {
        pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        reject(cancelled());
        if (pending.size === 0) terminate();
      };
      pending.set(id, (reply) => {
        cleanup();
        try {
          resolve(handle(reply));
        } catch (error) {
          reject(error instanceof Error ? error : unavailable());
        }
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        (worker as Worker).postMessage(build(id));
      } catch {
        cleanup();
        reject(unavailable());
      }
    });
  };

  return {
    assemble: (input, role, languages, signal) =>
      send(
        (id) => ({ id, op: 'assemble', input, role, ...(languages === undefined ? {} : { languages }) }),
        signal,
        (reply) => {
          if (reply === null || !reply.ok || reply.op !== 'assemble') throw unavailable();
          return reply.call;
        },
      ),
    scan: (input, signal) =>
      send(
        (id) => ({ id, op: 'scan', input }),
        signal,
        (reply) => {
          if (reply === null || !reply.ok || reply.op !== 'scan') throw unavailable();
          return reply.outcome;
        },
      ),
    dispose: (): void => {
      closed = true;
      failAll();
    },
  };
}
