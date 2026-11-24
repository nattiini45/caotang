import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import { ArtifactPathError, NodeArtifactFs, resolveWithin } from '@caotang/artifact-fs-node';
import { ArtifactNotFoundError } from '@caotang/store/artifact-fs';
import { subscribe } from '@parcel/watcher';
import type { AsyncSubscription, Event } from '@parcel/watcher';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';

import type { FolderReply, NativeFolder, NativeFolderChange, NativeFolderEntry } from './folder-contract.cjs';

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

/**
 * The grants a registry file holds. The file is the list of recent folders, not the projects, so one that cannot be read costs the list
 * and never the window: a file that is not a list starts empty, and a record missing a field is dropped rather than stopping the shell.
 */
function grantsIn(bytes: string): Grant[] {
  let saved: unknown;
  try {
    saved = JSON.parse(bytes);
  } catch (error) {
    console.error('Caotang could not read its recent-folder list. Starting with none.', error);
    return [];
  }
  if (!Array.isArray(saved)) return [];
  return saved.filter((record): record is Grant => {
    if (record === null || typeof record !== 'object') return false;
    const candidate = record as Partial<Grant>;
    return typeof candidate.id === 'string' && typeof candidate.name === 'string' && typeof candidate.root === 'string'
      && typeof candidate.dev === 'number' && typeof candidate.ino === 'number';
  });
}

/** The temp name an artifact write uses before its rename (artifact-fs-node): a watcher sees it come and go, and it is not the project. */
const TEMP_FILE = /(?:^|\/)\.[^/]*\.tmp$/u;

/** Folders whose contents are not the project's text: another program's data, backups and exports the app wrote itself. */
const UNWATCHED = ['**/.git/**', '**/node_modules/**', '**/exports/**', '**/.caotang-backup/**', '**/.caotang-mcp.lock', '**/*.tmp'];

/** The project-relative paths a burst of watcher events names, without the temp writes and repeats. */
function changedPaths(root: string, events: readonly Event[]): readonly string[] {
  const paths = events
    .map((event) => relative(root, event.path).split(sep).join('/'))
    .filter((path) => path !== '' && !path.startsWith('../') && !TEMP_FILE.test(path));
  return [...new Set(paths)];
}

/**
 * What the rest of the main process may ask of the grant list: the directory a folder id names. Only a folder the writer opened or
 * picked is in it, so another channel can be handed an id and never a path.
 */
export interface FolderRegistry {
  rootOf(id: string): string | undefined;
}

export interface FolderIpcOptions {
  /**
   * The pid of the MCP server this app runs, when one is running. A lock that names it is the app's own writer, not another program's:
   * the page pauses that server around its saves, so a write from here never races it (mcp.mts, packages/sdk/src/lock.ts).
   */
  readonly ownWriter?: () => number | undefined;
}

/**
 * Whether another writer holds the folder. The lock a Caotang MCP server leaves records its process; the one this app started is not
 * another writer, because the page pauses it for the length of its own save. Any other lock — a server a terminal started, or one whose
 * body cannot be read — is another writer, and the write is refused as it always was.
 */
async function heldByOtherWriter(fs: NodeArtifactFs, ownWriter: () => number | undefined): Promise<boolean> {
  if (!(await fs.exists('.caotang-mcp.lock'))) return false;
  const own = ownWriter();
  if (own === undefined) return true;
  const bytes = await fs.readBytes('.caotang-mcp.lock').catch(() => undefined);
  if (bytes === undefined) return true;
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return !(body !== null && typeof body === 'object' && (body as { pid?: unknown }).pid === own);
  } catch {
    return true;
  }
}

