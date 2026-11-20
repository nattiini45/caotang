/**
 * The host seam the studio app offers: a host is told when a provider key changes and which endpoint origin that key may
 * be sent to, and can supply keys this device has none for. Installing what the host supplies is not itself a change, or
 * the host would hear its own restore and commit what it had just read back.
 */
import { describe, expect, it } from 'vitest';
import { MemoryIndexedDb } from '@caotang/store';
import { ProviderService } from '../src/app/providers.js';
import type { AppDb } from '../src/app/app-db.js';

function memoryDb(): AppDb {
  const rows = new Map<string, unknown>();
  return {
    async get<T>(key: string) { return structuredClone(rows.get(key)) as T | undefined; },
    async put(key, value) { rows.set(key, structuredClone(value)); },
    async delete(key) { rows.delete(key); },
    async list<T>(prefix: string) { return [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T })); },
    close() {},
  };
}

const endpoint = (name: string, apiKey: string, baseUrl = 'https://a.example/v1') => ({ name, kind: 'endpoint' as const, baseUrl, apiKey, defaultModel: 'model-x' });

describe('the studio host seam', () => {
  it('installs the keys a host supplies without reporting them, and tells the host about a save', async () => {
    const seen: { profileId: string; change: unknown }[] = [];
    const { service } = await ProviderService.open({
      db: null,
      vault: null,
      host: {
        keyChanged: (profileId, change) => seen.push({ profileId, change }),
        restore: async () => [{ profileId: 'prv_0000000001', payload: { apiKey: 'sk-restored' } }],
      },
    });
    expect(seen).toEqual([]);
    expect(await service.keys.reveal('prv_0000000001')).toBe('sk-restored');

    const created = await service.profiles.create(endpoint('Endpoint', 'sk-saved'));
    expect(seen).toEqual([{ profileId: created.id, change: { origin: 'https://a.example', payload: { apiKey: 'sk-saved' } } }]);
  });

  it('opens without a host exactly as the folder app does', async () => {
    const { service } = await ProviderService.open({ db: null, vault: null });
    const created = await service.profiles.create(endpoint('Endpoint', 'sk-plain'));
    expect(await service.keys.reveal(created.id)).toBe('sk-plain');
  });

  it('opens when the host cannot supply its keys, leaving the profiles to report what they lost', async () => {
    const seen: { profileId: string; change: unknown }[] = [];
    const { service } = await ProviderService.open({
      db: null,
      vault: null,
      host: {
        keyChanged: (profileId, change) => seen.push({ profileId, change }),
        restore: async () => { throw new Error('the account vault is unreachable'); },
      },
    });
    expect(seen).toEqual([]);
    const created = await service.profiles.create(endpoint('Endpoint', 'sk-after'));
    expect(seen).toHaveLength(1);
    // An MCP bearer token lives in the same key store under its own reference and never becomes a profile, so no host
    // can be told about it.
    await service.keys.put('mcp:server-one', 'token-value');
    expect(seen).toEqual([{ profileId: created.id, change: { origin: 'https://a.example', payload: { apiKey: 'sk-after' } } }]);
  });

  it('does not report the keys it reads back while opening the stored studio', async () => {
    const db = memoryDb();
    const vault = new MemoryIndexedDb();
    const first = await ProviderService.open({ db, vault });
    const created = await first.service.profiles.create(endpoint('Endpoint', 'sk-stored'));
    await first.service.persist();

    const seen: { profileId: string; change: unknown }[] = [];
    const second = await ProviderService.open({ db, vault, host: { keyChanged: (profileId, change) => seen.push({ profileId, change }) } });
    expect(seen).toEqual([]);
    expect(await second.service.keys.reveal(created.id)).toBe('sk-stored');
    await second.service.profiles.create(endpoint('Second', 'sk-later'));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.change).toMatchObject({ origin: 'https://a.example', payload: { apiKey: 'sk-later' } });
  });
});
