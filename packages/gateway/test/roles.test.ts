/**
 * complete()'s task-role routing (provider-gateway §6): a request that names a role and no profile resolves
 * through the injected resolver — the role's profile is the target, and its model and thinking level are the
 * defaults the request's own fields beat. The role-referenced set is the egress allow-list the answer is checked
 * against before any key is revealed, and the ledger rows carry the role the call ran under.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createGateway,
  createKeyStore,
  createManualClock,
  createMemoryVaultPort,
  createProfileStore,
  EgressDeniedError,
  ProfileError,
} from '../src/index.js';
import { createMockProvider, type MockProvider } from '../src/mock/index.js';
import type { RoleResolver, TaskRole } from '../src/types.js';
import {
  addEndpoint,
  collect,
  finish,
  microtaskSubtle,
  ScriptedFetch,
  sseResponse,
  START,
  userMessage,
} from './helpers.js';

/**
 * A gateway over in-memory stores with a role resolver injected: the `harness()` kit plus the §6 option.
 * `ids` is a cell the resolver reads at request time, so a test can write the profile ids into it once the
 * profiles it created exist.
 */
function roleHarness(
  roles: RoleResolver,
  net: ScriptedFetch = new ScriptedFetch(),
  mock?: MockProvider,
) {
  const clock = createManualClock(START);
  const keys = createKeyStore(createMemoryVaultPort(), { subtle: microtaskSubtle() });
  const profiles = createProfileStore({ keys });
  const gateway = createGateway({
    profiles,
    keys,
    clock,
    fetch: net.fn,
    random: () => 0.5,
    roles,
    ...(mock === undefined ? {} : { mock }),
  });
  return { clock, keys, profiles, net, gateway };
}

