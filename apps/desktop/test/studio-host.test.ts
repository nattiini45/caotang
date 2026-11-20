/**
 * The host seam the studio app offers: a host is told when a provider key changes, and can supply keys this device has
 * none for. Installing what the host supplies is not itself a change, or the host would hear its own restore and commit
 * what it had just read back.
 */
import { describe, expect, it } from 'vitest';
import { ProviderService } from '../src/app/providers.js';

describe('the studio host seam', () => {
  it('installs the keys a host supplies without reporting them as changes, and tells the host about a save', async () => {
    const changed: string[] = [];
    const { service } = await ProviderService.open({
      db: null,
      vault: null,
      host: {
        keyChanged: (profileId) => changed.push(profileId),
        restore: async () => [{ profileId: 'prv_RESTORED', payload: { apiKey: 'sk-restored' } }],
      },
    });
    expect(changed).toEqual([]);
    expect(await service.keys.reveal('prv_RESTORED')).toBe('sk-restored');

    await service.keys.putPayload('prv_SAVED', { apiKey: 'sk-saved' });
    expect(changed).toEqual(['prv_SAVED']);
    await service.keys.remove('prv_SAVED');
    expect(changed).toEqual(['prv_SAVED', 'prv_SAVED']);
  });

  it('opens without a host exactly as the folder app does', async () => {
    const { service } = await ProviderService.open({ db: null, vault: null });
    await service.keys.put('prv_PLAIN', 'sk-plain');
    expect(await service.keys.reveal('prv_PLAIN')).toBe('sk-plain');
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
    await service.keys.put('prv_AFTER', 'sk-after');
    expect(changed).toEqual(['prv_AFTER']);
  });
});
