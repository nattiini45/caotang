import { describe, expect, it } from 'vitest';
import { createKeyStore, createMemoryVaultPort, createProfileStore, type NewProfile, type ProfilePatch } from '../src/index.js';
import { KEY } from './helpers.js';

describe('profile fields that are now automatic', () => {
  const legacy = { maxConcurrentRequests: 5, promptCache: { mode: 'off', ttl: '1h' } };

  it('ignores the removed request-limit and caching fields on creation and update, and never reports them', async () => {
    const profiles = createProfileStore({ keys: createKeyStore(createMemoryVaultPort()) });
    const input = { name: 'Endpoint', kind: 'endpoint', baseUrl: 'https://a.example/v1', apiKey: KEY, defaultModel: 'model-x', ...legacy } as NewProfile;
    const made = await profiles.create(input);
    expect(made).not.toHaveProperty('maxConcurrentRequests');
    expect(made).not.toHaveProperty('promptCache');
    const changed = await profiles.update(made.id, { name: 'Renamed', ...legacy } as ProfilePatch);
    expect(changed.name).toBe('Renamed');
    expect(changed).not.toHaveProperty('maxConcurrentRequests');
    expect(changed).not.toHaveProperty('promptCache');
  });

  it('does not refuse a mock profile for a malformed removed field', async () => {
    const profiles = createProfileStore({ keys: createKeyStore(createMemoryVaultPort()) });
    const made = await profiles.create({ name: 'Demo', kind: 'mock', maxConcurrentRequests: 99, promptCache: null } as unknown as NewProfile);
    expect(made.kind).toBe('mock');
    expect(made).not.toHaveProperty('maxConcurrentRequests');
  });
});
