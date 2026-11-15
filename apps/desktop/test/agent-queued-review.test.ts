import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore, type ChatRequest } from '@caotang/gateway';
import { createMockProvider, type MockScript } from '@caotang/gateway/mock';
import { emptyCoherenceFile, planReview } from '@caotang/coherence';
import { MemoryIndexedDb, openRuntimeStore, type ProjectState } from '@caotang/store';

import { AgentController } from '../src/app/agent.js';
import type { AppDb } from '../src/app/app-db.js';
import { sampleProjectState } from '../src/app/demo.js';
import type { ProviderService } from '../src/app/providers.js';
import type { QueuedReviewApproval } from '../src/app/queued-review.js';
import { ProjectSession } from '../src/app/session.js';
import { TaskStore, type TaskRecord, type TaskReviewReport } from '../src/app/task-store.js';
import type { PlanOffer, PlanOfferReview, PlanStep } from '@caotang/harness';

const sessions: { session: ProjectSession; controller: AgentController }[] = [];

beforeEach(() => {
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', new EventTarget());
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { session, controller } of sessions.splice(0)) {
    controller.stop();
    controller.detach();
    await controller.tasksIdle();
    await session.close();
  }
  vi.unstubAllGlobals();
});

function memoryDb(): AppDb & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    async get<T>(key: string) { return structuredClone(rows.get(key)) as T | undefined; },
    async put(key, value) { rows.set(key, structuredClone(value)); },
    async list<T>(prefix: string) { return [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T })); },
    async delete(key) { rows.delete(key); },
    close() {},
  };
}

function bodyOf(user: string): string {
  const start = user.indexOf('--- BEGIN DOCUMENT ---\n') + '--- BEGIN DOCUMENT ---\n'.length;
  return user.slice(start, user.indexOf('\n--- END DOCUMENT ---'));
}

function docIdOf(user: string): string {
  return /docId: ([A-Za-z0-9]+)\)/.exec(user)?.[1] ?? '';
}

const reviewScripts: MockScript[] = [
  {
    match: (req: ChatRequest) => req.messages.some((m) => typeof m.content === 'string' && m.content.includes('continuity extractor')),
    respond: (req: ChatRequest) => {
      const user = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      const body = bodyOf(user);
      const docId = docIdOf(user);
      const quote = body.slice(0, 10);
      return { content: JSON.stringify({ spans: quote.length > 0 ? [{ docId, from: 0, to: quote.length, quote, category: 'factual', note: '' }] : [] }) };
    },
  },
  {
    match: (req: ChatRequest) => req.role === 'background',
    respond: (req: ChatRequest) => {
      const user = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      const pairIds = [...user.matchAll(/\[pair (p\d+)\]/g)].map((m) => m[1]);
      return { content: JSON.stringify({ verdicts: pairIds.map((pairId) => ({ pairId, verdict: 'consistent', reasoning: 'ok', factGroup: { entity: 'x', attribute: 'y' } })) }) };
    },
  },
];

async function fixture(seed?: (db: ReturnType<typeof memoryDb>, state: ProjectState, profileId: string) => void, extraScripts?: readonly MockScript[]) {
  const state = sampleProjectState();
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const profile = await profiles.create({ name: 'Mock', kind: 'mock', isActive: true });
  const scripts = [...reviewScripts, ...(extraScripts ?? [])];
  const makeGateway = () => createGateway({ profiles, keys, clock: createManualClock(0), mock: createMockProvider({ scripts }) });
  const db = memoryDb();
  seed?.(db, state, profile.id);
  const build = async (gateway: ReturnType<typeof makeGateway>) => {
    const store = await openRuntimeStore(new MemoryIndexedDb());
    const session = new ProjectSession({ store, projectId: state.manifest.project.id, state, shadow: null, coherence: { checks: () => [], providers: { active: () => profile, gateway, resolveForRole: () => ({ profile, model: profile.defaultModel }) } } });
    session.attachCoherence({ file: emptyCoherenceFile(), writable: true, notices: [] }, { save: async () => undefined, attachFolder: async () => undefined });
    const providers = {
      gateway,
      active: () => profile,
      get: (id: string) => profiles.get(id),
      resolveForRole: () => ({ profile, model: profile.defaultModel }),
      persist: async () => undefined,
    } as unknown as ProviderService;
    const controller = new AgentController(session, providers, () => ({}), () => false, { store: new TaskStore(db), locksAvailable: () => true });
    controller.attach();
    sessions.push({ session, controller });
    return { session, controller, gateway };
  };
  const first = await build(makeGateway());
  return {
    state, db, profile, ...first,
    reopen: async (freshLedger: boolean) => build(freshLedger ? makeGateway() : first.gateway),
  };
}

