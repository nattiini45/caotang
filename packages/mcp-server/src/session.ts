/**
 * One open project, held by this server for its lifetime.
 *
 * The folder underneath (the single-writer lock, the folder-drift checks, the write queue, the exporter that writes `exports/`) is
 * the SDK's `openFolder`, shared with `@caotang/sdk`. What this file adds is the server's side of it: the harness every tool call goes
 * through, built with the ports that need no model (`createProductHarness`, `ports: 'external'`), the posture that decides whether an
 * external caller may write, and the two ways a call reaches the project: a read or auto-applied write (`callDirect`) and a write
 * the user confirmed in the host's dialog (`callConfirmed`).
 *
 * A write that changed the project is on disk when its call resolves. The folder is shared with whatever else opens it, and a
 * change another program made to it stops the writes until the server restarts (`FolderChangedError`, in the SDK's folder module).
 */

import { resolve } from 'node:path';

import type { CommandError } from '@caotang/bus';
import type { ExportDispatch, ExporterService } from '@caotang/exporter';
import { createProductHarness, metadataFor, type Harness, type TimelineProposal, type ToolOutcome } from '@caotang/harness';
import {
  MCP_VOICE,
  isCodexFileName,
  isDocumentFileName,
  manifestTextAt,
  openFolder,
  type FolderChangedError,
  type NodeArtifactFs,
  type TimelineApplied,
  type TimelineReadOptions,
  type TimelineWriteResult,
} from '@caotang/sdk/folder';
import type { TimelineModel } from '@caotang/timeline';
import {
  CODEX_DIR,
  createEmptyManifest,
  createProjectState,
  DOCS_DIR,
  MANIFEST_FILE,
  writeProject,
  type LoadNotice,
  type ProjectState,
} from '@caotang/store';

import { sourceWindow, type SourceWindow } from './attribution.js';
import { createChangeFeed, type ChangeFeed } from './changes.js';
import { ROUND_TTL_SECONDS } from './confirm.js';
import { createTtlMap } from './ttl-map.js';
import { changeOf } from './uris.js';

/**
 * One confirmation round, as `check` sees it: the call id its sealed state carries (the same in the question and in the accept, and
 * different for every request), and whether this is the accept round. A proposal staged for a question is held under that id.
 */
