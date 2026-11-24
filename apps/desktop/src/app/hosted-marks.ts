/**
 * The rollback marks a hosted project keeps on this device rather than on the account —
 * [hosted.md §7](../../../docs/architecture/hosted.md#7-sync-conflicts-and-rollback): the highest version of each file and of the index
 * this device has seen, keyed by path hash. They are device memory by design, so a server serving older ciphertext is refused rather than
 * quietly accepted, and they are scoped to the account the studio belongs to so two accounts never read each other's.
 *
 * A save this device could not deliver is not kept here: v1 holds it in the tab it was typed in, and the queue that carries it across a
 * reload is the follow-up (hosted.md §7).
 */
import { scopedStoreName } from './storage-scope.js';
import { browserStorage } from './unsent-copy.js';

export const MARKS_KEY_PREFIX = 'caotang.hosted-marks.';

export function hostedMarksKey(projectId: string): string {
  return scopedStoreName(`${MARKS_KEY_PREFIX}${projectId}`);
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