describe('complete() — task roles (provider-gateway §6)', () => {
  it('without a resolver a role is ledger data only: the named-or-active rule is unchanged', async () => {
    const net = new ScriptedFetch().push(() => sseResponse([finish('stop'), '[DONE]']));
    const clock = createManualClock(START);
    const keys = createKeyStore(createMemoryVaultPort(), { subtle: microtaskSubtle() });
    const profiles = createProfileStore({ keys });
    const gateway = createGateway({ profiles, keys, clock, fetch: net.fn, random: () => 0.5 });
    const h = { clock, keys, profiles, net, gateway };
    const active = await addEndpoint(h);

    const { error } = await collect(gateway.complete({ ...userMessage('hi'), role: 'drafting' }));

    expect(error).toBeUndefined();
    expect(net.calls[0]?.url).toBe('https://a.example/v1/chat/completions');
    expect(gateway.ledger.dayRows()).toMatchObject([{ profileId: active.id, model: 'model-x', role: 'drafting', requests: 1 }]);
  });

  it('does not consult the resolver for a roleless request', async () => {
    const resolve = vi.fn(() => undefined);
    const h = roleHarness({ resolve, allowed: () => [] }, new ScriptedFetch().push(() => sseResponse([finish('stop'), '[DONE]'])));
    const active = await addEndpoint(h);

    const { error } = await collect(h.gateway.complete(userMessage('hi')));

    expect(error).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    expect(h.net.calls[0]?.url).toBe('https://a.example/v1/chat/completions');
    expect(h.gateway.ledger.dayRows()).toMatchObject([{ profileId: active.id, role: 'chat' }]);
  });

  it('routes a role to the profile its resolver names, on that profile’s origin with that profile’s key', async () => {
    const ids: { drafted?: string } = {};
    const net = new ScriptedFetch().push(() => sseResponse([finish('stop'), '[DONE]']));
    const h = roleHarness(
      {
        resolve: (role: TaskRole) => (role === 'drafting' && ids.drafted !== undefined ? { profileId: ids.drafted } : undefined),
        allowed: (role: TaskRole) => (role === 'drafting' && ids.drafted !== undefined ? [ids.drafted] : []),
      },
      net,
    );
    await addEndpoint(h, { name: 'chat endpoint', baseUrl: 'https://a.example/v1' });
    ids.drafted = (await addEndpoint(h, { name: 'draft endpoint', baseUrl: 'https://b.example/v1', apiKey: 'sk-b-key-000000000000' })).id;

    const { error } = await collect(h.gateway.complete({ ...userMessage('draft it'), role: 'drafting' }));

    expect(error).toBeUndefined();
    expect(h.net.calls[0]?.url).toBe('https://b.example/v1/chat/completions');
    expect(h.net.headerOf(0, 'authorization')).toBe('Bearer sk-b-key-000000000000');
    // The usage row names the profile the role sent through, under the role.
    expect(h.gateway.ledger.dayRows()).toMatchObject([{ profileId: ids.drafted, model: 'model-x', role: 'drafting', requests: 1 }]);
  });

  it('uses the role’s model and thinking as defaults only, so the request’s own fields win', async () => {
    const mock = createMockProvider();
    const ids: { pinned?: string } = {};
    const h = roleHarness(
      {
        resolve: (role: TaskRole) =>
          role === 'drafting' && ids.pinned !== undefined ? { profileId: ids.pinned, model: 'role-model', thinking: 'low' } : undefined,
        allowed: () => (ids.pinned === undefined ? [] : [ids.pinned]),
      },
      new ScriptedFetch(),
      mock,
    );
    ids.pinned = (await h.profiles.create({ name: 'Offline', kind: 'mock' })).id;

    await collect(h.gateway.complete({ ...userMessage('defaults'), role: 'drafting' }));
    await collect(h.gateway.complete({ ...userMessage('explicit'), role: 'drafting', model: 'mine', thinking: 'high' }));

    // The mock records the request as routed: the role on it, and the role's thinking level as the default.
    expect(mock.calls[0]?.role).toBe('drafting');
    expect(mock.calls[0]?.thinking).toBe('low');
    expect(mock.calls[1]?.thinking).toBe('high');
    // The resolved model is the ledger's model, unless the request named its own.
    const rows = h.gateway.ledger.dayRows();
    expect(rows.map((row) => ({ model: row.model, role: row.role })).sort((a, b) => a.model.localeCompare(b.model))).toEqual([
      { model: 'mine', role: 'drafting' },
      { model: 'role-model', role: 'drafting' },
    ]);
  });

  it('refuses a routed request whose profile the role may not use, before any key is revealed', async () => {
    const ids: { allowed?: string; blocked?: string } = {};
    const net = new ScriptedFetch();
    const h = roleHarness(
      {
        resolve: () => (ids.blocked === undefined ? undefined : { profileId: ids.blocked }),
        allowed: () => (ids.allowed === undefined ? [] : [ids.allowed]),
      },
      net,
    );
    ids.allowed = (await addEndpoint(h, { name: 'chat endpoint', baseUrl: 'https://a.example/v1' })).id;
    ids.blocked = (await addEndpoint(h, { name: 'other endpoint', baseUrl: 'https://b.example/v1' })).id;
    const reveal = vi.spyOn(h.keys, 'revealPayload');

    const { error } = await collect(h.gateway.complete({ ...userMessage('x'), role: 'chat' }));

    expect(error).toBeInstanceOf(EgressDeniedError);
    expect((error as Error).message).toMatch(/"chat" role/);
    expect(net.calls).toHaveLength(0);
    expect(reveal).not.toHaveBeenCalled();
    expect(h.gateway.ledger.dayRows()).toEqual([]);
  });

  it('falls back to the named-or-active rule when the resolver has no answer, and fails as ever when none exists', async () => {
    const roles: RoleResolver = { resolve: () => undefined, allowed: () => [] };
    const h = roleHarness(roles, new ScriptedFetch().push(() => sseResponse([finish('stop'), '[DONE]'])));
    const active = await addEndpoint(h);

    // An unanswered role resolves to the active profile, as a roleless request does.
    const { error } = await collect(h.gateway.complete({ ...userMessage('x'), role: 'background' }));
    expect(error).toBeUndefined();
    expect(h.net.calls[0]?.url).toBe('https://a.example/v1/chat/completions');
    expect(h.gateway.ledger.dayRows()).toMatchObject([{ profileId: active.id, role: 'background' }]);

    // With no profile at all the refusal is the same no-active one a roleless request gets.
    const empty = roleHarness(roles);
    const refused = await collect(empty.gateway.complete({ ...userMessage('x'), role: 'drafting' }));
    expect(refused.error).toBeInstanceOf(ProfileError);
    expect((refused.error as ProfileError).code).toBe('no-active');
  });

  it('leaves an explicitly named profile alone: the resolver is not asked, and the role rides the ledger row', async () => {
    const resolve = vi.fn(() => undefined);
    const h = roleHarness({ resolve, allowed: () => [] }, new ScriptedFetch().push(() => sseResponse([finish('stop'), '[DONE]'])));
    await addEndpoint(h, { name: 'active', baseUrl: 'https://a.example/v1' });
    const named = await addEndpoint(h, { name: 'named', baseUrl: 'https://b.example/v1' });

    const { error } = await collect(h.gateway.complete({ ...userMessage('x'), role: 'chat', profileId: named.id }));

    expect(error).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
    expect(h.net.calls[0]?.url).toBe('https://b.example/v1/chat/completions');
    expect(h.gateway.ledger.dayRows()).toMatchObject([{ profileId: named.id, role: 'chat' }]);
  });
});

