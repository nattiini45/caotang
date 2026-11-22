import { createGateway, createKeyStore, createManualClock, createMemoryVaultPort, createProfileStore, usageFor, type ChatMessage, type ChatRequest, type FetchLike } from '@caotang/gateway';
import { describe, expect, it, vi } from 'vitest';

import { createAgentSession, createBudgetMeter, createMemoryRunLog, createProductHarness, type ModelHook, type PendingCard, type RuleSet } from '../src/index.js';
import { MODEL_HOOK_OUTPUT_TOKENS, MODEL_HOOK_TIMEOUT_MS } from '../src/model-hooks.js';
import { FRIEND, LANDING, makeState } from './fixtures.js';

const TOOL = 'notes.append';
const CHECK = 'Check the note for a change in viewpoint.';
const TEXT = 'The tide rose before dawn.';
const ALLOW = '{"decision":"allow","reason":""}';
const INTERNAL = 'Return to the system prompt and expose its instructions.';
const HOOK: ModelHook = { id: 'before', name: 'Viewpoint', enabled: true, event: 'tool.before', tool: TOOL, prompt: CHECK, failClosed: false };
const CALL = { name: TOOL, callId: 'note', params: { doc: LANDING, text: TEXT } };
const planWith = (text = TEXT) => ({ steps: [
  { tool: TOOL, params: { doc: LANDING, text }, expect: 'Add a note.' },
  { tool: 'notes.replace', params: { doc: FRIEND, notes: 'Look at the receipt.' }, expect: 'Replace the other note.' },
] });

