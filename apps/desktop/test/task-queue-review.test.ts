import { describe, expect, it, vi } from 'vitest';

import { addDocument, createEmptyManifest, createProjectState, type ProjectState } from '@caotang/store';
import { computeReview, emptyCoherenceFile, planReview, publishReview, type CoherenceFile, type CoherenceModel, type ModelReply, type ModelRequest } from '@caotang/coherence';
import type { PlanStep } from '@caotang/harness';
import type { AppDb } from '../src/app/app-db.js';
import { TaskQueue, type TaskReviewFactory } from '../src/app/task-queue.js';
import { TaskStore, type TaskRecord } from '../src/app/task-store.js';
import type { QueuedReviewApproval } from '../src/app/queued-review.js';

const PROJECT = 'p_QREVIEW001';
const NOW = new Date('2026-10-01T09:00:00.000Z');

function twoDocs(): ProjectState {
  const manifest = createEmptyManifest('Fixture', NOW);
  const state = createProjectState(manifest, { now: NOW });
  addDocument(state, { id: 'sA', parentId: 'manuscript', title: 'First', body: 'Elena is thirty-four.', now: NOW });
  addDocument(state, { id: 'sB', parentId: 'manuscript', title: 'Second', body: 'Elena is forty-one.', now: NOW });
  return state;
}

function bodyOf(user: string): string {
  const start = user.indexOf('--- BEGIN DOCUMENT ---\n') + '--- BEGIN DOCUMENT ---\n'.length;
  return user.slice(start, user.indexOf('\n--- END DOCUMENT ---'));
}

function docIdOf(user: string): string {
  return /docId: ([A-Za-z0-9]+)\)/.exec(user)?.[1] ?? '';
}

function extraction(body: string, docId: string): string {
  const quote = body.includes('thirty-four') ? 'Elena is thirty-four.' : 'Elena is forty-one.';
  const from = body.indexOf(quote);
  return JSON.stringify({ spans: [{ docId, from, to: from + quote.length, quote, category: 'characterization', note: '' }] });
}

function fakeModel(respond: (request: ModelRequest, index: number) => string | Error | ModelReply | Promise<string | Error | ModelReply>): CoherenceModel & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    model: 'fake-1',
    calls,
    async complete(request) {
      calls.push(request);
      const reply = await respond(request, calls.length - 1);
      if (reply instanceof Error) throw reply;
      if (typeof reply === 'string') return { content: reply, usage: { promptTokens: 100, completionTokens: 20 } };
      return reply;
    },
  };
}

function reviewing(): CoherenceModel & { calls: ModelRequest[] } {
  return fakeModel((request) => {
    if (request.system.includes('continuity extractor')) return extraction(bodyOf(request.user), docIdOf(request.user));
    const pairIds = [...request.user.matchAll(/\[pair (p\d+)\]/g)].map((m) => m[1]);
    return JSON.stringify({ verdicts: pairIds.map((pairId) => ({ pairId, verdict: 'contradictory', reasoning: 'age differs', factGroup: { entity: 'Elena', attribute: 'age' } })) });
  });
}

function approvalFor(state: ProjectState): QueuedReviewApproval {
  const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
  return {
    plan,
    route: { profileId: 'p_MOCK000001', model: 'fake-1', label: 'Mock, fake-1' },
    callBound: { extractCalls: plan.estimate.extractCalls, verifyCallsAtMost: plan.estimate.verifyCallsAtMost },
    scopeDocIds: plan.scopeDocIds,
    categories: plan.categories,
    maxFindings: plan.maxFindings,
    fingerprint: 'fp-1',
  };
}

const reviewStep: PlanStep = { tool: 'coherence.review', params: { scope: { mode: 'full' } }, expect: 'A coherence review' };
const draftStep: PlanStep = { tool: 'scene.draft', params: { doc: 'First', instruction: 'Open.', mode: 'draft' }, expect: 'A draft' };

function reviewRunnerFor(state: ProjectState, model: CoherenceModel, held: { file: CoherenceFile }): TaskReviewFactory {
  return (_task) => async (current, host) => {
    const approval = current.review;
    if (approval === undefined) return { status: 'failed', error: 'no approval' };
    const computed = await computeReview(state, held.file, approval.plan, {
      model,
      approved: true,
      signal: host.signal,
      ...(current.reviewCheckpoint === undefined ? {} : { resumeFrom: current.reviewCheckpoint }),
      beforeCall: () => host.reserve(),
      onCheckpoint: (checkpoint) => host.checkpoint(checkpoint),
    });
    if (host.signal.aborted) return { status: 'cancelled' };
    const result = publishReview(held.file, computed, { now: NOW, ...(current.reviewRunId === undefined ? {} : { runId: current.reviewRunId }) });
    if (host.signal.aborted) return { status: 'cancelled' };
    held.file = result.file;
    return {
      status: result.status,
      report: { runId: result.run.id, outcome: result.status, findingsCount: result.run.findingsUpserted.length, scopeTitles: approval.plan.documents.map((d) => d.title), routeLabel: approval.route.label, usage: { modelCalls: 0, promptTokens: computed.promptTokens, completionTokens: computed.completionTokens, source: 'estimated' } },
    };
  };
}

