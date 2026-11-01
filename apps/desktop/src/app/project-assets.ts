/**
 * The project's binary assets: the images under `assets/` (storyboard.md §2.2). The cover is one of them (epub-metadata.md),
 * and the cover import, the shot image import, the exporter and the bundle all read and write them through this one store,
 * so no two places can disagree about which image a cover or a shot is. The exporter's own artifacts are a different store
 * (exports.ts).
 *
 * ## Where the bytes are
 *
 * Three places, in the order a read tries them:
 *
 *  1. Memory: the bytes this page has written or been given. Always there for the life of the page.
 *  2. The browser's asset store (IndexedDB, `packages/store/src/runtime/asset-store.ts`): a project opened in this browser
 *     keeps its images across a reload, with or without a folder. {@link ProjectAssets.persistFor} binds it to a project.
 *  3. The project folder, when one is attached: every write goes there too, and a read the other two do not hold is
 *     answered by the folder.
 *
 * Where the browser has no asset store (a headless test, or a browser that refuses IndexedDB), the bytes last as long as
 * the page does, and {@link ProjectAssets.durable} says so, so the caller can tell the writer what is kept.
 *
 * ## A folder that is read but not attached
 *
 * Attaching a folder can be refused (it holds a different file under one of the store's paths, or its compile log cannot be read),
 * and the refusal says nothing about which pictures the folder holds. {@link ProjectAssets.listFolder} lists `assets/` apart from
 * the attach and keeps the folder as a read-only source, so a refused folder's pictures are still present and still shown; a file
 * that differs from the browser's copy counts as present, and the browser's copy is the one read for it. Writes go only to an
 * attached folder.
 *
 * ## When the list can be trusted
 *
 * A reference is dropped only for a file the project is sure is absent. {@link ProjectAssets.listingAuthoritative} is true when
 * the browser's copy was bound and listed, or a folder's `assets/` was listed, and no listing that was tried failed: an
 * unreadable store, or a page with nothing but its own memory, is not an empty project.
 *
 * ## A folder file is never overwritten
 *
 * An asset id is random, so a clash is not expected. A folder that holds a different file under a path this store holds is
 * still refused, and the file is named, the same rule the export store keeps for exports. The attach writes nothing when
 * it refuses.
 */

import { t } from '@lingui/core/macro';
import { parseAssetFileName } from '@caotang/storyboard';
import {
  ArtifactNotFoundError,
  deleteAssetBytes,
  deleteProjectAssets,
  getAssetBytes,
  getThumb,
  listAssetPaths,
  openAssetStore,
  putAssetBytes,
  putThumb,
  type ArtifactFs,
  type AssetStore,
} from '@caotang/store';

import { folderArtifactFs, folderBytes, type DirectoryHandleLike } from './fs-access.js';

/** The folder the images live in, beside the documents (storyboard.md §2.2). */
export const ASSETS_DIR = 'assets';

/** The extensions a cover image is stored under, in the order they are probed (the same order the exporter reads them). */
const COVER_EXTENSIONS = ['png', 'jpg', 'webp'] as const;

/**
 * The browser's asset store for one project, as {@link ProjectAssets} uses it. The methods are the three the store needs, so a
 * test can supply an in-memory one without a database.
 */
export interface DurableAssets {
  put(path: string, bytes: Uint8Array): Promise<void>;
  get(path: string): Promise<Uint8Array | undefined>;
  list(): Promise<string[]>;
  /** Removes one file and its thumbnails; `true` when the store held it. Left out by a stand-in that cannot remove. */
  delete?(path: string): Promise<boolean>;
  /** The derived thumbnails: per browser, never in a folder, the manifest or a bundle (pictures.md §6.5). */
  getThumb?(path: string, size: number): Promise<Uint8Array | undefined>;
  putThumb?(path: string, size: number, bytes: Uint8Array): Promise<void>;
}

/** One database connection per IndexedDB factory: the page's own in the browser, and each test's in-memory one. */
const openStores = new WeakMap<IDBFactory, Promise<AssetStore>>();

