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
  ProviderError,
  type GatewayTraceEvent,
  type NewProfile,
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
    expect(net.calls.map((call) => new URL(call.url).host)).toEqual(['a.example', 'b.example']);
    // The fallback sends the same body: one request, moved rather than rewritten.
    expect(net.bodyOf(1)).toEqual(net.bodyOf(0));
    expect(events.filter((event) => event.type === 'request').at(-1)).toMatchObject({ profileId: ids.fallback });
    const switchEvent = events.find((event) => event.type === 'fallback');
    expect(switchEvent).toMatchObject({ type: 'fallback', from: { profileId: ids.primary }, to: { profileId: ids.fallback }, reason: 'rate_limit' });
    // The switch is told under the call that answered, so a trace reader files it in that call's record rather than losing it.
    expect(switchEvent?.id).toBe(events.filter((event) => event.type === 'request').at(-1)?.id);
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

  it('moves to a fallback when a profile on this computer cannot be reached', async () => {
    // A local server that is down is a permanent failure for that address — a second try cannot change a browser's answer — but the
    // route may still move: the writer's sentence says "rate-limited, overloaded or unreachable".
    const keys = createKeyStore(createMemoryVaultPort(), { subtle: microtaskSubtle() });
    const profiles = createProfileStore({ keys });
    const hosts: string[] = [];
    let local = '';
    let remote = '';
    const roles: RoleResolver = {
      resolve: (role: TaskRole) => (role === 'chat' && local !== '' && remote !== '' ? { profileId: local, model: 'llama3.2', fallbacks: [{ profileId: remote }] } : undefined),
      allowed: () => [local, remote],
    };
    const gateway = createGateway({
      profiles,
      keys,
      clock: createManualClock(START),
      random: () => 0.5,
      fetch: (url) => {
        const host = new URL(String(url)).host;
        hosts.push(host);
        if (host === '127.0.0.1:11434') return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve(sseResponse([delta('from the fallback'), finish('stop'), '[DONE]']));
      },
      retry: { maxRetries: 0, delaysMs: [0], jitter: 0 },
      supportsAddressSpace: () => false,
      loopbackPermission: async () => 'denied',
      roles,
    });
    local = (await profiles.create({ name: 'Local', kind: 'endpoint', preset: 'ollama', defaultModel: 'llama3.2' })).id;
    remote = (await profiles.create({ name: 'Remote', kind: 'endpoint', baseUrl: 'https://b.example/v1', apiKey: `${KEY}b`, defaultModel: 'model-y' })).id;

    const { chunks, error } = await collect(gateway.complete({ ...userMessage('one request'), role: 'chat' }));
    expect(error).toBeUndefined();
    expect(deltasOf(chunks)).toBe('from the fallback');
    expect(hosts).toContain('b.example');
  });

  it('keeps a request that carries an approval stamp on its own destination', async () => {
    // A model hook names its route with `expectedRoute`: it is pinned to that profile, so the role's list never applies, and the
    // provider's own fault reaches the caller instead of an admission refusal for a destination it never asked for.
    const net = new ScriptedFetch().push(() => json(429, { error: { message: 'slow down' } }));
    let ids: { primary: string; fallback: string } = { primary: '', fallback: '' };
    const h = fallbackHarness(() => (ids.primary === '' ? undefined : { profileId: ids.primary, model: 'model-x', fallbacks: [{ profileId: ids.fallback }] }), { net });
    ids = await pair(h);

    const { error } = await collect(h.gateway.complete({
      ...userMessage('a hook request'),
      role: 'chat',
      expectedRoute: { profileId: ids.primary, model: 'model-x' },
    }));
    expect(error).toBeDefined();
    expect(hostsOf(net)).toEqual(['a.example']);
  });

  it('reports the route a role resolves right now, fallbacks included', async () => {
    let ids: { primary: string; fallback: string } = { primary: '', fallback: '' };
    const h = fallbackHarness(() => (ids.primary === '' ? undefined : { profileId: ids.primary, model: 'model-x', fallbacks: [{ profileId: ids.fallback }] }));
    ids = await pair(h);
    expect(h.gateway.resolveRoleRoute?.('chat')).toMatchObject({ profileId: ids.primary, fallbacks: [{ profileId: ids.fallback }] });
    expect(h.gateway.resolveRoleRoute?.('drafting')).toBeUndefined();
  });
});

