import { describe, expect, it } from 'vitest';

import { MemoryIndexedDb } from '../src/runtime/memory-idb.js';
import { openRuntimeStore, readProjectState } from '../src/runtime/store.js';
import { readAgentSessions } from '../src/runtime/agent-sessions.js';
import { readRun } from '../src/runtime/run-log-store.js';
import { createEmptyManifest, deleteProject } from '../src/index.js';
import {
  appendGoalCheckpoint, checkpointReadable, createGoalRun, markGoalsInterrupted, openGoalRecovery, pruneGoalRuns,
  readGoalRun, readGoalRuns, readOpenGoalRuns, recordGoalIteration, resumeGoalRun, settleGoalRun,
} from '../src/runtime/goal-run-store.js';

const PROJECT = 'p_9XK2M4Q7RZ';

describe('durable goal storage', () => {
  it('adds the goal store without rewriting the project, turn or conversation kept by version 5', async () => {
    const factory = new MemoryIndexedDb();
    const manifest = createEmptyManifest('Ferry Notebook', new Date(0));
    const turn = { schema: 1, runId: 'turn-one', projectId: PROJECT, kind: 'turn', intent: 'Keep this turn.', createdAt: 1, updatedAt: 1, status: 'finished' };
    const session = { projectId: PROJECT, sessionId: 'conversation-one', formatVersion: 1, title: 'Kept conversation', createdAt: 1, updatedAt: 1, active: true, turns: [{ runId: 'turn-one', role: 'chat' }] };
    await new Promise<void>((resolve, reject) => {
      const request = factory.open('goal-upgrade', 5);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('projects', { keyPath: 'id' });
        db.createObjectStore('documents', { keyPath: ['projectId', 'id'] }).createIndex('byProject', 'projectId');
        db.createObjectStore('sessions', { keyPath: ['projectId', 'index'] }).createIndex('byProject', 'projectId');
        db.createObjectStore('snapshots', { keyPath: ['projectId', 'docId', 'revision'] }).createIndex('byProject', 'projectId');
        db.createObjectStore('runs', { keyPath: 'runId' }).createIndex('byProject', 'projectId');
        db.createObjectStore('runEvents', { keyPath: ['runId', 'seq'] }).createIndex('byRun', 'runId');
        db.createObjectStore('agentSessions', { keyPath: ['projectId', 'sessionId'] }).createIndex('byProject', 'projectId');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(['projects', 'runs', 'agentSessions'], 'readwrite');
        tx.objectStore('projects').put({ id: PROJECT, manifest, storedAt: new Date(0).toISOString() });
        tx.objectStore('runs').put(turn);
        tx.objectStore('agentSessions').put(session);
        tx.onabort = () => reject(tx.error);
        tx.oncomplete = () => { db.close(); resolve(); };
      };
    });

    const store = await openRuntimeStore(factory, 'goal-upgrade');
    try {
      expect(store.db.version).toBe(6);
      expect(store.db.objectStoreNames.contains('goalRuns')).toBe(true);
      // The derived word-count cache is rebuilt on read (§2); every structural fact is preserved as written.
      const kept = (await readProjectState(store, PROJECT)).manifest;
      expect(kept.project).toEqual(manifest.project);
      expect(kept.tree).toEqual(manifest.tree);
      expect(kept.formatVersion).toBe(manifest.formatVersion);
      expect(await readRun(store, turn.runId)).toEqual(turn);
      expect(await readAgentSessions(store, PROJECT)).toEqual([session]);
    } finally {
      store.close();
    }
  });
});

const GOAL = 'g_7QK4M2N8RT';
const OTHER_GOAL = 'g_5HJ2P9WXZC';
const CONVERSATION = 'conversation-one';

const checkpoint = (nextIteration = 1) => ({
  goal: { id: GOAL, intent: 'Fill every synopsis.', checks: [{ kind: 'synopsis.filled', scope: { mode: 'full' } }], limits: { maxModelCalls: 20 } },
  iterations: [],
  results: [],
  nextIteration,
  spend: { modelCalls: 0, promptTokens: 0, completionTokens: 0, estimatedTokens: 0, steps: 0, activeMs: 0 },
});