/**
 * The browser's asset store for a project, or `undefined` when this browser has no IndexedDB (a headless run). A refused open
 * is also `undefined`: the images then last as long as the page, which {@link ProjectAssets.durable} reports.
 */
export async function browserDurableAssets(projectId: string, factory: IDBFactory | undefined = globalThis.indexedDB): Promise<DurableAssets | undefined> {
  const store = await sharedAssetStore(factory);
  if (store === undefined) return undefined;
  return {
    put: (path, bytes) => putAssetBytes(store, projectId, path, bytes),
    get: (path) => getAssetBytes(store, projectId, path),
    list: () => listAssetPaths(store, projectId),
    delete: (path) => deleteAssetBytes(store, projectId, path),
    getThumb: (path, size) => getThumb(store, projectId, path, size),
    putThumb: (path, size, bytes) => putThumb(store, projectId, path, size, bytes),
  };
}

/** The page's one connection to the asset store for `factory`, or `undefined` when there is no IndexedDB or the open is refused. */
async function sharedAssetStore(factory: IDBFactory | undefined): Promise<AssetStore | undefined> {
  if (factory === undefined) return undefined;
  let opened = openStores.get(factory);
  if (opened === undefined) {
    opened = openAssetStore(factory);
    openStores.set(factory, opened);
  }
  try {
    return await opened;
  } catch {
    // A refused open is not kept, so the next project to ask tries again.
    openStores.delete(factory);
    return undefined;
  }
}

/**
 * Removes every image the browser keeps for a project. The projects list calls it when a project is removed, so a project made
 * again later does not inherit a removed project's pictures, and the browser does not keep files nothing can reach.
 */
export async function forgetBrowserAssets(projectId: string, factory: IDBFactory | undefined = globalThis.indexedDB): Promise<void> {
  const store = await sharedAssetStore(factory);
  if (store !== undefined) await deleteProjectAssets(store, projectId);
}

export class ProjectAssets {
  private readonly held = new Map<string, Uint8Array>();
  private folder: DirectoryHandleLike | null = null;
  /** The folder's `assets/` paths as listed when it was attached. The agent's image check reads them synchronously. */
  private folderPaths = new Set<string>();
  /** A folder read for its pictures that is not (or not yet) the one writes go to: the folder of an attach that was refused. */
  private readFolder: DirectoryHandleLike | null = null;
  /** Whether a folder's `assets/` was listed, and whether the last attempt to list one failed. */
  private folderListed = false;
  private folderListFailed = false;
  /** Whether the browser's copy could not be listed, so its paths are not known to be all of them. */
  private durableListFailed = false;
  /** The browser's copy for this project, once {@link persistFor} has bound it. */
  private backend: DurableAssets | null = null;
  /** The project the browser's copy was last bound to, so a second bind of that project is the same binding. */
  private boundTo: string | null = null;
  /** The paths the browser's copy holds, as listed when it was bound, and kept current by every write. */
  private durablePaths = new Set<string>();
  /** Resolves once the browser's copy is bound and listed (at once when there is none). Every read and write waits for it. */
  private binding: Promise<void> = Promise.resolve();
  private readonly artifacts: ArtifactFs = artifactFsOf(this);

