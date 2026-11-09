import { describe, expect, it, vi } from 'vitest';
import { i18n } from '@lingui/core';

import type { PlanStep, StageOnlyResult } from '@caotang/harness';
import type { AppDb } from '../src/app/app-db.js';
import { TaskQueue, type TaskAgentFactory } from '../src/app/task-queue.js';
import { TaskStore, asTaskRecord, type TaskRecord } from '../src/app/task-store.js';
import { viewOf } from '../src/app/task-model.js';
import type { ProjectState } from '@caotang/store';
import { messages as german } from '../src/i18n/locales/de/messages.po';

const PROJECT = 'p_TASKPROJ01';
const step: PlanStep = { tool: 'scene.draft', params: { doc: 'Scene', instruction: 'Open.', mode: 'draft' }, expect: 'A draft' };

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(agentFor: TaskAgentFactory = () => 'No provider.') {
  const rows = new Map<string, unknown>();
  const db: AppDb = {
    async get<T>(key: string) { return structuredClone(rows.get(key)) as T | undefined; },
    async put(key, value) { rows.set(key, structuredClone(value)); },
    async list<T>(prefix: string) {
      return [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T }));
    },
    async delete(key) { rows.delete(key); },
    close() {},
  };
  const store = new TaskStore(db);
  const saved: TaskRecord[] = [];
  const save = store.save.bind(store);
  const entered = deferred();
  const release = deferred();
  let held = false;
  vi.spyOn(store, 'save').mockImplementation(async (task) => {
    saved.push(structuredClone(task));
    if (task.status === 'running' && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    await save(task);
  });
  const queue = new TaskQueue({ projectId: PROJECT, store, agentFor, foregroundBusy: () => false, locksAvailable: () => true, newId: () => 'task_TEST000001' });
  return { queue, store, saved, entered, release };
}

describe('the background task status machine', () => {
  it('honors cancel while the running record is still being saved, before constructing an agent', async () => {
    const agentFor = vi.fn(() => 'No provider.');
    const h = setup(agentFor);
    await h.queue.open();
    await h.queue.enqueue('Draft.', [step]);
    await h.entered.promise;
    expect(h.queue.snapshot()[0]).toMatchObject({ status: 'running', phase: 'starting' });
    await h.queue.cancel('task_TEST000001');
    expect(h.queue.snapshot()[0]?.phase).toBe('cancelling');
    const task = h.queue.snapshot()[0];
    if (task === undefined) throw new Error('The queued task is missing.');
    expect(viewOf(task, {} as ProjectState)).toMatchObject({ status: 'cancelling', statusText: 'Cancelling…', canCancel: false, canResume: false, canDismiss: false });
    i18n.load('de', german);
    i18n.activate('de');
    try {
      expect(viewOf(task, {} as ProjectState).statusText).toBe('Wird abgebrochen…');
    } finally {
      i18n.activate('en');
    }
    expect(h.queue.working()).toBe(true);
    h.release.resolve();
    await h.queue.idle();
    expect(agentFor).not.toHaveBeenCalled();
    expect(h.queue.snapshot()[0]).toMatchObject({ status: 'cancelled', phase: 'cancelled' });
    expect(h.saved.every((task) => asTaskRecord(task, PROJECT) !== undefined && !('phase' in task))).toBe(true);
    for (const status of ['starting', 'cancelling']) expect(asTaskRecord({ ...h.saved.at(-1), status }, PROJECT)).toBeUndefined();
  });

  for (const order of ['cancel then close', 'close then cancel'] as const) {
    it(`keeps cancellation final for ${order} while startup is pending`, async () => {
      const h = setup();
      await h.queue.open();
      await h.queue.enqueue('Draft.', [step]);
      await h.entered.promise;
      let closing: Promise<void>;
      if (order === 'cancel then close') {
        await h.queue.cancel('task_TEST000001');
        closing = h.queue.close();
      } else {
        closing = h.queue.close();
        await h.queue.cancel('task_TEST000001');
      }
      expect(h.queue.snapshot()[0]?.phase).toBe('cancelling');
      h.release.resolve();
      await closing;
      expect(h.queue.snapshot()[0]?.status).toBe('cancelled');
      await h.queue.open();
      expect(h.queue.snapshot()[0]?.status).toBe('cancelled');
    });
  }

  it('honors cancellation while its agent is downloading and does not stage after it arrives', async () => {
    const entered = deferred();
    const release = deferred();
    const stageOnly = vi.fn<() => Promise<StageOnlyResult>>();
    const h = setup(async () => {
      entered.resolve();
      await release.promise;
      return { stageOnly };
    });
    await h.queue.open();
    await h.queue.enqueue('Draft.', [step]);
    h.release.resolve();
    await entered.promise;
    await h.queue.cancel('task_TEST000001');
    const closing = h.queue.close();
    release.resolve();
    await closing;
    expect(stageOnly).not.toHaveBeenCalled();
    expect(h.queue.snapshot()[0]?.status).toBe('cancelled');
  });

  it('does not dismiss a cancellation before the run has settled', async () => {
    const h = setup();
    await h.queue.open();
    await h.queue.enqueue('Draft.', [step]);
    await h.entered.promise;
    await h.queue.cancel('task_TEST000001');
    await h.queue.dismiss('task_TEST000001');
    expect(h.queue.snapshot()).toHaveLength(1);
    h.release.resolve();
    await h.queue.idle();
    await h.queue.dismiss('task_TEST000001');
    expect(h.queue.snapshot()).toHaveLength(0);
  });

  it('never stages an item when an interrupted task has no calls left', async () => {
    const stageOnly = vi.fn<() => Promise<StageOnlyResult>>();
    const h = setup(() => ({ stageOnly }));
    await h.queue.open();
    await h.queue.enqueue('Draft.', [step]);
    await h.entered.promise;
    const closing = h.queue.close();
    h.release.resolve();
    await closing;
    const task = h.saved.at(-1) as TaskRecord;
    await h.store.save({ ...task, used: task.cap, status: 'interrupted' });
    await h.queue.open();
    await h.queue.resume(task.id);
    await h.queue.idle();
    expect(stageOnly).not.toHaveBeenCalled();
    expect(h.queue.snapshot()[0]?.status).toBe('failed');
    expect(h.queue.snapshot()[0]?.items[0]?.error).toContain('would go past');
  });

  it('keeps previously staged drafts reviewable when a resumed task cannot start its agent', async () => {
    const h = setup(() => 'No provider.');
    await h.queue.open();
    await h.queue.enqueue('Draft twice.', [step, step]);
    await h.entered.promise;
    const closing = h.queue.close();
    h.release.resolve();
    await closing;
    const task = h.saved.at(-1) as TaskRecord;
    await h.store.save({
      ...task,
      used: 1,
      items: task.items.map((item, index) => index === 0
        ? { ...item, state: 'staged', proposal: { text: 'A draft.', words: 2, revision: 1 }, revisions: {} }
        : item),
    });
    await h.queue.open();
    await h.queue.resume(task.id);
    await h.queue.idle();
    expect(h.queue.snapshot()[0]).toMatchObject({ status: 'ready', phase: 'ready', items: [{ state: 'staged' }, { state: 'failed', error: 'No provider.' }] });
    expect(h.queue.working()).toBe(false);
    expect(h.queue.review(task.id)).toBeDefined();
    expect((await h.store.list(PROJECT))[0]?.status).toBe('ready');
  });
});