describe('complete() — a fallback that answered starts the turn’s next request (provider-gateway §6)', () => {
  const routes = (ids: () => { primary: string; fallback: string }) => () =>
    (ids().primary === '' ? undefined : { profileId: ids().primary, model: 'model-x', fallbacks: [{ profileId: ids().fallback }] });

  it('sends a request that names a remembered target there first, and nowhere else', async () => {
    const net = new ScriptedFetch().push(() => sseResponse([delta('still the fallback'), finish('stop'), '[DONE]']));
    let ids: { primary: string; fallback: string } = { primary: '', fallback: '' };
    const h = fallbackHarness(routes(() => ids), { net });
    ids = await pair(h);
    const answered: unknown[] = [];

    const { chunks, error } = await collect(h.gateway.complete(
      { ...userMessage('the turn’s second request'), role: 'chat' },
      undefined,
      undefined,
      { startAt: ids.fallback, answered: (target) => answered.push(target) },
    ));
    expect(error).toBeUndefined();
    expect(deltasOf(chunks)).toBe('still the fallback');
    expect(hostsOf(net)).toEqual(['b.example']);
    // The caller is told the destination that answered, in the terms it hands back next time.
    expect(answered).toEqual([{ profileId: ids.fallback, model: expect.any(String) }]);
  });

  it('keeps the rest of the route behind a remembered target that fails again', async () => {
    // The remembered target is first, not exempt: it is admitted like any other fallback, and its own fault moves on to the primary.
    const net = new ScriptedFetch()
      .push(() => json(429, { error: { message: 'slow down' } }))
      .push(() => sseResponse([delta('the primary answers'), finish('stop'), '[DONE]']));
    let ids: { primary: string; fallback: string } = { primary: '', fallback: '' };
    const h = fallbackHarness(routes(() => ids), { net });
    ids = await pair(h);
    const admitted: unknown[] = [];
    const answered: unknown[] = [];

    const { chunks, error } = await collect(h.gateway.complete(
      { ...userMessage('the turn’s third request'), role: 'chat' },
      undefined,
      undefined,
      { startAt: ids.fallback, admitAttempt: (target) => admitted.push(target), answered: (target) => answered.push(target) },
    ));
    expect(error).toBeUndefined();
    expect(deltasOf(chunks)).toBe('the primary answers');
    expect(hostsOf(net)).toEqual(['b.example', 'a.example']);
    expect(admitted).toEqual([{ profileId: ids.primary, model: 'model-x' }]);
    expect(answered).toEqual([{ profileId: ids.primary, model: 'model-x' }]);
  });

  it('starts at the role’s primary again when the remembered target is gone from the route', async () => {
    const net = new ScriptedFetch().push(() => sseResponse([delta('from the primary'), finish('stop'), '[DONE]']));
    let ids: { primary: string; fallback: string } = { primary: '', fallback: '' };
    const h = fallbackHarness(routes(() => ids), { net });
    ids = await pair(h);

    const { chunks, error } = await collect(h.gateway.complete(
      { ...userMessage('after the writer edited the list'), role: 'chat' },
      undefined,
      undefined,
      { startAt: 'a-profile-that-is-not-in-the-route', answered: () => {} },
    ));
    expect(error).toBeUndefined();
    expect(deltasOf(chunks)).toBe('from the primary');
    expect(hostsOf(net)).toEqual(['a.example']);
  });

  it('never sends to a remembered target the role may no longer use', async () => {
    // A stale memory cannot widen what a role may reach: the route starts at its primary, and nothing is sent to the other profile.
    const net = new ScriptedFetch().push(() => sseResponse([delta('from the primary'), finish('stop'), '[DONE]']));
    let ids: { primary: string; fallback: string } = { primary: '', fallback: '' };
    const h = fallbackHarness(routes(() => ids), { net, allowed: () => [ids.primary] });
    ids = await pair(h);

    const { chunks, error } = await collect(h.gateway.complete(
      { ...userMessage('after the writer withdrew it'), role: 'chat' },
      undefined,
      undefined,
      { startAt: ids.fallback },
    ));
    expect(error).toBeUndefined();
    expect(deltasOf(chunks)).toBe('from the primary');
    expect(hostsOf(net)).toEqual(['a.example']);
  });

  it('does not remember a destination whose stream ended on a fault', async () => {
    // A filtered reply is a finished stream with no answer in it: the caller must not start its next request there.
    const net = new ScriptedFetch().push(() => sseResponse([delta('part'), finish('content_filter'), '[DONE]']));
    let ids: { primary: string; fallback: string } = { primary: '', fallback: '' };
    const h = fallbackHarness(routes(() => ids), { net });
    ids = await pair(h);
    const answered: unknown[] = [];

    const { chunks } = await collect(h.gateway.complete(
      { ...userMessage('a filtered reply'), role: 'chat' },
      undefined,
      undefined,
      { startAt: ids.fallback, answered: (target) => answered.push(target) },
    ));
    expect(deltasOf(chunks)).toBe('part');
    expect(hostsOf(net)).toEqual(['b.example']);
    expect(answered).toEqual([]);
  });

  it('ignores a remembered target on a request that is pinned to its own destination', async () => {
    // A stamped request names its route, so the turn’s memory has nothing to say about it.
    const net = new ScriptedFetch().push(() => sseResponse([delta('the pinned answer'), finish('stop'), '[DONE]']));
    let ids: { primary: string; fallback: string } = { primary: '', fallback: '' };
    const h = fallbackHarness(routes(() => ids), { net });
    ids = await pair(h);
    const answered: unknown[] = [];

    const { chunks, error } = await collect(h.gateway.complete(
      { ...userMessage('a pinned call'), role: 'chat', expectedRoute: { profileId: ids.primary, model: 'model-x' } },
      undefined,
      undefined,
      { startAt: ids.fallback, answered: (target) => answered.push(target) },
    ));
    expect(error).toBeUndefined();
    expect(deltasOf(chunks)).toBe('the pinned answer');
    expect(hostsOf(net)).toEqual(['a.example']);
    expect(answered).toEqual([]);
  });
});