  /**
   * The asset ids this store can read now, without waiting: the held images, the browser's copy as listed, and the folder's
   * as listed at attach. The agent's `shots.annotate` image check reads this at each call (storyboard.md §4). A file that is
   * not a well-named image is left out.
   */
  presentIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const path of [...this.held.keys(), ...this.durablePaths, ...this.folderPaths]) {
      const name = parseAssetFileName(path.slice(path.lastIndexOf('/') + 1));
      if (name !== undefined) ids.add(name.assetId);
    }
    return ids;
  }

  /**
   * Whether the asset list is complete enough to say a file is absent: the browser's copy or a folder was listed, and no listing
   * failed. The session drops no image reference until this holds (storyboard.md §2.2).
   */
  listingAuthoritative(): boolean {
    if (this.durableListFailed || this.folderListFailed) return false;
    return this.backend !== null || this.folderListed;
  }

  /** Whether writes go through to a project folder, or the bytes are held in this page only. */
  hasFolder(): boolean {
    return this.folder !== null;
  }

  /** Whether the browser's copy is bound, so the bytes outlive a reload of this page. */
  durable(): boolean {
    return this.backend !== null;
  }

  /**
   * Binds the browser's copy to a project and lists what it already holds, so a reopened project's images are read from it.
   * Resolves when the list is in. Without a backend (no IndexedDB) it resolves at once, and the images last as long as the page.
   * The lifecycle binds a store when it makes it, and the session binds it again when it is made: the second bind of the same
   * project is the first one, so it does not list the store a second time.
   */
  persistFor(projectId: string, factory?: IDBFactory): Promise<void> {
    if (factory === undefined && this.boundTo === projectId) return this.binding;
    this.boundTo = projectId;
    this.binding = this.bind(projectId, factory);
    return this.binding;
  }

  private async bind(projectId: string, factory: IDBFactory | undefined): Promise<void> {
    const backend = await browserDurableAssets(projectId, factory);
    if (backend === undefined) return;
    try {
      for (const path of await backend.list()) this.durablePaths.add(path);
      this.backend = backend;
      this.durableListFailed = false;
    } catch {
      this.durableListFailed = true;
      // A list that fails leaves the copy unbound for reading: an unreadable store must not look like an empty one, so the
      // images are then held in memory and the folder only, and `durable()` says so.
    }
  }

  /**
   * Resolves once the browser's copy has been listed (at once when there is none). The session waits for this before it checks
   * the project's images, so a reopened project is not checked against a store that has not been read yet.
   */
  ready(): Promise<void> {
    return this.binding;
  }

  /**
   * The assets as an `ArtifactFs` (the storyboard reads its images through one, as the App's ports carry it). The same object
   * on every call, so a view can keep it as a hook dependency.
   */
  artifactFs(): ArtifactFs {
    return this.artifacts;
  }

  /**
   * Writes one asset file. The folder and the browser's copy are written first when they are present, so a refused write
   * leaves the memory as it was, and a write that succeeds is in every place that holds the project.
   */
  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    assertAssetPath(path);
    await this.binding;
    if (this.folder !== null) await folderBytes(this.folder).writeBytes(path, bytes);
    if (this.backend !== null) {
      await this.backend.put(path, bytes);
      this.durablePaths.add(path);
    }
    this.held.set(path, bytes.slice());
  }

  /** The folder asset reads go to when memory and the browser's copy lack a file: the attached folder, else the one only read. */
  private readable(): DirectoryHandleLike | null {
    return this.folder ?? this.readFolder;
  }

  /** The bytes of one asset file, or `null` when no place holds it: the memory, the browser's copy, or the folder. */
  async readBytes(path: string): Promise<Uint8Array | null> {
    await this.binding;
    const held = this.held.get(path);
    if (held !== undefined) return held.slice();
    if (this.backend !== null && this.durablePaths.has(path)) {
      const stored = await this.backend.get(path);
      if (stored !== undefined) return stored.slice();
    }
    const folder = this.readable();
    if (folder === null) return null;
    return folderBytes(folder).readBytes(path);
  }

  /**
   * Removes the named asset files from every place that holds them for writing: the page's memory, the browser's copy (with the
   * thumbnails of each) and an attached folder. The app only ever attaches a folder whose read-and-write permission it asked for
   * (`folderWithPermission`), so a folder here is writable; a removal the browser refuses throws, and the files removed before it
   * stay removed. Only the sweep calls it, after the retention inventory has been read (pictures.md §6.6.1), and only with the
   * candidates that inventory offered.
   */
  async removeFiles(paths: readonly string[]): Promise<string[]> {
    await this.binding;
    const removed: string[] = [];
    for (const path of paths) {
      assertAssetPath(path);
      let gone = this.held.delete(path);
      if (this.folder !== null && (await folderArtifactFs(this.folder).exists(path))) {
        await folderBytes(this.folder).removeBytes(path);
        this.folderPaths.delete(path);
        gone = true;
      }
      if (this.backend?.delete !== undefined && this.durablePaths.has(path)) {
        if (await this.backend.delete(path)) gone = true;
        this.durablePaths.delete(path);
      }
      if (gone) removed.push(path);
    }
    return removed;
  }

  /** One derived thumbnail from the browser's copy, or `undefined` when none is kept (or the browser keeps none). */
  async readThumb(path: string, size: number): Promise<Uint8Array | undefined> {
    await this.binding;
    return this.backend?.getThumb?.(path, size);
  }

  /** Keeps one derived thumbnail in the browser's copy; nothing where the browser keeps none. Never written to a folder. */
  async writeThumb(path: string, size: number, bytes: Uint8Array): Promise<void> {
    await this.binding;
    await this.backend?.putThumb?.(path, size, bytes);
  }

  /** Whether one asset file is held, without reading it. */
  async has(path: string): Promise<boolean> {
    await this.binding;
    if (this.held.has(path) || this.durablePaths.has(path)) return true;
    const folder = this.readable();
    return folder !== null && (await folderArtifactFs(folder).exists(path));
  }

  /** Every asset file, by path, as the bytes a bundle carries. */
  async snapshot(): Promise<Record<string, Uint8Array>> {
    const files: Record<string, Uint8Array> = {};
    for (const path of await this.listPaths()) {
      const bytes = await this.readBytes(path);
      if (bytes !== null) files[path] = bytes;
    }
    return files;
  }

  /** Takes in the image files of a bundle, as they were exported. */
  async loadAll(files: Readonly<Record<string, Uint8Array>>): Promise<void> {
    for (const [path, bytes] of Object.entries(files)) await this.writeBytes(path, bytes);
  }

  /**
   * The paths the folder does not hold yet, of every path this store can read (the held ones, the browser's copy and the
   * folder's own). Throws when the folder holds a different file under one of them, and names it, and writes nothing. Every path
   * is compared before any write, so a refusal leaves the folder as it was.
   */
  private async missingFrom(root: DirectoryHandleLike): Promise<string[]> {
    const target = folderBytes(root);
    const missing: string[] = [];
    for (const path of await this.listPaths()) {
      const ours = await this.readBytes(path);
      if (ours === null) continue;
      const theirs = await target.readBytes(path);
      if (theirs === null) missing.push(path);
      else if (!sameBytes(theirs, ours)) {
        throw new Error(
          `${path} is already in the folder with other contents, so nothing was written to the folder and nothing was overwritten. Move or rename that file, then try again.`,
        );
      }
    }
    return missing;
  }

  /**
   * Throws when the folder holds a different file under one of this store's paths, and writes nothing. The session runs it
   * before any other folder write, so a folder refused for its compile log is not left with images in it.
   */
  async checkAttach(root: DirectoryHandleLike): Promise<void> {
    await this.missingFrom(root);
  }

  /**
   * Copies every picture this store can read into `root` that the folder does not hold yet, and writes nothing else. The folder
   * does not become the project's folder for that: {@link attach} does. Refuses as {@link checkAttach} does, before its first write.
   */
  async copyTo(root: DirectoryHandleLike): Promise<void> {
    const missing = await this.missingFrom(root);
    const target = folderBytes(root);
    for (const path of missing) {
      const bytes = await this.readBytes(path);
      if (bytes !== null) await target.writeBytes(path, bytes);
    }
  }

  /**
   * Copies the pictures into `root` (see {@link copyTo}) and makes it the folder every later write goes to. Refuses as
   * {@link checkAttach} does.
   */
  async attach(root: DirectoryHandleLike): Promise<void> {
    await this.copyTo(root);
    this.folder = root;
    this.readFolder = null;
    this.folderPaths = await assetPathsOf(root);
    this.folderListed = true;
    this.folderListFailed = false;
  }

  /**
   * Lists a folder's `assets/` and reads from it from now on, without attaching it: the session does this before it tries the
   * attach, so a refusal leaves the folder's pictures present. A listing that fails is recorded (the list is then not
   * authoritative) and does not throw. Does nothing once a folder is attached, which is already read.
   */
  async listFolder(root: DirectoryHandleLike): Promise<void> {
    if (this.folder !== null) return;
    try {
      this.folderPaths = await assetPathsOf(root);
      this.readFolder = root;
      this.folderListed = true;
      this.folderListFailed = false;
    } catch {
      this.folderPaths = new Set();
      this.readFolder = null;
      this.folderListFailed = true;
    }
  }

  /** Every asset path the store can read: the held ones, the browser's and the folder's, sorted, without repeats. */
  async listPaths(): Promise<string[]> {
    await this.binding;
    const names = new Set([...this.held.keys(), ...this.durablePaths]);
    const folder = this.readable();
    if (folder !== null) {
      for (const name of await folderArtifactFs(folder).listFiles(ASSETS_DIR)) names.add(`${ASSETS_DIR}/${name}`);
    }
    return [...names].sort();
  }
}