describe('checkpoint budget validation', () => {
  it.each(['maxModelCalls', 'maxTokens', 'maxCostUsd', 'maxSteps', 'maxActiveMs', 'deadline'])('rejects invalid %s limits', (field) => {
    const saved = checkpoint();
    for (const value of [NaN, Infinity, -Infinity, -1, '1', null]) {
      expect(checkpointReadable({ ...saved, goal: { ...saved.goal, limits: { ...saved.goal.limits, [field]: value } } }), `${field}=${String(value)}`).toBe(false);
    }
  });

  it.each(['modelCalls', 'promptTokens', 'completionTokens', 'estimatedTokens', 'steps', 'activeMs', 'costUsd'])('rejects invalid restored %s spend', (field) => {
    const saved = checkpoint();
    for (const value of [NaN, Infinity, -Infinity, -1, '1', null]) {
      expect(checkpointReadable({ ...saved, spend: { ...saved.spend, [field]: value } }), `${field}=${String(value)}`).toBe(false);
    }
  });

  it('requires safe integral call and step counts in limits and spend', () => {
    const saved = checkpoint();
    for (const value of [0.5, Number.MAX_SAFE_INTEGER + 1]) {
      for (const field of ['maxModelCalls', 'maxSteps']) expect(checkpointReadable({ ...saved, goal: { ...saved.goal, limits: { [field]: value } } })).toBe(false);
      for (const field of ['modelCalls', 'steps']) expect(checkpointReadable({ ...saved, spend: { ...saved.spend, [field]: value } })).toBe(false);
    }
  });

  it('accepts finite fractional prices, token reports and time, with zero integral counters', () => {
    const saved = checkpoint();
    expect(checkpointReadable({ ...saved,
      goal: { ...saved.goal, limits: { maxModelCalls: 0, maxSteps: 0, maxTokens: 0.5, maxCostUsd: 0.01, maxActiveMs: 0.5, deadline: 1 } },
      spend: { ...saved.spend, promptTokens: 0.5, completionTokens: 1.25, estimatedTokens: 0.75, activeMs: 0.5, costUsd: 0.002 },
    })).toBe(true);
  });

  it('requires a known limit rather than accepting an empty or unknown budget', () => {
    const saved = checkpoint();
    for (const limits of [{}, { maxCostUsd: undefined }, { unknownLimit: 1 }]) expect(checkpointReadable({ ...saved, goal: { ...saved.goal, limits } })).toBe(false);
  });

  it('rejects non-finite or fractional saved loop counters', () => {
    const saved = checkpoint();
    for (const value of [NaN, Infinity, -1]) expect(checkpointReadable({ ...saved, progress: { best: value, sinceBest: 0, passed: [] } })).toBe(false);
    for (const value of [NaN, Infinity, -1, 0.5]) expect(checkpointReadable({ ...saved, progress: { best: 1, sinceBest: value, passed: [] } })).toBe(false);
  });

  it('offers a persisted NaN cost checkpoint only as unreadable and refuses to append it', async () => {
    const store = await openRuntimeStore(new MemoryIndexedDb(), 'goal-bad-budget');
    const saved = checkpoint();
    const invalid = { ...saved, spend: { ...saved.spend, costUsd: NaN } };
    try {
      await createGoalRun(store, { goalId: GOAL, projectId: PROJECT, sessionId: CONVERSATION, checkpoint: invalid, at: 100 });
      await markGoalsInterrupted(store, PROJECT, 200);
      expect(await openGoalRecovery(store, GOAL)).toMatchObject({ kind: 'unreadable' });
      await expect(appendGoalCheckpoint(store, GOAL, { checkpoint: invalid, at: 300 })).rejects.toThrow('cannot be read');
      expect((await readGoalRun(store, GOAL))?.status).toBe('interrupted');
    } finally {
      store.close();
    }
  });
});

