import { expect, it } from 'vitest';
import { createUndoStore } from '@caotang/bus';
import { collectRetention, createRun, MemoryIndexedDb, openRuntimeStore, UndoRetentionLedger, writeRunBaseline } from '@caotang/store';
import { hostRetentionRoots } from '../src/app/picture-retention-host.js';

it('retains a picture named only as an id inside a baseline manifest, and fails closed on a damaged manifest', async () => {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  try {
    await createRun(store, { schema: 3, runId: 'run_retained', projectId: 'p_project', kind: 'turn', intent: 'Change the cover', createdAt: 1, updatedAt: 1, status: 'running' });
    await writeRunBaseline(store, 'p_project', 'run_retained', { version: 1, capturedAt: 1, textFiles: { 'caotang.json': JSON.stringify({ project: { coverAssetId: 'a_0123456789' } }) }, binaryFiles: {}, revisions: {} });
    const roots = hostRetentionRoots({ store, projectId: 'p_project', undo: () => createUndoStore(), ledger: new UndoRetentionLedger(), storage: undefined, appDb: () => null });
    const result = await collectRetention(roots);
    expect(result.authoritative).toBe(true);
    expect(result.ids.has('a_0123456789')).toBe(true);
    await createRun(store, { schema: 3, runId: 'run_bad', projectId: 'p_project', kind: 'turn', intent: 'Keep an unreadable point', createdAt: 1, updatedAt: 1, status: 'running' });
    await writeRunBaseline(store, 'p_project', 'run_bad', { version: 1, capturedAt: 1, textFiles: { 'caotang.json': '{broken' }, binaryFiles: {}, revisions: {} });
    expect((await collectRetention(roots)).authoritative).toBe(false);
  } finally { store.close(); }
});
