/**
 * The run-limit reservation against a real endpoint profile (agent-harness §7.1, provider-gateway §3):
 * what `modelLimits` reports as `thinkingTokens` must be the excess the request's transmitted cap
 * carries over the base cap — the lift implicit thinking earns included — so a call is refused
 * exactly when its real worst case would pass the limit, never sent under-reserved.
 *
 * The gateway is real, over an in-memory profile store and a scripted fetch; no provider is reached.
 */

import { describe, expect, it } from 'vitest';

import {
  createGateway,
  createKeyStore,
  createManualClock,
  createMemoryVaultPort,
  createProfileStore,
  usageFor,
  type ChatRequest,
  type FetchLike,
  type Gateway,
  type GatewayTraceEvent,
  type NewProfile,
  type ProfileView,
  type TaskRole,
  type ThinkingLevel,
} from '@caotang/gateway';
import { addShotNode, addStoryboardFolder } from '@caotang/storyboard';
import { VIDEO_TEMPLATE_IDS } from '@caotang/video-prompt-pack';

import {
  createAgentPorts,
  createAgentSession,
  createBudgetMeter,
  createContextPort,
  createHarness,
  type BudgetMeter,
} from '../../src/index.js';
import { CHAPTER_ONE, OPENED, clock, makeState } from '../fixtures.js';

const KEY = 'test-key';

function chunk(delta: unknown, finish: string | null, usage?: unknown): string {
  return `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) })}\n\n`;
}

