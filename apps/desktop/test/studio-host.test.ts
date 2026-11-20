/**
 * The host seam the studio app offers: a host is told when a provider key changes, and can supply keys this device has
 * none for. Installing what the host supplies is not itself a change, or the host would hear its own restore and commit
 * what it had just read back.
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

describe('the studio host seam', () => {
  it('installs the keys a host supplies without reporting them as changes, and tells the host about a save', async () => {
    const changed: string[] = [];
    const { service } = await ProviderService.open({
      db: null,
      vault: null,
      host: {
        keyChanged: (profileId) => changed.push(profileId),
        restore: async () => [{ profileId: 'prv_0000000001', payload: { apiKey: 'sk-restored' } }],
      },
    });
    expect(changed).toEqual([]);
    expect(await service.keys.reveal('prv_0000000001')).toBe('sk-restored');

    await service.keys.putPayload('prv_0000000002', { apiKey: 'sk-saved' });
    expect(changed).toEqual(['prv_0000000002']);
    await service.keys.remove('prv_0000000002');
    expect(changed).toEqual(['prv_0000000002', 'prv_0000000002']);
  });

  it('opens without a host exactly as the folder app does', async () => {
    const { service } = await ProviderService.open({ db: null, vault: null });
    await service.keys.put('prv_0000000003', 'sk-plain');
    expect(await service.keys.reveal('prv_0000000003')).toBe('sk-plain');
  });

  it('opens when the host cannot supply its keys, leaving the profiles to report what they lost', async () => {
    const changed: string[] = [];
    const { service } = await ProviderService.open({
      db: null,
      vault: null,
      host: {
        keyChanged: (profileId) => changed.push(profileId),
        restore: async () => { throw new Error('the account vault is unreachable'); },
      },
    });
    expect(changed).toEqual([]);
    await service.keys.put('prv_0000000004', 'sk-after');
    expect(changed).toEqual(['prv_0000000004']);
    // An MCP bearer token lives in the same store under its own reference, and it is not a provider key.
    await service.keys.put('mcp:server-one', 'token-value');
    expect(changed).toEqual(['prv_0000000004']);
  });

  it('does not report the keys it reads back while opening the stored studio', async () => {
    const db = memoryDb();
    const vault = new MemoryIndexedDb();
    const first = await ProviderService.open({ db, vault });
    const created = await first.service.profiles.create({ name: 'Endpoint', kind: 'endpoint', preset: 'openai', apiKey: 'sk-stored', defaultModel: 'gpt-test' });
    await first.service.persist();

    const changed: string[] = [];
    const second = await ProviderService.open({ db, vault, host: { keyChanged: (profileId) => changed.push(profileId) } });
    expect(changed).toEqual([]);
    expect(await second.service.keys.reveal(created.id)).toBe('sk-stored');
    await second.service.keys.put('prv_0000000005', 'sk-later');
    expect(changed).toEqual(['prv_0000000005']);
  });
});
