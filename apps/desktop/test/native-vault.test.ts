/**
 * The page's side of the keychain (#404): what `openDesktopKeys` does with the bridge, and what the move out of this browser's
 * sealed vault comes to. The host's half — sealing, the file, read-back, undo — is `packages/gateway/test/os-vault.test.ts`;
 * here the bridge is a scripted Map, so the wiring is what is under test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryIndexedDb } from '@caotang/store';
import { createIndexedDbVaultPort, createKeyStore, keyHandle, PROVIDER_KEY_DB_NAME } from '@caotang/gateway';

import { openDesktopKeys } from '../src/app/native-vault.js';
import { scopedStoreName } from '../src/app/storage-scope.js';

const ID = 'prv_ABCDEFGHJK';
const KEY = 'sk-live-0123456789abcdef';

interface Scripted {
  readonly held: Map<string, { apiKey: string; customHeaders?: Record<string, string> }>;
  /** The address each held key belongs to: what the shell records, and what a request may carry a key to. */
  readonly bindings: Map<string, string>;
  readonly calls: string[];
}

/**
 * The main process as the page sees it: the channels, over a Map, with the address rule the shell keeps — a second `put` for
 * another address is refused, a replacement moves it, and `bind` only fills a missing one.
 */
function scriptedVault(options: { available?: boolean; failPut?: boolean; failBind?: boolean } = {}): Scripted & { bridge: NonNullable<Window['caotangDesktop']>['vault'] } {
  const held = new Map<string, { apiKey: string; customHeaders?: Record<string, string> }>();
  const bindings = new Map<string, string>();
  const calls: string[] = [];
  const ok = <T,>(value: T) => Promise.resolve({ ok: true as const, value });
  const refused = Promise.resolve({ ok: false as const, error: 'unavailable' as const });
  return {
    held,
    bindings,
    calls,
    bridge: {
      available: () => { calls.push('available'); return ok(options.available ?? true); },
      put: (id, payload, origin) => {
        calls.push(`put:${id}`);
        if (options.failPut === true) return refused;
        const bound = bindings.get(id);
        if (bound !== undefined && bound !== origin) return Promise.resolve({ ok: false as const, error: 'invalid' as const });
        bindings.set(id, origin);
        held.set(id, payload);
        return ok(null);
      },
      putReplacement: (id, payload, origin) => {
        calls.push(`putReplacement:${id}`);
        if (options.failPut === true) return refused;
        bindings.set(id, origin);
        held.set(id, payload);
        return ok(null);
      },
      bind: (id, origin) => {
        calls.push(`bind:${id}`);
        if (options.failBind === true) return refused;
        if (held.has(id) && !bindings.has(id)) bindings.set(id, origin);
        return ok(null);
      },
      remove: (id) => { calls.push(`remove:${id}`); held.delete(id); bindings.delete(id); return ok(null); },
      has: (id) => { calls.push(`has:${id}`); return ok(held.has(id)); },
      revision: (id) => ok(`rev-${held.get(id)?.apiKey ?? 'empty'}`),
      restore: (id) => { calls.push(`restore:${id}`); return ok(null); },
      headers: (id) => ok(held.has(id) ? (held.get(id)?.customHeaders ?? {}) : null),
    },
  };
}

