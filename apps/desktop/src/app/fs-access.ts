/**
 * The project folder as an `ArtifactFs`, over the File System Access API — where the
 * browser has it (Chromium), and not elsewhere (project-format §8).
 *
 * The store's port is path-based and project-relative; the browser's is handle-based
 * and walks one directory at a time. This file is the translation between them, and
 * nothing else. It is written against a *structural* subset of the handle types so a
 * test can drive it with an in-memory tree; a real `FileSystemDirectoryHandle` is
 * assignable to it without a cast.
 *
 * ## Atomicity
 *
 * The port's contract is "temp name, then rename" (project-format §4). A File System
 * Access writable already has that property: its bytes are staged and only replace the
 * file when the stream is closed, so an interrupted write leaves the previous file in
 * place. The adapter therefore writes straight to the target name and relies on the
 * platform for the swap, rather than inventing a second temp-file protocol on top.
 */

import { ArtifactNotFoundError, type ArtifactFs } from '@caotang/store';

/** The one kind of entry a directory listing reports. */
export interface HandleLike {
  readonly kind: 'file' | 'directory';
  readonly name: string;
}

export interface FileLike {
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface WritableLike {
  write(data: string | Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface FileHandleLike extends HandleLike {
  readonly kind: 'file';
  getFile(): Promise<FileLike>;
  createWritable(): Promise<WritableLike>;
}

export interface DirectoryHandleLike extends HandleLike {
  readonly kind: 'directory';
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterable<[string, HandleLike]>;
}

/** Whether this browser can open or save a real folder at all. */
export function folderAccessSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/**
 * Ask the user for a folder. `null` means the user cancelled, which is not an error:
 * the picker's own dismissal is the answer.
 */
export async function pickDirectory(mode: 'read' | 'readwrite'): Promise<DirectoryHandleLike | null> {
  const picker = (window as unknown as {
    showDirectoryPicker: (options: { mode: 'read' | 'readwrite' }) => Promise<DirectoryHandleLike>;
  }).showDirectoryPicker;
  try {
    return await picker({ mode });
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError') return null;
    throw error;
  }
}

/**
 * Whether a folder holds nothing at all: no file and no folder, hidden ones included. "Save as a new folder…" saves only into an empty
 * folder, so it never writes over a file another project or program keeps there.
 */
export async function folderIsEmpty(root: DirectoryHandleLike): Promise<boolean> {
  for await (const entry of root.entries()) {
    void entry;
    return false;
  }
  return true;
}

function isNotFound(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'NotFoundError';
}

/** Split `a/b/c.md` into the directory segments and the basename. */
function splitPath(path: string): { segments: string[]; name: string } {
  const parts = path.split('/').filter((segment) => segment.length > 0);
  const name = parts.pop() ?? '';
  return { segments: parts, name };
}

/** Walk to a directory handle, creating the path when asked. A missing directory is `undefined` when not creating. */
async function walk(
  root: DirectoryHandleLike,
  segments: readonly string[],
  create: boolean,
): Promise<DirectoryHandleLike | undefined> {
  let cursor = root;
  for (const segment of segments) {
    try {
      cursor = await cursor.getDirectoryHandle(segment, { create });
    } catch (error) {
      if (isNotFound(error) && !create) return undefined;
      throw error;
    }
  }
  return cursor;
}

export function folderArtifactFs(root: DirectoryHandleLike): ArtifactFs {
  return {
    async read(path) {
      const { segments, name } = splitPath(path);
      const directory = await walk(root, segments, false);
      if (!directory) throw new ArtifactNotFoundError(path);
      let handle: FileHandleLike;
      try {
        handle = await directory.getFileHandle(name);
      } catch (error) {
        if (isNotFound(error)) throw new ArtifactNotFoundError(path);
        throw error;
      }
      return (await handle.getFile()).text();
    },

    // The byte half of the port is folderBytes', so the two never disagree about a path.
    // A writable stream commits on close, which is the atomic-replace the port asks for.
    async readBytes(path) {
      const bytes = await folderBytes(root).readBytes(path);
      if (bytes === null) throw new ArtifactNotFoundError(path);
      return bytes;
    },

    async writeBytesAtomic(path, bytes) {
      await folderBytes(root).writeBytes(path, bytes);
    },

    async writeAtomic(path, contents) {
      const { segments, name } = splitPath(path);
      const directory = await walk(root, segments, true);
      if (!directory) throw new Error(`could not create the folder for ${path}`);
      const handle = await directory.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(contents);
      await writable.close();
    },

    async listFiles(dir) {
      const directory = await walk(root, splitDir(dir), false);
      if (!directory) return [];
      return collect(directory, 'file');
    },

    async listDirs(dir) {
      const directory = await walk(root, splitDir(dir), false);
      if (!directory) return [];
      return collect(directory, 'directory');
    },

    async exists(path) {
      const { segments, name } = splitPath(path);
      const directory = await walk(root, segments, false);
      if (!directory) return false;
      if (name === '') return true;
      try {
        await directory.getFileHandle(name);
        return true;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      try {
        await directory.getDirectoryHandle(name);
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },

    async ensureDir(dir) {
      await walk(root, splitDir(dir), true);
    },

    async remove(path) {
      const { segments, name } = splitPath(path);
      const directory = await walk(root, segments, false);
      if (!directory) return;
      try {
        await directory.removeEntry(name);
      } catch (error) {
        // "No-op when absent" is the port's rule, and the browser says the same thing.
        if (!isNotFound(error)) throw error;
      }
    },
  };
}

/**
 * The binary side of a project folder: DOCX and EPUB are zip containers, which the port's
 * string writer cannot hold (`ByteArtifacts` in `@caotang/exporter`). The same handle walk, the
 * same atomicity as {@link folderArtifactFs}: the writable replaces the file on close.
 */
export interface FolderBytes {
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** The bytes of the file at `path`, or `null` when there is no such file. */
  readBytes(path: string): Promise<Uint8Array | null>;
  removeBytes(path: string): Promise<void>;
}

export function folderBytes(root: DirectoryHandleLike): FolderBytes {
  return {
    async writeBytes(path, bytes) {
      const { segments, name } = splitPath(path);
      const directory = await walk(root, segments, true);
      if (!directory) throw new Error(`could not create the folder for ${path}`);
      const handle = await directory.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
    },

    async readBytes(path) {
      const { segments, name } = splitPath(path);
      const directory = await walk(root, segments, false);
      if (!directory) return null;
      let handle: FileHandleLike;
      try {
        handle = await directory.getFileHandle(name);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    },

    async removeBytes(path) {
      const { segments, name } = splitPath(path);
      const directory = await walk(root, segments, false);
      if (!directory) return;
      try {
        await directory.removeEntry(name);
      } catch (error) {
        // Absent is not an error here either: an undo of a compile whose file never landed.
        if (!isNotFound(error)) throw error;
      }
    },
  };
}

function splitDir(dir: string): string[] {
  return dir.split('/').filter((segment) => segment.length > 0);
}

async function collect(directory: DirectoryHandleLike, kind: 'file' | 'directory'): Promise<string[]> {
  const names: string[] = [];
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind === kind) names.push(name);
  }
  return names.sort();
}

/**
 * Whether two handles name the same folder. The browser answers with `isSameEntry`, which a second handle to the same folder passes.
 * A handle that cannot answer is taken as another folder, so the copy held for the first is no baseline for it.
 */
export async function isSameFolder(a: DirectoryHandleLike, b: DirectoryHandleLike): Promise<boolean> {
  if (a === b) return true;
  const { isSameEntry } = a as DirectoryHandleLike & { isSameEntry?: (other: DirectoryHandleLike) => Promise<boolean> };
  return isSameEntry === undefined ? false : isSameEntry.call(a, b);
}
