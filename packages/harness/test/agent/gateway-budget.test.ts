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
  type ThinkingLevel,
} from '@caotang/gateway';

import {
  createAgentPorts,
  createAgentSession,
  createBudgetMeter,
  createContextPort,
  createHarness,
  type BudgetMeter,
} from '../../src/index.js';
import { clock, makeState } from '../fixtures.js';

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
