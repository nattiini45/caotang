/**
 * The external-call failures and their model-facing text — [extensibility.md §6](../../../docs/architecture/extensibility.md)
 * ("Error envelope") mapped into the bus's `CommandError` ([command-bus.md §7](../../../docs/architecture/command-bus.md)).
 *
 * The four texts §6 quotes are kept verbatim: unreachable, the pin mismatch, the schema
 * violation (which lists its paths), and timeout/abort. The fifth, a server that answered with
 * an error, is written here in the same register, because §6 does not quote one.
 */

import type { CommandError, PerOpFailure } from '@caotang/bus';

import type { SchemaFailure } from './schema.js';
import { describeFailure } from './schema.js';

/** §3.5's `McpError` codes. A call failure is one of these, and it is data: nothing throws past the boundary without one. */
export type McpErrorCode = 'unreachable' | 'pin_mismatch' | 'schema' | 'timeout' | 'cancelled' | 'server_error' | 'not_found' | 'input_required';

export interface McpError {
  readonly code: McpErrorCode;
  readonly message: string;
  /** For `schema`: every violation, with its JSON path. */
  readonly failures?: readonly SchemaFailure[];
}

/** The throw form of an `McpError`, for the one API that must return a value (`McpClient.callTool`). */
export class McpFailure extends Error {
  readonly error: McpError;

  constructor(error: McpError) {
    super(error.message);
    this.name = 'McpFailure';
    this.error = error;
  }
}

/** §6: *"unreachable → server '<name>' unreachable (health: configured). Check the URL in Settings › MCP & tools, or drop this step"*. */
export function unreachableText(serverName: string): string {
  return `server '${serverName}' unreachable (health: configured). Check the URL in Settings › MCP & tools, or drop this step`;
}

/** §6: *"pin mismatch → server changed since review — re-approve in Settings"*. */
export const PIN_MISMATCH_TEXT = 'server changed since review — re-approve in Settings';

/** §6: *"timeout/abort → external call timed out after 120 s — no partial results exist"*. The seconds come from the configured timeout. */
export function timeoutText(timeoutMs: number): string {
  return `external call timed out after ${formatSeconds(timeoutMs)} s — no partial results exist`;
}

/**
 * A call that ran to its wall-clock cap while the server was still reporting progress. The cap is named, and so is why progress did not
 * extend it. The idle limit's text above is for a server that went quiet.
 */
export function totalTimeoutText(totalMs: number): string {
  return `external call stopped after ${formatSeconds(totalMs)} s, the longest any call may run even while the server reports progress — no partial results exist`;
}

/**
 * A call that was cancelled before the server answered: the writer pressed Stop, or a run limit ended the turn. The server was told to stop, and
 * it may already have done part of the work: Caotang cannot know, and cannot undo what a server did.
 */
export function cancelledText(): string {
  return 'external call cancelled before the server answered — the server may already have done part of the work';
}

function formatSeconds(ms: number): string {
  return String(Math.round(ms) / 1000);
}

/** The schema refusal's sentence: every violation, each at its path. */
export function schemaText(failures: readonly SchemaFailure[]): string {
  return `arguments do not match the tool's input schema: ${failures.map(describeFailure).join('; ')}`;
}

/** The sentence for a schema the checker cannot read. The call is refused, and the reason is the keyword. */
export function unsupportedSchemaText(keyword: string): string {
  return `the tool's input schema uses ${keyword}, which Caotang cannot check, so the call is refused`;
}

/** One name for a resource the server does not have, however it said so (-32002 before 2026-07-28, -32602 after it). */
export function notFoundText(serverName: string, what: string): string {
  return `'${what}' was not found on server '${serverName}' — the server may have moved or removed it; pick it again from the list`;
}

/** A server that answered `input_required`: it wants more from the writer than Caotang can ask for yet (elicitation is not built). */
export function inputRequiredText(serverName: string): string {
  return `server '${serverName}' asked for more input before it would answer, which Caotang cannot give yet — nothing was read`;
}

/** The sentence for a server that answered a `resources/read` with an error. */
export function readErrorText(serverName: string, uri: string, detail: string): string {
  return `server '${serverName}' returned an error reading '${uri}': ${detail}. Nothing was read`;
}

/** The sentence for a server that answered with an error. The effect, if any, is external and Caotang cannot undo it. */
export function serverErrorText(serverName: string, toolName: string, detail: string): string {
  return `server '${serverName}' returned an error for '${toolName}': ${detail}. Caotang cannot undo an external effect; check the arguments against the tool's schema, or drop this step`;
}

/**
 * The bus envelope for an external failure. Codes follow command-bus §7's ten: a network
 * failure is `io-error`, an approval gap is `permission-denied`, and a bad argument is
 * `invalid-params` with every path listed in `details.failures` (§2: per-op, not one at a time).
 */
export function toCommandError(error: McpError, serverName: string, toolName: string): CommandError {
  switch (error.code) {
    case 'unreachable':
      return {
        code: 'io-error',
        message: error.message,
        target: toolName,
        correctiveHint: 'open Settings › MCP & tools to check the server, or drop this step',
      };
    case 'pin_mismatch':
      return {
        code: 'permission-denied',
        message: error.message,
        target: toolName,
        correctiveHint: 'the user must review the changed tool list in Settings › MCP & tools before this tool can be called again',
      };
    case 'schema': {
      const failures: PerOpFailure[] = (error.failures ?? []).map((failure) => ({
        target: failure.path === '' ? '(the arguments)' : failure.path,
        code: 'invalid-params',
        message: describeFailure(failure),
      }));
      return {
        code: 'invalid-params',
        message: error.message,
        target: toolName,
        details: { failures },
        correctiveHint: "fix the arguments at the listed paths to match the tool's input schema, then call it again",
      };
    }
    case 'timeout':
      return {
        code: 'io-error',
        message: error.message,
        target: toolName,
        correctiveHint: 'drop this step or report it to the user; Caotang does not retry an external call',
      };
    case 'cancelled':
      return {
        code: 'io-error',
        message: error.message,
        target: toolName,
        correctiveHint: 'the call was cancelled; do not retry it unless the user asks, and check whether the server already did part of the work',
      };
    case 'server_error':
      return {
        code: 'io-error',
        message: error.message,
        target: serverName,
        correctiveHint: 'report the server error to the user, or drop this step',
      };
    case 'not_found':
      return {
        code: 'not-found',
        message: error.message,
        target: toolName,
        correctiveHint: "pick the resource again from the server's list",
      };
    case 'input_required':
      return {
        code: 'io-error',
        message: error.message,
        target: serverName,
        correctiveHint: 'tell the user this server needs input Caotang cannot ask for yet',
      };
  }
}
