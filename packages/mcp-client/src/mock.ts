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
import type { McpWire, WireCallResult, WireFactory, WireOptions, WireTool } from './wire.js';

export interface MockMcpScript {
  /** What the server lists now. Read on every listing, so a test changes the listing by assigning this. */
  listTools: WireTool[];
  /** The answer to a call: a result, or an error the server reports. */
  respond: (tool: string, args: Record<string, unknown>) => WireCallResult | McpError;
  /** Injected failures: throw from here to fail a phase. `handshake` is the first contact with the server. */
  fail?: (phase: 'handshake' | 'list' | 'call') => void;
  /** Observes the wire operations, for an eval that counts requests on the wire. */
  record?: (event: { readonly phase: 'handshake' | 'list' | 'call'; readonly tool?: string }) => void;
}

const WIRE_KIND_OF: Readonly<Record<McpError['code'], WireError['kind']>> = {
  unreachable: 'network',
  timeout: 'timeout',
  server_error: 'protocol',
  pin_mismatch: 'protocol',
  schema: 'protocol',
};

function isMcpError(value: WireCallResult | McpError): value is McpError {
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