export interface ConfirmationRound {
  readonly callId: string;
  readonly accepted: boolean;
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
  /** Where a notice raised after the open is said (a refused write to coherence.json). Defaults to stderr, one line each. */
  readonly report?: (line: string) => void;
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
   * What the writes made here changed, announced once each is on disk (changes.ts). Nothing is announced for a read, and nothing for a
   * change another program made, except that it stopped the writes: that is announced once, as a drift.
   */
  readonly changes: ChangeFeed;
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
   * Runs one confirmed `timeline.edit` on the folder's two-file path (timeline.md §9.2): the folder's checks, this host's own
   * before-image against the `coherence.json` on disk, the harness call, the per-scene merge, both writes, and a read-back of what
   * the disk holds. The answer is typed — `persisted`, `conflict`, `partial` or `refused` — and never a bare success, because the
   * manifest and the coherence file are two saves and the second may fail after the first.
   */
  callConfirmedTimeline(name: string, callId: string, params: unknown, turnId: string): Promise<TimelineWriteResult<ToolOutcome>>;
  /**
   * Why this session writes nothing more, in full, when a timeline batch was only partly saved: the folder may not hold what the
   * session's copy has, and a later save would write that copy over it. Undefined until that happens, and undefined again only by a
   * restart; a read is not stopped.
   */
  readonly writtenPartway: string | undefined;
  /**
   * The checks of one call, with no effect: the refusal the call would get if it ran now, or `undefined` when it would be accepted. The
   * harness checks the call's params, and the exporter checks an export's selection (the gates its compile applies). A folder that
   * changed refuses a write here too. A confirmation asks only for a call that passes, so the dialog never asks for a change that cannot happen.
   */
  check(name: string, params: unknown, round?: ConfirmationRound): CommandError | undefined;
  /**
   * Drops what a confirmation round held for its accept (the staged values of a `timeline.edit`), when the round ends with no accept:
   * the writer declined or cancelled, the host cannot be asked, or the call was refused. An accept drops it by running.
   */
  releaseConfirmation(callId: string): void;
  /**
   * Lists the stored images again, for the exporter. `check` is synchronous and reads the listing held, so a confirmed call lists the
   * images first: a listing that failed once (a folder busy at open, say) is not held against every later compile, and a folder that
   * has since become unreadable refuses the compile before the writer is asked, not after.
   */
  refreshAssets(): Promise<void>;
  /**
   * The story timeline of the open project (timeline.md §3), built from the state and the `coherence.json` this session
   * holds in memory — the same model the app's view builds, so the MCP resources and tool and the browser answer with
   * identical data. Read-only: writes nothing, logs no row.
   */
  timeline(options?: TimelineReadOptions): TimelineModel;
  /** The timeline as CSV rows in the canonical order of timeline.md §8. Read-only, like {@link timeline}. */
  timelineCsv(options?: TimelineReadOptions): string;
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

/** The turn id an external turn is held under, as the harness's own facade names it. */
export function externalTurn(turnId: string): string {
  return `mcp:${turnId}`;
}

/** The tools whose effect is on coherence.json: the scan appends a run, and the status change marks a finding fixed. */
const COHERENCE_TOOLS: ReadonlySet<string> = new Set(['coherence.scan', 'coherence.setFindingStatus']);

/** Whether a tool changes the project when it runs. A read never does, so a folder that changed does not stop one. */
function changesProject(name: string): boolean {
  const risk = metadataFor(name)?.risk;
  return risk === 'write-auto' || risk === 'write-confirm';
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

export async function openProject(options: OpenProjectOptions): Promise<ProjectSession> {
  const now = options.now ?? (() => new Date());
  const { create } = options;
  const folder = await openFolder({
    root: options.root,
    voice: MCP_VOICE,
    writeCoherence: options.allowWrites,
    now,
    report: options.report ?? ((line) => void process.stderr.write(`${line}\n`)),
    ...(create === undefined
      ? {}
      : {
          create: async (fs: NodeArtifactFs, clock: () => Date): Promise<string> => {
            const name = create.trim();
            if (name === '') throw new Error('--create needs a project name');
            // Checked before the first write: a manifest written over these files would not own them, and the first save would delete them.
            const kept = await projectFileWithoutManifest(fs);
            if (kept !== undefined) throw new ProjectContentError(resolve(options.root), kept);
            const stamp = clock();
            const fresh = createProjectState(createEmptyManifest(name, stamp));
            const text = manifestTextAt(fresh, stamp);
            await writeProject(fs, fresh, { now: stamp });
            return text;
          },
        }),
  });
  try {
    const { fs, state, exporter } = folder;
    // codex.read is a pure read over the manifest's codex, so it runs here as it does in the app.
    // The three model-backed tools stay unwired ('external' ports): this server holds no provider profile or key,
    // and those tools would draft with Caotang's model, not the caller's.
    const harness = createProductHarness({ state, registry: folder.registry, externalWrites: options.allowWrites, ports: 'external' });
    const window = sourceWindow(harness.log);
    const changes = createChangeFeed();
    // The folder changing under the server stops its writes for good, so it is announced once: a host that is subscribed reads again.
    let driftSaid = false;
    const sayDrift = (): void => {
      if (!folder.changed || driftSaid) return;
      driftSaid = true;
      changes.emit({ updated: [], listChanged: true, drift: true });
    };
    // A save that went through announces what the log rows since `before` changed. One that failed announces nothing but a drift.
    const saved = async (before: number, save: () => Promise<void>): Promise<void> => {
      try {
        await save();
      } catch (error) {
        sayDrift();
        throw error;
      }
      const rows = harness.log.entries().slice(before);
      const change = changeOf(state, rows);
      if (change.updated.length > 0 || change.listChanged) changes.emit(change);
    };

    // A timeline batch is two saves, so one can land and the other not. When that happens the folder and this copy are out of step,
    // and no later write may paper over it: the whole session stops writing until it is restarted (timeline.md §9.2).
    let writtenPartway: string | undefined;
    // `check` runs before the host shows its confirmation. Keep each round's values read there, keyed by the round's call id, so two
    // open questions (even for identical arguments) cannot replace one another, and an accept cannot silently re-base over an edit
    // made while it waited. An entry leaves when its round is accepted, refused, declined or cancelled; a round whose host never
    // answers leaves by the same lifetime as its sealed state.
    const timelineApprovals = createTtlMap<TimelineProposal>();
    const releaseTimelineApproval = (callId: string): void => {
      const held = timelineApprovals.get(callId, now().getTime());
      if (held !== undefined) timelineApprovals.delete(callId, held);
    };
    const takeTimelineApproval = (callId: string): TimelineProposal | undefined => {
      const held = timelineApprovals.get(callId, now().getTime());
      if (held !== undefined) timelineApprovals.delete(callId, held);
      return held;
    };

    return {
      root: folder.root,
      fs,
      state,
      harness,
      exporter,
      allowWrites: options.allowWrites,
      created: folder.created,
      notices: folder.notices,
      window,
      changes,
      get writtenPartway() {
        return writtenPartway;
      },

      async callDirect(name, callId, params, turnId) {
        if (folder.changed && changesProject(name)) throw folder.stoppedError(false);
        const before = harness.log.length;
        const outcome = harness.external.call({ name, callId, params }, { turnId });
        harness.external.endTurn(turnId);
        // Only a write saves the project folder. A read can still log a row (coherence.scan logs its run), and that row is not a change to
        // the project's files. The run belongs in coherence.json, which a server with --allow-writes appends to, as it does for a finding
        // marked fixed; a server without it writes nothing.
        const logged = harness.log.length !== before;
        if (options.allowWrites && changesProject(name) && logged) await saved(before, () => folder.persist());
        if (options.allowWrites && logged && COHERENCE_TOOLS.has(name)) await folder.persistCoherence();
        return outcome;
      },

      async callConfirmed(name, callId, params, turnId) {
        if (folder.changed) throw folder.stoppedError(false);
        await folder.refreshAssets();
        const turn = externalTurn(turnId);
        const before = harness.log.length;
        const outcome = window.within('mcp', () =>
          harness.call({ name, callId, params }, { turnId: turn, permission: { confirmed: true } }),
        );
        harness.endTurn(turn);
        await exporter.idle();
        if (harness.log.length !== before || outcome.ok) await saved(before, () => folder.persist());
        await folder.persistCoherence();
        return outcome;
      },

      async callConfirmedTimeline(name, callId, params, turnId) {
        // Taken before anything can throw or refuse, so the proposal is consumed on every path out of this call.
        const approved = takeTimelineApproval(callId);
        if (folder.changed) throw folder.stoppedError(false);
        await folder.refreshAssets();
        const turn = externalTurn(turnId);
        const before = harness.log.length;
        const result = await folder.applyTimeline(
          (): TimelineApplied<ToolOutcome> => {
            let proposal = approved;
            if (proposal === undefined) {
              // A direct session caller has no separate check: stage and apply in the same synchronous turn, with no dialog in between.
              const staged = harness.timelineStage(params as Readonly<Record<string, unknown>>);
              if (!staged.ok) return { installed: false, outcome: { ok: false, error: staged.error } };
              proposal = staged.value;
            }
            const outcome = window.within('mcp', () =>
              harness.call({ name, callId, params, proposal }, { turnId: turn, permission: { confirmed: true } }),
            );
            // A refusal is the harness's, and the bus applies nothing before it decides: the folder writes nothing for it.
            return { installed: outcome.ok, outcome };
          },
        );
        harness.endTurn(turn);
        if (result.status === 'persisted') {
          // Announced only once the read-back agreed: a host is told what is on disk, never what was meant.
          const rows = harness.log.entries().slice(before);
          const change = changeOf(state, rows);
          if (change.updated.length > 0 || change.listChanged) changes.emit(change);
        }
        if (result.status === 'partial') writtenPartway = result.recovery;
        return result;
      },

      releaseConfirmation: releaseTimelineApproval,

      check(name, params, round) {
        // A folder that changed stops every write (callConfirmed), so a write is refused here, as the accept would refuse it, and no
        // question is asked for it.
        if (folder.changed && changesProject(name)) {
          if (round !== undefined) releaseTimelineApproval(round.callId);
          return notMadeError(name, folder.stoppedError(false));
        }
        if (name === 'timeline.edit') {
          // A check with no round stages nothing: there is no confirmation to hold a proposal for.
          if (round === undefined) {
            const staged = harness.timelineStage(params as Readonly<Record<string, unknown>>);
            return staged.ok ? undefined : staged.error;
          }
          const at = now().getTime();
          // A fresh request always stages from the live state. An accept reuses only its own earlier proposal; staging
          // again here would re-base it over another confirmation accepted while this one waited.
          if (round.accepted) {
            if (timelineApprovals.get(round.callId, at) !== undefined) return undefined;
            // The proposal expires just before the sealed confirmation state (mint comes after this check). An accept in that gap must
            // not stage afresh from live state: only a fresh round may do that, after its own check has run.
            return {
              code: 'revision-conflict',
              message: 'the timeline edit confirmation is no longer available, so the edit was not made',
              correctiveHint: 'make the timeline edit again and confirm it within 30 minutes',
              target: name,
            };
          }
          const staged = harness.timelineStage(params as Readonly<Record<string, unknown>>);
          if (!staged.ok) {
            releaseTimelineApproval(round.callId);
            return staged.error;
          }
          timelineApprovals.set(round.callId, staged.value, at + ROUND_TTL_SECONDS * 1000, at);
          return undefined;
        }
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

      refreshAssets: () => folder.refreshAssets(),
      timeline: (options) => folder.timeline(options),
      timelineCsv: (options) => folder.timelineCsv(options),
      persist: () => folder.persist(),
      async verifyFolder() {
        await folder.verifyFolder();
        sayDrift();
      },
      close: () => folder.close(),
      releaseLockSync: () => folder.releaseLockSync(),
    };
  } catch (error) {
    await folder.close();
    throw error;
  }
}
