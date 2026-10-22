/**
 * The store's {@link ArtifactFs} port on `node:fs` — [project-format.md §1/§4](../../../docs/architecture/project-format.md).
 *
 * The port's contract is what this file has to keep, and the in-memory binding
 * (`MemoryArtifactFs`) is the reference for it:
 *
 *   - **Atomic writes.** Every mutation is a write to a temp name in the same
 *     directory, an fsync, and a rename over the target (§4). A reader never
 *     sees a half-written document or manifest, and a crash leaves the old file.
 *   - **Root containment.** A path is project-relative and POSIX-separated, and it
 *     never leaves the project folder. The check is textual first (no absolute
 *     paths, no `..`, no backslashes), then it is repeated on the real path: a
 *     symlink inside the folder that points out of it is refused, because a
 *     project folder synced or unzipped by someone else can contain one.
 *   - **Readers ignore what they do not own.** A missing directory lists as empty,
 *     and a listing carries names only, never directories or links (§1).
 *
 * What this binding does not promise: `rename` is atomic on the same volume, but
 * the directory entry is not fsynced (Windows has no directory fsync). The
 * rename is retried briefly on the sharing violations Windows reports while
 * another process has the target open.
 */

import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { ByteArtifacts } from '@caotang/exporter';
import { ArtifactNotFoundError, type ArtifactFs } from '@caotang/store';

/** A path the port refuses before it touches the disk. The message names the path and the rule it broke. */
export class ArtifactPathError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`artifact path ${JSON.stringify(path)} ${reason}`);
    this.name = 'ArtifactPathError';
  }
}

/** Node's errno codes, read off an unknown thrown value. */
function errnoOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

/** A path that does not exist, or whose parent is not a directory: both mean "nothing there" to a reader. */
function absent(error: unknown): boolean {
  const code = errnoOf(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** True when `target` is strictly inside `root`. Both are absolute, and the root itself does not count. */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Resolves a project-relative POSIX path under `root`, or throws. The empty string
 * names the root itself, which is what a listing of the project folder asks for.
 */
export function resolveWithin(root: string, path: string): string {
  if (path === '') return root;
  if (path.includes('\\') || path.includes('\0')) {
    throw new ArtifactPathError(path, 'must use "/" separators and contain no NUL byte');
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new ArtifactPathError(path, 'must be relative to the project folder');
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ArtifactPathError(path, 'must not contain empty, "." or ".." segments');
  }
  const target = join(root, ...segments);
  if (!isInside(root, target)) throw new ArtifactPathError(path, 'resolves outside the project folder');
  return target;
}

/** Retries a rename on the transient sharing errors Windows gives while another process holds the target. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errnoOf(error);
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || attempt >= 6) throw error;
      await new Promise((done) => setTimeout(done, 25 * attempt));
    }
  }
}

export class NodeArtifactFs implements ArtifactFs {
  /** The absolute project folder. Every path the port accepts is relative to it. */
  readonly root: string;
  private readonly realRoot: string;

  /** `root` must already exist: the real path of the folder is what containment is checked against. */
  constructor(root: string) {
    this.root = resolve(root);
    this.realRoot = realpathSync(this.root);
  }

  async read(path: string): Promise<string> {
    const target = resolveWithin(this.root, path);
    await this.assertContained(target);
    try {
      return await readFile(target, 'utf8');
    } catch (error) {
      if (absent(error)) throw new ArtifactNotFoundError(path);
      throw error;
    }
  }

  /** The raw bytes of a file — a text file comes back as its UTF-8 encoding, unchanged. */
  async readBytes(path: string): Promise<Uint8Array> {
    const target = resolveWithin(this.root, path);
    await this.assertContained(target);
    try {
      const buffer = await readFile(target);
      // A fresh Uint8Array, not the Buffer's pooled view, so a caller cannot alias the pool.
      return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    } catch (error) {
      if (absent(error)) throw new ArtifactNotFoundError(path);
      throw error;
    }
  }

  /** Atomic UTF-8 write: temp name, fsync, rename (project-format §4). */
  async writeAtomic(path: string, contents: string): Promise<void> {
    await this.writeFileAtomic(path, Buffer.from(contents, 'utf8'));
  }

  /** Atomic binary write, for the DOCX and EPUB artifacts the exporter emits into `exports/`. */
  async writeBytesAtomic(path: string, bytes: Uint8Array): Promise<void> {
    await this.writeFileAtomic(path, bytes);
  }

  async listFiles(dir: string): Promise<string[]> {
    const entries = await this.entriesOf(dir);
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  }

  async listDirs(dir: string): Promise<string[]> {
    const entries = await this.entriesOf(dir);
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  async exists(path: string): Promise<boolean> {
    const target = resolveWithin(this.root, path);
    await this.assertContained(target);
    try {
      await stat(target);
      return true;
    } catch (error) {
      if (absent(error)) return false;
      throw error;
    }
  }

  async ensureDir(dir: string): Promise<void> {
    const target = resolveWithin(this.root, dir);
    await this.assertContained(target);
    await mkdir(target, { recursive: true });
  }

  /**
   * Removes a file. Absent is a no-op. A directory is refused, and so is anything
   * that would only be reached by following a link out of the folder: the link
   * itself is removed, never its target.
   */
  async remove(path: string): Promise<void> {
    const target = resolveWithin(this.root, path);
    await this.assertContained(dirname(target));
    try {
      const info = await lstat(target);
      if (info.isDirectory()) throw new Error(`refusing to remove a directory through remove(): ${path}`);
      await unlink(target);
    } catch (error) {
      if (absent(error)) return;
      throw error;
    }
  }

  private async writeFileAtomic(path: string, data: Uint8Array): Promise<void> {
    const target = resolveWithin(this.root, path);
    await this.assertContained(target);
    await mkdir(dirname(target), { recursive: true });
    await this.assertContained(target);

    const temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
    const handle = await open(temp, 'wx');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      await renameWithRetry(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  private async entriesOf(dir: string) {
    const target = resolveWithin(this.root, dir);
    await this.assertContained(target);
    try {
      return await readdir(target, { withFileTypes: true });
    } catch (error) {
      if (absent(error)) return [];
      throw error;
    }
  }

  /**
   * The real path of the nearest existing ancestor of `target` (or of `target`
   * itself, when it exists) must sit inside the real project folder. A link that
   * leads out is refused here, whichever way the path reached it.
   */
  private async assertContained(target: string): Promise<void> {
    let probe = target;
    for (;;) {
      try {
        const real = await realpath(probe);
        if (real !== this.realRoot && !real.startsWith(`${this.realRoot}${sep}`)) {
          throw new ArtifactPathError(relative(this.root, target), 'resolves through a link outside the project folder');
        }
        return;
      } catch (error) {
        if (!absent(error)) throw error;
        const parent = dirname(probe);
        if (parent === probe) return;
        probe = parent;
      }
    }
  }
}

/**
 * The exporter's binary port, over the same folder and the same atomic path, so a
 * DOCX or EPUB lands in `exports/` exactly as a Markdown file does.
 */
export function byteArtifactsOver(fs: Pick<ArtifactFs, 'writeBytesAtomic' | 'remove' | 'listFiles'>): ByteArtifacts {
  return {
    writeBytes: (path, bytes) => fs.writeBytesAtomic(path, bytes),
    removeBytes: (path) => fs.remove(path),
    listFiles: (dir) => fs.listFiles(dir),
  };
}
