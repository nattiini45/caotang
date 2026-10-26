import type { DirectoryHandleLike, FileHandleLike, HandleLike } from '../../apps/desktop/src/app/fs-access.js';

/**
 * A project folder as an in-memory tree, following the File System Access contract the app writes through: a
 * missing entry is a `NotFoundError`, and a writable's bytes land on `close()`. Not a spec file: it is imported.
 */
export type Entry = { kind: 'file'; bytes: Uint8Array } | { kind: 'directory'; children: Map<string, Entry> };

export type Directory = Extract<Entry, { kind: 'directory' }>;

/** A new, empty folder, and the handle the app is given for it. */
export function memoryFolder(): { handle: DirectoryHandleLike; tree: Directory } {
  const tree: Directory = { kind: 'directory', children: new Map() };
  return { handle: directoryHandle('Book', tree), tree };
}

/** Every file under the folder, by its slash path. */
export function filesIn(node: Directory, prefix = ''): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [name, child] of node.children) {
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (child.kind === 'file') out.set(path, child.bytes);
    else for (const [inner, bytes] of filesIn(child, path)) out.set(inner, bytes);
  }
  return out;
}

/** The text of a file's bytes. */
export function textOf(bytes: Uint8Array | undefined): string {
  return new TextDecoder().decode(bytes);
}

function notFound(name: string): Error {
  const error = new Error(`no entry named ${name}`);
  error.name = 'NotFoundError';
  return error;
}

function directoryHandle(name: string, node: Directory): DirectoryHandleLike {
  return {
    kind: 'directory',
    name,
    async getDirectoryHandle(child, options) {
      let next = node.children.get(child);
      if (next === undefined) {
        if (!options?.create) throw notFound(child);
        next = { kind: 'directory', children: new Map() };
        node.children.set(child, next);
      }
      if (next.kind !== 'directory') throw Object.assign(new Error(`${child} is a file`), { name: 'TypeMismatchError' });
      return directoryHandle(child, next);
    },
    async getFileHandle(child, options) {
      let next = node.children.get(child);
      if (next === undefined) {
        if (!options?.create) throw notFound(child);
        next = { kind: 'file', bytes: new Uint8Array() };
        node.children.set(child, next);
      }
      if (next.kind !== 'file') throw Object.assign(new Error(`${child} is a folder`), { name: 'TypeMismatchError' });
      return fileHandle(child, next);
    },
    async removeEntry(child) {
      if (!node.children.has(child)) throw notFound(child);
      node.children.delete(child);
    },
    async *entries(): AsyncIterable<[string, HandleLike]> {
      for (const [childName, child] of node.children) {
        yield [childName, child.kind === 'file' ? fileHandle(childName, child) : directoryHandle(childName, child)];
      }
    },
  };
}

function fileHandle(name: string, node: Extract<Entry, { kind: 'file' }>): FileHandleLike {
  return {
    kind: 'file',
    name,
    async getFile() {
      return {
        text: async () => new TextDecoder().decode(node.bytes),
        // A File's buffer is exactly its bytes: copy, so a view over a larger pooled
        // buffer (a Node Buffer's 8 KB pool, say) never leaks past the file's end.
        arrayBuffer: async () => {
          const copy = new Uint8Array(node.bytes.byteLength);
          copy.set(node.bytes);
          return copy.buffer;
        },
      };
    },
    async createWritable() {
      let staged: Uint8Array | null = null;
      return {
        async write(data) {
          staged = typeof data === 'string' ? new TextEncoder().encode(data) : data.slice();
        },
        async close() {
          if (staged !== null) node.bytes = staged;
        },
      };
    },
  };
}
