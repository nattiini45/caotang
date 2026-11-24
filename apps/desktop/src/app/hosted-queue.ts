/**
 * The two things a hosted project keeps on this device rather than on the account — [hosted.md §7](../../../docs/architecture/hosted.md#7-sync-conflicts-and-rollback).
 *
 * - **The offline queue**: the paths a save could not deliver, as the adapter's own text (`PendingEdits.serialize`), so they
 *   are sent once the server answers again and a reload does not drop the writer's words. This module keeps the text and never
 *   reads it: only the module that holds the adapter can turn it back into edits.
 * - **The rollback marks**: the highest version of each file and of the index this device has seen, keyed by path hash. They are
 *   device memory by design (§7), so a server serving older ciphertext is refused rather than quietly accepted.
 *
 * Both are scoped to the account the studio belongs to, so two accounts that imported the same bundle never read each other's
 * queue, and both tolerate a browser with no storage, a full quota, and a value this build did not write.
 */
import { scopedStoreName } from './storage-scope.js';
import { browserStorage } from './unsent-copy.js';

export const QUEUE_KEY_PREFIX = 'caotang.hosted-queue.';
export const MARKS_KEY_PREFIX = 'caotang.hosted-marks.';

/**
 * The most the queue writes, in characters of its text. A save that cannot be delivered is held in the open tab whatever its
 * size; past this the device cannot keep it across a reload, and the tab is the only copy until the server answers.
 */
export const QUEUE_CAP_CHARS = 4 * 1024 * 1024;

export function hostedQueueKey(projectId: string): string {
  return scopedStoreName(`${QUEUE_KEY_PREFIX}${projectId}`);
}

export function hostedMarksKey(projectId: string): string {
  return scopedStoreName(`${MARKS_KEY_PREFIX}${projectId}`);
}

/** The queue this device kept for the project, or `null` when there is none, the browser keeps no storage, or it read back empty. */
export function loadHostedQueue(projectId: string): string | null {
  try {
    const text = browserStorage()?.getItem(hostedQueueKey(projectId)) ?? null;
    return text === null || text === '' ? null : text;
  } catch {
    return null;
  }
}

/** Keeps the queue for the next open, or forgets it with `null`. Too large to keep is said to the caller rather than swallowed. */
export function saveHostedQueue(projectId: string, text: string | null): boolean {
  try {
    const storage = browserStorage();
    if (storage === undefined) return text === null;
    if (text === null) {
      storage.removeItem(hostedQueueKey(projectId));
      return true;
    }
    if (text.length > QUEUE_CAP_CHARS) return false;
    storage.setItem(hostedQueueKey(projectId), text);
    return true;
  } catch {
    return false;
  }
}

/** A mark is `[path hash, version]`, both from the adapter; anything else is a value this build did not write. */
function isMark(row: unknown): row is readonly [string, number] {
  return Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && Number.isSafeInteger(row[1]) && (row[1] as number) > 0;
}

/** The rollback marks this device kept for the project, oldest news dropped: a mark is a floor, so a lost row only trusts more. */
export function loadHostedMarks(projectId: string): [string, number][] {
  try {
    const text = browserStorage()?.getItem(hostedMarksKey(projectId));
    if (text === null || text === undefined || text === '') return [];
    const raw: unknown = JSON.parse(text);
    if (!Array.isArray(raw)) return [];
    return raw.filter(isMark).map(([key, version]) => [key, version]);
  } catch {
    return [];
  }
}

/** Keeps the marks for the next open; an empty set forgets the key, because a device that has seen nothing trusts what it meets. */
export function saveHostedMarks(projectId: string, entries: readonly (readonly [string, number])[]): void {
  try {
    const storage = browserStorage();
    if (storage === undefined) return;
    if (entries.length === 0) {
      storage.removeItem(hostedMarksKey(projectId));
      return;
    }
    storage.setItem(hostedMarksKey(projectId), JSON.stringify(entries));
  } catch {
    // A full or blocked store costs the rollback memory, never the save.
  }
}
