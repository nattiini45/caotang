import { expect, it } from 'vitest';
import { createAgentPorts, createAgentSession, createContextPort, createHarness, parsePlan, type ContextOverrides, type PendingCard, type PlanStep, type RuleSet } from '@caotang/harness';
import { textOf, type ChatRequest } from '@caotang/gateway';
import { setBody } from '@caotang/store';
import { ENTRY, ENTRY_TWO, FRIEND, LANDING, STORM, makeState } from '../../../packages/harness/test/fixtures.js';
import { mockGateway } from '../../../packages/harness/test/agent/gateway.js';
import { prose, steps, transcript } from '../../../packages/harness/test/agent/scripts.js';
import type { AppDb } from '../src/app/app-db.js';
import { TaskQueue, type TaskAgent } from '../src/app/task-queue.js';
import { TaskStore, asTaskRecord, reviewOf, taskKey } from '../src/app/task-store.js';

const PROJECT = 'p_TASKPROJ01';
const step: PlanStep = { tool: 'scene.draft', params: { doc: 'Scene', instruction: 'Open.', mode: 'draft' }, expect: 'A draft' };
const choices = () => ({ include: [{ kind: 'codex' as const, id: 'c_KEEPER0001' }], exclude: [{ kind: 'doc' as const, id: 'n_PRIVATE001' }] });

function setup() {
  const rows = new Map<string, unknown>();
  const db: AppDb = {
    async get<T>(key: string) { return structuredClone(rows.get(key)) as T | undefined; },
    async put(key, value) { rows.set(key, structuredClone(value)); },
    async list<T>(prefix: string) { return [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T })); },
    async delete(key) { rows.delete(key); },
    close() {},
  };
  const seen: (ContextOverrides | undefined)[] = [];
  const agent: TaskAgent = { stageOnly: async (_steps, options) => {
    seen.push(structuredClone(options?.contextOverrides));
    return { proposals: [{ text: 'A draft.', words: 2, revision: 0 }], revisions: [{}], refusals: [], stopped: false, modelCalls: 1, tokens: { promptTokens: 10, completionTokens: 2, requests: 1 } };
  } };
  const store = new TaskStore(db);
  let busy = false;
  const queue = () => new TaskQueue({ projectId: PROJECT, store, agentFor: () => agent, foregroundBusy: () => busy, locksAvailable: () => true, newId: () => 'task_CONTEXT001' });
  return { db, store, queue, seen, setBusy: (value: boolean) => { busy = value; } };
}

it('snapshots request choices through storage, interrupted resume, each staging call and review', async () => {
  const h = setup();
  const first = h.queue();
  await first.open();
  const supplied = choices();
  h.setBusy(true);
  await first.enqueue('Draft.', [step], supplied);
  supplied.include[0]!.id = 'c_CHANGED001';
  supplied.exclude.length = 0;
  h.setBusy(false);
  await first.idle();
  const task = first.snapshot()[0]!;
  expect(task.contextOverrides).toEqual(choices());
  expect(h.seen).toEqual([choices()]);
  expect(first.review(task.id)?.task.contextOverrides).toEqual(choices());
  await first.close();
  await h.store.save({ ...task, status: 'running', items: [{ key: '0', step: 0, state: 'pending' }], used: 0 });
  const resumed = h.queue();
  await resumed.open();
  expect(resumed.snapshot()[0]?.status).toBe('interrupted');
  await resumed.resume(task.id);
  await resumed.idle();
  expect(h.seen).toEqual([choices(), choices()]);
  expect(resumed.review(task.id)?.task.contextOverrides).toEqual(choices());
  await resumed.close();
});

