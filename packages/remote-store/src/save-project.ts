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
import { writeProject, type ProjectState, type WriteOptions, type WriteReport } from '@caotang/store';
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
  | { readonly kind: 'unavailable'; readonly changes: readonly RemoteChange[] }
  /**
   * The save itself failed — a refusal this module has no name for, a blob that would not authenticate, a state it would not
   * write. Nothing was written either, so `changes` is what this device staged, for the caller to queue rather than lose.
   */
  | { readonly kind: 'failed'; readonly error: unknown; readonly changes: readonly RemoteChange[] };

/** `assets/` in a project: the pictures, the cover among them (project-format §2). */
const ASSETS_DIR = 'assets';

/**
 * The project's pictures as this device holds them, and the ones this device deleted. A removal is named rather than inferred from
 * the account's listing: another device's picture is on that listing too, and a save that never saw it would delete it.
 */
export interface SaveAssets {
  readonly files: Readonly<Record<string, Uint8Array>>;
  /** The paths this device deleted while the session was open. */
  readonly removed?: readonly string[];
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/**
 * Stages the pictures into the same commit as the project files, so a save that returns a picture to the account returns it in the
 * batch that names it: a file already there byte for byte is left as it is, and only a path this device deleted is removed.
 *
 * Reading the account's copy is what tells an unchanged picture from a changed one, and that read can fail when the account cannot be
 * reached. A failed read is not a reason to leave the picture out of the save: its bytes are this device's, they belong in the batch
 * that names them, and the commit is what decides whether the account will take them.
 */
async function stageAssets(save: BatchedSave, fs: EncryptedRemoteArtifactFs, assets: SaveAssets): Promise<void> {
  for (const [path, bytes] of Object.entries(assets.files)) {
    if (!path.startsWith(`${ASSETS_DIR}/`)) continue;
    let current: Uint8Array | null = null;
    try {
      current = (await fs.exists(path)) ? await fs.readBytes(path) : null;
    } catch {
      current = null;
    }
    if (current === null || !sameBytes(current, bytes)) await save.writeBytesAtomic(path, bytes);
  }
  for (const path of assets.removed ?? []) {
    if (!path.startsWith(`${ASSETS_DIR}/`)) continue;
    // A removal the account cannot be asked about is staged too: the commit refuses it if the file is not there or moved, which is the
    // same answer the writer would get from asking.
    try {
      if (!(await fs.exists(path))) continue;
    } catch {
      // Staged anyway: the commit decides.
    }
    await save.remove(path);
  }
}

/**
 * Writes `state` to the account as one commit. `removed` is the documents this device deleted while the session was open, and it is
 * the only source of a removal: the account's own listing holds other devices' documents too, and a save that pruned what it did not
 * hold would delete work it never saw.
 */
export async function saveProjectToAccount(
  fs: EncryptedRemoteArtifactFs,
  state: ProjectState,
  options: WriteOptions & { readonly removed?: readonly string[]; readonly assets?: SaveAssets } = {},
): Promise<HostedSaveOutcome> {
  const save = new BatchedSave(fs);
  try {
    const removed = options.removed ?? [];
    const { removed: _removed, assets, ...writeOptions } = options;
    const report = await writeProject(save, state, { ...writeOptions, pruneDocumentIds: [...removed] });
    if (assets !== undefined) await stageAssets(save, fs, assets);
    await save.commit();
    return { kind: 'written', report };
  } catch (error) {
    // Read before the overlay goes: the staged save is what the writer's answer replays, or what waits in the queue.
    const changes = save.changes();
    save.discard();
    if (error instanceof RemoteConflictError) return { kind: 'conflict', paths: error.paths, changes };
    if (error instanceof RemoteUnavailableError) return { kind: 'unavailable', changes };
    return { kind: 'failed', error, changes };
  }
}
