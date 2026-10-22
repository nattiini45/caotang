/**
 * The harness registry, as MCP tools — extensibility.md §7 (outward) and §9.
 *
 * Every tool the harness declares is registered under its own name, with the
 * description and annotations the harness's registry-to-MCP mapping produces
 * (`mcpExposure`), and with the harness's own JSON Schema advertised unchanged. The
 * schema is only advertised: a call is validated by the harness, which refuses an
 * unknown key or a bad value with a model-facing message. A Standard Schema that
 * passed every value through would hide that message behind the SDK's, so the
 * `validate` here is the identity.
 *
 * A read and an auto-applied write run as an external caller (`callDirect`). A
 * write-confirm tool runs through the confirmation round trip in `confirm.ts`, and
 * only after the user accepted it. Nothing else reaches the harness. Every refusal is
 * returned as a tool result with `isError` set, so a model reads it the way it reads
 * any other harness refusal.
 */

import { randomUUID } from 'node:crypto';

import { err, type CommandError } from '@caotang/bus';
import { newId } from '@caotang/ids';
import { mcpExposure, type JsonSchema, type ToolListing, type ToolOutcome } from '@caotang/harness';
import type {
  CallToolResult,
  ClientCapabilities,
  InputRequiredResult,
  McpServer,
  ServerContext,
  StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { CLIENT_CAPABILITIES_META_KEY, inputRequired, inputResponse } from '@modelcontextprotocol/server';
import type { RequestStateCodec } from '@modelcontextprotocol/server';

import {
  argsDigest,
  codexEntryNameOf,
  CONFIRM_KEY,
  CONFIRMATION_SCHEMA,
  confirmationMessage,
  confirmationSummary,
  ROUND_TTL_SECONDS,
  titleOfNode,
  type ConfirmLedger,
  type RoundState,
} from './confirm.js';
import { FolderChangedError } from '@caotang/sdk/folder';

import { notMadeError, type ProjectSession } from './session.js';
import { projectFileLabel, projectFileTitles } from '@caotang/store';

/** Everything a tool needs to run: the open project, and the confirmation machinery. */
export interface ToolRuntime {
  readonly session: ProjectSession;
  readonly codec: RequestStateCodec<RoundState>;
  readonly ledger: ConfirmLedger;
}

/** A value the harness can return in the tool result, as the MCP `structuredContent` object. */
export type Structured = Record<string, unknown>;

/** The advertised Standard Schema: the harness's own JSON Schema, and a pass-through validate. */
export function advertisedSchema(schema: JsonSchema): StandardSchemaWithJSON<Structured, Structured> {
  const json: Record<string, unknown> = { ...schema };
  return {
    '~standard': {
      version: 1,
      vendor: 'caotang',
      validate: (value: unknown) => ({ value: (value ?? {}) as Structured }),
      jsonSchema: {
        input: () => json,
        output: () => json,
      },
    },
  };
}

/** A harness outcome as a tool result: the value as text and as structured content, or the refusal with `isError` set. */
export function toCallResult(outcome: ToolOutcome): CallToolResult {
  if (outcome.ok) {
    const { summary, data, affected, undoGroupId, notes } = outcome.value;
    const body: Structured = {
      summary,
      data,
      affected,
      ...(undoGroupId === undefined ? {} : { undoGroupId }),
      ...(notes === undefined ? {} : { notes }),
    };
    return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body };
  }
  const error: Structured = { ...outcome.error };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error }) }],
    structuredContent: { error },
  };
}

export function refusal(error: CommandError): CallToolResult {
  return toCallResult(err(error));
}

/** The result for a confirmation the user did not give: the call completed, and the project did not change. */
export function notWritten(name: string, status: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `${name} was ${status}: nothing was written.` }],
    structuredContent: { status, written: false, tool: name },
  };
}

/** The result when the project could not be saved after a write. The change is in memory, and the folder may be behind. */
function unsaved(name: string, reason: string): CallToolResult {
  return refusal({
    code: 'io-error',
    message: `Caotang could not finish saving the project folder after "${name}" (${reason}). The change is applied in memory and may not be on disk; restart caotang-mcp to reload the folder before relying on it.`,
    correctiveHint: 'restart caotang-mcp and read the project again before making another change',
    target: name,
  });
}

/**
 * The result for a write that was made in memory and then not saved because the folder changed, or that was saved and then
 * overtaken by another program's change to caotang.json. The folder error already says what happened to the change and what to do,
 * so the result says it once, and its lead-in does not deny a save that happened.
 */