async function idle(controller: AgentController): Promise<void> {
  await controller.tasksIdle();
}

it('queues the held approval, not a caller-mutated preview, and acknowledges the report without a project write', async () => {
  const f = await fixture();
  const prepared = await f.controller.prepareQueuedReview({ scope: { mode: 'full' }, maxFindings: 50 });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return;
  const preview = prepared.preview;
  const originalCap = preview.callBound.extractCalls + preview.callBound.verifyCallsAtMost;
  const originalMaxFindings = preview.plan.maxFindings;
  const originalModel = preview.route.model;
  expect(originalCap).toBeGreaterThan(0);

  preview.callBound.verifyCallsAtMost = 9999;
  preview.plan.maxFindings = 1;
  preview.route.model = 'mutated-model';
  preview.plan.scopeDocIds.length = 0;

  const queued = await f.controller.queuePreparedReview(preview);
  expect(queued.ok).toBe(true);
  if (!queued.ok) return;
  const stored = f.db.rows.get(`task:${f.state.manifest.project.id}:${queued.task.id}`) as TaskRecord;
  expect(stored.cap).toBe(originalCap);
  expect(stored.review?.maxFindings).toBe(originalMaxFindings);
  expect(stored.review?.route.model).toBe(originalModel);
  expect(stored.review?.scopeDocIds.length).toBeGreaterThan(0);
  expect(stored.review?.plan).not.toHaveProperty('promptPreview');
  expect(JSON.stringify(stored)).not.toContain('BEGIN DOCUMENT');
  expect(prepared.preview.plan.promptPreview.length).toBeGreaterThan(0);

  await idle(f.controller);
  const task = f.controller.taskViews().find((view) => view.id === queued.task.id);
  expect(task?.status).toBe('completed');
  expect(task?.report?.outcome).toBe('complete');
  expect(task?.unread).toBe(true);
  expect(f.session.coherenceFile()?.runs).toHaveLength(1);

  await f.controller.acknowledgeReviewTask(queued.task.id);
  const acknowledged = f.controller.taskViews().find((view) => view.id === queued.task.id);
  expect(acknowledged?.acknowledged).toBe(true);
  expect(acknowledged?.unread).toBe(false);
  expect(f.session.coherenceFile()?.runs).toHaveLength(1);
});

it('refuses to queue a review in Plan only mode', async () => {
  const f = await fixture();
  f.controller.setMode('plan-only');
  const prepared = await f.controller.prepareQueuedReview({ scope: { mode: 'full' }, maxFindings: 50 });
  expect(prepared.ok).toBe(false);
});

function mixedApproval(state: ProjectState): QueuedReviewApproval {
  const plan = planReview(state, emptyCoherenceFile(), { scope: { mode: 'full' } });
  return {
    plan,
    route: { profileId: 'p_MOCK000001', model: 'fake', label: 'Mock, fake' },
    callBound: { extractCalls: plan.estimate.extractCalls, verifyCallsAtMost: plan.estimate.verifyCallsAtMost },
    scopeDocIds: plan.scopeDocIds,
    categories: plan.categories,
    maxFindings: plan.maxFindings,
    fingerprint: 'fp-mixed',
  };
}

it('consumes a mixed review plus a deferred read-only plan after a successful foreground read', async () => {
  const report: TaskReviewReport = { runId: 'r_MIXED00001', outcome: 'complete', findingsCount: 1, scopeTitles: [], routeLabel: 'Mock, fake', usage: { modelCalls: 1, promptTokens: 10, completionTokens: 2, source: 'reported' } };
  const f = await fixture((db, state) => {
    const task: TaskRecord = {
      id: 'task_MIXED00001', projectId: state.manifest.project.id, intent: 'Review, then read.',
      steps: [
        { tool: 'coherence.review', params: { scope: { mode: 'full' } }, expect: 'A coherence review' },
        { tool: 'project.overview', params: {}, expect: 'An overview' },
      ],
      status: 'ready',
      items: [{ key: '0', step: 0, state: 'staged', proposal: report }],
      cap: 2, used: 1, promptTokens: 10, completionTokens: 2, runs: 1, createdAt: Date.now(), updatedAt: Date.now(),
      kind: 'mixed', review: mixedApproval(state), report, reviewRunId: report.runId,
    };
    db.rows.set(`task:${state.manifest.project.id}:${task.id}`, task);
  });
  await vi.waitFor(() => {
    expect(f.controller.taskViews().some((view) => view.id === 'task_MIXED00001')).toBe(true);
  });
  const before = f.controller.taskViews().find((view) => view.id === 'task_MIXED00001');
  expect(before?.status).toBe('ready');
  expect(before?.kind).toBe('mixed');
  const turn = await f.controller.reviewTask('task_MIXED00001');
  expect(turn?.status).toBe('replied');
  const after = f.controller.taskViews().find((view) => view.id === 'task_MIXED00001');
  expect(after?.status).toBe('applied');
});

