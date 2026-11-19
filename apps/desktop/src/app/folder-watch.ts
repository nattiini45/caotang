/**
 * What the open folder's watcher means for the session (desktop.md §External folder changes, #403). The main process reports
 * project-relative paths another program touched; this decides which of them the open copy can speak about, and whether the
 * folder's bytes still match the copy the session holds. A save of this tab's own moves that copy on as it writes, so its own
 * writes never read as someone else's.
 */

import { digestOfBytes, MANIFEST_FILE } from '@caotang/store';

import type { FolderBaseline } from './session.js';

/** Reads a folder file as it stands, or `null` when the folder no longer holds it. */
export type ChangedReader = (path: string) => Promise<Uint8Array | null>;

/**
 * The reported paths this copy can judge: the manifest, which it keeps as text, and the project files whose digests it holds.
 * Anything else is another file in the folder, which no save and no reload of this copy touches.
 */
export function knownChanges(baseline: FolderBaseline, paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].filter((path) => path === MANIFEST_FILE || baseline.digests.has(path));
}

/**
 * The known paths whose bytes no longer match the copy: the folder moved on outside Caotang. A file the folder no longer holds
 * counts as changed, so a document another program deleted is offered rather than saved back over silence.
 */
export async function externalChanges(
  baseline: FolderBaseline,
  paths: readonly string[],
  read: ChangedReader,
): Promise<readonly string[]> {
  const changed: string[] = [];
  for (const path of knownChanges(baseline, paths)) {
    const bytes = await read(path).catch(() => null);
    if (bytes === null) {
      changed.push(path);
      continue;
    }
    const same = path === MANIFEST_FILE
      ? new TextDecoder().decode(bytes) === baseline.manifestText
      : (await digestOfBytes(bytes)) === baseline.digests.get(path);
    if (!same) changed.push(path);
  }
  return changed;
}

/** How many changed files an offer names before it counts the rest, so a bulk edit does not fill the line. */
export const NAMED_CHANGES = 3;

/** What the offer says about the changed files: their names, and how many more there are. */
export function changeSummary(paths: readonly string[], nameOf: (path: string) => string): { readonly names: readonly string[]; readonly more: number } {
  return { names: paths.slice(0, NAMED_CHANGES).map(nameOf), more: Math.max(0, paths.length - NAMED_CHANGES) };
}
