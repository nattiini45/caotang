/**
 * Recovery from the MCP server — project-format §5, extensibility §9, docs/decisions.md ("An MCP host's elicitation dialog…").
 *
 * A folder whose `caotang.json` will not load used to end the server at start. Now `openProjectOrOffer` keeps the folder's lock and walks
 * the store's ladder (`recoverProject`, read-only), and the server starts in a degraded state that offers exactly two tools:
 *
 *   - `project.recover` (read) shows the offer: the source file, what is lost, and whether it needs its own yes.
 *   - `project.recoverApply` (write-confirm, only with `--allow-writes`) applies it, through the same confirmation round trip every other
 *     write uses. The host's dialog is the writer's yes, and it is worded from the offer: it names the exact source file and the whole
 *     loss list, and no title or document content. A rebuild is a second, separate confirmation (`rebuild: true`), because the
 *     arguments are part of what a yes is bound to, and a snapshot restore's yes never covers it.
 *
 * Every other tool is refused as a tool result. A manifest this build refuses outright (another app's, or a newer format:
 * `ProjectRefusedError`) is not offered a ladder, as in the app. No command-line flag is a yes.
 *
 * The folder is checked against what the offer read before anything is written: the text of `caotang.json`, and a digest of every document
 * and codex file. A change by another program, at the offer or at the accept, writes nothing and names the files. The server then holds
 * no project: it releases the lock and every tool answers that it must be restarted (the tool list is fixed, `tools.listChanged` is false).
 */

import { resolve } from 'node:path';

import type { CommandError } from '@caotang/bus';
import { MCP_VOICE, NodeArtifactFs, acquireProjectLock, manifestOnDisk, type ProjectLock } from '@caotang/sdk/folder';
import {
  ManifestUnreadableError,
  ProjectRefusedError,
  ProjectValidationError,
  changesInWords,
  commitRecovery,
  digestOfFile,
  driftOf,
  hasDrift,
  isTransientFileError,
  projectFileDigests,
  recoverProject,
  type RecoveryOffer,
  type RecoverySource,
} from '@caotang/store';
import type { CallToolResult, InputRequiredResult, McpServer, ServerContext } from '@modelcontextprotocol/server';

import type { RoundRuntime, Structured } from './tools.js';
import { advertisedSchema, confirmRound, refusal as refusalResult } from './tools.js';
import { openProject, type OpenProjectOptions, type ProjectSession } from './session.js';

/** Why the manifest did not load: it would not parse, or its fields failed the schema. */
export type DegradedCause = 'unreadable' | 'invalid';

/**
 * Where a recovery stands. `offered`: nothing written, the offer stands. `applying`: the commit is under way. `recovered`: the new
 * manifest is written and the lock is released. `failed`: the commit stopped part way, so the folder may be partly changed.
 */
export type RecoveryPhase = 'offered' | 'applying' | 'recovered' | 'failed';

/** What the ladder found for the folder: an offer to apply, or the attempts that found nothing. */
export type RecoveryFound = { readonly offer: RecoveryOffer } | { readonly attempts: readonly string[] };

/** What `apply` came to: written, or stopped because another program changed the folder since the offer was read. */
export type RecoveryApplied = { readonly kind: 'done'; readonly preservedAs: string | undefined } | { readonly kind: 'drift'; readonly cause: string };

/** A project folder that would not open, held for a recovery. It holds the folder's lock until the recovery is applied or the server stops. */
export interface DegradedSession {
  readonly degraded: true;
  readonly root: string;
  readonly fs: NodeArtifactFs;
  readonly allowWrites: boolean;
  readonly cause: DegradedCause;
  /** What the unreadable manifest was, for the operator's line: the store's own message. Never sent to a caller. */
  readonly problem: string;
  readonly found: RecoveryFound;
  readonly phase: RecoveryPhase;
  /**
   * What the folder holds now against what the offer read, in words (`changed the document “X”`), or `undefined` when it is as the offer
   * read it. Nothing is written or changed here.
   */
  folderDrift(): Promise<string | undefined>;
  /** Checks the folder, then writes the recovery. The phase is set before anything awaits, so a second accept of the same round finds it. */
  apply(): Promise<RecoveryApplied>;
  close(): Promise<void>;
  releaseLockSync(): void;
}

/** Whether a session is the degraded one. */
export function isDegraded(session: ProjectSession | DegradedSession): session is DegradedSession {
  return 'degraded' in session;
}

