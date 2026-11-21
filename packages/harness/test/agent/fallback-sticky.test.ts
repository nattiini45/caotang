/**
 * A role's fallback sticks within one turn (agent-harness §7.1, provider-gateway §6): once a turn's request under a role has moved to
 * a fallback, that role's later requests in the same turn start there — the answer it gave is not abandoned one call later, and a
 * destination that fails again leaves the rest of the route behind it. The turn is the memory's whole life: the next turn starts at
 * the role's primary again, a route the writer changed mid-turn wins over the memory, and a remembered destination is admitted on its
 * own worst case exactly as it is when the route moves there.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createGateway,
  createKeyStore,
  createManualClock,
  createMemoryVaultPort,
  createProfileStore,
  type FetchLike,
  type Gateway,
  type NewProfile,
  type ProfileView,
  type RoleTarget,
} from '@caotang/gateway';

import {
  createAgentPorts,
  createAgentSession,
  createBudgetMeter,
  createContextPort,
  createHarness,
  type BudgetMeter,
} from '../../src/index.js';
import { clock, makeState, STORM } from '../fixtures.js';

const KEY = 'test-key';

const chunk = (delta: object, finish: string | null, usage?: object): string =>
  `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) })}\n\n`;

const sse = (body: string): Response => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

/** A planner reply that ends the turn: the route answered in words. */
const answering = (text: string, promptTokens = 30) => (): Response =>
  sse(chunk({ role: 'assistant', content: JSON.stringify({ reply: text }) }, null) + chunk({}, 'stop', { prompt_tokens: promptTokens, completion_tokens: 6 }) + 'data: [DONE]\n\n');

/** A planner reply that reads one document, which makes the turn ask again with what it read. */
const reading = (doc: string, promptTokens = 30) => (): Response =>
  sse(chunk({ role: 'assistant', content: JSON.stringify({ steps: [{ tool: 'doc.read', params: { doc }, expect: 'The document is read' }] }) }, null) + chunk({}, 'stop', { prompt_tokens: promptTokens, completion_tokens: 6 }) + 'data: [DONE]\n\n');

const limited = (): Response => new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429, headers: { 'content-type': 'application/json' } });

interface Route {
  readonly gateway: Gateway;
  readonly primary: ProfileView;
  readonly fallback: ProfileView;
  /** Replaces the chat role's route, the way editing the role's settings would while a turn runs. */
  setRoute(next: { profileId: string; model?: string; fallbacks?: readonly RoleTarget[] }): void;
  /** Every request body that reached a profile, in order, with the host it went to. */
  readonly calls: { readonly host: string; readonly body: Record<string, unknown> }[];
}

/** A gateway whose chat role is `primary` with `fallback` behind it, over two priced endpoint profiles. */
async function routed(primary: NewProfile, fallback: NewProfile, replies: (() => Response)[], onCall?: (index: number, route: Route) => void): Promise<Route> {
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const calls: { host: string; body: Record<string, unknown> }[] = [];
  let current: { profileId: string; model?: string; fallbacks?: readonly RoleTarget[] };
  const route = {} as Route;
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    calls.push({ host: new URL(String(url)).host, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    onCall?.(calls.length - 1, route);
    return (replies.shift() ?? answering('Answered.'))();
  });
  const primaryView = await profiles.create(primary);
  const fallbackView = await profiles.create(fallback);
  current = { profileId: primaryView.id, model: primaryView.defaultModel, fallbacks: [{ profileId: fallbackView.id }] };
  const gateway = createGateway({
    profiles,
    keys,
    clock: createManualClock(0),
    fetch,
    retry: { maxRetries: 0, delaysMs: [0], jitter: 0 },
    roles: {
      resolve: (role) => (role === 'chat' ? current : undefined),
      allowed: () => [primaryView.id, fallbackView.id],
    },
  });
  return Object.assign(route, { gateway, primary: primaryView, fallback: fallbackView, calls, setRoute: (next: Parameters<Route['setRoute']>[0]) => { current = next; } });
}

async function sessionFor(base: Gateway, limits: Parameters<typeof createBudgetMeter>[0] = {}): Promise<{ session: ReturnType<typeof createAgentSession>; meter: BudgetMeter }> {
  const meter = createBudgetMeter(limits, { clock: createManualClock(1_000_000) });
  const state = makeState();
  // The planner answers in the JSON plan here rather than on the wire: the sticky rule is the same either way, and a scripted plan is
  // what makes a turn ask a second question.
  const gateway: Gateway = { ...base, modelCaps: (...args: Parameters<typeof base.modelCaps>) => ({ ...base.modelCaps(...args), tools: false }) };
  return {
    session: createAgentSession({
      harness: createHarness({ state, ports: createAgentPorts(), clock: clock.now }),
      gateway,
      context: createContextPort({ state }),
      decide: async () => ({ action: 'approve' }),
      emit: () => undefined,
      meter,
      role: 'chat',
      sessionId: 'fallback-sticky',
    }),
    meter,
  };
}

