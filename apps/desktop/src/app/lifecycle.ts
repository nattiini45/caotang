/**
 * Project-level operations: create, open, list, remove, export, import, and the folder open and save. None of these is a bus command — a project's existence is not an edit
 * to it — so each one builds or reads a `ProjectState` and hands it to a session.
 *
 * ## Identity on import
 *
 * A project's id is generated once (project-format §2). An import whose id is already
 * in this browser would make two projects answer to one id, so the copy is given a
 * fresh id and the caller is told. The original is never touched.
 *
 * ## One tab per project
 *
 * Every session takes its project's lease (project-lease.ts) before it is made, and gives it back when it closes. A project another tab has open is refused, not opened twice.
 *
 * ## A manifest that will not load
 *
 * A folder or bundle whose `caotang.json` cannot be read is not refused. The §5 recovery ladder is offered as a `PendingRecovery`, and nothing is written for it until the writer
 * accepts (`completeRecovery`). Recovery reads and reports first: writing is a separate, consented step. A folder recovery is also checked when it is accepted: the folder must
 * still hold the `caotang.json` the offer read, and a lock another program may hold needs the writer's yes, as a folder save does. Otherwise nothing is written.
 *
 * ## Saving to a folder another writer may share
 *
 * The desktop and the Caotang MCP server can both write one folder. `saveFolder` writes only when the folder still holds the `caotang.json` this session last loaded or saved **from that
 * folder** (a copy taken from another folder is no baseline for it), and every document and codex file this session held: a file another program changed, removed or added is
 * refused, named by its title, and written only when the writer says to replace it. The digests of those files are taken when the folder is opened and after each save (folder-digests.ts).
 * It never removes a document file the session did not delete (integrity-model.ts, write.ts `pruneDocumentIds`), and it never writes a project id the folder does not already hold.
 * What a confirmed save replaces is kept first: each document or codex file whose bytes the session did not last write is copied to `.caotang-backup/<time>/<path>` before it is replaced or removed,
 * and a save that cannot keep a copy stops before that file (folder-guard.ts). The browser has no compare-and-swap, so a change made between a file's last check and its rename cannot be
 * prevented, only narrowed and reported: the digest is read once more as the copy is made, and after the write the folder's files, `caotang.json` and the lock are read again. A file another program changed
 * meanwhile, or a lock that appeared, is named in a refusal marked `after`, and the copy the next save is checked against does not take it as the save's own.
 * A folder whose project this browser already keeps opens as that project when the stored copy is the same book (the same manifest, document text and codex entries), and the folder is then saved back to. A folder whose project another tab holds is refused, as the projects list refuses it. A folder whose project this browser keeps in a different version is not copied without a word: the writer is asked whether to use the folder's version, keep this browser's version and save it to the folder, or open the folder as a second copy with its own id, which cannot be saved into the folder (`answerFolderDiffers`). A project remembers the folder it was saved to or opened from as its own (folder-memory.ts), so the projects list can reopen it.
 * A session that a stale write has stopped saves nothing to a folder either.
 */

import { COHERENCE_FILE, serializeCoherenceFile, type CoherenceFile } from '@caotang/coherence';
import {
  ArtifactNotFoundError,
  appendSession,
  bodyNamesOf,
  commitRecovery,
  BACKFILLABLE_FIELDS,
  DOCS_DIR,
  createEmptyManifest,
  createProjectState,
  deleteProject,
  digestsAfterWrite,
  driftOf,
  exportProjectZip,
  FolderDriftError,
  importProjectZip,
  isBodyType,
  listProjectIds,
  ManifestUnreadableError,
  MANIFEST_FILE,
  MemoryArtifactFs,
  PRODUCTION_FORMAT,
  ProjectRefusedError,
  ProjectValidationError,
  SESSIONS_FILE,
  SessionsShrinkError,
  hasDrift,
  parseSessionsLog,
  projectFileChanges,
  projectFileDigests,
  projectFileLabel,
  projectFileTitles,
  readProject,
  readProjectState,
  readSessions,
  recoverProject,
  serializeManifest,
  writeProject,
  writeSessionsFile,
  type ArtifactFs,
  type EncodingIssue,
  type FolderDrift,
  type ProjectFileChange,
  type LoadNotice,
  type LoadResult,
  type WriteReport,
  readCoherenceFiles,
  writeCoherenceFiles,
  writeProjectState,
  type ProjectState,
  type RecoveryOffer,
  type RetentionConfig,
  type RuntimeStore,
  type SessionRecord,
} from '@caotang/store';
import { newId } from '@caotang/ids';
import type { McpClient } from '@caotang/mcp-client';

import { attachCoherence } from './coherence-io.js';
import { folderFileDiff, type FolderDiffLine } from './folder-diff.js';
import { applyEncodingDecisions, encodingResultLines, type EncodingDecision } from './encoding-review.js';
import { changedDuringSave, pruneFolderBackups, watchSave } from './folder-guard.js';
import { folderArtifactFs, isSameFolder, type DirectoryHandleLike } from './fs-access.js';
import { requestInkCompilerFor } from './ink-compiler.js';
import {
  copiedFromOf,
  forgetFolder,
  rememberCopiedFrom,
  rememberFolder,
  rememberFolderCopy,
  rememberedFolder,
  rememberedFolderCopy,
  type RememberedFolderCopy,
} from './folder-memory.js';
import {
  folderOpenRoute,
  folderProjectRoute,
  folderSaveVerdict,
  keepBrowserDigests,
  MCP_LOCK_FILE,
  openNoticeLines,
  sampleToReuse,
  sentenceOf,
  type FolderDiffersAnswer,
  type FolderSaveVerdict,
} from './integrity-model.js';
import { sampleProjectState } from './demo.js';
import { dropHistoryOf } from './history-store.js';
import { SkillReviews, dropReviewsOf } from './skill-reviews.js';
import { dropTasksOf } from './task-store.js';
import { recoverPending, recoveryNotice } from './pending-journal.js';
import { copyState, shadowOf, type Shadow } from './persistence-plan.js';
import { acquireProjectLease, ProjectOpenElsewhereError, type ProjectLease } from './project-lease.js';
import { ProjectSession, type FolderBaseline, type SessionCoherence } from './session.js';
import { ProjectAssets, coverFileHeld, folderPictures, forgetBrowserAssets } from './project-assets.js';

/**
 * What the settings say a session starts with: the autosave debounce and the checkpoint limits (ui-modules §5.1). The app
 * sets it at start-up and after a change; a session reads it when it is made, so a change applies to the projects opened
 * after it. The defaults are the spec's, so a session made before any setting exists behaves as it did.
 */
export interface SessionDefaults {
  readonly debounceMs?: number;
  readonly retention?: RetentionConfig;
  /** The app's MCP client, so the agent's `tool.search` and `mcp.invoke` reach the servers the writer connected (extensibility §5). */
  readonly mcp?: { readonly client: McpClient };
  /** What the agent's coherence tools read from the app: the checks the writer has on, and the review's model (coherence.md §7). */
  readonly coherence?: SessionCoherence;
}

let defaults: SessionDefaults = {};

/** Replaces the session defaults. Called by the app, never by a test that builds a session directly. */
export function setSessionDefaults(next: SessionDefaults): void {
  defaults = next;
}

/** The project's lease, or the refusal: another tab has the project open. */
async function leaseFor(projectId: string): Promise<ProjectLease> {
  const lease = await acquireProjectLease(projectId);
  if (lease === null) throw new ProjectOpenElsewhereError(projectId);
  // The lease is recorded as this page's until it is given back, so the projects list does not take a project this page is still closing
  // for one another tab holds (`openElsewhere`).
  let given: () => void = () => undefined;
  const back = new Promise<void>((resolve) => {
    given = resolve;
  });
  heldHere.set(projectId, back);
  return {
    release() {
      lease.release();
      if (heldHere.get(projectId) === back) heldHere.delete(projectId);
      given();
    },
  };
}

/**
 * The project leases a session on this page holds, by project id: each resolves when its session gives the lease back. The shell leaves a
 * project at once and closes its session after (App `goHome`), so the projects list can be shown while that close still holds the lease.
 */
const heldHere = new Map<string, Promise<void>>();

/** How long a removal waits for this page's own session on the project to close (`removeProject`). */
const OWN_CLOSE_WAIT_MS = 10_000;

/**
 * The binary assets of each project this page has opened, made or imported, by project id (project-assets.ts). A session
 * takes its project's store from here, so a project closed and opened again in the same tab keeps its cover. The store
 * lives as long as the page: a reload clears it, which is why the project panel says what keeps a cover.
 */
const assetsByProject = new Map<string, ProjectAssets>();

function assetsFor(projectId: string): ProjectAssets {
  let assets = assetsByProject.get(projectId);
  if (assets === undefined) {
    assets = new ProjectAssets();
    // Bound where the store is made, so a project read from the projects list, with no session, reads its pictures from the browser's copy.
    void assets.persistFor(projectId);
    assetsByProject.set(projectId, assets);
  }
  return assets;
}

/**
 * Constructs a session with the current defaults, and loads its coherence file before it is returned, so the findings tab
 * and the scene declarations read the file from their first render. Every session the lifecycle opens goes through here, and
 * it holds the project's lease from the moment it is made until it closes. A session that fails to start gives the lease back.
 */
async function sessionFor(
  store: RuntimeStore,
  state: ProjectState,
  shadow: Shadow | null,
  lease: ProjectLease,
  folder: DirectoryHandleLike | null = null,
): Promise<ProjectSession> {
  let session: ProjectSession;
  try {
    session = new ProjectSession({
      store,
      projectId: state.manifest.project.id,
      state,
      shadow,
      // The writer's reviews of this project's skills are kept in the app database, and never in the project (skill-reviews.ts).
      skillReviews: await SkillReviews.open(state.manifest.project.id),
      assets: assetsFor(state.manifest.project.id),
      // The agent's image check reads the project's images at each call (storyboard.md §4).
      presentAssets: () => assetsFor(state.manifest.project.id).presentIds(),
      ...(defaults.mcp === undefined ? {} : { mcp: defaults.mcp }),
      ...(defaults.coherence === undefined ? {} : { coherence: defaults.coherence }),
      ...(defaults.debounceMs === undefined ? {} : { debounceMs: defaults.debounceMs }),
      ...(defaults.retention === undefined ? {} : { retention: defaults.retention }),
      onClosed: () => lease.release(),
    });
    await attachCoherence(session, store, folder);
    // The dialogue checks compile Ink synchronously, so a project with a dialogue container opens once the compiler has loaded (ink-compiler.ts).
    // A failed load does not stop the open: the dialogue views say so and offer Try again.
    await requestInkCompilerFor(state);
    // Words the last page held when it went away are put back (or offered) before the editor mounts (pending-journal.ts).
    session.setReloadNotice(recoveryNotice(await recoverPending(session)));
    // The undo kept for a document this project no longer has goes (history-store.ts).
    void dropHistoryOf(state.manifest.project.id, new Set(state.documents.keys()));
  } catch (error) {
    lease.release();
    throw error;
  }
  // The writer has a copy of what was just opened or made, so the export check measures changes from here.
  session.markExported();
  return session;
}