it('reads legacy absent choices and refuses malformed task or step choices before running them', async () => {
  const h = setup();
  const queue = h.queue();
  await queue.open();
  await queue.enqueue('Draft.', [step]);
  await queue.idle();
  const task = queue.snapshot()[0]!;
  expect(asTaskRecord(task, PROJECT)?.contextOverrides).toBeUndefined();
  await queue.close();
  h.seen.length = 0;
  for (const invalid of [null, { include: 'all' }, { exclude: [{ kind: 'doc', id: 4 }] }, { include: [{ kind: 'asset', id: 'asset' }] }, { exclude: [{ kind: 'doc', id: ' ' }] }, { exclude: [], extra: true }]) {
    expect(asTaskRecord({ ...task, contextOverrides: invalid }, PROJECT)).toBeUndefined();
    expect(asTaskRecord({ ...task, steps: [{ ...step, contextOverrides: invalid }] }, PROJECT)).toBeUndefined();
    for (const damaged of [{ ...task, contextOverrides: invalid }, { ...task, steps: [{ ...step, contextOverrides: invalid }] }]) {
      await h.db.put(taskKey(PROJECT, task.id), damaged);
      const loaded = h.queue();
      await loaded.open();
      await loaded.resume(task.id);
      await loaded.idle();
      expect(loaded.snapshot()).toEqual([]);
      expect(h.seen).toEqual([]);
      await loaded.close();
    }
  }
});

it.each([false, true])('keeps stored choices on actual staging payloads and review cards after reload (native=%s)', async (native) => {
  const state = makeState();
  state.manifest.codex!.find((entry) => entry.id === ENTRY)!.description = 'Pinned context witness.';
  const never = state.manifest.codex!.find((entry) => entry.id === ENTRY_TWO)!;
  never.description = 'Never context witness.';
  never.includePolicy = 'never';
  setBody(state, FRIEND, 'Read-denied context witness.');
  const draft: PlanStep = { tool: 'scene.draft', params: { doc: STORM, instruction: 'Continue.', mode: 'continue' }, expect: 'A draft' };
  const intent = 'Draft the next five passages.';
  const base = await mockGateway([
    { match: (request) => request.tools !== undefined, respond: () => ({ content: '', toolCalls: Array.from({ length: 5 }, (_, index) => ({ id: `draft-${index}`, name: draft.tool, argumentsJson: JSON.stringify(draft.params) })) }) },
    transcript(intent, [steps(draft, draft, draft, draft, draft)]), prose('Brief: Continue.', 'A draft.'),
  ]);
  const requests: ChatRequest[] = [];
  const gateway = { ...base, modelCaps: () => ({ tools: native }), complete: (request: ChatRequest, signal?: AbortSignal) => {
    requests.push(structuredClone(request));
    return base.complete(request, signal);
  } };
  let rules: RuleSet = { rules: [] };
  const harness = createHarness({ state, ports: createAgentPorts(), rules: () => rules });
  const supplied = { include: [{ kind: 'codex' as const, id: ENTRY }, { kind: 'codex' as const, id: ENTRY_TWO }, { kind: 'doc' as const, id: FRIEND }], exclude: [{ kind: 'doc' as const, id: LANDING }] };
  const expected = structuredClone(supplied);
  expect(parsePlan({ steps: [{ ...draft, contextOverrides: expected }] }).ok).toBe(false);
  const { store } = setup();
  let busy = true;
  const queue = () => new TaskQueue({ projectId: PROJECT, store, foregroundBusy: () => busy, locksAvailable: () => true,
    agentFor: (_task, sessionId) => createAgentSession({ harness, gateway, sessionId, role: 'background', decide: async () => ({ action: 'cancel' }) }),
  });
  const first = queue();
  await first.open();
  const foreground = createAgentSession({ harness, gateway, loadEveryTool: () => true, decide: async () => ({ action: 'cancel' }), beforeStage: async (offer) => {
    expect(offer.contextOverrides).toEqual(expected);
    expect((await first.enqueue(intent, offer.steps, offer.contextOverrides)).ok).toBe(true);
    return 'background';
  } });
  expect((await foreground.submit(intent, { contextOverrides: supplied })).status).toBe('replied');
  supplied.include.length = 0;
  supplied.exclude.length = 0;
  await first.close();
  const saved = (await store.list(PROJECT))[0]!;
  expect(saved.status).toBe('interrupted');
  expect(saved.contextOverrides).toEqual(expected);
  await store.save({ ...saved, steps: saved.steps.map((entry, index) => index === 0 ? { ...entry, contextOverrides: { ...expected, exclude: [...expected.exclude, { kind: 'codex', id: ENTRY }] } } : entry) });
  rules = { rules: [{ source: 'app', tool: '*', effect: 'deny', access: 'read', scope: { subtree: FRIEND } }] };
  expect(harness.withheld('scene.draft').has(FRIEND)).toBe(true);
  busy = false;
  const resumed = queue();
  await resumed.open();
  await resumed.resume(saved.id);
  await resumed.idle();
  const ready = resumed.review(saved.id)!;
  expect(ready.task.status).toBe('ready');
  expect(ready.task.items.map(({ state, error }) => ({ state, error }))).toEqual(Array.from({ length: 5 }, () => ({ state: 'staged', error: undefined })));
  const drafts = requests.filter((request) => request.responseFormat === 'text');
  expect(drafts).toHaveLength(5);
  for (const [index, request] of drafts.entries()) {
    const sent = request.messages.map((message) => textOf(message.content)).join('\n');
    expect(sent.includes('Pinned context witness.')).toBe(index !== 0);
    expect(sent).not.toContain('Never context witness.');
    expect(sent).not.toContain('Read-denied context witness.');
    expect(sent).not.toContain('The ferry was late, as always.');
    expect(sent).toContain('The lamp failed.');
  }
  const cards: PendingCard[] = [];
  const reviewer = createAgentSession({ harness, gateway, decide: async (card) => { cards.push(card); return { action: 'cancel' }; } });
  expect((await reviewer.submitStaged(intent, { steps: ready.review.steps }, ready.review.proposals, ready.review.revisions, { contextOverrides: ready.task.contextOverrides })).status).toBe('cancelled');
  expect(cards).toHaveLength(1);
  for (const [index, card] of cards[0]!.card.steps.entries()) {
    const kept = card.context?.layers.find((layer) => layer.id === 'L2')?.kept ?? [];
    expect(kept.some((entry) => entry.ref?.id === ENTRY)).toBe(index !== 0);
  }
  expect(requests).toHaveLength(6);
  expect((await reviewer.submitStaged(intent, { steps: [{ ...draft, contextOverrides: { exclude: 'all' } }] }, [], [])).status).toBe('failed');
  expect(requests).toHaveLength(6);
  await resumed.close();
});

