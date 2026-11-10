import { expect, it, vi } from 'vitest';
import { MemoryIndexedDb, openRuntimeStore, writeProjectState } from '@caotang/store';
import { emptyCoherenceFile, planReview, runReview, type CoherenceFile } from '@caotang/coherence';
import { buildState, NOW } from '../../../packages/coherence/test/fixtures.js';
import { ProjectSession } from '../src/app/session.js';
import { shadowOf } from '../src/app/persistence-plan.js';

it('stops and saves a partial review before the session releases its project', async () => {
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
  try {
    const state = buildState({ scenes: [{ id: 'n_SCENE00001', title: 'Scene', body: 'The ferry arrived.' }] });
    const store = await openRuntimeStore(new MemoryIndexedDb());
    await writeProjectState(store, state);
    const saved: CoherenceFile[] = [];
    const onClosed = vi.fn(() => expect(saved.at(-1)?.runs[0]?.status).toBe('partial'));
    const session = new ProjectSession({ store, state, projectId: state.manifest.project.id, shadow: shadowOf(state), onClosed });
    const file = emptyCoherenceFile();
    session.attachCoherence({ file, writable: true, notices: [] }, { save: async (value) => { saved.push(value); }, attachFolder: async () => {} });
    const plan = planReview(state, file, { scope: { mode: 'full' }, maxFindings: 10 });
    session.coherenceReview.plan(plan);
    session.coherenceReview.start((_plan, signal) => runReview(state, file, plan, {
      approved: true, now: NOW, signal,
      model: { model: 'mock', complete: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Stopped.')), { once: true });
      }) },
    }));
    await session.close();
    expect(session.coherenceReview.snapshot().kind).toBe('cancelled');
    expect(onClosed).toHaveBeenCalledOnce();
    expect(saved.at(-1)?.runs).toHaveLength(1);
    expect(saved.at(-1)).not.toHaveProperty('completedCalls');
    expect(saved.at(-1)).not.toHaveProperty('kind');
  } finally {
    vi.unstubAllGlobals();
  }
});
