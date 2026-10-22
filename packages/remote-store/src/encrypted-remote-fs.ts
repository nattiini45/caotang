/**
 * `ArtifactFs` over an encrypted remote blob store — [hosted.md §5–§7](docs/architecture/hosted.md). Specified, not built.
 *
 * The port is unchanged. What it cannot carry (a version on a write, a listing over hashed names) lives here:
 *
 *   - every file is a sealed blob under a random name, written once and never replaced;
 *   - one sealed `manifest` blob maps each path to its version and blob name, and lists the directories;
 *   - a write puts the new blob (create-only), then swaps the manifest with `If-Match`. The manifest swap is the
 *     commit: a 412 there means another device committed first, and is raised as {@link RemoteConflictError}
 *     naming the file. Nothing is ever overwritten silently, and a blob left by a lost race is never read;
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
      const blob = await this.#store.get(MANIFEST_BLOB);
      if (blob === null) {
        // A server that once held a manifest and now holds none has dropped it; a fresh project has seen no counter.
        this.highWater.check(markOfManifest, 0);
        this.#manifest = new Manifest();
        this.#manifestEtag = null;
        return;
      }
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
      this.highWater.advance(markOfManifest, counter);
      for (const entry of manifest.files.values()) this.highWater.advance(markOfFile(entry.hash), entry.version);
      this.#manifest = manifest;
      this.#manifestEtag = blob.etag;
    });
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
    assertContained(path);
    return this.#exclusive(async () => {
      const previous = this.#manifest.files.get(path);
      const hash = previous?.hash ?? (await hashPath(this.#key, path));
      const version = (previous?.version ?? 0) + 1;
      const blob = hex(this.#random(16));
      const sealed = await sealFile(this.#key, { projectId: this.#projectId, pathHash: hash, version }, bytes, this.#random);
      await this.#put(blob, sealed, { ifNoneMatch: '*' }, path);
      const files = new Map(this.#manifest.files);
      files.set(path, { hash, version, blob, deleted: false });
      await this.#commit(files, new Set(this.#manifest.dirs), path);
      // The old version stays on the server for its soft-delete window and is not read again.
      if (previous !== undefined && !previous.deleted) await this.#discard(previous.blob);
    });
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
      const dirs = new Set(this.#manifest.dirs);
      let cursor = '';
      for (const segment of dir.split('/').filter(Boolean)) {
        cursor = joinPath(cursor, segment);
        dirs.add(cursor);
      }
      if (dirs.size === this.#manifest.dirs.size) return;
      await this.#commit(new Map(this.#manifest.files), dirs, dir);
    });
  }

  async remove(path: string): Promise<void> {
    assertContained(path);
    return this.#exclusive(async () => {
      if (this.#manifest.dirs.has(path)) throw new Error(`refusing to remove a directory through remove(): ${path}`);
      const entry = this.#manifest.files.get(path);
      if (entry === undefined || entry.deleted) return;
      const files = new Map(this.#manifest.files);
      files.set(path, { hash: entry.hash, version: entry.version + 1, blob: '', deleted: true });
      await this.#commit(files, new Set(this.#manifest.dirs), path);
      await this.#discard(entry.blob);
    });
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
