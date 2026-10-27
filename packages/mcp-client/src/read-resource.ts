/**
 * `mcp.readResource` — [extensibility.md §6](../../../docs/architecture/extensibility.md), the bus command that reads one resource
 * from a connected server, and only when the writer picked it (§4 rule 8).
 *
 * ```
 * validate → permission gate (agentRisk 'never') → apply (resources/read) → postconditions → activity (source 'mcp')
 * ```
 *
 * **The agent cannot issue it.** The descriptor is `agentRisk: 'never'`, and `validate` also refuses a call that does not carry
 * `pickedBy: 'writer'`, so the closure holds at two places: the gate and the command's own check. A resource is application-controlled in
 * MCP, and an agent that could fetch one would fetch whatever an injected text told it to fetch.
 *
 * **Which URI may be read** is decided without matching a URI against a template's variables (RFC 6570). It is a resource the server
 * currently lists, or it arrives with `viaTemplate` naming a listed resource template whose pin is verified. A template that is new or
 * changed since the writer's review is refused, so the pin gates something. Everything that can refuse before the effect is in
 * {@link prepareReadResource}, against the client's snapshot; the apply lists the catalog again first and checks again, because the
 * writer's click and the read are not the same moment.
 *
 * **What comes back** is text, no more than the external answer cap, marked untrusted: a blob is refused naming its MIME type, and an
 * answer over the cap is refused naming the cap. Nothing is trimmed, because a cut resource would be a different resource. This module
 * puts nothing in a prompt: the attach path that would carry the text to the model is not built, and when it is the text goes in the envelope of context `untrusted.ts` (issue #54).
 *
 * As with `mcp.invoke`, a failure never comes back as a value from the registration's apply: the bus would store it as a completed
 * command, so the apply rejects with an {@link McpReadResourceFailure} that carries the `CommandError`.
 */

import type { ApplyContext, CommandApply, CommandDescriptor, CommandError, Result } from '@caotang/bus';
import { ApplyRefusal, err, ok } from '@caotang/bus';

import type { McpClient, McpTransport } from './client.js';
import { McpFailure, serverErrorText, toCommandError, unreachableText, type McpError } from './errors.js';
import { EXTERNAL_RESULT_TOKEN_CAP, resultTokens } from './invoke.js';
import { isRecord } from './util.js';
import type { WireResourceContents } from './wire.js';

export const MCP_READ_RESOURCE_NAME = 'mcp.readResource' as const;

/** The closed set of top-level keys (command-bus §9: a key the command does not list is refused). */
const READ_KEYS = ['serverKey', 'uri', 'pickedBy', 'viaTemplate'];

/** §6's params: `{ serverKey, uri, pickedBy: 'writer', viaTemplate? }`. */
export interface McpReadResourceParams {
  readonly serverKey: string;
  readonly uri: string;
  /** Set only by the writer's picker. The command is refused without it. */
  readonly pickedBy: 'writer';
  /** The listed resource template the URI comes through, when the server does not list the URI itself. */
  readonly viaTemplate?: string;
}

/** What validate hands the apply: the params, and the server's name for the activity row. */
export interface McpReadResourceNormalized extends McpReadResourceParams {
  readonly serverName: string;
}

/** A resource's text, marked as the untrusted data it is (§4 rule 4). Verbatim: Caotang never summarises, rewrites or trims it. */
export interface UntrustedResource {
  readonly untrusted: true;
  readonly source: { readonly serverKey: string; readonly serverName: string; readonly uri: string };
  readonly mimeType?: string;
  readonly text: string;
  /** The estimate the cap was checked against (`resultTokens`). */
  readonly tokens: number;
}

/** What a validate closes over: the client's snapshot. It never reaches the wire. */
export interface ReadResourceValidateDeps {
  readonly client: Pick<McpClient, 'serverFor' | 'healthOf' | 'listResources'>;
}

/** What an apply closes over. The transport is the only route to a `resources/read`, and it is held here and nowhere else. */
export interface ReadResourceDeps extends ReadResourceValidateDeps {
  readonly transport: Pick<McpTransport, 'readResource' | 'refreshCatalog'>;
  /** The most tokens one resource may carry before it is refused. Defaults to {@link EXTERNAL_RESULT_TOKEN_CAP}. */
  readonly resultTokenCap?: number;
}

export type McpReadResourceOutcome = { readonly ok: true; readonly value: UntrustedResource } | { readonly ok: false; readonly error: CommandError };

/** The bus registration shape (command-bus §2 and §9) for `mcp.readResource`. */
export interface McpReadResourceRegistration {
  readonly descriptor: CommandDescriptor<McpReadResourceNormalized>;
  readonly apply: CommandApply<McpReadResourceNormalized, unknown>;
  /** The activity source the dispatch must carry. */
  readonly source: 'mcp';
}