describe('complete() — a window refusal moves only to a window that holds the request (provider-gateway §6)', () => {
  /** A gateway whose chat route is the small-window primary, then the given fallbacks. */
  async function windowed(fallbacks: readonly NewProfile[]) {
    const net = new ScriptedFetch();
    let ids: { primary: string; fallbacks: string[] } = { primary: '', fallbacks: [] };
    const h = fallbackHarness(
      () => (ids.primary === '' ? undefined : { profileId: ids.primary, fallbacks: ids.fallbacks.map((profileId) => ({ profileId })) }),
      { net },
    );
    // A local server's row is the documented 4,096-token window; every fallback's own row answers for itself.
    const primary = await addEndpoint(h, { name: 'Small', preset: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', defaultModel: 'local-model' });
    const created = [];
    for (const profile of fallbacks) created.push((await addEndpoint(h, profile)).id);
    ids = { primary: primary.id, fallbacks: created };
    return { h, net, primary: primary.id, fallbacks: created };
  }

  const overflow = (): Response => json(400, { error: { message: "This model's maximum context length is 4096 tokens. Your messages resulted in 9000 tokens." } });

  it('moves to a later target whose known window is larger than the request needs', async () => {
    const wide: NewProfile = { name: 'Wide', kind: 'endpoint', preset: 'deepseek', baseUrl: 'https://b.example/v1', apiKey: `${KEY}b`, defaultModel: 'deepseek-flash' };
    const { h, net } = await windowed([wide]);
    net.push(overflow).push(() => sseResponse([delta('from the wide window'), finish('stop'), '[DONE]']));
    const events: GatewayTraceEvent[] = [];
    const observed = fallbackHarness(
      () => ({ profileId: h.gateway.resolveRoleRoute?.('chat')?.profileId ?? '', fallbacks: h.gateway.resolveRoleRoute?.('chat')?.fallbacks ?? [] }),
      { net, observe: (event) => events.push(event) },
    );
    expect(observed).toBeDefined();

    const { chunks, error } = await collect(h.gateway.complete({ ...userMessage('a long prompt'), role: 'chat', maxOutputTokens: 8_000 }));

    expect(error).toBeUndefined();
    expect(deltasOf(chunks)).toBe('from the wide window');
    expect(net.calls.map((call) => new URL(call.url).host)).toEqual(['127.0.0.1:1234', 'b.example']);
  });

  it('never sends a prompt a target’s own window cannot hold', async () => {
    // The fallback's window is unknown (a hand-rolled endpoint states none), so it is not a destination for a window refusal: the
    // provider's own refusal reaches the caller instead of a second request that could only fail the same way.
    const unknown: NewProfile = { name: 'Unknown', kind: 'endpoint', baseUrl: 'https://b.example/v1', apiKey: `${KEY}b`, defaultModel: 'model-x' };
    const { h, net } = await windowed([unknown]);
    net.push(overflow);

    const { error } = await collect(h.gateway.complete({ ...userMessage('a long prompt'), role: 'chat', maxOutputTokens: 8_000 }));

    expect(error).toBeInstanceOf(ProviderError);
    expect(net.calls.map((call) => new URL(call.url).host)).toEqual(['127.0.0.1:1234']);
  });
});