it('keeps every staged synopsis prompt when rebuilding its review batch', async () => {
  const h = setup();
  const queue = h.queue();
  await queue.open();
  await queue.enqueue('Draft.', [step]);
  await queue.idle();
  const state = makeState();
  const contextOverrides: ContextOverrides = { include: [{ kind: 'codex', id: ENTRY }], exclude: [{ kind: 'doc', id: LANDING }] };
  const context = createContextPort({ state });
  const documents = [STORM, FRIEND];
  const items = documents.map((id) => ({ docId: id, synopsis: 'A synopsis.' }));
  const previews = documents.map((id) => context.assemble({ task: { tool: 'synopsis.fill', focus: id, instruction: 'Summarise.', overrides: contextOverrides }, role: 'Draft.' }).preview);
  const review = reviewOf({ ...queue.snapshot()[0]!, contextOverrides, steps: [{ tool: 'synopsis.fill', params: { docs: documents, source: 'text' }, expect: 'Two synopses' }],
    items: documents.map((id, index) => ({ key: `0:${id}`, step: 0, ref: id, state: 'staged', proposal: {
      items: [items[index]], context: previews[index],
    } })),
  });
  expect(review.proposals[0]).toMatchObject({ items, context: {
    payload: previews.flatMap((preview) => preview.payload),
    promptTokens: previews.reduce((sum, preview) => sum + preview.promptTokens, 0),
    layers: expect.arrayContaining([expect.objectContaining({ id: 'L2', kept: expect.arrayContaining([expect.objectContaining({ ref: { kind: 'codex', id: ENTRY } })]) })]),
  } });
  await queue.close();
});