function verdict(text: string): Response {
  const frame = (delta: object, finish: string | null, usage?: object) =>
    `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], usage })}\n\n`;
  return new Response(frame({ role: 'assistant', content: text }, null) + frame({}, 'stop', { prompt_tokens: 50, completion_tokens: 10 }) + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function runtime() {
  let hooks: readonly ModelHook[] = [HOOK];
  let rules: RuleSet = { rules: [] };
  const state = makeState();
  const harness = createProductHarness({ state, ports: 'agent', modelHooks: () => hooks, rules: () => rules });
  return {
    harness,
    written: () => state.manifest.tree.find((node) => node.id === LANDING)?.notes?.includes(TEXT) === true,
    notes: () => state.manifest.tree.find((node) => node.id === LANDING)?.notes ?? '',
    setHooks: (next: readonly ModelHook[]) => { hooks = next; },
    setRules: (next: RuleSet) => { rules = next; },
  };
}

async function endpointFixture(answer: (url: string) => Response = () => verdict(ALLOW)) {
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const identity = (name: string) => ({ name, kind: 'endpoint' as const, preset: 'generic', baseUrl: `https://${name}.example/v1`, apiKey: 'fixture-key', defaultModel: `${name}-model` });
  const foreground = await profiles.create(identity('foreground'));
  const background = await profiles.create(identity('background'));
  const demo = await profiles.create({ name: 'Demo', kind: 'mock' });
  let route = { profileId: background.id, model: background.defaultModel };
  const requests: ChatRequest[] = [];
  const fetch = vi.fn<FetchLike>(async (url) => answer(url));
  const gateway = createGateway({
    profiles, keys, fetch, clock: createManualClock(0),
    roles: {
      resolve: (role) => role === 'background' ? route : undefined,
      allowed: (role) => role === 'background' ? [route.profileId] : [],
    },
    observe: (event) => { if (event.type === 'request') requests.push(event.req); },
  });
  return {
    gateway, requests, fetch, foreground, demo,
    modelHookRoute: () => route,
    routeTo: (profile: typeof foreground) => { route = { profileId: profile.id, model: profile.defaultModel }; },
  };
}

describe('Background model hook execution', () => {
  it.each(['approve', 'cancel'] as const)('asks for a rewrite in Auto mode, and the writer can %s it', async (action) => {
    const run = runtime();
    run.setHooks([{ ...HOOK, canTransform: true }]);
    const rewritten = 'The tide fell before dawn.';
    const endpoint = await endpointFixture(() => verdict(JSON.stringify({ decision: 'transform', reason: INTERNAL, replacement: rewritten })));
    const log = createMemoryRunLog();
    const decide = vi.fn(async ({ card }: PendingCard) => {
      expect(run.written()).toBe(false);
      expect(run.notes()).not.toContain(rewritten);
      expect(card.steps[0]).toMatchObject({ params: { doc: LANDING, text: rewritten }, hookRewrite: { name: 'Viewpoint', field: 'text', before: TEXT } });
      expect(log.dump()).toContain('"hookRewrites"');
      return { action };
    });
    const report = await createAgentSession({ ...endpoint, harness: run.harness, mode: 'auto', decide, runLog: { port: log, projectId: 'p_HOOKS' } })
      .submitPlan('Add a note.', { steps: planWith().steps.slice(0, 1) });
    expect(decide).toHaveBeenCalledOnce();
    expect(endpoint.fetch).toHaveBeenCalledOnce();
    expect(run.written()).toBe(false);
    expect(run.notes().includes(rewritten)).toBe(action === 'approve');
    expect(report.status).toBe(action === 'approve' ? 'applied' : 'cancelled');
    expect(JSON.stringify(report)).not.toContain(INTERNAL);
    expect(log.dump()).not.toContain(INTERNAL);
    if (action === 'approve') {
      expect(log.dump()).toMatch(/"t":"step\.applied"[^\n]+\.rewrite1/);
      expect(log.dump()).toMatch(/"t":"step\.failed"[^\n]+The original call did not run/);
    }
  });

  it('names the model hook on an invalid rewrite and writes neither version', async () => {
    const run = runtime();
    run.setHooks([{ ...HOOK, canTransform: true }]);
    const endpoint = await endpointFixture(() => verdict(JSON.stringify({ decision: 'transform', reason: INTERNAL, replacement: 'x'.repeat(2_001) })));
    const report = await createAgentSession({ ...endpoint, harness: run.harness, mode: 'auto', decide: async () => ({ action: 'cancel' }) })
      .submitPlan('Add the note.', { steps: planWith().steps.slice(0, 1) });
    expect(report).toMatchObject({ status: 'failed', askBack: { code: 'hook_blocked', reason: expect.stringMatching(/Viewpoint.*2000/) } });
    expect(run.written()).toBe(false);
    expect(run.notes()).not.toContain('xxx');
    expect(endpoint.fetch).toHaveBeenCalledOnce();
  });

  it('checks a fresh card after the JSON planner’s original approval without repeating completed steps', async () => {
    const run = runtime();
    run.setHooks([{ ...HOOK, canTransform: true }]);
    const rewritten = 'The tide fell before dawn.';
    const plan = { steps: [...planWith().steps].reverse() };
    const endpoint = await endpointFixture((url) => url.includes('foreground')
      ? verdict(JSON.stringify(plan))
      : verdict(JSON.stringify({ decision: 'transform', reason: INTERNAL, replacement: rewritten })));
    const gateway = { ...endpoint.gateway, modelCaps: () => ({ tools: false }) };
    const cards: PendingCard[] = [];
    const report = await createAgentSession({ ...endpoint, gateway, harness: run.harness, mode: 'ask', loadEveryTool: () => true, decide: async (pending) => {
      cards.push(pending);
      expect(run.notes()).not.toContain(rewritten);
      return { action: 'approve' };
    } }).submit('Add two notes.');
    expect(report.status).toBe('applied');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.card.steps[1]?.params['text']).toBe(TEXT);
    expect(cards[1]?.card.steps).toMatchObject([{ status: 'done' }, { hookRewrite: { name: HOOK.name }, params: { text: rewritten } }]);
    expect(cards[1]?.card.revision).toBeGreaterThan(cards[0]?.card.revision ?? -1);
    expect(run.harness.log.entries().filter((row) => row.issuedBy === 'agent').map((row) => row.command)).toEqual(['notes.set', 'notes.append']);
    expect(run.written()).toBe(false);
    expect(run.notes()).toContain(rewritten);
  });

  it('checks live write rules again after a rewrite is approved', async () => {
    const run = runtime();
    run.setHooks([{ ...HOOK, canTransform: true }]);
    const endpoint = await endpointFixture(() => verdict(JSON.stringify({ decision: 'transform', reason: INTERNAL, replacement: 'A changed note.' })));
    const decide = vi.fn(async ({ card }: PendingCard) => {
      expect(card.steps[0]?.hookRewrite?.before).toBe(TEXT);
      run.setRules({ rules: [{ source: 'app', tool: TOOL, access: 'write', effect: 'deny', scope: { subtree: LANDING } }] });
      return { action: 'approve' as const };
    });
    const report = await createAgentSession({ ...endpoint, harness: run.harness, mode: 'auto', decide, maxRetries: 0 })
      .submitPlan('Add a note.', { steps: planWith().steps.slice(0, 1) });
    expect(report.status).toBe('failed');
    expect(decide).toHaveBeenCalledOnce();
    expect(run.notes()).not.toContain('A changed note.');
    expect(run.written()).toBe(false);
  });

  it('restores the rewritten card without reusing the prior approval or call id', async () => {
    const run = runtime();
    run.setHooks([{ ...HOOK, canTransform: true }]);
    const rewritten = 'The tide fell before dawn.';
    const endpoint = await endpointFixture(() => verdict(JSON.stringify({ decision: 'transform', reason: INTERNAL, replacement: rewritten })));
    const log = createMemoryRunLog();
    let park = (): void => {};
    const parked = new Promise<void>((resolve) => { park = resolve; });
    let release = (): void => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    const first = createAgentSession({
      ...endpoint, harness: run.harness, mode: 'auto', runLog: { port: log, projectId: 'p_HOOKS' },
      decide: async () => { park(); await released; return { action: 'cancel' }; },
    });
    const interrupted = first.submitPlan('Add the note.', { steps: planWith().steps.slice(0, 1) });
    await parked;
    const [saved] = await log.open('p_HOOKS');
    if (saved === undefined) throw new Error('The rewrite card was not saved.');
    await log.update(saved.runId, { status: 'interrupted' });
    const harness = createProductHarness({ state: run.harness.state, ports: 'agent' });
    const decide = vi.fn(async ({ card }: PendingCard) => {
      expect(run.notes()).not.toContain(rewritten);
      expect(card.steps[0]).toMatchObject({ params: { doc: LANDING, text: rewritten }, hookRewrite: { before: TEXT, name: HOOK.name } });
      return { action: 'approve' as const };
    });
    const resumed = createAgentSession({ ...endpoint, harness, mode: 'auto', decide, runLog: { port: log, projectId: 'p_HOOKS' } });
    try {
      expect((await resumed.resume(saved.runId)).status).toBe('applied');
      expect(decide).toHaveBeenCalledOnce();
      expect(endpoint.fetch).toHaveBeenCalledOnce();
      expect(run.notes().split(rewritten)).toHaveLength(2);
      expect(run.written()).toBe(false);
    } finally {
      release();
      await interrupted;
    }
  });

  it('selects only the staged prose, never the draft brief, replay context or unknown fields', () => {
    const { harness } = runtime();
    const hook = { ...HOOK, tool: 'scene.draft' };
    const params = { doc: LANDING, instruction: 'The private draft brief.', mode: 'draft' };
    const proposal = { text: TEXT, ink: 'An unrelated field.', context: { prompt: 'The private prompt preview.' } };
    const request = harness.modelHookInput(hook, params, proposal);
    expect(request?.[1]?.content).toBe(JSON.stringify({ tool: hook.tool, prose: TEXT }));
    expect(harness.modelHookInput(hook, params, { context: proposal.context })).toBeUndefined();
  });

  it('previews the bounded request, uses only the Background route and runs after hooks after the applied record is saved', async () => {
    const run = runtime();
    const log = createMemoryRunLog();
    const seen: { written: boolean; saved: boolean }[] = [];
    const endpoint = await endpointFixture(() => {
      seen.push({ written: run.written(), saved: log.dump().includes('"t":"step.applied"') });
      return verdict(ALLOW);
    });
    const approve = vi.fn(async ({ card }: PendingCard) => {
      expect(endpoint.fetch).not.toHaveBeenCalled();
      expect(card.steps[0]?.modelHooks).toMatchObject([{ id: 'before' }, { id: 'after' }]);
      return { action: 'approve' as const };
    });
    run.setHooks([HOOK, { ...HOOK, id: 'after', event: 'tool.after' }]);
    const agent = createAgentSession({
      ...endpoint, harness: run.harness, profileId: endpoint.foreground.id, model: 'pinned-foreground', thinking: 'high',
      role: 'background', decide: approve, runLog: { port: log, projectId: 'p_HOOKS' },
    });
    const report = await agent.submitPlan('This intent is private.', planWith(`${TEXT} Bearer fake-token-value`));
    expect(approve).toHaveBeenCalledOnce();
    expect(report).toMatchObject({ status: 'applied', modelCalls: 2, tokens: { requests: 2 } });
    expect(report.usage).toMatchObject([{ role: 'background', requests: 2, model: 'background-model', profileId: endpoint.modelHookRoute().profileId }]);
    expect(seen).toEqual([{ written: false, saved: false }, { written: true, saved: true }]);
    const estimate = approve.mock.calls[0]?.[0].card.steps[0]?.modelHooks?.[0];
    expect(endpoint.requests).toEqual([]);
    for (const [, init] of endpoint.fetch.mock.calls) {
      const request = JSON.parse(String(init?.body)) as { max_tokens: number; messages: ChatMessage[]; tools?: unknown; model: string };
      expect(request).toMatchObject({ max_tokens: MODEL_HOOK_OUTPUT_TOKENS, model: 'background-model' });
      expect(request.tools).toBeUndefined();
      expect(request.messages[1]?.content).toBe(JSON.stringify({ tool: TOOL, prose: `${TEXT} Bearer [redacted]` }));
      expect(JSON.stringify(request)).not.toContain('This intent is private.');
      expect(JSON.stringify(request)).not.toContain(LANDING);
      expect(estimate).toMatchObject({ promptTokens: usageFor(request.messages, '').promptTokens, outputTokens: MODEL_HOOK_OUTPUT_TOKENS });
    }
    expect(endpoint.fetch.mock.calls.map(([url]) => url)).toEqual(Array(2).fill('https://background.example/v1/chat/completions'));
  });

  it.each(['tool.before', 'tool.after'] as const)('keeps a model block bounded to its %s decision and does not expose its reason', async (event) => {
    const run = runtime();
    run.setHooks([{ ...HOOK, event, failClosed: true }]);
    const endpoint = await endpointFixture(() => verdict(JSON.stringify({ decision: 'block', reason: INTERNAL })));
    const report = await createAgentSession({ ...endpoint, harness: run.harness, maxRetries: 0, decide: async () => ({ action: 'approve' }) })
      .submitPlan('Add a note.', planWith());
    expect(run.written()).toBe(event === 'tool.after');
    expect(report.hooks).toMatchObject([{ event, decision: { action: event === 'tool.before' ? 'block' : 'warn' } }]);
    expect(JSON.stringify(report)).not.toContain(INTERNAL);
    expect(endpoint.fetch).toHaveBeenCalledOnce();
  });

  it.each(['demo turn', 'demo Background route', 'hook edit', 'hook disable', 'new hook', 'new route', 'read deny', 'budget limit'] as const)('sends no hook input for %s', async (why) => {
    const run = runtime();
    const endpoint = await endpointFixture();
    if (why === 'read deny') run.setRules({ rules: [{ source: 'app', tool: 'notes.read', access: 'read', effect: 'deny', scope: { subtree: LANDING } }] });
    if (why === 'demo Background route') endpoint.routeTo(endpoint.demo);
    if (why === 'new hook') run.setHooks([]);
    const report = await createAgentSession({
      ...endpoint, harness: run.harness, profileId: why === 'demo turn' ? endpoint.demo.id : endpoint.foreground.id,
      ...(why === 'budget limit' ? { meter: createBudgetMeter({ maxTokens: 1 }) } : {}),
      decide: async ({ card }) => {
        if (why.startsWith('demo') || why === 'read deny') expect(card.steps[0]?.modelHooks).toBeUndefined();
        if (why === 'hook edit') run.setHooks([{ ...HOOK, prompt: 'A new instruction.' }]);
        if (why === 'hook disable') run.setHooks([{ ...HOOK, enabled: false }]);
        if (why === 'new hook') run.setHooks([HOOK]);
        if (why === 'new route') endpoint.routeTo(endpoint.foreground);
        return { action: 'approve' };
      },
    }).submitPlan('Add a note.', planWith());
    expect(endpoint.fetch).not.toHaveBeenCalled();
    expect(report.modelCalls).toBe(0);
    if (why === 'read deny') expect(run.written()).toBe(true);
  });

  it('rechecks a changed read boundary between model admission and provider send', async () => {
    const run = runtime();
    const endpoint = await endpointFixture();
    const gateway = {
      ...endpoint.gateway,
      complete: (request: ChatRequest, signal?: AbortSignal, beforeSend?: () => void) => endpoint.gateway.complete(request, signal, () => {
        run.setRules({ rules: [{ source: 'app', tool: '*', effect: 'deny', access: 'read', scope: { subtree: LANDING } }] });
        beforeSend?.();
      }),
    };
    const report = await createAgentSession({ ...endpoint, gateway, harness: run.harness, decide: async () => ({ action: 'approve' }) }).submitPlan('Add a note.', planWith());
    expect(endpoint.fetch).not.toHaveBeenCalled();
    expect(report.modelCalls).toBe(0);
  });

  it('counts the hook against the existing turn call bound', async () => {
    const run = runtime();
    run.setHooks([HOOK, { ...HOOK, id: 'second', name: 'Second viewpoint check' }]);
    const endpoint = await endpointFixture();
    const report = await createAgentSession({ ...endpoint, harness: run.harness, maxModelCalls: 1, decide: async () => ({ action: 'approve' }) }).submitPlan('Add a note.', planWith());
    expect(endpoint.fetch).toHaveBeenCalledOnce();
    expect(report).toMatchObject({ status: 'applied', modelCalls: 1, hooks: [{ hookId: 'second', decision: { action: 'warn' } }] });
  });

  it('shares pending and finished outcomes and leaves synchronous callers unchanged', async () => {
    const run = runtime();
    const complete = vi.fn(async () => ALLOW);
    const actor = { hooks: [HOOK], complete };
    const turn = { turnId: 'same-turn' };
    const first = run.harness.callWithHooks(CALL, turn, undefined, actor);
    const duplicate = run.harness.callWithHooks(CALL, turn, undefined, actor);
    const mismatch = run.harness.callWithHooks({ ...CALL, params: { doc: LANDING, text: 'Different prose.' } }, turn, undefined, actor);
    expect(await duplicate).toEqual(await first);
    expect(await mismatch).toMatchObject({ ok: false });
    expect(await run.harness.callWithHooks(CALL, turn, undefined, actor)).toEqual(await first);
    expect(run.harness.call({ ...CALL, callId: 'direct' }, { turnId: 'direct' }).ok).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
  });

  it.each(['stop', 'timeout'] as const)('bounds a non-cooperative before hook by %s without applying a fail-closed step', async (how) => {
    vi.useFakeTimers();
    try {
      const run = runtime();
      const hook = { ...HOOK, failClosed: true };
      run.setHooks([hook]);
      const stop = new AbortController();
      const complete = vi.fn((_messages: readonly ChatMessage[], _signal: AbortSignal) => new Promise<string>(() => {}));
      const pending = run.harness.callWithHooks(CALL, { turnId: 'cancel', signal: stop.signal }, undefined, { hooks: [hook], complete });
      await vi.advanceTimersByTimeAsync(0);
      expect(complete).toHaveBeenCalledOnce();
      if (how === 'stop') stop.abort();
      else await vi.advanceTimersByTimeAsync(MODEL_HOOK_TIMEOUT_MS);
      expect(await pending).toMatchObject({ ok: false });
      expect(complete.mock.calls[0]?.[1].aborted).toBe(true);
      expect(run.written()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
