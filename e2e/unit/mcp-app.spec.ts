import { expect, test } from '@playwright/test';
import { EMPTY_MCP_SETTINGS, createMockWire, type McpServerConfig, type McpSettings, type WireFactory } from '../../packages/mcp-client/src/index.js';

import { McpApp, type McpKeyPort, type McpSettingsPort } from '../../apps/desktop/src/app/mcp.js';
import { mcpServerView, reviewSummary, toolStatusLabel } from '../../apps/desktop/src/app/mcp-model.js';
import { DEFAULT_SETTINGS, applyPatch, mcpLoadWarnings, normalizeSettings } from '../../apps/desktop/src/app/settings.js';

const NOW = '2026-10-08T09:00:00.000Z';

/** An in-memory settings port: the slice as the app keeps it, written whole on every change. */
function memorySettings(initial: McpSettings): McpSettingsPort & { value(): McpSettings } {
  let value = initial;
  return {
    current: () => value,
    value: () => value,
    update: async (patch) => {
      value = patch.mcp;
      return null;
    },
  };
}

/** An in-memory key port: what the vault would hold, by reference. */
function memoryKeys(): McpKeyPort & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    put: async (ref, token) => {
      map.set(ref, token);
    },
    reveal: async (ref) => map.get(ref),
    has: async (ref) => map.has(ref),
    remove: async (ref) => {
      map.delete(ref);
    },
  };
}

/** An in-memory key port whose removal fails, as a vault that cannot be written does. */
function failingKeys(): McpKeyPort {
  const map = new Map<string, string>();
  return {
    put: async (ref, token) => {
      map.set(ref, token);
    },
    reveal: async (ref) => map.get(ref),
    has: async (ref) => map.has(ref),
    remove: async () => {
      throw new Error('the vault cannot be written');
    },
  };
}

/** A scripted server that lists the given tool names, whatever address it is asked for. */
function scriptedServer(names: readonly string[]): WireFactory {
  return () =>
    createMockWire({
      listTools: names.map((name) => ({ name, description: `Does ${name}.`, inputSchema: { type: 'object' } })),
      respond: () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
    });
}

