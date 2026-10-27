/**
 * One open project: the bus, its state, the undo store, the activity log, the autosave scheduler, the persistence
 * queue, the exporter and the agent's harness, wired together once.
 *
 * ## Every mutation goes through `dispatch`
 *
 * The UI never edits `state` directly. A gesture calls `dispatch(name, params)`, which builds a `Command` and runs it
 * through `execute()` with the store's registry, the same path an agent's tool call takes (ui-modules §0.4). Undo runs
 * its inverses through the same `execute()`, so a reversal is logged and persisted like any other command.
 *
 * ## One undo store and one activity log, shared with the agent
 *
 * The harness owns the undo store and the activity log its calls write to (agent-harness §5). The session takes both
 * from it rather than building its own, so a user gesture, an agent turn and an undo of either land in one history:
 * the Undo button, the activity panel and "restore to before this turn" all read the same groups. The registry is
 * shared too, and the exporter behind `export.compile` is swapped, not the registry, when a folder is attached.
 *
 * ## Body text takes the autosave path
 *
 * Typing is debounced by `createAutosave` (800 ms, editor-engine §9, or the writer's setting). Its writer dispatches
 * `doc.write` through the bus. The bus is the revision authority: the autosave's `expectedRevision` is whatever the bus
 * last returned, and a conflict surfaces as `RevisionConflictError`, which autosave treats as the non-retryable
 * failure it is. The first write of a sitting opens the writing session (sessions.ts), and autosave counts each stored
 * change into it.
 *
 * ## Revision after undo
 *
 * An undo writes the earlier body back as a write of its own, so the store's revision moves *up* with it and never back
 * (`compensateBody`, command-bus §5, project-format §4). The autosave's base follows the store: it is re-seeded from the
 * state when the editor (re)opens a document, and when an undo or a restore changes the body under an open editor (the
 * editor's `setRevision` re-opens the slot on the revision the store now holds). It is never re-seeded while a write is
 * pending, which is autosave's own rule.
 *
 * ## Maintenance on open
 *
 * Opening a project runs the snapshot retention sweep (command-bus §5.1) once. The sweep reads the runtime store and
 * deletes what the ladder rejects. Undo does not read those rows (its snapshots are in memory), so the sweep cannot
 * take back an undo group that is still on the stack.
 *
 * ## Exports
 *
 * The exporter is injected into the registry (exporter.md §5). Its artifacts go through an `ExportStore`, which mirrors
 * them into a project folder once one is attached. The exporter takes its listing of `exports/` when it is made, so
 * attaching a folder makes it again, and the registry reaches the new one through a port that never changes.
 */

import { t } from '@lingui/core/macro';
import { isolate } from '@caotang/i18n';
import { scanTool, type CoherenceFile, type CoherenceModel, type DeterministicCheckId, type ScanData, type ScopeSpec, type ToolResult } from '@caotang/coherence';
import { compileCodex, countMentions, type DocumentTerm } from '@caotang/codex';
import {
  ApplyRefusal,
  createIdempotencyCache,
  createViewState,
  execute,
  executeAsync,
  type ActivityLog,
  type BusContext,
  type Command,
  type CommandError,
  type CommandName,
  type CommandParams,
  type CommandRegistry,
  type DocWriteParams,
  type ExecutionOutcome,
  type Result,
  type UndoGroup,
  type UndoStore,
  type ViewState,
} from '@caotang/bus';
import {
  AUTOSAVE_DEBOUNCE_MS,
  DEFAULT_RETENTION,
  RevisionConflictError,
  appendSession,
  createAutosave,
  backfillProjectIdentity,
  readSessions,
  createAssetStaging,
  createProjectCommandRegistry,
  createSkillStaging,
  createSessionTracker,
  domFlushSignals,
  evictSnapshots,
  getRevision,
  isBodyType,
  resolveRetentionConfig,
  systemCommandClock,
  writeBodySnapshot,
  type Autosave,
  type AssetStaging,
  type CodexEntry,
  type ExportCommandPort,
  type ProjectState,
  type RetentionConfig,
  type RuntimeStore,
  type SessionRecord,
  type SkillStaging,
  type SessionTracker,
  type WriteDocumentResult,
} from '@caotang/store';
import { newId } from '@caotang/ids';
import { assetRecordsOf, createExporter, exportMetadataOf, type EmitFailure, type ExporterService } from '@caotang/exporter';
import { dropDanglingImages, shotCommandPort } from '@caotang/storyboard';
import { InkCompilerNotLoaded } from '@caotang/dialogue';
import { createProductHarness, dialogueFactsOf, type Harness } from '@caotang/harness';
import type { McpClient } from '@caotang/mcp-client';
import type { SkillFile } from '@caotang/skills';

import { loadArabicFontOverHttp, loadCjkFontOverHttp, loadDevanagariFontOverHttp, loadEmojiFontOverHttp, loadHebrewFontOverHttp } from './fallback-fonts.js';
import { transcodePictureInBrowser } from './picture-transcoder.js';
import { CodexMentions } from './codex-model.js';
import { ExportStore } from './exports.js';
import { inkCompilerStatus, requestInkCompiler, requestInkCompilerFor } from './ink-compiler.js';
import { ProjectAssets, coverFileHeld } from './project-assets.js';
import { SkillReviews } from './skill-reviews.js';
import { skillsView, type SkillsView } from './skills-model.js';
import type { DirectoryHandleLike } from './fs-access.js';
import { Persistence } from './persistence.js';
import type { Shadow } from './persistence-plan.js';
import { dropHistoryOf } from './history-store.js';
import { PendingJournal, type PendingFailure } from './pending-journal.js';
import { browserStorage, stopKeptInBrowser } from './unsent-copy.js';

/* lingui-set comment="Interpolated values: error, reason, title" */

/**
 * Whether every change has reached the store (`saved`), is on its way (`saving`), failed (`failed`: retried by the next
 * change), or was refused because another tab stored newer text (`conflict`: this session never writes again, see
 * persistence.ts).
 */
export type SaveState = 'saved' | 'saving' | 'failed' | 'conflict';

/** A dispatch that returned an error: the command, who issued it, and the error's code. */
export interface RejectedDispatch {
  readonly command: CommandName;
  readonly issuedBy: 'user' | 'agent';
  readonly code: CommandError['code'];
}

/** The body this session last stored for a document, and the revision the store gave that write. */
export interface WrittenBody {
  readonly body: string;
  readonly revision: number;
}

/**
 * What the browser says about this project's storage (ui-modules §5.3). `persisted` is `null` until the browser has
 * answered, and the two estimates are `null` where the browser does not give them. Mirrored here for the UI; the
 * browser's own API is authoritative.
 */
export interface Durability {
  readonly persisted: boolean | null;
  readonly usage: number | null;
  readonly quota: number | null;
}

/** The folder's copy of the findings file was not written, while the browser's was (`CoherencePort.save`). The message says why, in words. */
export class CoherenceFolderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoherenceFolderError';
  }
}

/**
 * Where a session's coherence file is written (coherence.md §3): the browser's copy, and the open folder's when one is
 * attached. `save` receives the file as it is when the save runs, so a save never writes an older state than the latest.
 */
export interface CoherencePort {
  /** Saves `file` in the browser and in the attached folder. Throws a `CoherenceFolderError` when only the folder's copy was not written. */
  save(file: CoherenceFile): Promise<void>;
  /**
   * Makes an open folder a place the file is saved to from now on, and writes `file` into it now. The folder's own copy is read
   * first, and a copy that cannot be read is not written over: the call fails with the file named, and no folder is attached.
   */
  attachFolder(root: DirectoryHandleLike, file: CoherenceFile): Promise<void>;
}

/**
 * The copy of a project folder that this session last loaded from the folder or saved to it, with the folder it was in: the folder's
 * `caotang.json` text, the body nodes it named, and the digest of every document and codex file it held then, with the title each of those
 * files had. A copy is a baseline for that folder only: a save into any other folder has none to compare with (lifecycle `saveFolder`).
 */