function sse(text: string, finish: string, usage: unknown): Response {
  const body = chunk({ role: 'assistant', content: text }, null) + chunk({}, finish, usage) + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** One streamed chat completion that answers the planner call with plain text. */
function sseDone(): Response {
  return sse('Done.', 'stop', { prompt_tokens: 10, completion_tokens: 5 });
}

/** One streamed chat completion whose JSON reply stops mid-object at the output limit. */
function sseCut(completionTokens: number): () => Response {
  return () => sse('{"reply": "cut', 'length', { prompt_tokens: 10, completion_tokens: completionTokens });
}

/** One streamed chat completion whose reply is one native tool call (wire name, `.` → `__`) with `args` as its raw arguments text. */
function sseCall(tool: string, args: string, finish: string, completionTokens = 5): () => Response {
  return () => {
    const call = { index: 0, id: 'call_1', type: 'function', function: { name: tool.replaceAll('.', '__'), arguments: args } };
    const body = chunk({ role: 'assistant', tool_calls: [call] }, null) + chunk({}, finish, { prompt_tokens: 10, completion_tokens: completionTokens }) + 'data: [DONE]\n\n';
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

/** One streamed chat completion carrying a complete planner reply. */
function sseJson(text: string): () => Response {
  return () => sse(text, 'stop', { prompt_tokens: 10, completion_tokens: 5 });
}

interface Endpoint {
  readonly gateway: Gateway;
  readonly profile: ProfileView;
  readonly requests: ChatRequest[];
  readonly calls: { readonly url: string; readonly body: Record<string, unknown> }[];
}

/** A real gateway over an in-memory store and one endpoint profile, with a fetch that records calls and answers from `queue` (then plain replies). */
async function endpoint(profile: NewProfile, queue: readonly (() => Response)[] = [], listed: readonly Record<string, unknown>[] = []): Promise<Endpoint> {
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const requests: ChatRequest[] = [];
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const responders = [...queue];
  const fetchStub: FetchLike = (url, init) => {
    if (init.method === 'GET') {
      return Promise.resolve(new Response(JSON.stringify({ data: [...listed] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const next = responders.shift();
    return Promise.resolve(next === undefined ? sseDone() : next());
  };
  const gateway = createGateway({
    profiles,
    keys,
    clock: createManualClock(0),
    fetch: fetchStub,
    observe: (event: GatewayTraceEvent) => {
      if (event.type === 'request') requests.push(event.req);
    },
  });
  const view = await profiles.create(profile);
  return { gateway, profile: view, requests, calls };
}

/** A real gateway over an in-memory store, one DeepSeek endpoint profile, and a fetch that records and answers. */
async function deepSeekEndpoint(maxOutputTokens?: number): Promise<Endpoint> {
  return endpoint({
    name: 'DeepSeek',
    kind: 'endpoint',
    preset: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: KEY,
    defaultModel: 'deepseek-v4-pro',
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  });
}

/** A real gateway over an in-memory store, one Alibaba qwen3.8-flash endpoint (a reasoning_effort row: JSON wire, no tool declarations), whose listing advertises a 65,536 output cap. */
async function alibabaEndpoint(queue: readonly (() => Response)[] = []): Promise<Endpoint> {
  return endpoint(
    {
      name: 'Qwen',
      kind: 'endpoint',
      preset: 'alibaba',
      fields: { workspaceId: 'ws', region: 'ap-southeast-1' },
      baseUrl: 'https://ws.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      apiKey: KEY,
      defaultModel: 'qwen3.8-flash',
    },
    queue,
    [{ id: 'qwen3.8-flash', max_output_tokens: 65_536 }],
  );
}

interface Session {
  readonly session: ReturnType<typeof createAgentSession>;
  readonly meter: BudgetMeter;
}

async function sessionFor(gateway: Gateway, profile: ProfileView, options: { maxTokens?: number; thinking?: ThinkingLevel } = {}): Promise<Session> {
  const state = makeState();
  const meter = createBudgetMeter(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }, { clock: createManualClock(1_000_000) });
  const session = createAgentSession({
    harness: createHarness({ state, ports: createAgentPorts(), clock: clock.now }),
    gateway,
    context: createContextPort({ state }),
    decide: async () => ({ action: 'approve' }),
    emit: () => undefined,
    meter,
    profileId: profile.id,
    model: profile.defaultModel,
    ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
    sessionId: 'gb',
  });
  return { session, meter };
}

/** The prompt estimate `reserveCall` makes for the first planner request, read off the traced request. */
function promptOf(requests: readonly ChatRequest[]): number {
  const first = requests[0];
  if (first === undefined) throw new Error('no model request was traced');
  return usageFor(first.messages, '').promptTokens;
}

/** The output cap the first sent body carried (`max_tokens` on the Chat Completions wire). */
function transmittedOf(calls: readonly { body: Record<string, unknown> }[]): number {
  const body = calls[0]?.body;
  const cap = body?.max_tokens ?? body?.maxTokens;
  if (typeof cap !== 'number') throw new Error('no max_tokens on the first request body');
  return cap;
}

describe('the reservation covers the cap actually transmitted (agent-harness §7.1)', () => {
  it('reserves the lifted cap implicit thinking earns: a limit between the base and the transmitted cap refuses before send', async () => {
    const ep = await deepSeekEndpoint();
    // First, unbounded: the call goes out and the trace shows what it carried and what its prompt estimated to.
    const open = await sessionFor(ep.gateway, ep.profile);
    await open.session.submit('Say hello.');
    const prompt = promptOf(ep.requests);
    // DeepSeek's row thinks at the provider default: the request went out at the 16,384 floor, not 4,096.
    expect(transmittedOf(ep.calls)).toBe(16_384);
    const sent = ep.calls.length;

    // A fresh identical session whose limit admits the base cap plus a little, but not the transmitted one.
    const limited = await sessionFor(ep.gateway, ep.profile, { maxTokens: prompt + 5_000 });
    const report = await limited.session.submit('Say hello.');

    expect(report.status).toBe('failed');
    expect(report.modelCalls).toBe(0);
    expect(report.budgetStop).toMatchObject({ dimension: 'tokens', limit: prompt + 5_000 });
    // Nothing spent yet: the reservation named the prompt plus the transmitted cap, not the base 4,096.
    expect(report.budgetStop?.needed).toBe(prompt + 16_384);
    // And the refused call never reached the wire.
    expect(ep.calls).toHaveLength(sent);
  });

  it('reserves the profile’s own cap when it is set: an explicit level does not inflate it by a nominal share', async () => {
    const ep = await deepSeekEndpoint(2_000);
    const open = await sessionFor(ep.gateway, ep.profile, { thinking: 'high' });
    await open.session.submit('Say hello.');
    const prompt = promptOf(ep.requests);
    // The profile cap is not the default: the transmitted cap stays 2,000 however thinking settles.
    expect(transmittedOf(ep.calls)).toBe(2_000);
    const sent = ep.calls.length;

    // prompt + 2,500 admits the real worst case (prompt + 2,000) but not a reservation that added the
    // level's nominal 16,384 on top: the call must go out.
    const limited = await sessionFor(ep.gateway, ep.profile, { maxTokens: prompt + 2_500, thinking: 'high' });
    const report = await limited.session.submit('Say hello.');

    expect(report.budgetStop).toBeUndefined();
    expect(ep.calls.length).toBeGreaterThan(sent);
  });

  it('a retry after a cut never asks for less than the cap the cut reply went out with', async () => {
    // qwen3.8-flash is a reasoning_effort row: implicit thinking lifts the default cap to the 16,384 floor, and the
    // listing's 65,536 is the advertised maximum a cut reply may retry toward.
    const ep = await alibabaEndpoint([sseCut(9_000), sseJson('{"reply": "Done."}')]);
    // The advertised cap is read from what listModels last reported; the session itself never lists.
    await ep.gateway.listModels(ep.profile.id);
    const { session } = await sessionFor(ep.gateway, ep.profile);
    await session.submit('Say hello.');

    const first = ep.calls[0]?.body['max_tokens'] ?? ep.calls[0]?.body['maxTokens'];
    expect(first).toBe(16_384);
    // The cut reply reported 9,000 completion tokens: past the 4,096 base cap, short of the 16,384 sent. Read against
    // the transmitted cap it did not reach the limit, so the retry re-sends the same lifted cap — never the 8,192
    // (base cap × 2) the base-cap comparison raised it to, which would have shrunk what goes out.
    expect(ep.calls).toHaveLength(2);
    const retry = ep.calls[1]?.body['max_tokens'] ?? ep.calls[1]?.body['maxTokens'];
    expect(retry).toBeGreaterThanOrEqual(first as number);
  });

  it('a reply cut at the transmitted cap still earns its one raised retry, never a smaller one', async () => {
    const ep = await alibabaEndpoint([sseCut(20_000), sseJson('{"reply": "Done."}')]);
    await ep.gateway.listModels(ep.profile.id);
    const { session } = await sessionFor(ep.gateway, ep.profile);
    await session.submit('Say hello.');

    const first = ep.calls[0]?.body['max_tokens'] ?? ep.calls[0]?.body['maxTokens'];
    expect(first).toBe(16_384);
    // 20,000 reported tokens reached the 16,384 sent, so the retry asks for twice it — held to the advertised 65,536.
    expect(ep.calls).toHaveLength(2);
    const retry = ep.calls[1]?.body['max_tokens'] ?? ep.calls[1]?.body['maxTokens'];
    expect(retry).toBe(32_768);
    expect(retry as number).toBeGreaterThan(first as number);
  });
});

const BOARD = 'n_SBOARD0001';
const SHOT = 'n_SHOTONE001';
const VENDOR = VIDEO_TEMPLATE_IDS[0] as string;

/** A session pinned to `profileId` under the chat role, over a project with one storyboard shot for `prompt.draft` to draft. */
function boardSession(gateway: Gateway, profileId: string): Parameters<typeof createAgentSession>[0] {
  const state = makeState();
  addStoryboardFolder(state, { parentId: CHAPTER_ONE, title: 'Lamp Shots', now: OPENED, id: BOARD });
  addShotNode(state, { parentId: BOARD, title: 'The lamp fails', stored: { action: 'The lamp fails.' }, now: OPENED, id: SHOT });
  return {
    harness: createHarness({ state, ports: createAgentPorts(), clock: clock.now }),
    gateway,
    context: createContextPort({ state }),
    decide: async () => ({ action: 'approve' }),
    emit: () => undefined,
    profileId,
    role: 'chat',
    sessionId: 'gb-board',
  };
}

/**
 * A real gateway with two endpoint profiles and a role resolver: an active generic endpoint (no thinking row, so its
 * transmitted cap is the 4,096 default) and a DeepSeek profile (provider-default thinking, 16,384 on the wire) that `routes`
 * names for the roles it lists. Both share the recording fetch, which answers from `queue` and then plain replies.
 */
async function routedEndpoints(routes: readonly TaskRole[], queue: readonly (() => Response)[] = []) {
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const requests: ChatRequest[] = [];
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const responders = [...queue];
  const ids: { deepseek?: string } = {};
  const fetchStub: FetchLike = (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const next = responders.shift();
    return Promise.resolve(next === undefined ? sseDone() : next());
  };
  const gateway = createGateway({
    profiles,
    keys,
    clock: createManualClock(0),
    fetch: fetchStub,
    roles: {
      resolve: (role) => (routes.includes(role) && ids.deepseek !== undefined ? { profileId: ids.deepseek } : undefined),
      allowed: (role) => (routes.includes(role) && ids.deepseek !== undefined ? [ids.deepseek] : []),
    },
    observe: (event: GatewayTraceEvent) => {
      if (event.type === 'request') requests.push(event.req);
    },
  });
  const generic = await profiles.create({ name: 'Generic', kind: 'endpoint', preset: 'generic', baseUrl: 'https://llm.example/v1', apiKey: KEY, defaultModel: 'house-model' });
  const deepseek = await profiles.create({ name: 'DeepSeek', kind: 'endpoint', preset: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: KEY, defaultModel: 'deepseek-v4-pro' });
  ids.deepseek = deepseek.id;
  return { gateway, generic, deepseek, requests, calls };
}

describe('a role-routed call is reserved on the route it is sent through (agent-harness §7.1, provider-gateway §6)', () => {
  it('a planner call the session role routes is reserved at the role profile’s transmitted cap, not the active profile’s', async () => {
    const ep = await routedEndpoints(['chat']);
    const state = makeState();
    const open = createAgentSession({
      harness: createHarness({ state, ports: createAgentPorts(), clock: clock.now }),
      gateway: ep.gateway,
      context: createContextPort({ state }),
      decide: async () => ({ action: 'approve' }),
      emit: () => undefined,
      role: 'chat',
      sessionId: 'gb-role-open',
    });
    await open.submit('Say hello.');
    // No pin: the chat role sent the call to DeepSeek, at the lifted 16,384 — not the generic profile's 4,096.
    expect(ep.calls[0]?.url).toBe('https://api.deepseek.com/chat/completions');
    expect(transmittedOf(ep.calls)).toBe(16_384);
    const prompt = promptOf(ep.requests);
    const sent = ep.calls.length;

    const meter = createBudgetMeter({ maxTokens: prompt + 5_000 }, { clock: createManualClock(1_000_000) });
    const limited = createAgentSession({
      harness: createHarness({ state, ports: createAgentPorts(), clock: clock.now }),
      gateway: ep.gateway,
      context: createContextPort({ state }),
      decide: async () => ({ action: 'approve' }),
      emit: () => undefined,
      meter,
      role: 'chat',
      sessionId: 'gb-role-limited',
    });
    const report = await limited.submit('Say hello.');

    // Reserved against the active generic profile, prompt + 4,096 would have fit and the call gone out at 16,384.
    expect(report.status).toBe('failed');
    expect(report.modelCalls).toBe(0);
    expect(report.budgetStop).toMatchObject({ dimension: 'tokens', limit: prompt + 5_000, needed: prompt + 16_384 });
    expect(ep.calls).toHaveLength(sent);
  });

  it('a drafting call under another role than the session’s is reserved on the drafting route, not the session’s pinned profile', async () => {
    const plan = sseCall('prompt.draft', JSON.stringify({ shots: [SHOT], vendor: VENDOR, instruction: 'Keep it moody.' }), 'tool_calls');
    const draft = JSON.stringify({ camera: 'Slow dolly in.', subject: 'The lamp', action: 'The lamp fails.' });

    // Unbounded first: the planner goes to the pinned generic profile, the prompt-pack's drafting call to DeepSeek.
    const open = await routedEndpoints(['drafting'], [plan, sseJson(draft)]);
    const unbounded = createAgentSession(boardSession(open.gateway, open.generic.id));
    await unbounded.submit('Draft the prompt for the lamp shot.', { preload: ['prompt.draft'] });
    expect(open.calls[0]?.url).toBe('https://llm.example/v1/chat/completions');
    expect(transmittedOf(open.calls)).toBe(4_096);
    expect(open.requests[1]?.role).toBe('drafting');
    expect(open.calls[1]?.url).toBe('https://api.deepseek.com/chat/completions');
    expect(open.calls[1]?.body['max_tokens']).toBe(16_384);
    const plannerPrompt = promptOf(open.requests);
    const draftPrompt = usageFor((open.requests[1] as ChatRequest).messages, '').promptTokens;

    // A limit one token short of the drafting call at the 16,384 its route transmits, after the planner's call settled at its
    // reported 15 tokens. It admits the planner's reservation, and a drafting call reserved at the session profile's 4,096.
    const limit = 15 + draftPrompt + 16_384 - 1;
    expect(limit).toBeGreaterThanOrEqual(plannerPrompt + 4_096);
    const ep = await routedEndpoints(['drafting'], [plan, sseJson(draft)]);
    const meter = createBudgetMeter({ maxTokens: limit }, { clock: createManualClock(1_000_000) });
    await createAgentSession({ ...boardSession(ep.gateway, ep.generic.id), meter }).submit('Draft the prompt for the lamp shot.', { preload: ['prompt.draft'] });

    // The drafting call was refused before it was sent, at the drafting route's transmitted cap: the planner is told so.
    expect(ep.calls.map((call) => call.url)).not.toContain('https://api.deepseek.com/chat/completions');
    expect(ep.requests.map((request) => request.role)).not.toContain('drafting');
    const refusal = JSON.stringify(ep.requests[1]?.messages.at(-1)?.content);
    expect(refusal).toContain(`could use up to ${15 + draftPrompt + 16_384} tokens in all, past the run’s limit of ${limit}`);
  });
});

/** The F7 shape: a budget route (qwen3.7-flash, enable_thinking + budget) at a set level, whose listing advertises 65,536. */
async function budgetRouteEndpoint(queue: readonly (() => Response)[]): Promise<Endpoint> {
  return endpoint(
    {
      name: 'Qwen budget',
      kind: 'endpoint',
      preset: 'alibaba',
      fields: { workspaceId: 'ws', region: 'ap-southeast-1' },
      baseUrl: 'https://ws.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      apiKey: KEY,
      defaultModel: 'qwen3.7-flash',
    },
    queue,
    [{ id: 'qwen3.7-flash', max_output_tokens: 65_536 }],
  );
}

describe('a cut reply’s retry on a budget route (agent-harness §2, "A planner reply the provider cut")', () => {
  it('sends twice the transmitted cap, with the thinking budget counted once', async () => {
    const ep = await budgetRouteEndpoint([sseCall('doc.read', '{"doc": "The Fri', 'length', 6_000)]);
    await ep.gateway.listModels(ep.profile.id);
    const { session } = await sessionFor(ep.gateway, ep.profile, { thinking: 'low' });
    await session.submit('Say hello.');

    // The first request: the 4,096 default plus the low level's 1,024 budget.
    expect(ep.calls[0]?.body['max_tokens']).toBe(5_120);
    // 6,000 reported tokens reached it, so the retry goes out at twice 5,120 — not 10,240 plus another 1,024 of budget.
    expect(ep.calls).toHaveLength(2);
    expect(ep.calls[1]?.body['max_tokens']).toBe(10_240);
  });

  it('holds the retry to the advertised cap on the wire, budget included', async () => {
    const ep = await endpoint(
      {
        name: 'Qwen budget',
        kind: 'endpoint',
        preset: 'alibaba',
        fields: { workspaceId: 'ws', region: 'ap-southeast-1' },
        baseUrl: 'https://ws.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
        apiKey: KEY,
        defaultModel: 'qwen3.7-flash',
      },
      [sseCall('doc.read', '{"doc": "The Fri', 'length', 30_000)],
      [{ id: 'qwen3.7-flash', max_output_tokens: 24_000 }],
    );
    await ep.gateway.listModels(ep.profile.id);
    const { session } = await sessionFor(ep.gateway, ep.profile, { thinking: 'high' });
    await session.submit('Say hello.');

    // 4,096 + the high level's 16,384 = 20,480 transmitted, under the advertised 24,000.
    expect(ep.calls[0]?.body['max_tokens']).toBe(20_480);
    // Twice that passes 24,000, so the retry's transmitted cap is the advertised one — never 24,000 plus the budget.
    expect(ep.calls).toHaveLength(2);
    expect(ep.calls[1]?.body['max_tokens']).toBe(24_000);
  });
});
