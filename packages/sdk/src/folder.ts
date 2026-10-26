/**
 * One open project folder, held by a Node host for its lifetime: the MCP server and the SDK both open a folder through this.
 *
 * The session is the only place the pieces meet: the store's project state, the command registry, the exporter that writes
 * `exports/`, and the artifact folder. It takes the single-writer lock before it reads anything, and it writes the folder through
 * the store's `writeProject` (project-format §4), one write at a time. What a host does with the project (the harness, the tools it
 * offers, when it saves) is the host's own; this is the folder underneath.
 *
 * A harness call is synchronous and a write to disk is not. The state is changed first, in memory, by the bus, and the folder
 * follows through `persist()`, which queues behind any write already in flight. The queue is what keeps two writes from
 * interleaving their manifest rotations.
 *
 * The folder is shared with whatever else opens it, and the lock file is advisory: a program that does not read
 * `.caotang-mcp.lock` can still write the folder. So the session keeps what it last loaded or saved: the manifest text, and a
 * SHA-256 digest of every document and codex file of the project. Before each save it checks that the folder still holds exactly
 * that. A `caotang.json` another program changed, a document or codex file it changed or removed, and a document or codex file it
 * added all stop the writes until the folder is opened again (`FolderChangedError`). A save from this copy would overwrite that
 * program's work, or delete a file this copy does not own.
 *
 * Within a save that is allowed, only the documents that changed are written, and only the documents this session deleted are
 * removed from `docs/` (project-format §3).
 *
 * `coherence.json` is the one file outside that check. It is read at open, and written only when the host says so, on the same
 * queue (`persistCoherence`, coherence-file.ts), because it is derived state the app writes too: its own digest check merges or
 * refuses, and never stops a manuscript save.
 */

import { mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ApplyRefusal } from '@caotang/bus';
import { COHERENCE_FILE } from '@caotang/coherence';
import { assetRecordsOf, createExporter, exportMetadataOf, type ExporterService } from '@caotang/exporter';
import { transcodePictureInNode } from '@caotang/exporter/picture-transcoder-node';
import { loadInkCompiler } from '@caotang/harness';
import { isIdWithPrefix } from '@caotang/ids';
import { loadArabicFontInNode, loadCjkFontInNode, loadColourEmojiInNode, loadDevanagariFontInNode, loadEmojiFontInNode, loadHebrewFontInNode } from '@caotang/pdf-fonts/node-loader';
import {
  ArtifactNotFoundError,
  bodyStemOf,
  changesInWords,
  createProjectCommandRegistry,
  digestOfFile,
  digestsAfterWrite,
  driftOf,
  FolderDriftError,
  hasDrift,
  isBodyFileName,
  isBodyType,
  isTransientFileError,
  joinWords,
  MANIFEST_FILE,
  MemoryArtifactFs,
  PRODUCTION_FORMAT,
  projectFileDigests,
  projectFileLabel,
  projectFileTitles,
  readProject,
  serializeManifest,
  writeProject,
  type ArtifactFs,
  type LoadNotice,
  type ProjectState,
  type WriteReport,
} from '@caotang/store';
import type { CommandRegistry } from '@caotang/bus';

import { holdCoherence, openCoherence } from './coherence-file.js';
import { acquireProjectLock, type ProjectLock } from './lock.js';
import { byteArtifactsOver, NodeArtifactFs } from './node-fs.js';
import type { FolderVoice } from './voice.js';

/** The folder holds no project, and the host did not ask for one to be made. */
export class NoProjectError extends Error {
  constructor(
    readonly root: string,
    reason: string,
    hint: string = '',
  ) {
    super(`no Caotang project at ${root}: ${reason}.${hint === '' ? '' : ` ${hint}`}`);
    this.name = 'NoProjectError';
  }
}

/**
 * The project folder changed on disk since this host last saved it, because another
 * program changed `caotang.json`, or changed, removed or added a document or codex file.
 * `applied` says whether the change had already been made in memory when the error was
 * raised (a save that was refused) or whether it was refused before it began (a write
 * made after the folder changed). Either way writes stop until the host reads the folder
 * again. `cause` names what was found, in words.
 *
 * The message names the project by name, never by the folder path: it is read by an
 * external caller, and the machine's own path to the project is a stronger identifier
 * than any file name (§4 rule 5). The path stays on the operator's own lines, which
 * a host's caller writes to stderr.
 */
