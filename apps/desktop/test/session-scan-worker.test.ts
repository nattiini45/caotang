import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryIndexedDb, openRuntimeStore, writeProjectState, type ProjectState } from '@caotang/store';
import { emptyCoherenceFile, planReview, type CoherenceFile, type ScanComputeOutcome } from '@caotang/coherence';
import { computeScanWorker, type ScanWorkerInput } from '@caotang/harness';
import { buildState } from '../../../packages/coherence/test/fixtures.js';
import { ProjectSession } from '../src/app/session.js';
import { shadowOf } from '../src/app/persistence-plan.js';
import type { HarnessWorkerHandle } from '../src/workers/harness-worker-port.js';

function fakeWorker() {
  let markStarted = (): void => {};
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let resolveScan: (outcome: ScanComputeOutcome) => void = () => {};
  let rejectScan: (error: Error) => void = () => {};
  let input: ScanWorkerInput | undefined;
  const handle: HarnessWorkerHandle = {
    assemble: vi.fn(),
    scan: vi.fn((given: ScanWorkerInput, signal?: AbortSignal) => {
      input = given;
      return new Promise<ScanComputeOutcome>((resolve, reject) => {
        resolveScan = resolve;
        rejectScan = reject;
        markStarted();
        if (signal?.aborted === true) { reject(new Error('The background preparation was cancelled.')); return; }
        signal?.addEventListener('abort', () => reject(new Error('The background preparation was cancelled.')), { once: true });
      });
    }),
    dispose: vi.fn(),
  };
  return {
    handle,
    started,
    input: (): ScanWorkerInput => input as ScanWorkerInput,
    resolve: async (outcome: ScanComputeOutcome): Promise<void> => { await started; resolveScan(outcome); },
    reject: async (error: Error): Promise<void> => { await started; rejectScan(error); },
  };
}

const open: { session: ProjectSession; store: Awaited<ReturnType<typeof openRuntimeStore>> }[] = [];

beforeEach(() => {
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
});

