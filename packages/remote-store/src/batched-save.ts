/**
 * A save scope over the encrypted store — [hosted.md §5, §7](docs/architecture/hosted.md). The app assembles a whole
 * project folder in memory and writes it file by file (§4's write path), and every write on the remote store would
 * otherwise be its own index swap: a save of forty files would move the manifest forty times, each charged and each a
 * round trip. This binding of `ArtifactFs` holds one save's writes, deletions and directories and sends them as one
 * commit, so the store's own write path runs unchanged and the server sees one swap.
 *
 * It is a view, not a second store: nothing is written until {@link BatchedSave.commit}, a {@link BatchedSave.discard}
 * costs nothing, and a read sees what this save has staged before it asks the server. A commit that loses a race
 * throws with the overlay still in place, so the writer's answer (keep mine, or take theirs) is one call away.
 */
import { ArtifactNotFoundError, assertContained, joinPath, type ArtifactFs } from '@caotang/store';
import type { EncryptedRemoteArtifactFs, RemoteChange } from './encrypted-remote-fs.js';

export class BatchedSave implements ArtifactFs {
  readonly #inner: EncryptedRemoteArtifactFs;
  /** What this save writes, in the order it was staged; `null` is a removal. */
  readonly #files = new Map<string, Uint8Array | null>();
  readonly #dirs = new Set<string>();
  #closed = false;

  constructor(inner: EncryptedRemoteArtifactFs) {
    this.#inner = inner;
  }

  #open(): void {
    if (this.#closed) throw new Error('this save has already been committed or discarded');
  }

  #stage(path: string, bytes: Uint8Array | null): void {
    this.#open();
    assertContained(path);
    this.#files.set(path, bytes === null ? null : bytes.slice());
  }

  async read(path: string): Promise<string> {
    const staged = this.#files.get(path);
    if (staged === undefined) return this.#inner.read(path);
    if (staged === null) throw new ArtifactNotFoundError(path);
    return new TextDecoder('utf-8', { fatal: true }).decode(staged);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const staged = this.#files.get(path);
    if (staged === undefined) return this.#inner.readBytes(path);
    if (staged === null) throw new ArtifactNotFoundError(path);
    return staged.slice();
  }

  async writeAtomic(path: string, contents: string): Promise<void> {
    this.#stage(path, new TextEncoder().encode(contents));
  }

  async writeBytesAtomic(path: string, bytes: Uint8Array): Promise<void> {
    this.#stage(path, bytes);
  }

  async remove(path: string): Promise<void> {
    this.#stage(path, null);
  }

  async ensureDir(dir: string): Promise<void> {
    this.#open();
    assertContained(dir);
    let cursor = '';
    for (const segment of dir.split('/').filter(Boolean)) {
      cursor = joinPath(cursor, segment);
      this.#dirs.add(cursor);
    }
  }

  async listFiles(dir: string): Promise<string[]> {
    assertContained(dir);
    const names = new Set(await this.#inner.listFiles(dir));
    for (const [path, bytes] of this.#files) {
      if (parentOf(path) !== dir) continue;
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (bytes === null) names.delete(name);
      else names.add(name);
    }
    return [...names].sort();
  }

  async listDirs(dir: string): Promise<string[]> {
    assertContained(dir);
    const names = new Set(await this.#inner.listDirs(dir));
    const prefix = dir === '' ? '' : `${dir}/`;
    /** The directory of `path` that sits directly inside `dir`, or null when `path` is outside it or is `dir` itself. */
    const direct = (path: string): string | null => {
      if (path === dir || !path.startsWith(prefix)) return null;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === 0) return null;
      return slash === -1 ? rest : rest.slice(0, slash);
    };
    for (const staged of this.#dirs) {
      const name = direct(staged);
      if (name !== null) names.add(name);
    }
    // A file makes its parent directories exist without an `ensureDir`, as it does on a folder.
    for (const [path, bytes] of this.#files) {
      if (bytes === null) continue;
      const name = direct(parentOf(path));
      if (name !== null) names.add(name);
    }
    return [...names].sort();
  }

  async exists(path: string): Promise<boolean> {
    assertContained(path);
    if (path === '') return true;
    const staged = this.#files.get(path);
    if (staged !== undefined && staged !== null) return true;
    if (this.#dirs.has(path)) return true;
    const prefix = `${path}/`;
    for (const [other, bytes] of this.#files) if (bytes !== null && other.startsWith(prefix)) return true;
    for (const dir of this.#dirs) if (dir.startsWith(prefix)) return true;
    // A removal hides the file unless this save filled the path again, which the loops above already answered.
    if (staged === null) return false;
    return this.#inner.exists(path);
  }

  /** What the commit will send, for a caller that has to show the writer what a save touches. */
  changes(): RemoteChange[] {
    this.#open();
    return [...this.#files].map(([path, bytes]) => ({ path, bytes }));
  }

  get directories(): readonly string[] {
    this.#open();
    return [...this.#dirs];
  }

  get isEmpty(): boolean {
    this.#open();
    return this.#files.size === 0 && this.#dirs.size === 0;
  }

  /**
   * Sends everything this save holds as one index swap. A conflict throws with the overlay intact, so the caller can
   * `refresh()` the store and then either commit again (keep this device's text) or discard (take the other's). After
   * a successful commit the save is spent.
   */
  async commit(): Promise<void> {
    this.#open();
    await this.#inner.commitChanges(this.changes(), { dirs: this.directories });
    this.#closed = true;
    this.#files.clear();
    this.#dirs.clear();
  }

  /** Throws this save away. Nothing reached the server, so there is nothing to undo. */
  discard(): void {
    this.#open();
    this.#closed = true;
    this.#files.clear();
    this.#dirs.clear();
  }
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}