/** The coherence file as the bundle carries it: the session's copy, serialised as the module saves it, or none when there is none. */
function coherenceTextOf(session: ProjectSession): string | undefined {
  const file = session.coherenceFile();
  return file === undefined ? undefined : serializeCoherenceFile(file as CoherenceFile);
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly documents: number;
  readonly words: number;
}

export interface Opened {
  readonly session: ProjectSession;
  /** Things the load noticed, each a sentence for a person: the identity made at open, a migration, a value the load changed, an orphan. */
  readonly notices: readonly string[];
  /**
   * The fields the file carries that Caotang keeps in memory but does not use, by name (project-format §6). The next save drops them, so the
   * open says so, and says nothing else is dropped.
   */
  readonly droppedFields: readonly string[];
  /** Set when an import or folder open took a fresh id because the original was already here. */
  readonly copiedFrom: string | null;
  /**
   * Set when the writer chose to keep this browser's version of a folder's project (`answerFolderDiffers`): the workspace saves the project to
   * this folder as it opens, through the folder save and its questions.
   */
  readonly saveToFolder?: DirectoryHandleLike;
}

/**
 * A folder or bundle that Caotang can recover but not open as it is. It is read and described, and nothing is written until the
 * writer accepts it (`completeRecovery`). A rebuild loses structure, so its offer says so and needs an explicit yes.
 */
export interface PendingRecovery {
  /** The folder's name, or the bundle's file name, as the dialog names it. */
  readonly name: string;
  /** What the ladder found, and which copy it would open (project-format §5). */
  readonly offer: RecoveryOffer;
  /** The folder, or the unpacked bundle, the recovery reads and, once accepted, writes. */
  readonly fs: ArtifactFs;
  /** The bundle's session log, carried into the working copy. */
  readonly sessions: readonly SessionRecord[];
  /** The folder, when the project is one: its exports are kept there, and its copy is what the recovery replaces. */
  readonly folder: DirectoryHandleLike | null;
  /**
   * The digest of each document and codex file the folder held when the offer was read (folder-digests.ts). Accepting the offer checks the
   * folder against these before it writes, so a file another program changed since is named, not replaced. Empty for a bundle.
   */
  readonly digests: ReadonlyMap<string, string>;
}

/**
 * An open that found files whose bytes are not UTF-8 text (`LoadResult.encodingIssues`), held until
 * the writer answers for each one (`completeEncodingReview`): preview and convert it, or leave it
 * byte-for-byte. Nothing has been written for the files when the pending is handed out — except the
 * recovery write a `recovery` resume already committed, which `cancelNote` then says.
 *
 * The pending carries the filesystem the files live on — the folder's own, the unpacked bundle in
 * memory, or the recovery's target — so the dialog's previews read it and a convert writes back into
 * it before the project is adopted.
 */
export interface PendingEncoding {
  /** What the open is called: the folder's name, or the bundle's file name. */
  readonly name: string;
  /** Each file the load reported, with the guess its bytes gave. */
  readonly issues: readonly EncodingIssue[];
  /** Where the files live and a conversion writes: the folder, the unpacked bundle, or the recovered target. */
  readonly fs: ArtifactFs;
  /** How the open continues once the writer has answered. */
  readonly resume: EncodingResume;
  /** What cancelling should tell the writer happened already: a recovery's write, or '' when nothing ran. */
  readonly cancelNote: string;
}

/** What `completeEncodingReview` needs to continue the open the writer paused. */
export type EncodingResume =
  /** A folder open: routing, baseline and session are all decided after the answers, from a fresh read. */
  | { readonly kind: 'folder'; readonly root: DirectoryHandleLike }
  /** A bundle import: the unpacked bundle's sessions, images and findings file, carried into the adopt. */
  | {
      readonly kind: 'bundle';
      readonly sessions: readonly SessionRecord[];
      readonly assets: Readonly<Record<string, Uint8Array>>;
      readonly coherence: string | undefined;
    }
  /** An accepted recovery: the write already ran, so the answers are applied and the result adopted. */
  | { readonly kind: 'recovery'; readonly sessions: readonly SessionRecord[]; readonly folder: DirectoryHandleLike | null };

/** What opening a folder or a bundle gives back: the project, open, or a recovery the writer must accept first. */
export type OpenOutcome =
  | { readonly kind: 'opened'; readonly opened: Opened }
  | { readonly kind: 'recover'; readonly recovery: PendingRecovery }
  /** A folder or bundle holding files that are not UTF-8 text: the writer answers for each before the open finishes. */
  | { readonly kind: 'encoding'; readonly encoding: PendingEncoding }
  /** A folder whose project this browser keeps in a different version: the writer chooses which to keep (`answerFolderDiffers`). */
  | { readonly kind: 'differs'; readonly differs: FolderDiffers };

/** What the projects screen suggests after a project was left with changes since the writer last had a copy (project-format §8). */
export interface LeaveSuggestion {
  readonly projectId: string;
  readonly name: string;
}

/** The suggestion waiting for the projects screen to show it once. */
let leaveSuggestion: LeaveSuggestion | null = null;

/** Keeps a suggestion for the projects screen, which the shell leaves for when it leaves a project with unexported changes. */
export function noteLeaveSuggestion(suggestion: LeaveSuggestion): void {
  leaveSuggestion = suggestion;
}

/** The waiting suggestion, if there is one, without taking it. A render reads it this way, so it can run twice under StrictMode. */
export function peekLeaveSuggestion(): LeaveSuggestion | null {
  return leaveSuggestion;
}

/** Takes the waiting suggestion, if there is one: the projects screen shows it once. */
export function takeLeaveSuggestion(): LeaveSuggestion | null {
  const next = leaveSuggestion;
  leaveSuggestion = null;
  return next;
}

export async function listProjects(store: RuntimeStore): Promise<ProjectSummary[]> {
  const ids = await listProjectIds(store);
  const summaries: ProjectSummary[] = [];
  for (const id of ids) {
    const state = await readProjectState(store, id);
    summaries.push({
      id,
      name: state.manifest.project.name,
      documents: state.manifest.tree.filter((node) => node.type === 'document').length,
      words: Object.values(state.manifest.derived.wordCounts).reduce((sum, count) => sum + count, 0),
    });
  }
  return summaries.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** A new project: the three fixed roots and nothing else (ui-modules §2.4 — the empty state carries the next step). */
export async function createProject(store: RuntimeStore, name: string): Promise<ProjectSession> {
  const title = name.trim() === '' ? 'Untitled project' : name.trim();
  const state = createProjectState(createEmptyManifest(title));
  const session = await sessionFor(store, state, null, await leaseFor(state.manifest.project.id));
  await session.settle();
  return session;
}

/**
 * The sample manuscript the first-run card opens (demo.ts). It is a new project each time, so a demo run always starts from
 * the sample's own text, and its id is returned so the settings can say which projects are samples.
 */
export async function createSampleProject(store: RuntimeStore): Promise<ProjectSession> {
  const state = sampleProjectState();
  const session = await sessionFor(store, state, null, await leaseFor(state.manifest.project.id));
  await session.settle();
  return session;
}

/**
 * The sample a demo run works on: the writer's existing sample when it is still in this browser, so each demo click does not
 * make another copy, or a new one when there is none. `created` says which, so the caller records a new sample id only then.
 */
export async function openOrCreateSample(
  store: RuntimeStore,
  knownSampleIds: readonly string[],
): Promise<{ readonly session: ProjectSession; readonly created: boolean }> {
  const reuse = sampleToReuse(knownSampleIds, await listProjectIds(store));
  if (reuse !== null) return { session: await openProject(store, reuse), created: false };
  return { session: await createSampleProject(store), created: true };
}

/**
 * An existing project from the runtime store. Its shadow is the state it was just read from. The session is settled before it is
 * handed back, which runs the image check (storyboard.md §2.2): a reference to a file the project does not hold is dropped, and
 * named by `imageDropNotice`, when the project opens and not when the storyboard does.
 */
export async function openProject(store: RuntimeStore, projectId: string): Promise<ProjectSession> {
  // The lease comes first: the state is read only once no other tab can write it, so the shadow is never behind a write.
  const lease = await leaseFor(projectId);
  let state: ProjectState;
  try {
    state = await readProjectState(store, projectId);
  } catch (error) {
    lease.release();
    throw error;
  }
  const session = await sessionFor(store, state, shadowOf(state), lease);
  // A session that fails to settle is closed, which gives the lease back: no caller holds it.
  try {
    await session.settle();
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
  return session;
}

/** The open's sentence for image references the check dropped (`ProjectSession.imageNotices`), or none. The storyboard names them. */
export function imageDropNotice(session: ProjectSession): string[] {
  const dropped = session.imageNotices().length;
  if (dropped === 0) return [];
  return [
    dropped === 1
      ? 'A shot lost its picture because the file is not in the project. The storyboard names it.'
      : `${dropped} shots lost their pictures because the files are not in the project. The storyboard names them.`,
  ];
}

/**
 * Removes a project from this browser. The removal takes the project's lease, as an open does, so a project another tab has open is
 * not deleted under that tab: the removal is refused with the reason. The lease is given back once the project is gone.
 */
export async function removeProject(store: RuntimeStore, projectId: string): Promise<void> {
  // A session on this page that still holds the project is closing (`heldHere`): the removal waits for it, rather than calling it another tab.
  // The wait is bounded, so a close that never ends refuses the removal instead of leaving it waiting.
  const closing = heldHere.get(projectId);
  if (closing !== undefined) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closing, new Promise((resolve) => (timer = setTimeout(resolve, OWN_CLOSE_WAIT_MS)))]);
    clearTimeout(timer);
  }
  const lease = await acquireProjectLease(projectId);
  if (lease === null) throw new ProjectOpenElsewhereError(projectId);
  try {
    await deleteProject(store, projectId);
    // The project's images go with it, from this page and from the browser's asset store: a project made again later is a new
    // one, and must not inherit a removed cover or a shot's picture.
    assetsByProject.delete(projectId);
    await forgetBrowserAssets(projectId);
    // The folder the project remembered goes too: the list no longer has a project to reopen it for (folder-memory.ts).
    await forgetFolder(projectId);
    // The writer's reviews of its skills go too (skill-reviews.ts).
    await dropReviewsOf(projectId);
    // So do its background tasks, which hold text drawn from it (task-store.ts).
    await dropTasksOf(projectId);
  } finally {
    lease.release();
  }
}