export interface FolderBaseline {
  readonly folder: DirectoryHandleLike;
  readonly manifestText: string;
  readonly documentIds: readonly string[];
  /** The digest of each document and codex file, by path, as the folder held it when this copy was taken (folder-digests.ts). */
  readonly digests: ReadonlyMap<string, string>;
  /** The title each of those files had, by the id its name carries, so a change to a file this copy no longer holds is still named. */
  readonly titles: ReadonlyMap<string, string>;
}

/** What the writer chose for one scan on the Findings tab (coherence.md §6.2, §8): the scope and the checks. Both default. */
export interface ScanOptions {
  /** The writer agreed to a scope over the document guard, in the card (coherence.md §6.2). */
  readonly approvedLargeScope: boolean;
  /** Absent means the whole manuscript, as the scan has always run. */
  readonly scope?: ScopeSpec;
  /** Absent means every deterministic check. An empty list runs none, and the tab says so before it asks. */
  readonly checks?: readonly DeterministicCheckId[];
}

/** What the findings tab says about the coherence file: whether it is attached and writable, what the load noticed, and
 * why the last save did not reach the browser or the folder. */
export interface CoherenceStatus {
  readonly attached: boolean;
  readonly writable: boolean;
  readonly notices: readonly string[];
  readonly saveFailure: string | null;
}

export interface SessionOptions {
  readonly store: RuntimeStore;
  readonly projectId: string;
  readonly state: ProjectState;
  /** What the store is known to hold for this project. `null` means "nothing yet": the first pass writes everything. */
  readonly shadow: Shadow | null;
  /** The autosave debounce, from the writer's settings (ui-modules §5.1). Defaults to the spec's 800 ms. */
  readonly debounceMs?: number;
  /** The snapshot retention limits (command-bus §5.1). Defaults to 100 checkpoints kept for 30 days. */
  readonly retention?: RetentionConfig;
  /** Runs once, when the session has closed. The lifecycle gives the project's lease back here (project-lease.ts). */
  readonly onClosed?: () => void;
  /** The project's asset store, when the page already holds one for this project (lifecycle.ts). A new one is made otherwise. */
  readonly assets?: ProjectAssets;
  /** The app's MCP client (extensibility §3). With it, `tool.search` searches its servers and `mcp.invoke` reaches a loaded tool. */
  readonly mcp?: { readonly client: McpClient };
  /** The asset ids under the project's `assets/` folder, read at each call for the image check (storyboard.md §4). Absent, none are present. */
  readonly presentAssets?: () => ReadonlySet<string>;
  /** What the agent's coherence tools read from the app (`SessionCoherence`). Absent, every check runs and no review is wired. */
  readonly coherence?: SessionCoherence;
  /** The writer's reviews of this project's skills (skill-reviews.ts). Absent, no skill is reviewed, so the agent is told of none. */
  readonly skillReviews?: SkillReviews;
}

/**
 * What the app tells a session's coherence tools, read at each call: the deterministic checks the writer has on (Settings ›
 * Coherence), and the model a review runs through, which is the active provider (undefined when none is active).
 */
export interface SessionCoherence {
  readonly checks: () => readonly DeterministicCheckId[];
  readonly model: () => CoherenceModel | undefined;
}

/** What the session says when an older change is asked to be undone while a later one stands (see `undoGroup`). */
function laterChangesFirst(): string {
  return t`Undo the later changes first. Taking back this one now could also take back text written after it.`;
}

/** What the session says when a change is asked to be taken back after it already was. */
function alreadyUndone(): string {
  return t`That change has already been undone, so there is nothing to take back.`;
}

/**
 * How long the latch that answers one moment at the front holds.
 *
 * A hidden tab coming to the front fires the window's focus and the document's visibilitychange for
 * the same moment, and the platform does not promise to post the two in the same task: a latch that
 * cleared on the next macrotask would let the second signal through, and the images would be listed
 * twice for one moment. The latch re-arms on every signal and holds for this long after the last of
 * them, so one moment costs one listing however the platform posts it.
 */
const ASSET_LISTING_LATCH_MS = 100;

/**
 * What "restore to before this turn" reports: how many later changes went back with it, or why it stopped part way.
 * The session does not decide the words of the second case; the panel shows them as they are.
 */
export type RestoreResult = { readonly ok: true; readonly later: number } | { readonly ok: false; readonly message: string };

export class ProjectSession {
  readonly projectId: string;
  readonly state: ProjectState;
  readonly view: ViewState = createViewState();
  /** The activity log: the harness's, so an agent turn's rows and a user's rows are one history. */
  readonly log: ActivityLog;
  /** The undo store: the harness's, for the same reason. */
  readonly undo: UndoStore;
  /** The agent's harness, sharing this session's registry, undo store and log (agent-harness §3). */
  readonly harness: Harness;
  readonly persistence: Persistence;
  readonly autosave: Autosave;
  /** The words typed since the last save, kept where a page that goes away cannot take them (pending-journal.ts). */
  private readonly pending: PendingJournal;
  /** The timer of the journal's current window, or `null` between windows. */
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingWindowMs: number;
  /** What an open that recovered words from the journal says to the writer (`setReloadNotice`). */
  private reloadNoticeText: string | null = null;
  /** The exporter's artifacts: held for the session, and mirrored into a project folder when one is open. */
  readonly exports = new ExportStore();
  /** The project's images, the cover among them: written by the import, read by the exporter, carried by the bundle. */
  readonly assets: ProjectAssets;
  /** The images the writer has chosen and the next `project.importAsset` will take: held in memory, and single-use. */
  private readonly assetStaging: AssetStaging = createAssetStaging();
  /** The skill folders the writer has chosen and the next `skill.import` will take: held in memory, and single-use. */
  private readonly skillStaging: SkillStaging = createSkillStaging();
  /** The writer's reviews of this project's skills. A skill the writer has not read is not offered to the agent (extensibility.md §10). */
  readonly skillReviews: SkillReviews;
  /** The identity fields this open filled in (epub-metadata.md). Non-empty means the project must be saved once. */
  private readonly backfilled: readonly string[];
  /** The mention cache the codex panel's appearance view reads (codex-panels §1). */
  readonly mentions = new CodexMentions();
  private readonly registry: CommandRegistry;
  private exporterService: ExporterService;
  /**
   * The project's stored images as the exporter names them, listed by {@link refreshAssetRecords}. The exporter reads them
   * synchronously, so a compile reads this, and `null` until the first listing has finished.
   */
  private heldImages: HeldImages | null = null;
  /** How many image listings have started; a listing stores its result only when it is still the newest. */
  private imageListings = 0;
  /**
   * How many times the project's images have been listed. The views that show them read it and list
   * them again when it moves, so a keystroke does not list them (media/hooks.ts).
   */
  private assetVersion = 0;
  private readonly runtime: RuntimeStore;
  private readonly bus: BusContext;
  private readonly listeners = new Set<() => void>();
  private readonly written = new Map<string, WrittenBody>();
  /** The writing session: opened by the first write of a sitting, ended by `close` (sessions.ts). */
  private readonly sitting: SessionTracker;
  private readonly retention: RetentionConfig;
  private durabilityState: Durability = { persisted: null, usage: null, quota: null };
  private readonly maintenanceRun: Promise<void>;
  private maintenanceFailure: unknown = null;
  private closing: Promise<void> | null = null;
  private version = 0;
  /** Why the last undo did not fully succeed, or was refused, for the status line. */
  private lastUndoMessage: string | null = null;
  private readonly rejections: RejectedDispatch[] = [];
  /** The coherence file's write port and what its load said, once the file is attached (coherence.md §3). */
  private coherencePort: CoherencePort | null = null;
  private coherenceWritable = false;
  private coherenceNotices: readonly string[] = [];
  /** Why the last findings save to this browser failed. The save indicator reads failed while it is set. */
  private coherenceFailure: string | null = null;
  /**
   * Why the last write of the findings into a folder the project was saved to failed. The browser's copy is unaffected, so this
   * is shown on the findings tab but does not make the save indicator read failed.
   */
  private coherenceFolderFailure: string | null = null;
  /** The file as it was last queued for saving, as text: a save is queued only when the file has changed from it. */
  private coherenceQueued: string | null = null;
  /** Saves run one after another, so two writes never race on the rotation of the snapshots. */
  private coherenceQueue: Promise<void> = Promise.resolve();
  /** The findings writes queued or running. The save indicator reads saving while any is, since the store does not hold them until they land. */
  private coherenceInFlight = 0;
  /** Lets go of the lifecycle signals the pending journal is written on (see the constructor). */
  private detachPendingKeep: () => void = () => undefined;
  /** Lets go of the lifecycle signals the findings file is flushed on (see the constructor). */
  private detachCoherenceFlush: () => void = () => undefined;
  /** Lets go of the tab's focus signals, which list the project's images again (see the constructor). */
  private detachAssetRefresh: () => void = () => undefined;
  private readonly onClosed: (() => void) | undefined;
  /** The project as it stood when the writer last had a copy of it (`markExported`), as a signature (`changedSinceExport`). */
  /** The images the open dropped because `assets/` does not hold them, one line each. Shown on the storyboard. */
  private imageDropNotes: readonly string[] = [];
  /** The image check runs once, at the first settle (or attach) at which the asset list can be trusted (`ProjectAssets.listingAuthoritative`). */
  private imagesChecked = false;
  private exportBaseline: string | null = null;
  /** What the open folder's copy said when this session last loaded it or saved to it, and the folder it was in (`setFolderBaseline`). */
  private folderCopy: FolderBaseline | null = null;
  /** The project this one is a separate copy of, when an import or folder open made it with a fresh id (`setCopiedFrom`). */
  private copiedFromId: string | null = null;

