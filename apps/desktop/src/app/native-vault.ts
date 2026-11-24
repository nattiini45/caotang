/**
 * Where the app keeps provider keys and MCP tokens — [desktop.md §The keychain](../../../docs/architecture/desktop.md#the-keychain-404).
 *
 * In the desktop shell the main process holds them in the operating system's keychain, and this module is the page's side of
 * that: a {@link KeyStore} whose every answer is a handle rather than a secret, the one-time move of the keys an earlier version
 * sealed in this browser's IndexedDB, and the address each of those keys (or one the keychain already held) belongs to.
 *
 * **The migration writes, verifies, deletes.** Each sealed key is opened with the store that already holds it, written to the
 * keychain, read back by the main process before it is reported stored, checked once more, and only then removed from the
 * browser. A key that cannot be opened is left where it is rather than dropped, and the profiles that lost nothing keep
 * working; a machine where the move fails part-way keeps the keys it did not move.
 */

import {
  createIndexedDbVaultPort,
  createKeyStore,
  nativeKeyStore,
  PROVIDER_KEY_DB_NAME,
} from '@caotang/gateway';
import type { KeyStore, NativeKeyVault } from '@caotang/gateway';

import { t } from '@lingui/core/macro';

import type { VaultPayload, VaultReply } from '../../../desktop-shell/src/vault-contract.cjs';
import { scopedStoreName } from './storage-scope.js';

/**
 * The keychain, when this page runs in the desktop shell and the machine has one. Version 6 is the first whose vault records the
 * address a key is stored for and answers what an entry holds, which is how a headers-only entry reveals its empty key rather
 * than a handle (#864, #868); an older shell records neither and keeps the browser's vault instead.
 */
function bridge(): NonNullable<Window['caotangDesktop']>['vault'] | undefined {
  if (typeof window === 'undefined') return undefined;
  const desktop = window.caotangDesktop;
  return desktop !== undefined && desktop.version >= 6 ? desktop.vault : undefined;
}

/** What the desktop app has for keys. `none` is a browser, where the WebCrypto vault is the whole answer. */
export type DesktopKeys =
  | { readonly kind: 'none' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'keychain'; readonly store: KeyStore; readonly moved: number; readonly failed: boolean };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unwrap<T>(reply: VaultReply<T>): T {
  if (reply.ok) return reply.value;
  throw new Error('The operating system keychain did not answer.');
}

/** The keychain as the gateway's key store sees it: every method the page may call, and never a read. */
function vaultPort(api: NonNullable<ReturnType<typeof bridge>>): NativeKeyVault {
  return {
    available: async () => unwrap(await api.available()),
    put: async (id, payload, origin) => {
      const stored: VaultPayload = { apiKey: payload.apiKey, ...(payload.customHeaders === undefined ? {} : { customHeaders: payload.customHeaders }) };
      // The address the key is for is part of storing it: the shell records it, and a page cannot change it afterwards (#864).
      unwrap(await api.put(id, stored, origin));
    },
    putReplacement: async (id, payload, origin) => {
      const stored: VaultPayload = { apiKey: payload.apiKey, ...(payload.customHeaders === undefined ? {} : { customHeaders: payload.customHeaders }) };
      // The writer's own key, entered again for the endpoint they moved: the shell moves the address with it.
      unwrap(await api.putReplacement(id, stored, origin));
    },
    putHeaders: async (id, headers) => {
      unwrap(await api.putHeaders(id, headers));
    },
    keyState: async (id) => unwrap(await api.keyState(id)),
    headers: async (id) => {
      // A call that failed answers no headers, and saying "none" would read as a key stored without any: the store's answer is
      // "not known", which is an error, not silence.
      const reply = await api.headers(id);
      if (!reply.ok) throw new Error(t`Caotang could not read this key's extra header values from the keychain.`);
      return reply.value ?? undefined;
    },
    restore: async (id) => {
      unwrap(await api.restore(id));
    },
    revision: async (id) => unwrap(await api.revision(id)),
    has: async (id) => unwrap(await api.has(id)),
    remove: async (id) => {
      unwrap(await api.remove(id));
    },
  };
}

/**
 * How many keys moved out of this browser's vault into the keychain. Every entry the old store can open is written, read back
 * and then deleted; an entry it cannot open is counted as left rather than taken.
 */
async function migrate(factory: IDBFactory, store: KeyStore, origins: ReadonlyMap<string, string>): Promise<{ moved: number; failed: boolean }> {
  let moved = 0;
  let failed = false;
  let legacy: KeyStore;
  try {
    legacy = createKeyStore(createIndexedDbVaultPort({ factory, name: scopedStoreName(PROVIDER_KEY_DB_NAME) }));
  } catch {
    return { moved, failed };
  }
  const ids = (await legacy.entryIds?.().catch(() => [])) ?? [];
  for (const id of ids) {
    try {
      const payload = await legacy.revealPayload(id);
      // A key that cannot be opened here is not a key: leaving it alone keeps the browser's copy as the record of it.
      if (payload === undefined) continue;
      // The profile's own address, which the caller supplies: a key that cannot name one is not moved, because a host that
      // cannot bind it could never send it.
      const origin = origins.get(id);
      if (origin === undefined) continue;
      await store.putPayload(id, payload, origin);
      if (!await store.has(id)) {
        failed = true;
        continue;
      }
      await legacy.remove(id);
      moved += 1;
    } catch (error) {
      failed = true;
      console.warn(`Caotang could not move the key for ${id} into this computer's keychain.`, errorText(error));
    }
  }
  return { moved, failed };
}

/**
 * Opens what the desktop app has for keys, moving this browser's sealed keys into the keychain once. Never throws: a keychain
 * that cannot be used answers `unavailable`, and the caller keeps the browser's vault with a notice that says so.
 */
export async function openDesktopKeys(factory: IDBFactory | null, origins: ReadonlyMap<string, string>): Promise<DesktopKeys> {
  const api = bridge();
  if (api === undefined) return { kind: 'none' };
  let available = false;
  try {
    available = unwrap(await api.available());
  } catch (error) {
    console.warn('Caotang could not ask the operating system for a keychain.', errorText(error));
  }
  if (!available) return { kind: 'unavailable' };
  const store = nativeKeyStore(vaultPort(api));
  if (factory === null) return { kind: 'keychain', store, moved: 0, failed: false };
  const { moved, failed } = await migrate(factory, store, origins);
  return { kind: 'keychain', store, moved, failed };
}
