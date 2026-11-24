/**
 * A settings database that will not hand back the saved profiles at start-up (providers.ts, #873 review F9): the session must
 * open with the demo profile and a notice, and must never put its own short list over records it never saw.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { ProviderService } from '../src/app/providers.js';
import { APP_KEYS, type AppDb } from '../src/app/app-db.js';
import { activateEnglish } from '../src/i18n/runtime.js';

beforeAll(() => activateEnglish());

/** What an earlier run saved: a generic endpoint, whose key is optional, so it restores on a vault with nothing in it. */
const SAVED = [{ id: 'prv_ABCDEFGHJK', name: 'Saved endpoint', kind: 'endpoint', preset: 'generic', baseUrl: 'https://api.example.com/v1', defaultModel: 'model-x', isActive: true, hasKey: false }];

/** `once` is a transaction that aborted on its first try, which a second read is allowed to get past. */
function memoryDb(options: { failProfiles?: boolean | 'once' } = {}): AppDb & { readonly rows: Map<string, unknown>; readonly writes: string[] } {
  const rows = new Map<string, unknown>([[APP_KEYS.profiles, structuredClone(SAVED)]]);
  const writes: string[] = [];
  let failures = 0;
  return {
    rows,
    writes,
    async get<T>(key: string) {
      if (key === APP_KEYS.profiles) {
        const failing = options.failProfiles === true || (options.failProfiles === 'once' && failures === 0);
        if (failing) {
          failures += 1;
          throw new Error('The transaction aborted.');
        }
      }
      return structuredClone(rows.get(key)) as T | undefined;
    },
    async put(key, value) { writes.push(key); rows.set(key, structuredClone(value)); },
    async delete(key) { writes.push(key); rows.delete(key); },
    async list() { return []; },
    close() {},
  };
}

describe('the saved profiles when the database will not hand them back', () => {
  it('opens with the demo profile and keeps the records it could not read', async () => {
    const db = memoryDb({ failProfiles: true });
    const { service, notices } = await ProviderService.open({ db, vault: null });

    expect(notices.join(' ')).toContain('Your provider profiles could not be read');
    // The session still has a profile to work with, and the stored records are untouched.
    expect(service.list().map((profile) => profile.kind)).toEqual(['mock']);
    expect(db.rows.get(APP_KEYS.profiles)).toEqual(SAVED);
    expect(db.writes).not.toContain(APP_KEYS.profiles);
  });

  it('still saves everything that is not the profile list', async () => {
    const db = memoryDb({ failProfiles: true });
    const { service } = await ProviderService.open({ db, vault: null });
    const error = await service.persist();
    expect(error).toBeNull();
    expect(db.rows.get(APP_KEYS.profiles)).toEqual(SAVED);
    expect(db.writes).toContain(APP_KEYS.usage);
  });

  it('gets past a read that failed once, so a momentary abort does not cost the session its profiles', async () => {
    const db = memoryDb({ failProfiles: 'once' });
    const { service, notices } = await ProviderService.open({ db, vault: null });
    expect(notices.join(' ')).not.toContain('could not be read');
    expect(service.list().map((profile) => profile.name)).toEqual(['Saved endpoint']);
  });

  it('refuses a change to the profiles instead of reporting one that cannot be saved', async () => {
    const db = memoryDb({ failProfiles: true });
    const { service } = await ProviderService.open({ db, vault: null });
    await expect(service.addProfile({
      name: 'Another', kind: 'endpoint', preset: 'generic', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-typed', defaultModel: 'model-x',
    })).rejects.toThrow(/could not read your saved provider settings/u);
    await expect(service.remove(service.list()[0]!.id)).rejects.toThrow(/could not read your saved provider settings/u);
    // Nothing was changed and nothing was written over the records that could not be read.
    expect(service.list().map((profile) => profile.kind)).toEqual(['mock']);
    expect(db.rows.get(APP_KEYS.profiles)).toEqual(SAVED);
    expect(db.writes).not.toContain(APP_KEYS.profiles);
  });

  it('restores the saved profiles when the database answers, and adds no demo of its own', async () => {
    const db = memoryDb();
    const { service, notices } = await ProviderService.open({ db, vault: null });
    expect(notices.join(' ')).not.toContain('could not be read');
    expect(service.list().map((profile) => profile.name)).toEqual(['Saved endpoint']);
    expect(service.list()[0]?.id).toBe('prv_ABCDEFGHJK');
  });
});
