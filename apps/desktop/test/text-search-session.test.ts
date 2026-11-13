import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryIndexedDb, openRuntimeStore } from '@caotang/store';
import { ProjectSession } from '../src/app/session.js';
import { project } from '../../../e2e/unit/fixtures.js';

class PendingWorker {
  static instances: PendingWorker[] = [];
  readonly terminate = vi.fn();
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  postMessage = vi.fn();
  constructor() { PendingWorker.instances.push(this); }
}

beforeEach(() => {
  PendingWorker.instances = [];
  vi.stubGlobal('Worker', PendingWorker);
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('closes an active search worker and settles its pending call with the project', async () => {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const state = project();
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  try {
    const harness = await session.harnessReady();
    const result = harness.callAsync({ callId: 'search', name: 'text.search', params: { query: 'ferry' } }, { turnId: 'search' });
    expect(PendingWorker.instances).toHaveLength(1);
    await session.close();
    expect((await result).ok).toBe(false);
    expect(PendingWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  } finally { await session.close(); store.close(); }
});

it('disposes a harness that arrives after the project already closed', async () => {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  const state = project();
  const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null });
  try {
    await session.close();
    const harness = await session.harnessReady();
    const result = await harness.callAsync({ callId: 'late-search', name: 'text.search', params: { query: 'ferry' } }, { turnId: 'search' });
    expect(result).toMatchObject({ ok: false, error: { code: 'io-error' } });
    expect(PendingWorker.instances).toHaveLength(0);
  } finally { await session.close(); store.close(); }
});
