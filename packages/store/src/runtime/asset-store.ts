/**
 * The browser's copy of a project's binary assets: the images under `assets/` (storyboard.md §2.2, epub-metadata.md).
 *
 * Without a project folder the runtime store has no home for a file it keeps as bytes, so a shot image or a cover
 * is lost on reload. This store keeps those bytes in IndexedDB, keyed by project and by the file's project-relative
 * path, so an image reads back after a reload with no folder attached.
 *
 * It is a separate database from the runtime store (`caotang`), on purpose: the runtime store's schema is versioned
 * with the documents it holds, and an image store is a second, independent concern that can be opened, tested and
 * abandoned on its own. The factory is a parameter, as it is for the runtime store, so the in-memory binding serves
 * the tests and the browser's `indexedDB` serves the app.
 *
 * The store knows nothing about which files are images. The caller (the desktop's `ProjectAssets`) decides what a
 * path means and what it validates; this file moves bytes and keeps them per project.
 */

/**
 * Thumbnails are derived and per-browser (pictures.md §6.5): the `thumbs` store of this database, and never
 * the app database (`caotang-app` keeps its name and never holds project bytes), the project folder or a
 * bundle. Version 2 adds that store and nothing else: the `assets` store is untouched, so a database written
 * by version 1 opens unchanged beside its thumbnails.
 */
export const THUMBS_STORE = 'thumbs';
export const THUMBS_PROJECT_INDEX = 'byProject';

