/**
 * The app-level IndexedDB database: the settings, the non-secret provider profile records, the usage ledger's day rows
 * and the request log (ui-modules §5, provider-gateway §4 and §6).
 *
 * It is a database of its own, apart from the project store and the key vault, on purpose. Nothing a project export
 * carries comes from here, and nothing here can carry a credential: the key lives only in the vault (provider-gateway
 * §7), and a profile record has no key field. Every value is one JSON-shaped record under one key, so a reader never
 * sees half of a save.
 *
 * Opening is the only call that can fail for a reason the caller must report. Every later call either returns what is
 * stored or throws, and the caller decides what the writer is told; the app keeps working on defaults when it cannot
 * read or write here.
 */

import type { TaskRunRecord } from '@caotang/tasks';

/** The database name. No project uses it, and the project store has its own. */
export const APP_DB_NAME = 'caotang-app';
/**
 * Version 2 adds the editor's history journals (`STORE_HISTORY`); version 3 adds the writer's reviews of a project's skills
 * (`STORE_SKILL_REVIEWS`); version 4 adds the run history of a project's recurring tasks (`STORE_TASK_RUNS`). Each upgrade only adds
 * a store, so the `kv` records, the journals and the reviews are untouched by it.
 */
const APP_DB_VERSION = 4;
const STORE_KV = 'kv';
/** Per-document undo journals (history-store.ts), keyed `<projectId>:<docId>`. Per-viewer state: no export, bundle or agent reads it. */
const STORE_HISTORY = 'editor-history';
/** One small row for each journal (project, document, when it was last written), so a sweep reads these and not the journals. */
const STORE_HISTORY_META = 'editor-history-meta';

/**
 * The writer's review of each skill, keyed `<projectId>:<skill name>` (skill-reviews.ts). Kept here and never in a project, a bundle or an
 * export, so a shared project cannot ship its own approval (extensibility.md §10).
 */
const STORE_SKILL_REVIEWS = 'skill-reviews';

/**
 * When each recurring task of a project last ran on this machine, and its history (task-runs.ts), keyed `<projectId>:<taskId>`. Kept
 * here and never in a project, a bundle or an export: what a writer has already seen is the writer's, not the folder's.
 */
const STORE_TASK_RUNS = 'task-runs';

/** The record keys. One value per key, so a save replaces a whole record at once. */
export const APP_KEYS = {
  settings: 'settings',
  profiles: 'profiles',
  usage: 'usage',
  requests: 'requests',
} as const;

/** A kept undo journal. The journal is the editor's (`HistoryJournal`); this database only stores it. */
export interface HistoryRecord {
  readonly key: string;
  readonly projectId: string;
  readonly docId: string;
  readonly updatedAt: number;
  readonly journal: unknown;
}

/** What is known about a kept journal without reading it. */
export type HistoryMeta = Omit<HistoryRecord, 'journal'>;

/** The journals of the editor's history, in the database's `editor-history` stores (history-store.ts). */
export interface HistoryDb {
  /** The journal kept under `key`, or `undefined`. */
  get(key: string): Promise<HistoryRecord | undefined>;
  /** Replaces the journal kept for a document. The journal and its row in the index are written in one transaction. */
  put(record: HistoryRecord): Promise<void>;
  /** Removes the journals kept under these keys. */
  delete(keys: readonly string[]): Promise<void>;
  /** Every kept journal's project, document and last write, without the journals. */
  list(): Promise<readonly HistoryMeta[]>;
}

/** One review: the writer read the skill `name` of project `projectId` as it was when its pin was `pin`, at `reviewedAt` (ISO-8601). */
export interface SkillReviewRecord {
  readonly key: string;
  readonly projectId: string;
  readonly name: string;
  readonly pin: string;
  readonly reviewedAt: string;
}

/** The writer's skill reviews, in the database's `skill-reviews` store. */
export interface SkillReviewDb {
  /** Every review kept for a project. */
  list(projectId: string): Promise<readonly SkillReviewRecord[]>;
  put(record: SkillReviewRecord): Promise<void>;
  /** Removes the reviews kept under these keys. */
  delete(keys: readonly string[]): Promise<void>;
}

/** The runs of one recurring task of one project on this machine, newest first and bounded (`withRun` in `@caotang/tasks`). */
export interface TaskRunRow {
  readonly key: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly history: readonly TaskRunRecord[];
}