/** The errors that mean "this caotang.json will not load", where the ladder applies. A manifest this build refuses outright is not one. */
function isUnreadableManifest(error: unknown): boolean {
  if (error instanceof ProjectRefusedError) return false;
  return error instanceof ManifestUnreadableError || error instanceof ProjectValidationError;
}

/** The file the unreadable manifest is kept as, spelled as a pattern: the name is stamped when the commit writes it. */
const CORRUPT_COPY = 'caotang.json.corrupt-<timestamp>';

/** The honest bound of a folder with nothing to recover from, in the app's own words. */
const UNRECOVERABLE =
  'Caotang could not find a readable copy of this project. caotang.json cannot be read, and there is no backup or document file to rebuild it from';

/** The file a recovery reads the project from, or `undefined` for a rebuild, which reads the document and codex files. */
export function sourceFileOf(source: RecoverySource): string | undefined {
  return source.kind === 'rebuild' ? undefined : source.path;
}

/** The source in words, naming the exact file. */
export function sourceWords(source: RecoverySource): string {
  switch (source.kind) {
    case 'manifest':
      return source.path;
    case 'snapshot':
      return `${source.path} (${source.generation === 1 ? 'the newest snapshot' : `snapshot generation ${source.generation}`} of caotang.json)`;
    case 'legacy-snapshot':
      return `${source.path} (the legacy single-generation snapshot of caotang.json)`;
    case 'rebuild':
      return 'a rebuild from the front matter of the document and codex files';
  }
}

/** The digest of one file, or `undefined` when it is gone. A hold that outlasts the retries reads as a file the folder does not hold, which is a change. */
async function digestAt(fs: NodeArtifactFs, path: string): Promise<string | undefined> {
  try {
    return await digestOfFile(fs, path);
  } catch (error) {
    if (isTransientFileError(error)) return undefined;
    throw error;
  }
}