export class FolderChangedError extends Error {
  constructor(
    readonly root: string,
    readonly project: string,
    readonly applied: boolean,
    cause: string = 'changed or removed caotang.json',
    /** The change was written to the folder before another program changed caotang.json after it, so the folder may not hold it. */
    readonly saved: boolean = false,
    voice: FolderVoice,
  ) {
    super(
      `the project “${project}” changed on disk since ${voice.program} last saved it, because another program ${cause}. ` +
        `Writes are stopped, so that this copy cannot overwrite that work. ${outcomeWords(applied, saved)} ` +
        voice.reload,
    );
    this.name = 'FolderChangedError';
  }
}

/** What happened to the change, in words, for a {@link FolderChangedError}. */
function outcomeWords(applied: boolean, saved: boolean): string {
  if (saved) return 'The change was saved, and then another program changed caotang.json, so the folder may not hold it.';
  return applied ? 'The change is in memory and is not saved.' : 'Nothing was written.';
}

/**
 * The manifest text the folder holds, or `undefined` when none can be read. Windows reports a file another
 * program has open as a sharing error for a moment, so those are retried, as the port retries a rename. A
 * missing file, or one that stays unreadable, is `undefined`, which the save check treats as a change.
 */
export async function manifestOnDisk(fs: Pick<NodeArtifactFs, 'read'>): Promise<string | undefined> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fs.read(MANIFEST_FILE);
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
      const transient = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
      if (!transient || attempt >= 6) return undefined;
      await new Promise((done) => setTimeout(done, 25 * attempt));
    }
  }
}

/**
 * The manifest text `writeProject` writes for this state at `stamp`. It stamps `modifiedAt`
 * the way `writeProject` does and serializes in the same format, so this is the text the
 * folder holds once the save is done, and a later read can be checked against it.
 */
export function manifestTextAt(state: ProjectState, stamp: Date): string {
  state.manifest.project.modifiedAt = stamp.toISOString();
  return serializeManifest(state.manifest, PRODUCTION_FORMAT);
}

/**
 * A document file of the project: a body file (`.md`, `.fountain` or `.ink`) whose stem is a document id (project-format §1, §3).
 * The save may write one of these, and a file of this shape that no manifest names is another program's to keep.
 */
export function isDocumentFileName(name: string): boolean {
  return isBodyFileName(name) && isIdWithPrefix('n', bodyStemOf(name));
}

/** A codex redundancy file of the project: `c_<id>.md`, whose stem is a codex id (codex.md §3). */
export function isCodexFileName(name: string): boolean {
  return name.endsWith('.md') && isIdWithPrefix('c', name.slice(0, -3));
}

/** The ids of the tree's nodes that hold a body file: a document or a dialogue container (project-format §3). */
function bodyNodeIdsOf(state: ProjectState): string[] {
  return state.manifest.tree.filter((node) => isBodyType(node.type)).map((node) => node.id);
}

/**
 * The digest of one file, or `undefined` when it is gone. The store's digest read retries a transient sharing error (another program's
 * brief hold on a file), so the hold is not read as a change. A hold that outlasts the retries is read as a file the folder does not
 * hold, which the drift check names as a change, so the write is refused and nothing is written over it.
 */
async function digestAt(fs: NodeArtifactFs, path: string): Promise<string | undefined> {
  try {
    return await digestOfFile(fs, path);
  } catch (error) {
    if (isTransientFileError(error)) return undefined;
    throw error;
  }
}

/**
 * The digest of every document and codex file the folder holds, by path, each read through {@link digestAt}. These are the files the writer
 * may write or remove, so they are what the session keeps a copy of (see `driftCause`).
 */
async function folderDigests(fs: NodeArtifactFs): Promise<Map<string, string>> {
  return projectFileDigests(fs, (path) => digestAt(fs, path));
}

/** The stored images as the exporter names them: the listing of the assets folder, or the error that listing gave. */
type HeldAssets = { readonly records: AssetRecords } | { readonly failure: unknown };
type AssetRecords = Awaited<ReturnType<typeof assetRecordsOf>>;

/** The stored images of the folder now, held for the exporter, which reads them synchronously and so cannot be given a failure later. */
async function heldAssetsOf(fs: NodeArtifactFs): Promise<HeldAssets> {
  try {
    return { records: await assetRecordsOf(fs) };
  } catch (failure) {
    return { failure };
  }
}

