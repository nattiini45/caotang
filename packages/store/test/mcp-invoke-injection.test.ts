/**
 * `mcp.invoke` is injected into the store's registry, the way the exporter is (extensibility.md §6,
 * `ProjectCommandOptions.mcpInvoke`). The store does not import the MCP client, so the name has an apply only
 * when a caller supplies one, and without it the bus refuses the name as not wired.
 */
import { describe, expect, it } from 'vitest';

import { ok, resolveIn, type CommandApply, type CommandDescriptor } from '@caotang/bus';

import { createProjectCommandRegistry } from '../src/index.js';

describe('mcp.invoke — the store registry takes the client’s half, and no other', () => {
  it('refuses the name as not wired, and writes nothing, when no client was injected', () => {
    const resolved = resolveIn(createProjectCommandRegistry({}), 'mcp.invoke');
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe('internal');
    expect(resolved.error.message).toContain('has no implementation in this build');
  });

  it('resolves to the injected descriptor and apply, unchanged', () => {
    const descriptor: CommandDescriptor<unknown> = {
      mutates: 'none',
      agentRisk: 'write-confirm',
      undo: 'none',
      activitySource: 'mcp',
      validate: (params) => ok(params),
    };
    const apply: CommandApply<unknown, unknown> = async () => ({ isError: false, content: [] });
    const resolved = resolveIn(createProjectCommandRegistry({ mcpInvoke: { descriptor, apply } }), 'mcp.invoke');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.descriptor).toBe(descriptor);
    expect(resolved.value.apply).toBe(apply);
  });

  it('leaves the project names as they were when the client is injected', () => {
    const registry = createProjectCommandRegistry({ mcpInvoke: { descriptor: { mutates: 'none', agentRisk: 'write-confirm', undo: 'none', validate: (p) => ok(p) }, apply: async () => undefined } });
    // binder.create is an inverse-undo project command with its own apply; injecting an external call changes nothing else.
    expect(resolveIn(registry, 'binder.create').ok).toBe(true);
    expect(resolveIn(registry, 'export.compile').ok).toBe(false);
  });
});

describe('mcp.readResource — injected the same way, and closed to the agent whatever is injected', () => {
  it('refuses the name as not wired when no client was injected', () => {
    const resolved = resolveIn(createProjectCommandRegistry({}), 'mcp.readResource');
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.message).toContain('has no implementation in this build');
  });

  it('resolves to the injected descriptor and apply, unchanged, and leaves mcp.invoke unwired', () => {
    const descriptor: CommandDescriptor<unknown> = {
      mutates: 'none',
      agentRisk: 'never',
      undo: 'none',
      activitySource: 'mcp',
      asyncApply: true,
      validate: (params) => ok(params),
    };
    const apply: CommandApply<unknown, unknown> = async () => ({ untrusted: true });
    const registry = createProjectCommandRegistry({ mcpReadResource: { descriptor, apply } });
    const resolved = resolveIn(registry, 'mcp.readResource');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.descriptor).toBe(descriptor);
    expect(resolved.value.apply).toBe(apply);
    expect(resolveIn(registry, 'mcp.invoke').ok).toBe(false);
  });
});
