/**
 * The exporter's artifacts, held for the session and mirrored into the project folder when one
 * is open ([exporter.md §2 stage 4]).
 *
 * A compile has two destinations. The download is always made, from the bytes the session
 * holds. The folder is written when the session has one: a project opened from a folder, or one
 * saved to a folder. This store is what the exporter writes through, so one compile lands in
 * both places and one undo removes the file from both. The mirroring is this module's job, and
 * no caller has to remember it.
 *
 * ## Reads go to the session's copy
 *
 * The exporter names its next file, and appends its compile log, from a listing and a read it
 * makes synchronously. So reads are answered from memory and only writes and removals are
 * mirrored. Memory is never behind the folder: a folder attached later is brought up to date
 * first.
 *
 * ## The compile log is merged, never replaced
 *
 * `exports/compile-log.json` is append-only (exporter.md §2). Attaching a folder that already
 * has a log merges the two histories, the folder's first, so the next append keeps both. A log
 * that is not a JSON array is refused, because the exporter's own rule is that a corrupt log is
 * evidence and not scratch: the folder is then not attached.
 *
 * ## A folder file is never overwritten
 *
 * An export compiled before the folder was attached took its name from memory, so the folder may hold
 * a different file under that name. exporter.md §5 would give the export a free name, but that also
 * means rewriting its compile-log row and the digest the dialog shows, so the attach refuses instead.
 * It fails and names the file, and writes nothing: overwriting it would lose someone's export.
 */

import { ArtifactNotFoundError, EXPORTS_DIR, MemoryArtifactFs, type ArtifactFs } from '@caotang/store';
import { COMPILE_LOG_PATH, type ByteArtifacts } from '@caotang/exporter';

import { folderArtifactFs, folderBytes, type DirectoryHandleLike } from './fs-access.js';

export class ExportStore {
  private readonly text = new MemoryArtifactFs();
  private readonly binary = new Map<string, Uint8Array>();
  private folder: DirectoryHandleLike | null = null;

  /** The text side of the exporter's port: Markdown, plain text and the compile log. */
  readonly artifacts: ArtifactFs = {
    read: (path) => this.text.read(path),
    writeAtomic: async (path, contents) => {
      await this.text.writeAtomic(path, contents);
      if (this.folder !== null) await folderArtifactFs(this.folder).writeAtomic(path, contents);
    },
    listFiles: async (dir) => unique([...(await this.text.listFiles(dir)), ...(await this.folderFiles(dir))]),
    listDirs: (dir) => this.text.listDirs(dir),
    exists: (path) => this.text.exists(path),
    ensureDir: async (dir) => {
      await this.text.ensureDir(dir);
      if (this.folder !== null) await folderArtifactFs(this.folder).ensureDir(dir);
    },
    remove: async (path) => {
      await this.text.remove(path);
      if (this.folder !== null) await folderArtifactFs(this.folder).remove(path);
    },
    // Bytes the session holds live in `binary`; anything else is a text artifact, read as UTF-8.
    readBytes: async (path) => {
      const held = this.binary.get(path);
      return held !== undefined ? held.slice() : this.text.readBytes(path);
    },
    writeBytesAtomic: (path, bytes) => this.bytes.writeBytes(path, bytes),
  };

  /** The binary side: DOCX, EPUB, XLSX and PDF, which are zip containers or paged files. */
  readonly bytes: ByteArtifacts = {
    writeBytes: async (path, contents) => {
      // A copy, so a caller that reuses its buffer cannot change what the session holds.
      this.binary.set(path, contents.slice());
      if (this.folder !== null) await folderBytes(this.folder).writeBytes(path, contents);
    },
    removeBytes: async (path) => {
      this.binary.delete(path);
      if (this.folder !== null) await folderBytes(this.folder).removeBytes(path);
    },
    listFiles: async (dir) => unique([...basenamesIn(this.binary.keys(), dir), ...(await this.folderFiles(dir))]),
  };

  /** Whether the session's artifacts are mirrored into a project folder. */
  hasFolder(): boolean {
    return this.folder !== null;
  }

