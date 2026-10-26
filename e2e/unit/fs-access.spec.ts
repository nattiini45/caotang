import { expect, test } from '@playwright/test';

import {
  ArtifactNotFoundError,
  readProject,
  writeProject,
} from '../../packages/store/src/index.js';

import {
  folderArtifactFs,
  type DirectoryHandleLike,
  type FileHandleLike,
  type HandleLike,
} from '../../apps/desktop/src/app/fs-access.js';

import { IDS, project } from './fixtures.js';

/**
 * An in-memory directory tree that follows the File System Access handle contract: a
 * missing entry is a `NotFoundError`, and a writable's bytes land on `close()`.
 */
type Node = { kind: 'file'; text: string } | { kind: 'directory'; children: Map<string, Node> };

function notFound(name: string): Error {
  const error = new Error(`no entry named ${name}`);
  error.name = 'NotFoundError';
  return error;
}

function directoryHandle(name: string, children: Map<string, Node>): DirectoryHandleLike {
  const handle: DirectoryHandleLike = {
    kind: 'directory',
    name,
    async getDirectoryHandle(child, options) {
      let node = children.get(child);
      if (node === undefined) {
        if (!options?.create) throw notFound(child);
        node = { kind: 'directory', children: new Map() };
        children.set(child, node);
      }
      if (node.kind !== 'directory') throw Object.assign(new Error(`${child} is a file`), { name: 'TypeMismatchError' });
      return directoryHandle(child, node.children);
    },
    async getFileHandle(child, options) {
      let node = children.get(child);
      if (node === undefined) {
        if (!options?.create) throw notFound(child);
        node = { kind: 'file', text: '' };
        children.set(child, node);
      }
      if (node.kind !== 'file') throw Object.assign(new Error(`${child} is a folder`), { name: 'TypeMismatchError' });
      return fileHandle(child, node);
    },
    async removeEntry(child) {
      if (!children.has(child)) throw notFound(child);
      children.delete(child);
    },
    entries() {
      const pairs: [string, HandleLike][] = [...children.entries()].map(([childName, node]) => [
        childName,
        { kind: node.kind, name: childName },
      ]);
      return (async function* () {
        yield* pairs;
      })();
    },
  };
  return handle;
}

function fileHandle(name: string, node: { kind: 'file'; text: string }): FileHandleLike {
  return {
    kind: 'file',
    name,
    async getFile() {
      return {
        text: async () => node.text,
        arrayBuffer: async () => new TextEncoder().encode(node.text).buffer,
      };
    },
    async createWritable() {
      let pending = '';
      return {
        async write(data: string) {
          pending = data;
        },
        async close() {
          node.text = pending;
        },
      };
    },
  };
}

function emptyRoot(): { root: DirectoryHandleLike; tree: Map<string, Node> } {
  const tree = new Map<string, Node>();
  return { root: directoryHandle('project', tree), tree };
}

test.describe('the project folder, as an artifact', () => {
  test('writes and reads a file, creating the folders it needs', async () => {
    const { root, tree } = emptyRoot();
    const fs = folderArtifactFs(root);
    await fs.writeAtomic('docs/n_ONE.md', 'hello');
    expect(await fs.read('docs/n_ONE.md')).toBe('hello');
    expect(tree.get('docs')?.kind).toBe('directory');
  });

  test('a missing file is the port’s not-found error, and a missing folder lists as empty', async () => {
    const { root } = emptyRoot();
    const fs = folderArtifactFs(root);
    await expect(fs.read('caotang.json')).rejects.toBeInstanceOf(ArtifactNotFoundError);
    await expect(fs.read('docs/none.md')).rejects.toBeInstanceOf(ArtifactNotFoundError);
    expect(await fs.listFiles('codex')).toEqual([]);
    expect(await fs.exists('caotang.json')).toBe(false);
  });

  test('lists files and folders separately, sorted, and removes a file without error when it is already gone', async () => {
    const { root } = emptyRoot();
    const fs = folderArtifactFs(root);
    await fs.writeAtomic('b.txt', '2');
    await fs.writeAtomic('a.txt', '1');
    await fs.ensureDir('docs');
    expect(await fs.listFiles('')).toEqual(['a.txt', 'b.txt']);
    expect(await fs.listDirs('')).toEqual(['docs']);
    await fs.remove('a.txt');
    await fs.remove('a.txt');
    expect(await fs.exists('a.txt')).toBe(false);
  });

  test('a folder exists as a folder, and a file as a file: a browser answers a mismatch with TypeMismatchError', async () => {
    const { root } = emptyRoot();
    const fs = folderArtifactFs(root);
    await fs.writeAtomic('memory/MEMORY.md', 'index');
    await fs.writeAtomic('CAOTANG.md', 'rules');
    expect(await fs.exists('memory')).toBe(true);
    expect(await fs.exists('CAOTANG.md')).toBe(true);
    expect(await fs.exists('memory/MEMORY.md')).toBe(true);
    expect(await fs.exists('memory/none.md')).toBe(false);
    expect(await fs.exists('nothing')).toBe(false);
  });

  test('a whole project survives a trip through the folder: written, then read back to the same tree', async () => {
    const { root } = emptyRoot();
    const state = project();
    await writeProject(folderArtifactFs(root), state, { now: new Date('2026-10-08T10:00:00Z') });
    const loaded = await readProject(folderArtifactFs(root));
    expect(loaded.state.manifest.tree.map((node) => node.title)).toEqual(
      state.manifest.tree.map((node) => node.title),
    );
    expect(loaded.state.documents.get(IDS.sceneA)?.body).toBe('Four little words here');
    expect(loaded.report.ok).toBe(true);
  });
});