it('leaves a mixed task reviewable when its deferred native read is denied', async () => {
  const report: TaskReviewReport = { runId: 'r_MIXED00002', outcome: 'complete', findingsCount: 1, scopeTitles: [], routeLabel: 'Mock, fake', usage: { modelCalls: 1, promptTokens: 10, completionTokens: 2, source: 'reported' } };
  const f = await fixture((db, state) => {
    const task: TaskRecord = {
      id: 'task_MIXED00002', projectId: state.manifest.project.id, intent: 'Review, then read.',
      steps: [
        { tool: 'coherence.review', params: { scope: { mode: 'full' } }, expect: 'A coherence review' },
        { tool: 'project.overview', params: {}, expect: 'An overview' },
      ],
      status: 'ready',
      items: [{ key: '0', step: 0, state: 'staged', proposal: report }],
      cap: 2, used: 1, promptTokens: 10, completionTokens: 2, runs: 1, createdAt: Date.now(), updatedAt: Date.now(),
      kind: 'mixed', review: mixedApproval(state), report, reviewRunId: report.runId,
    };
    db.rows.set(`task:${state.manifest.project.id}:${task.id}`, task);
  });
  await vi.waitFor(() => {
    expect(f.controller.taskViews().some((view) => view.id === 'task_MIXED00002')).toBe(true);
  });
  f.session.setAgentRules([{ tool: 'project.overview', effect: 'deny', access: 'read', note: 'No overview.' }]);
  const turn = await f.controller.reviewTask('task_MIXED00002');
  expect(turn?.status).toBe('replied');
  expect(turn?.steps.some((step) => step.tool === 'project.overview' && step.status !== 'done')).toBe(true);
  const after = f.controller.taskViews().find((view) => view.id === 'task_MIXED00002');
  expect(after?.status).toBe('ready');
});

it('refuses a queued review cancelled while its initial save is held, before any paid call', async () => {
  const f = await fixture();
  const originalPut = f.db.put.bind(f.db);
  let resolveSave!: () => void;
  const saveHeld = new Promise<void>((resolve) => { resolveSave = resolve; });
  let saveStarted!: () => void;
  const started = new Promise<void>((resolve) => { saveStarted = resolve; });
  vi.spyOn(f.db, 'put').mockImplementation(async (key, value) => {
    if (key.startsWith('task:')) {
      saveStarted();
      await saveHeld;
    }
    return originalPut(key, value);
  });
  const prepared = await f.controller.prepareQueuedReview({ scope: { mode: 'full' }, maxFindings: 50 });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return;
  const abort = new AbortController();
  const pending = f.controller.queuePreparedReview(prepared.preview, abort.signal);
  await started;
  abort.abort();
  resolveSave();
  const result = await pending;
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.cancelled).toBe(true);
  expect(f.controller.taskViews()).toHaveLength(0);
  const stored = [...f.db.rows.entries()].find(([key]) => key.startsWith('task:'));
  expect(stored?.[1]).toMatchObject({ status: 'cancelled' });
  expect(f.session.coherenceFile()?.runs ?? []).toHaveLength(0);
});

