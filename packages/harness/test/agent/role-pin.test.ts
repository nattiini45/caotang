/**
 * A session pin and a role's ordered fallbacks (provider-gateway §6): the app pins each turn to the Chat role's resolved profile,
 * so before fallbacks existed every agent call named its profile. A pin that is exactly the role's own primary is now left off the
 * request — the route resolves it to the same profile — which is what lets the writer's authorised fallbacks answer. A pin that
 * names anything else keeps naming it: a turn on another profile, or one whose role changed under it, is sent there alone.
 */

import { describe, expect, it } from 'vitest';
import {
  createGateway,
  createKeyStore,
  createManualClock,
  createMemoryVaultPort,
  createProfileStore,
  type ChatRequest,
  type GatewayTraceEvent,
} from '@caotang/gateway';

import { createAgentPorts, createAgentSession, createContextPort, createHarness } from '../../src/index.js';
import { clock, makeState } from '../fixtures.js';

const KEY = 'test-key';

function sseDone(): Response {
  const body = `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A gateway whose role route is `primary`, over one endpoint profile, recording every request the agent loop sent. */
async function routed(): Promise<{ gateway: ReturnType<typeof createGateway>; profileId: string; requests: ChatRequest[] }> {
  const keys = createKeyStore(createMemoryVaultPort());
  const profiles = createProfileStore({ keys });
  const profile = await profiles.create({
    name: 'Primary', kind: 'endpoint', baseUrl: 'https://a.example/v1', apiKey: KEY, defaultModel: 'model-x', isActive: true,
  });
  const requests: ChatRequest[] = [];
  const gateway = createGateway({
    profiles,
    keys,
    clock: createManualClock(0),
    fetch: () => Promise.resolve(sseDone()),
    roles: { resolve: (role) => (role === 'chat' ? { profileId: profile.id, model: 'model-x' } : undefined), allowed: () => [profile.id] },
    observe: (event: GatewayTraceEvent) => {
      if (event.type === 'request') requests.push(event.req);
    },
  });
  return { gateway, profileId: profile.id, requests };
}

async function say(gateway: ReturnType<typeof createGateway>, pins: { profileId?: string; model?: string }): Promise<void> {
  const state = makeState();
  const session = createAgentSession({
    harness: createHarness({ state, ports: createAgentPorts(), clock: clock.now }),
    gateway,
    context: createContextPort({ state }),
    decide: async () => ({ action: 'approve' }),
    emit: () => undefined,
    role: 'chat',
    ...pins,
    sessionId: 'pin-route',
  });
  await session.submit('Say hello.');
}

describe('a session pin against the chat role’s primary (provider-gateway §6)', () => {
  it('leaves a pin that is the role’s own primary off the request, so the route decides', async () => {
    const { gateway, profileId, requests } = await routed();
    await say(gateway, { profileId, model: 'model-x' });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]?.profileId).toBeUndefined();
    expect(requests[0]?.role).toBe('chat');
  });

  it('keeps a pin that names another profile, which is sent there alone', async () => {
    const { gateway, requests } = await routed();
    await say(gateway, { profileId: 'prv_other', model: 'model-x' });
    // The role refuses a profile outside its allow-set, which is the same refusal a pinned turn always got.
    expect(requests).toHaveLength(0);
  });

  it('keeps a pin that names another model of the primary profile', async () => {
    const { gateway, profileId, requests } = await routed();
    await say(gateway, { profileId, model: 'model-other' });
    expect(requests[0]?.profileId).toBe(profileId);
    expect(requests[0]?.model).toBe('model-other');
  });
});