/** A failed `mcp.readResource`, carrying the bus's own error envelope. Thrown by the registration's apply, so a failure is never a completed command. */
export class McpReadResourceFailure extends ApplyRefusal {
  constructor(error: CommandError) {
    super(error);
    this.name = 'McpReadResourceFailure';
  }
}

/** The sentence for a template that has not been reviewed as it is now. */
export function templateUnreviewedText(serverName: string, template: string): string {
  return `the resource template '${template}' on server '${serverName}' is new or changed since you reviewed it — re-approve it in Settings › MCP & tools`;
}

/**
 * Validates an `mcp.readResource` call. Pure against the client's snapshot: no network, no write. Each refusal names its corrective path.
 */
export function prepareReadResource(deps: ReadResourceValidateDeps, params: unknown): Result<McpReadResourceNormalized, CommandError> {
  const shape = parseReadParams(params);
  if (!shape.ok) return shape;
  const { serverKey, uri, viaTemplate } = shape.value;

  const server = deps.client.serverFor(serverKey);
  if (server === undefined) {
    return refuse('not-found', `no MCP server with key '${serverKey}' is configured`, uri, 'pick the resource again from a server that is connected');
  }
  const health = deps.client.healthOf(serverKey);
  if (health === undefined || health.state === 'configured') {
    return fromMcpError({ code: 'unreachable', message: unreachableText(server.name) }, server.name, uri);
  }

  const listed = deps.client.listResources(serverKey);
  if (viaTemplate === undefined) {
    if (!listed.some((resource) => !resource.template && resource.uri === uri)) {
      return refuse(
        'not-found',
        `'${uri}' is not a resource that server '${server.name}' lists`,
        uri,
        "pick the resource from the server's list, or through one of its resource templates",
      );
    }
  } else {
    const template = listed.find((resource) => resource.template && resource.uri === viaTemplate);
    if (template === undefined) {
      return refuse(
        'not-found',
        `'${viaTemplate}' is not a resource template that server '${server.name}' lists`,
        viaTemplate,
        "pick a template from the server's list",
      );
    }
    if (template.pinState !== 'verified') {
      return refuse(
        'permission-denied',
        templateUnreviewedText(server.name, viaTemplate),
        viaTemplate,
        'the writer must review the resource template in Settings › MCP & tools before a resource can be read through it',
      );
    }
  }

  return ok({ serverKey, uri, pickedBy: 'writer', ...(viaTemplate === undefined ? {} : { viaTemplate }), serverName: server.name });
}

/**
 * Runs a validated call. Every outcome is an {@link McpReadResourceOutcome}: a server's failure is an envelope and an activity row, not
 * an exception. The activity summary is `read <server> › <uri> (external resource)`.
 */
export async function applyMcpReadResource(
  deps: ReadResourceDeps,
  params: McpReadResourceNormalized,
  context: Pick<ApplyContext, 'report'>,
): Promise<McpReadResourceOutcome> {
  const { serverKey, uri, serverName } = params;

  // The validation was made on a snapshot that may be old: the writer's click and this read are not the same moment. The catalog is
  // listed again (the wire keeps a list for the server's own ttl, so this is not a request every time) and the call is checked again.
  await deps.transport.refreshCatalog(serverKey);
  const recheck = prepareReadResource(deps, {
    serverKey,
    uri,
    pickedBy: params.pickedBy,
    ...(params.viaTemplate === undefined ? {} : { viaTemplate: params.viaTemplate }),
  });
  if (!recheck.ok) {
    context.report({ affected: [], summary: `refused ${serverName} › ${uri} (external resource): ${recheck.error.message}` });
    return { ok: false, error: recheck.error };
  }

  let contents: readonly WireResourceContents[];
  try {
    contents = await deps.transport.readResource(serverKey, uri);
  } catch (error) {
    const mcp: McpError =
      error instanceof McpFailure ? error.error : { code: 'server_error', message: serverErrorText(serverName, uri, error instanceof Error ? error.message : String(error)) };
    context.report({ affected: [], summary: `read ${serverName} › ${uri} (external resource) — failed: ${mcp.code}` });
    return { ok: false, error: toCommandError(mcp, serverName, uri) };
  }

  const refused = (summary: string, error: CommandError): McpReadResourceOutcome => {
    context.report({ affected: [], summary: `read ${serverName} › ${uri} (external resource) — ${summary}` });
    return { ok: false, error };
  };

  if (contents.length === 0) {
    return refused('the server returned nothing', {
      code: 'postcondition',
      message: `server '${serverName}' returned no contents for '${uri}'`,
      target: uri,
      correctiveHint: 'pick another resource, or tell the writer the server returned nothing',
    });
  }
  const texts: string[] = [];
  for (const content of contents) {
    if (!('text' in content)) {
      const type = content.mimeType === undefined || content.mimeType === '' ? 'no MIME type' : content.mimeType;
      return refused(`it is a ${type} blob, so it was not read`, {
        code: 'invalid-params',
        message: `'${uri}' on server '${serverName}' is a blob (${type}); Caotang reads text and application/json resources only, so it was not read`,
        target: uri,
        correctiveHint: 'pick a text or JSON resource',
      });
    }
    texts.push(content.text);
  }
  const text = texts.join('\n\n');
  const cap = deps.resultTokenCap ?? EXTERNAL_RESULT_TOKEN_CAP;
  const tokens = resultTokens([{ type: 'text', text }]);
  if (tokens > cap) {
    return refused(`it was over the ${cap}-token cap, so it was not read`, {
      code: 'limit-exceeded',
      message: `'${uri}' on server '${serverName}' is about ${tokens} tokens, over the ${cap}-token cap, so it was not read. Caotang does not cut a resource down.`,
      target: uri,
      correctiveHint: 'split the resource, or pick a smaller page of it',
    });
  }

  const mimeTypes = new Set(contents.map((content) => content.mimeType));
  const mimeType = mimeTypes.size === 1 ? [...mimeTypes][0] : undefined;
  context.report({ affected: [], summary: `read ${serverName} › ${uri} (external resource)` });
  return {
    ok: true,
    value: {
      untrusted: true,
      source: { serverKey, serverName, uri },
      ...(mimeType === undefined || mimeType === '' ? {} : { mimeType }),
      text,
      tokens,
    },
  };
}