it('reconciles an already-published run on resume without another model call', async () => {
  const runId = 'r_PUBLISHED01';
  const f = await fixture((db, state, profileId) => {
    const task: TaskRecord = {
      id: 'task_RECON0001', projectId: state.manifest.project.id, intent: 'Review.',
      steps: [{ tool: 'coherence.review', params: { scope: { mode: 'full' } }, expect: 'A coherence review' }],
      status: 'interrupted',
      items: [{ key: '0', step: 0, state: 'pending' }],
      cap: 3, used: 1, promptTokens: 10, completionTokens: 2, runs: 1, createdAt: Date.now(), updatedAt: Date.now(),
      kind: 'review', review: { ...mixedApproval(state), route: { ...mixedApproval(state).route, profileId } }, reviewRunId: runId,
      reviewCheckpoint: { extractedDocIds: [], spans: [], verifiedBatches: 0, verdicts: [], usageByPair: {}, promptTokens: 10, completionTokens: 2, notes: [], status: 'partial', evaluated: [] },
    };
    db.rows.set(`task:${state.manifest.project.id}:${task.id}`, task);
  });
  const published = { ...emptyCoherenceFile(), runs: [{ id: runId, at: new Date().toISOString(), kind: 'llm' as const, checkIds: [], scope: { docIds: [] }, findingsUpserted: ['f_EXISTING01'], tokens: { promptTokens: 10, completionTokens: 2 }, status: 'partial' as const }] };
  f.session.applyCoherenceFile(published);
  await vi.waitFor(() => { expect(f.controller.taskViews().some((view) => view.id === 'task_RECON0001')).toBe(true); });
  await f.controller.resumeTask('task_RECON0001');
  await f.controller.tasksIdle();
  const task = f.controller.taskViews().find((view) => view.id === 'task_RECON0001');
  expect(task?.status).toBe('completed');
  expect(task?.report?.runId).toBe(runId);
  expect(task?.report?.outcome).toBe('partial');
  expect(task?.report?.findingsCount).toBe(1);
  expect(f.session.coherenceFile()?.runs).toHaveLength(1);
});

it('does not invalidate an approval when a future document or a never codex entry changes', async () => {
  const f = await fixture((_db, state) => {
    const elena = (state.manifest.codex ?? []).find((entry) => entry.name === 'Elena')!;
    elena.includePolicy = 'always';
    state.manifest.codex!.push({ ...elena, id: 'c_NEVER00001', name: 'Secret', includePolicy: 'never', description: 'hidden' });
  });
  const storm = f.state.manifest.tree.find((node) => node.type === 'document' && node.title === 'The Storm')!;
  const friend = f.state.manifest.tree.find((node) => node.type === 'document' && node.title === 'The Friend')!;
  const prepared = await f.controller.prepareQueuedReview({ scope: { mode: 'doc', docIds: [storm.id] }, maxFindings: 50 });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return;
  friend.synopsis = 'A later chapter changes.';
  const secret = f.state.manifest.codex!.find((entry) => entry.name === 'Secret')!;
  secret.description = 'A never entry changes.';
  const queued = await f.controller.queuePreparedReview(prepared.preview);
  expect(queued.ok).toBe(true);
  await idle(f.controller);
});

it('invalidates an approval when a used codex entry or an earlier document changes', async () => {
  const f = await fixture((_db, state) => {
    const elena = (state.manifest.codex ?? []).find((entry) => entry.name === 'Elena')!;
    elena.includePolicy = 'always';
  });
  const landing = f.state.manifest.tree.find((node) => node.type === 'document' && node.title === 'The Landing')!;
  const storm = f.state.manifest.tree.find((node) => node.type === 'document' && node.title === 'The Storm')!;
  const elena = f.state.manifest.codex!.find((entry) => entry.name === 'Elena')!;

  const first = await f.controller.prepareQueuedReview({ scope: { mode: 'doc', docIds: [storm.id] }, maxFindings: 50 });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  elena.description = 'The keeper, rewritten.';
  const refusedCodex = await f.controller.queuePreparedReview(first.preview);
  expect(refusedCodex.ok).toBe(false);

  const second = await f.controller.prepareQueuedReview({ scope: { mode: 'doc', docIds: [storm.id] }, maxFindings: 50 });
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  landing.synopsis = 'A different opening.';
  const refusedStory = await f.controller.queuePreparedReview(second.preview);
  expect(refusedStory.ok).toBe(false);
});