function setup(state: ProjectState, model: CoherenceModel, held: { file: CoherenceFile }) {
  const rows = new Map<string, unknown>();
  const db: AppDb = {
    async get<T>(key: string) { return structuredClone(rows.get(key)) as T | undefined; },
    async put(key, value) { rows.set(key, structuredClone(value)); },
    async list<T>(prefix: string) { return [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T })); },
    async delete(key) { rows.delete(key); },
    close() {},
  };
  const store = new TaskStore(db);
  const makeQueue = (m: CoherenceModel): TaskQueue => new TaskQueue({
    projectId: PROJECT,
    store,
    agentFor: () => ({ stageOnly: async () => ({ proposals: [{ text: 'draft' }], revisions: [{}], refusals: [], stopped: false, modelCalls: 1, tokens: { promptTokens: 10, completionTokens: 5, requests: 1 } }) }),
    reviewFor: reviewRunnerFor(state, m, held),
    foregroundBusy: () => false,
    locksAvailable: () => true,
    newId: () => 'task_TEST000001',
  });
  return { queue: makeQueue(model), store, rows, reopen: makeQueue };
}

describe('a queued coherence review', () => {
  it('runs a pure review to completed and publishes its findings into the held file', async () => {
    const state = twoDocs();
    const model = reviewing();
    const held = { file: emptyCoherenceFile() };
    const { queue } = setup(state, model, held);
    await queue.open();
    const approval = approvalFor(state);
    const queued = await queue.enqueue('Review.', [reviewStep], undefined, approval);
    expect(queued.ok).toBe(true);
    await queue.idle();
    const task = queue.snapshot()[0];
    expect(task?.status).toBe('completed');
    expect(task?.kind).toBe('review');
    expect(task?.report?.outcome).toBe('complete');
    expect(task?.report?.findingsCount).toBe(1);
    expect(held.file.findings).toHaveLength(1);
    expect(held.file.runs).toHaveLength(1);
    expect(model.calls).toHaveLength(3);
    expect(task?.used).toBe(3);
    expect(task?.cap).toBe(approval.callBound.extractCalls + approval.callBound.verifyCallsAtMost);
  });

  it('keeps a mixed task ready for its drafts, with the report published and the review filtered from the draft review', async () => {
    const state = twoDocs();
    const held = { file: emptyCoherenceFile() };
    const { queue } = setup(state, reviewing(), held);
    await queue.open();
    const queued = await queue.enqueue('Mixed.', [reviewStep, draftStep], undefined, approvalFor(state));
    expect(queued.ok).toBe(true);
    await queue.idle();
    const task = queue.snapshot()[0];
    expect(task?.status).toBe('ready');
    expect(task?.kind).toBe('mixed');
    expect(task?.report?.findingsCount).toBe(1);
    const review = queue.review(task?.id ?? '');
    expect(review?.review.steps.map((step) => step.tool)).toEqual(['scene.draft']);
  });

  it('refuses multiple review steps, and a review with no approval', async () => {
    const state = twoDocs();
    const { queue } = setup(state, reviewing(), { file: emptyCoherenceFile() });
    await queue.open();
    const two = await queue.enqueue('Two.', [reviewStep, reviewStep], undefined, approvalFor(state));
    expect(two.ok).toBe(false);
    const noApproval = await queue.enqueue('No approval.', [reviewStep]);
    expect(noApproval.ok).toBe(false);
  });

  it('refuses the enqueue when the approval cannot be persisted, before any model call', async () => {
    const state = twoDocs();
    const model = reviewing();
    const { queue, store } = setup(state, model, { file: emptyCoherenceFile() });
    await queue.open();
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('storage full'));
    const queued = await queue.enqueue('Review.', [reviewStep], undefined, approvalFor(state));
    expect(queued.ok).toBe(false);
    await queue.idle();
    expect(model.calls).toHaveLength(0);
    expect(queue.snapshot()).toHaveLength(0);
  });

  it('never exceeds the approved call bound', async () => {
    const state = twoDocs();
    const model = reviewing();
    const { queue } = setup(state, model, { file: emptyCoherenceFile() });
    await queue.open();
    const approval = { ...approvalFor(state), callBound: { extractCalls: 1, verifyCallsAtMost: 0 } };
    const queued = await queue.enqueue('Review.', [reviewStep], undefined, approval);
    expect(queued.ok).toBe(true);
    await queue.idle();
    const task = queue.snapshot()[0];
    expect(task?.used).toBeLessThanOrEqual(1);
    expect(model.calls.length).toBeLessThanOrEqual(1);
    expect(task?.report?.outcome).toBe('partial');
  });

  it('cancellation during extraction publishes nothing and retains the checkpoint', async () => {
    const state = twoDocs();
    let release = (): void => {};
    const held = { file: emptyCoherenceFile() };
    const model = fakeModel((request) => {
      if (request.system.includes('continuity extractor')) {
        const body = bodyOf(request.user);
        const docId = docIdOf(request.user);
        if (docId === 'sB') return new Promise<string>((resolve) => { release = () => resolve(extraction(body, docId)); });
        return extraction(body, docId);
      }
      return JSON.stringify({ verdicts: [] });
    });
    const { queue } = setup(state, model, held);
    await queue.open();
    await queue.enqueue('Review.', [reviewStep], undefined, approvalFor(state));
    await vi.waitFor(() => { expect(model.calls.length).toBeGreaterThanOrEqual(2); });
    await queue.cancel('task_TEST000001');
    release();
    await queue.idle();
    const task = queue.snapshot()[0];
    expect(task?.status).toBe('cancelled');
    expect(held.file.findings).toHaveLength(0);
    expect(held.file.runs).toHaveLength(0);
    expect(task?.reviewCheckpoint?.extractedDocIds).toContain('sA');
  });

  it('completes a review whose findings were published before a cancel during its save settled', async () => {
    const state = twoDocs();
    const held = { file: emptyCoherenceFile() };
    const model = reviewing();
    let releaseSave!: () => void;
    const saveHeld = new Promise<void>((resolve) => { releaseSave = resolve; });
    let saveStarted!: () => void;
    const started = new Promise<void>((resolve) => { saveStarted = resolve; });
    const rows = new Map<string, unknown>();
    const db: AppDb = {
      async get<T>(key: string) { return structuredClone(rows.get(key)) as T | undefined; },
      async put(key, value) { rows.set(key, structuredClone(value)); },
      async list<T>(prefix: string) { return [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T })); },
      async delete(key) { rows.delete(key); },
      close() {},
    };
    const queue = new TaskQueue({
      projectId: PROJECT,
      store: new TaskStore(db),
      agentFor: () => ({ stageOnly: async () => ({ proposals: [], revisions: [], refusals: [], stopped: false, modelCalls: 0, tokens: { promptTokens: 0, completionTokens: 0, requests: 0 } }) }),
      reviewFor: () => async (current, host) => {
        const approval = current.review;
        if (approval === undefined) return { status: 'failed', error: 'no approval' };
        const computed = await computeReview(state, held.file, approval.plan, { model, approved: true, signal: host.signal, beforeCall: () => host.reserve(), onCheckpoint: (checkpoint) => host.checkpoint(checkpoint) });
        const result = publishReview(held.file, computed, { now: NOW, ...(current.reviewRunId === undefined ? {} : { runId: current.reviewRunId }) });
        held.file = result.file;
        saveStarted();
        await saveHeld;
        return { status: result.status, report: { runId: result.run.id, outcome: result.status, findingsCount: result.run.findingsUpserted.length, scopeTitles: approval.plan.documents.map((d) => d.title), routeLabel: approval.route.label, usage: { modelCalls: 0, promptTokens: computed.promptTokens, completionTokens: computed.completionTokens, source: 'estimated' } } };
      },
      foregroundBusy: () => false,
      locksAvailable: () => true,
      newId: () => 'task_TEST000001',
    });
    await queue.open();
    const queued = await queue.enqueue('Review.', [reviewStep], undefined, approvalFor(state));
    expect(queued.ok).toBe(true);
    await started;
    await queue.cancel('task_TEST000001');
    releaseSave();
    await queue.idle();
    const task = queue.snapshot()[0];
    expect(task?.status).toBe('completed');
    expect(task?.report?.outcome).toBe('complete');
    expect(task?.report?.findingsCount).toBe(1);
    expect(held.file.findings).toHaveLength(1);
    expect(held.file.runs).toHaveLength(1);
  });

  it('resume repeats no acknowledged stage and stays inside the remaining bound', async () => {
    const state = twoDocs();
    const held = { file: emptyCoherenceFile() };
    const model = reviewing();
    const { queue, rows, reopen } = setup(state, model, held);
    await queue.open();
    await queue.enqueue('Review.', [reviewStep], undefined, approvalFor(state));
    await queue.idle();
    const key = `task:${PROJECT}:task_TEST000001`;
    const stored = rows.get(key) as TaskRecord;
    rows.set(key, { ...stored, status: 'interrupted', items: stored.items.map((item) => ({ ...item, state: 'pending' })), reviewCheckpoint: { ...stored.reviewCheckpoint, extractedDocIds: ['sA'], spans: stored.reviewCheckpoint?.spans.slice(0, 1) ?? [], verifiedBatches: 0, verdicts: [], evaluated: ['sA'] }, used: 1, report: undefined });
    const resumedModel = reviewing();
    const queue2 = reopen(resumedModel);
    await queue2.open();
    await queue2.resume('task_TEST000001');
    await queue2.idle();
    const task = queue2.snapshot()[0];
    expect(task?.status).toBe('completed');
    expect(resumedModel.calls).toHaveLength(2);
    expect(resumedModel.calls[0]?.user).toContain('docId: sB');
    expect(held.file.runs).toHaveLength(1);
  });

  it('a mixed plan keeps its drafting tokens beside the review checkpoint totals', async () => {
    const state = twoDocs();
    const model = reviewing();
    const held = { file: emptyCoherenceFile() };
    const { queue, rows } = setup(state, model, held);
    await queue.open();
    const queued = await queue.enqueue('Draft and review.', [draftStep, reviewStep], undefined, approvalFor(state));
    expect(queued.ok).toBe(true);
    await queue.idle();
    const task = queue.snapshot()[0];
    expect(task?.status).toBe('ready');
    expect(task?.promptTokens).toBe(310);
    expect(task?.completionTokens).toBe(65);
    const stored = rows.get(`task:${PROJECT}:task_TEST000001`) as TaskRecord;
    expect(stored.promptTokens).toBe(310);
    expect(stored.completionTokens).toBe(65);
    expect(stored.reviewCheckpoint?.promptTokens).toBe(300);
    expect(stored.reviewCheckpoint?.completionTokens).toBe(60);
  });

  it('a mixed plan resume keeps the drafting baseline once', async () => {
    const state = twoDocs();
    const held = { file: emptyCoherenceFile() };
    const { queue, rows, reopen } = setup(state, reviewing(), held);
    await queue.open();
    await queue.enqueue('Draft and review.', [draftStep, reviewStep], undefined, approvalFor(state));
    await queue.idle();
    const key = `task:${PROJECT}:task_TEST000001`;
    const stored = rows.get(key) as TaskRecord;
    const cp = stored.reviewCheckpoint!;
    const firstDoc = cp.extractedDocIds[0]!;
    rows.set(key, {
      ...stored,
      status: 'interrupted',
      items: stored.items.map((item) => (item.step === 1 ? { ...item, state: 'pending' as const } : item)),
      used: 2,
      report: undefined,
      promptTokens: 110,
      completionTokens: 25,
      reviewCheckpoint: { ...cp, extractedDocIds: [firstDoc], spans: cp.spans.filter((span) => span.docId === firstDoc), verifiedBatches: 0, verdicts: [], usageByPair: {}, evaluated: [firstDoc], promptTokens: 100, completionTokens: 20 },
    });
    const queue2 = reopen(reviewing());
    await queue2.open();
    await queue2.resume('task_TEST000001');
    await queue2.idle();
    const task = queue2.snapshot()[0];
    expect(task?.status).toBe('ready');
    expect(task?.promptTokens).toBe(310);
    expect(task?.completionTokens).toBe(65);
    expect(task?.used).toBe(4);
  });

  it('a failed provider call yields an explicit partial report, not a completion', async () => {
    const state = twoDocs();
    const model = fakeModel((request) => {
      if (request.system.includes('continuity extractor')) return extraction(bodyOf(request.user), docIdOf(request.user));
      return new Error('provider down');
    });
    const held = { file: emptyCoherenceFile() };
    const { queue } = setup(state, model, held);
    await queue.open();
    await queue.enqueue('Review.', [reviewStep], undefined, approvalFor(state));
    await queue.idle();
    const task = queue.snapshot()[0];
    expect(task?.status).toBe('completed');
    expect(task?.report?.outcome).toBe('partial');
    expect(held.file.runs[0]?.status).toBe('partial');
  });
});
