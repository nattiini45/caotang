/**
 * `mcp.invoke` — [extensibility.md §6](../../../docs/architecture/extensibility.md), the bus
 * command that carries every external tool call.
 *
 * ```
 * validate → permission gate (per call's risk) → apply (callTool) → postconditions → activity (source 'mcp')
 * ```
 *
 * **Validate is everything that can refuse before the effect**, and it is pure against the
 * client's current snapshot: the server is known, its health is past `configured`, the tool is
 * listed and enabled and loaded this turn, its pin is verified, and the arguments match its
 * schema. A refusal here is data with the model-facing text, and nothing has run.
 *
 * **The gate reads a per-call risk.** `read-auto` runs without a confirmation and `write-confirm`
 * waits for one, so the descriptor's static `agentRisk` is only the floor (`write-confirm`). The
 * bus reads it through the descriptor's `agentRiskOf`, which takes the normalized call's `risk`, so the gate
 * decides on this call's risk and not on the floor.
 *
 * **The apply is async, so it is dispatched through the bus's `executeAsync()`**, which awaits it
 * (command-bus §3). The descriptor is marked `asyncApply`, so `execute()` refuses the call before anything
 * runs and names `executeAsync`; the synchronous bus never starts the server call. The store registry carries
 * this registration, and the harness dispatches the external call through `executeAsync`.
 *
 * **A failure never comes back as a value from the registration's apply.** The bus stores whatever an
 * apply returns and reports it as a completed command, so a refused or failed call returned as
 * `{ ok: false }` would reach the model as success. The registration's apply therefore resolves with the
 * untrusted result and rejects with an {@link McpInvokeFailure} that carries the `CommandError`. The bus
 * maps that error to `err` at integration (command-bus §7); {@link applyMcpInvoke} keeps the value form for
 * callers that want the outcome directly.
 */

import type { ApplyContext, CommandApply, CommandDescriptor, CommandError, Result } from '@caotang/bus';
import { ApplyRefusal, err, ok } from '@caotang/bus';

import type { McpClient, McpToolResult, McpTransport } from './client.js';
import { McpFailure, PIN_MISMATCH_TEXT, schemaText, serverErrorText, toCommandError, unreachableText, unsupportedSchemaText, type McpError } from './errors.js';
import type { EffectiveRisk } from './risk.js';
import { validateArguments } from './schema.js';
import type { LoadedTools } from './search.js';
import { isRecord } from './util.js';

export const MCP_INVOKE_NAME = 'mcp.invoke' as const;

/** The closed set of top-level keys (command-bus §9: a key the command does not list is refused). */
const INVOKE_KEYS = ['serverKey', 'toolName', 'args', 'expectedPins'];

/** §6's params: `{ serverKey, toolName, args, expectedPins? }`. */
export interface McpInvokeParams {
  readonly serverKey: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  /** The pin hashes the caller reviewed. Given, the current hash must be one of them, or the call is refused. */
  readonly expectedPins?: readonly string[];
}

/** What validate hands the gate and the apply: the params, plus what the bus's activity row and the approval card need. */
export interface McpInvokeNormalized extends McpInvokeParams {
  readonly qualifiedName: string;
  readonly serverName: string;
  /** The candidate hash the call was validated against. */
  readonly hash: string;
  /** The per-call risk the gate reads. Never `write-auto`. */
  readonly risk: EffectiveRisk;
}

/** What a validate closes over: the client's snapshot and the turn's loaded set. It never reaches the wire. */
export interface ValidateDeps {
  readonly client: Pick<McpClient, 'serverFor' | 'describe' | 'healthOf'>;
  readonly loaded: LoadedTools;
}

/**
 * What an apply closes over. The transport is the only route to a `tools/call`, and it is held here and
 * nowhere else: the client's own surface has no call (see {@link McpTransport}).
 */
export interface InvokeDeps extends ValidateDeps {
  readonly transport: Pick<McpTransport, 'callTool' | 'relist'>;
  /** The most tokens an external answer may carry before it is refused. Defaults to {@link EXTERNAL_RESULT_TOKEN_CAP}. */
  readonly resultTokenCap?: number;
}

/**
 * The cap on one external answer, on the harness's estimate (a token is four characters, `tokens.ts`). Caotang does not
 * trim an answer to fit it: an answer over the cap is refused with the cap named, and an answer under it is verbatim (§6).
 */