it('refuses to queue a review offer whose canonical approval is not held', async () => {
  const f = await fixture();
  const plan = planReview(f.state, emptyCoherenceFile(), { scope: { mode: 'full' } });
  const review: PlanOfferReview = {
    stepIndex: 0,
    plan,
    callBound: { extractCalls: plan.estimate.extractCalls, verifyCallsAtMost: plan.estimate.verifyCallsAtMost },
    route: { profileId: 'p_MOCK000001', model: 'fake', label: 'Mock, fake' },
    scopeDocIds: plan.scopeDocIds,
    categories: plan.categories,
    maxFindings: plan.maxFindings,
    fingerprint: 'fp-offer',
    cost: undefined,
    costUnknownReason: null,
    scopeTitles: plan.documents.map((doc) => doc.title),
    exclusions: [],
  };
  const offer: PlanOffer = { turnId: 't_OFFER00001', steps: [{ tool: 'coherence.review', params: { scope: { mode: 'full' } }, expect: 'A coherence review' }], estimatedCalls: 3, turnCap: 8, reviews: [review] };
  const result = await f.controller.queuePlanOffer(offer);
  expect(result.ok).toBe(false);
  expect(f.controller.taskViews()).toHaveLength(0);
});

it('queues the canonical offer approval, not a mutated offer snapshot', async () => {
  const step: PlanStep = { tool: 'coherence.review', params: { scope: { mode: 'full' } }, expect: 'A coherence review' };
  const plannerScript: MockScript = { match: () => true, respond: () => ({ content: JSON.stringify({ steps: [step] }) }) };
  const f = await fixture(undefined, [plannerScript]);
  const running = f.controller.submit('Review the manuscript.');
  await vi.waitFor(() => { expect(f.controller.snapshot().offer).not.toBeNull(); });
  const offer = f.controller.snapshot().offer!.offer;
  const review = offer.reviews![0]!;
  const canonicalCap = review.callBound.extractCalls + review.callBound.verifyCallsAtMost;
  const canonicalScope = [...review.scopeDocIds];

  const unrelated: PlanOffer = { ...offer, reviews: [{ ...review, fingerprint: 'fp-unrelated' }] };
  expect((await f.controller.queuePlanOffer(unrelated)).ok).toBe(false);

  const mutated: PlanOffer = { ...offer, reviews: [{ ...review, callBound: { extractCalls: 999, verifyCallsAtMost: 999 }, scopeDocIds: ['n_FAKE000001'], maxFindings: 1, plan: { ...review.plan, estimate: { ...review.plan.estimate, extractCalls: 999 } } }] };
  const queued = await f.controller.queuePlanOffer(mutated);
  expect(queued.ok).toBe(true);
  if (queued.ok) {
    const stored = f.db.rows.get(`task:${f.state.manifest.project.id}:${queued.task.id}`) as TaskRecord;
    expect(stored.cap).toBe(canonicalCap);
    expect(stored.review?.scopeDocIds).toEqual(canonicalScope);
    expect(stored.review?.maxFindings).toBe(review.maxFindings);
  }

  expect((await f.controller.queuePlanOffer(mutated)).ok).toBe(false);

  await f.controller.answerOffer('cancel');
  await running;
  await idle(f.controller);
});

async function completedReview(f: Awaited<ReturnType<typeof fixture>>) {
  const prepared = await f.controller.prepareQueuedReview({ scope: { mode: 'full' }, maxFindings: 50 });
  if (!prepared.ok) throw new Error(prepared.reason);
  const queued = await f.controller.queuePreparedReview(prepared.preview);
  if (!queued.ok) throw new Error(queued.reason);
  await idle(f.controller);
  const key = `task:${f.state.manifest.project.id}:${queued.task.id}`;
  return { key, id: queued.task.id, stored: f.db.rows.get(key) as TaskRecord };
}

function interruptedAfterFirstExtraction(stored: TaskRecord, withAccounting: boolean): TaskRecord {
  const cp = stored.reviewCheckpoint!;
  const firstDoc = cp.extractedDocIds[0]!;
  const base = {
    extractedDocIds: [firstDoc],
    spans: cp.spans.filter((span) => span.docId === firstDoc),
    verifiedBatches: 0,
    verdicts: [],
    usageByPair: {},
    promptTokens: 0,
    completionTokens: 0,
    notes: [],
    status: 'partial' as const,
    evaluated: [firstDoc],
  };
  const checkpoint = withAccounting ? { ...base, modelCalls: 1, usageSource: 'reported' as const } : base;
  return { ...stored, status: 'interrupted', items: stored.items.map((item) => ({ ...item, state: 'pending' as const })), reviewCheckpoint: checkpoint, used: 1, report: undefined };
}

