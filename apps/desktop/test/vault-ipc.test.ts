/**
 * The vault channels as the main process parses them (#868) — desktop.md §The keychain.
 *
 * `registerVaultIpc` is the whole surface the page's key store talks to, so this drives the registered handlers through a fake
 * `ipcMain`: the payload parser is exercised where the page meets it, on a machine with no keychain and no Electron. What the
 * vault then does with an accepted payload — the seal, the file, the read-back — is `packages/gateway/test/os-vault.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { registerVaultIpc, type KeyVault, type VaultIpcHost } from '../../desktop-shell/src/vault.mjs';

const ENTRY = 'app://caotang/index.html';
const ID = 'prv_ABCDEFGHJK';
const HEADERS = { 'x-workspace': 'made-up' };

type Reply = { readonly ok: boolean; readonly value?: unknown; readonly error?: string };

/** The main process's vault behind the channels: payloads in a Map, sealed and read back for real by the gateway's own suite. */
function fakeVault(): KeyVault & { readonly held: Map<string, { apiKey: string; customHeaders?: Record<string, string> }> } {
  const held = new Map<string, { apiKey: string; customHeaders?: Record<string, string> }>();
  return {
    held,
    available: async () => true,
    read: async (id) => held.get(id),
    async put(id, payload) {
      held.set(id, payload);
    },
    async putHeaders(id, headers) {
      const payload = held.get(id);
      if (payload === undefined) return;
      held.set(id, { apiKey: payload.apiKey, ...(Object.keys(headers).length === 0 ? {} : { customHeaders: { ...headers } }) });
    },
    async remove(id) {
      held.delete(id);
    },
    has: async (id) => held.has(id),
    restore: async () => undefined,
    revision: async (id) => held.has(id) ? `rev-${held.get(id)?.apiKey ?? ''}` : 'empty',
    async headers(id) {
      const payload = held.get(id);
      return payload === undefined ? undefined : { ...(payload.customHeaders ?? {}) };
    },
    async keyState(id) {
      const payload = held.get(id);
      return payload === undefined ? 'none' : payload.apiKey === '' ? 'empty' : 'key';
    },
  };
}

/** The channels the shell registered, called the way the preload calls them: from the studio's own top frame. */
function channels(vault: KeyVault): (channel: string, ...args: unknown[]) => Promise<Reply> {
  const registered = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc: VaultIpcHost = {
    handle: (channel, handler) => {
      registered.set(channel, handler as (event: unknown, ...args: unknown[]) => unknown);
    },
  };
  registerVaultIpc(ENTRY, vault, ipc);
  const event = { senderFrame: { parent: null, url: ENTRY } };
  return async (channel, ...args) => {
    const handler = registered.get(channel);
    if (handler === undefined) throw new Error(`Caotang registers no ${channel} channel.`);
    return await handler(event, ...args) as Reply;
  };
}

describe('a payload the page hands the keychain', () => {
  it('stores one whose key is empty because the profile authenticates with its own headers (#868)', async () => {
    const vault = fakeVault();
    const call = channels(vault);
    expect(await call('vault:put', ID, { apiKey: '', customHeaders: HEADERS })).toEqual({ ok: true, value: null });
    // The distinction the page reads back is an empty key, not the absence of an entry and not a handle.
    expect(vault.held.get(ID)).toEqual({ apiKey: '', customHeaders: HEADERS });
    expect(await call('vault:headers', ID)).toEqual({ ok: true, value: HEADERS });
    expect(await call('vault:keyState', ID)).toEqual({ ok: true, value: 'empty' });
  });

  it('refuses a payload that holds neither a key nor a header', async () => {
    const vault = fakeVault();
    const call = channels(vault);
    expect(await call('vault:put', ID, { apiKey: '' })).toEqual({ ok: false, error: 'invalid' });
    expect(await call('vault:put', ID, { apiKey: '', customHeaders: {} })).toEqual({ ok: false, error: 'invalid' });
    expect(vault.held.has(ID)).toBe(false);
  });

  it('refuses a key that is not text, and keeps every bound it had', async () => {
    const vault = fakeVault();
    const call = channels(vault);
    const tooMany = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`x-header-${index}`, 'value']));
    expect(await call('vault:put', ID, { apiKey: '', customHeaders: tooMany })).toEqual({ ok: false, error: 'invalid' });
    expect(await call('vault:put', ID, { apiKey: '', customHeaders: { ['x'.repeat(257)]: 'value' } })).toEqual({ ok: false, error: 'invalid' });
    expect(await call('vault:put', ID, { apiKey: '', customHeaders: { 'x-workspace': 'v'.repeat(8193) } })).toEqual({ ok: false, error: 'invalid' });
    expect(await call('vault:put', ID, { apiKey: 42, customHeaders: HEADERS })).toEqual({ ok: false, error: 'invalid' });
    expect(await call('vault:put', ID, { apiKey: 'k'.repeat(8193), customHeaders: HEADERS })).toEqual({ ok: false, error: 'invalid' });
    expect(await call('vault:put', ID, null)).toEqual({ ok: false, error: 'invalid' });
    expect(vault.held.has(ID)).toBe(false);
  });

  it('answers what an id holds without answering the key', async () => {
    const vault = fakeVault();
    const call = channels(vault);
    expect(await call('vault:keyState', ID)).toEqual({ ok: true, value: 'none' });
    await call('vault:put', ID, { apiKey: 'sk-made-up-key-1' });
    expect(await call('vault:keyState', ID)).toEqual({ ok: true, value: 'key' });
    // An edit that touches only the headers keeps the key, so the state does not move.
    expect(await call('vault:putHeaders', ID, HEADERS)).toEqual({ ok: true, value: null });
    expect(await call('vault:keyState', ID)).toEqual({ ok: true, value: 'key' });
  });
});