export const EXTERNAL_RESULT_TOKEN_CAP = 8_000;

/** The tokens an answer's content counts as, on the same estimate the harness uses for its own caps. */
export function resultTokens(content: readonly unknown[]): number {
  return Math.ceil(JSON.stringify(content).length / 4);
}

/** The content a successful call returns, marked as the untrusted data it is (§4 rule 4). */
export interface UntrustedCallResult {
  readonly untrusted: true;
  readonly source: { readonly serverKey: string; readonly serverName: string; readonly toolName: string; readonly qualifiedName: string };
  readonly isError: boolean;
  /** The server's content blocks, verbatim. Caotang never summarises, rewrites or trims them. */
  readonly content: readonly unknown[];
}

/** The apply's answer. A failed call is an error envelope (and still has its activity row); a call that ran is data. */
export type McpInvokeOutcome = { readonly ok: true; readonly value: UntrustedCallResult } | { readonly ok: false; readonly error: CommandError };

/** The bus registration shape (command-bus §2 and §9), for `mcp.invoke` once it joins the closed name set. */
export interface McpInvokeRegistration {
  readonly descriptor: CommandDescriptor<McpInvokeNormalized>;
  /** Resolves with the untrusted result. Rejects with an {@link McpInvokeFailure} for every failure (see the module header). */
  readonly apply: CommandApply<McpInvokeNormalized, unknown>;
  /** The activity source the dispatch must carry: `execute(command, bus, registry, source)` stamps it on the row (command-bus §8). */
  readonly source: 'mcp';
}

/**
 * A failed `mcp.invoke`, carrying the bus's own error envelope. Thrown by the registration's apply, so a failure
 * is never a completed command. The message is the envelope's message, and `error` is what the bus returns.
 */
export class McpInvokeFailure extends ApplyRefusal {
  constructor(error: CommandError) {
    super(error);
    this.name = 'McpInvokeFailure';
  }
}

/**
 * Validates an `mcp.invoke` call. Pure against the client's snapshot: no network, no write.
 * The order is the order a person would check things, and each refusal names its corrective path.
 */
export function prepareInvoke(deps: ValidateDeps, params: unknown): Result<McpInvokeNormalized, CommandError> {
  const shape = parseInvokeParams(params);
  if (!shape.ok) return shape;
  const { serverKey, toolName, args, expectedPins } = shape.value;

  const server = deps.client.serverFor(serverKey);
  if (server === undefined) {
    return refuse('not-found', `no MCP server with key '${serverKey}' is configured`, toolName, 'call tool.search to find the tool under a server that is connected');
  }
  const health = deps.client.healthOf(serverKey);
  if (health === undefined || health.state === 'configured') {
    return fromMcpError({ code: 'unreachable', message: unreachableText(server.name) }, server.name, toolName);
  }
  const tool = deps.client.describe(serverKey, toolName);
  if (tool === undefined) {
    return refuse(
      'not-found',
      `'${toolName}' is not listed on server '${server.name}'`,
      toolName,
      "call tool.search for the tool's current name — the server may have renamed it",
    );
  }
  if (!tool.enabled) {
    return refuse('not-found', `'${toolName}' is disabled on server '${server.name}'`, toolName, 'ask the user to enable it in Settings › MCP & tools');
  }
  if (!deps.loaded.isLoaded(tool.qualifiedName)) {
    return refuse(
      'not-found',
      `${tool.qualifiedName} is not loaded this turn — call tool.search first`,
      toolName,
      'call tool.search, then call the tool by the qualified name it returns',
    );
  }
  if (tool.pinState !== 'verified') return fromMcpError({ code: 'pin_mismatch', message: PIN_MISMATCH_TEXT }, server.name, toolName);
  if (expectedPins !== undefined && !expectedPins.includes(tool.candidateHash)) {
    return fromMcpError({ code: 'pin_mismatch', message: PIN_MISMATCH_TEXT }, server.name, toolName);
  }

  const verdict = validateArguments(tool.inputSchema, args);
  if (!verdict.ok) {
    if ('unsupported' in verdict) {
      return err({
        code: 'invalid-params',
        message: unsupportedSchemaText(verdict.unsupported),
        target: toolName,
        correctiveHint: "drop this step, or tell the user this server's tool schema cannot be checked before a call",
      });
    }
    return fromMcpError({ code: 'schema', message: schemaText(verdict.failures), failures: verdict.failures }, server.name, toolName);
  }

  return ok({
    serverKey,
    // The server's own name, whichever the caller named the tool by: the call and the activity row carry it (extensibility §3.5).
    toolName: tool.toolName,
    args,
    ...(expectedPins === undefined ? {} : { expectedPins }),
    qualifiedName: tool.qualifiedName,
    serverName: server.name,
    hash: tool.candidateHash,
    risk: tool.effectiveRisk,
  });
}

