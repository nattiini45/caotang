/**
 * The key store of a host that keeps the keys itself — desktop.md §The keychain. What is asserted here is the whole promise:
 * the page can store, replace, check and remove a key, and what it gets back when it asks for one is a handle, never the key.
 */

import { describe, expect, it } from 'vitest';
import { keyHandle, nativeKeyStore, type NativeKeyVault } from '../src/index.js';
import type { KeyPayload } from '../src/keys/key-store.js';

/** A vault that behaves like the main process's: it holds payloads, and answers revisions the way a sealed record does. */
function vault(): NativeKeyVault & { readonly held: Map<string, KeyPayload>; readonly undos: string[] } {
  const held = new Map<string, KeyPayload>();
  const undos: string[] = [];
  let saved: Map<string, KeyPayload> = new Map();
  return {
    held,
    undos,
    available: async () => true,
    async put(id, payload) {
      saved = new Map(held);
      held.set(id, payload);
    },
    async putHeaders(id, headers) {
      const payload = held.get(id);
      if (payload === undefined) return;
      held.set(id, { apiKey: payload.apiKey, ...(Object.keys(headers).length === 0 ? {} : { customHeaders: { ...headers } }) });
    },
    async headers(id) {
      const payload = held.get(id);
      return payload === undefined ? undefined : { ...(payload.customHeaders ?? {}) };
    },
    async keyState(id) {
      const payload = held.get(id);
      return payload === undefined ? 'none' : payload.apiKey === '' ? 'empty' : 'key';
    },
    async revision(id) {
      const payload = held.get(id);
      return payload === undefined ? 'empty' : `rev-${payload.apiKey}`;
    },
    has: async (id) => held.has(id),
    async remove(id) {
      held.delete(id);
    },
    async restore(id) {
      undos.push(id);
      held.clear();
      for (const [key, payload] of saved) held.set(key, payload);
    },
  };
}

const ID = 'prv_ABCDEFGHJK';
const TOKEN = 'mcp:one-token';
const KEY = 'sk-live-0123456789abcdef';

describe('a key the host holds', () => {
  it('answers a stored key with a handle, never with the key', async () => {
    const store = nativeKeyStore(vault());
    await store.put(ID, KEY);
    expect(await store.has(ID)).toBe(true);
    expect(await store.reveal(ID)).toBe(keyHandle(ID));
    expect(JSON.stringify(await store.revealPayload(ID))).not.toContain(KEY);
  });

  it('answers an unknown key with nothing, so a profile without one is named instead of tried', async () => {
    const store = nativeKeyStore(vault());
    expect(await store.reveal(ID)).toBeUndefined();
    expect(await store.revealPayload(ID)).toBeUndefined();
    expect(await store.has(ID)).toBe(false);
    expect(await store.credentialRevision(ID)).toBe('empty');
  });

  it('gives the page the extra header values it typed, and still not the key', async () => {
    const store = nativeKeyStore(vault());
    await store.putPayload(ID, { apiKey: KEY, customHeaders: { 'x-workspace': 'w1' } });
    const payload = await store.revealPayload(ID);
    expect(payload).toEqual({ apiKey: keyHandle(ID), customHeaders: { 'x-workspace': 'w1' } });
  });

  it('keeps the stored key when the payload it was given comes back with the handle in it (#863)', async () => {
    const held = vault();
    const store = nativeKeyStore(held);
    await store.putPayload(ID, { apiKey: KEY, customHeaders: { 'x-team': 'one' } });
    // Reading a key and writing it back is how an edit that changes only the headers arrives: the key it saw is the handle.
    const read = await store.revealPayload(ID);
    expect(read?.apiKey).toBe(keyHandle(ID));
    await store.putPayload(ID, { ...read!, customHeaders: { 'x-team': 'two' } });
    // The stored secret is untouched, and the headers are the ones the edit wrote.
    expect(held.held.get(ID)?.apiKey).toBe(KEY);
    expect(held.held.get(ID)?.customHeaders).toEqual({ 'x-team': 'two' });
    expect(JSON.stringify(await store.revealPayload(ID))).not.toContain(KEY);
  });

  it('answers a headers-only entry with its empty key, and keeps it when the payload comes back (#868)', async () => {
    const held = vault();
    const store = nativeKeyStore(held);
    await store.putPayload(ID, { apiKey: '', customHeaders: { 'x-workspace': 'w1' } });
    // The page stored an empty key, so the empty key is what it reads back: a handle would name a secret there is none of.
    const read = await store.revealPayload(ID);
    expect(read).toEqual({ apiKey: '', customHeaders: { 'x-workspace': 'w1' } });
    expect(await store.reveal(ID)).toBe('');
    // Writing the payload back with new headers keeps the entry and its empty key.
    await store.putPayload(ID, { ...read!, customHeaders: { 'x-workspace': 'w2' } });
    expect(held.held.get(ID)).toEqual({ apiKey: '', customHeaders: { 'x-workspace': 'w2' } });
    // A handle is still not a secret, whatever else the entry holds.
    await expect(store.put(ID, keyHandle(ID))).rejects.toThrow(/handle is not a secret/u);
    expect(held.held.get(ID)).toEqual({ apiKey: '', customHeaders: { 'x-workspace': 'w2' } });
  });

  it('refuses a handle where a key belongs, because a handle names a secret rather than being one', async () => {
    const held = vault();
    const store = nativeKeyStore(held);
    await expect(store.put(ID, keyHandle(ID))).rejects.toThrow(/handle is not a secret/u);
    expect(held.held.has(ID)).toBe(false);
  });

  it('remaps a handle at a new id, because the handle is the id and not the key', async () => {
    const store = nativeKeyStore(vault());
    await store.put(ID, KEY);
    const handle = await store.reveal(ID);
    if (handle === undefined) throw new Error('the store revealed no handle for a key it holds');
    await store.put('prv_ZZZZZZZZZZ', handle);
    expect(await store.reveal('prv_ZZZZZZZZZZ')).toBe(keyHandle('prv_ZZZZZZZZZZ'));
  });

  it('revises when the key changes, and refuses an approval that names the old one', async () => {
    const held = vault();
    const store = nativeKeyStore(held);
    await store.put(ID, KEY);
    const revision = await store.credentialRevision(ID);
    await store.put(ID, 'sk-live-second');
    expect(await store.credentialRevision(ID)).not.toBe(revision);
    await expect(store.revealPayload(ID, revision)).rejects.toThrow(/approved provider credentials changed/);
    expect(await store.revealPayload(ID, await store.credentialRevision(ID))).toBeDefined();
  });

  it('can put back what a failed replace overwrote, without ever reading the key', async () => {
    const held = vault();
    const store = nativeKeyStore(held);
    await store.put(TOKEN, 'old-token');
    await store.put(TOKEN, 'new-token');
    expect(held.held.get(TOKEN)?.apiKey).toBe('new-token');
    await store.restore!(TOKEN);
    expect(held.undos).toEqual([TOKEN]);
    expect(held.held.get(TOKEN)?.apiKey).toBe('old-token');
  });

  it('removes a key, and then answers nothing for it', async () => {
    const held = vault();
    const store = nativeKeyStore(held);
    await store.put(ID, KEY);
    await store.remove(ID);
    expect(held.held.has(ID)).toBe(false);
    expect(await store.reveal(ID)).toBeUndefined();
  });

  it('cannot list its ids: the host owns the keychain, and a page that could list them learns only names', async () => {
    const store = nativeKeyStore(vault());
    expect(store.entryIds).toBeUndefined();
  });
});