/** One stored thumbnail: a project, the asset path it is of, the thumbnail size (long edge in px), and its bytes. */
export interface ThumbRow {
  readonly projectId: string;
  readonly path: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

/** The database name. Distinct from the runtime store's `caotang`, so the two never share a schema version. */
export const ASSET_DB_NAME = 'caotang-assets';

/**
 * 1: the first build of the asset store — the `assets` store only. No earlier version exists to migrate from.
 * 2: adds the `thumbs` store (pictures.md §6.5); the upgrade only adds a store, it never touches `assets`.
 */
export const ASSET_DB_VERSION = 2;

export const ASSET_STORE = 'assets';
export const ASSET_PROJECT_INDEX = 'byProject';

/** One stored file: a project, its path under the project folder (`assets/<name>`), and its bytes. */
export interface AssetRow {
  readonly projectId: string;
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface AssetStore {
  readonly db: IDBDatabase;
  readonly name: string;
  close(): void;
}

/** Opens (and if necessary creates or upgrades) the asset database. */
export function openAssetStore(factory: IDBFactory, name: string = ASSET_DB_NAME): Promise<AssetStore> {
  return new Promise<AssetStore>((resolve, reject) => {
    const request = factory.open(name, ASSET_DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ASSET_STORE)) {
        // A compound key, so one project's files are one contiguous range, as the runtime store's documents are.
        const assets = db.createObjectStore(ASSET_STORE, { keyPath: ['projectId', 'path'] });
        assets.createIndex(ASSET_PROJECT_INDEX, 'projectId', { unique: false });
      }
      // Version 2 adds only the thumbnail store; an upgrade from version 1 leaves every stored file where it was.
      if (event.oldVersion < 2 && !db.objectStoreNames.contains(THUMBS_STORE)) {
        const thumbs = db.createObjectStore(THUMBS_STORE, { keyPath: ['projectId', 'path', 'size'] });
        thumbs.createIndex(THUMBS_PROJECT_INDEX, 'projectId', { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab asking for a newer version must not wait on this connection, so it is closed on request.
      db.onversionchange = () => db.close();
      resolve({ db, name, close: () => db.close() });
    };
    request.onerror = () => {
      reject(request.error ?? new Error(`could not open the asset store "${name}"`));
    };
  });
}

/**
 * Runs one request in a transaction over the named stores and resolves with its result once the transaction
 * commits. A failed or aborted transaction rejects, so a caller never treats an unwritten file as written.
 */
function transact<T>(
  db: IDBDatabase,
  stores: string | readonly string[],
  mode: IDBTransactionMode,
  request: (tx: IDBTransaction) => IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let value: T | undefined;
    const pending = request(tx);
    pending.onsuccess = () => {
      value = pending.result;
    };
    tx.oncomplete = () => resolve(value as T);
    tx.onerror = () => reject(tx.error ?? pending.error ?? new Error('the asset write failed'));
    tx.onabort = () => reject(tx.error ?? new Error('the asset transaction was aborted, so nothing was written'));
  });
}

/** Stores one file's bytes under a project and path, replacing any earlier file at that path. */
export async function putAssetBytes(store: AssetStore, projectId: string, path: string, bytes: Uint8Array): Promise<void> {
  // A copy, so a later change to the caller's buffer cannot change what is stored.
  const row: AssetRow = { projectId, path, bytes: bytes.slice() };
  await transact(store.db, ASSET_STORE, 'readwrite', (tx) => tx.objectStore(ASSET_STORE).put(row));
}

/** One stored file's bytes, or `undefined` when the project has no file at that path. */
export async function getAssetBytes(store: AssetStore, projectId: string, path: string): Promise<Uint8Array | undefined> {
  const row = await transact<AssetRow | undefined>(store.db, ASSET_STORE, 'readonly', (tx) => tx.objectStore(ASSET_STORE).get([projectId, path]));
  return row?.bytes;
}

/** Every stored path of one project, sorted. */
export async function listAssetPaths(store: AssetStore, projectId: string): Promise<string[]> {
  const rows = await transact<AssetRow[]>(store.db, ASSET_STORE, 'readonly', (tx) => tx.objectStore(ASSET_STORE).index(ASSET_PROJECT_INDEX).getAll(projectId));
  return rows.map((row) => row.path).sort();
}

/**
 * Removes one stored file of one project (the sweep's removal, §6.4.2). Resolves `true` when the store held
 * the file and `false` when it did not, so a caller never reports a removal that did not happen. Thumbnails
 * of the file are removed with it; no other project and no other file is touched.
 */
export async function deleteAssetBytes(store: AssetStore, projectId: string, path: string): Promise<boolean> {
  const held = await getAssetBytes(store, projectId, path);
  if (held === undefined) {
    // Not held as a file: still drop any thumbnail rows for the path, and say nothing was removed.
    await deleteThumbsOf(store, projectId, path);
    return false;
  }
  await transact(store.db, ASSET_STORE, 'readwrite', (tx) => tx.objectStore(ASSET_STORE).delete([projectId, path]));
  await deleteThumbsOf(store, projectId, path);
  return true;
}

/** Stores one thumbnail, replacing any earlier one of the same project, path and size. */
export async function putThumb(store: AssetStore, projectId: string, path: string, size: number, bytes: Uint8Array): Promise<void> {
  const row: ThumbRow = { projectId, path, size, bytes: bytes.slice() };
  await transact(store.db, THUMBS_STORE, 'readwrite', (tx) => tx.objectStore(THUMBS_STORE).put(row));
}

/** One stored thumbnail, or `undefined` when none was stored at that size. */
export async function getThumb(store: AssetStore, projectId: string, path: string, size: number): Promise<Uint8Array | undefined> {
  const row = await transact<ThumbRow | undefined>(store.db, THUMBS_STORE, 'readonly', (tx) => tx.objectStore(THUMBS_STORE).get([projectId, path, size]));
  return row?.bytes;
}

/** Every stored thumbnail row of one project, for a sweep of the store's own housekeeping. */
export async function listThumbs(store: AssetStore, projectId: string): Promise<ThumbRow[]> {
  return transact<ThumbRow[]>(store.db, THUMBS_STORE, 'readonly', (tx) => tx.objectStore(THUMBS_STORE).index(THUMBS_PROJECT_INDEX).getAll(projectId));
}

/** Removes every thumbnail of one asset path of one project. */
async function deleteThumbsOf(store: AssetStore, projectId: string, path: string): Promise<void> {
  const rows = await listThumbs(store, projectId);
  for (const row of rows) {
    if (row.path === path) {
      await transact(store.db, THUMBS_STORE, 'readwrite', (tx) => tx.objectStore(THUMBS_STORE).delete([projectId, path, row.size]));
    }
  }
}

/** Removes every stored file and every thumbnail of one project, and returns how many files were removed. Nothing else is touched. */
export async function deleteProjectAssets(store: AssetStore, projectId: string): Promise<number> {
  const paths = await listAssetPaths(store, projectId);
  for (const path of paths) {
    await transact(store.db, ASSET_STORE, 'readwrite', (tx) => tx.objectStore(ASSET_STORE).delete([projectId, path]));
  }
  const thumbs = await listThumbs(store, projectId);
  for (const row of thumbs) {
    await transact(store.db, THUMBS_STORE, 'readwrite', (tx) => tx.objectStore(THUMBS_STORE).delete([projectId, row.path, row.size]));
  }
  return paths.length;
}