/**
 * Runs a validated call. Every outcome is an {@link McpInvokeOutcome}: the function does not throw
 * for a server's failure, because a failure is an envelope the model reads and an activity row the
 * person can see. The activity summary is §6's: `called <server> › <tool> (external)`.
 */
export async function applyMcpInvoke(deps: InvokeDeps, params: McpInvokeNormalized, context: Pick<ApplyContext, 'report'>): Promise<McpInvokeOutcome> {
  const { serverKey, toolName, serverName } = params;
  const qualifiedName = params.qualifiedName;

  // The apply runs on the snapshot the bus validated, but the bus is asynchronous here and a write-confirm call has
  // waited for a person before this point, so the server may have changed since validation. Its listing is read again
  // first (bounded by the list timeout), so the recheck below sees what the server advertises at the moment of the call.
  // Without this, a read-only tool whose description changed would run on the old pin (client-no-relist-before-call).
  await deps.transport.relist(serverKey);
  const recheck = prepareInvoke(deps, {
    serverKey,
    toolName,
    args: params.args,
    ...(params.expectedPins === undefined ? {} : { expectedPins: params.expectedPins }),
  });
  if (!recheck.ok) {
    context.report({ affected: [], summary: `refused ${serverName} › ${toolName} (external): ${recheck.error.message}` });
    return { ok: false, error: recheck.error };
  }
  // The recheck answers with the tool as it is now, which is not what the person was shown. A call validated as
  // read-auto that the server has since demoted to confirm-only, or a tool whose hash moved and was re-approved,
  // is a call nobody approved for this description, so it does not leave the machine.
  if (recheck.value.hash !== params.hash || (params.risk === 'read-auto' && recheck.value.risk !== 'read-auto')) {
    context.report({ affected: [], summary: `refused ${serverName} › ${toolName} (external): ${PIN_MISMATCH_TEXT}` });
    return { ok: false, error: toCommandError({ code: 'pin_mismatch', message: PIN_MISMATCH_TEXT }, serverName, toolName) };
  }

  let result: McpToolResult;
  try {
    result = await deps.transport.callTool(serverKey, toolName, params.args);
  } catch (error) {
    const mcp: McpError =
      error instanceof McpFailure
        ? error.error
        : { code: 'server_error', message: serverErrorText(serverName, toolName, error instanceof Error ? error.message : String(error)) };
    context.report({ affected: [], summary: `called ${serverName} › ${toolName} (external) — failed: ${mcp.code}` });
    return { ok: false, error: toCommandError(mcp, serverName, toolName) };
  }

  // Postcondition (§2): the result is well-formed. Each block names a type, which is all Caotang reads.
  const wellFormed = Array.isArray(result.content) && result.content.every((block) => isRecord(block) && typeof block['type'] === 'string');
  if (!wellFormed) {
    context.report({ affected: [], summary: `called ${serverName} › ${toolName} (external) — the result was malformed` });
    return {
      ok: false,
      error: {
        code: 'postcondition',
        message: `server '${serverName}' returned content for '${toolName}' that has no type on every block, so Caotang cannot show it`,
        target: toolName,
        correctiveHint: 'drop this step; the server returned a result Caotang cannot read',
      },
    };
  }

  // The answer is returned whole or not at all. An answer over the cap is refused, and the cap is named, so the model
  // can ask for less; it is never cut down, because a cut answer would be a different answer the server did not give.
  const cap = deps.resultTokenCap ?? EXTERNAL_RESULT_TOKEN_CAP;
  const tokens = resultTokens(result.content);
  if (tokens > cap) {
    context.report({ affected: [], summary: `called ${serverName} › ${toolName} (external) — the result was over the ${cap}-token cap, so it was not returned` });
    return {
      ok: false,
      error: {
        code: 'limit-exceeded',
        message: `server '${serverName}' answered '${toolName}' with about ${tokens} tokens, over the ${cap}-token cap, so the answer was not returned. The tool ran on the server, so any effect it had is already in place; Caotang does not cut an external answer down.`,
        target: toolName,
        correctiveHint: 'call the tool again with narrower arguments so the answer is smaller, or drop this step',
      },
    };
  }

  context.report({
    affected: [],
    summary: `called ${serverName} › ${toolName} (external)${result.isError ? ' — the tool reported an error' : ''}`,
  });
  return {
    ok: true,
    value: {
      untrusted: true,
      source: { serverKey, serverName, toolName, qualifiedName },
      isError: result.isError,
      content: result.content,
    },
  };
}

