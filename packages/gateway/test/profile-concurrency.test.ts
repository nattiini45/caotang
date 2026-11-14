import { describe, expect, it, vi } from 'vitest';
import { createKeyStore, createMemoryVaultPort, createProfileStore, type NewProfile, type ProfilePatch } from '../src/index.js';
import { KEY } from './helpers.js';

describe('app-local profile request limits', () => {
  it('notifies only committed limit changes and isolates listener failures', async () => {
    const profiles = createProfileStore({ keys: createKeyStore(createMemoryVaultPort()) });
    const profile = await profiles.create({ name: 'Demo', kind: 'mock' });
    const changed = vi.fn();
    profiles.subscribeLimits?.(() => { throw new Error('observer failed'); });
    const unsubscribe = profiles.subscribeLimits?.(changed);
    expect(unsubscribe).toEqual(expect.any(Function));
    await expect(profiles.update(profile.id, { maxConcurrentRequests: 3 })).resolves.toMatchObject({ maxConcurrentRequests: 3 });
    expect(changed).toHaveBeenCalledExactlyOnceWith(profile.id);
    await profiles.update(profile.id, { name: 'Renamed', maxConcurrentRequests: 3 });
    await expect(profiles.update(profile.id, { maxConcurrentRequests: 0 })).rejects.toMatchObject({ field: 'maxConcurrentRequests' });
    expect(changed).toHaveBeenCalledTimes(1);
    unsubscribe?.();
    await profiles.update(profile.id, { maxConcurrentRequests: 4 });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('defaults legacy endpoint and mock inputs and preserves explicit edits on both kinds', async () => {
    const profiles = createProfileStore({ keys: createKeyStore(createMemoryVaultPort()) });
    const endpoint = await profiles.create({ name: 'Endpoint', kind: 'endpoint', baseUrl: 'https://a.example/v1', apiKey: KEY, defaultModel: 'model-x' });
    const mock = await profiles.create({ name: 'Demo', kind: 'mock' });
    expect(endpoint.maxConcurrentRequests).toBe(3);
    expect(mock.maxConcurrentRequests).toBe(8);
    for (const profile of [endpoint, mock]) {
      expect((await profiles.update(profile.id, { maxConcurrentRequests: 1 })).maxConcurrentRequests).toBe(1);
      expect((await profiles.update(profile.id, { name: 'Renamed' })).maxConcurrentRequests).toBe(1);
      expect((await profiles.update(profile.id, { maxConcurrentRequests: 8 })).maxConcurrentRequests).toBe(8);
      expect(profiles.get(profile.id)?.maxConcurrentRequests).toBe(8);
    }
  });

  it.each([0, -1, 9, 1.5, NaN, Infinity, null, '3', true, {}, []])('rejects malformed limit %j atomically on creation and update', async (value) => {
    const keys = createKeyStore(createMemoryVaultPort());
    const profiles = createProfileStore({ keys });
    for (const kind of ['endpoint', 'mock'] as const) {
      const input = { name: 'Valid', kind, baseUrl: kind === 'mock' ? 'mock://caotang' : 'https://a.example/v1', apiKey: KEY, defaultModel: 'model-x', maxConcurrentRequests: 2 };
      const saved = await profiles.create(input);
      const payload = await keys.revealPayload(saved.id);
      await expect(profiles.create({ ...input, maxConcurrentRequests: value } as NewProfile)).rejects.toMatchObject({ code: 'invalid', field: 'maxConcurrentRequests' });
      await expect(profiles.update(saved.id, { maxConcurrentRequests: value } as ProfilePatch)).rejects.toMatchObject({ code: 'invalid', field: 'maxConcurrentRequests' });
      expect(profiles.get(saved.id)).toEqual(saved);
      expect(await keys.revealPayload(saved.id)).toEqual(payload);
    }
    expect(profiles.list()).toHaveLength(2);
  });
});