  /** The artifact at `path` as the bytes a download carries, or `null` when this session wrote none there. */
  async read(path: string): Promise<Uint8Array | null> {
    if (isBinaryPath(path)) return this.binary.get(path) ?? null;
    try {
      return new TextEncoder().encode(await this.text.read(path));
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) return null;
      throw error;
    }
  }

  /**
   * Mirror into `root` from now on. What this session already made is written to it first, and
   * the compile log is merged. Throws, and attaches nothing, when the folder's log cannot be read
   * as a log, or when the folder holds a different file under the name of one of this session's
   * exports: that file is named in the message and is not overwritten.
   */
  async attach(root: DirectoryHandleLike): Promise<void> {
    const target = folderArtifactFs(root);
    const theirs = await compileRows(target);
    const ours = await compileRows(this.text);
    const clash = await this.clashWith(root, target);
    if (clash !== null) {
      throw new Error(
        `${clash} is already in the folder with other contents, so the folder was not attached and nothing was overwritten. Move or rename that file, then save to the folder again.`,
      );
    }
    const seen = new Set(theirs.map((row) => JSON.stringify(row)));
    const merged = [...theirs, ...ours.filter((row) => !seen.has(JSON.stringify(row)))];
    if (merged.length > 0) {
      await this.text.writeAtomic(COMPILE_LOG_PATH, `${JSON.stringify(merged, null, 2)}\n`);
    }
    for (const name of await this.text.listFiles(EXPORTS_DIR)) {
      const path = `${EXPORTS_DIR}/${name}`;
      await target.writeAtomic(path, await this.text.read(path));
    }
    for (const [path, bytes] of this.binary) {
      await folderBytes(root).writeBytes(path, bytes);
    }
    this.folder = root;
  }

  /**
   * The first export this session holds whose path the folder also holds with other bytes, or `null`.
   *
   * The exporter reserves a folder's names only from the attach on, so an export made before it can share
   * a name with a file the session never saw; this is where that is caught. The bytes are compared, not
   * the name: the same bytes are the same export, and writing them again loses nothing. The compile log is
   * exempt, because it is merged and never replaced.
   */
  private async clashWith(root: DirectoryHandleLike, target: ArtifactFs): Promise<string | null> {
    for (const name of await this.text.listFiles(EXPORTS_DIR)) {
      const path = `${EXPORTS_DIR}/${name}`;
      if (path === COMPILE_LOG_PATH) continue;
      const theirs = await readIfPresent(target, path);
      if (theirs !== null && theirs !== (await this.text.read(path))) return path;
    }
    for (const [path, ours] of this.binary) {
      const theirs = await folderBytes(root).readBytes(path);
      if (theirs !== null && !sameBytes(theirs, ours)) return path;
    }
    return null;
  }

  private async folderFiles(dir: string): Promise<string[]> {
    return this.folder === null ? [] : folderArtifactFs(this.folder).listFiles(dir);
  }
}

/** The text of the file at `path`, or `null` when there is no such file. */
async function readIfPresent(fs: ArtifactFs, path: string): Promise<string | null> {
  try {
    return await fs.read(path);
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) return null;
    throw error;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}

/** The rows of a compile log, `[]` when there is none yet. A file that is not a JSON array is an error. */
async function compileRows(fs: ArtifactFs): Promise<unknown[]> {
  const text = await readIfPresent(fs, COMPILE_LOG_PATH);
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${COMPILE_LOG_PATH} in the folder is not valid JSON, so the folder was not attached`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${COMPILE_LOG_PATH} in the folder is not a JSON array, so the folder was not attached`);
  }
  return parsed;
}

/**
 * The paths the export store holds as bytes rather than text. The prose formats' figures and the contact sheet's
 * pictures are published beside their document (a Markdown export's `.assets/` folder), so the picture extensions
 * are here too: a picture read back through the text store would come back as nothing.
 */
function isBinaryPath(path: string): boolean {
  return /\.(docx|epub|xlsx|pdf|cbz|png|jpe?g|webp)$/i.test(path);
}

/** The basenames of the paths directly inside `dir`. */
function basenamesIn(paths: Iterable<string>, dir: string): string[] {
  const prefix = `${dir}/`;
  const names: string[] = [];
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest.length > 0 && !rest.includes('/')) names.push(rest);
  }
  return names;
}

function unique(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}
