/**
 * The host seam the studio app offers: a host is told when a provider key changes and which endpoint origin that key may
 * be sent to, and can supply keys this device has none for. Installing what the host supplies is not itself a change, or
 * the host would hear its own restore and commit what it had just read back.
 */
import { describe, expect, it } from 'vitest';
import { MemoryIndexedDb } from '@caotang/store';
import { ProviderService } from '../src/app/providers.js';
import { APP_KEYS, type AppDb } from '../src/app/app-db.js';

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
        restore: async () => [{ profileId: 'prv_0000000001', payload: { apiKey: 'sk-restored' }, origin: 'https://a.example' }],
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

  it('leaves a key this device already has alone, so a save that has not reached the account is not undone', async () => {
    const db = memoryDb();
    const vault = new MemoryIndexedDb();
    const first = await ProviderService.open({ db, vault });
    const created = await first.service.profiles.create(endpoint('Endpoint', 'sk-newer-here'));
    await first.service.persist();

    // The account still holds the key this device replaced, because that save never reached it.
    const second = await ProviderService.open({
      db,
      vault,
      host: { restore: async () => [{ profileId: created.id, payload: { apiKey: 'sk-older-there' } }] },
    });
    expect(await second.service.keys.reveal(created.id)).toBe('sk-newer-here');
  });

  it('installs the account key for a profile whose entry cannot be opened any more', async () => {
    const db = memoryDb();
    const first = await ProviderService.open({ db, vault: new MemoryIndexedDb() });
    const created = await first.service.profiles.create(endpoint('Endpoint', 'sk-only-on-account'));
    await first.service.persist();

    // A fresh vault stands in for site data cleared out from under the entry: the profile is here, its key is not readable.
    const second = await ProviderService.open({
      db,
      vault: new MemoryIndexedDb(),
      host: { restore: async () => [{ profileId: created.id, payload: { apiKey: 'sk-from-account' } }] },
    });
    expect(await second.service.keys.reveal(created.id)).toBe('sk-from-account');
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

  it('adds models to a profile whose key lives in the account vault, without the writer entering it again', async () => {
    const db = memoryDb();
    const vault = new MemoryIndexedDb();
    // An earlier build saved one model and no list; its key is only on the account, as a hosted writer's is.
    const first = await ProviderService.open({ db, vault });
    const created = await first.service.profiles.create(endpoint('Endpoint', 'sk-vaulted'));
    await first.service.persist();
    await first.service.keys.remove(created.id);

    const second = await ProviderService.open({
      db,
      vault,
      host: { restore: async (origins) => [...origins].some(([id]) => id === created.id) ? [{ profileId: created.id, payload: { apiKey: 'sk-vaulted' } }] : [] },
    });
    expect(await second.service.keys.reveal(created.id)).toBe('sk-vaulted');

    // Picking more models under that one key is a profile write: the id, the origin and the sealed key are untouched, so the
    // account's copy stays openable and nothing asks for the key again.
    const extended = await second.service.profiles.update(created.id, { pickedModels: ['model-x', 'model-y'] });
    expect(extended.id).toBe(created.id);
    expect(extended.pickedModels).toEqual(['model-x', 'model-y']);
    expect(await second.service.keys.reveal(created.id)).toBe('sk-vaulted');
    await second.service.persist();

    const third = await ProviderService.open({
      db,
      vault,
      host: { restore: async () => [{ profileId: created.id, payload: { apiKey: 'sk-vaulted' } }] },
    });
    const restored = third.service.get(created.id);
    expect(restored?.pickedModels).toEqual(['model-x', 'model-y']);
    expect(await third.service.keys.reveal(created.id)).toBe('sk-vaulted');
    expect(JSON.stringify(await db.get(APP_KEYS.profiles))).not.toContain('sk-vaulted');
  });

  it('does not report the keys it reads back while opening the stored studio', async () => {
    const db = memoryDb();
    const vault = new MemoryIndexedDb();
    const first = await ProviderService.open({ db, vault });
    const created = await first.service.profiles.create(endpoint('Endpoint', 'sk-stored'));
    await first.service.persist();

    const seen: { profileId: string; change: unknown }[] = [];
    const asked: string[][] = [];
    const second = await ProviderService.open({
      db,
      vault,
      host: {
        keyChanged: (profileId, change) => seen.push({ profileId, change }),
        // The studio names where each stored profile points, so a key cannot come back for an address it was not entered at.
        restore: async (origins) => { asked.push([...origins].map(([id, origin]) => `${id} ${origin}`)); return []; },
      },
    });
    expect(asked).toEqual([[`${created.id} https://a.example`]]);
    expect(seen).toEqual([]);
    expect(await second.service.keys.reveal(created.id)).toBe('sk-stored');
    await second.service.profiles.create(endpoint('Second', 'sk-later'));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.change).toMatchObject({ origin: 'https://a.example', payload: { apiKey: 'sk-later' } });
  });
});