  constructor(options: SessionOptions) {
    this.projectId = options.projectId;
    this.state = options.state;
    this.runtime = options.store;
    this.onClosed = options.onClosed;
    this.retention = resolveRetentionConfig(options.retention ?? DEFAULT_RETENTION);

    // epub-metadata.md: a project that predates the identifier and the language gets them here, once, and the save that
    // follows writes them. It is idempotent, so a folder load that already ran it changes nothing a second time.
    this.backfilled = backfillProjectIdentity(this.state.manifest);

    this.skillReviews = options.skillReviews ?? SkillReviews.none(options.projectId);
    this.assets = options.assets ?? new ProjectAssets();
    // The browser's copy of the project's images, so a reopened project's images read back after a reload. Every read and
    // write of the assets waits for this binding (project-assets.ts), so nothing is written to a store that is not yet bound.
    void this.assets.persistFor(options.projectId);
    this.exporterService = exporterFor(() => this.state, this.exports, this.assets, () => this.imagesForExport());
    void this.refreshAssetRecords();
    // The registry's exporter port is this one function, which always asks the current exporter. Attaching a folder
    // swaps the exporter behind it, so the registry the harness holds never goes stale.
    const exporter: ExportCommandPort = {
      compile: (state, request) => this.exporterService.commandPort().compile(state, request),
    };
    this.registry = createProjectCommandRegistry({
      clock: systemCommandClock,
      snapshots: (snapshot) => writeBodySnapshot(options.store, snapshot),
      exporter,
      // The storyboard module's applies (storyboard.create, shot.create, shot.setMeta). Without this port the bus refuses
      // them as not wired, and shots.annotate, which the harness wires only when shot.setMeta has an apply, is refused too.
      shots: shotCommandPort(),
      // The cover image's bytes go to the project's asset store, which writes them through to the project folder when one
      // is open. The exporter reads the cover back from the same store (epub-metadata.md).
      assets: { staging: this.assetStaging, writeBytes: (path, bytes) => this.assets.writeBytes(path, bytes) },
      // The skills the writer imports are staged here, and the command names them (extensibility.md §10).
      skillStaging: this.skillStaging,
    });

    this.harness = createProductHarness({
      state: this.state,
      registry: this.registry,
      clock: () => Date.now(),
      ports: 'agent',
      // The agent is told only of the skills the writer has read and approved, and the harness checks that on every call.
      skills: { reviewedPin: (name) => this.skillReviews.pinOf(name) },
      notify: () => this.afterCommand(),
      ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
      ...(options.presentAssets === undefined ? {} : { presentAssets: options.presentAssets }),
      // The agent's coherence scans read the writer's Coherence settings, and its review runs through the app's model
      // (coherence.md §5.3). The settings and the model are read at each call. The factory adds the dialogue facts and the review context.
      ...(options.coherence === undefined ? {} : { coherence: options.coherence }),
    });
    this.undo = this.harness.undo;
    this.log = this.harness.log;

    this.bus = {
      state: this.state,
      view: this.view,
      read: () => this.state,
      undo: this.undo,
      log: this.log,
      idempotency: createIdempotencyCache(),
      notify: () => this.bump(),
    };
    this.persistence = new Persistence(options.store, options.projectId, () => this.state, options.shadow);
    // The journal reads the autosave and the persistence only when it is asked to keep or prune, which is after both are made.
    this.pendingWindowMs = Math.min(options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_DEBOUNCE_MS);
    this.pending = new PendingJournal(browserStorage(), options.projectId, {
      docIds: () => this.state.documents.keys(),
      bodyOf: (docId) => this.state.documents.get(docId)?.body,
      stored: (docId) => this.persistence.storedDocument(docId),
      pendingBodyOf: (docId) => this.autosave.pendingBodyOf(docId),
      dirtyDocIds: () => this.autosave.dirtyDocIds(),
      stopped: () => this.persistence.isStopped(),
    });
    this.pending.subscribe(() => this.bump());
    this.persistence.subscribe(() => {
      this.afterPersistence();
      this.bump();
    });
    // The identity this open filled in is written now, not at the next edit: an identifier that was never saved would be
    // minted again on the next open, and a retailer would see two books.
    if (this.backfilled.length > 0) this.persistence.schedule();

    this.sitting = createSessionTracker({
      projectId: options.projectId,
      append: (request) => appendSession(options.store, request),
    });
    const flushSignals = domFlushSignals({ visibility: document, page: window });
    this.autosave = createAutosave({
      source: 'write',
      projectId: options.projectId,
      write: this.writeDocument,
      dispatch: this.writeDocument,
      sessions: this.sitting,
      signals: flushSignals,
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    });
    this.autosave.subscribe((event) => {
      if (event.status.dirty) this.armPendingWindow();
      this.bump();
    });
    // The typing not yet saved is kept in this browser on the same signals the autosave flushes on, synchronously (pending-journal.ts): a
    // flush that starts during teardown may never finish, and `localStorage` has finished when the handler returns.
    this.detachPendingKeep = flushSignals.subscribe(() => this.pending.keep());
    // The findings file leaves on the same signals as the bodies (project-format §4). A findings save that failed is tried again when the tab
    // is hidden or leaves, instead of waiting for the next change. A save already in flight is not awaited here, since a pagehide handler
    // cannot wait for it: the save indicator and the unload warning cover that case.
    this.detachCoherenceFlush = flushSignals.subscribe(() => this.queueCoherenceSave());

    // A picture put into the project's folder from outside the app is picked up when the tab comes
    // back to the front: the images are listed again then, and not on every change of the session
    // (assetsVersion). The listener is one for the session, and it is let go when the session closes.
    this.detachAssetRefresh = this.watchForAssetChanges();

    // Opening a project is the moment the retention ladder runs (command-bus §5.1). It is not awaited by the open:
    // a failed sweep is kept for the Data section to report, and the project opens regardless.
    this.maintenanceRun = this.sweepSnapshots();
  }

  /* ------------------------------------------------------------------ *
   * React's view of the session: a version that changes on every commit.
   * ------------------------------------------------------------------ */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = (): number => this.version;

