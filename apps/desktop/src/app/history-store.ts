/**
 * The undo journals the editor keeps across a reload (editor-engine §7, `@caotang/editor/tiptap` `history-journal.ts`), in the app database
 * (`editor-history`, app-db.ts), one per document, keyed `<projectId>:<docId>`.
 *
 * They are per-viewer state, like the unsent copy: kept in this browser only, never in a project, a bundle or an export, and not read by the
 * agent. A journal only ever costs undo steps, never text (the pending journal keeps the text, pending-journal.ts), so every call here is best
 * effort: a database that is missing, closed or full means no kept undo, and the editor runs as it did before.
 *
 * The writes are debounced (one second after the last change, at most five seconds after the first) and made at once when the tab is hidden.
 * A journal leaves when its document is deleted, when its project is removed, and when it has not been written for 30 days.
 */

import type { HistoryJournal, HistoryPort } from '@caotang/editor/tiptap';

import { activeAppDb, type AppDb, type HistoryMeta } from './app-db.js';

/** A journal not written for this long is dropped by the sweep at start-up. */
export const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** How long after the last change a journal is written, and the longest a change waits while the writer keeps typing. */
export const HISTORY_WRITE_DELAY_MS = 1000;
export const HISTORY_WRITE_MAX_WAIT_MS = 5000;

export function historyKey(projectId: string, docId: string): string {
  return `${projectId}:${docId}`;
}

/**
 * The writes in flight, by journal key. Writes for one key land in the order they were asked for, whichever saver asked, and a read waits for
 * the write in flight: a document left and opened again within a moment finds the journal the first visit wrote.
 */
const writing = new Map<string, Promise<void>>();

/** The journal kept for a document, or `undefined` when there is none or the database cannot be read. */
export async function loadHistoryJournal(projectId: string, docId: string, db: AppDb | null = activeAppDb()): Promise<HistoryJournal | undefined> {
  if (db?.history === undefined) return undefined;
  try {
    await writing.get(historyKey(projectId, docId));
    return (await db.history?.get(historyKey(projectId, docId)))?.journal as HistoryJournal | undefined;
  } catch {
    return undefined;
  }
}

/** What the editor's history port needs, and the end of its life: `flush` writes what is waiting, `dispose` writes it and lets go of the tab's signals. */
export interface HistorySaver {
  readonly onChange: HistoryPort['onChange'];
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

/** The clock the saver waits on, so a test decides when the delay passes. */
export interface SaverTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

/** The part of `document` the saver reads: the tab being hidden is when it writes at once. */
export interface VisibilitySource {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

const SYSTEM_TIMERS: SaverTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * The writer for one editor's journal. `onChange` is the editor's port: it records that a write is due and which function reads the journal,
 * and does no other work. A write reads the journal then (which serializes the base once), so a burst of typing costs one write.
 */
export function createHistorySaver(
  projectId: string,
  docId: string,
  db: AppDb | null = activeAppDb(),
  timers: SaverTimers = SYSTEM_TIMERS,
  visibility: VisibilitySource | null = typeof document === 'undefined' ? null : document,
): HistorySaver {
  const key = historyKey(projectId, docId);
  let read: (() => HistoryJournal | null) | null = null;
  let waiting = false;
  let timer: unknown = null;
  let firstChangeAt = 0;

  const write = (): Promise<void> => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    if (!waiting || read === null || db?.history === undefined) {
      waiting = false;
      return writing.get(key) ?? Promise.resolve();
    }
    waiting = false;
    const journal = read();
    const database = db.history;
    const next = (writing.get(key) ?? Promise.resolve()).then(async () => {
      try {
        if (journal === null) await database.delete([key]);
        else await database.put({ key, projectId, docId, updatedAt: timers.now(), journal });
      } catch {
        // Best effort: a journal that was not kept costs undo steps after a reload, never text.
      }
    });
    writing.set(key, next);
    void next.then(() => {
      if (writing.get(key) === next) writing.delete(key);
    });
    return next;
  };

  const whenHidden = (): void => {
    if (visibility?.visibilityState === 'hidden') void write();
  };
  visibility?.addEventListener('visibilitychange', whenHidden);

  return {
    onChange(next) {
      read = next;
      if (!waiting) firstChangeAt = timers.now();
      waiting = true;
      if (timer !== null) timers.clearTimeout(timer);
      const overdue = firstChangeAt + HISTORY_WRITE_MAX_WAIT_MS - timers.now();
      timer = timers.setTimeout(() => void write(), Math.max(0, Math.min(HISTORY_WRITE_DELAY_MS, overdue)));
    },
    flush: write,
    async dispose() {
      visibility?.removeEventListener('visibilitychange', whenHidden);
      await write();
    },
  };
}

/**
 * Drops the journals of a project whose document is no longer in it (`keep` is the documents it has), or all of the project's when `keep` is
 * `null`. Called when the project opens, after a delete, and when the project is removed.
 */
export async function dropHistoryOf(projectId: string, keep: ReadonlySet<string> | null, db: AppDb | null = activeAppDb()): Promise<number> {
  if (db?.history === undefined) return 0;
  try {
    const doomed = (await db.history.list()).filter((meta) => meta.projectId === projectId && (keep === null || !keep.has(meta.docId)));
    await db.history.delete(doomed.map((meta) => meta.key));
    return doomed.length;
  } catch {
    return 0;
  }
}

/** Drops the journals not written for 30 days. Called once when the app opens. */
export async function sweepHistory(db: AppDb | null = activeAppDb(), now: number = Date.now()): Promise<number> {
  if (db?.history === undefined) return 0;
  try {
    const stale = (await db.history.list()).filter((meta: HistoryMeta) => now - meta.updatedAt > HISTORY_MAX_AGE_MS);
    await db.history.delete(stale.map((meta) => meta.key));
    return stale.length;
  } catch {
    return 0;
  }
}