afterEach(async () => {
  for (const { session, store } of open.splice(0)) {
    await session.close();
    store.close();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function setup(state: ProjectState = buildState({ scenes: [{ id: 'n_SCENE00001', title: 'Scene', body: 'The ferry arrived.' }] })) {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  await writeProjectState(store, state);
  const session = new ProjectSession({ store, state, projectId: state.manifest.project.id, shadow: shadowOf(state) });
  session.attachCoherence({ file: emptyCoherenceFile(), writable: true, notices: [] }, { save: async () => {}, attachFolder: async () => {} });
  const worker = fakeWorker();
  vi.spyOn(session, 'harnessWorker').mockReturnValue(worker.handle);
  open.push({ session, store });
  return { state, store, session, worker };
}

async function outcomeFor(worker: ReturnType<typeof fakeWorker>): Promise<ScanComputeOutcome> {
  await worker.started;
  return computeScanWorker(worker.input());
}

it('publishes the worker’s drafts and records the run on the main thread', async () => {
  const { session, worker } = await setup();
  const pending = session.scanCoherenceAsync({ approvedLargeScope: false });
  await worker.started;
  expect(worker.handle.scan).toHaveBeenCalledOnce();
  worker.resolve(await outcomeFor(worker));
  const result = await pending;
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data.documents).toBe(1);
  expect(session.state.coherence?.runs).toHaveLength(1);
  expect(session.scanInFlight()).toBe(false);
});

it('sends only the held file’s check inputs, never its old findings or runs', async () => {
  const { session, worker } = await setup();
  const pending = session.scanCoherenceAsync({ approvedLargeScope: false });
  await worker.started;
  const sent = worker.input();
  expect(Object.keys(sent.file).sort()).toEqual(['knowledge', 'reviewState', 'sceneMeta']);
  expect(sent.file).not.toHaveProperty('findings');
  expect(sent.file).not.toHaveProperty('runs');
  expect(sent.state.documents.has('n_SCENE00001')).toBe(true);
  worker.resolve(await outcomeFor(worker));
  await pending;
});

it('refuses a second scan while one is in flight, and the first still finishes', async () => {
  const { session, worker } = await setup();
  const first = session.scanCoherenceAsync({ approvedLargeScope: false });
  expect(session.scanInFlight()).toBe(true);
  const second = await session.scanCoherenceAsync({ approvedLargeScope: false });
  expect(second.ok).toBe(false);
  if (second.ok) return;
  expect(second.code).toBe('busy');
  worker.resolve(await outcomeFor(worker));
  expect((await first).ok).toBe(true);
});

it('refuses a scan while a model review is running', async () => {
  const { state, session } = await setup();
  const plan = planReview(state, session.coherenceFile() as CoherenceFile, { scope: { mode: 'full' }, maxFindings: 10 });
  session.coherenceReview.plan(plan);
  session.coherenceReview.start((_plan, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Stopped.')), { once: true });
  }));
  const result = await session.scanCoherenceAsync({ approvedLargeScope: false });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe('busy');
  session.coherenceReview.stop();
  await session.coherenceReview.settled();
});

it('cancelling leaves the findings and history unchanged', async () => {
  const { session, worker } = await setup();
  const pending = session.scanCoherenceAsync({ approvedLargeScope: false });
  session.cancelScan();
  const result = await pending;
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe('cancelled');
  expect(session.state.coherence?.runs).toHaveLength(0);
  expect(session.scanInFlight()).toBe(false);
  expect(worker.handle.dispose).not.toHaveBeenCalled();
});

it('a held-file edit while the scan runs makes the result stale and keeps the edit', async () => {
  const { session, worker } = await setup();
  const pending = session.scanCoherenceAsync({ approvedLargeScope: false });
  const file = session.coherenceFile() as CoherenceFile;
  session.applyCoherenceFile({ ...file, sceneMeta: { n_SCENE00001: { dayOffset: 3 } } });
  worker.resolve(await outcomeFor(worker));
  const result = await pending;
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe('stale');
  expect(session.state.coherence?.runs).toHaveLength(0);
  expect(session.state.coherence?.sceneMeta['n_SCENE00001']?.dayOffset).toBe(3);
});

it('a worker failure writes nothing and is retryable', async () => {
  const { session, worker } = await setup();
  const pending = session.scanCoherenceAsync({ approvedLargeScope: false });
  worker.reject(new Error('The worker crashed.'));
  const result = await pending;
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe('worker-unavailable');
  expect(session.state.coherence?.runs).toHaveLength(0);
  expect(session.scanInFlight()).toBe(false);
});

it('a manuscript edit while the worker computes refuses the old result', async () => {
  const { session, state, worker } = await setup();
  const pending = session.scanCoherenceAsync({ approvedLargeScope: false });
  const outcome = await outcomeFor(worker);
  expect(session.dispatch('doc.write', { docId: 'n_SCENE00001', body: 'The writer changed the scene.' }).ok).toBe(true);
  worker.resolve(outcome);
  const result = await pending;
  expect(result).toMatchObject({ ok: false, code: 'stale' });
  expect(state.coherence?.runs).toHaveLength(0);
  expect(state.documents.get('n_SCENE00001')?.body).toBe('The writer changed the scene.');
  expect(session.scanInFlight()).toBe(false);
});

it('refuses publication when a non-deny read rule changes', async () => {
  const { session, worker } = await setup();
  const harness = await session.harnessReady();
  const policy = vi.spyOn(harness, 'readPolicy').mockReturnValue('policy-before');
  const withheld = harness.withheld('coherence.scan');
  const pending = session.scanCoherenceAsync({ approvedLargeScope: false, withheld });
  const outcome = await outcomeFor(worker);
  policy.mockReturnValue('policy-after');
  worker.resolve(outcome);
  expect(await pending).toMatchObject({ ok: false, code: 'stale' });
  expect(session.state.coherence?.runs).toHaveLength(0);
});

it('captures the read-deny set instead of trusting caller mutation during the await', async () => {
  const { session, worker } = await setup();
  const harness = await session.harnessReady();
  const withheld = new Set<string>();
  vi.spyOn(harness, 'withheld').mockImplementation(() => new Set(withheld));
  const pending = session.scanCoherenceAsync({ approvedLargeScope: false, withheld });
  const outcome = await outcomeFor(worker);
  withheld.add('n_SCENE00001');
  worker.resolve(outcome);
  expect(await pending).toMatchObject({ ok: false, code: 'stale' });
  expect(session.state.coherence?.runs).toHaveLength(0);
});

it('an already-cancelled scan never reads a snapshot or starts a worker', async () => {
  const { session, state, worker } = await setup();
  const signal = AbortSignal.abort();
  const document = state.documents.get('n_SCENE00001');
  if (document === undefined) throw new Error('Missing fixture scene.');
  Object.defineProperty(document, 'body', { configurable: true, get: () => { throw new Error('Cancelled scan read a body.'); } });
  expect(await session.scanCoherenceAsync({ approvedLargeScope: false }, signal)).toMatchObject({ ok: false, code: 'cancelled' });
  expect(worker.handle.scan).not.toHaveBeenCalled();
  Object.defineProperty(document, 'body', { configurable: true, value: 'The ferry arrived.', writable: true });
});

it('passes a scope refusal through without publishing', async () => {
  const { session, worker } = await setup();
  const pending = session.scanCoherenceAsync({ approvedLargeScope: false });
  worker.resolve({ ok: false, code: 'confirmation-required', message: 'This scope is over the guard.' });
  const result = await pending;
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe('confirmation-required');
  expect(session.state.coherence?.runs).toHaveLength(0);
});

it('says so when no findings file is open', async () => {
  const { session } = await setup();
  session.state.coherence = undefined;
  const result = await session.scanCoherenceAsync({ approvedLargeScope: false });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe('no-file');
});

it('closing the project cancels the in-flight scan without publishing', async () => {
  const { session, store } = await setup();
  const pending = session.scanCoherenceAsync({ approvedLargeScope: false });
  await session.close();
  store.close();
  open.length = 0;
  const result = await pending;
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(['cancelled', 'closed']).toContain(result.code);
});

it('an agent scan whose captured read boundary matches the live one publishes', async () => {
  const { session, worker } = await setup();
  const harness = await session.harnessReady();
  const withheld = harness.withheld('coherence.scan');
  const pending = session.scanCoherenceAsync({ approvedLargeScope: false, withheld });
  worker.resolve(await outcomeFor(worker));
  const result = await pending;
  expect(result.ok).toBe(true);
  expect(session.state.coherence?.runs).toHaveLength(1);
});

it('an agent scan whose captured read boundary no longer matches is stale', async () => {
  const { session, worker } = await setup();
  await session.harnessReady();
  const pending = session.scanCoherenceAsync({ approvedLargeScope: false, withheld: new Set(['n_SCENE00001']) });
  worker.resolve(await outcomeFor(worker));
  const result = await pending;
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe('stale');
  expect(session.state.coherence?.runs).toHaveLength(0);
});

it('an agent scan leaves a read-denied document out of the projection', async () => {
  const state = buildState({ scenes: [{ id: 'n_SCENE00001', title: 'Open', body: 'The ferry arrived.' }, { id: 'n_SCENE00002', title: 'Hidden', body: 'A secret.' }] });
  const { session, worker } = await setup(state);
  await session.harnessReady();
  const pending = session.scanCoherenceAsync({ approvedLargeScope: false, withheld: new Set(['n_SCENE00002']) });
  await worker.started;
  const sent = worker.input();
  expect(sent.state.documents.has('n_SCENE00001')).toBe(true);
  expect(sent.state.documents.has('n_SCENE00002')).toBe(false);
  expect(sent.state.manifest.tree.some((node) => node.id === 'n_SCENE00002')).toBe(false);
  session.cancelScan();
  await pending;
});