function describeProblem(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Opens the folder as a project, or, when its `caotang.json` will not load, as a recovery to offer. The strict open (`openProject`) is
 * tried first and is unchanged. Only `ManifestUnreadableError` and `ProjectValidationError` take the ladder; a `ProjectRefusedError`, a
 * missing manifest and a folder held by another writer are raised as they always were.
 */
export async function openProjectOrOffer(options: OpenProjectOptions): Promise<ProjectSession | DegradedSession> {
  try {
    return await openProject(options);
  } catch (error) {
    if (!isUnreadableManifest(error)) throw error;
    return openDegraded(options, error instanceof ManifestUnreadableError ? 'unreadable' : 'invalid', describeProblem(error));
  }
}

async function openDegraded(options: OpenProjectOptions, cause: DegradedCause, problem: string): Promise<ProjectSession | DegradedSession> {
  const now = options.now ?? (() => new Date());
  const root = resolve(options.root);
  // The strict open released the lock when it failed. Taking it again is refused as it always is if another writer got there first.
  const lock = await acquireProjectLock(root, now());
  try {
    const fs = new NodeArtifactFs(root);
    // The digests are read before the ladder, as the open reads them before the project, so a change made while the ladder reads is a
    // change the accept sees.
    const digests = await projectFileDigests(fs, (path) => digestAt(fs, path));
    const result = await recoverProject(fs, { now: now() });
    if (result.status === 'ok' && result.offer.source.kind === 'manifest') {
      // caotang.json reads now: another program repaired it between the open and the ladder. There is nothing to recover.
      await lock.release();
      return await openProject(options);
    }
    const found: RecoveryFound = result.status === 'unrecoverable' ? { attempts: result.attempts } : { offer: result.offer };
    return degraded({ root, fs, lock, digests, found, cause, problem, allowWrites: options.allowWrites, report: options.report, now });
  } catch (error) {
    await lock.release();
    throw error;
  }
}

interface DegradedParts {
  readonly root: string;
  readonly fs: NodeArtifactFs;
  readonly lock: ProjectLock;
  readonly digests: ReadonlyMap<string, string>;
  readonly found: RecoveryFound;
  readonly cause: DegradedCause;
  readonly problem: string;
  readonly allowWrites: boolean;
  readonly report: ((line: string) => void) | undefined;
  readonly now: () => Date;
}

function degraded(parts: DegradedParts): DegradedSession {
  const { fs, lock, digests, found, now } = parts;
  const offer = 'offer' in found ? found.offer : undefined;
  let phase: RecoveryPhase = 'offered';
  const say = parts.report ?? ((line: string) => void process.stderr.write(`${line}\n`));

  const folderDrift = async (): Promise<string | undefined> => {
    if (offer === undefined) return undefined;
    // The baseline is the text the ladder read; a folder with no manifest reads as the empty text, so only a file that appeared is a change.
    const baseline = offer.corruptManifest?.contents ?? '';
    if (((await manifestOnDisk(fs)) ?? '') !== baseline) return 'changed or removed caotang.json';
    const drift = driftOf(digests, await projectFileDigests(fs, (path) => digestAt(fs, path)));
    return hasDrift(drift) ? changesInWords(drift, offer.state, new Map(), MCP_VOICE.holder) : undefined;
  };

  return {
    degraded: true,
    root: parts.root,
    fs,
    allowWrites: parts.allowWrites,
    cause: parts.cause,
    problem: parts.problem,
    found,
    get phase() {
      return phase;
    },
    folderDrift,
    async apply() {
      if (offer === undefined || phase !== 'offered') throw new Error('there is no recovery to apply');
      // The phase is set before anything awaits: a second accept of the same round finds a recovery under way, and waits for its answer.
      phase = 'applying';
      let changed: string | undefined;
      try {
        changed = await folderDrift();
      } catch (error) {
        phase = 'offered';
        throw error;
      }
      if (changed !== undefined) {
        phase = 'offered';
        return { kind: 'drift', cause: changed };
      }
      let commit;
      try {
        commit = await commitRecovery(fs, offer, { now: now() });
      } catch (error) {
        // A commit that failed part way may have written the preserved copy or removed caotang.json. The lock stays, and the next start offers the ladder again.
        phase = 'failed';
        throw error;
      }
      phase = 'recovered';
      await lock.release().catch(() => undefined);
      say(
        `caotang-mcp: recovered the project from ${sourceWords(offer.source)}` +
          `${commit.preservedAs === undefined ? '' : `; the unreadable caotang.json is kept as ${commit.preservedAs}`}; the lock is released: restart caotang-mcp to open it`,
      );
      return { kind: 'done', preservedAs: commit.preservedAs };
    },
    close: () => lock.release(),
    releaseLockSync: () => lock.releaseSync(),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Words: the refusals, the question, and the instructions. All of them are worded from the offer and carry no title or document text.
// ---------------------------------------------------------------------------------------------------------------------------------

export const RECOVER_TOOL = 'project.recover';
export const RECOVER_APPLY_TOOL = 'project.recoverApply';

/** What the offer is, in one clause for a startup line or an instruction. */
export function offerClause(session: DegradedSession): string {
  if (!('offer' in session.found)) return UNRECOVERABLE;
  const { offer } = session.found;
  return offer.requiresConsent
    ? `caotang.json cannot be read, and no snapshot of it can: a rebuild from the document and codex files is possible, and it loses the folder structure and the vocabulary`
    : `caotang.json cannot be read; ${sourceWords(offer.source)} can be restored`;
}

/** How a writer goes on from here, for the operator's lines and for the instructions. */
export function wayForward(session: DegradedSession): string {
  if (!('offer' in session.found)) return 'open the folder in Caotang to look at it, or put a readable caotang.json back and start caotang-mcp again';
  if (!session.allowWrites) {
    return `call ${RECOVER_TOOL} to see the offer; to apply it, open the folder in Caotang or restart caotang-mcp with --allow-writes`;
  }
  return `call ${RECOVER_TOOL} to see the offer, then ${RECOVER_APPLY_TOOL}, which asks you to confirm in the host before it writes anything`;
}

/** The refusal of a tool this degraded server does not run, in each phase. */
export function unavailableError(session: DegradedSession, name: string): CommandError | undefined {
  const phase = session.phase;
  if (phase === 'recovered') {
    return {
      code: 'permission-denied',
      message: `recovered; restart or reconnect the server to open the project. "${name}" was not run.`,
      correctiveHint: 'restart caotang-mcp (or reconnect the host, which starts it again), then read the project',
      target: name,
    };
  }
  if (phase === 'failed') {
    return {
      code: 'io-error',
      message: `the recovery did not finish, so the folder may be partly changed. "${name}" was not run.`,
      correctiveHint: 'restart caotang-mcp, which offers the recovery again, or open the folder in Caotang',
      target: name,
    };
  }
  if (name === RECOVER_TOOL) return undefined;
  if (name === RECOVER_APPLY_TOOL) {
    if (!('offer' in session.found)) {
      return {
        code: 'not-found',
        message: `there is nothing to recover from: ${UNRECOVERABLE}. "${name}" was not run.`,
        correctiveHint: 'tell the user what the message says; they can open the folder in Caotang to look at it',
        target: name,
      };
    }
    if (!session.allowWrites) {
      return {
        code: 'permission-denied',
        message: `"${name}" writes, and this server is read-only, so it is not exposed and nothing was written. Restart caotang-mcp with --allow-writes to apply the recovery from this host, or open the folder in Caotang.`,
        correctiveHint: 'do not retry it from here: tell the user the recovery needs --allow-writes or the desktop app',
        target: name,
        risk: 'write-confirm',
      };
    }
    return undefined;
  }
  return {
    code: 'permission-denied',
    message: `this project could not be opened; recover it first. "${name}" was not run: ${offerClause(session)}.`,
    correctiveHint: wayForward(session),
    target: name,
  };
}

/**
 * The guard's refusal for a tool call on a degraded server. The two recovery tools reach their handlers once the recovery is written, so
 * that a replay of an accepted retry is answered from the ledger (confirm.ts); every other name is refused here.
 */
export function guardDegraded(session: DegradedSession, name: string): CommandError | undefined {
  if (session.phase === 'recovered' && (name === RECOVER_TOOL || name === RECOVER_APPLY_TOOL)) return undefined;
  return unavailableError(session, name);
}

/** The initialize instructions of a degraded server: the project is not open, and what to do about it. */
export function degradedInstructions(session: DegradedSession): string {
  return (
    `The Caotang project in this folder could not be opened, so none of the project tools are available: ${offerClause(session)}. ` +
    `The only tools are ${RECOVER_TOOL}${session.allowWrites && 'offer' in session.found ? ` and ${RECOVER_APPLY_TOOL}` : ''}. ` +
    `${wayForward(session)}. This server holds the folder's lock until it stops. A refused call says why, and the corrective step is in the refusal.`
  );
}

/**
 * The question the host shows for a recovery, from the offer alone. It names the exact source file, the copy the unreadable manifest is
 * kept as, the whole loss list, and the lock; it never names a title or carries document text.
 */
export function recoveryQuestion(offer: RecoveryOffer): string {
  const rebuild = offer.source.kind === 'rebuild';
  const head = rebuild
    ? 'rebuild this project from the front matter of its document and codex files, because caotang.json and every snapshot of it cannot be read'
    : `restore this project from ${sourceWords(offer.source)}, because caotang.json cannot be read`;
  const documents = `${offer.recoveredDocuments.length} ${offer.recoveredDocuments.length === 1 ? 'document file' : 'document files'}`;
  const codex = `${offer.recoveredCodex.length} ${offer.recoveredCodex.length === 1 ? 'codex file' : 'codex files'}`;
  const files = rebuild
    ? `${documents} and ${codex} become the documents and codex entries of the rebuilt project`
    : `${documents} and ${codex} that the snapshot does not name are imported as recovered items`;
  const parts = [
    head,
    `The unreadable caotang.json is kept as ${CORRUPT_COPY}, and the recovered project is written as the new caotang.json`,
    ...(rebuild || offer.recoveredDocuments.length + offer.recoveredCodex.length > 0 ? [files] : []),
    ...(offer.loss.length === 0 ? [] : [`What a rebuild loses: ${offer.loss.join(' ')}`]),
    'This server holds the folder lock, so Caotang cannot open the project at the same time, and the server must be restarted afterwards',
  ];
  return parts.join('. ');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The two tools.
// ---------------------------------------------------------------------------------------------------------------------------------

/** The runtime of a degraded server: the recovery it offers, and the confirmation machinery. */
export interface RecoveryRuntime extends RoundRuntime {
  readonly recovery: DegradedSession;
}

function resultOf(summary: string, data: Structured): CallToolResult {
  const body: Structured = { summary, data };
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
}

/** The offer as `project.recover` shows it. It carries file names and counts, never the unreadable manifest's bytes or a document's text. */
function recoverResult(session: DegradedSession): CallToolResult {
  const { found } = session;
  if (!('offer' in found)) {
    return resultOf(`${UNRECOVERABLE}.`, { status: 'unrecoverable', attempts: [...found.attempts], canApply: false, nextStep: wayForward(session) });
  }
  const { offer } = found;
  const sourceFile = sourceFileOf(offer.source);
  return resultOf(
    `${offerClause(session)}. ${offer.requiresConsent ? 'A rebuild needs its own confirmation.' : 'Applying it asks the user to confirm.'}`,
    {
      status: 'offer',
      source: { ...offer.source, ...(sourceFile === undefined ? {} : { file: sourceFile }) },
      requiresConsent: offer.requiresConsent,
      loss: [...offer.loss],
      preservedAs: CORRUPT_COPY,
      recoveredDocuments: offer.recoveredDocuments.length,
      recoveredCodexEntries: offer.recoveredCodex.length,
      encodingIssues: offer.encodingIssues.map((issue) => ({ file: issue.path, kind: issue.kind })),
      canApply: session.allowWrites,
      nextStep: wayForward(session),
    },
  );
}

/** The arguments of `project.recoverApply`, checked: only `rebuild`, and only a boolean. */
function rebuildOf(params: Structured, name: string): { readonly rebuild: boolean } | CommandError {
  for (const key of Object.keys(params)) {
    if (key !== 'rebuild') {
      return {
        code: 'invalid-params',
        message: `"${name}" takes no "${key}": its only argument is rebuild.`,
        correctiveHint: 'call it with {} to restore a snapshot, or {"rebuild": true} to rebuild',
        target: key,
      };
    }
  }
  const value = params['rebuild'];
  if (value !== undefined && typeof value !== 'boolean') {
    return { code: 'invalid-params', message: `"rebuild" must be true or false.`, correctiveHint: 'send rebuild as a boolean', target: 'rebuild' };
  }
  return { rebuild: value === true };
}

/** The refusal of a call whose `rebuild` does not match what the offer is, or `undefined` when it does. */
function mismatchOf(offer: RecoveryOffer, rebuild: boolean, name: string): CommandError | undefined {
  if (offer.requiresConsent && !rebuild) {
    return {
      code: 'invalid-params',
      message:
        `"${name}" would rebuild this project from its document and codex files, because caotang.json and every snapshot of it cannot be read. ` +
        `A rebuild loses: ${offer.loss.join(' ')} It needs its own confirmation, and nothing was written.`,
      correctiveHint: `to ask for it, call ${name} with {"rebuild": true}; the user is asked to confirm the rebuild and the loss. Otherwise open the folder in Caotang`,
      target: 'rebuild',
    };
  }
  if (!offer.requiresConsent && rebuild) {
    return {
      code: 'invalid-params',
      message: `this recovery restores ${sourceWords(offer.source)}; it is not a rebuild, so rebuild: true does not apply. Nothing was written.`,
      correctiveHint: `call ${name} with {}`,
      target: 'rebuild',
    };
  }
  return undefined;
}

/** What `project.recoverApply` tells the caller after the write. */
function appliedResult(offer: RecoveryOffer, preservedAs: string | undefined): CallToolResult {
  return resultOf(
    `Recovered the project from ${sourceWords(offer.source)}. ` +
      `${preservedAs === undefined ? '' : `The unreadable caotang.json is kept as ${preservedAs}. `}` +
      'The server released the folder lock and holds no project: restart or reconnect the server to open it.',
    {
      status: 'recovered',
      source: offer.source,
      ...(preservedAs === undefined ? {} : { preservedAs }),
      restartRequired: true,
    },
  );
}

function driftRefusal(name: string, cause: string): CommandError {
  return {
    code: 'io-error',
    message: `"${name}" was not made: the folder changed since the recovery was offered, because another program ${cause}. Nothing was written.`,
    correctiveHint: 'restart caotang-mcp, which reads the folder and offers the recovery again',
    target: name,
  };
}

/** One `project.recoverApply` call, across its rounds: the checks, the question, and the write. */
function runRecoverApply(
  server: McpServer,
  params: Structured,
  ctx: ServerContext,
  runtime: RecoveryRuntime,
  waitSeconds: number | undefined,
): Promise<CallToolResult | InputRequiredResult> {
  const name = RECOVER_APPLY_TOOL;
  const { recovery } = runtime;
  const offer = 'offer' in recovery.found ? recovery.found.offer : undefined;
  return confirmRound(
    server,
    ctx,
    runtime,
    {
      name,
      params,
      async prepare() {
        // After the accept (applying, recovered, failed) the folder is the recovery's own, and the check below answers. Before it, the
        // folder is checked here, before the host is asked, so no dialog is shown for a recovery that would be refused.
        if (recovery.phase !== 'offered') return undefined;
        try {
          const cause = await recovery.folderDrift();
          return cause === undefined ? undefined : refusalResult(driftRefusal(name, cause));
        } catch (error) {
          return refusalResult({
            code: 'io-error',
            message: `"${name}" was not made: the project folder could not be read (${error instanceof Error ? error.name : 'Error'}). Nothing was written.`,
            correctiveHint: 'make sure the project folder can be read, then ask again',
            target: name,
          });
        }
      },
      check() {
        const unavailable = unavailableError(recovery, name);
        if (unavailable !== undefined) return unavailable;
        if (recovery.phase !== 'offered') {
          return { code: 'permission-denied', message: `a recovery is being applied. "${name}" was not run.`, target: name };
        }
        const args = rebuildOf(params, name);
        if ('code' in args) return args;
        return offer === undefined ? undefined : mismatchOf(offer, args.rebuild, name);
      },
      elsewhere: 'open the folder in the Caotang desktop app, which recovers it with the same consent',
      summary: () => (offer === undefined ? 'recover this project' : recoveryQuestion(offer)),
      async apply() {
        try {
          const applied = await recovery.apply();
          if (applied.kind === 'drift') return refusalResult(driftRefusal(name, applied.cause));
          return offer === undefined ? resultOf('Recovered.', { status: 'recovered', restartRequired: true }) : appliedResult(offer, applied.preservedAs);
        } catch (error) {
          const partly = recovery.phase === 'failed';
          return refusalResult({
            code: 'io-error',
            message: partly
              ? `Caotang could not finish the recovery (${errorCode(error)}), so the folder may be partly changed. The unreadable caotang.json is kept as ${CORRUPT_COPY} when it was set aside.`
              : `"${name}" was not made: the project folder could not be read (${errorCode(error)}). Nothing was written.`,
            correctiveHint: partly
              ? 'restart caotang-mcp, which offers the recovery again, or open the folder in Caotang'
              : 'make sure the project folder can be read, then ask again',
            target: name,
          });
        }
      },
    },
    waitSeconds,
  );
}

/** The class of a failure as the operating system reports it, or the error's own name: never its message, which carries a path. */
function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.name : 'Error';
}

/**
 * Registers the degraded server's tools: `project.recover`, and with writes on and an offer to apply, `project.recoverApply`. Returns
 * the names registered. Every other name is refused before the SDK sees it (guard.ts, `unavailableError`).
 */
export function registerRecoveryTools(server: McpServer, runtime: RecoveryRuntime, roundWaitMs?: number): readonly string[] {
  const waitSeconds = roundWaitMs === undefined ? undefined : Math.ceil(roundWaitMs / 1000);
  const { recovery } = runtime;
  const registered: string[] = [RECOVER_TOOL];

  server.registerTool(
    RECOVER_TOOL,
    {
      description:
        'Shows what recovering this project would do. The project could not be opened because caotang.json cannot be read. ' +
        'Returns the file a recovery would restore from (a snapshot of caotang.json) or that it would rebuild from the document and codex files, what a rebuild loses, ' +
        'and whether it needs its own confirmation. Writes nothing.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: advertisedSchema({ type: 'object', properties: {}, additionalProperties: false }),
    },
    (): CallToolResult => {
      const unavailable = unavailableError(recovery, RECOVER_TOOL);
      return unavailable === undefined ? recoverResult(recovery) : refusalResult(unavailable);
    },
  );

  if (recovery.allowWrites && 'offer' in recovery.found) {
    server.registerTool(
      RECOVER_APPLY_TOOL,
      {
        description:
          'Requires user confirmation. Applies the recovery that project.recover shows: restores the project from the snapshot it names, or rebuilds it from the document and codex files. ' +
          'The unreadable caotang.json is kept as caotang.json.corrupt-<timestamp>. A rebuild loses the folder structure and the vocabulary, so it needs rebuild: true and its own confirmation. ' +
          'Nothing is written unless the user accepts. Afterwards the server holds no project: restart or reconnect it to open the recovered one.',
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        inputSchema: advertisedSchema({
          type: 'object',
          properties: { rebuild: { type: 'boolean', description: 'Set to true to rebuild the project from its document and codex files. Only for a rebuild offer.' } },
          additionalProperties: false,
        }),
      },
      (args: Structured, ctx: ServerContext): Promise<CallToolResult | InputRequiredResult> =>
        runRecoverApply(server, args ?? {}, ctx, runtime, waitSeconds),
    );
    registered.push(RECOVER_APPLY_TOOL);
  }
  return registered;
}