/**
 * Whether another tab holds the project open, so that it cannot be removed from here. The list asks before it offers Remove, so it
 * can say why instead of offering a removal that would be refused. The lease is taken for a moment and given back. A lease this page
 * holds is not another tab's: the list is shown only once the workspace has left its project, so a session that holds one is closing.
 */
export async function openElsewhere(projectId: string): Promise<boolean> {
  if (heldHere.has(projectId)) return false;
  const lease = await acquireProjectLease(projectId);
  if (lease === null) return true;
  lease.release();
  return false;
}

export interface ExportedBundle {
  readonly bytes: Uint8Array;
  readonly filename: string;
  /** Things the writer should know about this copy, phrased for a person (a cover the page does not hold). */
  readonly notices: readonly string[];
  /**
   * The notices about the files whose text this copy does not carry, apart from the other notices.
   *
   * They are kept apart because they are what an adopt failure has to report: a file the copy left out
   * is a file the restored copy lacks, and a file the copy holds as an empty shell is one the restored
   * copy holds empty — either way the text is not in the copy — while a notice about the cover says
   * nothing about the files.
   */
  readonly omissions: readonly string[];
}

/**
 * The project as a zip bundle (project-format §7). Saves everything first, so the bundle
 * is the state the user sees and not the state a few hundred milliseconds ago. Making one is also the
 * writer's copy, so the export check measures changes from it.
 */
export async function exportBundle(store: RuntimeStore, session: ProjectSession): Promise<ExportedBundle> {
  await session.settle();
  const sessions = await readSessions(store, session.projectId);
  const bundle = await bundleOf(session.state, sessions, session.assets, coherenceTextOf(session));
  session.markExported();
  return bundle;
}

/**
 * The bundle of a project that is not open. The stored state is read, not an open
 * session's, so this works from the project list without opening the project.
 *
 * `copyFor` decides what the export does with a file this load declined because
 * its bytes are not UTF-8 (the store's `WriteOptions.copyFor`). The default is
 * a `user` copy, which refuses: a bundle the writer takes home has to carry the
 * whole project. The `use-folder` flow passes `internal`, because the bundle it
 * makes is the app's own safety net — a copy that refused would make adopting
 * the folder's version impossible for exactly the project that needs it most.
 */
export async function exportStoredBundle(
  store: RuntimeStore,
  projectId: string,
  copyFor: 'user' | 'internal' = 'user',
): Promise<ExportedBundle> {
  const state = await readProjectState(store, projectId);
  const sessions = await readSessions(store, projectId);
  const coherence = (await readCoherenceFiles(store, projectId))[COHERENCE_FILE];
  const assets = assetsFor(projectId);
  // The browser's copy is listed before the bundle reads the pictures, so a reloaded page's pictures are in the bundle.
  await assets.ready();
  return bundleOf(state, sessions, assets, coherence, copyFor);
}

/**
 * The bundle of a state, its session log and its images (zip.ts carries `assets/` byte-for-byte). A cover that neither the browser's
 * copy nor an attached folder holds is bundled without its image, and the copy says so: one missing picture is not a reason to refuse
 * a whole backup.
 *
 * `copyFor` says who the bundle is for (zip.ts `ExportZipOptions.copyFor`): the writer's own copy
 * refuses a file it cannot hold, and the app's own copy leaves that file out and says so.
 */
async function bundleOf(
  state: ProjectState,
  sessions: readonly SessionRecord[],
  assets: ProjectAssets,
  coherence: string | undefined,
  copyFor: 'user' | 'internal' = 'user',
): Promise<ExportedBundle> {
  const notices: string[] = [];
  const omissions: string[] = [];
  const cover = state.manifest.project.coverAssetId;
  if (cover && !(await coverFileHeld(assets, cover))) {
    notices.push(
      'the cover image is not available in this browser, so the bundle has no cover. A project kept in a folder has its cover there: open that folder, or choose the cover again in the project panel',
    );
  }
  // The findings file rides beside caotang.json (coherence.md §3), and the images in assets/.
  const exported = await exportProjectZip(state, {
    sessions,
    assets: await assets.snapshot(),
    ...(coherence === undefined ? {} : { coherence }),
    copyFor,
  });
  // A file the load declined because its bytes are not UTF-8 has no text to carry, and the copy says what
  // it does with it rather than losing it silently. The writer's own copy refuses rather than getting here
  // (write.ts `WriteOptions.copyFor`).
  //
  // The two kinds are told apart, because they are not the same thing: a codex file the copy cannot carry
  // is left out of it altogether, while a document the load held is written as the empty body the browser's
  // own copy shows — the copy holds that file, and it holds it empty. Saying "leaves it out" of a file the
  // copy holds would be a lie, and it would hide the hazard: a save of that copy writes the empty text over
  // the author's file.
  for (const path of exported.omitted) {
    omissions.push(`“${path}” is not UTF-8 text, so this copy leaves it out; the file it was opened from still holds its text`);
  }
  for (const path of exported.emptied) {
    omissions.push(
      `“${path}” is not UTF-8 text, so this copy holds an empty file in its place instead of its text; the file it was opened from still holds its text, and a save of this copy over it would write that empty text over it`,
    );
  }
  notices.push(...omissions);
  return { bytes: exported.bytes, filename: exported.filename, notices, omissions };
}

/**
 * Put a loaded state into the runtime store as a working copy and open it. The state
 * is written in full on the first pass (its shadow is `null`), and the session log the
 * bundle carried is appended line by line, so history survives the import.
 */