describe('modelLimits() — task roles (provider-gateway §6, §3 "Effective output")', () => {
  /** An active generic endpoint (no thinking row) and a DeepSeek profile that thinks at the provider default, routed for drafting. */
  async function routed(answers = true) {
    const ids: { drafted?: string } = {};
    const resolve = vi.fn((role: TaskRole) => (answers && role === 'drafting' && ids.drafted !== undefined ? { profileId: ids.drafted } : undefined));
    const h = roleHarness({ resolve, allowed: (role: TaskRole) => (role === 'drafting' && ids.drafted !== undefined ? [ids.drafted] : []) });
    const active = await addEndpoint(h, { name: 'generic', preset: 'generic', baseUrl: 'https://a.example/v1' });
    const drafted = await addEndpoint(h, { name: 'deepseek', preset: 'deepseek', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-v4-pro' });
    ids.drafted = drafted.id;
    return { h, active, drafted, resolve };
  }

  it('settles a role-stamped request with no profile on the route complete() sends it through', async () => {
    const { h } = await routed();
    // The active generic profile has no thinking row: its transmitted cap is the 4,096 default.
    expect(h.gateway.modelLimits().thinkingTokens).toBeUndefined();
    // The drafting role routes to DeepSeek, whose provider-default thinking lifts the default cap to 16,384.
    const limits = h.gateway.modelLimits(undefined, undefined, undefined, { role: 'drafting' });
    expect(limits.maxOutputTokens).toBe(4_096);
    expect(limits.thinkingTokens).toBe(12_288);
  });

  it('keeps a named profile over the role, and a role the resolver has no answer for on the active profile', async () => {
    const { h, drafted, resolve } = await routed(false);
    expect(h.gateway.modelLimits(undefined, undefined, undefined, { role: 'chat' }).thinkingTokens).toBeUndefined();
    expect(resolve).toHaveBeenCalledWith('chat');
    resolve.mockClear();
    expect(h.gateway.modelLimits(drafted.id, undefined, undefined, { role: 'chat' }).thinkingTokens).toBe(12_288);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('takes the role’s thinking level as the default the asked level beats', async () => {
    const ids: { drafted?: string } = {};
    const h = roleHarness({
      resolve: (role: TaskRole) => (role === 'drafting' && ids.drafted !== undefined ? { profileId: ids.drafted, thinking: 'off' } : undefined),
      allowed: (role: TaskRole) => (role === 'drafting' && ids.drafted !== undefined ? [ids.drafted] : []),
    });
    await addEndpoint(h, { name: 'generic', preset: 'generic', baseUrl: 'https://a.example/v1' });
    ids.drafted = (await addEndpoint(h, { name: 'deepseek', preset: 'deepseek', baseUrl: 'https://api.deepseek.com', defaultModel: 'deepseek-v4-pro' })).id;
    // The role pins thinking off: no lift. An asked level on the same request wins over the role's.
    expect(h.gateway.modelLimits(undefined, undefined, undefined, { role: 'drafting' }).thinkingTokens).toBeUndefined();
    expect(h.gateway.modelLimits(undefined, undefined, 'high', { role: 'drafting' }).thinkingTokens).toBe(12_288);
  });
});
