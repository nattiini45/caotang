/**
 * Provider profiles — provider-gateway.md §2. CRUD, stable ids, the exactly-one-active
 * invariant, the MOCK type, and the rule that a view never carries a key.
 */

import { describe, expect, it } from 'vitest';
import {
  createKeyStore,
  createMemoryVaultPort,
  createProfileStore,
  PROFILE_ID_PATTERN,
  ProfileError,
  type ProfileStore,
} from '../src/index.js';
import { KEY, lcg } from './helpers.js';

function store(): { profiles: ProfileStore; keys: ReturnType<typeof createKeyStore> } {
  const keys = createKeyStore(createMemoryVaultPort());
  return { profiles: createProfileStore({ keys }), keys };
}

const endpoint = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  kind: 'endpoint' as const,
  baseUrl: 'https://a.example/v1',
  apiKey: KEY,
  defaultModel: 'model-x',
  ...extra,
});

/** The invariant from §2: once any profile exists, exactly one is active. */
function expectOneActive(profiles: ProfileStore): void {
  const all = profiles.list();
  if (all.length === 0) {
    expect(profiles.active()).toBeUndefined();
    return;
  }
  expect(all.filter((p) => p.isActive)).toHaveLength(1);
  expect(profiles.active()?.id).toBe(all.find((p) => p.isActive)?.id);
}

describe('profile CRUD and ids', () => {
  it('mints a stable, prefixed, unguessable-looking id that never changes on update', async () => {
    const { profiles } = store();
    const created = await profiles.create(endpoint('OpenRouter main'));
    expect(created.id).toMatch(PROFILE_ID_PATTERN);
    expect(created.id).not.toContain('OpenRouter');

    const renamed = await profiles.update(created.id, { name: 'Renamed' });
    expect(renamed.id).toBe(created.id);
    expect(profiles.get(created.id)?.name).toBe('Renamed');
  });

  it('gives every profile its own id', async () => {
    const { profiles } = store();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i += 1) ids.add((await profiles.create(endpoint(`p${i}`))).id);
    expect(ids.size).toBe(20);
  });

  it('lists profiles in creation order and removes them cleanly', async () => {
    const { profiles } = store();
    const first = await profiles.create(endpoint('first'));
    const second = await profiles.create(endpoint('second'));
    expect(profiles.list().map((p) => p.id)).toEqual([first.id, second.id]);
    await profiles.remove(first.id);
    expect(profiles.get(first.id)).toBeUndefined();
    expect(profiles.list().map((p) => p.id)).toEqual([second.id]);
  });

  it('refuses to update or remove an id that does not exist', async () => {
    const { profiles } = store();
    await expect(profiles.update('prv_0000000000', { name: 'x' })).rejects.toMatchObject({ code: 'not-found' });
    await expect(profiles.remove('prv_0000000000')).rejects.toBeInstanceOf(ProfileError);
    expect(() => profiles.activate('prv_0000000000')).toThrow(ProfileError);
  });

  it('ignores a probe result for a profile that was removed while the probe ran', async () => {
    const { profiles } = store();
    const created = await profiles.create(endpoint('gone soon'));
    await profiles.remove(created.id);
    expect(() => profiles.recordProbe(created.id, { supportsJsonObject: true, probedAt: 1 })).not.toThrow();
  });
});

