/**
 * One open project, held by this server for its lifetime.
 *
 * The session is the only place the pieces meet: the store's project state, the
 * command registry, the exporter that writes `exports/`, the harness that every
 * tool call goes through, and the artifact folder. It takes the single-writer lock
 * before it reads anything, and it writes the folder through the store's
 * `writeProject` after every write turn (project-format §4), one write at a time.
 *
 * A harness call is synchronous and a write to disk is not. The state is changed
 * first, in memory, by the bus, and the folder follows through `persist()`, which
 * queues behind any write already in flight. The queue is what keeps two writes
 * from interleaving their manifest rotations.
 *
 * The folder is shared with whatever else opens it, and the lock file is advisory:
 * a program that does not read `.caotang-mcp.lock` can still write the folder. So the
 * session keeps what it last loaded or saved: the manifest text, and a SHA-256 digest of
 * every document and codex file of the project. Before each save it checks that the
 * folder still holds exactly that. A `caotang.json` another program changed, a document
 * or codex file it changed or removed, and a document or codex file it added all stop
 * the writes until the server restarts (`FolderChangedError`). A save from this copy
 * would overwrite that program's work, or delete a file this copy does not own.
 *
 * Within a save that is allowed, only the documents that changed are written, and only
 * the documents this session deleted are removed from `docs/` (project-format §3).
 */

import { mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ApplyRefusal, type CommandError } from '@caotang/bus';
import { assetRecordsOf, createExporter, exportMetadataOf, type ExportDispatch, type ExporterService } from '@caotang/exporter';
import { loadCjkFontInNode, loadEmojiFontInNode } from '@caotang/exporter/fallback-fonts-node';
import { codexReadPort, createHarness, metadataFor, type Harness, type ToolOutcome } from '@caotang/harness';
import { isIdWithPrefix } from '@caotang/ids';
import {
  ArtifactNotFoundError,
  bodyStemOf,
  changesInWords,
  CODEX_DIR,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  digestOfFile,
  digestsAfterWrite,
  DOCS_DIR,
  driftOf,
  FolderDriftError,
  hasDrift,
  isBodyFileName,
  isBodyType,
  isTransientFileError,
  joinWords,
  MANIFEST_FILE,
  PRODUCTION_FORMAT,
  projectFileDigests,
  projectFileLabel,
  projectFileTitles,
  readProject,
  serializeManifest,
  writeProject,
  type LoadNotice,
  type ProjectState,
  type WriteReport,
} from '@caotang/store';

import { sourceWindow, type SourceWindow } from './attribution.js';
import { byteArtifactsOver, NodeArtifactFs } from './node-fs.js';
import { acquireProjectLock, type ProjectLock } from './lock.js';

/** The folder holds no project, and the caller did not ask for one to be made. */
export class NoProjectError extends Error {
  constructor(
    readonly root: string,
    reason: string,
  ) {
    super(`no Caotang project at ${root}: ${reason}. Pass --create "<name>" to make a new project there.`);
    this.name = 'NoProjectError';
  }
}

/**
 * The folder holds a project's files without its `caotang.json`, and `--create` was asked for.
 * A new manifest owns none of those files, and a save deletes a document or codex file that
 * the manifest does not own (the store's `writeProject`). So the folder is refused, unchanged.
 * `found` names the first such file.
 */
export class ProjectContentError extends Error {
  constructor(
    readonly root: string,
    readonly found: string,
  ) {
    super(
      `the folder ${root} holds ${found}, but no caotang.json, so --create did not make a project there: ` +
        'a new manifest would delete those files on its first save. Open this folder in Caotang, which recovers ' +
        'a project whose manifest is lost (project-format §5), or put caotang.json back, and start caotang-mcp again without --create.',
    );
    this.name = 'ProjectContentError';
  }
}

/**
 * The project folder changed on disk since this server last saved it, because another
 * program changed `caotang.json`, or changed, removed or added a document or codex file.
 * `applied` says whether the change had already been made in memory when the error was
 * raised (a save that was refused) or whether it was refused before it began (a write
 * made after the folder changed). Either way writes stop until the server restarts and
 * reads the folder again. `cause` names what was found, in words.
 *
 * The message names the project by name, never by the folder path: it is read by an
 * external caller, and the machine's own path to the project is a stronger identifier
 * than any file name (§4 rule 5). The path stays on the operator's own lines, which
 * `openProject`'s caller writes to stderr.
 */