/**
 * The registration for the bus. `agentRisk` is `never`: the gate refuses an agent's call outright, and `validate` refuses any call
 * that does not carry `pickedBy: 'writer'` besides. The apply resolves with the untrusted resource and rejects with an
 * {@link McpReadResourceFailure} for every failure.
 */
export function mcpReadResourceRegistration(deps: ReadResourceDeps): McpReadResourceRegistration {
  return {
    descriptor: {
      mutates: 'none',
      agentRisk: 'never',
      undo: 'none',
      activitySource: 'mcp',
      // The apply awaits the server, so only `executeAsync` may run it. `execute()` refuses it before anything runs.
      asyncApply: true,
      validate: (params) => prepareReadResource(deps, params),
    },
    apply: async (_state, params, context) => {
      const outcome = await applyMcpReadResource(deps, params, context);
      if (!outcome.ok) throw new McpReadResourceFailure(outcome.error);
      return outcome.value;
    },
    source: 'mcp',
  };
}

function parseReadParams(params: unknown): Result<McpReadResourceParams, CommandError> {
  if (!isRecord(params)) {
    return refuse('invalid-params', 'mcp.readResource takes an object of named parameters', undefined, 'send { "serverKey", "uri", "pickedBy": "writer" }');
  }
  const extra = Object.keys(params).find((key) => !READ_KEYS.includes(key));
  if (extra !== undefined) {
    return refuse('invalid-params', `"${extra}" is not a parameter of mcp.readResource`, undefined, `accepted parameters: ${READ_KEYS.join(', ')}`);
  }
  const serverKey = params['serverKey'];
  if (typeof serverKey !== 'string' || serverKey === '') {
    return refuse('invalid-params', '"serverKey" is required and must be the server key', undefined, 'use the key of the server the resource was listed on');
  }
  const uri = params['uri'];
  if (typeof uri !== 'string' || uri === '') {
    return refuse('invalid-params', '"uri" is required and must be the resource URI', undefined, 'use the URI the server listed');
  }
  if (params['pickedBy'] !== 'writer') {
    return refuse(
      'permission-denied',
      'a resource is read only when the writer picks it: "pickedBy" must be "writer"',
      'pickedBy',
      'the agent cannot read a resource; ask the writer to attach it',
    );
  }
  const viaTemplate = params['viaTemplate'];
  if (viaTemplate !== undefined && (typeof viaTemplate !== 'string' || viaTemplate === '')) {
    return refuse('invalid-params', '"viaTemplate" must be a listed resource template', undefined, 'omit it, or name the template the URI comes through');
  }
  return ok({ serverKey, uri, pickedBy: 'writer', ...(viaTemplate === undefined ? {} : { viaTemplate }) });
}

function refuse(code: CommandError['code'], message: string, target: string | undefined, correctiveHint: string): Result<never, CommandError> {
  return err({ code, message, ...(target === undefined ? {} : { target }), correctiveHint });
}

function fromMcpError(error: McpError, serverName: string, uri: string): Result<never, CommandError> {
  return err(toCommandError(error, serverName, uri));
}
