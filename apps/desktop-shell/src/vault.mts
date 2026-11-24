/**
 * The keychain the desktop app keeps its keys in — [desktop.md §The keychain](../../../docs/architecture/desktop.md#the-keychain-404).
 *
 * Provider keys and MCP bearer tokens are held here, in the main process, sealed by the operating system's own store through
 * Electron's `safeStorage`: DPAPI on Windows, the login keychain on macOS, libsecret or KWallet on Linux. The page may put,
 * delete, check for, revise and put back one; it may never read one. A secret leaves this file only into a request the port is
 * about to send, to an address the app configured for that key.
 *
 * The vault's own rules — one file of entries, each the sealed secret and the address it was entered for, committed in one
 * write and read back before it is reported, a replace that can be put back, writes serialised — live in
 * [`@caotang/gateway/keys/os-vault`](../../../packages/gateway/src/keys/os-vault.ts) and are tested there. This file brings the
 * seal, the file and the channels.
 *
 * **Linux without a keyring is not a keychain.** Chromium falls back to a built-in key that is the same on every machine, which
 * is obfuscation rather than encryption; the vault reports itself unavailable there, and the app keeps the browser's WebCrypto
 * vault with a notice that says so (provider-gateway §7).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { NodeArtifactFs } from '@caotang/artifact-fs-node';
import { keyOrigin } from '@caotang/gateway/keys/key-origin';
import { KeyBoundElsewhere, openOsVault, VAULT_ID, type OsKeyVault } from '@caotang/gateway/keys/os-vault';
import { parseVaultHeaders, parseVaultPayload } from '@caotang/gateway/keys/vault-payload';
import { ipcMain, safeStorage } from 'electron';

import { fromStudioFrame } from './ipc-guard.mjs';
import type { VaultKeyState, VaultPayload, VaultReply } from './vault-contract.cjs';

export type KeyVault = OsKeyVault;

const FILE = 'native-key-vault.json';

/** Chromium's own key, the same on every machine: sealed is the wrong word for what it does. */
function realKeychain(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform !== 'linux') return true;
  const backend = safeStorage.getSelectedStorageBackend();
  return backend !== 'basic_text' && backend !== 'unknown';
}

/**
 * How one value is sealed and opened. The two calls answer different shapes on the pinned Electron: `encryptStringAsync` resolves
 * the sealed bytes, and `decryptStringAsync` resolves a record whose `result` is the plain text. A spec may pass its own, so the
 * vault's put, read-back and read are exercised on a machine with no keyring, which is every CI runner.
 */
export interface Sealer {
  available(): boolean;
  seal(plain: string): Promise<string>;
  open(sealed: string): Promise<string>;
}

export const electronSealer = (): Sealer => ({
  available: () => safeStorage.isEncryptionAvailable(),
  seal: async (plain) => (await safeStorage.encryptStringAsync(plain)).toString('base64'),
  open: async (sealed) => (await safeStorage.decryptStringAsync(Buffer.from(sealed, 'base64'))).result,
});

export async function openKeyVault(profile: string, sealer: Sealer = electronSealer()): Promise<KeyVault> {
  const fs = new NodeArtifactFs(profile);
  const path = join(profile, FILE);
  return openOsVault({
    available: async () => realKeychain(),
    read: async () => await fs.exists(FILE) ? readFile(path, 'utf8') : undefined,
    write: (text) => fs.writeAtomic(FILE, text),
    seal: (plain) => sealer.seal(plain),
    open: (sealed) => sealer.open(sealed),
  });
}

/** A call whose arguments the page got wrong: a different answer from a machine that has no keychain. */
class InvalidCall extends Error {}

/** What these channels are registered on: the running app's `ipcMain`, or a spec's own, so the parser is testable without Electron. */
export type VaultIpcHost = Pick<typeof ipcMain, 'handle'>;

