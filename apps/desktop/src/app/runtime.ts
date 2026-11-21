/**
 * The one IndexedDB connection the app uses (project-format §8: the runtime store is
 * the browser's working copy).
 *
 * Opened on first use and shared by every session. A failed open is not cached, so a
 * later attempt (a reload, or the user retrying) gets a fresh chance rather than the
 * same rejected promise.
 *
 * The name carries the studio's storage scope (`storage-scope.ts`): a hosted shell's
 * accounts get a store each, and the memo remembers which scope it opened, so a
 * different one is opened afresh rather than answering with the other account's copy.
 */

import { openRuntimeStore, RUNTIME_DB_NAME, type RuntimeStore } from '@caotang/store';
import { scopedStoreName, storageScope } from './storage-scope.js';

let pending: Promise<RuntimeStore> | null = null;
let pendingScope: string | null | undefined;
const nativeStores = new Map<string, Promise<RuntimeStore>>();

export function nativeRuntimeStore(folderId: string): Promise<RuntimeStore> {
  const name = scopedStoreName(`caotang-native-${folderId}`);
  const existing = nativeStores.get(name);
  if (existing !== undefined) return existing;
  const opened = openRuntimeStore(indexedDB, name);
  nativeStores.set(name, opened);
  void opened.catch(() => nativeStores.delete(name));
  return opened;
}

export function runtimeStore(): Promise<RuntimeStore> {
  const scope = storageScope();
  if (pending !== null && pendingScope === scope) return pending;
  pendingScope = scope;
  pending = (async () => {
    if (typeof indexedDB === 'undefined') {
      throw new Error('This browser has no IndexedDB, so projects cannot be stored here.');
    }
    return openRuntimeStore(indexedDB, scopedStoreName(RUNTIME_DB_NAME));
  })();
  pending.catch(() => {
    if (pendingScope === scope) {
      pending = null;
      pendingScope = undefined;
    }
  });
  return pending;
}
