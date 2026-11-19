import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { ArtifactPathError, NodeArtifactFs, resolveWithin } from '@caotang/artifact-fs-node';
import { ArtifactNotFoundError } from '@caotang/store/artifact-fs';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

import type { FolderReply, NativeFolder, NativeFolderEntry } from './folder-contract.cjs';

type FolderError = Extract<FolderReply<never>, { ok: false }>['error'];
type Grant = NativeFolder & { readonly root: string; readonly dev: number; readonly ino: number };

class FolderRefusal extends Error {
  constructor(readonly reason: FolderError) {
    super(reason);
  }
}

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

function refusal(error: unknown): FolderError {
  if (error instanceof FolderRefusal) return error.reason;
  if (error instanceof ArtifactPathError) return 'invalid';
  if (error instanceof ArtifactNotFoundError || errorCode(error) === 'ENOENT') return 'entry-missing';
  if (['EACCES', 'EPERM', 'EROFS'].includes(String(errorCode(error)))) return 'read-only';
  return 'unavailable';
}

function entryPath(root: string, path: unknown, file: boolean): string {
  if (typeof path !== 'string' || path.length > 1024 || (file && path === '')) throw new FolderRefusal('invalid');
  resolveWithin(root, path);
  if (path === '') return path;
  const [first, second] = path.split('/');
  if (path.split('/').some((part) => /[<>:"|?*\p{Cc}]|[ .]$/u.test(part) || /^(?:COM[0-9¹²³]|LPT[0-9¹²³]|AUX|CON|NUL|PRN)(?:\.|$)/i.test(part))) {
    throw new FolderRefusal('invalid');
  }
  if (
    ['docs', 'codex', 'assets', 'exports', 'runs', 'memory', '.caotang-backup'].includes(first ?? '') ||
    (first === '.agents' && (second === undefined || second === 'skills')) ||
    /^(?:caotang\.json|coherence\.json|tasks\.json)(?:\.bak(?:\.\d+)?|\.corrupt-[\w.-]+)?$/.test(path) ||
    ['CAOTANG.md', 'AGENTS.md', 'sessions.jsonl', '.gitignore', '.caotang-mcp.lock'].includes(path)
  ) return path;
  throw new FolderRefusal('invalid');
}

async function checkRoot(grant: Grant, writable: boolean): Promise<void> {
  const info = await lstat(grant.root).catch((error: unknown) => {
    if (['ENOENT', 'ENOTDIR'].includes(String(errorCode(error)))) throw new FolderRefusal('missing');
    throw error;
  });
  if (!(info.isDirectory() && info.dev === grant.dev && info.ino === grant.ino)
    || await realpath(grant.root) !== grant.root) throw new FolderRefusal('missing');
  if (writable) {
    if (process.platform !== 'win32' && (info.mode & 0o222) === 0) throw new FolderRefusal('read-only');
    await access(grant.root, constants.W_OK);
  }
}

function publicFolder({ id, name }: Grant): NativeFolder {
  return { id, name };
}

export async function registerFolderIpc(profile: string, entryUrl: string): Promise<void> {
  const registryFs = new NodeArtifactFs(profile);
  const registry = 'native-project-folders.json';
  const recent = new Map<string, Grant>();
  const selected = new Map<string, Grant>();
  const registryBytes = await readFile(join(profile, registry), 'utf8').catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return '[]';
    throw error;
  });
  const saved: unknown = JSON.parse(registryBytes);
  if (!Array.isArray(saved)) throw new Error('Native project folder registry is unreadable.');
  for (const record of saved as Partial<Grant>[]) {
    if (!record || typeof record.id !== 'string' || typeof record.name !== 'string' || typeof record.root !== 'string'
      || typeof record.dev !== 'number' || typeof record.ino !== 'number') throw new Error('Native project folder registry is unreadable.');
    recent.set(record.id, record as Grant);
  }
  let writes = Promise.resolve();
  const updateRecents = (action: (next: Map<string, Grant>) => void): Promise<null> => {
    const write = writes.then(async () => {
      const next = new Map(recent);
      action(next);
      await registryFs.writeAtomic(registry, JSON.stringify([...next.values()]));
      recent.clear();
      for (const [id, grant] of next) recent.set(id, grant);
      return null;
    });
    writes = write.then(() => undefined, () => undefined);
    return write;
  };
  function handle<T>(channel: string, run: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>): void {
    ipcMain.handle(`folders:${channel}`, async (event, ...args: unknown[]): Promise<FolderReply<T>> => {
      const frame = event.senderFrame;
      if (!frame || frame.parent !== null || frame.url !== entryUrl) return { ok: false, error: 'invalid' };
      try {
        return { ok: true, value: await run(event, ...args) };
      } catch (error) {
        return { ok: false, error: refusal(error) };
      }
    });
  }
  function granted(id: unknown): Grant {
    const grant = typeof id === 'string' ? selected.get(id) ?? recent.get(id) : undefined;
    if (!grant) throw new FolderRefusal('missing');
    return grant;
  }
  async function withPath<T>(id: unknown, path: unknown, writable: boolean, file: boolean, use: (fs: NodeArtifactFs, target: string) => Promise<T>): Promise<T> {
    const grant = granted(id);
    const target = entryPath(grant.root, path, file);
    await checkRoot(grant, writable);
    const fs = new NodeArtifactFs(grant.root);
    if (writable && path !== '' && await fs.exists('.caotang-mcp.lock')) throw new FolderRefusal('unavailable');
    return use(fs, target);
  }
  handle('pick', async (event, mode) => {
    if (mode !== 'open' && mode !== 'empty') throw new FolderRefusal('invalid');
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new FolderRefusal('invalid');
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
    const picked = result.filePaths[0];
    if (result.canceled || !picked) return null;
    const root = await realpath(picked);
    const info = await stat(root);
    const prior = [...recent.values(), ...selected.values()].find((item) => item.root === root && item.dev === info.dev && item.ino === info.ino);
    const grant = prior ?? { id: randomUUID(), name: basename(root), root, dev: info.dev, ino: info.ino };
    await checkRoot(grant, true);
    if (mode === 'empty' && (await readdir(root)).length !== 0) throw new FolderRefusal('invalid');
    if (mode === 'open' && !await new NodeArtifactFs(root).exists('caotang.json')) throw new FolderRefusal('invalid');
    selected.set(grant.id, grant);
    return publicFolder(grant);
  });
  handle('recent', () => [...recent.values()].map(publicFolder));
  handle('remember', (_event, id) => {
    const grant = granted(id);
    return updateRecents((next) => next.set(grant.id, grant));
  });
  handle('forget', (_event, id) => {
    const grant = granted(id);
    selected.delete(grant.id);
    return updateRecents((next) => { next.delete(grant.id); });
  });
  handle('list', (_event, id, path) => withPath(id, path, path === '', false, async (fs, dir): Promise<NativeFolderEntry[]> => {
    const [dirs, files] = await Promise.all([fs.listDirs(dir), fs.listFiles(dir)]);
    return [...dirs.map((name) => ({ kind: 'directory' as const, name })), ...files.map((name) => ({ kind: 'file' as const, name }))];
  }));
  handle('read', (_event, id, path) => withPath(id, path, false, true, (fs, target) => fs.readBytes(target)));
  handle('write', (_event, id, path, bytes) => withPath(id, path, true, true, async (fs, target) => {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 50 * 1024 * 1024 || target === '.caotang-mcp.lock') throw new FolderRefusal('invalid');
    await fs.writeBytesAtomic(target, bytes);
    return null;
  }));
  handle('mkdir', (_event, id, path) => withPath(id, path, true, false, async (fs, target) => {
    await fs.ensureDir(target);
    return null;
  }));
  handle('remove', (_event, id, path) => withPath(id, path, true, true, async (fs, target) => {
    if (target === '.caotang-mcp.lock') throw new FolderRefusal('invalid');
    await fs.remove(target);
    return null;
  }));
}
