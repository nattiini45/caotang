import { ApplyRefusal, err, executeAsync, ok, type BusContext, type CommandError, type CommandRegistry, type Result } from '@caotang/bus';
import { newId } from '@caotang/ids';
import { createMcpTransport, mcpInvokeRegistration, validateArguments, type ExternalToolDescriptor, type McpClient, type UntrustedCallResult } from '@caotang/mcp-client';
import type { ProjectState } from '@caotang/store';

export type McpReadHook = {
  id: string;
  name: string;
  enabled: boolean;
  event: 'tool.before' | 'tool.after';
  tool: string;
  serverKey: string;
  toolName: string;
  pin: string;
  failClosed: boolean;
};

const invalidHook = (message: string): Result<never, CommandError> => err({
  code: 'invalid-params',
  message,
  correctiveHint: 'Select a connected, trusted and reviewed read-only MCP tool that accepts no arguments.',
});

export function validateMcpReadHook(
  client: Pick<McpClient, 'describe' | 'healthOf' | 'serverFor'> | undefined,
  hook: Pick<McpReadHook, 'serverKey' | 'toolName' | 'pin'>,
): Result<ExternalToolDescriptor, CommandError> {
  const server = client?.serverFor(hook.serverKey);
  const health = client?.healthOf(hook.serverKey);
  if (server?.enabled !== true || (health?.state !== 'connected' && health?.state !== 'healthy')) {
    return invalidHook('The MCP hook server is not connected.');
  }
  const tool = client?.describe(hook.serverKey, hook.toolName);
  if (tool === undefined || tool.toolName !== hook.toolName || !tool.enabled || tool.pinState !== 'verified' || tool.pin?.hash !== hook.pin || tool.candidateHash !== hook.pin) {
    return invalidHook('The MCP hook tool is disabled or does not match its reviewed pin.');
  }
  if (!server.trustReads || tool.effectiveRisk !== 'read-auto') {
    return invalidHook('The MCP hook tool is not a trusted, reviewed read.');
  }
  if (!validateArguments(tool.inputSchema, {}).ok) return invalidHook('The MCP hook tool does not accept empty arguments.');
  return ok(tool);
}

export async function invokeMcpReadHook(
  client: McpClient | undefined,
  hook: McpReadHook,
  bus: BusContext<ProjectState>,
  registry: CommandRegistry,
  turnId: string,
  callId: string,
  at: number,
  stillAllowed: () => boolean,
  signal?: AbortSignal,
): Promise<{ attempted: boolean; reason?: string }> {
  const checked = validateMcpReadHook(client, hook);
  if (!checked.ok) return { attempted: false, reason: checked.error.message };
  if (client === undefined || !stillAllowed() || signal?.aborted === true) {
    return { attempted: false, reason: 'The MCP hook no longer has permission to run.' };
  }

  const transport = createMcpTransport(client);
  const invoke = mcpInvokeRegistration({
    client,
    loaded: { isLoaded: (name) => name === checked.value.qualifiedName },
    transport: {
      relist: transport.relist,
      callTool: (serverKey, toolName, args, callOptions) => {
        if (!validateMcpReadHook(client, hook).ok || !stillAllowed() || signal?.aborted === true) {
          throw new Error('MCP hook permission changed.');
        }
        return transport.callTool(serverKey, toolName, args, callOptions);
      },
    },
    callOptions: () => signal === undefined ? undefined : { signal },
  });
  const failed = 'The MCP hook did not return a successful result. Check Settings › MCP & tools and the activity log.';
  const dispatched = await executeAsync({
    id: newId('cmd'),
    name: 'mcp.invoke',
    params: { serverKey: hook.serverKey, toolName: hook.toolName, args: {}, expectedPins: [hook.pin] },
    issuedBy: 'agent',
    turnId,
    callId: JSON.stringify(['mcp-hook', callId, hook.event, hook.id]),
    createdAt: at,
  }, bus, {
    ...registry,
    'mcp.invoke': {
      descriptor: invoke.descriptor as CommandRegistry['mcp.invoke']['descriptor'],
      apply: async (state, params, context) => {
        try {
          const result = await invoke.apply(state, params as Parameters<typeof invoke.apply>[1], {
            ...context,
            report: () => {},
          }) as UntrustedCallResult;
          if (result.isError) throw new Error(failed);
          context.report({ affected: [], summary: 'Ran a read-only MCP hook.' });
          return null;
        } catch {
          context.report({ affected: [], summary: 'A read-only MCP hook did not return a successful result.' });
          throw new ApplyRefusal({ code: 'postcondition', message: failed });
        }
      },
    },
  });
  return dispatched.ok ? { attempted: true } : { attempted: true, reason: failed };
}