it('reports the provider’s actual request count and persists it at the checkpoint', async () => {
  const f = await fixture();
  const { id, stored } = await completedReview(f);
  const task = f.controller.taskViews().find((view) => view.id === id);
  expect(task?.status).toBe('completed');
  const requests = f.gateway.ledger.turnTotals(`${id}.review`).requests;
  expect(requests).toBeGreaterThan(0);
  expect(task?.report?.usage.source).toBe('reported');
  expect(task?.report?.usage.modelCalls).toBe(requests);
  expect(stored.reviewCheckpoint?.modelCalls).toBe(requests);
  expect(stored.reviewCheckpoint?.usageSource).toBe('reported');
});

it('resume carries persisted request accounting on an empty ledger without double counting', async () => {
  const f = await fixture();
  const { key, id, stored } = await completedReview(f);
  const total = stored.reviewCheckpoint!.modelCalls!;
  expect(total).toBeGreaterThan(1);
  f.db.rows.set(key, interruptedAfterFirstExtraction(stored, true));
  const again = await f.reopen(true);
  await vi.waitFor(() => { expect(again.controller.taskViews().some((view) => view.id === id)).toBe(true); });
  await again.controller.resumeTask(id);
  await again.controller.tasksIdle();
  const task = again.controller.taskViews().find((view) => view.id === id);
  expect(task?.status).toBe('completed');
  expect(task?.report?.usage.modelCalls).toBe(total);
  expect(task?.report?.usage.source).toBe('reported');
});

it('resume does not double count when the ledger still holds the earlier requests', async () => {
  const f = await fixture();
  const { key, id, stored } = await completedReview(f);
  const total = stored.reviewCheckpoint!.modelCalls!;
  f.db.rows.set(key, interruptedAfterFirstExtraction(stored, true));
  const again = await f.reopen(false);
  expect(again.gateway.ledger.turnTotals(`${id}.review`).requests).toBe(total);
  await vi.waitFor(() => { expect(again.controller.taskViews().some((view) => view.id === id)).toBe(true); });
  await again.controller.resumeTask(id);
  await again.controller.tasksIdle();
  const task = again.controller.taskViews().find((view) => view.id === id);
  expect(task?.status).toBe('completed');
  expect(task?.report?.usage.modelCalls).toBe(total);
});

it('a resumed checkpoint without accounting stays unknown rather than inventing reported usage', async () => {
  const f = await fixture();
  const { key, id, stored } = await completedReview(f);
  f.db.rows.set(key, interruptedAfterFirstExtraction(stored, false));
  const again = await f.reopen(true);
  await vi.waitFor(() => { expect(again.controller.taskViews().some((view) => view.id === id)).toBe(true); });
  await again.controller.resumeTask(id);
  await again.controller.tasksIdle();
  const task = again.controller.taskViews().find((view) => view.id === id);
  expect(task?.status).toBe('completed');
  expect(task?.report?.usage.source).toBe('unknown');
});

it('resume keeps an estimated source estimated even when later requests report usage', async () => {
  const f = await fixture();
  const { key, id, stored } = await completedReview(f);
  const truncated = interruptedAfterFirstExtraction(stored, true);
  f.db.rows.set(key, { ...truncated, reviewCheckpoint: { ...truncated.reviewCheckpoint!, usageSource: 'estimated' } });
  const again = await f.reopen(true);
  await vi.waitFor(() => { expect(again.controller.taskViews().some((view) => view.id === id)).toBe(true); });
  await again.controller.resumeTask(id);
  await again.controller.tasksIdle();
  const task = again.controller.taskViews().find((view) => view.id === id);
  expect(task?.status).toBe('completed');
  expect(task?.report?.usage.source).toBe('estimated');
});

it('invalidates an approval when the focus document is renamed, but not for a document outside the scope', async () => {
  const f = await fixture();
  const documents = f.state.manifest.tree.filter((node) => node.type === 'document');
  const focus = documents[0]!;
  const outsider = documents[documents.length - 1]!;
  expect(outsider.id).not.toBe(focus.id);
  const prepared = await f.controller.prepareQueuedReview({ scope: { mode: 'doc', docIds: [focus.id] }, maxFindings: 50 });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return;
  outsider.title = 'A renamed later chapter';
  const stillQueued = await f.controller.queuePreparedReview(prepared.preview);
  expect(stillQueued.ok).toBe(true);
  await idle(f.controller);

  const second = await f.controller.prepareQueuedReview({ scope: { mode: 'doc', docIds: [focus.id] }, maxFindings: 50 });
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  focus.title = 'A renamed focus';
  const refused = await f.controller.queuePreparedReview(second.preview);
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.reason).toContain('changed since it was approved');
});

