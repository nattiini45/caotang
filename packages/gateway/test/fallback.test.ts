/**
 * complete()'s ordered fallbacks (provider-gateway §6): a role's requests try its primary, then the profiles the writer listed
 * for that role, in order. A target is left only for a fault another provider may not share, only before any output reached the
 * caller, and only to a profile the role's allow-set names. Everything else — a pinned request, an authorisation failure, a
 * partial answer, a cancelled turn — behaves exactly as it did before the list existed.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createGateway,
  createKeyStore,
  createManualClock,
  createMemoryVaultPort,
  createProfileStore,
  EgressDeniedError,
  type GatewayTraceEvent,
} from '../src/index.js';
import type { RoleResolver, RoleTarget, TaskRole } from '../src/types.js';
import {
  addEndpoint,
  collect,
  delta,
  deltasOf,
  finish,
  microtaskSubtle,
  ScriptedFetch,
  sseResponse,
  START,
  userMessage,
  KEY,
} from './helpers.js';

interface FallbackHarness {
  readonly clock: ReturnType<typeof createManualClock>;
  readonly profiles: ReturnType<typeof createProfileStore>;
  readonly keys: ReturnType<typeof createKeyStore>;
  readonly net: ScriptedFetch;
  readonly gateway: ReturnType<typeof createGateway>;
}

/**
 * A gateway whose resolver answers from `route`, so a test can change it between a request's resolution and its send. Retries are
 * off: the transport's own two retries are the spec's, and they are tested where they live. What is tested here is what happens
 * once they have run out.
 */
