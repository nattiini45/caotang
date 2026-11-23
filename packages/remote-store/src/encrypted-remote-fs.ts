/**
 * `ArtifactFs` over an encrypted remote blob store — [hosted.md §5–§7](docs/architecture/hosted.md).
 *
 * The port is unchanged. What it cannot carry (a version on a write, a listing over hashed names, several files
 * in one commit) lives here:
 *
 *   - every file is a sealed blob under a random name, written once and never replaced;
 *   - one sealed `manifest` blob maps each path to its version and blob name, and lists the directories;
 *   - a write puts the new blob (create-only), then swaps the manifest with `If-Match`. The manifest swap is the
 *     commit: a 412 there means another device committed first, and is raised as {@link RemoteConflictError}
 *     naming the file. Nothing is ever overwritten silently, and a blob left by a lost race is never read;
 *   - a project save goes through {@link EncryptedRemoteArtifactFs.commitChanges}, which seals every file of the
 *     batch, puts each blob, then swaps the index once. A batch whose own files still match what this device read
 *     merges onto a state another device committed in between and retries, so an unrelated edit elsewhere is
 *     never a conflict; a batch that would overwrite a file another device changed names those files and writes
 *     nothing;
 *   - the manifest counter and each file version are bound into the sealed bytes and checked against the
 *     device's {@link HighWaterMarks}, so a replayed older state is refused.
 */
import {
  CryptoError,
  HighWaterMarks,
  hashPath,
  openFile,
  openManifest,
  sealFile,
  sealManifest,
  systemRandom,
  type RandomBytes,
  type SecretKey,
} from '@caotang/crypto';
import { ArtifactNotFoundError, assertContained, joinPath, type ArtifactFs } from '@caotang/store';
import { BlobPreconditionFailedError, type Precondition, type RemoteBlobStore } from './blob-store.js';
import { RemoteConflictError, RemoteIntegrityError } from './errors.js';
import { Manifest, type FileEntry } from './manifest.js';

const MANIFEST_BLOB = 'manifest';
const COUNTER_BYTES = 8;
/** One swap merged onto an unrelated commit, plus a second, before the batch reports a conflict it did not have. */
const COMMIT_ATTEMPTS = 3;

/** One path in a project save: its new bytes, or `null` to remove it (the tombstone keeps its mark meaningful). */
export interface RemoteChange {
  readonly path: string;
  readonly bytes: Uint8Array | null;
}

interface PreparedChange {
  readonly path: string;
  /** What this device read for the path before the batch, `undefined` when it was absent. */
  readonly previous: FileEntry | undefined;
  readonly next: FileEntry;
}

/** Whether a path reads the same in two indexes: hash, version, blob and tombstone all agree. */
function sameEntry(a: FileEntry | undefined, b: FileEntry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.hash === b.hash && a.version === b.version && a.blob === b.blob && a.deleted === b.deleted;
}

export interface EncryptedRemoteFsOptions {
  readonly store: RemoteBlobStore;
  readonly projectId: string;
  readonly projectKey: SecretKey;
  /** The device's memory of the highest versions it has seen. Pass the persisted one; a fresh one trusts the first state it meets. */
  readonly highWater?: HighWaterMarks;
  readonly random?: RandomBytes;
}

