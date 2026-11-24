/**
 * The key store of a host that keeps the keys itself — the desktop app's main process holding them in the operating
 * system's keychain ([desktop.md §The keychain](../../../docs/architecture/desktop.md#the-keychain-404)).
 *
 * It answers the same {@link KeyStore} the browser's store does, and one thing differently, on purpose: nothing it returns
 * is a secret. `reveal` answers the *handle* of a stored key, and the adapter puts that handle where the key would go; the
 * host swaps it for the secret at the last moment, once it has checked that the address is one this key belongs to
 * ([native-egress.ts](../native-egress.ts)). So the page can make a call with a key and never learn what the key is: a
 * script in the page can *use* a stored key while the app is open, and cannot take it away.
 *
 * The payload the writer typed — a key, and a generic endpoint's extra headers — is stored whole by the host. The extra
 * header *values* come back to the page, because the writer typed them here and the form shows them; the key does not.
 */

import { keyHandle } from '../native-egress.js';
import type { KeyPayload, KeyStore } from './key-store.js';

/**
 * What the host's vault does. Every method is what the main process must offer for the page to have a key store at all; the
 * host's own read of a secret is not here, because it happens inside the host, where no page can ask for it.
 */
export interface NativeKeyVault {
  /** Whether the operating system's keychain can be used at all. False means the browser's WebCrypto vault is in use. */
  available(): Promise<boolean>;
  /** Stores the payload under `id` for one address, and answers only once the host has read it back. */
  put(id: string, payload: KeyPayload, origin: string): Promise<void>;
  /**
   * Replaces the extra header values stored with `id` and keeps the key it already holds. This is what a headers-only edit uses:
   * the page hands back the payload it was given, whose key is the handle, and sealing that handle over the real key would destroy
   * it (the handle is not a secret — it names one).
   */
  putHeaders(id: string, headers: Readonly<Record<string, string>>): Promise<void>;
  /** The extra header values stored with `id`: never the key. */
  headers(id: string): Promise<Readonly<Record<string, string>> | undefined>;
  /** A value that changes whenever the stored payload does, for a caller comparing approvals. */
  revision(id: string): Promise<string>;
  has(id: string): Promise<boolean>;
  remove(id: string): Promise<void>;
  /** Puts back what the last `put` for `id` replaced, and removes the entry when there was none. */
  restore(id: string): Promise<void>;
}

/** What `reveal` answers for a stored key: a handle, never the key. */
export function nativeKeyStore(vault: NativeKeyVault): KeyStore {
  return {
    async put(id, apiKey, origin) {
      // A handle names a stored key; it is not one. Sealing it would replace the secret with its own name, which nothing can open.
      if (apiKey === keyHandle(id)) throw new Error('A key handle is not a secret. This store keeps the key itself, so it cannot be set from what it returned.');
      await vault.put(id, { apiKey }, origin);
    },

    async putPayload(id, payload, origin) {
      // Reading a payload and writing it back is how an edit that touches only the headers arrives: its key is this store's own
      // handle. The stored secret stays, and only the headers move (native-store.test.ts, #863).
      if (payload.apiKey === keyHandle(id)) {
        await vault.putHeaders(id, payload.customHeaders ?? {});
        return;
      }
      await vault.put(id, payload, origin);
    },

    async reveal(id) {
      return await vault.has(id) ? keyHandle(id) : undefined;
    },

    async revealPayload(id, expectedRevision) {
      if (expectedRevision !== undefined && await vault.revision(id) !== expectedRevision) {
        throw new Error('The approved provider credentials changed. This attempt was not sent.');
      }
      const headers = await vault.headers(id);
      if (headers === undefined) return undefined;
      return { apiKey: keyHandle(id), ...(Object.keys(headers).length === 0 ? {} : { customHeaders: headers }) };
    },

    credentialRevision: (id) => vault.revision(id),

    has: (id) => vault.has(id),

    async remove(id) {
      await vault.remove(id);
    },

    restore: (id) => vault.restore(id),
  };
}