function withBridge(vault: NonNullable<Window['caotangDesktop']>['vault'] | undefined): void {
  vi.stubGlobal('window', vault === undefined ? {} : { caotangDesktop: { version: 6, vault } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Every key these tests know is for one address; a key whose profile is gone is covered by its own case. */
const ORIGIN = 'https://api.example.com';
const originsOfEveryKey = (): Map<string, string> => new Map([[ID, ORIGIN], ['mcp:one', 'https://mcp.example.com']]);

describe('a page in the desktop app', () => {
  it('has no key store when the machine has no keychain, and says so', async () => {
    withBridge(scriptedVault({ available: false }).bridge);
    expect(await openDesktopKeys(null, originsOfEveryKey())).toEqual({ kind: 'unavailable' });
  });

  it('has no key store at all in a browser', async () => {
    withBridge(undefined);
    expect(await openDesktopKeys(null, originsOfEveryKey())).toEqual({ kind: 'none' });
  });

  it('answers a stored key with a handle, and never with the key', async () => {
    const scripted = scriptedVault();
    withBridge(scripted.bridge);
    const opened = await openDesktopKeys(null, originsOfEveryKey());
    expect(opened.kind).toBe('keychain');
    if (opened.kind !== 'keychain') return;
    await opened.store.put(ID, KEY, ORIGIN);
    expect(scripted.held.get(ID)?.apiKey).toBe(KEY);
    expect(scripted.bindings.get(ID)).toBe(ORIGIN);
    expect(await opened.store.reveal(ID)).toBe(keyHandle(ID));
    expect(JSON.stringify(await opened.store.revealPayload(ID))).not.toContain(KEY);
    expect(await opened.store.has(ID)).toBe(true);
    await opened.store.remove(ID);
    expect(await opened.store.reveal(ID)).toBeUndefined();
  });

  it('keeps the extra header values the writer typed beside the key', async () => {
    const scripted = scriptedVault();
    withBridge(scripted.bridge);
    const opened = await openDesktopKeys(null, originsOfEveryKey());
    if (opened.kind !== 'keychain') throw new Error('expected the keychain');
    await opened.store.putPayload(ID, { apiKey: KEY, customHeaders: { 'x-workspace': 'w1' } }, ORIGIN);
    expect(await opened.store.revealPayload(ID)).toEqual({ apiKey: keyHandle(ID), customHeaders: { 'x-workspace': 'w1' } });
  });

  it('cannot store anything when the keychain refuses, and does not pretend a key is there', async () => {
    withBridge(scriptedVault({ failPut: true }).bridge);
    const opened = await openDesktopKeys(null, originsOfEveryKey());
    if (opened.kind !== 'keychain') throw new Error('expected the keychain');
    await expect(opened.store.put(ID, KEY, ORIGIN)).rejects.toThrow(/keychain did not answer/u);
    expect(await opened.store.has(ID)).toBe(false);
  });
});

describe('the keys an earlier version sealed in this browser', () => {
  it('moves them: written, read back, then deleted from the browser', async () => {
    const factory = new MemoryIndexedDb();
    const legacy = createKeyStore(createIndexedDbVaultPort({ factory, name: scopedStoreName(PROVIDER_KEY_DB_NAME) }));
    await legacy.put(ID, KEY);
    await legacy.put('mcp:one', 'fixture-token');

    const scripted = scriptedVault();
    withBridge(scripted.bridge);
    const opened = await openDesktopKeys(factory as unknown as IDBFactory, originsOfEveryKey());
    expect(opened).toMatchObject({ kind: 'keychain', moved: 2, failed: false });
    expect(scripted.held.get(ID)?.apiKey).toBe(KEY);
    expect(scripted.held.get('mcp:one')?.apiKey).toBe('fixture-token');

    // The browser's copy is gone only after the keychain had it.
    expect(await legacy.entryIds?.()).toEqual([]);
  });

  it('leaves a key in the browser when the keychain refuses it, and says the move failed', async () => {
    const factory = new MemoryIndexedDb();
    const legacy = createKeyStore(createIndexedDbVaultPort({ factory, name: scopedStoreName(PROVIDER_KEY_DB_NAME) }));
    await legacy.put(ID, KEY);

    withBridge(scriptedVault({ failPut: true }).bridge);
    const opened = await openDesktopKeys(factory as unknown as IDBFactory, originsOfEveryKey());
    expect(opened).toMatchObject({ kind: 'keychain', moved: 0, failed: true });
    // A key that did not arrive is still in the browser, so the next open tries again rather than losing it.
    expect(await legacy.reveal(ID)).toBe(KEY);
  });

  it('moves keys and reports nothing when the browser had none', async () => {
    const factory = new MemoryIndexedDb();
    const scripted = scriptedVault();
    withBridge(scripted.bridge);
    expect(await openDesktopKeys(factory as unknown as IDBFactory, originsOfEveryKey())).toMatchObject({ kind: 'keychain', moved: 0, failed: false });
    expect(scripted.held.size).toBe(0);
  });
});

describe('the keys an earlier version left in the keychain', () => {
  it('gives a held key the address its own record names, so it is not denied after the upgrade', async () => {
    const scripted = scriptedVault();
    // A key the keychain held before the addresses were kept: present, and belonging nowhere.
    scripted.held.set(ID, { apiKey: KEY });
    withBridge(scripted.bridge);
    expect(await openDesktopKeys(null, originsOfEveryKey())).toMatchObject({ kind: 'keychain', moved: 0, failed: false });
    expect(scripted.bindings.get(ID)).toBe(ORIGIN);
    expect(scripted.calls).toContain(`bind:${ID}`);
  });

  it('leaves a key with no record of where it belongs unbound rather than guessing an address', async () => {
    const scripted = scriptedVault();
    scripted.held.set('prv_NOBODYHOME', { apiKey: KEY });
    withBridge(scripted.bridge);
    await openDesktopKeys(null, new Map([[ID, ORIGIN]]));
    // Nothing named this id's address, so nothing was recorded for it: a key with no address is refused, not sent anywhere.
    expect(scripted.bindings.has('prv_NOBODYHOME')).toBe(false);
    expect(scripted.calls).not.toContain('bind:prv_NOBODYHOME');
  });

  it('opens anyway when the keychain will not record an address, and says the move failed for a browser key', async () => {
    const scripted = scriptedVault({ failBind: true });
    scripted.held.set(ID, { apiKey: KEY });
    withBridge(scripted.bridge);
    expect(await openDesktopKeys(null, originsOfEveryKey())).toMatchObject({ kind: 'keychain', moved: 0, failed: false });
    expect(scripted.bindings.has(ID)).toBe(false);
  });
});