/**
 * The images for one compile: the held listing. A listing that failed is a refusal of the compile (an `ApplyRefusal`, which the bus
 * returns as a refusal, and not as a defect in the apply), so no shot list is written without the images it names.
 */
function assetsOf(held: HeldAssets): AssetRecords {
  if ('failure' in held) {
    const reason = held.failure instanceof Error ? held.failure.message : String(held.failure);
    throw new ApplyRefusal({
      code: 'io-error',
      message: `the images of this project could not be listed (${reason}), so no export was written`,
      correctiveHint: 'make sure the project folder can be read, then compile again',
      target: 'export.compile',
    });
  }
  return held.records;
}

/** One file of the project folder by its path, or `null` when the folder does not hold it. The exporter reads a cover this way. */
async function readAssetOrNull(fs: NodeArtifactFs, path: string): Promise<Uint8Array | null> {
  try {
    return await fs.readBytes(path);
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) return null;
    throw error;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export interface OpenFolderOptions {
  /** The project folder. */
  readonly root: string;
  readonly voice: FolderVoice;
  /** Whether `coherence.json` may be written. Off: it is read at open, and never written. */
  readonly writeCoherence: boolean;
  /**
   * Where an export is written. `folder` (default) is the project's own `exports/`. `memory` keeps the compiled files and the compile
   * log in memory for the life of the session, so a host that must not write the folder can still run an export.
   */
  readonly exports?: 'folder' | 'memory';
  readonly now?: () => Date;
  /** Where a notice raised after the open is said (a refused write to coherence.json). */
  readonly report: (line: string) => void;
  /**
   * Makes the project when the folder holds none, and returns the manifest text it wrote. Called with the lock held, before anything is
   * read. Absent, a folder with no project is refused (`NoProjectError`). The folder is made first when it does not exist.
   */
  readonly create?: (fs: NodeArtifactFs, now: () => Date) => Promise<string>;
}

export interface OpenFolder {
  readonly root: string;
  readonly fs: NodeArtifactFs;
  readonly state: ProjectState;
  readonly registry: CommandRegistry;
  readonly exporter: ExporterService;
  /** Whether `create` made the project, rather than the folder holding one. */
  readonly created: boolean;
  /** Load notices the store raised while reading the folder: migrations, dropped fields, recovered files. */
  readonly notices: LoadNotice[];
  /** Whether the folder changed under this copy, so every write is refused. */
  readonly changed: boolean;
  /** The refusal a write gets once the folder changed. `applied` is whether the change was already made in memory. */
  stoppedError(applied: boolean): FolderChangedError;
  /** Lists the stored images again, for the exporter, which reads them synchronously. */
  refreshAssets(): Promise<void>;
  /** Writes the project folder from the current state, after any write queued before it. */
  persist(): Promise<void>;
  /** Writes `coherence.json` when it changed and writes are on, on the same queue. Never throws. */
  persistCoherence(): Promise<void>;
  /** Checks the folder against what this session holds, queued like a save. A change it finds stops the writes. */
  verifyFolder(): Promise<void>;
  /** Waits for the exporter, flushes pending writes, and releases the lock. */
  close(): Promise<void>;
  /** The lock release, for an `exit` handler, which cannot await. */
  releaseLockSync(): void;
}

export async function openFolder(options: OpenFolderOptions): Promise<OpenFolder> {
  // The dialogue checks compile Ink synchronously, so the compiler is loaded before any project is (dialogue ink-loader.ts).
  await loadInkCompiler();
  const { voice } = options;
  const now = options.now ?? (() => new Date());
  const root = resolve(options.root);
  const exists = await isDirectory(root);
  if (!exists && options.create === undefined) throw new NoProjectError(root, 'the folder does not exist', voice.noProjectHint);

  await mkdir(root, { recursive: true });
  const lock: ProjectLock = await acquireProjectLock(root, now());
  try {
    const fs = new NodeArtifactFs(root);
    let created = false;
    let manifestText = await manifestOnDisk(fs);
    if (manifestText === undefined) {
      if (options.create === undefined) throw new NoProjectError(root, 'the folder holds no caotang.json', voice.noProjectHint);
      manifestText = await options.create(fs, now);
      created = true;
    }

    // The folder's documents and codex files are digested before the project is read, so a change made while it is read is one the next
    // save sees, not one it is taken to have loaded (driftCause).
    // Every digest this session reads retries another program's brief hold on a file (digestAt), the write's own check included.
    const readDigest = (path: string): Promise<string | undefined> => digestAt(fs, path);
    let held = await folderDigests(fs);
    const loaded = await readProject(fs, { now: now(), manifestText });
    const state = loaded.state;
    // coherence.json is read on either posture. Its digest is taken first, as the folder's are, so a change made while it is read is one
    // the next save sees. It is written only when the host says so, by persistCoherence.
    // A file that cannot be read has no digest and is not written (openCoherence holds it unwritable), and it never stops the open.
    const coherenceDigest = await digestAt(fs, COHERENCE_FILE).catch(() => undefined);
    const coherence = await openCoherence(fs, state, voice);
    const notices = [...loaded.notices, ...coherence.notices];
    const coherenceHold = holdCoherence({
      fs,
      state,
      opened: coherence,
      allowWrites: options.writeCoherence,
      digestAtOpen: coherenceDigest,
      digest: () => digestAt(fs, COHERENCE_FILE),
      notices,
      report: options.report,
      voice,
    });
    // The body nodes this copy named when it was last loaded or saved: one that has since left the tree is a document the session deleted.
    let heldBodies = bodyNodeIdsOf(state);
    // The titles the copy held at the same time, so a file a later edit or deletion took out of the state is still named in words.
    let heldTitles = projectFileTitles(state);

    // The stored images for the shot list and the prompt pack. The exporter reads them synchronously, so they are listed here, and
    // listed again before each confirmed call is checked (refreshAssets) and before it runs, because a confirmed call is
    // the only way an export runs. A folder that
    // cannot be listed is held as the error it gave: a compile that needs the images raises it, so the export is refused, and a
    // reader of the project is not refused for it.
    let assetRecords = await heldAssetsOf(fs);
    // The exporter gets what the desktop gives its own (exportMetadataOf), so an EPUB compiles here for a project with an identifier.
    // The cover is read from this folder's asset store; a file the folder does not hold is left out, as the exporter does.
    const exportFs: ArtifactFs = options.exports === 'memory' ? new MemoryArtifactFs() : fs;
    const exporter = createExporter({
      readState: () => state,
      artifacts: exportFs,
      bytes: byteArtifactsOver(exportFs),
      metadata: (current) => exportMetadataOf(current.manifest.project),
      readAsset: (path) => readAssetOrNull(fs, path),
      assets: () => assetsOf(assetRecords),
      // The PDFs' font for text outside Latin script: from fonts/ beside the bundle, or from @caotang/font-noto-cjk.
      loadFallbackFont: loadCjkFontInNode,
      // Their emoji font (Noto Emoji, monochrome): from fonts/ beside the bundle, or from @caotang/font-noto-emoji.
      loadEmojiFont: loadEmojiFontInNode,
      // Their colour emoji (Noto Color Emoji as vector pictures): from fonts/ beside the bundle, or from @caotang/font-noto-color-emoji.
      loadColourEmoji: loadColourEmojiInNode,
      // Their Arabic, Hebrew and Devanagari fonts: from fonts/ beside the bundle, or from @caotang/font-noto-arabic, @caotang/font-noto-hebrew and @caotang/font-noto-devanagari.
      loadArabicFont: loadArabicFontInNode,
      loadHebrewFont: loadHebrewFontInNode,
      loadDevanagariFont: loadDevanagariFontInNode,
      // A WebP picture on the contact sheet: decoded with @jsquash/webp, whose webp_dec.wasm is beside the bundle or in its package.
      transcodePicture: transcodePictureInNode,
    });
    await exporter.ready();

    const registry = createProjectCommandRegistry({ exporter: exporter.commandPort() });

    // The manifest text this host last loaded or saved: the folder must still hold it before the next save. Once a check has found
    // a change, `changed` is set and `stoppedBy` says what it found, so every later refusal says the same thing.
    let saved: string = manifestText;
    let changed = false;
    let stoppedBy: string | undefined;
    let stoppedSaved = false;
    let queue: Promise<void> = Promise.resolve();

    const errorOf = (applied: boolean, cause: string | undefined, wasSaved: boolean): FolderChangedError =>
      new FolderChangedError(root, state.manifest.project.name, applied, cause, wasSaved, voice);

    /** Stops the writes: every later one is refused, until the host reads the folder again. */
    const markChanged = (cause: string, wasSaved = false): void => {
      changed = true;
      stoppedBy = cause;
      stoppedSaved = wasSaved;
    };

    const stopWith = (cause: string, wasSaved = false): never => {
      markChanged(cause, wasSaved);
      throw errorOf(true, cause, wasSaved);
    };

    /**
     * What the folder holds now against what this session holds, in the words a refusal gives, or `undefined` when they agree: the
     * `caotang.json` text first, then every document and codex file's digest. Nothing is written or changed here.
     */
    const driftCause = async (): Promise<string | undefined> => {
      if ((await manifestOnDisk(fs)) !== saved) return 'changed or removed caotang.json';
      const drift = driftOf(held, await folderDigests(fs));
      return hasDrift(drift) ? changesInWords(drift, state, heldTitles, voice.holder) : undefined;
    };

    const saveOnce = async (): Promise<void> => {
      if (changed) throw errorOf(true, stoppedBy, stoppedSaved);
      // A change is refused before anything is written.
      const cause = await driftCause();
      if (cause !== undefined) stopWith(cause);
      const stamp = now();
      const text = manifestTextAt(state, stamp);
      // Only a document this session deleted is removed from docs/ (project-format §3, the folder-save rule). A file another program put
      // there is kept, and so is every document the copy still names.
      const present = new Set(bodyNodeIdsOf(state));
      const deleted = heldBodies.filter((id) => !present.has(id));
      const report: WriteReport = { written: [], rotated: [], dropped: [], pruned: [] };
      try {
        // Each file is checked against the digest held for it just before it is written or removed, so a change made after the check above
        // is not overwritten either.
        await writeProject(fs, state, { now: stamp, pruneDocumentIds: deleted, expectedDigests: held, readDigest, report });
      } catch (error) {
        // A write that failed part way has already changed some files, and may have written the manifest. The copy keeps the digests of the
        // files that write named, and of no other, so the next save does not take this host's own partial write for another program's
        // change, but still sees a change another program made to a file the write did not touch. The deletions are kept until a save completes.
        held = await digestsAfterWrite(fs, held, report, readDigest);
        if ((await manifestOnDisk(fs)) === text) saved = text;
        if (error instanceof FolderDriftError) {
          // Another program changed a file after the check above and before this write reached it, so the write stopped before that file.
          stopWith(joinWords(error.paths.map((path) => `changed ${projectFileLabel(path, projectFileTitles(state), heldTitles, voice.holder)}`)));
        }
        throw error;
      }
      saved = text;
      held = await digestsAfterWrite(fs, held, report, readDigest);
      heldBodies = [...present];
      heldTitles = projectFileTitles(state);
      if ((await manifestOnDisk(fs)) !== text) stopWith(`changed caotang.json after ${voice.holder} saved it`, true);
    };

    const enqueue = (task: () => Promise<void>): Promise<void> => {
      const next = queue.then(task);
      queue = next.catch(() => undefined);
      return next;
    };

    return {
      root,
      fs,
      state,
      registry,
      exporter,
      created,
      notices,
      get changed() {
        return changed;
      },
      stoppedError: (applied) => errorOf(applied, stoppedBy, applied ? stoppedSaved : false),
      async refreshAssets() {
        assetRecords = await heldAssetsOf(fs);
      },
      persist: () => enqueue(saveOnce),
      // coherence.json is derived state (findings and runs), so it is saved on the same queue as the project and never overlaps a project
      // save, but it is outside driftCause: a findings write by the app must not stop manuscript writes, and a manuscript change does not stop this one.
      persistCoherence: () => enqueue(coherenceHold.save),
      // The folder check a confirmed write runs before the host is asked. It is queued like a save, so it never reads a file a save in flight
      // is still writing, and a change it finds stops the writes exactly as a save's check would.
      verifyFolder: () =>
        enqueue(async () => {
          if (changed) return;
          const cause = await driftCause();
          if (cause !== undefined) markChanged(cause);
        }),
      async close() {
        await exporter.idle();
        await queue;
        await lock.release();
      },
      releaseLockSync() {
        lock.releaseSync();
      },
    };
  } catch (error) {
    await lock.release();
    throw error;
  }
}
