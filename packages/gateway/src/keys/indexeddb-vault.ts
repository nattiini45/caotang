/**
 * The browser binding of the key vault: IndexedDB, in its own database.
 *
 * It is a separate database from the project store on purpose. §7 keeps keys "in
 * IndexedDB **outside** the project DB", so that exporting, resetting, or syncing a
 * project can never carry a credential with it. The wrapping key and the sealed entries
 * are two object stores in that database.
 *
 * Each operation runs in its own transaction and resolves when the transaction
 * commits, not when the request succeeds. A write that a later abort rolls back is
 * then reported as a failure, which is the answer a caller needs.
 *
 * The store's own `MemoryIndexedDb` is the headless stand-in for this file in tests,
 * because the store's README makes the same argument about browser code in general.
 */

import type { KeyVaultPort, SealedEntry } from './vault.js';

const STORE_WRAP = 'wrap';
const STORE_ENTRIES = 'entries';
const WRAP_KEY_ID = 'wrapping-key';
const DB_VERSION = 1;

/**
 * Both stores use in-line keys (`keyPath`), so every record carries its own key. That is
 * the one form every IndexedDB implementation accepts, including the headless binding the
 * tests run against, which refuses out-of-line keys.
 */
interface WrapRecord {
  id: string;
  key: CryptoKey;
}

interface EntryRecord extends SealedEntry {
  profileId: string;
}

/** The database the sealed provider keys live in. The app names it through its storage scope (storage-scope.ts). */
export const PROVIDER_KEY_DB_NAME = 'caotang-provider-keys';

export interface IndexedDbVaultOptions {
  /** defaults to `globalThis.indexedDB`; tests pass an in-memory factory */
  factory?: IDBFactory;
  /** the database name; defaults to a Caotang-specific one that no project uses */
  name?: string;
}

export function createIndexedDbVaultPort(options: IndexedDbVaultOptions = {}): KeyVaultPort {
  const factory = options.factory ?? globalThis.indexedDB;
  if (factory === undefined) throw new Error('IndexedDB is not available in this host, so the provider key vault cannot open.');
  const name = options.name ?? PROVIDER_KEY_DB_NAME;
  let opened: Promise<IDBDatabase> | undefined;

  const open = (): Promise<IDBDatabase> => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_WRAP)) db.createObjectStore(STORE_WRAP, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE_ENTRIES)) db.createObjectStore(STORE_ENTRIES, { keyPath: 'profileId' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        opened = undefined;
        reject(request.error ?? new Error('Opening the provider key vault failed.'));
      };
    });
    return opened;
  };

  /** One request per transaction; resolves on commit, rejects on error or abort. */
  const run = async <T>(store: string, mode: IDBTransactionMode, work: (objects: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let result: T | undefined;
      const request = work(tx.objectStore(store));
      request.onsuccess = () => {
        result = request.result;
      };
      tx.oncomplete = () => resolve(result as T);
      tx.onerror = () => reject(tx.error ?? new Error('Provider key vault transaction failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Provider key vault transaction was aborted.'));
    });
  };

  return {
    async getWrappingKey() {
      const record = await run<WrapRecord | undefined>(STORE_WRAP, 'readonly', (objects) => objects.get(WRAP_KEY_ID));
      return record?.key;
    },
    async putWrappingKeyIfAbsent(candidate) {
      // The read and the conditional write share one readwrite transaction, which the
      // browser serialises against other tabs, so a second tab sees the first tab's key.
      const db = await open();
      return new Promise<CryptoKey>((resolve, reject) => {
        const tx = db.transaction(STORE_WRAP, 'readwrite');
        const objects = tx.objectStore(STORE_WRAP);
        let stored: CryptoKey | undefined;
        const read = objects.get(WRAP_KEY_ID);
        read.onsuccess = () => {
          const existing = (read.result as WrapRecord | undefined)?.key;
          if (existing !== undefined) {
            stored = existing;
            return;
          }
          const record: WrapRecord = { id: WRAP_KEY_ID, key: candidate };
          objects.put(record);
          stored = candidate;
        };
        tx.oncomplete = () => {
          // Resolving with the candidate here would hand back a key that may not be stored.
          if (stored === undefined) reject(new Error('Provider key vault did not report the stored wrapping key.'));
          else resolve(stored);
        };
        tx.onerror = () => reject(tx.error ?? new Error('Provider key vault transaction failed.'));
        tx.onabort = () => reject(tx.error ?? new Error('Provider key vault transaction was aborted.'));
      });
    },
    async getEntry(profileId) {
      const record = await run<EntryRecord | undefined>(STORE_ENTRIES, 'readonly', (objects) => objects.get(profileId));
      return record === undefined ? undefined : { iv: record.iv, ciphertext: record.ciphertext };
    },
    async putEntry(profileId, entry) {
      const record: EntryRecord = { profileId, iv: entry.iv, ciphertext: entry.ciphertext };
      await run(STORE_ENTRIES, 'readwrite', (objects) => objects.put(record));
    },
    async deleteEntry(profileId) {
      await run(STORE_ENTRIES, 'readwrite', (objects) => objects.delete(profileId));
    },
  };
}