/** The recurring tasks' run history, in the database's `task-runs` store. */
export interface TaskRunDb {
  /** Every task's history kept for a project. */
  list(projectId: string): Promise<readonly TaskRunRow[]>;
  put(row: TaskRunRow): Promise<void>;
  /** Removes the histories kept under these keys. */
  delete(keys: readonly string[]): Promise<void>;
}

/** One record of the `kv` store, as `AppDb.list` returns it. */
export interface KvRow<T = unknown> {
  readonly key: string;
  readonly value: T;
}

export interface AppDb {
  /** The value stored under `key`, or `undefined` when nothing has been stored there. */
  get<T>(key: string): Promise<T | undefined>;
  /** Replaces the value under `key`. Resolves when the transaction has committed. */
  put(key: string, value: unknown): Promise<void>;
  /** Every record whose key starts with `prefix`, in key order. The background tasks of a project are read this way (task-store.ts). */
  list<T>(prefix: string): Promise<readonly KvRow<T>[]>;
  /** Removes the record under `key`. A key with nothing stored is not an error. */
  delete(key: string): Promise<void>;
  /** The editor's undo journals. Absent on a stand-in that keeps only settings; the editor then keeps no undo across a reload. */
  readonly history?: HistoryDb;
  /** The writer's skill reviews. Absent on a stand-in that keeps only settings; no skill is then reviewed across a reload. */
  readonly reviews?: SkillReviewDb;
  /** The recurring tasks' run history. Absent on a stand-in that keeps only settings; a task is then offered again after a reload. */
  readonly taskRuns?: TaskRunDb;
  close(): void;
}

/** Runs one IDB request inside its own transaction and resolves with its result once the transaction commits. */
function requestOf<T>(request: IDBRequest<T>, tx: IDBTransaction): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let result: T | undefined;
    request.onsuccess = () => {
      result = request.result;
    };
    tx.oncomplete = () => resolve(result as T);
    tx.onerror = () => reject(tx.error ?? new Error('The app database transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('The app database transaction was aborted.'));
  });
}

/** Resolves once the transaction has committed, for a transaction that makes several requests. */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('The app database transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('The app database transaction was aborted.'));
  });
}

/**
 * Opens the app database. `factory` is the browser's `indexedDB`, or a stand-in in a test. Rejects when the open fails,
 * which the caller turns into a notice and an app that runs on defaults.
 */
