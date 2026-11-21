/**
 * The storage scope: the folder app keeps its fixed store names, and a hosted shell's accounts get a store each. The
 * names are what the isolation rests on, so they are asserted here rather than only through a browser.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyManifest, createProjectState, listProjectIds, MemoryIndexedDb, openRuntimeStore, RUNTIME_DB_NAME, writeProjectState } from '@caotang/store';
import { openAppDb } from '../src/app/app-db.js';
import { ProviderService } from '../src/app/providers.js';
import { scopedStoreName, setStorageScope, storageScope } from '../src/app/storage-scope.js';

afterEach(() => setStorageScope(null));

describe('the studio storage scope', () => {
  it('keeps the fixed names when nothing names the studio', () => {
    expect(storageScope()).toBeNull();
    expect(scopedStoreName('caotang-app')).toBe('caotang-app');
    expect(scopedStoreName(RUNTIME_DB_NAME)).toBe(RUNTIME_DB_NAME);
  });

  it('names a store after the account when one is set, and forgets it again', () => {
    setStorageScope('github:201');
    expect(scopedStoreName('caotang-app')).toBe('caotang-app--github:201');
    setStorageScope('');
    expect(storageScope()).toBeNull();
    expect(scopedStoreName('caotang-app')).toBe('caotang-app');
  });

  it('opens the app database under its fixed name when no scope is set', async () => {
    const factory = new MemoryIndexedDb();
    const db = await openAppDb(factory);
    await db.put('settings', { kind: 'classic' });
    db.close();

    // A second open reads what the first wrote, so the default name is the name the app has always used.
    const again = await openAppDb(factory);
    expect(await again.get('settings')).toEqual({ kind: 'classic' });
  });

  it("gives each account its own app database, so one account's settings are not the other's", async () => {
    const factory = new MemoryIndexedDb();

    setStorageScope('github:201');
    const mine = await openAppDb(factory);
    await mine.put('settings', { kind: 'classic', locale: 'de' });
    mine.close();

    setStorageScope('github:202');
    const other = await openAppDb(factory);
    expect(await other.get('settings')).toBeUndefined();
    await other.put('settings', { kind: 'modern', locale: 'en' });
    other.close();

    setStorageScope('github:201');
    const back = await openAppDb(factory);
    expect(await back.get('settings')).toEqual({ kind: 'classic', locale: 'de' });
    expect(await back.get(`caotang--github:202`)).toBeUndefined();
  });

  it('gives each account its own provider key vault, so a key sealed for one does not answer for the other', async () => {
    const factory = new MemoryIndexedDb();

    setStorageScope('github:201');
    const mine = await ProviderService.open({ db: null, vault: factory });
    await mine.service.keys.put('prv_0000000001', 'sk-mine');

    setStorageScope('github:202');
    const other = await ProviderService.open({ db: null, vault: factory });
    expect(await other.service.keys.reveal('prv_0000000001')).toBeUndefined();
    await other.service.keys.put('prv_0000000001', 'sk-theirs');

    setStorageScope('github:201');
    const back = await ProviderService.open({ db: null, vault: factory });
    expect(await back.service.keys.reveal('prv_0000000001')).toBe('sk-mine');
  });

  it("gives each account its own runtime store, so one account cannot list the other's projects", async () => {
    const factory = new MemoryIndexedDb();
    const now = new Date(0);

    setStorageScope('github:201');
    const mine = await openRuntimeStore(factory, scopedStoreName(RUNTIME_DB_NAME));
    expect(mine.name).toBe('caotang--github:201');
    const state = createProjectState(createEmptyManifest('Mine', now), { now });
    await writeProjectState(mine, state);
    const id = state.manifest.project.id;
    mine.close();

    setStorageScope('github:202');
    const other = await openRuntimeStore(factory, scopedStoreName(RUNTIME_DB_NAME));
    expect(other.name).toBe('caotang--github:202');
    expect(await listProjectIds(other)).toEqual([]);
    other.close();

    setStorageScope('github:201');
    const back = await openRuntimeStore(factory, scopedStoreName(RUNTIME_DB_NAME));
    expect(await listProjectIds(back)).toEqual([id]);
  });
});
