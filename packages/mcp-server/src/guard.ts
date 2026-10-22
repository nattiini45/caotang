/**
 * The server-side refusals that come before the SDK sees a request —
 * command-bus.md §4 and extensibility.md §9.
 *
 * The SDK answers a `tools/call` for a name it has no tool for with "not found",
 * and that is the wrong answer for two cases this server must name:
 *
 *   - **A hard-denied command** (`project.deleteNode`). It is refused whatever the
 *     caller asks, in every mode, and the refusal is the bus's own: `checkPermission`
 *     produces the message, so the words cannot drift from the bus's.
 *   - **A write tool on a read-only server.** Its name is known, it is not exposed,
 *     and the caller should be told why and what would change it.
 *
 * Both are answered as a tool result with `isError: true`, which is how every other
 * refusal of this server is answered, so a model reads them the same way. The guard
 * runs on the parsed message, once, before the request reaches the transport, so it
 * covers every transport the server speaks.
 */

import { checkPermission, hardDenyClass, isCommandName, type CommandError } from '@caotang/bus';
import { metadataFor } from '@caotang/harness';

export interface GuardPolicy {
  /** Whether write tools are exposed (`--allow-writes`). */
  readonly allowWrites: boolean;
  /**
   * Set on a server that could not open its project (recovery.ts): the refusal a tool name earns there, or `undefined` for a name that
   * reaches a handler. It reads the recovery's live phase, so it answers differently once the recovery is written.
   */
  readonly degraded?: (name: string) => CommandError | undefined;
}

/**
 * A JSON-RPC response carrying a refusal, in the shape a `tools/call` result takes.
 * `resultType: 'complete'` is part of that shape on the 2026-07-28 revision, which
 * requires it on every complete result, and a client on that revision refuses one
 * without it.
 */
export interface RefusalResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result: {
    readonly resultType: 'complete';
    readonly isError: true;
    readonly content: readonly { readonly type: 'text'; readonly text: string }[];
    readonly structuredContent: { readonly error: CommandError };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The refusal as a `tools/call` result. The text is the error as JSON, for a model; `structuredContent` for a host. */
export function refusalResponse(id: string | number | null, error: CommandError): RefusalResponse {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      resultType: 'complete',
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error }) }],
      structuredContent: { error },
    },
  };
}

/**
 * The hard-deny refusal for a command name, from the bus's own gate. `undefined` for a
 * name that is not hard-denied.
 */
export function hardDeniedError(name: string): CommandError | undefined {
  if (!isCommandName(name) || hardDenyClass(name) === undefined) return undefined;
  const verdict = checkPermission({ agentRisk: 'never' }, { name, issuedBy: 'agent' });
  return verdict.ok ? undefined : verdict.error;
}

/** The refusal for a write tool that this read-only server does not expose. */
function readOnlyError(name: string, risk: string): CommandError {
  return {
    code: 'permission-denied',
    message: `"${name}" is a ${risk} tool, and this server is read-only, so it is not exposed and nothing was written. Restart caotang-mcp with --allow-writes to let external callers change this project.`,
    target: name,
    risk: risk === 'write-confirm' ? 'write-confirm' : 'write-auto',
    correctiveHint:
      'do not retry it from here: tell the user that this server is read-only, and what the change would be, so they can decide to restart it with --allow-writes',
  };
}

/**
 * The refusal this request earns, or `undefined` when the request may proceed. Only a
 * `tools/call` can earn one; every other message passes through untouched.
 */
export function guardMessage(message: unknown, policy: GuardPolicy): RefusalResponse | undefined {
  if (!isRecord(message) || message['method'] !== 'tools/call' || !('id' in message)) return undefined;
  const id = (message['id'] ?? null) as string | number | null;
  const params = isRecord(message['params']) ? message['params'] : {};
  const name = typeof params['name'] === 'string' ? params['name'] : '';

  const denied = hardDeniedError(name);
  if (denied !== undefined) return refusalResponse(id, denied);

  const stopped = policy.degraded?.(name);
  if (stopped !== undefined) return refusalResponse(id, stopped);

  const meta = metadataFor(name);
  if (meta !== undefined && meta.risk !== 'read' && meta.risk !== 'meta' && !policy.allowWrites) {
    return refusalResponse(id, readOnlyError(name, meta.risk));
  }
  return undefined;
}

/**
 * The same guard for a batch. A JSON-RPC batch is not part of the 2026-07-28 revision,
 * so a batch that carries a refused call is refused whole, and the caller sends the
 * call on its own. Anything else in a batch goes to the SDK unchanged.
 */
export function guardBatch(messages: readonly unknown[], policy: GuardPolicy): RefusalResponse | undefined {
  for (const message of messages) {
    const refusal = guardMessage(message, policy);
    if (refusal !== undefined) {
      return refusalResponse(null, {
        code: 'invalid-params',
        message: `a batch carries a refused call (${refusal.result.structuredContent.error.message}), so the whole batch was not run. Send each call on its own.`,
        correctiveHint: 'resend the calls one at a time, without the refused call',
      });
    }
  }
  return undefined;
}
