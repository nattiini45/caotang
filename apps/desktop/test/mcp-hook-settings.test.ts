import { describe, expect, it } from 'vitest';
import type { McpReadHook } from '@caotang/harness';
import { mcpHooksForProject } from '../src/app/mcp-hooks.js';
import { applyPatch, DEFAULT_SETTINGS, normalizeSettings } from '../src/app/settings.js';

const hook: McpReadHook = {
  id: 'r_123456789A', name: 'Check the catalogue', tool: 'notes.append', event: 'tool.before',
  serverKey: 'catalogue', toolName: 'lookup', pin: 'a'.repeat(64), enabled: true, failClosed: true,
};

describe('private MCP hook settings', () => {
  it('stores a definition only under its project and clears one project without affecting another', () => {
    const first = applyPatch(DEFAULT_SETTINGS, { mcpHooks: { p_123456789A: [hook] } });
    const second = applyPatch(first, { mcpHooks: { p_023456789A: [{ ...hook, name: 'Other catalogue' }] } });
    const reloaded = normalizeSettings(JSON.parse(JSON.stringify(second)));
    expect(reloaded.mcpHooks['p_123456789A']).toEqual([hook]);
    expect(reloaded.mcpHooks['p_OTHER']).toBeUndefined();
    expect(mcpHooksForProject(reloaded.mcpHooks, 'constructor')).toEqual([]);
    const cleared = applyPatch(reloaded, { mcpHooks: { p_123456789A: [] } });
    expect(cleared.mcpHooks['p_123456789A']).toBeUndefined();
    expect(cleared.mcpHooks['p_023456789A']?.[0]?.name).toBe('Other catalogue');
  });

  it('drops malformed definitions and never preserves extra input or credential fields', () => {
    const stored = normalizeSettings({ mcpHooks: {
      p_123456789A: [
        { ...hook, token: 'not a hook field', args: { text: 'not a hook field' } },
        { ...hook, name: 'Duplicate' },
        { ...hook, id: 'r_023456789A', event: 'turn.end' },
        { ...hook, id: 'r_223456789A', pin: 'not a hash' },
      ],
    } });
    expect(stored.mcpHooks).toEqual({ p_123456789A: [hook] });
  });
});