export async function registerFolderIpc(profile: string, entryUrl: string, options: FolderIpcOptions = {}): Promise<FolderRegistry> {
  const registryFs = new NodeArtifactFs(profile);
  const registry = 'native-project-folders.json';
  const recent = new Map<string, Grant>();
  const selected = new Map<string, Grant>();
  const registryBytes = await readFile(join(profile, registry), 'utf8').catch((error: unknown) => {
    if (errorCode(error) !== 'ENOENT') console.error('Caotang could not read its recent-folder list. Starting with none.', error);
    return '[]';
  });
  for (const record of grantsIn(registryBytes)) recent.set(record.id, record);
  /**
   * The watchers behind the open folders, one per folder and window, and the ids handed out for each of them. A watch belongs to
   * the caller that asked for it: a reload or a second holder gets its own id, so a late release takes only its own id with it.
   */
  const watches = new Map<string, { readonly subscription: Promise<AsyncSubscription>; readonly holders: Set<string> }>();
  const holders = new Map<string, string>();
  /** The windows already being watched for destruction, so one window has one listener however many watchers it opens. */
  const watchedWindows = new Set<number>();
  const watchKey = (grant: Grant, contents: WebContents): string => `${grant.id}\u0000${contents.id}`;
  /** Ends one holder's watch, and stops the watcher when it was the folder and window's last one. */
  const dropWatch = async (subscriptionId: string): Promise<void> => {
    const key = holders.get(subscriptionId);
    if (key === undefined) return;
    holders.delete(subscriptionId);
    const record = watches.get(key);
    if (record === undefined) return;
    record.holders.delete(subscriptionId);
    if (record.holders.size > 0) return;
    watches.delete(key);
    const subscription = await record.subscription.catch(() => null);
    await subscription?.unsubscribe().catch(() => undefined);
  };
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
    if (writable && path !== '' && await heldByOtherWriter(fs, options.ownWriter ?? (() => undefined))) throw new FolderRefusal('unavailable');
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
    // Forgetting edits the list, not the grant. A session that is closing still writes to the folder it was opened from, so the grant
    // goes on working for the rest of this run and only the persisted entry is removed.
    selected.set(grant.id, grant);
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
  // One watcher per folder and window, and an id per watch call on it: a holder that goes away after a successor arrives releases
  // only its own id, and the successor's watch goes on until it releases too.
  handle('watch', async (event, id) => {
    const grant = granted(id);
    await checkRoot(grant, false);
    const contents = event.sender;
    const key = watchKey(grant, contents);
    let record = watches.get(key);
    if (record === undefined) {
      // The record is in the map before the watcher is awaited: two calls that overlap share one subscription instead of the
      // second replacing the first and leaving it running.
      const created = { subscription: subscribe(grant.root, (_error, events) => {
        const paths = changedPaths(grant.root, events);
        if (paths.length === 0) return;
        const change: NativeFolderChange = { folderId: grant.id, paths };
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send('folders:changed', change);
        }
      }, { ignore: UNWATCHED }), holders: new Set<string>() };
      watches.set(key, created);
      // One listener per window, not one per watcher: a window that goes drops every holder of every folder it watches.
      if (!watchedWindows.has(contents.id)) {
        watchedWindows.add(contents.id);
        contents.once('destroyed', () => {
          watchedWindows.delete(contents.id);
          for (const [watched, opened] of watches) {
            if (!watched.endsWith(`\u0000${contents.id}`)) continue;
            for (const held of [...opened.holders]) void dropWatch(held);
          }
        });
      }
      record = created;
    }
    const subscriptionId = randomUUID();
    record.holders.add(subscriptionId);
    holders.set(subscriptionId, key);
    // A watcher that would not start answers as a refusal and leaves nothing behind, so the next ask tries again instead of this
    // window believing it watches a folder it does not.
    try {
      await record.subscription;
    } catch (error) {
      await dropWatch(subscriptionId);
      throw error;
    }
    return subscriptionId;
  });
  handle('unwatch', (_event, subscription) => {
    void dropWatch(typeof subscription === 'string' ? subscription : '');
    return Promise.resolve(null);
  });
  return {
    rootOf: (id) => selected.get(id)?.root ?? recent.get(id)?.root,
  };
}
