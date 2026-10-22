/**
 * The default wire is loaded on first use (lazy-wire.ts): nothing fetches the SDK until an operation
 * needs it, a URL outside the allowlist never fetches it, and a failed load is a named network
 * failure that the next operation retries.
 */

import { describe, expect, it } from 'vitest';

import { WireError as FromWire, createSdkWire } from '../src/wire.js';
import { createLazyWire, type WireLoader } from '../src/lazy-wire.js';
import { WireError, WireLoadError, createMcpClient, type McpServerConfig, type McpWire, type WireDeps } from '../src/index.js';
import { WireError as FromWireError } from '../src/wire-error.js';

const SERVER: McpServerConfig = {
  key: 's_AAAAAAAAAA',
  name: 'Example tools',
  transport: 'http',
  url: 'https://tools.example/mcp',
  auth: { kind: 'none' },
  enabled: true,
  trustReads: false,
  pinnedTools: {},
  addedAt: '2026-10-20T09:00:00.000Z',
};

const DEPS: WireDeps = {
  resolveBearer: async () => undefined,
  fetch: async () => new Response('no', { status: 500 }),
  probe: async () => false,
};

const OPTIONS = { timeoutMs: 1000 };

/** A loader that counts its calls and hands out a scripted wire. */
function counting(wire: McpWire): { readonly load: WireLoader; readonly loads: () => number } {
  let count = 0;
  return {
    loads: () => count,
    load: async () => {
      count += 1;
      return { createSdkWire: () => wire };
    },
  };
}

function scripted(log: string[] = []): McpWire {
  return {
    async listTools() {
      log.push('list');
      return [{ name: 'a' }];
    },
    async callTool(name) {
      log.push(`call ${name}`);
      return { content: [], isError: false };
    },
    async close() {
      log.push('close');
    },
  };
}

describe('the lazy wire', () => {
  it('does not load the SDK wire until an operation needs it', async () => {
    const { load, loads } = counting(scripted());
    const wire = createLazyWire(SERVER, DEPS, load);
    expect(loads()).toBe(0);
    await wire.close();
    expect(loads()).toBe(0);
    await wire.listTools(OPTIONS);
    expect(loads()).toBe(1);
  });

  it('loads once and passes every operation to the loaded wire', async () => {
    const log: string[] = [];
    const { load, loads } = counting(scripted(log));
    const wire = createLazyWire(SERVER, DEPS, load);
    expect(await wire.listTools(OPTIONS)).toEqual([{ name: 'a' }]);
    expect(await wire.callTool('b', {}, OPTIONS)).toEqual({ content: [], isError: false });
    await wire.close();
    expect(loads()).toBe(1);
    expect(log).toEqual(['list', 'call b', 'close']);
  });

  it('refuses a URL outside the allowlist before loading anything', async () => {
    const { load, loads } = counting(scripted());
    const wire = createLazyWire({ ...SERVER, url: 'https://user:pw@tools.example/mcp' }, DEPS, load);
    const error = await wire.listTools(OPTIONS).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WireError);
    expect((error as WireError).kind).toBe('network');
    expect(loads()).toBe(0);
  });

  it('reports a failed load as a named network failure, and tries again on the next operation', async () => {
    let attempts = 0;
    const load: WireLoader = async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError('Failed to fetch dynamically imported module');
      return { createSdkWire: () => scripted() };
    };
    const wire = createLazyWire(SERVER, DEPS, load);
    const error = await wire.listTools(OPTIONS).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WireLoadError);
    expect(error).toBeInstanceOf(WireError);
    expect((error as WireError).kind).toBe('network');
    expect((error as WireError).message).toContain('Failed to fetch dynamically imported module');
    expect(await wire.listTools(OPTIONS)).toEqual([{ name: 'a' }]);
    expect(attempts).toBe(2);
  });

  it('shows a failed load in the server card as the connector not loading', async () => {
    const client = createMcpClient({
      settings: { enabled: true, servers: [SERVER] },
      wire: () => createLazyWire(SERVER, DEPS, async () => { throw new TypeError('chunk 404'); }),
    });
    const health = await client.connect(SERVER.key);
    expect(health.state).toBe('configured');
    expect(health.detail).toContain('could not be loaded');
    expect(health.detail).not.toContain('check the URL');
  });

  it('keeps one WireError class across wire.ts and wire-error.ts', () => {
    expect(FromWire).toBe(FromWireError);
    expect(typeof createSdkWire).toBe('function');
  });
});