const endpoint = (name: string, host: string, price: { prompt: number; completion: number }, maxOutputTokens: number): NewProfile => ({
  name,
  kind: 'endpoint',
  preset: 'generic',
  baseUrl: `https://${host}/v1`,
  apiKey: KEY,
  defaultModel: `${name}-model`,
  maxOutputTokens,
  pricePer1k: price,
});

const hostsOf = (route: Route): string[] => route.calls.map((call) => call.host);

describe('a fallback sticks within one turn (provider-gateway §6)', () => {
  it('starts the turn’s later requests at the fallback that answered, without trying the primary again', async () => {
    // One turn, three requests: the primary is rate-limited, the fallback's reply is cut off at its cap, so the turn asks again. That
    // third request must start at the fallback — the provider that just answered it — rather than going back to the failing primary.
    const route = await routed(endpoint('Primary', 'a.example', { prompt: 0.01, completion: 0.01 }, 4_096), endpoint('Second', 'b.example', { prompt: 0.01, completion: 0.01 }, 2_048), [limited, reading(STORM), answering('Answered by the fallback.')]);
    const { session } = await sessionFor(route.gateway);

    const report = await session.submit('Say hello.');
    expect(report.status).toBe('replied');
    expect(hostsOf(route)).toEqual(['a.example', 'b.example', 'b.example']);
  });

  it('starts the next turn at the role’s primary again', async () => {
    // The memory is the turn's, so the turn after it resolves the route from the top: a primary that answers again is used again.
    const route = await routed(endpoint('Primary', 'a.example', { prompt: 0.01, completion: 0.01 }, 4_096), endpoint('Second', 'b.example', { prompt: 0.01, completion: 0.01 }, 2_048), [limited, answering('Answered by the fallback.'), answering('Answered by the primary.')]);
    const { session } = await sessionFor(route.gateway);

    expect((await session.submit('Say hello.')).status).toBe('replied');
    expect((await session.submit('Say hello again.')).status).toBe('replied');
    expect(hostsOf(route)).toEqual(['a.example', 'b.example', 'a.example']);
  });

  it('follows the route the writer has now when the remembered destination is gone from it', async () => {
    // The writer empties the role's fallback list while the turn runs: the remembered destination is no longer part of the route, so
    // the turn's next request starts at the role's primary, and nothing is sent to the profile it dropped.
    const route = await routed(
      endpoint('Primary', 'a.example', { prompt: 0.01, completion: 0.01 }, 4_096),
      endpoint('Second', 'b.example', { prompt: 0.01, completion: 0.01 }, 2_048),
      [limited, reading(STORM), answering('Answered by the primary.')],
      (index, state) => { if (index === 1) state.setRoute({ profileId: state.primary.id, model: state.primary.defaultModel }); },
    );
    const { session } = await sessionFor(route.gateway);

    const report = await session.submit('Say hello.');
    expect(report.status).toBe('replied');
    expect(hostsOf(route)).toEqual(['a.example', 'b.example', 'a.example']);
  });

  it('admits a request that starts at the remembered fallback on that fallback’s own worst case', async () => {
    // The fallback is far more expensive per token than the primary. Once the turn's spend is nearly at its limit, the fallback's own
    // worst case passes the limit and the request is refused before it is sent; sized against the primary instead, it would have been
    // sent, so the refusal is the proof the opening reservation followed the memory.
    const route = await routed(endpoint('Primary', 'a.example', { prompt: 0.0001, completion: 0.0001 }, 4_096), endpoint('Second', 'b.example', { prompt: 0.05, completion: 0.05 }, 2_048), [limited, reading(STORM, 4_000), answering('never sent')]);
    const { session } = await sessionFor(route.gateway, { maxCostUsd: 0.4 });

    const report = await session.submit('Say hello.');
    expect(report.status).toBe('failed');
    expect(report.budgetStop).toMatchObject({ dimension: 'cost' });
    // The fallback answered once, and the refused request never reached it.
    expect(hostsOf(route)).toEqual(['a.example', 'b.example']);
  });
});