it('invalidates an approval when a scoped document is archived, even the first with no story so far', async () => {
  const f = await fixture();
  const focus = f.state.manifest.tree.filter((node) => node.type === 'document')[0]!;
  const prepared = await f.controller.prepareQueuedReview({ scope: { mode: 'doc', docIds: [focus.id] }, maxFindings: 50 });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return;
  focus.status = 'archived';
  const refused = await f.controller.queuePreparedReview(prepared.preview);
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.reason).toContain('changed since it was approved');
});

it('queues the held offer steps, not a caller-mutated steps array', async () => {
  const step: PlanStep = { tool: 'coherence.review', params: { scope: { mode: 'full' } }, expect: 'A coherence review' };
  const plannerScript: MockScript = { match: () => true, respond: () => ({ content: JSON.stringify({ steps: [step] }) }) };
  const f = await fixture(undefined, [plannerScript]);
  const running = f.controller.submit('Review the manuscript.');
  await vi.waitFor(() => { expect(f.controller.snapshot().offer).not.toBeNull(); });
  const offer = f.controller.snapshot().offer!.offer;
  const canonicalSteps = structuredClone(offer.steps);
  const mutated: PlanOffer = {
    ...offer,
    steps: [{ tool: 'coherence.review', params: { scope: { mode: 'doc', docIds: ['n_FAKE000001'] }, maxFindings: 1 }, expect: 'A mutated review' }],
  };
  const queued = await f.controller.queuePlanOffer(mutated);
  expect(queued.ok).toBe(true);
  if (queued.ok) {
    const stored = f.db.rows.get(`task:${f.state.manifest.project.id}:${queued.task.id}`) as TaskRecord;
    expect(stored.steps).toEqual(canonicalSteps);
    expect(stored.review?.scopeDocIds).toEqual(offer.reviews![0]!.scopeDocIds);
    expect(stored.review?.maxFindings).toBe(offer.reviews![0]!.maxFindings);
  }
  await f.controller.answerOffer('cancel');
  await running;
  await idle(f.controller);
});

it('refuses a draft-only offer that is no longer held', async () => {
  const f = await fixture();
  const offer: PlanOffer = { turnId: 't_GONE000001', steps: [{ tool: 'scene.draft', params: { doc: 'The Landing', instruction: 'Open.', mode: 'draft' }, expect: 'A draft' }], estimatedCalls: 1, turnCap: 8 };
  const result = await f.controller.queuePlanOffer(offer);
  expect(result.ok).toBe(false);
  expect(f.controller.taskViews()).toHaveLength(0);
});

it('a tampered checkpoint is not resumed: the review restarts within the remaining bound, keeping its accounted usage', async () => {
  const f = await fixture();
  const { key, id, stored } = await completedReview(f);
  const total = stored.reviewCheckpoint!.modelCalls!;
  expect(total).toBeGreaterThan(1);
  const truncated = interruptedAfterFirstExtraction(stored, true);
  const firstDoc = truncated.reviewCheckpoint!.extractedDocIds[0]!;
  const tampered = {
    ...truncated,
    reviewCheckpoint: {
      ...truncated.reviewCheckpoint!,
      spans: [{ docId: firstDoc, from: 0, to: 24, quote: 'a forged span quote', category: 'factual' as const, note: '' }],
    },
  };
  f.db.rows.set(key, tampered);
  const again = await f.reopen(true);
  await vi.waitFor(() => { expect(again.controller.taskViews().some((view) => view.id === id)).toBe(true); });
  await again.controller.resumeTask(id);
  await again.controller.tasksIdle();
  const task = again.controller.taskViews().find((view) => view.id === id);
  expect(task?.status).toBe('completed');
  expect(task?.report?.usage.modelCalls).toBe(total + 1);
  expect(again.gateway.ledger.turnTotals(`${id}.review`).requests).toBe(total);
  expect(task!.used).toBeLessThanOrEqual(stored.cap);
  const run = again.session.coherenceFile()?.runs.find((entry) => entry.id === task?.report?.runId);
  expect(run?.notes.some((note) => note.includes('did not match the approved documents'))).toBe(true);
});