describe('a durable goal record', () => {
  it('commits a completed checkpoint with its run reference and refuses links to missing or settled goals', async () => {
    const store = await openRuntimeStore(new MemoryIndexedDb(), 'goal-completion');
    try {
      await expect(recordGoalIteration(store, GOAL, 'turn-one')).rejects.toThrow('no goal');
      await createGoalRun(store, { goalId: GOAL, projectId: PROJECT, sessionId: CONVERSATION, checkpoint: checkpoint(), at: 100 });
      const completed = { ...checkpoint(2), outcome: { status: 'passed', reason: 'Done.' } };
      await appendGoalCheckpoint(store, GOAL, { checkpoint: completed, runId: 'turn-one', at: 200 });
      expect(await readGoalRun(store, GOAL)).toMatchObject({ checkpoint: completed, iterationRunIds: ['turn-one'] });
      await appendGoalCheckpoint(store, GOAL, { checkpoint: completed, runId: 'turn-one', at: 201 });
      expect((await readGoalRun(store, GOAL))?.iterationRunIds).toEqual(['turn-one']);
      await settleGoalRun(store, GOAL, { status: 'passed', reason: 'Done.', at: 300 });
      await expect(recordGoalIteration(store, GOAL, 'turn-two')).rejects.toThrow('not running');
    } finally {
      store.close();
    }
  });

  it('survives a reopen with its checkpoint, iteration turns and owning conversation, and settles once', async () => {
    const factory = new MemoryIndexedDb();
    const store = await openRuntimeStore(factory, 'goal-record');
    try {
      await createGoalRun(store, { goalId: GOAL, projectId: PROJECT, sessionId: CONVERSATION, checkpoint: checkpoint(), at: 100 });
      await appendGoalCheckpoint(store, GOAL, { checkpoint: checkpoint(2), at: 200 });
      await recordGoalIteration(store, GOAL, 'turn-one', 210);
      await recordGoalIteration(store, GOAL, 'turn-one', 220);
    } finally {
      store.close();
    }
    const reopened = await openRuntimeStore(factory, 'goal-record');
    try {
      const held = await readGoalRun(reopened, GOAL);
      expect(held).toMatchObject({ goalId: GOAL, projectId: PROJECT, sessionId: CONVERSATION, status: 'running', iterationRunIds: ['turn-one'] });
      expect(held?.checkpoint).toEqual(checkpoint(2));
      await settleGoalRun(reopened, GOAL, { status: 'passed', reason: 'every check passes after 2 iterations', at: 300 });
      const settled = await readGoalRun(reopened, GOAL);
      expect(settled).toMatchObject({ status: 'settled' });
      expect(settled?.result).toEqual({ status: 'passed', reason: 'every check passes after 2 iterations' });
      // A settled goal is history: it is not offered for recovery, and a later checkpoint cannot revive it.
      expect(await readOpenGoalRuns(reopened, PROJECT)).toEqual([]);
      await expect(appendGoalCheckpoint(reopened, GOAL, { checkpoint: checkpoint(3), at: 400 })).rejects.toThrow('settled');
    } finally {
      reopened.close();
    }
  });

  it('marks a goal a reload abandoned as interrupted, and only an explicit resume makes it running again', async () => {
    const factory = new MemoryIndexedDb();
    const store = await openRuntimeStore(factory, 'goal-interrupted');
    try {
      await createGoalRun(store, { goalId: GOAL, projectId: PROJECT, sessionId: CONVERSATION, checkpoint: checkpoint(), at: 100 });
      await createGoalRun(store, { goalId: OTHER_GOAL, projectId: 'p_other', sessionId: CONVERSATION, checkpoint: checkpoint(), at: 100 });
      expect(await markGoalsInterrupted(store, PROJECT, 500)).toBe(1);
      const held = await readGoalRun(store, GOAL);
      expect(held).toMatchObject({ status: 'interrupted' });
      expect(held?.checkpoint).toEqual(checkpoint());
      expect((await readGoalRun(store, OTHER_GOAL))?.status).toBe('running');
      // Marking again is not a state of its own: the record stays interrupted until someone resumes it.
      expect(await markGoalsInterrupted(store, PROJECT, 600)).toBe(0);
      expect((await readGoalRun(store, GOAL))?.status).toBe('interrupted');
      await resumeGoalRun(store, GOAL, 700);
      expect((await readGoalRun(store, GOAL))?.status).toBe('running');
      // Only an interrupted goal resumes: a live one is refused rather than restarted under the writer.
      await expect(resumeGoalRun(store, GOAL, 750)).rejects.toThrow('nothing to resume');
      await settleGoalRun(store, GOAL, { status: 'passed', reason: 'done', at: 760 });
      await expect(resumeGoalRun(store, GOAL, 770)).rejects.toThrow('nothing to resume');
    } finally {
      store.close();
    }
  });

  it('refuses a stored checkpoint it cannot read instead of guessing at it', async () => {
    const factory = new MemoryIndexedDb();
    const store = await openRuntimeStore(factory, 'goal-damaged');
    try {
      await createGoalRun(store, { goalId: GOAL, projectId: PROJECT, sessionId: CONVERSATION, checkpoint: checkpoint(), at: 100 });
      const damaged = { ...(await readGoalRun(store, GOAL)), checkpoint: { goal: { id: GOAL } } };
      await new Promise<void>((resolve, reject) => {
        const tx = store.db.transaction('goalRuns', 'readwrite');
        tx.objectStore('goalRuns').put(damaged);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      await expect(openGoalRecovery(store, GOAL)).resolves.toMatchObject({ kind: 'unreadable' });
      await expect(openGoalRecovery(store, 'g_0000000000')).resolves.toEqual({ kind: 'none' });
    } finally {
      store.close();
    }
  });

  it('keeps an interrupted goal past the settled retention window and deletes it with its project', async () => {
    const factory = new MemoryIndexedDb();
    const store = await openRuntimeStore(factory, 'goal-retention');
    try {
      await createGoalRun(store, { goalId: GOAL, projectId: PROJECT, sessionId: CONVERSATION, checkpoint: checkpoint(), at: 1 });
      await createGoalRun(store, { goalId: OTHER_GOAL, projectId: PROJECT, sessionId: CONVERSATION, checkpoint: checkpoint(), at: 1 });
      await settleGoalRun(store, OTHER_GOAL, { status: 'failed', reason: 'a check cannot be met', at: 2 });
      await markGoalsInterrupted(store, PROJECT, 3);
      // The settled goal is past the window and goes; the interrupted one is the record a recovery needs, so it stays.
      expect(await pruneGoalRuns(store, PROJECT, 400 * 86_400_000, { days: 30, count: 50 })).toBe(1);
      expect((await readGoalRuns(store, PROJECT)).map((row) => row.goalId)).toEqual([GOAL]);
      expect((await readGoalRun(store, GOAL))?.checkpoint).toEqual(checkpoint());
      await deleteProject(store, PROJECT);
      expect(await readGoalRuns(store, PROJECT)).toEqual([]);
    } finally {
      store.close();
    }
  });
});
