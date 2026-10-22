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
import { createProductHarness, metadataFor, type Harness, type ToolOutcome } from '@caotang/harness';
import {
  MCP_VOICE,
  isCodexFileName,
  isDocumentFileName,
  manifestTextAt,
  openFolder,
  type FolderChangedError,
  type NodeArtifactFs,
} from '@caotang/sdk/folder';
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
   * harness checks the call's params, and the exporter checks an export's selection (the gates its compile applies). A folder that
   * changed refuses a write here too. A confirmation asks only for a call that passes, so the dialog never asks for a change that cannot happen.
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

      async callDirect(name, callId, params, turnId) {
        if (folder.changed && changesProject(name)) throw folder.stoppedError(false);
        const before = harness.log.length;
        const outcome = harness.external.call({ name, callId, params }, { turnId });
        harness.external.endTurn(turnId);
        // Only a write saves the project folder. A read can still log a row (coherence.scan logs its run), and that row is not a change to
        // the project's files. The run belongs in coherence.json, which a server with --allow-writes appends to, as it does for a finding
        // marked fixed; a server without it writes nothing.
        const logged = harness.log.length !== before;
        if (options.allowWrites && changesProject(name) && logged) await folder.persist();
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
        if (harness.log.length !== before || outcome.ok) await folder.persist();
        await folder.persistCoherence();
        return outcome;
      },

      check(name, params) {
        // A folder that changed stops every write (callConfirmed), so a write is refused here, as the accept would refuse it, and no
        // question is asked for it.
        if (folder.changed && changesProject(name)) return notMadeError(name, folder.stoppedError(false));
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
      persist: () => folder.persist(),
      verifyFolder: () => folder.verifyFolder(),
      close: () => folder.close(),
      releaseLockSync: () => folder.releaseLockSync(),
    };
  } catch (error) {
    await folder.close();
    throw error;
  }
}
