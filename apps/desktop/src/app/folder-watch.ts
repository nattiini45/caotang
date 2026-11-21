/**
 * What the open folder's watcher means for the session (desktop.md §External folder changes, #403). The main process reports
 * project-relative paths another program touched; this decides which of them the open copy can speak about, and whether the
 * folder's bytes still match the copy the session holds. A save of this tab's own moves that copy on as it writes, so its own
 * writes never read as someone else's.
 */

import { ArtifactNotFoundError, digestOfBytes, MANIFEST_FILE } from '@caotang/store';

import type { FolderBaseline } from './session.js';

/** Reads a folder file as it stands, `null` when the folder no longer holds it, and rejects when it could not be read. */
export type ChangedReader = (path: string) => Promise<Uint8Array | null>;

/**
 * The comparison's reader over a folder that throws for a file it does not hold: the adapter's own not-found is a deletion,
 * which is offered, and every other failure stays a question the offer does not answer.
 */
export function folderReader(read: (path: string) => Promise<Uint8Array>): ChangedReader {
  return async (path) => {
    try {
      return await read(path);
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) return null;
      throw error;
    }
  };
}

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
    // A read that fails says nothing about the file: a locked or briefly missing handle is not an edit to offer.
    const bytes = await read(path).catch(() => undefined);
    if (bytes === undefined) continue;
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

/** How many paths one pass reads, so a burst larger than one pass yields to the event loop between passes rather than blocking it. */
export const READ_PASS = 40;

/**
 * The known paths whose bytes no longer match the copy, however many were reported: a burst of two hundred files is read in passes
 * rather than cut off at the first one, so every reported path is judged and the offer counts what actually changed (#775).
 */
export async function allExternalChanges(
  baseline: FolderBaseline,
  paths: readonly string[],
  read: ChangedReader,
): Promise<readonly string[]> {
  const known = knownChanges(baseline, paths);
  const changed: string[] = [];
  for (let index = 0; index < known.length; index += READ_PASS) {
    changed.push(...await externalChanges(baseline, known.slice(index, index + READ_PASS), read));
  }
  return changed;
}

/**
 * The changes to offer: the folder's bytes differ from the copy this session holds, and still differ once this session has no write of
 * its own into the folder outstanding, judged against the copy that write left behind. A save of this tab's own can outlast any fixed
 * delay on a project of a few hundred documents, so the second read waits on the save itself rather than on a timer (#778).
 */
export async function confirmedChanges(
  paths: readonly string[],
  copy: () => FolderBaseline | null,
  read: (target: FolderBaseline) => ChangedReader,
  writesSettled: () => Promise<void>,
): Promise<readonly string[]> {
  const before = copy();
  if (before === null) return [];
  const first = await allExternalChanges(before, paths, read(before));
  if (first.length === 0) return [];
  await writesSettled();
  const after = copy();
  if (after === null) return [];
  return allExternalChanges(after, first, read(after));
}

/** How many changed files an offer names before it counts the rest, so a bulk edit does not fill the line. */
export const NAMED_CHANGES = 3;

/** What the offer says about the changed files: their names, and how many more there are. */
export function changeSummary(paths: readonly string[], nameOf: (path: string) => string): { readonly names: readonly string[]; readonly more: number } {
  return { names: paths.slice(0, NAMED_CHANGES).map(nameOf), more: Math.max(0, paths.length - NAMED_CHANGES) };
}