function changedAfterWrite(name: string, error: FolderChangedError): CommandError {
  const lead = error.saved ? `"${name}" was saved, but` : `Caotang could not finish saving "${name}":`;
  return {
    code: 'io-error',
    message: `${lead} ${error.message}`,
    correctiveHint: 'restart caotang-mcp and read the project again before making another change',
    target: name,
  };
}

/**
 * The result for a write that did not succeed. A write the folder's change stopped before it
 * began says that nothing was written. A write that was made and then not saved is `changedAfterWrite`
 * when the folder changed, and `unsaved` for any other failure.
 */
function failed(name: string, error: unknown, session: ProjectSession): CallToolResult {
  if (error instanceof FolderChangedError) return refusal(error.applied ? changedAfterWrite(name, error) : notMadeError(name, error));
  return unsaved(name, reason(error, session));
}

/**
 * A failure in words for the caller: its class, and the file it hit named by its title. A raw
 * error message carries the machine's own path to that file, and a refusal names a file by its
 * title and name, never by path or id (§4 rule 5). The words come from the state the session
 * holds, so a document the call named is named for the reader by the words they know it by.
 */
function reason(error: unknown, session: ProjectSession): string {
  const kind = errorCodeOf(error);
  const label = fileLabelOf(error, session);
  return label === undefined ? kind : `${kind}, on ${label}`;
}

/** The class of a failure, as the operating system reports it: `EISDIR`, `EACCES`, or the error's own name. */
function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.name : 'Error';
}

/**
 * The project file a failure named, in the store's words, or `undefined` when the error names
 * none. The path is read out of the message only to find the file's id; the words that come back
 * are the store's own, so no path and no id reaches the caller.
 */