async function adopt(
  store: RuntimeStore,
  state: ProjectState,
  sessions: readonly SessionRecord[],
  notices: readonly string[],
  droppedFields: readonly string[],
  folder: DirectoryHandleLike | null = null,
  assets: Readonly<Record<string, Uint8Array>> = {},
  coherence?: string,
): Promise<Opened> {
  const originalId = state.manifest.project.id;
  const taken = new Set(await listProjectIds(store));
  let copiedFrom: string | null = null;
  if (taken.has(originalId)) {
    state.manifest.project.id = newId('p', { taken });
    copiedFrom = originalId;
  }
  // A bundle that carried a findings file gives the working copy its set before the session reads it, so the file the bundle
  // holds is the one the project opens with (coherence.md §3, §7).
  if (coherence !== undefined) {
    // The project row must exist before its set can be attached to it, so the state is written first; the session's own first
    // write then replaces the same row, and keeps the set (ProjectRow.coherenceFiles).
    await writeProjectState(store, state, { now: new Date() });
    await writeCoherenceFiles(store, state.manifest.project.id, { [COHERENCE_FILE]: coherence });
  }
  const session = await sessionFor(store, state, null, await leaseFor(state.manifest.project.id), folder);
  // A copy made with a fresh id remembers the project it was copied from, so it is never saved into that project's folder (`saveFolder`).
  if (copiedFrom !== null) session.setCopiedFrom(copiedFrom);
  // The session is not handed back until every step below has run. A step that fails leaves no caller holding it, so the session is
  // closed here, which gives the project's lease back; the step's own error is the one the caller sees.
  try {
    for (const record of sessions) {
      await appendSession(store, { projectId: session.projectId, record });
    }
    // A bundle's images go into the project's asset store before any folder is attached, so the attach writes them out too.
    await session.assets.loadAll(assets);
    // A project opened from a folder exports into that folder (exporter.md §2, stage 4). A folder whose compile
    // log cannot be read stays unattached, and the project still opens: the reason is a notice, not a refusal.
    const noticesOut = [...notices];
    if (folder !== null) {
      try {
        await session.attachFolder(folder);
      } catch (error) {
        noticesOut.push(exportsKeptHere(error));
      }
    }
    await session.settle();
    noticesOut.push(...imageDropNotice(session));
    if (copiedFrom !== null) await rememberCopiedFrom(session.projectId, copiedFrom);
    return { session, notices: noticesOut, droppedFields: [...droppedFields], copiedFrom };
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
}

/** The folder's `caotang.json` text, or `null` when the folder has none. */
async function readManifestText(fs: ArtifactFs): Promise<string | null> {
  return (await fs.exists(MANIFEST_FILE)) ? fs.read(MANIFEST_FILE) : null;
}

/**
 * The ids of the body nodes a state's tree names, in tree order: a document or a dialogue container, each of which has a body file
 * in `docs/` (project-format §3). A folder copy holds these, so a container deleted from the tree is a deletion the save removes.
 */
function documentIdsOf(state: ProjectState): string[] {
  return state.manifest.tree.filter((node) => isBodyType(node.type)).map((node) => node.id);
}

/**
 * Records the folder copy a session holds: the folder's manifest text, the document ids the copy names, and the digests of the folder's
 * document and codex files with the titles they had (`ProjectSession.setFolderBaseline`, `FolderBaseline`). Every place that takes a
 * folder copy goes through here, so the copy is one record on the session and `saveFolder` checks the folder against it.
 */
function holdFolderCopy(
  session: ProjectSession,
  folder: DirectoryHandleLike,
  manifestText: string,
  digests: ReadonlyMap<string, string>,
): void {
  session.setFolderBaseline(folder, manifestText, documentIdsOf(session.state), digests, projectFileTitles(session.state));
}

/**
 * Keeps the folder copy the session now holds in the app database, beside the remembered folder (folder-memory.ts `rememberFolderCopy`), so
 * a save after a reload is checked against what the folder held when Caotang last opened it as this project's own or saved to it, rather
 * than asked about as a folder of unknown state. Called only where the copy is the folder's real state (an open as the project's own, a
 * save), never for a copy taken from this browser's version (`answerFolderDiffers` `keep-browser`).
 */
async function rememberHeldCopy(session: ProjectSession): Promise<void> {
  const copy = session.folderBaseline();
  if (copy === null) return;
  await rememberFolderCopy(session.projectId, {
    folderName: copy.folder.name,
    manifestText: copy.manifestText,
    documentIds: [...copy.documentIds],
    digests: [...copy.digests],
    titles: [...copy.titles],
  });
}

/**
 * The folder copy kept for this project across a reload (`rememberHeldCopy`), as a baseline for `root`, or `null` when none is kept or it is
 * for another folder: the folder the project remembers must be `root` (`isSameEntry`), or, where no handle is remembered (a folder in the
 * origin's private file system), the kept copy must be of a folder with `root`'s name.
 */
async function rememberedCopyFor(projectId: string, root: DirectoryHandleLike): Promise<FolderBaseline | null> {
  const kept = await rememberedFolderCopy(projectId);
  if (kept === null) return null;
  const remembered = await rememberedFolder(projectId);
  if (remembered !== null ? !(await isSameFolder(remembered, root)) : kept.folderName !== root.name) return null;
  return {
    folder: root,
    manifestText: kept.manifestText,
    documentIds: [...kept.documentIds],
    digests: new Map(kept.digests),
    titles: new Map(kept.titles),
  };
}

/** The body nodes a folder copy named that the state no longer holds: the only files a save into that folder may remove. */
function deletedSince(copy: FolderBaseline, state: ProjectState): string[] {
  const present = new Set(documentIdsOf(state));
  return copy.documentIds.filter((id) => !present.has(id));
}

/**
 * The fields a load noticed that a save drops (`LoadNotice.droppedField`), by name, in the order the file names them. The open says these
 * and nothing else is dropped, so no other notice is counted as one.
 */
function droppedFieldsOf(notices: readonly LoadNotice[]): string[] {
  return notices.flatMap((notice) => (notice.droppedField === undefined ? [] : [notice.droppedField]));
}

/** The open's sentence for a folder its exports cannot be written to: they are kept in this browser, and the reason follows as a sentence. */
function exportsKeptHere(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `Exports are kept in this browser, not in the folder. ${sentenceOf(reason)}`;
}

/**
 * The notices a load raised that are not dropped fields, as the lines the writer reads: each one's own sentence (`LoadNotice.say`), and a
 * count of those that have none, whose messages name paths, ids or spec sections (`openNoticeLines`).
 */
function noticesOf(notices: readonly LoadNotice[]): string[] {
  return openNoticeLines(notices.filter((notice) => notice.droppedField === undefined));
}

/**
 * The session log a folder holds (project-format §4), or none when the folder has no `sessions.jsonl`. A line the parser cannot read is
 * counted by it and left out here, as a bundle's log is read (zip.ts), so one damaged line does not refuse the open.
 */
async function folderSessionsOf(fs: ArtifactFs): Promise<SessionRecord[]> {
  if (!(await fs.exists(SESSIONS_FILE))) return [];
  return parseSessionsLog(await fs.read(SESSIONS_FILE)).records;
}

/**
 * A session line as one string: two lines have the same key exactly when `sameSessionLine` says they are the same session (the same
 * start, end, word count and documents, in order).
 */
function sessionLineKey(line: SessionRecord): string {
  return JSON.stringify([line.startedAt, line.endedAt, line.wordsWritten, line.docIds]);
}

/**
 * The lines of `lines` that `held` does not hold, in the order of `lines`. Two lines are the same session when `sameSessionLine` says so, and
 * each held line answers for one line only, so a session that appears twice in `lines` is missing only when `held` holds it fewer times.
 * The held lines are counted by key, so the check is linear in the two logs: it runs at every folder open and save, and a log grows with
 * the writer's history.
 */
function linesNotHeld(lines: readonly SessionRecord[], held: readonly SessionRecord[]): SessionRecord[] {
  const unanswered = new Map<string, number>();
  for (const line of held) {
    const key = sessionLineKey(line);
    unanswered.set(key, (unanswered.get(key) ?? 0) + 1);
  }
  const missing: SessionRecord[] = [];
  for (const line of lines) {
    const key = sessionLineKey(line);
    const left = unanswered.get(key) ?? 0;
    if (left === 0) missing.push(line);
    else unanswered.set(key, left - 1);
  }
  return missing;
}

/**
 * Brings a stored project's session log up to a folder's: every line of the folder's log that the store does not hold is appended to the
 * store, so the save that follows can write the folder's history back. Nothing the store holds is changed or reordered. A log that differs
 * from the folder's is merged, not refused (project-format §4).
 */
async function carryFolderSessions(store: RuntimeStore, projectId: string, folderLog: readonly SessionRecord[]): Promise<void> {
  const held = await readSessions(store, projectId);
  for (const record of linesNotHeld(folderLog, held)) {
    await appendSession(store, { projectId, record });
  }
}

/** A write report with nothing in it yet, for a write whose changes the caller records (`digestsAfterWrite`). */
function emptyReport(): WriteReport {
  return { written: [], rotated: [], dropped: [], pruned: [] };
}

/**
 * Whether two states hold the same book: the manifest as the writer serializes it, and the text of every document. The time a save stamps
 * on the manifest (`project.modifiedAt`) is left out: a folder save stamps it on the copy it writes and not on the project this browser
 * keeps, so after any save the two differ there and nowhere else.
 */
function sameBook(stored: ProjectState, folder: ProjectState): boolean {
  if (manifestTextOf(stored, folder.manifest.project.modifiedAt) !== manifestTextOf(folder, folder.manifest.project.modifiedAt)) return false;
  if (stored.documents.size !== folder.documents.size) return false;
  for (const [id, record] of stored.documents) {
    if (folder.documents.get(id)?.body !== record.body) return false;
  }
  return true;
}

/**
 * A state's manifest as the writer serializes it, with `modifiedAt` set to `stamp`, so two manifests compare without the save's stamp. Two
 * things are left out, because they are not the book: `derived` is a cache that a load which finds it empty rebuilds with a new stamp
 * (read.ts), so a folder's copy never carries the stored copy's; and the serializer keeps each node's keys in the order the object was made
 * in, which a project made in this browser and the same project read from its folder do not share, so the keys are sorted.
 */
function manifestTextOf(state: ProjectState, stamp: string): string {
  const manifest = { ...state.manifest, project: { ...state.manifest.project, modifiedAt: stamp } };
  const parsed = JSON.parse(serializeManifest(manifest, PRODUCTION_FORMAT)) as Record<string, unknown>;
  delete parsed.derived;
  return sortedJson(parsed);
}

/** JSON with every object's keys sorted, at every depth, so a value compares the same whatever order its keys were written in. */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

/**
 * Opens a project this browser already keeps, as the folder's own session: the stored state, the folder attached for its exports and
 * findings, and the pictures the folder holds. A project another tab holds is refused with `ProjectOpenElsewhereError`, as the projects list
 * refuses it: the folder is not opened again as a second copy of a book that tab already has open.
 */
async function openStored(
  store: RuntimeStore,
  projectId: string,
  folder: DirectoryHandleLike,
  load: { readonly notices: readonly string[]; readonly droppedFields: readonly string[]; readonly folderLog: readonly SessionRecord[] },
  assets: Readonly<Record<string, Uint8Array>>,
): Promise<Opened> {
  // The lease comes first, as an open takes it. A refusal propagates to the writer: the folder is not opened as a copy of a project another
  // tab has open.
  const lease = await leaseFor(projectId);
  let state: ProjectState;
  try {
    state = await readProjectState(store, projectId);
  } catch (error) {
    lease.release();
    throw error;
  }
  const session = await sessionFor(store, state, shadowOf(state), lease, folder);
  try {
    // Every line of the folder's log the store does not hold is carried into the store, so the save can write the folder's whole history back.
    await carryFolderSessions(store, projectId, load.folderLog);
    await session.assets.loadAll(assets);
    const noticesOut = [...load.notices];
    try {
      await session.attachFolder(folder);
    } catch (error) {
      noticesOut.push(exportsKeptHere(error));
    }
    await session.settle();
    noticesOut.push(...imageDropNotice(session));
    return { session, notices: noticesOut, droppedFields: [...load.droppedFields], copiedFrom: null };
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
}

/**
 * The project id a folder's `caotang.json` names, or `undefined` when the text names none (a manifest this check cannot read is not an
 * identity to protect, and the verdict in `saveFolder` deals with it).
 */
function projectIdOf(manifestText: string): string | undefined {
  try {
    const id = (JSON.parse(manifestText) as { project?: { id?: unknown } } | null)?.project?.id;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The errors that mean "this caotang.json will not load", where the §5 ladder applies: one that will not parse, or one whose fields fail the
 * schema. A manifest this build refuses outright (another app, a newer format: `ProjectRefusedError`) is not one of them, and is refused.
 */
function isUnreadableManifest(error: unknown): boolean {
  if (error instanceof ProjectRefusedError) return false;
  return error instanceof ManifestUnreadableError || error instanceof ProjectValidationError;
}

/** The ladder's offer for a folder or bundle, or the plain reason it has none. Read only: nothing is written here. */
async function recoveryFor(
  name: string,
  fs: ArtifactFs,
  sessions: readonly SessionRecord[],
  folder: DirectoryHandleLike | null,
  digests: ReadonlyMap<string, string>,
): Promise<PendingRecovery> {
  const found = await recoverProject(fs);
  if (found.status === 'unrecoverable') {
    throw new Error(
      'Caotang could not find a readable copy of this project. caotang.json cannot be read, and there is no backup or document file to rebuild it from.',
    );
  }
  return { name, offer: found.offer, fs, sessions, folder, digests };
}

/**
 * Import a `.caotang` bundle as a fresh working copy. A bundle whose `caotang.json` will not load is offered its recovery
 * (`recover`), and is opened only when the writer accepts it (`completeRecovery`).
 */
export async function importBundle(store: RuntimeStore, bytes: Uint8Array, name: string): Promise<OpenOutcome> {
  const unpacked = await importProjectZip(bytes);
  let loaded: LoadResult;
  try {
    loaded = await readProject(unpacked.fs);
  } catch (error) {
    if (!isUnreadableManifest(error)) throw error;
    return { kind: 'recover', recovery: await recoveryFor(name, unpacked.fs, unpacked.sessions, null, new Map()) };
  }
  const coherence = (await unpacked.fs.exists(COHERENCE_FILE)) ? await unpacked.fs.read(COHERENCE_FILE) : undefined;
  // A bundle's non-UTF-8 files pause the import the same way a folder's do: the answers are applied to the
  // unpacked copy in memory, before the project is adopted — so the working copy is made from the converted text.
  if (loaded.encodingIssues.length > 0) {
    return {
      kind: 'encoding',
      encoding: {
        name,
        issues: loaded.encodingIssues,
        fs: unpacked.fs,
        resume: { kind: 'bundle', sessions: unpacked.sessions, assets: unpacked.assets, coherence },
        cancelNote: '',
      },
    };
  }
  return {
    kind: 'opened',
    opened: await adopt(
      store,
      loaded.state,
      unpacked.sessions,
      noticesOf(loaded.notices),
      droppedFieldsOf(loaded.notices),
      null,
      unpacked.assets,
      coherence,
    ),
  };
}

/**
 * Open a project folder through the File System Access API, as a working copy in the runtime store. The folder's `caotang.json`
 * text is kept as the baseline a later save is checked against. A folder whose manifest will not load is offered its recovery.
 */
export async function openFolder(store: RuntimeStore, root: DirectoryHandleLike): Promise<OpenOutcome> {
  const fs = folderArtifactFs(root);
  const onDisk = await readManifestText(fs);
  // The folder's document and codex files are digested before anything is read, so a change made while the project is read is one the
  // first save sees, not one this session is taken to have loaded.
  const digests = await projectFileDigests(fs);
  let loaded: LoadResult;
  try {
    loaded = await readProject(fs);
  } catch (error) {
    if (!isUnreadableManifest(error)) throw error;
    return { kind: 'recover', recovery: await recoveryFor(root.name, fs, await folderSessionsOf(fs), root, digests) };
  }
  // Files whose bytes are not UTF-8 pause the open for the writer's answer before any routing: a convert changes the bytes a
  // baseline and a book are measured on, so it is asked about first (`completeEncodingReview` finishes the open after).
  if (loaded.encodingIssues.length > 0) {
    return {
      kind: 'encoding',
      encoding: { name: root.name, issues: loaded.encodingIssues, fs, resume: { kind: 'folder', root }, cancelNote: '' },
    };
  }
  return finishFolderOpen(store, root, fs, loaded, onDisk, digests, []);
}

/**
 * The rest of a folder open, once the folder's load is settled — called directly by `openFolder`, and by
 * `completeEncodingReview` after the writer's answers converted what they would. `extraNotices` says what the
 * pause did (each converted or refused file) ahead of the load's own notices; `onDisk` and `digests` are read
 * fresh after any conversion, so the baseline the session holds is the folder as it stands.
 */
async function finishFolderOpen(
  store: RuntimeStore,
  root: DirectoryHandleLike,
  fs: ArtifactFs,
  loaded: LoadResult,
  onDisk: string | null,
  digests: ReadonlyMap<string, string>,
  extraNotices: readonly string[],
): Promise<OpenOutcome> {
  // An identity the open made (epub-metadata.md: the identifier, the language) is written back to the folder before the
  // session starts, so the next open reads the same values and the book keeps its identifier. The project opens even when
  // that write is skipped or fails; the reason is a notice, because the next open would then make another identifier. A
  // folder another program holds (the MCP server's lock) is not written to here: the writer has not been asked.
  const notices = [...extraNotices, ...noticesOf(loaded.notices)];
  const droppedFields = droppedFieldsOf(loaded.notices);
  // The folder's session log (project-format §4) is the history a copy opened from it starts with (adopt), or the one a stored copy carries on.
  const folderLog = await folderSessionsOf(fs);
  let baselineText = onDisk ?? '';
  if (loaded.notices.some((notice) => (BACKFILLABLE_FIELDS as readonly string[]).includes(notice.path))) {
    if (await fs.exists(MCP_LOCK_FILE)) {
      notices.push('The details Caotang made for this project as it opened were not saved to the folder, because another program, such as the Caotang MCP server, may be using it. The next open may make another set.');
    } else {
      const report = emptyReport();
      try {
        // A backfill is not a save of the writer's deletions, so it removes no file from the folder: an empty list says so. Each file
        // is checked against the digest taken above, as a save checks it.
        await writeProject(fs, copyState(loaded.state), { now: new Date(), pruneDocumentIds: [], expectedDigests: digests, report });
        baselineText = (await readManifestText(fs)) ?? '';
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        notices.push(`The details Caotang made for this project as it opened could not be saved to the folder, so the next open may make another set. ${sentenceOf(reason)}`);
      }
      digests = await digestsAfterWrite(fs, digests, report);
    }
  }
  // A project this browser keeps that is the same book as the folder opens as the folder's own session. Otherwise the folder opens
  // as a copy, which cannot be saved back into the folder. The folder's pictures go into the browser's copy as the project opens, so a
  // later open from the list (no folder) reads them too.
  const pictures = await folderPictures(root);
  const projectId = loaded.state.manifest.project.id;
  const stored = (await listProjectIds(store)).includes(projectId) ? await readProjectState(store, projectId) : null;
  const route = folderOpenRoute({ storedHasId: stored !== null, sameBook: stored !== null && sameBook(stored, loaded.state) });
  // A stored copy that differs from the folder is not copied without a word: the writer is asked which version to keep (answerFolderDiffers).
  if (route === 'ask' && stored !== null) {
    return {
      kind: 'differs',
      differs: {
        projectId,
        projectName: stored.manifest.project.name,
        folderName: root.name,
        root,
        state: loaded.state,
        folderLog,
        notices,
        droppedFields,
        pictures,
        baselineText,
        digests,
      },
    };
  }
  // A stored copy of this book opens as the folder's own session, and another tab's hold on it refuses the open (openStored).
  const opened =
    route === 'own'
      ? await openStored(store, projectId, root, { notices, droppedFields, folderLog }, pictures)
      : await adopt(store, loaded.state, folderLog, notices, droppedFields, root, pictures);
  holdFolderCopy(opened.session, root, baselineText, digests);
  await rememberFolder(opened.session.projectId, root);
  await rememberHeldCopy(opened.session);
  return { kind: 'opened', opened };
}

/**
 * A folder whose project this browser keeps, in a version that differs from the folder's (`FolderOpenRoute` `ask`): everything the open
 * read, held until the writer answers, so the answer opens the project without reading the folder again. Nothing has been written for it.
 */
export interface FolderDiffers {
  readonly projectId: string;
  /** The project's name as this browser keeps it. */
  readonly projectName: string;
  readonly folderName: string;
  readonly root: DirectoryHandleLike;
  /** The folder's version of the project, as the open read it. */
  readonly state: ProjectState;
  readonly folderLog: readonly SessionRecord[];
  readonly notices: readonly string[];
  readonly droppedFields: readonly string[];
  readonly pictures: Readonly<Record<string, Uint8Array>>;
  /** The folder's `caotang.json` text and the digests of its files, as the open read them: the baseline a later save is checked against. */
  readonly baselineText: string;
  readonly digests: ReadonlyMap<string, string>;
}

/**
 * Opens a folder whose version differs from this browser's, the way the writer chose (`FolderDiffersAnswer`):
 * - `use-folder`: this browser's copy is removed and the folder's version takes its place, under the same id, with the writing history of
 *   both (each session line once). The folder is then the project's own, and later saves go back to it.
 * - `keep-browser`: this browser's copy opens with the folder attached, and `saveToFolder` asks the workspace to save it there. The save is
 *   checked against the folder as it stands, with this browser's version of each file it holds (`keepBrowserDigests`), so a document the
 *   save would write over is named in the changed-documents question first, and nothing is written until the writer answers.
 * - `separate-copy`: the folder opens as a second project with its own id, as it did before the question existed (adopt).
 */
export async function answerFolderDiffers(store: RuntimeStore, differs: FolderDiffers, answer: FolderDiffersAnswer): Promise<Opened> {
  const { root } = differs;
  if (answer === 'separate-copy') {
    const opened = await adopt(store, differs.state, differs.folderLog, differs.notices, differs.droppedFields, root, differs.pictures);
    holdFolderCopy(opened.session, root, differs.baselineText, differs.digests);
    return opened;
  }
  if (answer === 'use-folder') {
    const storedLog = await readSessions(store, differs.projectId);
    // This browser's copy is held in memory as a bundle before it is removed (its state, session log, pictures and findings), so an adopt
    // that fails puts it back rather than leaving the writer with neither version in this browser. The bundle is the app's own safety
    // net, not a copy the writer takes home, so it is made as an internal copy: a file this load declined because its bytes are not
    // UTF-8 has no text to carry, and an internal copy omits it and names it in its notices rather than refusing — a refusal here would
    // make 'use-folder' impossible for exactly the projects that hold such a file.
    const kept = await exportStoredBundle(store, differs.projectId, 'internal');
    // The files this load declined are held beside the bundle, because their record lives on the state and not in `caotang.json`: a
    // file whose bytes are not UTF-8 has no text to write, so the internal copy writes an empty document in place of a held one and
    // leaves a held codex file out, and the record of both is lost. Without them the copy that is put back would write that empty
    // document over the author's file, and the next save to the folder would prune the codex file it does not own.
    const keptHeld = await heldFilesOf(store, differs.projectId);
    // So are the records folder-memory.ts keeps for it (its folder, the folder copy last seen there, and the project it was copied from), which
    // the removal forgets.
    const keptRecords: KeptFolderRecords = {
      folder: await rememberedFolder(differs.projectId),
      folderCopy: await rememberedFolderCopy(differs.projectId),
      copiedFrom: await copiedFromOf(differs.projectId),
    };
    // The removal takes the project's lease, so a copy another tab has open is refused here, before anything changes.
    await removeProject(store, differs.projectId);
    const log = [...differs.folderLog, ...linesNotHeld(storedLog, differs.folderLog)];
    let opened: Opened;
    try {
      opened = await adopt(store, differs.state, log, differs.notices, differs.droppedFields, root, differs.pictures);
    } catch (error) {
      // The copy is put back, and the put-back is best-effort: a failure of it must not hide why the adopt failed.
      // The writer is told both reasons — the adopt's own, and the put-back's if that failed too — and the adopt's
      // error is the cause, so nothing about it is lost.
      const restoreFailure = await restoreBrowserCopy(store, differs.projectId, kept.bytes, keptRecords, keptHeld);
      const adoptReason = error instanceof Error ? error.message : String(error);
      if (restoreFailure !== null) {
        throw new Error(
          `The folder's version could not be opened (${adoptReason}), and this browser's copy could not be put back (${restoreFailure.message}).`,
          { cause: error },
        );
      }
      // The failure is the only moment anyone learns what the safety copy does not hold: a file it left out is a file the
      // restored copy lacks, so its notice rides out with the failure. The folder the writer chose still holds the text.
      if (kept.omissions.length === 0) throw error;
      throw new Error(
        `${adoptReason} The copy of the project this browser kept, and that was put back, does not hold every file: ${kept.omissions.join(' ')}`,
        { cause: error },
      );
    }
    holdFolderCopy(opened.session, root, differs.baselineText, differs.digests);
    await rememberFolder(opened.session.projectId, root);
    await rememberHeldCopy(opened.session);
    return opened;
  }
  // This browser's version opens as the folder's session. The folder's own load notices are about a version the writer set aside, so
  // they are not said, and the folder's pictures do not replace this browser's.
  const opened = await openStored(store, differs.projectId, root, { notices: [], droppedFields: [], folderLog: differs.folderLog }, {});
  const browser = new MemoryArtifactFs();
  // The probe writes into a fresh in-memory folder, which holds none of the files this load declined because their bytes are not
  // UTF-8. It is a copy the app keeps for itself — only the digests are read from it, never the text — so it is written as an
  // internal copy, which carries what it can and leaves what it cannot out of the copy rather than refusing (the store's
  // WriteOptions.copyFor). A codex file the load held is one of those: it is left out of the copy, and the report says so. A
  // document the load held is the other way round: the copy has no text for it, so it writes the empty document the browser's own
  // copy shows, and the file it was read from is left where it is.
  await writeProject(browser, copyState(opened.session.state), { now: new Date(), copyFor: 'internal' });
  // The digest of a held document is the digest of that empty document, not of the file in the folder, so it is left out of the
  // probe: the save is checked against the folder's own digest for it, and does not ask the writer about a file that never changed.
  const digests = await projectFileDigests(browser);
  for (const name of opened.session.state.declinedDocFiles) digests.delete(`${DOCS_DIR}/${name}`);
  holdFolderCopy(opened.session, root, differs.baselineText, keepBrowserDigests(digests, differs.digests));
  return { ...opened, saveToFolder: root };
}

/**
 * Puts this browser's copy of a project back from the bundle `answerFolderDiffers` held before it removed the copy, after the folder's
 * version failed to take its place. Whatever the failed adopt left under the id is removed first, so the copy comes back under its own id
 * (an import into a taken id would make a second copy). The files the load declined are put back with it: a bundle carries the files it
 * declined *with* their text, and the load reads their record back from them, but a file whose bytes are not UTF-8 has no text to write,
 * so the copy leaves it out (a codex file) or writes an empty document in its place (a document) and the record of it is lost. The copy
 * that comes back is the copy that was held. The restored session is closed at once: the caller reports the adopt's failure, and the
 * project is in the projects list as it was. Only the version history of earlier bodies (the store's snapshots) is not in a bundle.
 *
 * **Every step of the put-back is tried, whatever the one before it did.** A
 * write of the held files that fails must not skip the close of the session —
 * the project's lease would stay held by a session nobody has, and the
 * projects list would refuse the copy that was just put back — nor the records
 * the removal forgot. The first failure is the one reported, and `null` when
 * every step worked.
 */
async function restoreBrowserCopy(
  store: RuntimeStore,
  projectId: string,
  bytes: Uint8Array,
  records: KeptFolderRecords,
  held: HeldFiles,
): Promise<Error | null> {
  let failure: unknown = null;
  const step = async (what: () => Promise<void>): Promise<void> => {
    try {
      await what();
    } catch (error) {
      failure = failure ?? error;
    }
  };
  const opened: { session: ProjectSession | null } = { session: null };
  await step(async () => {
    if ((await listProjectIds(store)).includes(projectId)) await removeProject(store, projectId);
    const restored = await importBundle(store, bytes, 'this browser’s copy');
    // A bundle this browser itself exported should never pause on encodings — a declined file rides the bundle as the
    // UTF-8 text the load kept for it. If one ever does, leaving every file is the safe answer: nothing is converted.
    const settled = restored.kind === 'encoding' ? await completeEncodingReview(store, restored.encoding, []) : restored;
    if (settled.kind !== 'opened') return;
    opened.session = settled.opened.session;
    // The bundle carried no record of the files the load held, so the copy is put back as it was held: the files
    // are named again, and the empty document the internal copy wrote in place of a held one is dropped — a document
    // the load held has no text, and a save leaves the author's file where it is.
    applyHeldFiles(settled.opened.session.state, held);
    await writeProjectState(store, settled.opened.session.state, { now: new Date() });
  });
  // The session is closed whatever the write did: a write that failed must not leave the project's lease held by a
  // session nobody has, or the projects list would refuse the copy that was just put back.
  const session = opened.session;
  if (session !== null) await step(() => session.close());
  await step(async () => {
    // The removal forgot the records the project kept beside it: they are kept again as they were, so the projects list still offers the
    // folder, a save to it is checked against the folder copy last seen there, and a separate copy is still refused in its original's folder.
    if (records.folder !== null) await rememberFolder(projectId, records.folder);
    if (records.folderCopy !== null) await rememberFolderCopy(projectId, records.folderCopy);
    if (records.copiedFrom !== null) await rememberCopiedFrom(projectId, records.copiedFrom);
  });
  if (failure === null) return null;
  return failure instanceof Error ? failure : new Error(String(failure));
}

/**
 * The files a load held: the documents and codex files whose bytes are not UTF-8, and the text the load kept for the files it declined
 * for another reason.
 *
 * Their record lives on the state and not in `caotang.json`, so a bundle cannot carry all of it: a file whose bytes are not UTF-8 has
 * no text to write, and the internal copy writes an empty document in place of a held one and leaves a held codex file out (the
 * store's `WriteOptions.copyFor`). They are held in memory beside the bundle instead, so the copy that is put back is the copy that
 * was held.
 */
interface HeldFiles {
  readonly declinedDocFiles: readonly string[];
  readonly declinedCodexFiles: readonly string[];
  readonly declinedText: ReadonlyMap<string, string>;
}

/** The held files of the stored copy, read before `answerFolderDiffers` removes it. */
async function heldFilesOf(store: RuntimeStore, projectId: string): Promise<HeldFiles> {
  const state = await readProjectState(store, projectId);
  return {
    declinedDocFiles: [...state.declinedDocFiles],
    declinedCodexFiles: [...state.declinedCodexFiles],
    declinedText: new Map(state.declinedText),
  };
}

/**
 * Puts the held files back on a restored state: the files the load declined are named again, and the body of a document it held is
 * dropped.
 *
 * The body is dropped because the internal copy wrote an empty document in place of a held one, and a state that holds that body would
 * write it over the author's file — the load held the document because its bytes are not text, and a save leaves such a file alone.
 */
function applyHeldFiles(state: ProjectState, held: HeldFiles): void {
  state.declinedDocFiles.clear();
  for (const name of held.declinedDocFiles) state.declinedDocFiles.add(name);
  state.declinedCodexFiles.clear();
  for (const name of held.declinedCodexFiles) state.declinedCodexFiles.add(name);
  state.declinedText.clear();
  for (const [path, text] of held.declinedText) state.declinedText.set(path, text);
  for (const node of state.manifest.tree) {
    if (!isBodyType(node.type)) continue;
    if (!bodyNamesOf(node).some((name) => held.declinedDocFiles.includes(name))) continue;
    state.documents.delete(node.id);
  }
}

/** The folder-memory.ts records of a project, read before `answerFolderDiffers` removes this browser's copy, so a failed adopt puts them back. */
interface KeptFolderRecords {
  readonly folder: DirectoryHandleLike | null;
  readonly folderCopy: RememberedFolderCopy | null;
  readonly copiedFrom: string | null;
}

/** What the writer has said about a recovery the folder check asked about: the same lock answer a folder save takes. */
export interface RecoveryAnswers {
  /** Recover although a lock file says another program, such as the Caotang MCP server, may be using the folder (see `FolderSaveAnswers`). */
  readonly lockConfirmed?: boolean;
}

/**
 * Why a recovery was not written: the folder is locked, its `caotang.json` changed after Caotang read it, or a document or codex file in it did
 * (`files`, named in the outcome). Nothing was written either way.
 */
export type RecoveryRefusal = 'locked' | 'changed' | 'files';

/** The result of accepting a recovery: opened, paused on the recovered files' encodings, or refused for one reason the writer must answer first (or reopen the folder for). */
export type RecoveryOutcome =
  | { readonly kind: 'opened'; readonly opened: Opened }
  | { readonly kind: 'encoding'; readonly encoding: PendingEncoding }
  | {
      readonly kind: 'refused';
      readonly reason: RecoveryRefusal;
      /** The document and codex files another program changed, removed or added, in the words the dialog shows (`files` only). */
      readonly files: readonly FolderFileChange[];
    };

/**
 * Accepts a recovery the writer has been offered (project-format §5.3): the recovered project is written as the new manifest,
 * the unreadable one is kept beside it, and the result is opened. Only the recovery dialog calls this, after the writer says yes.
 *
 * A folder is checked when the recovery is accepted, not when it was offered, because another program may have changed it since: its
 * `caotang.json` must still be the text the offer read (`folderSaveVerdict`), and a lock file needs the writer's `lockConfirmed`. A refusal
 * writes nothing. The copy kept beside the new manifest is the text read here, so the bytes kept are the bytes replaced.
 */
export async function completeRecovery(
  store: RuntimeStore,
  recovery: PendingRecovery,
  answers: RecoveryAnswers = {},
): Promise<RecoveryOutcome> {
  let offer = recovery.offer;
  if (recovery.folder !== null) {
    const onDisk = await readManifestText(recovery.fs);
    const verdict = folderSaveVerdict({
      // A folder with no manifest reads as the empty text the offer read too, so only a file that appeared since is a change.
      onDisk: onDisk ?? '',
      baseline: offer.corruptManifest?.contents ?? '',
      locked: await recovery.fs.exists(MCP_LOCK_FILE),
      lockConfirmed: answers.lockConfirmed === true,
      overwriteConfirmed: false,
      filesChanged: false,
    });
    // The baseline is always the offer's text, so `unknown` cannot come back. It is a change if it ever did.
    if (verdict !== 'write') return { kind: 'refused', reason: verdict === 'locked' ? 'locked' : 'changed', files: [] };
    // The document and codex files are checked against the digests the offer read, as a save checks them: a file another program
    // changed since is named, and the recovery writes nothing.
    const drift = driftOf(recovery.digests, await projectFileDigests(recovery.fs));
    if (hasDrift(drift)) return { kind: 'refused', reason: 'files', files: folderChanges(drift, offer.state, new Map()) };
    offer = withPreservedManifest(offer, onDisk);
  }
  await commitRecovery(recovery.fs, offer, { now: new Date() });
  // Files whose bytes are not UTF-8 pause for the writer's answer here too — after the recovery write, which the
  // pending's cancel names. The answers are applied to the recovered copy and the result adopted, as a bundle's are.
  if (offer.encodingIssues.length > 0) {
    return {
      kind: 'encoding',
      encoding: {
        name: recovery.name,
        issues: offer.encodingIssues,
        fs: recovery.fs,
        resume: { kind: 'recovery', sessions: recovery.sessions, folder: recovery.folder },
        cancelNote: 'The recovery was written, and the project’s files are as it left them. The project was not opened.',
      },
    };
  }
  // The recovery's own notes say which copy was used, and the dialog has already said it, so they are not repeated as field notices.
  const opened = await adopt(store, offer.state, recovery.sessions, [], [], recovery.folder);
  if (recovery.folder !== null) {
    // The recovery wrote the folder, so the digests are taken as the folder now stands: the next save is checked against what it holds.
    holdFolderCopy(opened.session, recovery.folder, (await readManifestText(recovery.fs)) ?? '', await projectFileDigests(recovery.fs));
  }
  return { kind: 'opened', opened };
}

/**
 * The offer with its preserved copy set to the text on disk when it was checked, so the copy kept is the copy removed. With no file on
 * disk there is nothing to keep, and the offer carries no copy.
 */
function withPreservedManifest(offer: RecoveryOffer, onDisk: string | null): RecoveryOffer {
  if (offer.corruptManifest === undefined) return offer;
  if (onDisk === null) return { ...offer, corruptManifest: undefined };
  return { ...offer, corruptManifest: { path: offer.corruptManifest.path, contents: onDisk } };
}

/**
 * Continues an open that paused on non-UTF-8 files, once the writer has answered (`PendingEncoding`). Each file the
 * writer converted is backed up and rewritten in place first (`applyEncodingDecisions`); then the project is read
 * again — a converted file is plain text now and is imported by the same loader that held it — and the open finishes
 * the way it would have: a folder routes and attaches as `openFolder` does, a bundle is adopted, an accepted recovery
 * adopts its recovered copy. The lines the application of the answers produced are said ahead of the load's own
 * notices, so a file that could not be converted is named rather than silently held.
 */
export async function completeEncodingReview(
  store: RuntimeStore,
  pending: PendingEncoding,
  decisions: readonly EncodingDecision[],
): Promise<OpenOutcome> {
  const result = await applyEncodingDecisions(pending.fs, pending.issues, decisions);
  let loaded: LoadResult;
  try {
    loaded = await readProject(pending.fs);
  } catch (error) {
    if (!isUnreadableManifest(error)) throw error;
    // A manifest that can no longer be read — another program touched the folder while the dialog was open — is
    // offered its recovery again, as the open that read it would have offered.
    const resume = pending.resume;
    const folder = resume.kind === 'folder' ? resume.root : resume.kind === 'recovery' ? resume.folder : null;
    const sessions =
      resume.kind === 'folder' ? await folderSessionsOf(pending.fs) : resume.sessions;
    return {
      kind: 'recover',
      recovery: await recoveryFor(pending.name, pending.fs, sessions, folder, folder === null ? new Map() : await projectFileDigests(pending.fs)),
    };
  }
  const lines = encodingResultLines(result, loaded.state);
  const resume = pending.resume;
  switch (resume.kind) {
    case 'bundle':
      return {
        kind: 'opened',
        opened: await adopt(
          store,
          loaded.state,
          resume.sessions,
          [...lines, ...noticesOf(loaded.notices)],
          droppedFieldsOf(loaded.notices),
          null,
          resume.assets,
          resume.coherence,
        ),
      };
    case 'recovery': {
      // As the accepted recovery itself would open it: the conversion lines are the whole report, since the recovery
      // dialog already said which copy was used.
      const opened = await adopt(store, loaded.state, resume.sessions, lines, [], resume.folder);
      if (resume.folder !== null) {
        holdFolderCopy(opened.session, resume.folder, (await readManifestText(pending.fs)) ?? '', await projectFileDigests(pending.fs));
      }
      return { kind: 'opened', opened };
    }
    case 'folder':
      return finishFolderOpen(store, resume.root, pending.fs, loaded, await readManifestText(pending.fs), await projectFileDigests(pending.fs), lines);
  }
}

/** The exact folder state shown by an overwrite question. */
export interface FolderOverwriteSnapshot {
  readonly manifestText: string | null;
  readonly digests: ReadonlyMap<string, string>;
}

function folderOverwriteSnapshotMatches(snapshot: FolderOverwriteSnapshot, manifestText: string | null, digests: ReadonlyMap<string, string>): boolean {
  if (snapshot.manifestText !== manifestText || snapshot.digests.size !== digests.size) return false;
  for (const [path, digest] of snapshot.digests) if (digests.get(path) !== digest) return false;
  return true;
}

/** What the writer has said about a folder save the checks asked about (see `folderSaveVerdict`). */
export type FolderSaveAnswers =
  | {
      readonly lockConfirmed?: boolean;
      readonly overwriteConfirmed?: false;
      readonly overwriteSnapshot?: never;
    }
  | {
      readonly lockConfirmed?: boolean;
      readonly overwriteConfirmed: true;
      /** The unchanged folder state the writer saw in the overwrite question. */
      readonly overwriteSnapshot: FolderOverwriteSnapshot;
    };

/** One document or codex file another program changed, removed or added, in the words the folder question shows (`folderChanges`). */
export type FolderFileChange = ProjectFileChange;

/**
 * The changes a drift names, in the folder question's words: a document by its title, a codex entry by its name, and a file this copy does
 * not hold described, so no node id and no file name reaches the writer. The wording is the store's, which the MCP server shares.
 */
export function folderChanges(drift: FolderDrift, state: ProjectState, heldTitles: ReadonlyMap<string, string>): FolderFileChange[] {
  return projectFileChanges(drift, state, heldTitles, 'this copy');
}

/** A changed project file whose path remains internal, so equal display labels cannot mix their previews. */
export interface FolderFilePreviewTarget extends FolderFileChange {
  readonly path: string;
}

/** Bounded exact paths retained for comparison and the number not retained. */
export interface FolderFilePreviewTargets {
  readonly targets: readonly FolderFilePreviewTarget[];
  readonly omitted: number;
}

/** The text lines a writer can compare before confirming a folder overwrite. */
export interface FolderFilePreview extends FolderFilePreviewTarget {
  readonly lines: readonly FolderDiffLine[];
}

/** A bounded set of previews and the number of file comparisons omitted to keep the question manageable. */
export interface FolderFilePreviewBatch {
  readonly previews: readonly FolderFilePreview[];
  readonly omitted: number;
}

const MAX_FOLDER_FILE_PREVIEWS = 12;
const MAX_FOLDER_PREVIEW_CHARACTERS = 48_000;
const FOLDER_PREVIEW_READ_CONCURRENCY = 3;

async function readFolderPreviewFile(fs: ArtifactFs, path: string): Promise<string | null | undefined> {
  try {
    return await fs.read(path);
  } catch (error) {
    return error instanceof ArtifactNotFoundError ? undefined : null;
  }
}

function folderFilePreviewTargets(
  drift: FolderDrift,
  state: ProjectState,
  heldTitles: ReadonlyMap<string, string>,
): FolderFilePreviewTargets {
  const currentTitles = projectFileTitles(state);
  const target = (path: string, change: ProjectFileChange['change']): FolderFilePreviewTarget => ({
    path,
    label: projectFileLabel(path, currentTitles, heldTitles, 'this copy'),
    change,
  });
  const previewable = (path: string): boolean => path.startsWith(`${DOCS_DIR}/`) || path.startsWith('codex/');
  const targets: FolderFilePreviewTarget[] = [];
  let total = 0;
  const collect = (paths: readonly string[], change: ProjectFileChange['change']): void => {
    for (const path of paths) {
      if (!previewable(path)) continue;
      total += 1;
      if (targets.length < MAX_FOLDER_FILE_PREVIEWS) targets.push(target(path, change));
    }
  };
  collect(drift.changed, 'changed');
  collect(drift.removed, 'removed');
  collect(drift.added, 'added');
  return { targets, omitted: total - targets.length };
}

/**
 * Prepares a read-only, line-based comparison for the exact files named by a folder-save question. The
 * folder text is read as it stands when the question opens; the tab's text is serialized into a
 * temporary in-memory artifact using the same project writer as a save. No folder file is changed.
 */
export async function previewFolderChanges(
  session: ProjectSession,
  root: DirectoryHandleLike,
  files: readonly FolderFilePreviewTarget[],
  previouslyOmitted = 0,
): Promise<FolderFilePreviewBatch> {
  if (files.length === 0) return { previews: [], omitted: previouslyOmitted };
  const targets = files.slice(0, MAX_FOLDER_FILE_PREVIEWS);
  const folderFs = folderArtifactFs(root);
  const proposedFs = new MemoryArtifactFs();
  try {
    await writeProject(proposedFs, copyState(session.state), { copyFor: 'internal' });
  } catch {
    const previews = targets.map((file) => ({ ...file, lines: [{ kind: 'note' as const, text: 'Caotang could not prepare this comparison.' }] }));
    return { previews, omitted: previouslyOmitted + files.length - previews.length };
  }
  const previews: FolderFilePreview[] = [];
  let characters = 0;
  for (let start = 0; start < targets.length; start += FOLDER_PREVIEW_READ_CONCURRENCY) {
    const batch = await Promise.all(targets.slice(start, start + FOLDER_PREVIEW_READ_CONCURRENCY).map(async (file) => {
      const { path } = file;
      const folderText = await readFolderPreviewFile(folderFs, path);
      const declined = path.startsWith(`${DOCS_DIR}/`) && session.state.declinedDocFiles.has(path.slice(DOCS_DIR.length + 1));
      const tabText = declined ? undefined : await readFolderPreviewFile(proposedFs, path);
      return { ...file, lines: folderFileDiff(folderText, tabText) };
    }));
    for (const preview of batch) {
      const size = preview.lines.reduce((total, line) => total + 2 + Math.max(1, line.text.length) + 1, 0);
      if (characters + size > MAX_FOLDER_PREVIEW_CHARACTERS) {
        return { previews, omitted: previouslyOmitted + files.length - previews.length };
      }
      previews.push(preview);
      characters += size;
    }
  }
  return { previews, omitted: previouslyOmitted + files.length - previews.length };
}

/**
 * The result of a save to a folder: written, or refused for one reason the writer must answer first. `files` names the documents and codex
 * entries another program changed, removed or added, in words (`folderChanges`), so the question can say which ones it is about. `partial`
 * is set when the change was found during the write rather than before it: the files before the changed one, and the pictures, were written.
 * `after` is set when it was found only once the write had finished.
 */
export type FolderSaveOutcome =
  | {
      readonly kind: 'saved';
      /** The folder in the project folder that holds the files this save replaced, when it replaced any another program had written (folder-guard.ts). */
      readonly backup?: string;
    }
  | {
      readonly kind: 'refused';
      readonly reason: Exclude<FolderSaveVerdict, 'write'>;
      readonly files: readonly FolderFileChange[];
      /** Bounded exact changed file paths for previews; paths are internal and are not rendered to the writer. */
      readonly previewFiles?: readonly FolderFilePreviewTarget[];
      /** Exact file comparisons not retained for previews due to target or output limits. */
      readonly omittedPreviewFiles?: number;
      readonly partial?: true;
      /**
       * Set when the save was written in full and the change was found after it: another program changed these files, or put its lock in the
       * folder, while the save wrote. The folder holds that program's version, and the next save asks about it.
       */
      readonly after?: true;
      /** Set on a changed refusal when the folder's `caotang.json` is gone, rather than changed: there is no newer copy to open. */
      readonly removed?: true;
    };

const folderOverwriteSnapshots = new WeakMap<object, FolderOverwriteSnapshot>();

/** The exact folder state a save refusal associates with its overwrite question. */
export function folderOverwriteSnapshotFor(outcome: FolderSaveOutcome): FolderOverwriteSnapshot | undefined {
  return folderOverwriteSnapshots.get(outcome);
}

function withFolderOverwriteSnapshot<T extends Extract<FolderSaveOutcome, { readonly kind: 'refused' }>>(
  outcome: T,
  snapshot: FolderOverwriteSnapshot,
): T {
  folderOverwriteSnapshots.set(outcome, snapshot);
  return outcome;
}

/** What a copy opened from a folder says when it is asked to save into that folder: a copy of the book, not the book. */
const COPY_CANNOT_SAVE_INTO_FOLDER =
  'This copy cannot be saved into that folder. It is a second copy of the book the folder holds, and saving it there would change the folder’s book into this copy. Nothing was written. Save this copy to a new folder, or export a backup.';

/**
 * Write the project's current state into a folder as an artifact (project-format §4), when the folder still holds the copy this
 * session last loaded or saved (`folderSaveVerdict`). Otherwise nothing is written, and the reason is returned for the shell to ask about.
 * Only the documents this session deleted are removed from `docs/`: a file another writer put in the folder stays where it is.
 */
export async function saveFolder(
  session: ProjectSession,
  root: DirectoryHandleLike,
  answers: FolderSaveAnswers = {},
): Promise<FolderSaveOutcome> {
  // Another tab holds newer text, which this session stopped on (persistence.ts). Writing this state into a folder would replace that text.
  if (session.persistence.isStopped()) {
    throw new Error('This tab cannot save: another tab has newer text for this project. Export a backup to keep the words in this tab.');
  }
  await session.settle();
  const fs = folderArtifactFs(root);
  const onDisk = await readManifestText(fs);
  // Whose project the folder holds (`folderProjectRoute`). A separate copy made from the folder's own book has an id of its own (adopt), and
  // writing it there would turn the folder's book into the copy, so that save is refused, before anything is written and whatever the
  // writer answers. Any other project is asked about (`unknown`), and this project's own earlier save is never called another project.
  const route = folderProjectRoute({
    folderId: onDisk === null ? undefined : projectIdOf(onDisk),
    ownId: session.state.manifest.project.id,
    copiedFrom: session.copiedFrom() ?? (await copiedFromOf(session.projectId)),
  });
  if (route === 'original') throw new Error(COPY_CANNOT_SAVE_INTO_FOLDER);
  // The copy this session holds is a baseline only for the folder it was taken from (`FolderBaseline`). A folder holding this project's own
  // earlier save, which this session holds no copy of (after a reload), is compared with the copy kept for it across the reload. Any other
  // folder is compared with nothing.
  const copy = session.folderBaseline();
  let held = copy !== null && (await isSameFolder(copy.folder, root)) ? copy : null;
  if (held === null && route === 'own') held = await rememberedCopyFor(session.projectId, root);
  // What the folder holds now, digested before anything is compared or written, so the check and the write see the same files.
  const before = await projectFileDigests(fs);
  const drift = held === null ? null : driftOf(held.digests, before);
  const previewHeldTitles = held?.titles ?? new Map<string, string>();
  const files = drift === null ? [] : folderChanges(drift, session.state, previewHeldTitles);
  const previewTargets = drift === null ? { targets: [], omitted: 0 } : folderFilePreviewTargets(drift, session.state, previewHeldTitles);
  const lockedBefore = await fs.exists(MCP_LOCK_FILE);
  const overwriteConfirmed = answers.overwriteConfirmed === true
    && answers.overwriteSnapshot !== undefined
    && folderOverwriteSnapshotMatches(answers.overwriteSnapshot, onDisk, before);
  const verdict = folderSaveVerdict({
    onDisk,
    baseline: held?.manifestText ?? null,
    locked: lockedBefore,
    lockConfirmed: answers.lockConfirmed === true,
    overwriteConfirmed,
    filesChanged: files.length > 0,
    sameProject: route === 'own',
  });
  if (verdict !== 'write') {
    const refusal = verdict === 'changed' && onDisk === null
      ? { kind: 'refused' as const, reason: verdict, files, removed: true as const }
      : { kind: 'refused' as const, reason: verdict, files };
    return withFolderOverwriteSnapshot({
      ...refusal,
      ...(previewTargets.targets.length === 0 ? {} : {
        previewFiles: previewTargets.targets,
        ...(previewTargets.omitted === 0 ? {} : { omittedPreviewFiles: previewTargets.omitted }),
      }),
    }, { manifestText: onDisk, digests: before });
  }
  // The session log is written first, so a log the folder cannot take refuses the save before any project file is written (writeFolderLog).
  await writeFolderLog(session, fs);
  // The pictures are copied before the manifest names them, so the folder never holds a manifest without the files it names. A folder
  // holding a different file under one of those names is refused here, before anything is written (project-assets.ts).
  await session.assets.copyTo(root);
  const report = emptyReport();
  const now = new Date();
  // A file the write replaces or removes that this session did not last write is copied to .caotang-backup first, and checked once more
  // as it is copied (folder-guard.ts).
  const watch = watchSave(fs, { now, expected: before, held: held === null ? null : held.digests, report });
  const toWrite = copyState(session.state);
  // As with documents, only the copy's own folder can hold skill files this session removed. Any other folder keeps every file it has.
  if (held === null) toWrite.removedSkillFiles.clear();
  try {
    await writeProject(watch.fs, toWrite, {
      now,
      // Only the copy's own folder can hold documents this session deleted. Any other folder keeps every file it has.
      pruneDocumentIds: held === null ? [] : deletedSince(held, session.state),
      // Each file is checked against the digest the folder held just before this save, as it is written or removed.
      expectedDigests: before,
      report,
    });
  } catch (error) {
    if (!(error instanceof FolderDriftError)) throw error;
    // Another program changed a file after the check above, and the write stopped before that file. The copy keeps the digests of what this
    // save did write and of no other, so the next save still sees that other change. Nothing it changed is overwritten.
    if (held !== null) session.setFolderBaseline(root, held.manifestText, held.documentIds, await digestsAfterWrite(fs, before, error.partial), held.titles);
    const overwriteSnapshot = { manifestText: await readManifestText(fs), digests: await projectFileDigests(fs) };
    const changed = { changed: [...error.paths], removed: [], added: [] };
    const heldTitles = held?.titles ?? new Map<string, string>();
    const previewTargets = folderFilePreviewTargets(changed, session.state, heldTitles);
    return withFolderOverwriteSnapshot({
      kind: 'refused',
      reason: 'files',
      files: folderChanges(changed, session.state, heldTitles),
      partial: true,
      ...(previewTargets.targets.length === 0 ? {} : {
        previewFiles: previewTargets.targets,
        ...(previewTargets.omitted === 0 ? {} : { omittedPreviewFiles: previewTargets.omitted }),
      }),
    }, overwriteSnapshot);
  }
  // The skill files the folder no longer holds are no longer owed a removal.
  if (held !== null) for (const path of [...session.state.removedSkillFiles]) if (!toWrite.removedSkillFiles.has(path)) session.state.removedSkillFiles.delete(path);
  // What is on disk now is what the next save is checked against, so it is read back rather than assumed, with one exception: a file another
  // program changed while the save wrote (the folder's files are digested again and compared with what the save left, folder-guard.ts) is
  // not taken as this save's own, so the next save asks about it. The same goes for caotang.json.
  const settled = await changedDuringSave(fs, before, watch);
  const written = watch.manifestText();
  const currentManifestText = await readManifestText(fs);
  const manifestNow = currentManifestText ?? '';
  const overwriteSnapshot = { manifestText: currentManifestText, digests: settled.currentDigests };
  const manifestMoved = written !== undefined && manifestNow !== written;
  holdFolderCopy(session, root, manifestMoved ? written : manifestNow, settled.digests);
  // The findings file goes beside the project, and stays in step with it from now on (coherence.md §3).
  await session.attachCoherenceFolder(root);
  // The project remembers the folder it was saved to, so the projects list can reopen it with one click (folder-memory.ts).
  await rememberFolder(session.projectId, root);
  await rememberHeldCopy(session);
  const backup = watch.backup();
  if (backup !== undefined) await pruneFolderBackups(fs);
  // The lock is read again: a server that took the folder while the save wrote may have read half of it.
  const lockAppeared = !lockedBefore && (await fs.exists(MCP_LOCK_FILE));
  const heldTitles = session.folderBaseline()?.titles ?? new Map<string, string>();
  const changes = (): FolderFileChange[] => folderChanges(settled.drift, session.state, heldTitles);
  const afterWritePreviewTargets = folderFilePreviewTargets(settled.drift, session.state, heldTitles);
  const afterWritePreview = afterWritePreviewTargets.targets.length === 0 ? {} : {
    previewFiles: afterWritePreviewTargets.targets,
    ...(afterWritePreviewTargets.omitted === 0 ? {} : { omittedPreviewFiles: afterWritePreviewTargets.omitted }),
  };
  if (manifestMoved) return withFolderOverwriteSnapshot({
    kind: 'refused',
    reason: 'changed',
    files: changes(),
    after: true,
    ...afterWritePreview,
  }, overwriteSnapshot);
  if (hasDrift(settled.drift)) return withFolderOverwriteSnapshot({
    kind: 'refused',
    reason: 'files',
    files: changes(),
    after: true,
    ...afterWritePreview,
  }, overwriteSnapshot);
  if (lockAppeared) return withFolderOverwriteSnapshot({ kind: 'refused', reason: 'locked', files: [], after: true }, overwriteSnapshot);
  return backup === undefined ? { kind: 'saved' } : { kind: 'saved', backup };
}

/**
 * Writes the session log into the folder as `sessions.jsonl` (project-format §4). The folder's own lines come first, as they are, and the
 * browser copy's lines the folder does not hold follow them. The file is only appended to (sessions.ts `writeSessionsFile`), so no line the
 * folder holds is dropped or reordered, and a damaged line is kept as it is. A log that differs from the browser's copy is merged, not
 * refused, and it is written before any project file, so a save that stops after this step has lost nothing.
 */
async function writeFolderLog(session: ProjectSession, fs: ArtifactFs): Promise<void> {
  const folderLog = await folderSessionsOf(fs);
  const browserLog = await session.sessionLog();
  try {
    await writeSessionsFile(fs, [...folderLog, ...linesNotHeld(browserLog, folderLog)]);
  } catch (error) {
    // The folder's record is read again by the write. It can only differ from the read above when another program wrote it in between.
    if (error instanceof SessionsShrinkError) {
      throw new Error('The folder’s record of writing sessions changed while Caotang was saving it. Nothing was written. Save again.', { cause: error });
    }
    throw error;
  }
}

/** The part of the settings a demo run reads, and records its sample in. The app's settings store has this shape. */
export interface DemoSettings {
  current(): { readonly sampleProjectIds: readonly string[] };
  update(patch: { readonly sampleProjectIds: readonly string[] }): Promise<unknown>;
}

/**
 * The sample a demo run opens (`openOrCreateSample`), and the settings' record of a sample made here, so the next run reuses it. When
 * that record cannot be written the sample is closed, because the shell will not show it and nothing else would give its lease back.
 * The failure is passed on to the caller.
 */
export async function openDemoSample(store: RuntimeStore, settings: DemoSettings): Promise<ProjectSession> {
  const { session, created } = await openOrCreateSample(store, settings.current().sampleProjectIds);
  if (!created) return session;
  try {
    await settings.update({ sampleProjectIds: [...settings.current().sampleProjectIds, session.projectId] });
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
  return session;
}