const markOfManifest = 'manifest';
const markOfFile = (hash: string): string => `file:${hash}`;

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export class EncryptedRemoteArtifactFs implements ArtifactFs {
  readonly highWater: HighWaterMarks;
  readonly #store: RemoteBlobStore;
  readonly #projectId: string;
  readonly #key: SecretKey;
  readonly #random: RandomBytes;
  #manifest = new Manifest();
  /** The etag of the manifest as last read or written; `null` while the server has none. */
  #manifestEtag: string | null = null;
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(options: EncryptedRemoteFsOptions) {
    this.#store = options.store;
    this.#projectId = options.projectId;
    this.#key = options.projectKey;
    this.#random = options.random ?? systemRandom;
    this.highWater = options.highWater ?? new HighWaterMarks();
  }

  static async open(options: EncryptedRemoteFsOptions): Promise<EncryptedRemoteArtifactFs> {
    const fs = new EncryptedRemoteArtifactFs(options);
    await fs.refresh();
    return fs;
  }

  /** Reads the server's manifest again. Run after a {@link RemoteConflictError} to see what the other device did. */
  refresh(): Promise<void> {
    return this.#exclusive(async () => {
      const state = await this.#read();
      if (state === null) {
        // A server that once held a manifest and now holds none has dropped it; a fresh project has seen no counter.
        this.highWater.check(markOfManifest, 0);
        this.#manifest = new Manifest();
        this.#manifestEtag = null;
        return;
      }
      this.#adopt(state);
    });
  }

  /**
   * The server's index, authenticated and checked against this device's marks but **not** adopted: a caller that
   * must decide what a moved index means reads it this way, so a refused batch leaves this device's state where
   * the writer's conflict question needs it. `null` when the server holds none.
   */
  async #read(): Promise<{ readonly manifest: Manifest; readonly etag: string } | null> {
    const blob = await this.#store.get(MANIFEST_BLOB);
    if (blob === null) return null;
    if (blob.bytes.length <= COUNTER_BYTES) throw new RemoteIntegrityError(null, 'the index is too short');
    const counter = Number(new DataView(blob.bytes.buffer, blob.bytes.byteOffset, blob.bytes.byteLength).getBigUint64(0));
    if (!Number.isSafeInteger(counter)) throw new RemoteIntegrityError(null, 'the index counter is out of range');
    this.highWater.check(markOfManifest, counter);
    let manifest: Manifest;
    try {
      manifest = Manifest.parse(counter, await openManifest(this.#key, { projectId: this.#projectId, version: counter }, blob.bytes.subarray(COUNTER_BYTES)));
    } catch (cause) {
      if (cause instanceof CryptoError) throw new RemoteIntegrityError(null, 'the index did not authenticate: wrong key or altered bytes', { cause });
      throw cause;
    }
    for (const entry of manifest.files.values()) this.highWater.check(markOfFile(entry.hash), entry.version);
    return { manifest, etag: blob.etag };
  }

  #adopt(state: { readonly manifest: Manifest; readonly etag: string }): void {
    this.#manifest = state.manifest;
    this.#manifestEtag = state.etag;
    this.highWater.advance(markOfManifest, state.manifest.counter);
    for (const entry of state.manifest.files.values()) this.highWater.advance(markOfFile(entry.hash), entry.version);
  }

  async read(path: string): Promise<string> {
    return new TextDecoder('utf-8', { fatal: true }).decode(await this.readBytes(path));
  }

  async readBytes(path: string): Promise<Uint8Array> {
    assertContained(path);
    const entry = this.#manifest.files.get(path);
    if (entry === undefined || entry.deleted) throw new ArtifactNotFoundError(path);
    const blob = await this.#store.get(entry.blob);
    if (blob === null) return this.#missing(path);
    try {
      const plain = await openFile(this.#key, { projectId: this.#projectId, pathHash: entry.hash, version: entry.version }, blob.bytes);
      this.highWater.advance(markOfFile(entry.hash), entry.version);
      return plain;
    } catch (cause) {
      if (cause instanceof CryptoError) throw new RemoteIntegrityError(path, 'the file did not authenticate: it was altered or swapped on the server', { cause });
      throw cause;
    }
  }

  /**
   * A blob the index names is gone. If the index has moved on, another device replaced or removed the file and
   * this device is behind; if not, the server lost it.
   */
  async #missing(path: string): Promise<never> {
    const current = await this.#store.get(MANIFEST_BLOB);
    if (current !== null && current.etag !== this.#manifestEtag) throw new RemoteConflictError(path);
    throw new RemoteIntegrityError(path, 'the server no longer has this file');
  }

  async writeAtomic(path: string, contents: string): Promise<void> {
    return this.writeBytesAtomic(path, new TextEncoder().encode(contents));
  }

  async writeBytesAtomic(path: string, bytes: Uint8Array): Promise<void> {
    return this.commitChanges([{ path, bytes }]);
  }

  /**
   * A project save: every change of the batch seals and reaches the server, then **one** index swap commits them
   * together. A save of forty files therefore moves the index once, and a refused save leaves the index exactly as
   * it was.
   *
   * A 412 on the index swap is not automatically a conflict: the other device may have changed a file this batch
   * does not touch. The index is read again; when none of the batch's own paths moved, the batch is rebuilt on the
   * other device's state and retried, so both edits survive. When one did move, {@link RemoteConflictError} names
   * every path of the batch that changed elsewhere and nothing is overwritten — that is the question the writer is
   * asked, and {@link refresh} then shows what the other device wrote.
   *
   * `options.dirs` records directories in the same swap, so a save that creates `assets/` or `exports/` costs one
   * commit rather than one more.
   */
  async commitChanges(changes: readonly RemoteChange[], options: { readonly dirs?: readonly string[] } = {}): Promise<void> {
    const dirs = options.dirs ?? [];
    if (changes.length === 0 && dirs.length === 0) return;
    return this.#exclusive(() => this.#apply(changes, dirs));
  }

  async #apply(changes: readonly RemoteChange[], wanted: readonly string[] = []): Promise<void> {
    const seen = new Set<string>();
    for (const change of changes) {
      assertContained(change.path);
      if (seen.has(change.path)) throw new Error(`a save stages one path once, and ${change.path} arrives twice`);
      seen.add(change.path);
      if (change.bytes === null && this.#manifest.dirs.has(change.path)) throw new Error(`refusing to remove a directory through a save: ${change.path}`);
    }
    const dirs = new Set<string>();
    for (const dir of wanted) {
      assertContained(dir);
      let cursor = '';
      for (const segment of dir.split('/').filter(Boolean)) {
        cursor = joinPath(cursor, segment);
        dirs.add(cursor);
      }
    }
    const base = this.#manifest;
    const prepared: PreparedChange[] = [];
    for (const change of changes) {
      const previous = base.files.get(change.path);
      if (change.bytes === null) {
        if (previous === undefined || previous.deleted) continue;
        prepared.push({ path: change.path, previous, next: { hash: previous.hash, version: previous.version + 1, blob: '', deleted: true } });
        continue;
      }
      const hash = previous?.hash ?? (await hashPath(this.#key, change.path));
      const version = (previous?.version ?? 0) + 1;
      const blob = hex(this.#random(16));
      const sealed = await sealFile(this.#key, { projectId: this.#projectId, pathHash: hash, version }, change.bytes, this.#random);
      await this.#put(blob, sealed, { ifNoneMatch: '*' }, change.path);
      prepared.push({ path: change.path, previous, next: { hash, version, blob, deleted: false } });
    }
    if (prepared.length === 0 && dirs.size === 0) return;
    await this.#commitBatch(prepared, base, [...dirs]);
    // A replaced or removed version stays on the server for its soft-delete window and is not read again.
    for (const change of prepared) {
      if (change.previous !== undefined && !change.previous.deleted) await this.#discard(change.previous.blob);
    }
  }

  /** The index swap, merged onto an unrelated concurrent commit rather than refused by it. */
  async #commitBatch(prepared: readonly PreparedChange[], base: Manifest, dirs: readonly string[]): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const files = new Map(this.#manifest.files);
      for (const change of prepared) files.set(change.path, change.next);
      const listing = new Set(this.#manifest.dirs);
      for (const dir of dirs) listing.add(dir);
      try {
        await this.#commit(files, listing, prepared[0]?.path ?? dirs[0] ?? '');
        return;
      } catch (cause) {
        if (!(cause instanceof RemoteConflictError)) throw cause;
        const remote = await this.#read();
        if (remote === null) throw cause;
        const moved = prepared.filter((change) => !sameEntry(base.files.get(change.path), remote.manifest.files.get(change.path)));
        if (moved.length > 0) throw new RemoteConflictError(moved[0]!.path, moved.map((change) => change.path));
        if (attempt >= COMMIT_ATTEMPTS) throw cause;
        // Another device committed a file this batch does not touch: keep its work and swap again on top of it.
        this.#adopt(remote);
      }
    }
  }

  async listFiles(dir: string): Promise<string[]> {
    assertContained(dir);
    const names: string[] = [];
    for (const [path, entry] of this.#manifest.files) {
      if (!entry.deleted && parentOf(path) === dir) names.push(path.slice(path.lastIndexOf('/') + 1));
    }
    return names.sort();
  }

  async listDirs(dir: string): Promise<string[]> {
    assertContained(dir);
    const prefix = dir === '' ? '' : `${dir}/`;
    const names = new Set<string>();
    for (const path of this.#manifest.dirs) {
      if (path === '' || !path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest !== '' && !rest.includes('/')) names.add(rest);
    }
    // A file written without `ensureDir` still has a directory, as it does on a real file system.
    for (const [path, entry] of this.#manifest.files) {
      if (entry.deleted || !path.startsWith(prefix)) continue;
      const slash = path.indexOf('/', prefix.length);
      if (slash > prefix.length) names.add(path.slice(prefix.length, slash));
    }
    return [...names].sort();
  }

  async exists(path: string): Promise<boolean> {
    assertContained(path);
    if (path === '' || this.#manifest.dirs.has(path)) return true;
    const entry = this.#manifest.files.get(path);
    if (entry !== undefined && !entry.deleted) return true;
    const prefix = `${path}/`;
    for (const [other, e] of this.#manifest.files) if (!e.deleted && other.startsWith(prefix)) return true;
    return false;
  }

  async ensureDir(dir: string): Promise<void> {
    assertContained(dir);
    return this.#exclusive(async () => {
      let listed = true;
      let known = '';
      for (const segment of dir.split('/').filter(Boolean)) {
        known = joinPath(known, segment);
        if (!this.#manifest.dirs.has(known)) listed = false;
      }
      if (listed) return;
      // The index lists directories and nothing ever removes one, so another device's commit can never clash with
      // this one: a 412 here is a concurrent move to merge, not a conflict to report.
      for (let attempt = 1; ; attempt += 1) {
        const dirs = new Set(this.#manifest.dirs);
        let cursor = '';
        for (const segment of dir.split('/').filter(Boolean)) {
          cursor = joinPath(cursor, segment);
          dirs.add(cursor);
        }
        try {
          await this.#commit(new Map(this.#manifest.files), dirs, dir);
          return;
        } catch (cause) {
          if (!(cause instanceof RemoteConflictError)) throw cause;
          const remote = await this.#read();
          if (remote === null || attempt >= COMMIT_ATTEMPTS) throw cause;
          this.#adopt(remote);
        }
      }
    });
  }

  async remove(path: string): Promise<void> {
    return this.commitChanges([{ path, bytes: null }]);
  }

  /** One mutation at a time: each reads the manifest, changes it and swaps it, so two in flight would race each other. */
  #exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(run, run);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async #put(name: string, bytes: Uint8Array, precondition: Precondition, path: string): Promise<string> {
    try {
      return (await this.#store.put(name, bytes, precondition)).etag;
    } catch (cause) {
      if (cause instanceof BlobPreconditionFailedError) throw new RemoteConflictError(path);
      throw cause;
    }
  }

  /** The commit point: the next manifest replaces exactly the one this device read. */
  async #commit(files: Map<string, FileEntry>, dirs: Set<string>, path: string): Promise<void> {
    const next = this.#manifest.next(files, dirs);
    const sealed = await sealManifest(this.#key, { projectId: this.#projectId, version: next.counter }, next.serialize(), this.#random);
    const wire = new Uint8Array(COUNTER_BYTES + sealed.length);
    new DataView(wire.buffer).setBigUint64(0, BigInt(next.counter));
    wire.set(sealed, COUNTER_BYTES);
    const etag = await this.#put(MANIFEST_BLOB, wire, this.#manifestEtag === null ? { ifNoneMatch: '*' } : { ifMatch: this.#manifestEtag }, path);
    this.#manifest = next;
    this.#manifestEtag = etag;
    this.highWater.advance(markOfManifest, next.counter);
    for (const entry of next.files.values()) this.highWater.advance(markOfFile(entry.hash), entry.version);
  }

  /** Soft-deletes a blob nothing refers to. A failure leaves an unreferenced blob, which is harmless and for the server's retention to clear. */
  async #discard(blob: string): Promise<void> {
    try {
      await this.#store.delete(blob);
    } catch {
      /* unreferenced either way */
    }
  }
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}
