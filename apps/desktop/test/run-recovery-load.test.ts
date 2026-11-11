import { afterEach, expect, it, vi } from 'vitest';
import { createRun, MemoryIndexedDb, openRuntimeStore, readRunBaseline } from '@caotang/store';
import { sampleProjectState } from '../src/app/demo.js';
import { ProjectSession } from '../src/app/session.js';
import type * as RecoveryModule from '../src/app/run-recovery.js';

const construct = vi.hoisted(() => vi.fn());
vi.mock('../src/app/run-recovery.js', async (importOriginal) => {
  const { RunRecovery } = await importOriginal<typeof RecoveryModule>();
  return { RunRecovery: class extends RunRecovery {
    constructor(...args: ConstructorParameters<typeof RunRecovery>) {
      construct();
      super(...args);
    }
  } };
});

afterEach(() => {
  vi.unstubAllGlobals();
  construct.mockReset();
});

it('shares a failed recovery load and lets a later action construct and use recovery again', async () => {
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
  const state = sampleProjectState();
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const session = new ProjectSession({ store, state, projectId: state.manifest.project.id, shadow: null });
  try {
    const runId = 'run_retry';
    await createRun(store, { schema: 3, runId, projectId: session.projectId, kind: 'turn', intent: 'Keep a restore point.', createdAt: 1, updatedAt: 1, status: 'running' });
    construct.mockImplementationOnce(() => { throw new Error('Recovery loading failed.'); });
    const failed = await Promise.allSettled([session.captureRunBaseline(runId), session.prepareRunRestore(runId)]);
    expect(failed.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(construct).toHaveBeenCalledOnce();
    await session.captureRunBaseline(runId);
    expect(construct).toHaveBeenCalledTimes(2);
    expect(await readRunBaseline(store, session.projectId, runId)).toBeDefined();
    expect(await session.prepareRunRestore(runId)).not.toBe('');
  } finally {
    await session.close();
    store.close();
  }
});
