/**
 * The scripted MCP server — [extensibility.md §11](../../../docs/architecture/extensibility.md),
 * the eval harness. Deterministic and headless: a script says what the server lists and how it
 * answers, and a test changes the listing between two steps to play a rug pull or a delta.
 *
 * It is a {@link McpWire}, so the client under test is the real client; only the network is
 * replaced. Failures are injected as the same {@link WireError} kinds the SDK wire produces, so
 * the client's mapping is exercised rather than bypassed.
 */

import type { McpError } from './errors.js';
import { WireError } from './wire-error.js';
import type {
  McpWire,
  WireCallResult,
  WireCapabilities,
  WireFactory,
  WireOptions,
  WirePrompt,
  WirePromptResult,
  WireResource,
  WireResourceContents,
  WireResourceListing,
  WireResourceTemplate,
  WireTool,
} from './wire.js';

/** The steps of a scripted server a test can fail or watch. */
export type MockPhase = 'handshake' | 'list' | 'call' | 'resources' | 'prompts' | 'read' | 'prompt';

export interface MockMcpScript {
  /** What the server lists now. Read on every listing, so a test changes the listing by assigning this. */
  listTools: WireTool[];
  /** The answer to a call: a result, or an error the server reports. */
  respond: (tool: string, args: Record<string, unknown>) => WireCallResult | McpError;
  /** Injected failures: throw from here to fail a phase. `handshake` is the first contact with the server. */
  fail?: (phase: MockPhase) => void;
  /** Observes the wire operations, for an eval that counts requests on the wire. `tool` names the tool, the prompt or the resource URI asked for. */
  record?: (event: { readonly phase: MockPhase; readonly tool?: string }) => void;
  /** What the server lists as resources, templates and prompts now. A script without them advertises none, and none is ever asked for. */
  resources?: WireResource[];
  templates?: WireResourceTemplate[];
  prompts?: WirePrompt[];
  /** The contents of a resource, or the error the server answers with. Read on every read. */
  readResource?: (uri: string) => readonly WireResourceContents[] | McpError;
  /** The messages of a prompt. */
  getPrompt?: (name: string, args: Record<string, string>) => WirePromptResult | McpError;
  /** Overrides what the server advertises. By default it advertises resources when `resources` or `templates` is set, and prompts when `prompts` is. */
  capabilities?: Partial<WireCapabilities>;
}

const WIRE_KIND_OF: Readonly<Record<McpError['code'], WireError['kind']>> = {
  unreachable: 'network',
  timeout: 'timeout',
  server_error: 'protocol',
  pin_mismatch: 'protocol',
  schema: 'protocol',
  not_found: 'not-found',
  input_required: 'input-required',
};

function isMcpError(value: object): value is McpError {
  return !('content' in value) && 'code' in value && 'message' in value;
}

/** One scripted server. The first operation is the handshake; every later one is a listing or a call. */
export function createMockWire(script: MockMcpScript): McpWire {
  let opened = false;
  const open = (): void => {
    if (opened) return;
    script.record?.({ phase: 'handshake' });
    script.fail?.('handshake');
    opened = true;
  };
  return {
    async listTools(_options: WireOptions): Promise<readonly WireTool[]> {
      open();
      script.record?.({ phase: 'list' });
      script.fail?.('list');
      return script.listTools.map((tool) => ({ ...tool }));
    },
    async callTool(name: string, args: Record<string, unknown>, _options: WireOptions): Promise<WireCallResult> {
      open();
      script.record?.({ phase: 'call', tool: name });
      script.fail?.('call');
      const answer = script.respond(name, args);
      if (isMcpError(answer)) throw new WireError(WIRE_KIND_OF[answer.code], answer.message);
      return { content: answer.content, isError: answer.isError === true };
    },
    async capabilities(_options: WireOptions): Promise<WireCapabilities> {
      open();
      return {
        resources: script.capabilities?.resources ?? (script.resources !== undefined || script.templates !== undefined),
        prompts: script.capabilities?.prompts ?? script.prompts !== undefined,
        completions: script.capabilities?.completions ?? false,
      };
    },
    async listResources(_options: WireOptions): Promise<WireResourceListing> {
      open();
      script.record?.({ phase: 'resources' });
      script.fail?.('resources');
      return { resources: (script.resources ?? []).map((resource) => ({ ...resource })), templates: (script.templates ?? []).map((template) => ({ ...template })) };
    },
    async readResource(uri: string, _options: WireOptions): Promise<readonly WireResourceContents[]> {
      open();
      script.record?.({ phase: 'read', tool: uri });
      script.fail?.('read');
      const answer = script.readResource?.(uri);
      if (answer === undefined) throw new WireError('not-found', `no resource ${uri}`);
      if (!Array.isArray(answer) && isMcpError(answer)) throw new WireError(WIRE_KIND_OF[answer.code], answer.message);
      return answer as readonly WireResourceContents[];
    },
    async listPrompts(_options: WireOptions): Promise<readonly WirePrompt[]> {
      open();
      script.record?.({ phase: 'prompts' });
      script.fail?.('prompts');
      return (script.prompts ?? []).map((prompt) => ({ ...prompt }));
    },
    async getPrompt(name: string, args: Record<string, string>, _options: WireOptions): Promise<WirePromptResult> {
      open();
      script.record?.({ phase: 'prompt', tool: name });
      script.fail?.('prompt');
      const answer = script.getPrompt?.(name, args) ?? { code: 'server_error' as const, message: `no prompt ${name}` };
      if (isMcpError(answer)) throw new WireError(WIRE_KIND_OF[answer.code], answer.message);
      return answer;
    },
    async close(): Promise<void> {
      opened = false;
    },
  };
}

/** A factory that gives each server its own script, by server key. A server with no script is unreachable. */
export function createMockWireFactory(scripts: Readonly<Record<string, MockMcpScript>>): WireFactory {
  return (server) => {
    const script = Object.prototype.hasOwnProperty.call(scripts, server.key) ? scripts[server.key] : undefined;
    if (script === undefined) {
      return createMockWire({
        listTools: [],
        respond: () => ({ code: 'unreachable', message: `no script for ${server.key}` }),
        fail: () => {
          throw new WireError('network', `no script for ${server.key}`);
        },
      });
    }
    return createMockWire(script);
  };
}
