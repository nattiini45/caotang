/**
 * The keychain the desktop app keeps its keys in — [desktop.md §The keychain](../../../docs/architecture/desktop.md#the-keychain-404).
 *
 * Provider keys and MCP bearer tokens are held here, in the main process, sealed by the operating system's own store through
 * Electron's `safeStorage`: DPAPI on Windows, the login keychain on macOS, libsecret or KWallet on Linux. The page may put,
 * delete, check for, revise and put back one; it may never read one. A secret leaves this file only into a request the port is
 * about to send, to an address the app configured for that key.
 *
 * The vault's own rules — one file of sealed entries, a write read back before it is reported, a replace that can be put back,
 * writes serialised — live in [`@caotang/gateway/keys/os-vault`](../../../packages/gateway/src/keys/os-vault.ts) and are tested
 * there. This file brings the seal, the file and the channels.
 *
 * **Linux without a keyring is not a keychain.** Chromium falls back to a built-in key that is the same on every machine, which
 * is obfuscation rather than encryption; the vault reports itself unavailable there, and the app keeps the browser's WebCrypto
 * vault with a notice that says so (provider-gateway §7).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { NodeArtifactFs } from '@caotang/artifact-fs-node';
import { openOsVault, VAULT_ID, type OsKeyVault } from '@caotang/gateway/keys/os-vault';
import { ipcMain, safeStorage } from 'electron';

import { fromStudioFrame } from './ipc-guard.mjs';
import type { VaultPayload, VaultReply } from './vault-contract.cjs';

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

/** The channels the page may call, and the answers it gets. Nothing here reads a secret back to the page. */
export function registerVaultIpc(entryUrl: string, vault: KeyVault): void {
  const reply = <T,>(run: () => T | Promise<T>): Promise<VaultReply<T>> => Promise.resolve()
    .then(run)
    .then((value): VaultReply<T> => ({ ok: true, value }), (error: unknown): VaultReply<T> => {
      // A refusal is the shape the page can show: an argument the page got wrong says so, and a machine without a keychain is
      // the one reason a well-formed call fails on purpose.
      if (error instanceof InvalidCall) return { ok: false, error: 'invalid' };
      if (!(error instanceof Error)) throw error;
      return { ok: false, error: 'unavailable' };
    });

  const idOf = (value: unknown): string => {
    if (typeof value !== 'string' || !VAULT_ID.test(value)) throw new InvalidCall('invalid');
    return value;
  };

  /** A payload the page may store: a key, and a generic endpoint's extra headers, all text and all bounded. */
  const payloadOf = (value: unknown): VaultPayload => {
    if (value === null || typeof value !== 'object') throw new InvalidCall('invalid');
    const candidate = value as { apiKey?: unknown; customHeaders?: unknown };
    if (typeof candidate.apiKey !== 'string' || candidate.apiKey === '' || candidate.apiKey.length > 8192) throw new InvalidCall('invalid');
    const headers = candidate.customHeaders;
    if (headers === undefined) return { apiKey: candidate.apiKey };
    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) throw new InvalidCall('invalid');
    const copy: Record<string, string> = {};
    const entries = Object.entries(headers as Record<string, unknown>);
    if (entries.length > 64) throw new InvalidCall('invalid');
    for (const [name, header] of entries) {
      if (typeof header !== 'string' || header.length > 8192 || name === '' || name.length > 256) throw new InvalidCall('invalid');
      copy[name] = header;
    }
    return { apiKey: candidate.apiKey, ...(entries.length === 0 ? {} : { customHeaders: copy }) };
  };

  /** The extra headers a page may hand back: text under a name, both bounded. Nothing here is a secret. */
  const headersOf = (raw: unknown): Readonly<Record<string, string>> => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidCall('invalid');
    const copy: Record<string, string> = {};
    const entries = Object.entries(raw as Record<string, unknown>);
    // The same bound the payload parser applies: a page cannot spend the host's memory on headers either way.
    if (entries.length > 64) throw new InvalidCall('invalid');
    for (const [name, value] of entries) {
      if (typeof value !== 'string' || value.length > 8192 || name === '' || name.length > 256) throw new InvalidCall('invalid');
      copy[name] = value;
    }
    return copy;
  };

  ipcMain.handle('vault:available', (event): Promise<VaultReply<boolean>> => reply(async () => {
    if (!fromStudioFrame(event, entryUrl)) throw new InvalidCall('invalid');
    return vault.available();
  }));

  ipcMain.handle('vault:put', (event, rawId: unknown, rawPayload: unknown): Promise<VaultReply<null>> => reply(async () => {
    if (!fromStudioFrame(event, entryUrl)) throw new InvalidCall('invalid');
    await vault.put(idOf(rawId), payloadOf(rawPayload));
    return null;
  }));

  // A headers-only edit: the page read a key (and was given a handle) and changed only the extra headers. The secret stays where it
  // is, because sealing the handle over it would destroy the key the writer saved (#863).
  ipcMain.handle('vault:putHeaders', (event, rawId: unknown, rawHeaders: unknown): Promise<VaultReply<null>> => reply(async () => {
    if (!fromStudioFrame(event, entryUrl)) throw new InvalidCall('invalid');
    await vault.putHeaders(idOf(rawId), headersOf(rawHeaders));
    return null;
  }));

  ipcMain.handle('vault:remove', (event, rawId: unknown): Promise<VaultReply<null>> => reply(async () => {
    if (!fromStudioFrame(event, entryUrl)) throw new InvalidCall('invalid');
    await vault.remove(idOf(rawId));
    return null;
  }));

  ipcMain.handle('vault:has', (event, rawId: unknown): Promise<VaultReply<boolean>> => reply(async () => {
    if (!fromStudioFrame(event, entryUrl)) throw new InvalidCall('invalid');
    return vault.has(idOf(rawId));
  }));

  ipcMain.handle('vault:revision', (event, rawId: unknown): Promise<VaultReply<string>> => reply(async () => {
    if (!fromStudioFrame(event, entryUrl)) throw new InvalidCall('invalid');
    return vault.revision(idOf(rawId));
  }));

  ipcMain.handle('vault:restore', (event, rawId: unknown): Promise<VaultReply<null>> => reply(async () => {
    if (!fromStudioFrame(event, entryUrl)) throw new InvalidCall('invalid');
    await vault.restore(idOf(rawId));
    return null;
  }));

  ipcMain.handle('vault:headers', (event, rawId: unknown): Promise<VaultReply<Readonly<Record<string, string>> | null>> => reply(async () => {
    if (!fromStudioFrame(event, entryUrl)) throw new InvalidCall('invalid');
    return (await vault.headers(idOf(rawId))) ?? null;
  }));
}
