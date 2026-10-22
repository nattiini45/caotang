import { describe, expect, it } from 'vitest';

import { createNodeProviders } from '../src/providers.js';
import { TEST_PROFILE } from './endpoint.js';

const KEY = 'sk-sealed-key-123456';

describe('the provider set-up', () => {
  it("'mock' is the demo profile: active, no key, no network", async () => {
    const providers = await createNodeProviders({ provider: 'mock' });
    expect(providers.profile.kind).toBe('mock');
    expect(providers.gateway.profiles.active()?.id).toBe(providers.profile.id);
    expect(providers.role).toBe('chat');
  });

  it('seals the key, reads a thunk once, and shows it on no view', async () => {
    let reads = 0;
    const providers = await createNodeProviders({
      provider: {
        profile: TEST_PROFILE,
        apiKey: () => {
          reads += 1;
          return KEY;
        },
      },
      fetch: async () => new Response('{}', { status: 500 }),
    });
    expect(reads).toBe(1);
    expect(JSON.stringify(providers.profile)).not.toContain(KEY);
    expect(JSON.stringify(providers.gateway.profiles.list())).not.toContain(KEY);
  });

  it('opens a profile with no key, for a server that needs none, and refuses an address it may not send a key to', async () => {
    expect((await createNodeProviders({ provider: { profile: TEST_PROFILE, apiKey: () => undefined } })).profile.hasKey).toBe(false);
    await expect(createNodeProviders({ provider: { profile: { ...TEST_PROFILE, baseUrl: 'http://insecure.example.test/v1' }, apiKey: 'k-123456789' } })).rejects.toThrow(/https/i);
  });

  it('carries the model, the thinking level and the role the caller named', async () => {
    const providers = await createNodeProviders({
      provider: { profile: TEST_PROFILE, apiKey: 'k-123456789', model: 'other', thinking: 'low', role: 'drafting' },
    });
    expect([providers.model, providers.thinking, providers.role]).toEqual(['other', 'low', 'drafting']);
  });
});