function fileLabelOf(error: unknown, session: ProjectSession): string | undefined {
  const texts = error instanceof Error ? [error.message, error.stack ?? ''] : [String(error)];
  // An error names the file by its absolute path, and a project file sits directly in `docs/` or
  // `codex/`, so the last such segment is the project's own.
  const found = texts
    .map((text) => [...text.matchAll(/(?:^|[\s"'(\\/])((?:docs|codex)[\\/][^\\/\s"':,)]+)\.[A-Za-z0-9]+/g)].at(-1)?.[1])
    .find((candidate) => candidate !== undefined);
  if (found === undefined) return undefined;
  const titles = projectFileTitles(session.state);
  return projectFileLabel(found.replace(/\\/g, '/'), titles, titles, 'this copy');
}

/**
 * The capabilities the connected client declared for this request. On the 2026-07-28
 * revision they ride the request's own `_meta` envelope, which is the view the SDK's input
 * gate reads. The deprecated accessor is filled from that envelope only on the HTTP entry,
 * so a stdio connection has no other copy of them. On a 2025-era connection there is no
 * envelope, and the accessor holds what `initialize` declared on that connection's server
 * (over HTTP, the connection is one `legacy-sessions.ts` keeps for its session id).
 */
function declaredCapabilities(server: McpServer, ctx: ServerContext): ClientCapabilities | undefined {
  const envelope = ctx.mcpReq.envelope as Readonly<Record<string, unknown>> | undefined;
  return (envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined) ?? server.server.getClientCapabilities();
}

/** Whether the declared capabilities allow the form a confirmation asks for: an elicitation with a form, or one that names no mode, which means a form. */
function canAnswerForm(capabilities: ClientCapabilities | undefined): boolean {
  const elicitation = capabilities?.elicitation;
  if (elicitation === undefined) return false;
  return elicitation.form !== undefined || Object.keys(elicitation).length === 0;
}

/**
 * The turn and call an external request is held under. A new pair per request: the
 * server keeps no session, so a request is its own turn, and a confirmation carries
 * its pair through the round trip in the sealed state.
 */
function newTurnId(): string {
  return newId('cmd');
}

async function runDirect(runtime: ToolRuntime, name: string, params: Structured): Promise<CallToolResult> {
  const turnId = newTurnId();
  const callId = newId('cmd');
  try {
    // The empty-project note is the harness's own, chosen for the caller's write mode (harness tools/reads.ts), so it is not rewritten here.
    const outcome = await runtime.session.callDirect(name, callId, params, turnId);
    return toCallResult(outcome);
  } catch (error) {
    return failed(name, error, runtime.session);
  }
}

/**
 * Runs an accepted write and resolves to what the caller is told. The harness applies the change
 * synchronously when this is called, and only the save is awaited, so the ledger can hold the answer
 * as soon as the call returns.
 */
async function applyConfirmed(runtime: ToolRuntime, name: string, bound: RoundState, params: Structured): Promise<CallToolResult> {
  try {
    return toCallResult(await runtime.session.callConfirmed(name, bound.callId, params, bound.turnId));
  } catch (error) {
    return failed(name, error, runtime.session);
  }
}

/** The confirmation machinery a round needs, and nothing of the project: the sealed state's codec and the replay ledger. */
export interface RoundRuntime {
  readonly codec: RequestStateCodec<RoundState>;
  readonly ledger: ConfirmLedger;
}

/** What one write-confirm call supplies to its rounds: the checks before the question, the question, and the write after a yes. */
export interface ConfirmHooks {
  readonly name: string;
  readonly params: Structured;
  /** Where the change can be made when this host cannot be asked, in place of "inside Caotang". */
  readonly elsewhere?: string;
  /** Checks that await, run before the ledger is read. A result stops the call with it; nothing is asked. */
  prepare(): Promise<CallToolResult | undefined>;
  /** The refusal the accept would return, found with no effect, or `undefined` when the call would be accepted. Synchronous, so nothing awaits between the ledger read and the write. */
  check(): CommandError | undefined;
  /** The change, in words, for the question. */
  summary(): string;
  /** Runs an accepted call and resolves to what the caller is told. It starts its write before it returns its promise. */
  apply(bound: RoundState): Promise<CallToolResult>;
}

/** One write-confirm call, across its rounds. See confirm.ts for why each step is needed. */
export async function confirmRound(
  server: McpServer,
  ctx: ServerContext,
  runtime: RoundRuntime,
  hooks: ConfirmHooks,
  waitSeconds: number | undefined,
): Promise<CallToolResult | InputRequiredResult> {
  const { name, params } = hooks;
  const digest = argsDigest(name, params);
  const round = ctx.mcpReq.requestState<RoundState>();
  const bound = round !== undefined && round.tool === name && round.digest === digest ? round : undefined;
  const reply = inputResponse(ctx.mcpReq.inputResponses, CONFIRM_KEY);
  const accepted = bound !== undefined && reply.kind === 'elicit' && reply.action === 'accept' && reply.content?.['confirmed'] === true;

  // This await comes before the ledger is read, not after it: of two accepts of one round, the second must find the first's answer in
  // the ledger with nothing awaited between that read and the write.
  const stopped = await hooks.prepare();
  if (stopped !== undefined) return stopped;

  // A replay of an accepted retry is answered first, from the ledger. The first accept has already changed the project, so the same
  // arguments may no longer check against it (a codex create whose name the first accept took), and a refusal here would tell the agent
  // to rename and create again. The replay gets the first answer, and writes nothing.
  if (bound !== undefined && accepted) {
    const replay = runtime.ledger.recall(bound.nonce, Date.now());
    if (replay !== undefined) return replay;
  }

  // The arguments are checked before the host is asked. A dialog that asks for a change which the accept would refuse misleads the
  // person, so the refusal the accept would return comes back now: nothing is asked, and nothing is written.
  const invalid = hooks.check();
  if (invalid !== undefined) return refusal(invalid);
  const declared = declaredCapabilities(server, ctx);
  if (!canAnswerForm(declared)) {
    // Undefined means this request shows no capabilities at all: a request with no session id, on the stateless leg, which
    // never saw an `initialize`. A 2025-era connection that did see one keeps its capabilities on its own server (see
    // legacy-sessions.ts), so this is not a host that declared nothing. The refusal names the two routes that can ask:
    // initialize over this endpoint and keep the session id it returns, or the same server over stdio.
    const unseen = declared === undefined;
    const why = unseen
      ? 'this request shows no session, so Caotang cannot see the capabilities the client declared, and cannot ask you'
      : 'this client did not declare elicitation support, so Caotang cannot ask you';
    return refusal({
      code: 'permission-denied',
      message: `"${name}" needs your confirmation, and ${why}. Nothing was written.`,
      correctiveHint: unseen
        ? `to confirm writes from this host, send initialize over this endpoint and make the call on the Mcp-Session-Id it returns, or connect over stdio (caotang-mcp serve --stdio --allow-writes, or the MCPB bundle)${hooks.elsewhere === undefined ? '' : `, or ${hooks.elsewhere}`}; do not retry this call without a session`
        : `use a client that supports elicitation, or ${hooks.elsewhere ?? 'make the change inside Caotang'}; do not retry the call from here`,
      target: name,
      risk: 'write-confirm',
    });
  }

  if (bound !== undefined && reply.kind === 'elicit') {
    if (accepted) {
      // Nothing awaits between the ledger read above and this write, so of two accepts of one round, the second finds the first's
      // answer, still in flight, and waits for it. The write itself starts inside `apply`, before that function returns
      // its promise.
      const now = Date.now();
      const answer = hooks.apply(bound);
      runtime.ledger.remember(bound.nonce, answer, now + ROUND_TTL_SECONDS * 1000, now);
      return answer;
    }
    const status = reply.action === 'decline' ? 'declined' : reply.action === 'cancel' ? 'cancelled' : 'not confirmed';
    return notWritten(name, status);
  }

  // No answer for these arguments yet: ask. The state carries the pair of an earlier round, when there was one.
  const turnId = bound?.turnId ?? newTurnId();
  const callId = bound?.callId ?? newId('cmd');
  const state = await runtime.codec.mint({ v: 1, tool: name, digest, turnId, callId, nonce: randomUUID() });
  return inputRequired({
    inputRequests: {
      [CONFIRM_KEY]: inputRequired.elicit({
        message: confirmationMessage(hooks.summary(), waitSeconds),
        requestedSchema: CONFIRMATION_SCHEMA,
      }),
    },
    requestState: state,
  });
}

/** One write-confirm harness tool: the round of {@link confirmRound}, with the project's own checks and write. */
function runConfirmed(
  server: McpServer,
  listing: ToolListing,
  params: Structured,
  ctx: ServerContext,
  runtime: ToolRuntime,
  waitSeconds: number | undefined,
): Promise<CallToolResult | InputRequiredResult> {
  const name = listing.name;
  const { session } = runtime;
  return confirmRound(
    server,
    ctx,
    runtime,
    {
      name,
      params,
      async prepare() {
        // The images an export names are listed now, before the check below reads them: a listing held from an earlier call may be one
        // that failed, or one that has since stopped being true.
        await session.refreshAssets();
        // The folder is checked before the host is asked, as the accept would check it (verifyFolder). A folder that changed is refused now, and
        // the host is not asked about a change the save would refuse.
        try {
          await session.verifyFolder();
        } catch (error) {
          return refusal({
            code: 'io-error',
            message: `"${name}" was not made: the project folder could not be read (${reason(error, session)}). Nothing was written.`,
            correctiveHint: 'make sure the project folder can be read, then make the change again',
            target: name,
          });
        }
        return undefined;
      },
      check: () => session.check(name, params),
      summary: () =>
        confirmationSummary(
          name,
          params,
          (id) => titleOfNode(session.state, id),
          (id) => codexEntryNameOf(session.state, id),
        ),
      apply: (bound) => applyConfirmed(runtime, name, bound, params),
    },
    waitSeconds,
  );
}

/**
 * Registers every exposed harness tool on `server`. Returns the names registered, in table order. `roundWaitMs` is the
 * deadline of a confirmation on this server's connection, when it has one; the question says so (confirm.ts).
 */
export function registerCaotangTools(server: McpServer, runtime: ToolRuntime, roundWaitMs?: number): readonly string[] {
  const waitSeconds = roundWaitMs === undefined ? undefined : Math.ceil(roundWaitMs / 1000);
  const registered: string[] = [];
  for (const listing of runtime.session.harness.tools()) {
    const exposure = mcpExposure(listing);
    if (!exposure.exposed) continue;
    // tool.search searches the tool servers that Caotang's own MCP client connects to. This server connects to none, so the
    // tool could only answer that no servers are connected, and an outside agent would plan around a dead end (§9).
    if (listing.name === 'tool.search') continue;
    // A tool whose implementation this server does not have is not advertised: listed, it
    // would refuse every call, and an outside agent would plan around a tool that cannot run.
    if (!listing.wired) continue;
    // An async-only tool awaits a model, and runs only as a step of a plan the writer approves (runtime.ts, asyncOnly). This server
    // holds no provider key, so it does not list one (coherence.md §7, the coherence.review row): listed, a write-confirm would ask
    // the user to approve a call that then refuses, with nothing run.
    if (listing.async) continue;
    if (listing.risk !== 'read' && !runtime.session.allowWrites) continue;

    server.registerTool(
      listing.name,
      {
        description: exposure.description,
        annotations: exposure.annotations,
        inputSchema: advertisedSchema(listing.schema),
      },
      async (args: Structured, ctx: ServerContext): Promise<CallToolResult | InputRequiredResult> => {
        const params: Structured = args ?? {};
        if (listing.risk === 'write-confirm') return runConfirmed(server, listing, params, ctx, runtime, waitSeconds);
        return runDirect(runtime, listing.name, params);
      },
    );
    registered.push(listing.name);
  }
  return registered;
}
