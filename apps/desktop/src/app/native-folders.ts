import { t } from '@lingui/core/macro';

import type { FolderReply, NativeFolder, NativeFolderBridge, NativeFolderChange } from '../../../desktop-shell/src/folder-contract.cjs';

import type { DirectoryHandleLike, FileHandleLike, HandleLike } from './fs-access.js';

const nativeIds = new WeakMap<DirectoryHandleLike, string>();

function bridge(): NativeFolderBridge | undefined {
  return typeof window !== 'undefined' && window.caotangDesktop?.version === 2 ? window.caotangDesktop.folders : undefined;
}

export function nativeFoldersAvailable(): boolean {
  return bridge() !== undefined;
}

export function nativeFolderId(folder: DirectoryHandleLike | null): string | undefined {
  return folder === null ? undefined : nativeIds.get(folder);
}

/** A browser-shaped filesystem error: `fs-access` reads the name, and the message never reaches the writer. */
function fsError(name: 'NotFoundError' | 'TypeMismatchError'): DOMException {
  return new DOMException(name, name);
}

function unwrap<T>(reply: FolderReply<T>): T {
  if (reply.ok) return reply.value;
  switch (reply.error) {
    case 'missing': throw new Error(t`The project folder is missing or was moved. Choose Open a folder to find it.`);
    case 'entry-missing': throw fsError('NotFoundError');
    case 'read-only': throw new Error(t`The project folder is read-only. Make it writable, then try again.`);
    case 'invalid': throw new Error(t`Choose an existing Caotang project folder or an empty folder for a new copy.`);
    case 'unavailable': throw new Error(t`Caotang could not access the project folder. Check its permissions and try again.`);
  }
}

function folderHandle(folder: NativeFolder, api: NativeFolderBridge): DirectoryHandleLike {
  const at = (parent: string, name: string): string => parent === '' ? name : `${parent}/${name}`;
  const list = async (path: string) => unwrap(await api.list(folder.id, path));
  function directory(name: string, path: string): DirectoryHandleLike {
    async function check(child: string, kind: HandleLike['kind'], create?: boolean): Promise<string> {
      const target = at(path, child);
      const found = (await list(path)).find((entry) => entry.name === child);
      if (found && found.kind !== kind) throw fsError('TypeMismatchError');
      if (!found && !create) throw fsError('NotFoundError');
      return target;
    }
    return {
      name,
      kind: 'directory',
      async getDirectoryHandle(child, options) {
        const target = await check(child, 'directory', options?.create);
        if (options?.create) unwrap(await api.mkdir(folder.id, target));
        return directory(child, target);
      },
      async getFileHandle(child, options): Promise<FileHandleLike> {
        const target = await check(child, 'file', options?.create);
        return {
          kind: 'file',
          name: child,
          async getFile() {
            const bytes = unwrap(await api.read(folder.id, target));
            return {
              text: async () => new TextDecoder().decode(bytes),
              arrayBuffer: async () => new Uint8Array(bytes).buffer,
            };
          },
          async createWritable() {
            let bytes: Uint8Array = new Uint8Array();
            return {
              async write(data) { bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data; },
              async close() { unwrap(await api.write(folder.id, target, bytes)); },
            };
          },
        };
      },
      async removeEntry(child) { unwrap(await api.remove(folder.id, at(path, child))); },
      async *entries() { for (const entry of await list(path)) yield [entry.name, entry]; },
    };
  }
  const root = Object.assign(directory(folder.name, ''), {
    isSameEntry: async (other: DirectoryHandleLike) => nativeIds.get(other) === folder.id,
  });
  nativeIds.set(root, folder.id);
  return root;
}

export async function pickNativeFolder(mode: 'open' | 'empty'): Promise<DirectoryHandleLike | null> {
  const api = bridge();
  if (!api) return null;
  const folder = unwrap(await api.pickFolder(mode));
  return folder === null ? null : folderHandle(folder, api);
}

export async function listNativeFolders(): Promise<readonly DirectoryHandleLike[]> {
  const api = bridge();
  return api ? unwrap(await api.recentFolders()).map((folder) => folderHandle(folder, api)) : [];
}

export async function rememberNativeFolder(id: string): Promise<void> {
  const api = bridge();
  if (api) unwrap(await api.rememberFolder(id));
}

export async function forgetNativeFolder(id: string): Promise<void> {
  const api = bridge();
  if (api) unwrap(await api.forgetFolder(id));
}

/** Starts watching an open project folder in the main process; the returned id stops it again (desktop.md §External folder changes). */
export async function watchNativeFolder(id: string): Promise<string | null> {
  const api = bridge();
  return api ? unwrap(await api.watch(id)) : null;
}

export async function unwatchNativeFolder(subscription: string): Promise<void> {
  const api = bridge();
  if (api) unwrap(await api.unwatch(subscription));
}

/** Listens for the changes the main process reports for a watched folder. The returned function stops listening. */
export function onNativeFolderChange(listener: (change: NativeFolderChange) => void): () => void {
  const api = bridge();
  return api ? api.onChanged(listener) : () => undefined;
}