export function openAppDb(factory: IDBFactory, name: string = APP_DB_NAME): Promise<AppDb> {
  return new Promise<AppDb>((resolve, reject) => {
    const request = factory.open(name, APP_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Each store is made only when it is missing, so an upgrade from version 1 keeps the `kv` records and adds the journals.
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORE_HISTORY)) db.createObjectStore(STORE_HISTORY, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORE_HISTORY_META)) db.createObjectStore(STORE_HISTORY_META, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORE_SKILL_REVIEWS)) {
        db.createObjectStore(STORE_SKILL_REVIEWS, { keyPath: 'key' }).createIndex('byProject', 'projectId');
      }
      if (!db.objectStoreNames.contains(STORE_TASK_RUNS)) {
        db.createObjectStore(STORE_TASK_RUNS, { keyPath: 'key' }).createIndex('byProject', 'projectId');
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      resolve({
        async get<T>(key: string): Promise<T | undefined> {
          const tx = db.transaction(STORE_KV, 'readonly');
          const row = await requestOf(tx.objectStore(STORE_KV).get(key) as IDBRequest<{ key: string; value: T } | undefined>, tx);
          return row?.value;
        },
        async put(key: string, value: unknown): Promise<void> {
          const tx = db.transaction(STORE_KV, 'readwrite');
          await requestOf(tx.objectStore(STORE_KV).put({ key, value }) as IDBRequest<IDBValidKey>, tx);
        },
        async list<T>(prefix: string): Promise<readonly KvRow<T>[]> {
          const tx = db.transaction(STORE_KV, 'readonly');
          // A key range narrows the read where the host has one; the filter below keeps the answer exact where it does not.
          const range = typeof IDBKeyRange === 'undefined' ? undefined : IDBKeyRange.bound(prefix, `${prefix}￿`);
          const rows = await requestOf(tx.objectStore(STORE_KV).getAll(range) as IDBRequest<KvRow<T>[]>, tx);
          return rows.filter((row) => row.key.startsWith(prefix)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        },
        async delete(key: string): Promise<void> {
          const tx = db.transaction(STORE_KV, 'readwrite');
          await requestOf(tx.objectStore(STORE_KV).delete(key) as IDBRequest<undefined>, tx);
        },
        history: {
          async get(key: string): Promise<HistoryRecord | undefined> {
            const tx = db.transaction([STORE_HISTORY, STORE_HISTORY_META], 'readonly');
            const journal = tx.objectStore(STORE_HISTORY).get(key) as IDBRequest<{ key: string; journal: unknown } | undefined>;
            const meta = tx.objectStore(STORE_HISTORY_META).get(key) as IDBRequest<HistoryMeta | undefined>;
            await committed(tx);
            if (journal.result === undefined || meta.result === undefined) return undefined;
            return { ...meta.result, journal: journal.result.journal };
          },
          async put(record: HistoryRecord): Promise<void> {
            const tx = db.transaction([STORE_HISTORY, STORE_HISTORY_META], 'readwrite');
            const { journal, ...meta } = record;
            tx.objectStore(STORE_HISTORY).put({ key: record.key, journal });
            tx.objectStore(STORE_HISTORY_META).put(meta);
            await committed(tx);
          },
          async delete(keys: readonly string[]): Promise<void> {
            if (keys.length === 0) return;
            const tx = db.transaction([STORE_HISTORY, STORE_HISTORY_META], 'readwrite');
            for (const key of keys) {
              tx.objectStore(STORE_HISTORY).delete(key);
              tx.objectStore(STORE_HISTORY_META).delete(key);
            }
            await committed(tx);
          },
          async list(): Promise<readonly HistoryMeta[]> {
            const tx = db.transaction(STORE_HISTORY_META, 'readonly');
            return requestOf(tx.objectStore(STORE_HISTORY_META).getAll() as IDBRequest<HistoryMeta[]>, tx);
          },
        },
        reviews: {
          async list(projectId: string): Promise<readonly SkillReviewRecord[]> {
            const tx = db.transaction(STORE_SKILL_REVIEWS, 'readonly');
            return requestOf(tx.objectStore(STORE_SKILL_REVIEWS).index('byProject').getAll(projectId) as IDBRequest<SkillReviewRecord[]>, tx);
          },
          async put(record: SkillReviewRecord): Promise<void> {
            const tx = db.transaction(STORE_SKILL_REVIEWS, 'readwrite');
            tx.objectStore(STORE_SKILL_REVIEWS).put(record);
            await committed(tx);
          },
          async delete(keys: readonly string[]): Promise<void> {
            if (keys.length === 0) return;
            const tx = db.transaction(STORE_SKILL_REVIEWS, 'readwrite');
            for (const key of keys) tx.objectStore(STORE_SKILL_REVIEWS).delete(key);
            await committed(tx);
          },
        },
        taskRuns: {
          async list(projectId: string): Promise<readonly TaskRunRow[]> {
            const tx = db.transaction(STORE_TASK_RUNS, 'readonly');
            return requestOf(tx.objectStore(STORE_TASK_RUNS).index('byProject').getAll(projectId) as IDBRequest<TaskRunRow[]>, tx);
          },
          async put(row: TaskRunRow): Promise<void> {
            const tx = db.transaction(STORE_TASK_RUNS, 'readwrite');
            tx.objectStore(STORE_TASK_RUNS).put(row);
            await committed(tx);
          },
          async delete(keys: readonly string[]): Promise<void> {
            if (keys.length === 0) return;
            const tx = db.transaction(STORE_TASK_RUNS, 'readwrite');
            for (const key of keys) tx.objectStore(STORE_TASK_RUNS).delete(key);
            await committed(tx);
          },
        },
        close(): void {
          db.close();
        },
      });
    };
    request.onerror = () => reject(request.error ?? new Error('The app database could not be opened.'));
    request.onblocked = () => reject(new Error('The app database is open in another tab, so it cannot be upgraded here.'));
  });
}

/**
 * The app database this session uses, for the records that belong to a project but are kept here until the store can hold
 * them (the coherence file and the saved furniture; see `coherence-io.ts` and `furniture-store.ts`). Set once the services
 * are open. `null` means no database, and those records are then kept for the session only.
 */
let activeDb: AppDb | null = null;

export function setActiveAppDb(db: AppDb | null): void {
  activeDb = db;
}

export function activeAppDb(): AppDb | null {
  return activeDb;
}