test.describe('the MCP app: tokens, imports and the enabled tools (extensibility §3.1, §4, §8)', () => {
  test('a bearer token is sealed in the vault under its own reference, and the settings never hold it', async () => {
    const keys = memoryKeys();
    const settings = memorySettings(EMPTY_MCP_SETTINGS);
    const app = new McpApp({ settings, keys });

    const outcome = await app.addServer({ name: 'Story bible', url: 'https://tools.example.com/mcp', token: 'secret-token-123' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect([...keys.map.values()]).toEqual(['secret-token-123']);
    expect(JSON.stringify(settings.value())).not.toContain('secret-token-123');
    expect(outcome.server.auth).toEqual({ kind: 'bearer', tokenRef: expect.stringMatching(/^mcp:[0-9a-f]{24}$/) });
    expect(await app.tokenPresent(outcome.server.key)).toBe(true);
  });

  test('a server the client refuses takes its token back out of the vault, so nothing is left behind', async () => {
    const keys = memoryKeys();
    const app = new McpApp({ settings: memorySettings(EMPTY_MCP_SETTINGS), keys });
    expect((await app.addServer({ name: 'First', url: 'https://tools.example.com/mcp' })).ok).toBe(true);

    const second = await app.addServer({ name: 'Second', url: 'https://tools.example.com/mcp', token: 'another-token' });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.message).toContain('already connected');
    expect(keys.map.size).toBe(0);
  });

  test('a removed server takes its token out of the vault, so nothing is left behind', async () => {
    const keys = memoryKeys();
    const app = new McpApp({ settings: memorySettings(EMPTY_MCP_SETTINGS), keys });
    const added = await app.addServer({ name: 'Story bible', url: 'https://tools.example.com/mcp', token: 'secret-token-123' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(keys.map.size).toBe(1);

    await app.removeServer(added.server.key);
    // The client hands the token back when the server is gone: a sealed token that nothing names
    // is a token that is kept for ever.
    expect(keys.map.size).toBe(0);
  });

  test('a vault that cannot take the token back is reported to the caller, and not swallowed', async () => {
    const app = new McpApp({ settings: memorySettings(EMPTY_MCP_SETTINGS), keys: failingKeys() });
    const added = await app.addServer({ name: 'Story bible', url: 'https://tools.example.com/mcp', token: 'secret-token-123' });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    // The change of address drops the credential, and the vault refuses to let it go. The
    // failure is the caller's to see: a sealed token that stays in the vault for ever is not a
    // thing that happens quietly.
    await expect(app.client.updateServer(added.server.key, { url: 'https://elsewhere.example.com/mcp' })).rejects.toThrow(
      'the vault cannot be written',
    );
  });

  test('an import names each refused entry and keeps the rest, and it never carries a trust grant', async () => {
    const app = new McpApp({ settings: memorySettings(EMPTY_MCP_SETTINGS), keys: memoryKeys() });
    const text = JSON.stringify({
      servers: [
        { name: 'Good', url: 'https://good.example.com/mcp', enabledTools: ['search'] },
        { name: 'Trusted', url: 'https://trust.example.com/mcp', trustReads: true },
        { name: 'Bearer', url: 'https://bearer.example.com/mcp', auth: { kind: 'bearer', tokenRef: 'x' } },
        { name: 'Plain', url: 'http://example.com/mcp' },
        { name: 'Off', url: 'https://off.example.com/mcp', enabled: false },
      ],
    });

    const result = app.importServers(text, NOW);
    expect(result.added).toEqual(['Good', 'Off']);
    expect(result.refused.map((refusal) => refusal.entry)).toEqual(['"Trusted"', '"Bearer"', '"Plain"']);
    expect(result.refused[0]?.reason).toContain('trustReads');
    expect(result.refused[1]?.reason).toContain('bearer token');
    const servers = app.client.settings().servers;
    expect(servers.find((server) => server.name === 'Off')?.enabled).toBe(false);
    expect(servers.every((server) => server.trustReads === false)).toBe(true);
    expect(servers.every((server) => Object.keys(server.pinnedTools).length === 0)).toBe(true);
  });

  test('the tools an import selected are the only ones enabled once the server connects', async () => {
    const app = new McpApp({ settings: memorySettings(EMPTY_MCP_SETTINGS), keys: memoryKeys(), wire: scriptedServer(['search', 'delete']) });
    await app.client.setMasterEnabled(true);
    app.importServers(JSON.stringify({ servers: [{ name: 'Good', url: 'https://good.example.com/mcp', enabledTools: ['search'] }] }), NOW);
    const key = app.client.settings().servers[0]?.key ?? '';

    const health = await app.connect(key);
    expect(health.state).toBe('connected');
    expect(app.client.listTools(key).map((tool) => [tool.toolName, tool.enabled])).toEqual([
      ['delete', false],
      ['search', true],
    ]);
  });

  test('an import selection is kept on the stored record, through later client changes, so a restarted app keeps it before any connect', async () => {
    const settings = memorySettings(EMPTY_MCP_SETTINGS);
    const first = new McpApp({ settings, keys: memoryKeys(), wire: scriptedServer(['search', 'delete']) });
    await first.client.setMasterEnabled(true);
    first.importServers(JSON.stringify({ servers: [{ name: 'Good', url: 'https://good.example.com/mcp', enabledTools: ['search'] }] }), NOW);
    expect(settings.value().servers[0]?.enabledTools).toEqual(['search']);

    // A later change the client makes, before the server has listed anything, writes the record again and keeps the selection.
    await first.client.setMasterEnabled(false);
    await first.client.setMasterEnabled(true);
    expect(settings.value().servers[0]?.enabledTools).toEqual(['search']);
    expect(first.exportText()).toContain('"enabledTools"');
    expect(first.exportText()).toContain('"search"');

    // A restart reads the record, and the first connect applies the selection the record holds.
    const second = new McpApp({ settings, keys: memoryKeys(), wire: scriptedServer(['search', 'delete']) });
    const key = second.client.settings().servers[0]?.key ?? '';
    expect(second.client.settings().servers[0]?.enabledTools).toEqual(['search']);
    const health = await second.connect(key);
    expect(health.state).toBe('connected');
    expect(second.client.listTools(key).map((tool) => [tool.toolName, tool.enabled])).toEqual([
      ['delete', false],
      ['search', true],
    ]);
    expect(settings.value().servers[0]?.enabledTools).toEqual(['search']);
  });

  test('exported text carries names and addresses, and never a key, a token or a pin', async () => {
    const app = new McpApp({ settings: memorySettings(EMPTY_MCP_SETTINGS), keys: memoryKeys() });
    await app.addServer({ name: 'Story bible', url: 'https://tools.example.com/mcp', token: 'secret-token-456' });
    const text = app.exportText();
    expect(text).toContain('"url": "https://tools.example.com/mcp"');
    expect(text).not.toContain('secret-token-456');
    expect(text).not.toContain('tokenRef');
    expect(text).not.toContain('pinnedTools');
  });
});

test.describe('the settings slice for MCP & tools (extensibility §3.1, §8)', () => {
  const good: McpServerConfig = {
    key: 's_ABCDEFGHJK',
    name: 'Good',
    transport: 'http',
    url: 'https://good.example.com/mcp',
    auth: { kind: 'none' },
    enabled: true,
    trustReads: false,
    pinnedTools: {},
    addedAt: NOW,
  };
  const bad = { ...good, key: 's_BCDEFGHJKM', name: 'Bad', url: 'http://remote.example.com/mcp' };

  test('a broken server is dropped by name with a warning, and the good one loads', () => {
    const loaded = normalizeSettings({ mcp: { enabled: true, servers: [good, bad] } });
    expect(loaded.mcp.enabled).toBe(true);
    expect(loaded.mcp.servers.map((server) => server.name)).toEqual(['Good']);
    const warnings = mcpLoadWarnings({ mcp: { enabled: true, servers: [good, bad] } }, NOW);
    expect(warnings.some((warning) => warning.startsWith('dropped MCP server "Bad"'))).toBe(true);
  });

  test('a missing slice loads to the master switch off, with no servers', () => {
    expect(normalizeSettings({}).mcp).toEqual({ enabled: false, servers: [] });
    expect(DEFAULT_SETTINGS.mcp.enabled).toBe(false);
  });

  test('a patch replaces the slice, and nothing else in the settings moves', () => {
    const next = applyPatch(DEFAULT_SETTINGS, { mcp: { enabled: true, servers: [good] } });
    expect(next.mcp.servers).toHaveLength(1);
    expect(next.editor).toEqual(DEFAULT_SETTINGS.editor);
  });
});

test.describe('the MCP panel model (extensibility §3.2, §3.4)', () => {
  const server = {
    key: 's_ABCDEFGHJK',
    name: 'Good',
    transport: 'http' as const,
    url: 'https://good.example.com/mcp',
    auth: { kind: 'none' as const },
    enabled: true,
    trustReads: false,
    pinnedTools: {},
    addedAt: NOW,
  };

  test('a configured server says it is not connected, and offers no trust grant', () => {
    const view = mcpServerView(server, { key: server.key, state: 'configured' }, undefined);
    expect(view.detail).toContain('Not connected this session');
    expect(view.trustAvailable).toBe(false);
    expect(view.review).toBeUndefined();
  });

  test('the trust grant opens only for a healthy server with reviewed pins', () => {
    const reviewed = { ...server, pinnedTools: { 'mcp__s_ABCDEFGHJK__search': { hash: 'a'.repeat(64), firstSeen: NOW, lastReviewedAt: NOW } } };
    expect(mcpServerView(reviewed, { key: server.key, state: 'healthy', toolsDiscovered: 1 }, undefined).trustAvailable).toBe(true);
    expect(mcpServerView(reviewed, { key: server.key, state: 'connected', pendingReview: true }, undefined).trustAvailable).toBe(false);
  });

  test('a current listing has nothing to review, and a changed one shows its review', () => {
    const current = { serverKey: server.key, serverName: 'Good', kind: 'current' as const, fingerprint: 'f', tools: [], removed: [] };
    expect(mcpServerView(server, { key: server.key, state: 'healthy' }, current).review).toBeUndefined();
    const changed = { ...current, kind: 'changed' as const };
    expect(mcpServerView(server, { key: server.key, state: 'connected', pendingReview: true }, changed).review).toBe(changed);
  });

  test('the review opens with a count, and every tool stays confirm-only until it is approved', () => {
    const summary = reviewSummary({
      serverKey: server.key,
      serverName: 'Good',
      kind: 'changed',
      fingerprint: 'f',
      tools: [
        { qualifiedName: 'a', toolName: 'a', status: 'new', description: '', inputSchema: {}, candidateHash: 'h', enabled: true },
        { qualifiedName: 'b', toolName: 'b', status: 'changed', description: '', inputSchema: {}, candidateHash: 'h', enabled: true },
      ],
      removed: [{ qualifiedName: 'c', toolName: 'c', previousHash: 'h' }],
    });
    expect(summary).toBe('1 new, 1 changed, 0 unchanged, 1 removed. Every tool stays confirm-only until you approve this list.');
    expect(toolStatusLabel('changed')).toBe('Changed since review');
    expect(toolStatusLabel('new')).toBe('New, not reviewed');
  });
});