  /** Tells every subscriber something changed. Public so the agent controller can say a turn moved. */
  bump(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /* ------------------------------------------------------------------ *
   * Commands
   * ------------------------------------------------------------------ */

  /** Build a user command with a fresh id and run it. The one door the UI uses. */
  dispatch<N extends CommandName>(name: N, params: CommandParams[N]): Result<ExecutionOutcome, CommandError> {
    return this.run({
      id: newId('cmd'),
      name,
      params,
      issuedBy: 'user',
      createdAt: Date.now(),
    });
  }

  /**
   * Every dispatch that returned an error, oldest first. A refused dispatch writes no activity row (command-bus §8: one
   * entry per executed command), so this is the only record of one, and the e2e suite reads it through the test hook to
   * see a command that was attempted and turned away.
   */
  rejected(): readonly RejectedDispatch[] {
    return this.rejections;
  }

  /** `execute()` plus the two things every dispatch owes the UI: a re-render and a persistence pass. */
  private run(command: Command): Result<ExecutionOutcome, CommandError> {
    const result = execute(command, this.bus, this.registry);
    if (!result.ok) {
      this.rejections.push({ command: command.name, issuedBy: command.issuedBy, code: result.error.code });
    } else if (command.name === 'project.deleteNode') {
      // The undo kept for a document that was deleted goes with it (history-store.ts).
      void dropHistoryOf(this.projectId, new Set(this.state.documents.keys()));
    }
    this.afterCommand();
    return result;
  }

  /**
   * Opens the journal's window on the first unsaved edit, and writes the journal when it closes: once per window while the writer types, not
   * per keystroke. A tab that is discarded or killed gets no lifecycle event, so this write is what it leaves behind.
   */
  private armPendingWindow(): void {
    if (this.pendingTimer !== null || this.closing !== null) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.pending.keep();
    }, this.pendingWindowMs);
  }

  /** A persistence pass has settled or failed: the journal drops what the store holds, or yields to the unsent copy if the session stopped. */
  private afterPersistence(): void {
    if (this.persistence.isStopped()) this.pending.clearForStop(stopKeptInBrowser(browserStorage()));
    else this.pending.prune();
  }

  /** Why the typing not yet saved could not be kept in this browser, or `null`. The shell says it in the status line. */
  pendingFailure(): PendingFailure | null {
    return this.pending.failure();
  }

  /** What an open that recovered words kept through a reload says to the writer, or `null`. */
  reloadNotice(): string | null {
    return this.reloadNoticeText;
  }

  setReloadNotice(text: string | null): void {
    this.reloadNoticeText = text;
  }

  /** What every command owes the UI and the store, whoever issued it: a persistence pass and a re-render. */
  private afterCommand(): void {
    // A dialogue container made after the open (a new one, an import, the agent's) starts the compiler's download at once.
    if (inkCompilerStatus() === 'idle') void requestInkCompilerFor(this.state);
    this.persistence.schedule();
    this.queueCoherenceSave();
    this.bump();
  }

  /**
   * The body write: one `doc.write` through the bus, dispatched as the user. It is the autosave's writer and its
   * dispatch, and it throws on refusal so autosave keeps the body and reports the failure (editor-engine §9).
   */
  private readonly writeDocument = async (request: DocWriteParams): Promise<WriteDocumentResult> => {
    // The first stored change of a sitting opens its writing session, so the autosave's count has a session to land in.
    if (!this.sitting.isOpen()) this.sitting.beginSession();
    const before = getRevision(this.state, request.docId);
    const result = this.dispatch('doc.write', {
      docId: request.docId,
      body: request.body,
      ...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision }),
    });
    if (!result.ok) {
      if (result.error.code === 'revision-conflict') {
        const actual = result.error.details?.actualRevision ?? getRevision(this.state, request.docId);
        throw new RevisionConflictError(request.docId, request.expectedRevision ?? before, actual);
      }
      throw new Error(result.error.message);
    }
    const revision = getRevision(this.state, request.docId);
    // What this session stored, and the revision the store gave it. The editor reads it back to tell its own write from one
    // that moved the document underneath it (see `EditorPane`).
    this.written.set(request.docId, { body: request.body, revision });
    return { revision, changed: revision !== before };
  };

  /* ------------------------------------------------------------------ *
   * Documents in the editor
   * ------------------------------------------------------------------ */

  /**
   * The body this session last stored for a document, or `null` before its first write. The editor reads it back to tell
   * its own write from a change made underneath it.
   */
  lastWritten(docId: string): WrittenBody | null {
    return this.written.get(docId) ?? null;
  }

  /* ------------------------------------------------------------------ *
   * Writing sessions (sessions.jsonl)
   * ------------------------------------------------------------------ */

  /** Words written so far in the open sitting, net per document (sessions.ts). Zero when no sitting is open. */
  sittingWords(): number {
    return this.sitting.pending()?.wordsWritten ?? 0;
  }

  /** Whether a writing session is open right now. */
  sittingOpen(): boolean {
    return this.sitting.isOpen();
  }

  /* ------------------------------------------------------------------ *
   * Storage and maintenance
   * ------------------------------------------------------------------ */

  /** The browser's answer about this project's storage, as the last request or check left it (ui-modules §5.3). */
  durability(): Durability {
    return this.durabilityState;
  }

  /** Records what the browser said. Called by the app once it has asked; the UI re-renders from it. */
  setDurability(next: Durability): void {
    this.durabilityState = next;
    this.bump();
  }

  /** Resolves when the open-time snapshot sweep has finished. */
  maintenance(): Promise<void> {
    return this.maintenanceRun;
  }

  /** Why the open-time sweep failed, or `null`. The project is open either way. */
  maintenanceError(): unknown {
    return this.maintenanceFailure;
  }

  /** The retention limits in force for this project (command-bus §5.1). */
  retentionLimits(): RetentionConfig {
    return this.retention;
  }

  /**
   * The trim the Data section offers: the same sweep as on open, run again now. Resolves with nothing: the caller reads
   * the new numbers from the store.
   */
  async trimSnapshots(): Promise<void> {
    await this.settle();
    await evictSnapshots(this.runtime, this.projectId, Date.now(), this.retention);
    this.bump();
  }

  private async sweepSnapshots(): Promise<void> {
    try {
      await evictSnapshots(this.runtime, this.projectId, Date.now(), this.retention);
    } catch (error) {
      this.maintenanceFailure = error;
      this.bump();
    }
  }

  /* ------------------------------------------------------------------ *
   * Exports
   * ------------------------------------------------------------------ */

  /**
   * Imports an image as the project's cover (`project.importAsset`, the one asynchronous command). The bytes are staged and
   * the command names them, so an image is never a param: a param is JSON and would be copied into the undo group. A
   * refusal is kept for the status line, as every dispatch's is, and a success changes the cover in one undo group.
   */
  async importCover(bytes: Uint8Array): Promise<Result<ExecutionOutcome, CommandError>> {
    const command: Command<CommandParams['project.importAsset']> = {
      id: newId('cmd'),
      name: 'project.importAsset',
      params: { stagingId: this.assetStaging.stage(bytes), target: 'cover' },
      issuedBy: 'user',
      createdAt: Date.now(),
    };
    const result = await executeAsync(command, this.bus, this.registry);
    if (!result.ok) this.rejections.push({ command: command.name, issuedBy: command.issuedBy, code: result.error.code });
    await this.refreshAssetRecords();
    this.afterCommand();
    return result;
  }

  /* ------------------------------------------------------------------ *
   * Skills (extensibility.md §10): the writer's own instructions for the agent
   * ------------------------------------------------------------------ */

  /** The project's skills as the Skills panel lists them, with where each stands with the writer's review. */
  skills(): SkillsView {
    return skillsView(this.state, (name) => this.skillReviews.pinOf(name));
  }

  /** Takes one skill folder into the project (`skill.import`): the files are staged, and the command names them. */
  importSkill(folder: string, files: readonly SkillFile[]): Result<ExecutionOutcome, CommandError> {
    return this.dispatch('skill.import', { stagingId: this.skillStaging.stage({ folder, files }) });
  }

  /** Writes one text file of a skill (`skill.write`). A skill changed this way is unreviewed until the writer approves it again. */
  writeSkillFile(name: string, path: string, text: string): Result<ExecutionOutcome, CommandError> {
    return this.dispatch('skill.write', { name, path, text });
  }

  deleteSkill(name: string): Result<ExecutionOutcome, CommandError> {
    return this.dispatch('skill.delete', { name });
  }

  setSkillEnabled(name: string, enabled: boolean): Result<ExecutionOutcome, CommandError> {
    return this.dispatch('skill.setEnabled', { name, enabled });
  }

  /**
   * Records that the writer read the skill as it is now and approved it. The approval is of these bytes: any change to any file of the
   * skill makes it unreviewed again. Resolves with false when there is no such skill.
   */
  async approveSkill(name: string): Promise<boolean> {
    const row = this.skills().rows.find((candidate) => candidate.name === name);
    if (row === undefined) return false;
    await this.skillReviews.approve(name, row.skill.pin);
    this.bump();
    return true;
  }

  /**
   * Imports an image as a shot's picture (`shot.importImage`, storyboard.md §3.1): the bytes are staged, the command names them
   * and the shot, and the file and the shot's `image` are one undo group. A refusal is kept for the status line, as every
   * dispatch's is.
   */
  async importShotImage(nodeId: string, bytes: Uint8Array): Promise<Result<ExecutionOutcome, CommandError>> {
    const command: Command<CommandParams['shot.importImage']> = {
      id: newId('cmd'),
      name: 'shot.importImage',
      params: { nodeId, stagingId: this.assetStaging.stage(bytes) },
      issuedBy: 'user',
      createdAt: Date.now(),
    };
    const result = await executeAsync(command, this.bus, this.registry);
    if (!result.ok) this.rejections.push({ command: command.name, issuedBy: command.issuedBy, code: result.error.code });
    await this.refreshAssetRecords();
    this.afterCommand();
    return result;
  }

  /**
   * Imports several pictures, each as its own shot's image (`shot.importImages`, storyboard.md §6): the bytes are staged, one command
   * names them and the shots, and the files and every shot's `image` are one undo group. A refusal is kept for the status line, and
   * writes no file.
   */
  async importShotImages(items: readonly { readonly nodeId: string; readonly bytes: Uint8Array }[]): Promise<Result<ExecutionOutcome, CommandError>> {
    const command: Command<CommandParams['shot.importImages']> = {
      id: newId('cmd'),
      name: 'shot.importImages',
      params: { items: items.map(({ nodeId, bytes }) => ({ nodeId, stagingId: this.assetStaging.stage(bytes) })) },
      issuedBy: 'user',
      createdAt: Date.now(),
    };
    const result = await executeAsync(command, this.bus, this.registry);
    if (!result.ok) this.rejections.push({ command: command.name, issuedBy: command.issuedBy, code: result.error.code });
    await this.refreshAssetRecords();
    this.afterCommand();
    return result;
  }

  /**
   * Lists the project's stored images again, for the exporter. The exporter reads them synchronously, so this runs at each point the
   * images can have changed (the open, the import of a cover or a shot's picture, the attach of a folder, an export asked for), and a
   * compile reads what it last listed. A listing that fails is held as its error: the compile that needs the images is then refused
   * with it, and no shot list is written with every image named as having no file.
   */
  async refreshAssetRecords(): Promise<void> {
    // Listings can overlap (the constructor's and a later import's): only the newest one started is kept, so a slow early listing
    // taken before a bundle's images loaded never replaces a newer one.
    const generation = ++this.imageListings;
    let held: HeldImages;
    try {
      // The binding is awaited inside the try, so a store that will not open is this listing's failure, held the way a listing
      // that cannot read is. The callers that fire this without awaiting it (the constructor, the tab's focus) then never face an
      // unhandled rejection, and a compile refuses with the reason instead of waiting on a listing that never lands.
      await this.assets.ready();
      held = { records: await assetRecordsOf(this.assets.artifactFs()) };
    } catch (failure) {
      held = { failure };
    }
    // A superseded listing neither replaces the images nor moves the version: only the listing this session kept says the images
    // have been listed again, so a slow early listing that lands late does not make every view re-list what a newer one read.
    if (generation !== this.imageListings) return;
    this.heldImages = held;
    // The images have been listed again, so they can have changed: the views that show them read the
    // version this moves and list them again (media/hooks.ts). A keystroke does not list them.
    this.assetVersion += 1;
    this.bump();
  }

  /**
   * The version of the project's images.
   *
   * It moves when the images have been listed again, which is when they can have changed: the open,
   * an import, a folder attached, a settle, an export asked for (`exportsReady`, which lists before
   * each compile), and the tab coming back to the front (`watchForAssetChanges`). A view that shows
   * the images lists them again when this moves, so it does not list them on every change of the
   * session (media/hooks.ts).
   */
  assetsVersion(): number {
    return this.assetVersion;
  }

  /**
   * Lists the project's images again when the tab comes back to the front.
   *
   * The images are listed when they can have changed — the open, an import, a folder attached, a
   * settle, an export asked for — and a picture put into the project's folder from outside the app is
   * one more way they can have changed: the writer drops the file into the folder with another
   * program and comes back. The tab's focus is that moment, so the listing is then, and nowhere else:
   * a keystroke does not list the folder.
   *
   * The listeners are installed for every session, whatever its folder, so a folder attached later is
   * refreshable from the moment it exists; until then the handler returns without listing, because a
   * project without a folder has no images to pick up from outside the app. The listener is one for
   * the session, and the returned function lets go of it.
   */
  private watchForAssetChanges(): () => void {
    // A hidden tab coming to the front fires the window's focus and the document's visibilitychange for the same moment. One
    // moment asks for one listing, so the first signal of it is taken and the ones that follow are let through to nothing. The
    // platform does not promise to post the two in the same task, so the latch is not cleared on the next macrotask: it re-arms on
    // every signal and holds for a moment after the last of them, and one moment costs one listing however it arrives.
    let listing = false;
    let latch: ReturnType<typeof setTimeout> | null = null;
    const listAgain = (): void => {
      if (!this.assets.hasFolder()) return;
      if (latch !== null) clearTimeout(latch);
      latch = setTimeout(() => {
        listing = false;
        latch = null;
      }, ASSET_LISTING_LATCH_MS);
      if (listing) return;
      listing = true;
      void this.refreshAssetRecords();
    };
    const whenVisible = (): void => {
      if (document.visibilityState === 'hidden') return;
      listAgain();
    };
    window.addEventListener('focus', listAgain);
    document.addEventListener('visibilitychange', whenVisible);
    return () => {
      window.removeEventListener('focus', listAgain);
      document.removeEventListener('visibilitychange', whenVisible);
      if (latch !== null) clearTimeout(latch);
    };
  }

  /**
   * The images for one compile: what the last listing read. A listing that failed, or one that has not finished, is a refusal of the
   * export (an `ApplyRefusal`, which the bus returns as a refusal, not as a defect in the apply), so no shot list is written without them.
   */
  private imagesForExport(): AssetRecords {
    if (this.heldImages === null) {
      throw new ApplyRefusal({
        code: 'io-error',
        message: t`the images of this project are still being listed, so no export was written`,
        correctiveHint: t`compile again in a moment, when the listing has finished`,
        target: 'export.compile',
      });
    }
    if ('failure' in this.heldImages) {
      const reason = this.heldImages.failure instanceof Error ? this.heldImages.failure.message : String(this.heldImages.failure);
      throw new ApplyRefusal({
        code: 'io-error',
        message: t`the images of this project could not be listed (${{ error: reason }}), so no export was written`,
        correctiveHint: t`make sure the project folder can be read, then compile again`,
        target: 'export.compile',
      });
    }
    return this.heldImages.records;
  }

  /** The image references the open dropped because `assets/` does not hold their files, one line each (storyboard.md §2.2). */
  imageNotices(): readonly string[] {
    return this.imageDropNotes;
  }

  /**
   * Resolves when the exporter has listed `exports/`, and the project's images are listed again. A compile waits for it, because the
   * names it reserves come from that listing and the images it names come from the one just read.
   */
  async exportsReady(): Promise<void> {
    // The Ink story and the dialogue tables compile the containers' Ink, which needs the compiler (ink-compiler.ts).
    await requestInkCompilerFor(this.state);
    await this.refreshAssetRecords();
    await this.exporterService.ready();
  }

  /** Resolves when every queued export write has settled, so the bytes of a finished compile are in the store. */
  exportsIdle(): Promise<void> {
    return this.exporterService.idle();
  }

  /** The export jobs that failed, oldest first. An export that wrote nothing has its reason here. */
  exportFailures(): readonly EmitFailure[] {
    return this.exporterService.failures();
  }

  /** The bytes of an artifact this session wrote at `path`, for a download. */
  readExport(path: string): Promise<Uint8Array | null> {
    return this.exports.read(path);
  }

  /** Whether the file the project's cover names is held, in the project folder or in this page's memory. */
  coverFileHeld(): Promise<boolean> {
    return coverFileHeld(this.assets, this.state.manifest.project.coverAssetId);
  }

  /** Whether the project's images are written into a project folder, or are held in this page only. */
  assetsInFolder(): boolean {
    return this.assets.hasFolder();
  }

  /** Whether an export is also written into the project folder, which is the case once a folder is attached. */
  exportsToFolder(): boolean {
    return this.exports.hasFolder();
  }

  /**
   * Mirror this project's exports into `root` from now on. Rejects, and changes nothing, when the folder's compile log
   * cannot be read as one, or when the folder already holds a different file under the name of an export this session
   * made before the folder was known (see `ExportStore.attach`). The exporter is made again afterwards, so its listing of
   * `exports/` includes the folder's files and a new export cannot take a name one of them holds.
   */
  async attachFolder(root: DirectoryHandleLike): Promise<void> {
    // The folder's pictures are listed before anything can refuse the attach, so a refused folder's pictures are still present.
    await this.assets.listFolder(root);
    // Each store refuses before it writes, and the images are checked first, so a folder refused for its compile log keeps no image.
    await this.assets.checkAttach(root);
    await this.exports.attach(root);
    await this.assets.attach(root);
    this.exporterService = exporterFor(() => this.state, this.exports, this.assets, () => this.imagesForExport());
    await this.refreshAssetRecords();
    await this.exporterService.ready();
    this.bump();
    // A check that waited for a folder's list (the project had no browser copy) runs now that the list is in.
    await this.checkImageReferences();
  }

  /* ------------------------------------------------------------------ *
   * Undo
   * ------------------------------------------------------------------ */

  /**
   * The most recent undo group's last digest, phrased for the Undo button; `null` when there is nothing to undo. The writer's own
   * typing is named by its scene, in the writer's words, and not by the log's sentence with its revision number.
   * The log keeps that sentence for the Activity panel.
   */
  undoLabel(): string | null {
    const groups = this.undo.groups();
    const last = groups[groups.length - 1];
    if (last === undefined) return null;
    const newest = this.log.entriesForGroup(last.id).at(-1);
    if (newest?.command === 'doc.write' && newest.issuedBy === 'user') {
      const title = newest.affected[0]?.title;
      return title === undefined ? t`your typing` : t`your typing in “${{ title: isolate(title) }}”`;
    }
    return this.summaryOf(last);
  }

  /** What a group did, in the words the activity log gives its last row, or the group's own label when it has no row. */
  private summaryOf(group: UndoGroup): string {
    const entries = this.log.entriesForGroup(group.id);
    return entries[entries.length - 1]?.summary ?? group.label;
  }

  /**
   * The group `undoLast` takes back: the newest in the undo store, or `null` when there is none. It is the only group that
   * can be undone (see `undoGroup`), so it is the only one the activity panel offers an Undo for.
   */
  newestUndoGroupId(): string | null {
    const groups = this.undo.groups();
    return groups[groups.length - 1]?.id ?? null;
  }

  /**
   * Undo the most recent group. Pending typing is saved first, so it becomes a group of its own and is undone in its turn
   * rather than being silently discarded.
   */
  async undoLast(): Promise<boolean> {
    await this.autosave.flush();
    this.lastUndoMessage = null;
    const newest = this.newestUndoGroupId();
    if (newest === null) return false;
    return this.undoNow(newest);
  }

  /**
   * Undo one group, but only the newest one: the Activity panel's Undo. An older group's compensations put a body back to
   * what it was before that change, which would also take back every edit made after it, and the bus does not re-base those
   * later snapshots (command-bus §5). So an older group is refused, with the reason, until the groups after it are undone.
   * Pending typing is saved first, as for `undoLast`, and that save can itself be the newest group. A group that has already
   * been undone is not there to undo. A turn's checkpoint is not undone here: `restoreBefore` takes it back.
   */
  async undoGroup(id: string): Promise<boolean> {
    await this.autosave.flush();
    this.lastUndoMessage = null;
    if (this.undo.group(id) === undefined) {
      this.lastUndoMessage = alreadyUndone();
      return false;
    }
    if (this.newestUndoGroupId() !== id) {
      this.lastUndoMessage = laterChangesFirst();
      return false;
    }
    return this.undoNow(id);
  }

  /**
   * "Restore to before this turn" (agent-harness §5, editor-engine §7): puts the project back as it was before the group `id`
   * was made. Every group made after it is taken back first, newest first, and then `id` itself, so each document and each
   * binder change returns in the order it was made, which is the only order in which a body snapshot is exact (command-bus
   * §5). Pending typing is saved first, and typing made after the turn is taken back with it, as the confirmation says.
   * Nothing older than `id` is touched.
   */
  async restoreBefore(id: string): Promise<RestoreResult> {
    await this.autosave.flush();
    this.lastUndoMessage = null;
    const groups = this.undo.groups();
    const at = groups.findIndex((group) => group.id === id);
    if (at === -1) return { ok: false, message: alreadyUndone() };
    for (const group of groups.slice(at).reverse()) {
      if (!this.undoNow(group.id)) {
        const reason = this.lastUndoMessage ?? t`a change could not be taken back`;
        return {
          ok: false,
          message: t`The restore stopped part way, because a later change could not be taken back: ${{ reason }}. Changes made before that one were not touched.`,
        };
      }
    }
    return { ok: true, later: groups.length - 1 - at };
  }

  /** The changes a restore to before `id` would also take back: each later group, oldest first, in the words the log gives it. */
  laterChangesAfter(id: string): readonly string[] {
    const groups = this.undo.groups();
    const at = groups.findIndex((group) => group.id === id);
    return at === -1 ? [] : groups.slice(at + 1).map((group) => this.summaryOf(group));
  }

  private undoNow(id: string): boolean {
    const outcome = this.undo.undo(id);
    // An undo moves stored text without going through `writeDocument`, so no write this session made describes the
    // stored body any more. The editor's own-write test must not match one of them against the undone text (EditorPane).
    this.written.clear();
    this.persistence.schedule();
    this.bump();
    if (!outcome.ok) {
      this.lastUndoMessage = outcome.error.message;
      return false;
    }
    const failed = outcome.value.failures[0];
    this.lastUndoMessage = failed ? failed.message : null;
    return outcome.value.failures.length === 0;
  }

  /** Why the last undo did not fully succeed, or was refused; `null` when it did, or none has run. */
  undoErrorMessage(): string | null {
    return this.lastUndoMessage;
  }

  /* ------------------------------------------------------------------ *
   * Coherence (coherence.md §3, §6–§8)
   * ------------------------------------------------------------------ */

  /**
   * Gives the session its coherence file, as the lifecycle loaded and reconciled it. From now on the file is the state's own
   * copy: the bus's coherence commands change it in memory, and every change is saved through `port` (see `afterCommand`).
   */
  attachCoherence(loaded: { readonly file: CoherenceFile; readonly writable: boolean; readonly notices: readonly string[] }, port: CoherencePort): void {
    this.state.coherence = loaded.file;
    this.coherencePort = port;
    this.coherenceWritable = loaded.writable;
    this.coherenceNotices = loaded.notices;
    this.coherenceQueued = JSON.stringify(loaded.file);
    this.bump();
  }

  /**
   * The coherence file as the session holds it, or `undefined` when none is attached. The state carries the store's structural
   * type; every value in it came through `attachCoherence` or a scan, both of which hold a whole `CoherenceFile`, so the
   * downcast is to the type the value already is.
   */
  coherenceFile(): CoherenceFile | undefined {
    return this.state.coherence as CoherenceFile | undefined;
  }

  /** What the findings tab reads about the file: attached, writable, what the load noticed, and the last save's failure. */
  coherenceStatus(): CoherenceStatus {
    return {
      attached: this.state.coherence !== undefined,
      writable: this.coherenceWritable,
      notices: this.coherenceNotices,
      saveFailure: this.coherenceFailure ?? this.coherenceFolderFailure,
    };
  }

  /**
   * Queues a save when the coherence file has changed since it was last queued. A body write does not change it, so typing
   * never saves the file. The save runs after the ones before it and never throws: a failure is kept for the findings tab,
   * and the file counts as not queued again, so the next command of any kind (typing included) tries the save again.
   */
  private queueCoherenceSave(): void {
    // A stopped session writes nothing (persistence.ts): not the findings either, since another tab may hold newer ones.
    if (this.persistence.isStopped()) return;
    const port = this.coherencePort;
    if (port === null || this.state.coherence === undefined || !this.coherenceWritable) return;
    const signature = JSON.stringify(this.state.coherence);
    if (signature === this.coherenceQueued) return;
    this.coherenceQueued = signature;
    void this.chainCoherenceWrite(async () => {
      const file = this.coherenceFile();
      if (file === undefined) return;
      try {
        await port.save(file);
        this.coherenceFailure = null;
      } catch (error) {
        if (error instanceof CoherenceFolderError) {
          // The browser's copy was saved; the folder's was not, and the findings tab says why.
          this.coherenceFailure = null;
          this.coherenceFolderFailure = t`Your findings could not be saved to the folder: ${{ error: error.message }}`;
          if (this.coherenceQueued === signature) this.coherenceQueued = null;
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.coherenceFailure = t`Your findings could not be saved in this browser: ${{ error: message }}`;
        // Unless a newer file has been queued behind this one, the next change queues this file again.
        if (this.coherenceQueued === signature) this.coherenceQueued = null;
      }
    });
  }

  /**
   * Chains one findings write behind the writes before it. The write counts as in flight until it has settled, and the save
   * indicator reads saving meanwhile: the indicator is the store's, and a findings write is not in the store until it lands, so
   * a reload begun when the indicator read saved could lose it. `write` never throws; a failure is kept in `coherenceFailure`.
   */
  private chainCoherenceWrite(write: () => Promise<void>): Promise<void> {
    this.coherenceInFlight += 1;
    const next = this.coherenceQueue.then(async () => {
      try {
        await write();
      } finally {
        this.coherenceInFlight -= 1;
        this.bump();
      }
    });
    this.coherenceQueue = next;
    return next;
  }

  /**
   * The deterministic scan over the manuscript (coherence.md §5.1, §7 tool 15): the checks run, the findings are upserted and
   * the run is recorded. The scan appends derived state and is not a command (command-bus §9), so it changes no manuscript
   * text. A scope over the guard is refused until the writer approves it, which the caller passes as `approvedLargeScope`.
   */
  scanCoherence(options: ScanOptions): ToolResult<ScanData> {
    const file = this.coherenceFile();
    if (file === undefined) return { ok: false, code: 'no-file', message: t`No findings file is open for this project.` };
    // The scope and the checks are the writer's choice on the Findings tab, and default to the whole manuscript and every
    // check. The dialogue facts are the branch checks' input (coherence.md §5.1, dialogue-narrative.md §5), read here so a scan
    // of the open project always sees the containers as they are now.
    const params: Record<string, unknown> = { scope: options.scope ?? { mode: 'full' } };
    if (options.checks !== undefined) params['checks'] = [...options.checks];
    // The branch checks compile Ink, which needs the compiler loaded. A scan that cannot compile says so and runs nothing, rather than
    // reporting a project with no branch findings.
    let dialogue: ReturnType<typeof dialogueFactsOf>;
    try {
      dialogue = dialogueFactsOf(this.state);
    } catch (error) {
      if (!(error instanceof InkCompilerNotLoaded)) throw error;
      void requestInkCompiler();
      return { ok: false, code: 'ink-loading', message: t`The Ink compiler is still loading, so the dialogue checks cannot run yet. Run the scan again in a moment.` };
    }
    const result = scanTool(params, {
      state: this.state,
      file,
      now: new Date(),
      detector: countInEntries,
      approvedLargeScope: options.approvedLargeScope,
      dialogue,
    });
    if (result.ok && result.file !== undefined) {
      this.state.coherence = result.file;
      this.afterCommand();
    }
    return result;
  }

  /**
   * The agent's coherence tools change the held findings file without a bus command (coherence.md §7 tools 15 and 16), so no
   * command reports the change. A turn that ends calls this, which queues the file's save like any other coherence change.
   */
  coherenceChanged(): void {
    this.afterCommand();
  }

  /**
   * Replaces the held findings file with one a review or a discard produced. The file is the state's copy from then on, and
   * it is saved through the port like every other coherence change (see `queueCoherenceSave`).
   */
  applyCoherenceFile(file: CoherenceFile): void {
    this.state.coherence = file;
    this.afterCommand();
  }

  /**
   * Makes a folder a place the findings file is saved to, and writes the file into it now. Called when the writer saves the
   * project to a folder, so the folder's copy of the findings is current from then on. The write waits behind the saves queued
   * before it, so two writes to the file never run at once, and a file that is not writable is not written to a folder either.
   */
  async attachCoherenceFolder(root: DirectoryHandleLike): Promise<void> {
    if (this.persistence.isStopped()) return;
    const port = this.coherencePort;
    if (port === null || this.state.coherence === undefined || !this.coherenceWritable) return;
    const attached = this.chainCoherenceWrite(async () => {
      const file = this.coherenceFile();
      if (file === undefined) return;
      try {
        await port.attachFolder(root, file);
        this.coherenceFolderFailure = null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.coherenceFolderFailure = t`Your findings could not be saved to the folder: ${{ error: message }}`;
      }
    });
    await attached;
  }

  /* ------------------------------------------------------------------ *
   * Persistence and save state
   * ------------------------------------------------------------------ */

  /** Whether every change has reached the store, is on its way, failed, or was refused for newer text in another tab. */
  saveState(): SaveState {
    if (this.persistence.getStatus() === 'conflict') return 'conflict';
    if (this.persistence.getStatus() === 'failed') return 'failed';
    if (this.coherenceFailure !== null) return 'failed';
    if (this.persistence.getStatus() === 'writing') return 'saving';
    if (this.autosave.dirtyDocIds().length > 0) return 'saving';
    if (this.coherenceInFlight > 0) return 'saving';
    return 'saved';
  }

  /** Resolves when the store holds everything this session has done so far. */
  async settle(): Promise<void> {
    // The open loads a bundle's images before it settles, so the listing the exporter reads is taken after them (refreshAssetRecords).
    await this.refreshAssetRecords();
    await this.checkImageReferences();
    await this.autosave.flush();
    await this.persistence.settle();
    await this.coherenceQueue;
  }

  /**
   * The open's image check (storyboard.md §2.2): an image reference whose file `assets/` does not hold is dropped, with one notice
   * per drop, and the save that follows writes the manifest without it. It runs once per session, at the first call that finds the
   * asset list authoritative: every open settles the session, which runs it, so the notices are on the session before any view
   * opens, and the storyboard's own call is then a no-op. A list that is not authoritative (no browser copy and no folder listed, or
   * a listing that failed) drops nothing and leaves the check to run when a later listing is (`attachFolder`).
   */
  async checkImageReferences(): Promise<void> {
    if (this.imagesChecked) return;
    await this.assets.ready();
    if (this.imagesChecked || !this.assets.listingAuthoritative()) return;
    this.imagesChecked = true;
    const notices = dropDanglingImages(this.state, this.assets.presentIds());
    if (notices.length === 0) return;
    this.imageDropNotes = notices;
    this.persistence.schedule();
    this.bump();
  }

  /**
   * Records that the writer has a copy of the project as it stands: a bundle was just made, or the project was just opened.
   * `changedSinceExport` is measured from here.
   */
  markExported(): void {
    this.exportBaseline = this.contentSignature();
  }

  /**
   * Whether the project has changed since `markExported` last ran. `false` before the first mark, so a session nobody has
   * taken a baseline for is never nagged to export. Across a reload there is no baseline (the copy the browser holds is
   * not a copy the writer made), which is the limit of this check.
   */
  changedSinceExport(): boolean {
    return this.exportBaseline !== null && this.exportBaseline !== this.contentSignature();
  }

  /** What makes two states the same project for the export check: the manifest, every body and revision, and the findings. */
  private contentSignature(): string {
    const documents = [...this.state.documents.values()]
      .map((doc) => [doc.id, doc.revision, doc.body] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return JSON.stringify([this.state.manifest, documents, this.state.coherence ?? null]);
  }

  /**
   * Records what `folder` held when this session loaded it or last saved to it: its `caotang.json` text, which documents that copy named,
   * and the digests and titles of its document and codex files (`FolderBaseline`). A save into that folder is refused when the folder no
   * longer holds that text or those files (lifecycle `saveFolder`).
   */
  setFolderBaseline(
    folder: DirectoryHandleLike,
    manifestText: string,
    documentIds: readonly string[],
    digests: ReadonlyMap<string, string>,
    titles: ReadonlyMap<string, string>,
  ): void {
    this.folderCopy = { folder, manifestText, documentIds: [...documentIds], digests: new Map(digests), titles: new Map(titles) };
  }

  /**
   * Replaces the digests of the folder copy this session holds, after a save into its folder changed some of those files: the text and the
   * documents named stay as they were. A session with no folder copy has nothing to replace, so the call changes nothing.
   */
  setFolderDigests(digests: ReadonlyMap<string, string>): void {
    if (this.folderCopy === null) return;
    this.folderCopy = { ...this.folderCopy, digests: new Map(digests) };
  }

  /** The session log the runtime store holds for this project, as the folder's `sessions.jsonl` is written from and read into (project-format §4). */
  sessionLog(): Promise<SessionRecord[]> {
    return readSessions(this.runtime, this.projectId);
  }

  /**
   * Records that this project is a separate copy of the project `originalId`, made with a fresh id because the original was already in this
   * browser (lifecycle `adopt`). A save into a folder holding the original is refused (lifecycle `saveFolder`).
   */
  setCopiedFrom(originalId: string): void {
    this.copiedFromId = originalId;
  }

  /** The project this one was copied from, as this session knows it (`setCopiedFrom`), or `null`. The app database keeps it across reloads. */
  copiedFrom(): string | null {
    return this.copiedFromId;
  }

  /** The folder copy this session last loaded or saved, with its folder, or `null` when it never has (see `FolderBaseline`). */
  folderBaseline(): FolderBaseline | null {
    return this.folderCopy;
  }

  /**
   * The body nodes (documents and dialogue containers) the folder's copy named that this session has since deleted: the only
   * files a save to that folder may remove. A file the session never owned is not in this list, so it is never removed. The caller
   * asks only about the folder the copy is for (lifecycle `saveFolder`).
   */
  documentsDeletedSinceFolder(): string[] {
    if (this.folderCopy === null) return [];
    const present = new Set(this.state.manifest.tree.filter((node) => isBodyType(node.type)).map((node) => node.id));
    return this.folderCopy.documentIds.filter((id) => !present.has(id));
  }

  /**
   * Leaves the project: settles it, ends the writing session if words were written in it, and stops the autosave. Resolves
   * once the session line is in the store. A sitting that is lost to a closed tab is the tracker's documented loss
   * (sessions.ts), not a silent one: nothing is recorded for it, and nothing claims otherwise. The project's lease is given
   * back last, so another tab cannot open the project while this one is still writing to it.
   */
  close(): Promise<void> {
    if (this.closing !== null) return this.closing;
    this.closing = (async () => {
      try {
        // The lifecycle signals are let go first, so nothing this session does after its close begins can start a findings save.
        this.detachCoherenceFlush();
        this.detachPendingKeep();
        if (this.pendingTimer !== null) clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
        // The tab's focus signals are let go too, so a closed session does not list the project's images any more.
        this.detachAssetRefresh();
        await this.autosave.flush();
        await this.persistence.settle();
        await this.coherenceQueue;
        this.pending.prune();
        this.autosave.dispose();
        if (this.sitting.isOpen() && (this.sitting.pending()?.docIds.length ?? 0) > 0) {
          await this.sitting.endSession();
        }
        this.listeners.clear();
      } finally {
        this.onClosed?.();
      }
    })();
    return this.closing;
  }
}

/**
 * The mention counts of one body against the codex, for a scan: the codex's own detector, run over the text, with the spellings
 * the body adds (a screenplay's cue names). A scan has no per-document cache of its own, so it counts here.
 */
function countInEntries(body: string, entries: readonly CodexEntry[], terms: readonly DocumentTerm[] = []): ReadonlyMap<string, number> {
  return countMentions(body, compileCodex(entries), terms);
}

/** The project's stored images as the exporter names them (the shot list and the prompt pack): the listing of `assets/`. */
type AssetRecords = Awaited<ReturnType<typeof assetRecordsOf>>;

/** A listing of the project's images that has finished, or the error it gave. */
type HeldImages = { readonly records: AssetRecords } | { readonly failure: unknown };

/**
 * The exporter for one project. It reads the state through `read`, so it always sees the project as it is now. Its cover is
 * read from the project's asset store, where the cover import put it; its compile outputs go to the export store. Its images are
 * read through `images`, which the session holds from its last listing (`refreshAssetRecords`).
 */
function exporterFor(
  read: () => ProjectState,
  artifacts: ExportStore,
  assets: ProjectAssets,
  images: () => AssetRecords,
): ExporterService {
  return createExporter({
    readState: read,
    artifacts: artifacts.artifacts,
    bytes: artifacts.bytes,
    metadata: (state) => exportMetadataOf(state.manifest.project),
    readAsset: (path) => assets.readBytes(path),
    assets: images,
    // The contact sheet's font for text outside Latin script, fetched from this origin only when a sheet needs it.
    loadFallbackFont: loadCjkFontOverHttp,
    // Its emoji font (Noto Emoji, monochrome), fetched from this origin only when a sheet holds an emoji.
    loadEmojiFont: loadEmojiFontOverHttp,
    // Noto Sans Arabic, Noto Sans Hebrew and Noto Sans Devanagari, fetched from this origin only when a file holds their script.
    loadArabicFont: loadArabicFontOverHttp,
    loadHebrewFont: loadHebrewFontOverHttp,
    loadDevanagariFont: loadDevanagariFontOverHttp,
    // A WebP picture on the contact sheet, drawn on a canvas: the PDF embeds PNG and JPEG only, and the CSP refuses WebAssembly.
    transcodePicture: transcodePictureInBrowser,
  });
}