describe('exactly one active profile (§2)', () => {
  it('makes the first profile active and leaves later ones inactive', async () => {
    const { profiles } = store();
    const first = await profiles.create(endpoint('first'));
    const second = await profiles.create(endpoint('second'));
    expect(first.isActive).toBe(true);
    expect(second.isActive).toBe(false);
    expectOneActive(profiles);
  });

  it('makes a profile created with isActive the only active one', async () => {
    const { profiles } = store();
    await profiles.create(endpoint('first'));
    const chosen = await profiles.create(endpoint('chosen', { isActive: true }));
    expect(profiles.active()?.id).toBe(chosen.id);
    expectOneActive(profiles);
  });

  it('moves activity with activate and keeps exactly one', async () => {
    const { profiles } = store();
    const a = await profiles.create(endpoint('a'));
    const b = await profiles.create(endpoint('b'));
    profiles.activate(b.id);
    expect(profiles.active()?.id).toBe(b.id);
    expect(profiles.get(a.id)?.isActive).toBe(false);
    expectOneActive(profiles);
  });

  it('promotes the oldest remaining profile when the active one is removed', async () => {
    const { profiles } = store();
    const a = await profiles.create(endpoint('a'));
    const b = await profiles.create(endpoint('b'));
    await profiles.create(endpoint('c'));
    await profiles.remove(a.id);
    expect(profiles.active()?.id).toBe(b.id);
    expectOneActive(profiles);
  });

  it('leaves no active profile when the last one is removed', async () => {
    const { profiles } = store();
    const only = await profiles.create(endpoint('only'));
    await profiles.remove(only.id);
    expect(profiles.active()).toBeUndefined();
    expectOneActive(profiles);
  });

  it('holds the invariant across a long random sequence of creates, activations, and removals', async () => {
    const { profiles } = store();
    const random = lcg(20261008);
    for (let step = 0; step < 300; step += 1) {
      const roll = random();
      const all = profiles.list();
      if (roll < 0.4 || all.length === 0) {
        await profiles.create(endpoint(`p${step}`, { isActive: random() < 0.2 }));
      } else if (roll < 0.7) {
        profiles.activate(all[Math.floor(random() * all.length)]!.id);
      } else {
        await profiles.remove(all[Math.floor(random() * all.length)]!.id);
      }
      expectOneActive(profiles);
    }
  });
});

describe('the MOCK profile type (§8)', () => {
  it('needs no key, takes the mock base, and gets a default model', async () => {
    const { profiles } = store();
    const mock = await profiles.create({ name: 'Offline', kind: 'mock' });
    expect(mock.kind).toBe('mock');
    expect(mock.baseUrl).toBe('mock://caotang');
    expect(mock.defaultModel).toBe('mock/echo-1');
    expect(mock.hasKey).toBe(false);
  });

  it('does not store a key for a mock, even if one is supplied', async () => {
    const { profiles, keys } = store();
    const mock = await profiles.create({ name: 'Offline', kind: 'mock', apiKey: KEY });
    expect(mock.hasKey).toBe(false);
    expect(await keys.has(mock.id)).toBe(false);
  });

  it('refuses any base other than mock://caotang for a mock', async () => {
    const { profiles } = store();
    await expect(profiles.create({ name: 'Bad', kind: 'mock', baseUrl: 'https://a.example/v1' })).rejects.toMatchObject({
      field: 'baseUrl',
    });
  });
});

