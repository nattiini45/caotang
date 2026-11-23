/**
 * A project's whole save into the account — [hosted.md §5, §7, §11](docs/architecture/hosted.md). The app assembles a
 * project and writes it file by file; on the account that save has to be one index swap, and a file another device changed
 * has to come back as the "files changed" question rather than as a lost write.
 *
 * So a save stages into {@link BatchedSave} and commits once. When the commit loses to another device, the answer is the
 * paths that moved, with nothing written — the caller asks the writer, which is the same question a folder save asks. A save
 * that cannot reach the server at all is `unavailable`, and holding it for later is the queue's business, not this
 * function's.
 */
import { DOCS_DIR, writeProject, type ProjectState, type WriteOptions, type WriteReport } from '@caotang/store';
import { BatchedSave } from './batched-save.js';
import type { EncryptedRemoteArtifactFs, RemoteChange } from './encrypted-remote-fs.js';
import { RemoteUnavailableError } from './blob-store.js';
import { RemoteConflictError } from './errors.js';

export type HostedSaveOutcome =
  | { readonly kind: 'written'; readonly report: WriteReport }
  /**
   * Another device changed these paths: nothing was written, and the writer answers. `changes` is the save as it was staged,
   * so "keep mine" is one replay on top of the other device's version rather than a second pass over the project.
   */
  | { readonly kind: 'conflict'; readonly paths: readonly string[]; readonly changes: readonly RemoteChange[] }
  /** The server did not answer: nothing was written, and `changes` is the save for the caller to queue. */
  | { readonly kind: 'unavailable'; readonly changes: readonly RemoteChange[] };

/** The project's documents on the account, as ids, from the listing the adapter holds. */
async function documentIdsOnAccount(fs: EncryptedRemoteArtifactFs): Promise<readonly string[]> {
  const names = await fs.listFiles(DOCS_DIR);
  return names.map((name) => name.slice(0, name.lastIndexOf('.'))).filter((id) => id !== '');
}

/**
 * Writes `state` to the account as one commit. `removed` are the documents this device deleted; the rest are read from the
 * account's own listing, so a document another device wrote is never pruned just because this copy does not hold it.
 */
export async function saveProjectToAccount(
  fs: EncryptedRemoteArtifactFs,
  state: ProjectState,
  options: WriteOptions & { readonly removed?: readonly string[] } = {},
): Promise<HostedSaveOutcome> {
  const save = new BatchedSave(fs);
  try {
    const onAccount = await documentIdsOnAccount(fs);
    const kept = new Set(state.documents.keys());
    const removed = new Set([...(options.removed ?? []), ...onAccount.filter((id) => !kept.has(id))]);
    const { removed: _removed, ...writeOptions } = options;
    const report = await writeProject(save, state, { ...writeOptions, pruneDocumentIds: [...removed] });
    await save.commit();
    return { kind: 'written', report };
  } catch (error) {
    // Read before the overlay goes: the staged save is what the writer's answer replays, or what waits in the queue.
    const changes = save.changes();
    save.discard();
    if (error instanceof RemoteConflictError) return { kind: 'conflict', paths: error.paths, changes };
    if (error instanceof RemoteUnavailableError) return { kind: 'unavailable', changes };
    throw error;
  }
}