/**
 * The store's assets as an {@link ArtifactFs}: the directory `assets/` lists the images, and the byte methods read and write
 * them. Text and directory operations are not part of an image store, so they refuse, rather than pretend to work.
 */
function artifactFsOf(assets: ProjectAssets): ArtifactFs {
  const refuse = (what: string): never => {
    throw new Error(`the project's images do not support ${what}`);
  };
  return {
    read: async () => refuse(t`text reads`),
    writeAtomic: async () => refuse(t`text writes`),
    listFiles: async (dir) => {
      if (dir !== ASSETS_DIR) return [];
      const paths = await assets.listPaths();
      return paths.filter((path) => path.startsWith(`${ASSETS_DIR}/`)).map((path) => path.slice(ASSETS_DIR.length + 1));
    },
    listDirs: async () => [],
    exists: async (path) => assets.has(path),
    ensureDir: async () => undefined,
    remove: async () => refuse('removal'),
    readBytes: async (path) => {
      const bytes = await assets.readBytes(path);
      if (bytes === null) throw new ArtifactNotFoundError(path);
      return bytes;
    },
    writeBytesAtomic: (path, bytes) => assets.writeBytes(path, bytes),
  };
}

/**
 * Whether the file a project's cover names is held: `false` when the project names no cover, or names one the store does not
 * hold under any image extension. A cover the store does not hold is left out of an EPUB, so this is what the panel reports.
 */