describe('validation', () => {
  it('needs a name, a model, and a base for an endpoint', async () => {
    const { profiles } = store();
    await expect(profiles.create(endpoint('   '))).rejects.toMatchObject({ field: 'name' });
    await expect(profiles.create(endpoint('x', { defaultModel: ' ' }))).rejects.toMatchObject({ field: 'defaultModel' });
    await expect(profiles.create(endpoint('x', { baseUrl: 'mock://caotang' }))).rejects.toMatchObject({ field: 'baseUrl' });
  });

  it('defaults an endpoint to the generic preset and refuses a preset that does not exist', async () => {
    const { profiles } = store();
    const created = await profiles.create(endpoint('x'));
    expect(created.preset).toBe('generic');
    await expect(profiles.create(endpoint('x', { preset: 'not-a-provider' }))).rejects.toMatchObject({ field: 'preset' });
  });

  it('requires a key when the preset does not mark it optional, and not when it does', async () => {
    const { profiles } = store();
    // openai is a named preset: it documents keyed calls, so the key is required.
    await expect(profiles.create(endpoint('remote', { preset: 'openai', apiKey: '' }))).rejects.toMatchObject({ field: 'apiKey' });
    // generic is key-optional: a hand-rolled endpoint may ignore the header entirely.
    const free = await profiles.create(endpoint('free', { apiKey: '' }));
    expect(free.hasKey).toBe(false);
    // opencode documents keyless calls on its free models; with no base URL given, the preset's is used.
    const zen = await profiles.create({ name: 'zen', kind: 'endpoint', preset: 'opencode', apiKey: '', defaultModel: 'kimi-k3' });
    expect(zen.hasKey).toBe(false);
    expect(zen.preset).toBe('opencode');
    expect(zen.baseUrl).toBe('https://opencode.ai/inference/v1');
  });

  it('refuses a loopback base even without a key — there is no http exemption anymore', async () => {
    const { profiles } = store();
    await expect(profiles.create(endpoint('local', { baseUrl: 'http://localhost:1234/v1', apiKey: '' }))).rejects.toMatchObject({
      field: 'baseUrl',
    });
  });

  it('refuses plain http even to a look-alike 127. host, and a named preset still requires its key', async () => {
    const { profiles } = store();
    await expect(profiles.create(endpoint('x', { baseUrl: 'http://127.attacker.test/v1', apiKey: '' }))).rejects.toMatchObject({
      field: 'baseUrl',
    });
    await expect(
      profiles.create(endpoint('x', { baseUrl: 'https://127.attacker.test/v1', preset: 'openai', apiKey: '' })),
    ).rejects.toMatchObject({ field: 'apiKey' });
  });

  it('refuses a key with a space or a line break in it, which would fail every request', async () => {
    const { profiles } = store();
    await expect(profiles.create(endpoint('x', { apiKey: 'sk-abc def' }))).rejects.toMatchObject({ field: 'apiKey' });
    await expect(profiles.create(endpoint('x', { apiKey: 'sk-abc\n' }))).resolves.toBeDefined();
  });

  it('bounds temperature, the output limit, and prices', async () => {
    const { profiles } = store();
    await expect(profiles.create(endpoint('x', { temperature: 3 }))).rejects.toMatchObject({ field: 'temperature' });
    await expect(profiles.create(endpoint('x', { maxOutputTokens: 0 }))).rejects.toMatchObject({ field: 'maxOutputTokens' });
    await expect(profiles.create(endpoint('x', { maxOutputTokens: 1.5 }))).rejects.toMatchObject({ field: 'maxOutputTokens' });
    await expect(profiles.create(endpoint('x', { pricePer1k: { prompt: -1, completion: 0 } }))).rejects.toMatchObject({
      field: 'pricePer1k',
    });
  });

  it('keeps a saved price when an update leaves the price out, and clears it when the update says null', async () => {
    const { profiles } = store();
    const created = await profiles.create(endpoint('priced', { pricePer1k: { prompt: 0.5, completion: 1.5 } }));
    const kept = await profiles.update(created.id, { name: 'renamed' });
    expect(kept.pricePer1k).toEqual({ prompt: 0.5, completion: 1.5 });
    const replaced = await profiles.update(created.id, { pricePer1k: { prompt: 2, completion: 4 } });
    expect(replaced.pricePer1k).toEqual({ prompt: 2, completion: 4 });
    const cleared = await profiles.update(created.id, { pricePer1k: null });
    expect(cleared).not.toHaveProperty('pricePer1k');
    expect(profiles.get(created.id)).not.toHaveProperty('pricePer1k');
    expect(profiles.get(created.id)?.name).toBe('renamed');
  });

  it('normalises the base it stores', async () => {
    const { profiles } = store();
    const created = await profiles.create(endpoint('x', { baseUrl: 'https://openrouter.ai/api/v1/' }));
    expect(created.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('keeps the old base and key when a save is refused, so a typo cannot half-apply', async () => {
    const { profiles } = store();
    const created = await profiles.create(endpoint('x'));
    await expect(profiles.update(created.id, { baseUrl: 'https://a.example/v1/chat/completions' })).rejects.toBeInstanceOf(
      ProfileError,
    );
    expect(profiles.get(created.id)?.baseUrl).toBe('https://a.example/v1');
  });
});

describe('the key boundary', () => {
  it('never puts the key on a view, whichever way the view is read', async () => {
    const { profiles } = store();
    const created = await profiles.create(endpoint('x'));
    const serialised = JSON.stringify([created, profiles.get(created.id), profiles.list(), profiles.active()]);
    expect(serialised).not.toContain(KEY);
    expect(serialised).not.toContain('apiKey');
    expect(created).not.toHaveProperty('apiKey');
    expect(created.hasKey).toBe(true);
  });

  it('keeps the key in the key store, and drops it there when the profile goes', async () => {
    const { profiles, keys } = store();
    const created = await profiles.create(endpoint('x'));
    expect(await keys.reveal(created.id)).toBe(KEY);
    await profiles.remove(created.id);
    expect(await keys.has(created.id)).toBe(false);
  });

  it('refuses an origin change that brings no key, so the stored key is never sent to the new origin', async () => {
    const { profiles, keys } = store();
    const created = await profiles.create(endpoint('x'));
    const attempt = profiles.update(created.id, { baseUrl: 'https://attacker.example/v1' });
    await expect(attempt).rejects.toBeInstanceOf(ProfileError);
    await expect(attempt).rejects.toMatchObject({ code: 'invalid', field: 'apiKey' });
    await expect(attempt).rejects.toThrow('Enter the API key again for the new endpoint.');

    expect(profiles.get(created.id)?.baseUrl).toBe('https://a.example/v1');
    expect(profiles.get(created.id)?.hasKey).toBe(true);
    expect(await keys.reveal(created.id)).toBe(KEY);
  });

  it('moves to a new origin with the key entered for it, and the old key is replaced', async () => {
    const { profiles, keys } = store();
    const created = await profiles.create(endpoint('x'));
    const moved = await profiles.update(created.id, { baseUrl: 'https://b.example/v1', apiKey: 'sk-moved-key-123456' });
    expect(moved.baseUrl).toBe('https://b.example/v1');
    expect(moved.hasKey).toBe(true);
    expect(await keys.reveal(created.id)).toBe('sk-moved-key-123456');
  });

  it('refuses an origin change that re-enters the key but lets stored headers ride', async () => {
    const { profiles, keys } = store();
    const created = await profiles.create(endpoint('x', { customHeaders: { 'x-proxy-secret': 'hunter2' } }));
    const attempt = profiles.update(created.id, { baseUrl: 'https://attacker.example/v1', apiKey: 'sk-moved-key-123456' });
    await expect(attempt).rejects.toBeInstanceOf(ProfileError);
    await expect(attempt).rejects.toMatchObject({ code: 'invalid', field: 'customHeaders' });
    await expect(attempt).rejects.toThrow('Enter the extra headers again for the new endpoint.');

    expect(profiles.get(created.id)?.baseUrl).toBe('https://a.example/v1');
    expect((await keys.revealPayload(created.id))?.customHeaders).toEqual({ 'x-proxy-secret': 'hunter2' });
    expect((await keys.revealPayload(created.id))?.apiKey).toBe(KEY);
  });

  it('refuses an origin change that re-enters headers but lets the stored key ride', async () => {
    const { profiles, keys } = store();
    const created = await profiles.create(endpoint('x', { customHeaders: { 'x-proxy-secret': 'hunter2' } }));
    const attempt = profiles.update(created.id, {
      baseUrl: 'https://attacker.example/v1',
      customHeaders: { 'x-proxy-secret': 'hunter2' },
    });
    await expect(attempt).rejects.toMatchObject({ code: 'invalid', field: 'apiKey' });
    await expect(attempt).rejects.toThrow('Enter the API key again for the new endpoint.');

    expect(profiles.get(created.id)?.baseUrl).toBe('https://a.example/v1');
    expect(await keys.reveal(created.id)).toBe(KEY);
  });

  it('refuses an origin change for a keyless profile whose stored headers would ride', async () => {
    const { profiles } = store();
    const created = await profiles.create(endpoint('local', { apiKey: '', customHeaders: { 'x-team': 'blue-42' } }));
    const attempt = profiles.update(created.id, { baseUrl: 'https://remote.example/v1' });
    await expect(attempt).rejects.toMatchObject({ code: 'invalid', field: 'customHeaders' });
    expect(profiles.get(created.id)?.baseUrl).toBe('https://a.example/v1');
  });

  it('moves origin when the patch re-enters both secrets', async () => {
    const { profiles, keys } = store();
    const created = await profiles.create(endpoint('x', { customHeaders: { 'x-proxy-secret': 'hunter2' } }));
    const moved = await profiles.update(created.id, {
      baseUrl: 'https://b.example/v1',
      apiKey: 'sk-moved-key-123456',
      customHeaders: { 'x-proxy-secret': 'fresh-secret' },
    });
    expect(moved.baseUrl).toBe('https://b.example/v1');
    const payload = await keys.revealPayload(created.id);
    expect(payload?.apiKey).toBe('sk-moved-key-123456');
    expect(payload?.customHeaders).toEqual({ 'x-proxy-secret': 'fresh-secret' });
  });

  it('keeps the key when only the path changes on the same origin', async () => {
    const { profiles, keys } = store();
    const created = await profiles.create(endpoint('x'));
    const repathed = await profiles.update(created.id, { baseUrl: 'https://a.example/v2' });
    expect(repathed.baseUrl).toBe('https://a.example/v2');
    expect(await keys.reveal(created.id)).toBe(KEY);
  });

  it('lets a keyless generic endpoint move origin without a key, since generic marks the key optional', async () => {
    const { profiles, keys } = store();
    const local = await profiles.create(endpoint('local', { apiKey: '' }));
    const moved = await profiles.update(local.id, { baseUrl: 'https://remote.example/v1' });
    expect(moved.baseUrl).toBe('https://remote.example/v1');
    expect(moved.hasKey).toBe(false);
    expect(await keys.has(local.id)).toBe(false);
  });

  it('replaces the stored key on update, and clears it only where the preset marks the key optional', async () => {
    const { profiles, keys } = store();
    const created = await profiles.create(endpoint('x'));
    await profiles.update(created.id, { apiKey: 'sk-replacement-123456' });
    expect(await keys.reveal(created.id)).toBe('sk-replacement-123456');
    const cleared = await profiles.update(created.id, { apiKey: '' });
    expect(cleared.hasKey).toBe(false);
    expect(await keys.has(created.id)).toBe(false);

    // A preset that requires a key refuses to end a save without one.
    const keyed = await profiles.create(endpoint('keyed', { preset: 'openai', apiKey: 'sk-o-1234567890' }));
    await expect(profiles.update(keyed.id, { apiKey: '' })).rejects.toMatchObject({ field: 'apiKey' });
    expect(await keys.reveal(keyed.id)).toBe('sk-o-1234567890');
  });
});

describe('custom headers (generic endpoints only)', () => {
  it('seals custom headers with the key and never puts the values on a view', async () => {
    const { profiles, keys } = store();
    const created = await profiles.create(
      endpoint('proxied', { customHeaders: { 'x-team': 'blue-42', 'x-proxy-secret': 'hunter2' } }),
    );
    expect(JSON.stringify(created)).not.toContain('hunter2');
    expect(JSON.stringify(profiles.list())).not.toContain('hunter2');
    expect(created).not.toHaveProperty('customHeaders');
    expect((await keys.revealPayload(created.id))?.customHeaders).toEqual({ 'x-team': 'blue-42', 'x-proxy-secret': 'hunter2' });
    expect((await keys.revealPayload(created.id))?.apiKey).toBe(KEY);
  });

  it('refuses custom headers on a named preset, on a mock, and with bad names or values', async () => {
    const { profiles } = store();
    await expect(
      profiles.create(endpoint('x', { preset: 'openai', customHeaders: { 'x-a': 'b' } })),
    ).rejects.toMatchObject({ field: 'customHeaders' });
    await expect(
      profiles.create({ name: 'm', kind: 'mock', customHeaders: { 'x-a': 'b' } }),
    ).rejects.toMatchObject({ field: 'customHeaders' });
    await expect(profiles.create(endpoint('x', { customHeaders: { 'bad name': 'v' } }))).rejects.toMatchObject({
      field: 'customHeaders',
    });
    await expect(profiles.create(endpoint('x', { customHeaders: { 'x-a': '  ' } }))).rejects.toMatchObject({
      field: 'customHeaders',
    });
    await expect(profiles.create(endpoint('x', { customHeaders: { 'x-a': 'v\nev' } }))).rejects.toMatchObject({
      field: 'customHeaders',
    });
  });

  it('merges header edits with the sealed key and clears them on null', async () => {
    const { profiles, keys } = store();
    const created = await profiles.create(endpoint('x', { customHeaders: { 'x-team': 'blue' } }));
    // A key-only update keeps the headers.
    await profiles.update(created.id, { apiKey: 'sk-next-123456' });
    expect((await keys.revealPayload(created.id))?.customHeaders).toEqual({ 'x-team': 'blue' });
    // A headers-only update keeps the key.
    await profiles.update(created.id, { customHeaders: { 'x-new': 'val-9' } });
    const payload = await keys.revealPayload(created.id);
    expect(payload?.apiKey).toBe('sk-next-123456');
    expect(payload?.customHeaders).toEqual({ 'x-new': 'val-9' });
    // null clears the headers; the key stays.
    await profiles.update(created.id, { customHeaders: null });
    expect((await keys.revealPayload(created.id))?.customHeaders).toBeUndefined();
    expect((await keys.revealPayload(created.id))?.apiKey).toBe('sk-next-123456');
  });

  it('lets a keyless generic endpoint seal custom headers, and remove drops the entry', async () => {
    const { profiles, keys } = store();
    const created = await profiles.create(endpoint('keyless', { apiKey: '', customHeaders: { 'x-team': 'blue' } }));
    expect(created.hasKey).toBe(false);
    expect((await keys.revealPayload(created.id))?.customHeaders).toEqual({ 'x-team': 'blue' });
    await profiles.remove(created.id);
    expect(await keys.has(created.id)).toBe(false);
  });
});

describe('the cached response-format probe (§5)', () => {
  it('clears the probe when the endpoint or the model changes, because the answer no longer applies', async () => {
    const { profiles } = store();
    const created = await profiles.create(endpoint('x'));
    profiles.recordProbe(created.id, { supportsJsonObject: true, probedAt: 1 });
    expect(profiles.get(created.id)?.responseFormat?.supportsJsonObject).toBe(true);

    const renamed = await profiles.update(created.id, { name: 'still the same endpoint' });
    expect(renamed.responseFormat?.supportsJsonObject).toBe(true);

    const moved = await profiles.update(created.id, { baseUrl: 'https://b.example/v1', apiKey: 'sk-moved-key-123456' });
    expect(moved.responseFormat).toBeUndefined();
  });

  it('clears the probe when the key changes', async () => {
    const { profiles } = store();
    const created = await profiles.create(endpoint('x'));
    profiles.recordProbe(created.id, { supportsJsonObject: false, probedAt: 1 });
    const rekeyed = await profiles.update(created.id, { apiKey: 'sk-new-key-123456' });
    expect(rekeyed.responseFormat).toBeUndefined();
  });
});

describe('local model presets (Ollama, LM Studio, llama.cpp)', () => {
  const local = (preset: string, extra: Record<string, unknown> = {}) => ({ name: `Local ${preset}`, kind: 'endpoint' as const, preset, ...extra });

  it.each([
    ['ollama', 'http://127.0.0.1:11434/v1'],
    ['lmstudio', 'http://127.0.0.1:1234/v1'],
    ['llamacpp', 'http://127.0.0.1:8080/v1'],
  ])('saves %s with no key and no address typed: the preset’s loopback http default, a model, no key', async (preset, baseUrl) => {
    const { profiles, keys } = store();
    const view = await profiles.create(local(preset));
    expect(view).toMatchObject({ preset, baseUrl, hasKey: false });
    expect(view.defaultModel).not.toBe('');
    expect(await keys.revealPayload(view.id)).toBeUndefined();
  });

  it('lets the writer change the port or the host within loopback, and normalises it', async () => {
    const { profiles } = store();
    const view = await profiles.create(local('ollama', { baseUrl: 'http://localhost:9999/v1/' }));
    expect(view.baseUrl).toBe('http://localhost:9999/v1');
    const moved = await profiles.update(view.id, { baseUrl: 'http://[::1]:11500/v1' });
    expect(moved.baseUrl).toBe('http://[::1]:11500/v1');
  });

  it.each(['http://192.168.1.20:11434/v1', 'http://box.local:11434/v1', 'http://127.evil.example/v1', 'http://127.0.0.1@evil.example/v1', 'https://api.openai.com/v1'])(
    'refuses %s on a create and on an edit, naming the base URL',
    async (baseUrl) => {
      const { profiles } = store();
      await expect(profiles.create(local('lmstudio', { baseUrl }))).rejects.toMatchObject({ code: 'invalid', field: 'baseUrl' });
      const view = await profiles.create(local('lmstudio'));
      await expect(profiles.update(view.id, { baseUrl })).rejects.toMatchObject({ code: 'invalid', field: 'baseUrl' });
      expect(profiles.get(view.id)?.baseUrl).toBe('http://127.0.0.1:1234/v1');
    },
  );

  it('keeps the generic endpoint and every hosted preset https only, loopback included', async () => {
    const { profiles } = store();
    await expect(profiles.create(endpoint('Generic', { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '' }))).rejects.toThrow(/https/);
    await expect(profiles.create(endpoint('Hosted', { preset: 'openai', baseUrl: 'http://127.0.0.1:11434/v1' }))).rejects.toThrow(/https/);
  });

  it('seals a key the writer sets on the server, and refuses to carry it to another origin', async () => {
    const { profiles, keys } = store();
    const view = await profiles.create(local('lmstudio', { apiKey: KEY }));
    expect(view.hasKey).toBe(true);
    expect((await keys.revealPayload(view.id))?.apiKey).toBe(KEY);
    await expect(profiles.update(view.id, { baseUrl: 'http://127.0.0.1:1235/v1' })).rejects.toMatchObject({ code: 'invalid', field: 'apiKey' });
  });

  it('takes no custom headers: those belong to the generic endpoint', async () => {
    const { profiles } = store();
    await expect(profiles.create(local('ollama', { customHeaders: { 'x-a': 'b' } }))).rejects.toMatchObject({ field: 'customHeaders' });
  });
});
