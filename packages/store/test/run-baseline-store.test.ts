import { afterEach, expect, it } from 'vitest';
import { createRun, deleteRun, MemoryIndexedDb, openRuntimeStore, pruneRuns, readRunBaseline, readRunBaselines, updateRun, writeRunBaseline, type RunBaseline, type RuntimeStore } from '../src/index.js';

const stores: RuntimeStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const point = (text: string): RunBaseline => ({ version: 1, capturedAt: 100, textFiles: { 'caotang.json': text }, binaryFiles: {}, revisions: {} });

async function fixture() {
  const store = await openRuntimeStore(new MemoryIndexedDb());
  stores.push(store);
  await createRun(store, { schema: 3, runId: 'run_1', projectId: 'p_1', kind: 'turn', intent: 'Write', createdAt: 1, updatedAt: 1, status: 'running' });
  return store;
}

it('retains the first point atomically, keeps it through run updates, and checks project ownership', async () => {
  const store = await fixture();
  const first = point('first');
  expect(await writeRunBaseline(store, 'p_1', 'run_1', first)).toBe(true);
  expect(await writeRunBaseline(store, 'p_1', 'run_1', point('second'))).toBe(false);
  await updateRun(store, 'run_1', { status: 'finished', outcome: 'applied' });
  expect(await readRunBaseline(store, 'p_1', 'run_1')).toEqual(first);
  await expect(readRunBaseline(store, 'p_other', 'run_1')).rejects.toThrow();
  await expect(writeRunBaseline(store, 'p_other', 'run_1', first)).rejects.toThrow();
  expect(await readRunBaselines(store, 'p_other')).toEqual([]);
});

it('refuses malformed or late points without replacing the row', async () => {
  const store = await fixture();
  await expect(writeRunBaseline(store, 'p_1', 'run_1', { ...point('bad'), revisions: { scene: -1 } })).rejects.toThrow('damaged');
  expect(await readRunBaseline(store, 'p_1', 'run_1')).toBeUndefined();
  await updateRun(store, 'run_1', { status: 'finished' });
  await expect(writeRunBaseline(store, 'p_1', 'run_1', point('late'))).rejects.toThrow('writing step');
});

it('releases points with their run on discard or retention pruning', async () => {
  const store = await fixture();
  await writeRunBaseline(store, 'p_1', 'run_1', point('before'));
  await updateRun(store, 'run_1', { status: 'interrupted' });
  expect(await pruneRuns(store, 'p_1', 100_000, { days: 0, count: 0 })).toBe(0);
  expect(await readRunBaselines(store, 'p_1')).toHaveLength(1);
  await updateRun(store, 'run_1', { status: 'finished' });
  expect(await pruneRuns(store, 'p_1', 100_000, { days: 0, count: 0 })).toBe(1);
  expect(await readRunBaselines(store, 'p_1')).toEqual([]);
  await createRun(store, { schema: 3, runId: 'run_2', projectId: 'p_1', kind: 'turn', intent: 'Write', createdAt: 1, updatedAt: 1, status: 'running' });
  await writeRunBaseline(store, 'p_1', 'run_2', point('before again'));
  await deleteRun(store, 'run_2');
  expect(await readRunBaselines(store, 'p_1')).toEqual([]);
});
