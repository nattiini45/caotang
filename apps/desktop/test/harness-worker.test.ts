
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { assembleProjected, computeScanWorker, projectScanInput } from '@caotang/harness';
import { emptyCoherenceFile } from '@caotang/coherence';

import { projectContextInput } from '../../../packages/context/src/index.js';
import { STORM, makeState } from '../../../packages/harness/test/fixtures.js';
import { createHarnessWorker } from '../src/workers/harness-worker-port.js';
import type { HarnessWorkerReply, HarnessWorkerRequest } from '../src/workers/harness-protocol.js';

class HeldWorker {
  static instances: HeldWorker[] = [];
  readonly messages: HarnessWorkerRequest[] = [];
  readonly terminate = vi.fn();
  onmessage: ((event: MessageEvent<HarnessWorkerReply>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor(readonly url: URL, readonly options: WorkerOptions) {
    HeldWorker.instances.push(this);
  }
  postMessage(message: HarnessWorkerRequest): void {
    this.messages.push(structuredClone(message));
  }
  async answer(index = 0): Promise<void> {
    const request = this.messages[index]!;
    const reply: HarnessWorkerReply =
      request.op === 'assemble'
        ? { id: request.id, ok: true, op: 'assemble', call: assembleProjected(request.input, request.role, request.languages) }
        : { id: request.id, ok: true, op: 'scan', outcome: await computeScanWorker(request.input) };
    this.onmessage?.(new MessageEvent('message', { data: reply }));
  }
  raw(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}

const assembleInput = () =>
  projectContextInput({ tool: 'scene.draft', instruction: 'Brief: the lamp fails.', focus: STORM, mode: 'continue' }, { state: makeState() }, {});
const scanInput = () => ({
  ...projectScanInput(makeState(), emptyCoherenceFile(), undefined),
  params: { scope: { mode: 'full' } },
  approvedLargeScope: true,
});

beforeEach(() => {
  HeldWorker.instances = [];
  vi.stubGlobal('Worker', HeldWorker);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('creates a same-origin module worker lazily and reuses it across both operations', async () => {
  const handle = createHarnessWorker();
  expect(HeldWorker.instances).toHaveLength(0);
  const first = handle.assemble(assembleInput(), 'ROLE', undefined);
  const worker = HeldWorker.instances[0]!;
  expect(worker.url.pathname).toMatch(/harness-worker\.ts$/);
  expect(worker.options).toEqual({ type: 'module' });
  await worker.answer(0);
  await first;
  const second = handle.scan(scanInput());
  expect(HeldWorker.instances).toHaveLength(1);
  await worker.answer(1);
  expect((await second).ok).toBe(true);
  handle.dispose();
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('assembles to the same bytes the synchronous worker-side computation returns', async () => {
  const handle = createHarnessWorker();
  const input = assembleInput();
  const pending = handle.assemble(input, 'ROLE', { ui: 'de', project: 'fr' });
  const worker = HeldWorker.instances[0]!;
  await worker.answer(0);
  const call = await pending;
  expect(call).toEqual(assembleProjected(structuredClone(input), 'ROLE', { ui: 'de', project: 'fr' }));
  handle.dispose();
});

it('computes a scan and returns drafts and coverage, not a held file', async () => {
  const handle = createHarnessWorker();
  const pending = handle.scan(scanInput());
  const worker = HeldWorker.instances[0]!;
  await worker.answer(0);
  const outcome = await pending;
  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    expect(outcome.count).toBeGreaterThan(0);
    expect(Array.isArray(outcome.compute.drafts)).toBe(true);
    expect(outcome.compute.ranIds.length).toBeGreaterThan(0);
  }
  handle.dispose();
});

it('cancels one waiting call without losing another, then terminates when no live job remains', async () => {
  const handle = createHarnessWorker();
  const a = new AbortController();
  const b = new AbortController();
  const first = handle.assemble(assembleInput(), 'ROLE', undefined, a.signal);
  const second = handle.assemble(assembleInput(), 'ROLE', undefined, b.signal);
  const worker = HeldWorker.instances[0]!;
  a.abort();
  await expect(first).rejects.toThrow();
  expect(worker.terminate).not.toHaveBeenCalled();
  await worker.answer(1);
  await expect(second).resolves.toBeDefined();
  const third = handle.assemble(assembleInput(), 'ROLE', undefined, b.signal);
  b.abort();
  await expect(third).rejects.toThrow();
  expect(worker.terminate).toHaveBeenCalledOnce();
  handle.dispose();
});

it('drops a late reply for an already-cancelled id without acting on it', async () => {
  const handle = createHarnessWorker();
  const controller = new AbortController();
  const pending = handle.assemble(assembleInput(), 'ROLE', undefined, controller.signal);
  const worker = HeldWorker.instances[0]!;
  controller.abort();
  await expect(pending).rejects.toThrow();
  await worker.answer(0);
  expect(worker.terminate).toHaveBeenCalledOnce();
  handle.dispose();
});

it('ignores a cancelled id while another job is still using the same worker', async () => {
  const handle = createHarnessWorker();
  const controller = new AbortController();
  const cancelled = handle.assemble(assembleInput(), 'ROLE', undefined, controller.signal);
  const running = handle.scan(scanInput());
  const worker = HeldWorker.instances[0]!;
  controller.abort();
  await expect(cancelled).rejects.toThrow();
  await worker.answer(0);
  expect(worker.terminate).not.toHaveBeenCalled();
  await worker.answer(1);
  await expect(running).resolves.toMatchObject({ ok: true });
  handle.dispose();
});

it.each(['error', 'messageerror', 'dispose', 'failed-reply', 'malformed'] as const)('settles every pending request on %s without a synchronous fallback', async (kind) => {
  const handle = createHarnessWorker();
  const first = handle.assemble(assembleInput(), 'ROLE', undefined);
  const second = handle.scan(scanInput());
  const worker = HeldWorker.instances[0]!;
  if (kind === 'error') worker.onerror?.();
  if (kind === 'messageerror') worker.onmessageerror?.();
  if (kind === 'dispose') handle.dispose();
  if (kind === 'failed-reply') for (const request of worker.messages) worker.raw({ id: request.id, ok: false, error: 'worker-failed' });
  if (kind === 'malformed') worker.raw({ nonsense: true });
  await expect(first).rejects.toThrow();
  await expect(second).rejects.toThrow();
  if (kind !== 'failed-reply') expect(worker.terminate).toHaveBeenCalledOnce();
  handle.dispose();
});

it('a clone failure on postMessage rejects that request', async () => {
  const handle = createHarnessWorker();
  vi.spyOn(HeldWorker.prototype, 'postMessage').mockImplementation(() => {
    throw new Error('clone failed');
  });
  await expect(handle.assemble(assembleInput(), 'ROLE', undefined)).rejects.toThrow();
  handle.dispose();
});

it.each([
  { id: Number.NaN, ok: true, op: 'scan' },
  { id: Number.POSITIVE_INFINITY, ok: true, op: 'assemble' },
  { id: 999, ok: false, error: 'unknown request' },
  { id: 1, ok: true, op: 'assemble' },
  { id: 1, ok: true, op: 'assemble', call: { messages: [], preview: {}, prompt: {} } },
  { id: 1, ok: true, op: 'scan', outcome: { ok: true, count: 1 } },
  { id: 1, ok: true, op: 'scan', outcome: { ok: false, code: 42, message: 'bad' } },
])('rejects malformed operation payloads and settles every pending job: %j', async (reply) => {
  const handle = createHarnessWorker();
  const first = handle.assemble(assembleInput(), 'ROLE', undefined);
  const second = handle.scan(scanInput());
  const worker = HeldWorker.instances[0]!;
  worker.raw(reply);
  await expect(first).rejects.toThrow();
  await expect(second).rejects.toThrow();
  expect(worker.terminate).toHaveBeenCalledOnce();
  handle.dispose();
});

it('rejects malformed nested check data before it can reach publication', async () => {
  const handle = createHarnessWorker();
  const input = scanInput();
  const pending = handle.scan(input);
  const worker = HeldWorker.instances[0]!;
  const outcome = await computeScanWorker(input);
  if (!outcome.ok) throw new Error('The fixture must compute a scan.');
  worker.raw({ id: 1, ok: true, op: 'scan', outcome: { ...outcome, compute: { ...outcome.compute, reviewed: [null] } } });
  await expect(pending).rejects.toThrow();
  expect(worker.terminate).toHaveBeenCalledOnce();
  handle.dispose();
});

it('refuses missing worker support and an already-aborted call before creating a worker', async () => {
  vi.stubGlobal('Worker', undefined);
  const handle = createHarnessWorker();
  const controller = new AbortController();
  controller.abort();
  await expect(handle.assemble(assembleInput(), 'ROLE', undefined)).rejects.toThrow();
  await expect(handle.assemble(assembleInput(), 'ROLE', undefined, controller.signal)).rejects.toThrow();
  expect(HeldWorker.instances).toHaveLength(0);
  handle.dispose();
});

it('starts a fresh worker for a retry after a failure terminated the old one', async () => {
  const handle = createHarnessWorker();
  const first = handle.assemble(assembleInput(), 'ROLE', undefined);
  const worker = HeldWorker.instances[0]!;
  worker.onerror?.();
  await expect(first).rejects.toThrow();
  expect(worker.terminate).toHaveBeenCalledOnce();
  const retry = handle.assemble(assembleInput(), 'ROLE', undefined);
  expect(HeldWorker.instances).toHaveLength(2);
  const next = HeldWorker.instances[1]!;
  await next.answer(0);
  await expect(retry).resolves.toBeDefined();
  handle.dispose();
});

it('rejects after disposal and does not start a worker', async () => {
  const handle = createHarnessWorker();
  handle.dispose();
  await expect(handle.assemble(assembleInput(), 'ROLE', undefined)).rejects.toThrow();
  await expect(handle.scan(scanInput())).rejects.toThrow();
  expect(HeldWorker.instances).toHaveLength(0);
});