export class FolderChangedError extends Error {
  constructor(
    readonly root: string,
    readonly project: string,
    readonly applied: boolean,
    cause: string = 'changed or removed caotang.json',
    /** The change was written to the folder before another program changed caotang.json after it, so the folder may not hold it. */
    readonly saved: boolean = false,
  ) {
    super(
      `the project “${project}” changed on disk since caotang-mcp last saved it, because another program ${cause}. ` +
        `Writes are stopped, so that this copy cannot overwrite that work. ${outcomeWords(applied, saved)} ` +
        'Restart caotang-mcp to reload the folder.',
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
 * The refusal a write gets when the folder's change stopped it before it began. It is the same whether the refusal is found before the
 * writer is asked (`check`) or after the accept (`callConfirmed`, through tools.ts), so the words a caller reads do not depend on the path.
 */
export function notMadeError(name: string, error: FolderChangedError): CommandError {
  return {
    code: 'io-error',
    message: `"${name}" was not made: ${error.message}`,
    correctiveHint: 'restart caotang-mcp and read the project again before making another change',
    target: name,
  };
}

/**
 * The export a preflight step would run, from the preview the export tool gives its step (export-compile.ts), or `undefined` for any other
 * step. The preview is typed `unknown` by the harness, so this narrows it to a bus export command and nothing else.
 */
function exportDispatchOf(preview: unknown): ExportDispatch | undefined {
  if (typeof preview !== 'object' || preview === null || !('dispatch' in preview)) return undefined;
  const dispatch = preview.dispatch;
  if (typeof dispatch !== 'object' || dispatch === null || !('name' in dispatch) || !('params' in dispatch)) return undefined;
  const { name, params } = dispatch;
  if (name !== 'export.compile' && name !== 'export.compileSelection') return undefined;
  if (typeof params !== 'object' || params === null) return undefined;
  return { name, params: params as Record<string, unknown> };
}

export interface OpenProjectOptions {
  /** The project folder. */
  readonly root: string;
  /** The name of a new project, made when the folder holds none. Ignored for a folder that does. */
  readonly create?: string;
  /** Whether external callers may change the project (`--allow-writes`). Off means read-only. */
  readonly allowWrites: boolean;
  readonly now?: () => Date;
}

export interface ProjectSession {
  readonly root: string;
  readonly fs: NodeArtifactFs;
  readonly state: ProjectState;
  readonly harness: Harness;
  readonly exporter: ExporterService;
  readonly allowWrites: boolean;
  /** Whether this open made the project, rather than finding one. */
  readonly created: boolean;
  /** Load notices the store raised while reading the folder: migrations, dropped fields, recovered files. */
  readonly notices: readonly LoadNotice[];
  /** The source window over the harness log, for approved writes. */
  readonly window: SourceWindow;
  /**
   * Runs a read, or an auto-applied write, as an external caller. The harness binds
   * the source to `mcp` and refuses a write the project has not opened. A write that
   * changed the project is on disk when this resolves, and a read saves nothing.
   */
  callDirect(name: string, callId: string, params: unknown, turnId: string): Promise<ToolOutcome>;
  /**
   * Runs a write the user confirmed through the host's dialog. The turn is native to
   * the harness (it carries the confirmation), and its rows are stamped `mcp` by the
   * window, so the log says who asked.
   */
  callConfirmed(name: string, callId: string, params: unknown, turnId: string): Promise<ToolOutcome>;
  /**
   * The checks of one call, with no effect: the refusal the call would get if it ran now, or `undefined` when it would be accepted. The
   * harness checks the call's params, and the exporter checks an export's selection (the gates its compile applies). A folder that changed
   * refuses a write here too. A confirmation asks only for a call that passes, so the dialog never asks for a change that cannot happen.
   */
  check(name: string, params: unknown): CommandError | undefined;
  /**
   * Lists the stored images again, for the exporter. `check` is synchronous and reads the listing held, so a confirmed call lists the
   * images first: a listing that failed once (a folder busy at open, say) is not held against every later compile, and a folder that
   * has since become unreadable refuses the compile before the writer is asked, not after.
   */
  refreshAssets(): Promise<void>;
  /** Writes the project folder from the current state, after any write queued before it. */
  persist(): Promise<void>;
  /**
   * Checks the folder against what this session holds, before a confirmed write is asked for. A change the save would refuse stops the writes
   * here, as the save would stop them, so `check` refuses the call and the host is not asked about it. Queued behind any write in flight.
   */
  verifyFolder(): Promise<void>;
  /** Waits for the exporter, flushes pending writes, and releases the lock. */
  close(): Promise<void>;
  /** The lock release, for an `exit` handler, which cannot await. */
  releaseLockSync(): void;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The turn id an external turn is held under, as the harness's own facade names it. */
export function externalTurn(turnId: string): string {
  return `mcp:${turnId}`;
}

/** Whether a tool changes the project when it runs. A read never does, so a folder that changed does not stop one. */
function changesProject(name: string): boolean {
  const risk = metadataFor(name)?.risk;
  return risk === 'write-auto' || risk === 'write-confirm';
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
function manifestTextAt(state: ProjectState, stamp: Date): string {
  state.manifest.project.modifiedAt = stamp.toISOString();
  return serializeManifest(state.manifest, PRODUCTION_FORMAT);
}

/**
 * A document file of the project: a body file (`.md`, `.fountain` or `.ink`) whose stem is a document id (project-format §1, §3).
 * The save may write one of these, and a file of this shape that no manifest names is another program's to keep.
 */
function isDocumentFileName(name: string): boolean {
  return isBodyFileName(name) && isIdWithPrefix('n', bodyStemOf(name));
}

/** A codex redundancy file of the project: `c_<id>.md`, whose stem is a codex id (codex.md §3). */
function isCodexFileName(name: string): boolean {
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
 * may write or remove, so they are what the session keeps a copy of (see `firstFolderDrift`).
 */
async function folderDigests(fs: NodeArtifactFs): Promise<Map<string, string>> {
  return projectFileDigests(fs, (path) => digestAt(fs, path));
}

/** How this server names itself in a refusal, for a file it does not hold: `a document this server does not hold`. */
const HOLDER = 'this server';

/**
 * A project file in words, for the writer: `the document “The Landing”`, `the codex entry “Elena Voss”` (the store's `projectFileLabel`,
 * which the desktop's folder question shares). The title is the one the state holds now, or else the one the session held when it last
 * loaded or saved. No node id or file name reaches the writer (the path is the server's own to log).
 */
function fileInWords(path: string, state: ProjectState, heldTitles: ReadonlyMap<string, string>): string {
  return projectFileLabel(path, projectFileTitles(state), heldTitles, HOLDER);
}

/**
 * The first file in a folder with no `caotang.json` that belongs to a project: a document or codex
 * file, or a manifest copy. A new manifest would not own a document or codex file, and a save deletes
 * those. `undefined` for a folder none of whose files are a project's.
 */
async function projectFileWithoutManifest(fs: NodeArtifactFs): Promise<string | undefined> {
  const document = (await fs.listFiles(DOCS_DIR)).find(isDocumentFileName);
  if (document !== undefined) return `the document file ${DOCS_DIR}/${document}`;
  const codex = (await fs.listFiles(CODEX_DIR)).find(isCodexFileName);
  if (codex !== undefined) return `the codex file ${CODEX_DIR}/${codex}`;
  const copy = (await fs.listFiles('')).find((name) => name.startsWith(`${MANIFEST_FILE}.`));
  return copy === undefined ? undefined : `the manifest copy ${copy}`;
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

export async function openProject(options: OpenProjectOptions): Promise<ProjectSession> {
  const now = options.now ?? (() => new Date());
  const root = resolve(options.root);
  const exists = await isDirectory(root);
  if (!exists && options.create === undefined) throw new NoProjectError(root, 'the folder does not exist');

  await mkdir(root, { recursive: true });
  const lock: ProjectLock = await acquireProjectLock(root, now());
  try {
    const fs = new NodeArtifactFs(root);
    let created = false;
    let manifestText = await manifestOnDisk(fs);
    if (manifestText === undefined) {
      if (options.create === undefined) throw new NoProjectError(root, 'the folder holds no caotang.json');
      const name = options.create.trim();
      if (name === '') throw new Error('--create needs a project name');
      // Checked before the first write: a manifest written over these files would not own them, and the first save would delete them.
      const kept = await projectFileWithoutManifest(fs);
      if (kept !== undefined) throw new ProjectContentError(root, kept);
      const stamp = now();
      const fresh = createProjectState(createEmptyManifest(name, stamp));
      manifestText = manifestTextAt(fresh, stamp);
      await writeProject(fs, fresh, { now: stamp });
      created = true;
    }

    // The folder's documents and codex files are digested before the project is read, so a change made while it is read is one the next
    // save sees, not one it is taken to have loaded (firstFolderDrift).
    // Every digest this session reads retries another program's brief hold on a file (digestAt), the write's own check included.
    const readDigest = (path: string): Promise<string | undefined> => digestAt(fs, path);
    let held = await folderDigests(fs);
    const loaded = await readProject(fs, { now: now(), manifestText });
    const state = loaded.state;
    // The body nodes this copy named when it was last loaded or saved: one that has since left the tree is a document the session deleted.
    let heldBodies = bodyNodeIdsOf(state);
    // The titles the copy held at the same time, so a file a later edit or deletion took out of the state is still named in words.
    let heldTitles = projectFileTitles(state);

    // The stored images for the shot list and the prompt pack. The exporter reads them synchronously, so they are listed here, and
    // listed again before each confirmed call is checked (refreshAssets) and before it runs (callConfirmed), because a confirmed call is
    // the only way an export runs. A folder that
    // cannot be listed is held as the error it gave: a compile that needs the images raises it, so the export is refused, and a
    // reader of the project is not refused for it.
    let assetRecords = await heldAssetsOf(fs);
    // The exporter gets what the desktop gives its own (exportMetadataOf), so an EPUB compiles here for a project with an identifier.
    // The cover is read from this folder's asset store; a file the folder does not hold is left out, as the exporter does.
    const exporter = createExporter({
      readState: () => state,
      artifacts: fs,
      bytes: byteArtifactsOver(fs),
      metadata: (current) => exportMetadataOf(current.manifest.project),
      readAsset: (path) => readAssetOrNull(fs, path),
      assets: () => assetsOf(assetRecords),
      // The contact sheet's font for text outside Latin script: from fonts/ beside the bundle, or from @caotang/font-noto-cjk.
      loadFallbackFont: loadCjkFontInNode,
      // Its emoji font (Noto Emoji, monochrome): from fonts/ beside the bundle, or from @caotang/font-noto-emoji.
      loadEmojiFont: loadEmojiFontInNode,
    });
    await exporter.ready();

    const registry = createProjectCommandRegistry({ exporter: exporter.commandPort() });
    // codex.read is a pure read over the manifest's codex, so it runs here as it does in the app.
    // The three model-backed tools stay unwired: this server holds no provider profile or key,
    // and those tools would draft with Caotang's model, not the caller's.
    const harness = createHarness({ state, registry, externalWrites: options.allowWrites, ports: { 'codex.read': codexReadPort } });
    const window = sourceWindow(harness.log);

    // The manifest text this server last loaded or saved: the folder must still hold it before the next save. Once a check has found
    // a change, `changed` is set and `stoppedBy` says what it found, so every later refusal says the same thing.
    let saved: string = manifestText;
    let changed = false;
    let stoppedBy: string | undefined;
    let stoppedSaved = false;
    let queue: Promise<void> = Promise.resolve();

    /** Stops the writes: every later one is refused, until the server restarts and reads the folder again. */
    const markChanged = (cause: string, wasSaved = false): void => {
      changed = true;
      stoppedBy = cause;
      stoppedSaved = wasSaved;
    };

    const stopWith = (cause: string, wasSaved = false): never => {
      markChanged(cause, wasSaved);
      throw new FolderChangedError(root, state.manifest.project.name, true, cause, wasSaved);
    };

    /**
     * What the folder holds now against what this session holds, in the words a refusal gives, or `undefined` when they agree: the
     * `caotang.json` text first, then every document and codex file's digest. Nothing is written or changed here.
     */
    const driftCause = async (): Promise<string | undefined> => {
      if ((await manifestOnDisk(fs)) !== saved) return 'changed or removed caotang.json';
      const drift = driftOf(held, await folderDigests(fs));
      return hasDrift(drift) ? changesInWords(drift, state, heldTitles, HOLDER) : undefined;
    };

    const saveOnce = async (): Promise<void> => {
      if (changed) throw new FolderChangedError(root, state.manifest.project.name, true, stoppedBy, stoppedSaved);
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
        // files that write named, and of no other, so the next save does not take this server's own partial write for another program's
        // change, but still sees a change another program made to a file the write did not touch. The deletions are kept until a save completes.
        held = await digestsAfterWrite(fs, held, report, readDigest);
        if ((await manifestOnDisk(fs)) === text) saved = text;
        if (error instanceof FolderDriftError) {
          // Another program changed a file after the check above and before this write reached it, so the write stopped before that file.
          stopWith(joinWords(error.paths.map((path) => `changed ${fileInWords(path, state, heldTitles)}`)));
        }
        throw error;
      }
      saved = text;
      held = await digestsAfterWrite(fs, held, report, readDigest);
      heldBodies = [...present];
      heldTitles = projectFileTitles(state);
      if ((await manifestOnDisk(fs)) !== text) stopWith('changed caotang.json after this server saved it', true);
    };

    const persist = (): Promise<void> => {
      const next = queue.then(saveOnce);
      queue = next.catch(() => undefined);
      return next;
    };

    // The folder check a confirmed write runs before the host is asked. It is queued like a save, so it never reads a file a save in flight
    // is still writing, and a change it finds stops the writes exactly as a save's check would.
    const verifyFolder = (): Promise<void> => {
      const next = queue.then(async () => {
        if (changed) return;
        const cause = await driftCause();
        if (cause !== undefined) markChanged(cause);
      });
      queue = next.catch(() => undefined);
      return next;
    };

    const session: ProjectSession = {
      root,
      fs,
      state,
      harness,
      exporter,
      allowWrites: options.allowWrites,
      created,
      notices: loaded.notices,
      window,

      async callDirect(name, callId, params, turnId) {
        if (changed && changesProject(name)) throw new FolderChangedError(root, state.manifest.project.name, false, stoppedBy);
        const before = harness.log.length;
        const outcome = harness.external.call({ name, callId, params }, { turnId });
        harness.external.endTurn(turnId);
        // Only a write saves the folder. A read can still log a row (coherence.scan logs its run), and that row stays in
        // memory: a read is not a change to the project's files, and a server without --allow-writes never writes them.
        if (options.allowWrites && changesProject(name) && harness.log.length !== before) await persist();
        return outcome;
      },

      async callConfirmed(name, callId, params, turnId) {
        if (changed) throw new FolderChangedError(root, state.manifest.project.name, false, stoppedBy);
        assetRecords = await heldAssetsOf(fs);
        const turn = externalTurn(turnId);
        const before = harness.log.length;
        const outcome = window.within('mcp', () =>
          harness.call({ name, callId, params }, { turnId: turn, permission: { confirmed: true } }),
        );
        harness.endTurn(turn);
        await exporter.idle();
        if (harness.log.length !== before || outcome.ok) await persist();
        return outcome;
      },

      check(name, params) {
        // A folder that changed stops every write (callConfirmed), so a write is refused here, as the accept would refuse it, and no
        // question is asked for it.
        if (changed && changesProject(name))
          return notMadeError(name, new FolderChangedError(root, state.manifest.project.name, false, stoppedBy));
        // A plan of one step is checked by the tool's own prepare, with no effect (plan.ts), which is the check the accept runs first. A step
        // is deferred only when an earlier step may create what it names, and a plan of one has none, so a refusal here is final.
        const preflight = harness.previewPlan({ steps: [{ tool: name, params, expect: 'the call as the host asked it' }] });
        if (!preflight.ok) return preflight.error;
        const step = preflight.value.steps[0];
        if (step?.status === 'refused') return step.error;
        // An export's gates are the exporter's, and they run at apply, after the writer is asked. Here they run with nothing reserved or
        // written, so a compile that would be refused (a screenplay format with no scene, say) is refused before the dialog.
        const dispatch = exportDispatchOf(step?.preview);
        return dispatch === undefined ? undefined : exporter.refusalOf(state, dispatch, now().getTime());
      },

      async refreshAssets() {
        assetRecords = await heldAssetsOf(fs);
      },

      persist,
      verifyFolder,

      async close() {
        await exporter.idle();
        await queue;
        await lock.release();
      },

      releaseLockSync() {
        lock.releaseSync();
      },
    };
    return session;
  } catch (error) {
    await lock.release();
    throw error;
  }
}