function fallbackHarness(
  route: () => { readonly profileId: string; readonly model?: string; readonly fallbacks?: readonly RoleTarget[] } | undefined,
  options: { net?: ScriptedFetch; observe?: (event: GatewayTraceEvent) => void; allowed?: () => readonly string[] } = {},
): FallbackHarness {
  const clock = createManualClock(START);
  const keys = createKeyStore(createMemoryVaultPort(), { subtle: microtaskSubtle() });
  const profiles = createProfileStore({ keys });
  const net = options.net ?? new ScriptedFetch();
  const roles: RoleResolver = {
    resolve: (role: TaskRole) => (role === 'chat' ? route() : undefined),
    allowed: () => options.allowed?.() ?? [route()?.profileId ?? '', ...(route()?.fallbacks ?? []).map((entry) => entry.profileId)],
  };
  const gateway = createGateway({
    profiles,
    keys,
    clock,
    fetch: net.fn,
    random: () => 0.5,
    roles,
    retry: { maxRetries: 0, delaysMs: [0], jitter: 0 },
    ...(options.observe === undefined ? {} : { observe: options.observe }),
  });
  return { clock, profiles, keys, net, gateway };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The two profiles a routed request can reach: the role's primary, then the one the writer listed. */
async function pair(h: FallbackHarness): Promise<{ primary: string; fallback: string }> {
  const primary = await addEndpoint(h);
  const fallback = await addEndpoint(h, { name: 'Second', baseUrl: 'https://b.example/v1', apiKey: `${KEY}b` });
  return { primary: primary.id, fallback: fallback.id };
}

const hostsOf = (net: ScriptedFetch): string[] => net.calls.map((call) => new URL(call.url).host);

describe('complete() — ordered role fallbacks (provider-gateway §6)', () => {
  it('sends the same request to the next authorised profile after the primary is rate-limited', async () => {
    const net = new ScriptedFetch()
      .push(() => json(429, { error: { message: 'slow down' } }))
      .push(() => sseResponse([delta('from the fallback'), finish('stop'), '[DONE]']));
    const events: GatewayTraceEvent[] = [];
    let ids: { primary: string; fallback: string } = { primary: '', fallback: '' };
    const routes = (): { profileId: string; model?: string; fallbacks?: readonly RoleTarget[] } | undefined =>
      ids.primary === '' || ids.fallback === '' ? undefined : { profileId: ids.primary, model: 'model-x', fallbacks: [{ profileId: ids.fallback }] };
    const h = fallbackHarness(routes, { net, observe: (event) => events.push(event) });
    ids = await pair(h);

    const { chunks, error } = await collect(h.gateway.complete({ ...userMessage('one request'), role: 'chat' }));
    expect(error).toBeUndefined();
    expect(deltasOf(chunks)).toBe('from the fallback');
    // Turning retries off hid the 429 behind a zero delay, so the address is scripted: the fallback's answer followed it at once.
    expect(net.calls.at(-1)?.url).toContain('b.example');
    expect(hostsOf(net)).toEqual(['a.example', 'b.example']);
    // The fallback sends the same body: one request, moved rather than rewritten.
    expect(net.bodyOf(1)).toEqual(net.bodyOf(0));
    expect(events.filter((event) => event.type === 'request').at(-1)).toMatchObject({ profileId: ids.fallback });
    const switchEvent = events.find((event) => event.type === 'fallback');
    expect(switchEvent).toMatchObject({ type: 'fallback', from: { profileId: ids.primary }, to: { profileId: ids.fallback }, reason: 'rate_limit' });
    // The models named are the ones each profile actually sends: the primary's `model-x`, the fallback's own default.
    expect(switchEvent?.type === 'fallback' ? switchEvent.from.model : undefined).toBe(String(net.bodyOf(0)['model']));
    expect(switchEvent?.type === 'fallback' ? switchEvent.to.model : undefined).toBe(String(net.bodyOf(1)['model']));
  });

  it('falls back on an overloaded provider, and the request log names who was tried', async () => {
    const net = new ScriptedFetch()
      .push(() => json(529, { error: { message: 'overloaded' } }))
      .push(() => sseResponse([delta('ok'), finish('stop'), '[DONE]']));
    let ids: { primary: string; fallback: string } = { primary: '', fallback: '' };
    const h = fallbackHarness(() => (ids.primary === '' ? undefined : { profileId: ids.primary, model: 'model-x', fallbacks: [{ profileId: ids.fallback }] }), { net });
    ids = await pair(h);

    await collect(h.gateway.complete({ ...userMessage('one request'), role: 'chat' }));
    const logged = h.gateway.requestLog.entries().map((entry) => entry.profileId);
    expect(logged).toContain(ids.primary);
    expect(logged).toContain(ids.fallback);
  });

  it('does not fall back when the primary refuses the credentials', async () => {
    const net = new ScriptedFetch().push(() => json(401, { error: { message: 'bad key' } }));
    let ids: { primary: string; fallback: string } = { primary: '', fallback: '' };
    const h = fallbackHarness(() => (ids.primary === '' ? undefined : { profileId: ids.primary, model: 'model-x', fallbacks: [{ profileId: ids.fallback }] }), { net });
    ids = await pair(h);

    const { error } = await collect(h.gateway.complete({ ...userMessage('one request'), role: 'chat' }));
    expect(error).toBeDefined();
    expect(hostsOf(net)).toEqual(['a.example']);
  });

  it('never falls back once output reached the caller', async () => {
    const encoder = new TextEncoder();
    const net = new ScriptedFetch().push(() => new Response(new ReadableStream<Uint8Array>({
      // One text delta, and then the stream breaks: the caller has seen part of an answer, so a second provider would repeat it.
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(delta('partial'))}\n\n`));
        setTimeout(() => controller.error(new Error('the body broke')), 20);
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    let ids: { primary: string; fallback: string } = { primary: '', fallback: '' };
    const h = fallbackHarness(() => (ids.primary === '' || ids.fallback === '' ? undefined : { profileId: ids.primary, model: 'model-x', fallbacks: [{ profileId: ids.fallback }] }), { net });
    ids = await pair(h);

    const { chunks } = await collect(h.gateway.complete({ ...userMessage('one request'), role: 'chat' }));
    expect(deltasOf(chunks)).toBe('partial');
    expect(hostsOf(net)).toEqual(['a.example']);
  });

  it('refuses a fallback the role no longer allows, before its key is revealed', async () => {
    let ids: { primary: string; fallback: string } = { primary: '', fallback: '' };
    const h = fallbackHarness(() => (ids.primary === '' ? undefined : { profileId: ids.primary, model: 'model-x', fallbacks: [{ profileId: ids.fallback }] }), {
      net: new ScriptedFetch().push(() => json(429, { error: { message: 'slow down' } })),
      allowed: () => (ids.primary === '' ? [] : [ids.primary]),
    });
    ids = await pair(h);
    const revealed: string[] = [];
    const spy = vi.spyOn(h.keys, 'revealPayload').mockImplementation(async (id) => {
      revealed.push(id);
      return { apiKey: KEY };
    });

    const { error } = await collect(h.gateway.complete({ ...userMessage('one request'), role: 'chat' }));
    expect(error).toBeInstanceOf(EgressDeniedError);
    expect(revealed).toEqual([ids.primary]);
    expect(hostsOf(h.net)).toEqual(['a.example']);
    spy.mockRestore();
  });

  it('keeps a request that pins its own profile on that profile alone', async () => {
    const net = new ScriptedFetch().push(() => sseResponse([delta('pinned'), finish('stop'), '[DONE]']));
    let ids: { primary: string; fallback: string } = { primary: '', fallback: '' };
    const h = fallbackHarness(() => (ids.primary === '' ? undefined : { profileId: ids.primary, model: 'model-x', fallbacks: [{ profileId: ids.fallback }] }), { net });
    ids = await pair(h);

    const { chunks } = await collect(h.gateway.complete({ ...userMessage('pinned'), role: 'chat', profileId: ids.fallback }));
    expect(deltasOf(chunks)).toBe('pinned');
    expect(hostsOf(net)).toEqual(['b.example']);
  });

  it('reports the route a role resolves right now, fallbacks included', async () => {
    let ids: { primary: string; fallback: string } = { primary: '', fallback: '' };
    const h = fallbackHarness(() => (ids.primary === '' ? undefined : { profileId: ids.primary, model: 'model-x', fallbacks: [{ profileId: ids.fallback }] }));
    ids = await pair(h);
    expect(h.gateway.resolveRoleRoute?.('chat')).toMatchObject({ profileId: ids.primary, fallbacks: [{ profileId: ids.fallback }] });
    expect(h.gateway.resolveRoleRoute?.('drafting')).toBeUndefined();
  });
});
