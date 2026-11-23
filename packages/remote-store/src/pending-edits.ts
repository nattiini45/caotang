/**
 * Offline edits — [hosted.md §7](docs/architecture/hosted.md). A save made while the server is unreachable, and the
 * replay that sends it once it is back.
 *
 * The queue holds the **latest** state of each path, because only that state was ever going to be written: a file
 * edited twice offline is one write of the second text, and a file deleted after being edited is one removal. It is
 * plain data — {@link PendingEdits.serialize} is what the app keeps in its device store between sessions — and it
 * needs no key: the paths and the words are already in this device's memory, and sealing them for a local store
 * would only add a second thing to lose.
 *
 * Replay is all-or-nothing, like a save: it commits every staged path in one index swap. A conflict keeps the whole
 * queue, so nothing is lost while the writer answers; after {@link EncryptedRemoteArtifactFs.refresh} the answer
 * "keep mine" is another replay (which now writes on top of the other device's version) and "take theirs" is
 * {@link PendingEdits.clear} of the paths named in {@link RemoteConflictError.paths}.
 */
import { decodeBase64, encodeBase64 } from '@caotang/crypto';
import { assertContained } from '@caotang/store';
import { RemoteUnavailableError } from './blob-store.js';
import type { EncryptedRemoteArtifactFs, RemoteChange } from './encrypted-remote-fs.js';

export type SaveOutcome = 'saved' | 'queued';

const QUEUE_FORMAT = 1;

function toBytes(contents: string | Uint8Array): Uint8Array {
  return typeof contents === 'string' ? new TextEncoder().encode(contents) : contents.slice();
}

/** What a save left waiting: one entry per path, in the order it was first staged. */
export class PendingEdits {
  readonly #edits = new Map<string, Uint8Array | null>();

  /** Stages a file's new contents; a later stage of the same path replaces it. */
  stage(path: string, contents: string | Uint8Array): void {
    assertContained(path);
    if (path === '') throw new Error('a project file needs a path');
    this.#edits.set(path, toBytes(contents));
  }

  /** Stages a deletion; a later stage of the same path replaces it, and a deletion after a write removes the write. */
  stageRemoval(path: string): void {
    assertContained(path);
    if (path === '') throw new Error('a project file needs a path');
    this.#edits.set(path, null);
  }

  stageAll(changes: readonly RemoteChange[]): void {
    for (const change of changes) {
      if (change.bytes === null) this.stageRemoval(change.path);
      else this.stage(change.path, change.bytes);
    }
  }

  get size(): number {
    return this.#edits.size;
  }

  get isEmpty(): boolean {
    return this.#edits.size === 0;
  }

  /** The staged paths, in the order they were first staged. */
  get paths(): readonly string[] {
    return [...this.#edits.keys()];
  }

  /** The batch to hand {@link EncryptedRemoteArtifactFs.commitChanges}. */
  changes(): RemoteChange[] {
    return [...this.#edits].map(([path, bytes]) => ({ path, bytes }));
  }

  /** Forgets the staged state of these paths, or of every path when none are named. */
  clear(paths?: readonly string[]): void {
    if (paths === undefined) this.#edits.clear();
    else for (const path of paths) this.#edits.delete(path);
  }

  /**
   * Forgets what a sent batch carried, and only where the path still holds exactly that: an edit staged while the
   * commit was in flight is newer than what the server took and stays queued for the next replay. `clear()` cannot be
   * used for this — it would drop that edit without a word, and the writer would have been told the save landed.
   */
  settle(sent: readonly RemoteChange[]): void {
    for (const change of sent) if (this.#edits.get(change.path) === change.bytes) this.#edits.delete(change.path);
  }

  /** The queue as text, for the device store. Bytes travel as canonical base64; a removal travels as `null`. */
  serialize(): string {
    const edits = [...this.#edits].map(([path, bytes]) => [path, bytes === null ? null : encodeBase64(bytes)]);
    return JSON.stringify({ format: QUEUE_FORMAT, edits });
  }

  static parse(text: string): PendingEdits {
    const fail = (detail: string): never => {
      throw new Error(`the saved offline queue is unreadable: ${detail}`);
    };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (cause) {
      return fail(String(cause));
    }
    if (typeof raw !== 'object' || raw === null || !('format' in raw) || raw.format !== QUEUE_FORMAT) return fail('unknown format');
    const edits: unknown = 'edits' in raw ? raw.edits : undefined;
    if (!Array.isArray(edits)) return fail('no edits');
    const queue = new PendingEdits();
    for (const row of edits as unknown[]) {
      if (!Array.isArray(row) || row.length !== 2) return fail('a malformed row');
      const [path, value] = row as unknown[];
      if (typeof path !== 'string' || (value !== null && typeof value !== 'string')) return fail('a malformed row');
      if (value === null) queue.stageRemoval(path);
      else queue.stage(path, decodeBase64(value));
    }
    return queue;
  }
}

/**
 * Sends every staged edit in one commit and empties the queue once the server has them. A conflict or an unreachable
 * server throws and leaves the queue as it was.
 */
export async function replayPending(fs: EncryptedRemoteArtifactFs, edits: PendingEdits): Promise<number> {
  if (edits.isEmpty) return 0;
  const changes = edits.changes();
  await fs.commitChanges(changes);
  edits.settle(changes);
  return changes.length;
}

/**
 * Saves through the remote store, or holds the changes in the queue while the server cannot be reached. The queue is
 * staged before the attempt, so a call that is interrupted between the commit and the answer does not drop the edit:
 * the next replay writes the same words again, which costs one version and changes nothing else.
 *
 * A conflict is never swallowed: it reaches the caller, which asks the writer, and the queue keeps every staged path
 * until that answer arrives.
 */
export async function saveOrQueue(fs: EncryptedRemoteArtifactFs, edits: PendingEdits, changes: readonly RemoteChange[]): Promise<SaveOutcome> {
  edits.stageAll(changes);
  try {
    await replayPending(fs, edits);
    return 'saved';
  } catch (error) {
    if (error instanceof RemoteUnavailableError) return 'queued';
    throw error;
  }
}