/**
 * The registration for the bus. The descriptor's `agentRisk` is the floor, `write-confirm`: the
 * per-call risk is `normalized.risk`, and the gate must read that (see the module header).
 *
 * The apply resolves with the untrusted result and rejects with an {@link McpInvokeFailure} for every
 * failure, so the outcome the bus records is never a failure dressed as a completed command.
 */
export function mcpInvokeRegistration(deps: InvokeDeps): McpInvokeRegistration {
  return {
    descriptor: {
      mutates: 'none',
      agentRisk: 'write-confirm',
      undo: 'none',
      // The row is the external call's, whatever source the caller named (command-bus §8).
      activitySource: 'mcp',
      // The apply awaits the server, so only `executeAsync` may run it. `execute()` refuses it before anything runs.
      asyncApply: true,
      // The gate's risk for this call: the external tool's effective risk, never write-auto (extensibility §4, §7).
      agentRiskOf: (normalized) => ((normalized as McpInvokeNormalized).risk === 'read-auto' ? 'read' : 'write-confirm'),
      validate: (params) => prepareInvoke(deps, params),
    },
    apply: async (_state, params, context) => {
      const outcome = await applyMcpInvoke(deps, params, context);
      if (!outcome.ok) throw new McpInvokeFailure(outcome.error);
      return outcome.value;
    },
    source: 'mcp',
  };
}

interface ParsedInvoke {
  readonly serverKey: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly expectedPins: readonly string[] | undefined;
}

function parseInvokeParams(params: unknown): Result<ParsedInvoke, CommandError> {
  if (!isRecord(params)) {
    return refuse('invalid-params', 'mcp.invoke takes an object of named parameters', undefined, 'send { "serverKey", "toolName", "args" }');
  }
  const extra = Object.keys(params).find((key) => !INVOKE_KEYS.includes(key));
  if (extra !== undefined) {
    return refuse('invalid-params', `"${extra}" is not a parameter of mcp.invoke`, undefined, `accepted parameters: ${INVOKE_KEYS.join(', ')}`);
  }
  const serverKey = params['serverKey'];
  if (typeof serverKey !== 'string' || serverKey === '') {
    return refuse('invalid-params', '"serverKey" is required and must be the server key', undefined, 'use the s_ key that tool.search returned');
  }
  const toolName = params['toolName'];
  if (typeof toolName !== 'string' || toolName === '') {
    return refuse('invalid-params', '"toolName" is required and must be the tool name', undefined, 'use the tool name that tool.search returned');
  }
  const args = params['args'];
  if (!isRecord(args)) {
    return refuse('invalid-params', '"args" is required and must be an object of the tool\'s arguments', toolName, "send {} when the tool takes no arguments");
  }
  const pins = params['expectedPins'];
  if (pins !== undefined && (!Array.isArray(pins) || !pins.every((pin) => typeof pin === 'string'))) {
    return refuse('invalid-params', '"expectedPins" must be a list of pin hashes', toolName, 'omit it, or pass the hashes tool.search reported');
  }
  return ok({ serverKey, toolName, args, expectedPins: pins as readonly string[] | undefined });
}

function refuse(code: CommandError['code'], message: string, target: string | undefined, correctiveHint: string): Result<never, CommandError> {
  return err({ code, message, ...(target === undefined ? {} : { target }), correctiveHint });
}

function fromMcpError(error: McpError, serverName: string, toolName: string): Result<never, CommandError> {
  return err(toCommandError(error, serverName, toolName));
}