export async function coverFileHeld(assets: ProjectAssets, coverAssetId: string | null | undefined): Promise<boolean> {
  if (coverAssetId === undefined || coverAssetId === null || coverAssetId === '') return false;
  for (const extension of COVER_EXTENSIONS) {
    if (await assets.has(`${ASSETS_DIR}/${coverAssetId}.${extension}`)) return true;
  }
  return false;
}

/** The paths of the files a folder holds under `assets/`. */
async function assetPathsOf(root: DirectoryHandleLike): Promise<Set<string>> {
  return new Set((await folderArtifactFs(root).listFiles(ASSETS_DIR)).map((name) => `${ASSETS_DIR}/${name}`));
}

/**
 * Every picture a project folder holds under `assets/`, by path. A folder opened here puts them into the browser's copy as the
 * project opens, so the project opened later from the list, with no folder, still has them.
 */
export async function folderPictures(root: DirectoryHandleLike): Promise<Record<string, Uint8Array>> {
  const target = folderBytes(root);
  const pictures: Record<string, Uint8Array> = {};
  for (const name of await folderArtifactFs(root).listFiles(ASSETS_DIR)) {
    const path = `${ASSETS_DIR}/${name}`;
    const bytes = await target.readBytes(path);
    if (bytes !== null) pictures[path] = bytes;
  }
  return pictures;
}

/** A path must name one file directly inside `assets/`. The zip reader has already refused escaping names, so this is the store's own guard. */
function assertAssetPath(path: string): void {
  const prefix = `${ASSETS_DIR}/`;
  const name = path.startsWith(prefix) ? path.slice(prefix.length) : '';
  if (name === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw new Error(`"${path}" is not a file directly inside the project's ${ASSETS_DIR}/ folder`);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}