/** The channels the page may call, and the answers it gets. Nothing here reads a secret back to the page. */
export function registerVaultIpc(entryUrl: string, vault: KeyVault, ipc: VaultIpcHost = ipcMain): void {
  const reply = <T,>(run: () => T | Promise<T>): Promise<VaultReply<T>> => Promise.resolve()
    .then(run)
    .then((value): VaultReply<T> => ({ ok: true, value }), (error: unknown): VaultReply<T> => {
      // A refusal is the shape the page can show: an argument the page got wrong says so, and a machine without a keychain is
      // the one reason a well-formed call fails on purpose.
      if (error instanceof InvalidCall) return { ok: false, error: 'invalid' };
      // An id the keychain already holds for another address says so: the page can tell the writer which key to enter again,
      // where a keychain that would not answer would send them looking for a broken keychain instead (#879).
      if (error instanceof KeyBoundElsewhere) return { ok: false, error: 'bound' };
      if (!(error instanceof Error)) throw error;
      return { ok: false, error: 'unavailable' };
    });

  const idOf = (value: unknown): string => {
    if (typeof value !== 'string' || !VAULT_ID.test(value)) throw new InvalidCall('invalid');
    return value;
  };

  /** A payload the page may store, as the vault's own rules read it: a key, and a generic endpoint's extra headers. */
  const payloadOf = (value: unknown): VaultPayload => {
    const payload = parseVaultPayload(value);
    if (payload === undefined) throw new InvalidCall('invalid');
    return payload;
  };

  /**
   * The origin a key is stored for: what the binding records, and the only address the id may ever be sent to. https anywhere,
   * and plain http only on this computer, which is the one non-https address the native port reaches and a local MCP server's
   * own (key-origin.ts, native-egress.ts).
   */
  const originOf = (raw: unknown): string => {
    const origin = typeof raw === 'string' ? keyOrigin(raw) : undefined;
    if (origin === undefined) throw new InvalidCall('invalid');
    return origin;
  };

  /** The extra headers a page may hand back: text under a name, both bounded. Nothing here is a secret. */
  const headersOf = (raw: unknown): Readonly<Record<string, string>> => {
    const headers = parseVaultHeaders(raw);
    if (headers === undefined) throw new InvalidCall('invalid');
    return headers;
  };

  ipc.handle('vault:available', (event): Promise<VaultReply<boolean>> => reply(async () => {
    if (!fromStudioFrame(event, entryUrl)) throw new InvalidCall('invalid');
    return vault.available();
  }));

  ipc.handle('vault:put', (event, rawId: unknown, rawPayload: unknown, rawOrigin: unknown): Promise<VaultReply<null>> => reply(async () => {
    if (!fromStudioFrame(event, entryUrl)) throw new InvalidCall('invalid');
    const id = idOf(rawId);
    const payload = payloadOf(rawPayload);
    // The address the key was typed for is part of storing it: the vault writes the sealed secret and the address in the same
    // turn, so a key is never stored without one and never has one without its key (#864). An id already stored for another
    // address is refused here; the writer's own replacement key for an endpoint they moved goes through its own call below.
    await vault.put(id, payload, originOf(rawOrigin));
    return null;
  }));

  // The key a writer typed again for an endpoint they moved: the one write that may take a new address, and only because it
  // carries a secret they entered for it rather than the handle of the key already stored.
  ipc.handle('vault:putReplacement', (event, rawId: unknown, rawPayload: unknown, rawOrigin: unknown): Promise<VaultReply<null>> => reply(async () => {
    if (!fromStudioFrame(event, entryUrl)) throw new InvalidCall('invalid');
    await vault.putReplacement(idOf(rawId), payloadOf(rawPayload), originOf(rawOrigin));
    return null;
  }));

  // A headers-only edit: the page read a key (and was given a handle) and changed only the extra headers. The secret stays where it
  // is, because sealing the handle over it would destroy the key the writer saved (#863).
  ipc.handle('vault:putHeaders', (event, rawId: unknown, rawHeaders: unknown): Promise<VaultReply<null>> => reply(async () => {
    if (!fromStudioFrame(event, entryUrl)) throw new InvalidCall('invalid');
    await vault.putHeaders(idOf(rawId), headersOf(rawHeaders));
    return null;
  }));

  ipc.handle('vault:remove', (event, rawId: unknown): Promise<VaultReply<null>> => reply(async () => {
    if (!fromStudioFrame(event, entryUrl)) throw new InvalidCall('invalid');
    await vault.remove(idOf(rawId));
    return null;
  }));

  ipc.handle('vault:has', (event, rawId: unknown): Promise<VaultReply<boolean>> => reply(async () => {
    if (!fromStudioFrame(event, entryUrl)) throw new InvalidCall('invalid');
    return vault.has(idOf(rawId));
  }));

  ipc.handle('vault:revision', (event, rawId: unknown): Promise<VaultReply<string>> => reply(async () => {
    if (!fromStudioFrame(event, entryUrl)) throw new InvalidCall('invalid');
    return vault.revision(idOf(rawId));
  }));

  ipc.handle('vault:restore', (event, rawId: unknown): Promise<VaultReply<null>> => reply(async () => {
    if (!fromStudioFrame(event, entryUrl)) throw new InvalidCall('invalid');
    await vault.restore(idOf(rawId));
    return null;
  }));

  ipc.handle('vault:keyState', (event, rawId: unknown): Promise<VaultReply<VaultKeyState>> => reply(async () => {
    if (!fromStudioFrame(event, entryUrl)) throw new InvalidCall('invalid');
    return vault.keyState(idOf(rawId));
  }));

  ipc.handle('vault:headers', (event, rawId: unknown): Promise<VaultReply<Readonly<Record<string, string>> | null>> => reply(async () => {
    if (!fromStudioFrame(event, entryUrl)) throw new InvalidCall('invalid');
    return (await vault.headers(idOf(rawId))) ?? null;
  }));
}
