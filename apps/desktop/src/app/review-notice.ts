/**
 * What a reload owes the writer about suggestions that were still marked (editor-engine §15).
 *
 * The marks live only in the open editor. The store holds the accepted text, so a reload (or a closed tab) opens on the agent's text,
 * and this record is how the editor says so, once. It is one small row for each document in the app database's `kv` store, written
 * whenever the count of marked suggestions changes and removed when it reaches zero. It is per-viewer state: no project, bundle or
 * export carries it, and it holds counts and ids, never text.
 */

import type { AppDb } from './app-db.js';


/** What is left unresolved in one document. */
export interface ReviewRecord {
  readonly docId: string;
  readonly count: number;
  /** The agent turn that made the suggestions, or `null` when the editor no longer knows it. */
  readonly turnId: string | null;
}

export const reviewKey = (projectId: string, docId: string): string => `review-pending:${projectId}:${docId}`;

/**
 * Notes how many suggestions a document holds now. Best effort: a database that is missing or full means no notice after a reload,
 * never a lost word, because the text is the store's.
 */
export async function recordPending(
  projectId: string,
  docId: string,
  count: number,
  turnId: string | null,
  db: AppDb | null,
): Promise<void> {
  if (db === null) return;
  try {
    if (count <= 0) await db.delete(reviewKey(projectId, docId));
    else await db.put(reviewKey(projectId, docId), { docId, count, turnId } satisfies ReviewRecord);
  } catch {
    // Best effort, as the undo journal is.
  }
}

/** The record of a document, removed as it is read: the notice is shown once. `null` when nothing was left unresolved. */
export async function takePending(projectId: string, docId: string, db: AppDb | null): Promise<ReviewRecord | null> {
  if (db === null) return null;
  try {
    const record = await db.get<ReviewRecord>(reviewKey(projectId, docId));
    if (record === undefined) return null;
    await db.delete(reviewKey(projectId, docId));
    return Number.isInteger(record.count) && record.count > 0 ? record : null;
  } catch {
    return null;
  }
}
