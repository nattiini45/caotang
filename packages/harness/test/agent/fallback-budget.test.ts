/**
 * A route's fallbacks and the turn's budget (agent-harness §7.1, provider-gateway §6): a bounded call must not spend against only
 * the primary's reservation. Before a fallback's request opens, the attempt that just ended is counted as spend and the next
 * destination's own worst case — its output cap and its price — takes the call's place; a destination whose worst case passes a cap
 * is refused there, before anything is sent to it.
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

const chunk = (delta: object, finish: string | null, usage?: object): string =>
  `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) })}\n\n`;

const answer = (): Response =>
  new Response(chunk({ role: 'assistant', content: 'Answered by the fallback.' }, null) + chunk({}, 'stop', { prompt_tokens: 30, completion_tokens: 6 }) + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

const limited = (): Response => new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429, headers: { 'content-type': 'application/json' } });

interface Route {
  readonly gateway: Gateway;
  readonly primary: ProfileView;
  readonly fallback: ProfileView;
  /** Every request body that reached a profile, in order, with the host it went to. */
  readonly calls: { readonly host: string; readonly body: Record<string, unknown> }[];
}

/** A gateway whose chat role is `primary` with `fallback` behind it, over two priced endpoint profiles. */
async function routed(primary: NewProfile, fallback: NewProfile, replies: (() => Response)[]): Promise<Route> {
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const calls: { host: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    calls.push({ host: new URL(String(url)).host, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return (replies.shift() ?? answer)();
  });
  const primaryView = await profiles.create(primary);
  const fallbackView = await profiles.create(fallback);
  const gateway = createGateway({
    profiles,
    keys,
    clock: createManualClock(0),
    fetch,
    retry: { maxRetries: 0, delaysMs: [0], jitter: 0 },
    roles: {
      resolve: (role) => (role === 'chat' ? { profileId: primaryView.id, model: primaryView.defaultModel, fallbacks: [{ profileId: fallbackView.id }] } : undefined),
      allowed: () => [primaryView.id, fallbackView.id],
    },
  });
  return { gateway, primary: primaryView, fallback: fallbackView, calls };
}

async function sessionFor(gateway: Gateway, limits: Parameters<typeof createBudgetMeter>[0]): Promise<{ session: ReturnType<typeof createAgentSession>; meter: BudgetMeter }> {
  const meter = createBudgetMeter(limits, { clock: createManualClock(1_000_000) });
  const state = makeState();
  return {
    session: createAgentSession({
      harness: createHarness({ state, ports: createAgentPorts(), clock: clock.now }),
      gateway,
      context: createContextPort({ state }),
      decide: async () => ({ action: 'approve' }),
      emit: () => undefined,
      meter,
      role: 'chat',
      sessionId: 'fallback-budget',
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

describe('a fallback is admitted on its own worst case (provider-gateway §6)', () => {
  it('reserves and sends the fallback at its own, tighter cap, with the primary’s attempt counted as spend', async () => {
    // The fallback's row sends a much smaller cap than the primary's, so its reservation is the smaller of the two.
    const route = await routed(endpoint('Primary', 'a.example', { prompt: 0.01, completion: 0.01 }, 16_384), endpoint('Second', 'b.example', { prompt: 0.01, completion: 0.01 }, 2_048), [limited, answer]);
    const { session, meter } = await sessionFor(route.gateway, {});

    const report = await session.submit('Say hello.');
    expect(report.status).toBe('replied');
    // The move happened, and the fallback's own cap went out on the wire rather than the primary's.
    expect(route.calls.map((call) => call.host)).toEqual(['a.example', 'b.example']);
    expect(route.calls[1]?.body['max_tokens']).toBe(2_048);
    // Both attempts are spend: the fallback answered with 30 prompt tokens, so anything past that is the prompt the primary was
    // sent before the route moved. One model call, and one admission per destination.
    expect(meter.spend().modelCalls).toBe(1);
    expect(meter.spend().promptTokens).toBeGreaterThan(1_000);
  });

  it('refuses the fallback before it is sent when its own price would pass the turn’s cost limit', async () => {
    // The primary is cheap enough for the limit; the fallback costs a hundred times more per token.
    const route = await routed(endpoint('Primary', 'a.example', { prompt: 0.001, completion: 0.001 }, 4_096), endpoint('Second', 'b.example', { prompt: 1, completion: 1 }, 4_096), [limited, answer]);
    const { session } = await sessionFor(route.gateway, { maxCostUsd: 0.5 });

    const report = await session.submit('Say hello.');
    expect(report.status).toBe('failed');
    expect(report.budgetStop).toMatchObject({ dimension: 'cost' });
    // The fallback was never sent to: the refusal landed at the route's admission, not at its send.
    expect(route.calls.map((call) => call.host)).toEqual(['a.example']);
    expect(report.modelCalls).toBe(1);
  });
});
