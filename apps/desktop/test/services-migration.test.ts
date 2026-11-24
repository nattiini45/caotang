/**
 * The addresses the keychain's upgrade needs (desktop.md §The keychain, #864): a key an earlier build stored in this browser is
 * moved, and one it stored in the keychain is given its address, only for an address its own record names. This is auxiliary
 * data for that migration, so a settings database that will not answer must not stop the app from opening.
 */

import { describe, expect, it } from 'vitest';
import type { McpSettings, McpServerConfig } from '@caotang/mcp-client';

import { migrationOrigins } from '../src/app/services.js';
import type { AppDb } from '../src/app/app-db.js';

const PROFILE = 'prv_ABCDEFGHJK';
const TOKEN_REF = 'mcp:0123456789abcdef01234567';

function settings(servers: readonly McpServerConfig[] = []): McpSettings {
  return { servers } as unknown as McpSettings;
}

function server(overrides: Partial<McpServerConfig> & { readonly url: string }): McpServerConfig {
  return {
    key: 'srv-one',
    name: 'One',
    enabled: true,
    auth: { kind: 'none' },
    ...overrides,
  } as unknown as McpServerConfig;
}

/** The settings database as this lookup sees it: one key, and whatever answer a case scripts for it. */
function database(answer: (key: string) => Promise<unknown>): Pick<AppDb, 'get'> {
  return { get: (async <T,>(key: string): Promise<T | undefined> => await answer(key) as T | undefined) };
}

describe('the addresses a stored credential belongs to', () => {
  it('names each provider profile’s endpoint origin', async () => {
    const db = database(async () => [{ id: PROFILE, baseUrl: 'https://api.example.com/v1' }, { id: 'prv_ZZZZZZZZZZ', baseUrl: 'http://127.0.0.1:11434/v1' }]);
    const origins = await migrationOrigins(db, settings());
    expect([...origins]).toEqual([[PROFILE, 'https://api.example.com'], ['prv_ZZZZZZZZZZ', 'http://127.0.0.1:11434']]);
  });

  it('carries a saved MCP bearer token’s reference, at its server’s own origin', async () => {
    const db = database(async () => []);
    const origins = await migrationOrigins(db, settings([
      server({ url: 'https://mcp.example.com/mcp', auth: { kind: 'bearer', tokenRef: TOKEN_REF } }),
    ]));
    expect([...origins]).toEqual([[TOKEN_REF, 'https://mcp.example.com']]);
  });

  it('places a token two servers share at the first server’s address, and never moves it to the second (#879)', async () => {
    const db = database(async () => []);
    const origins = await migrationOrigins(db, settings([
      server({ key: 'srv-one', url: 'http://127.0.0.1:3845/mcp', auth: { kind: 'bearer', tokenRef: TOKEN_REF } }),
      server({ key: 'srv-two', url: 'http://127.0.0.1:3846/mcp', auth: { kind: 'bearer', tokenRef: TOKEN_REF } }),
    ]));
    // One entry holds one address: the token is placed for the first server that names it, and the second server's address
    // never serves it — so the second is refused a token this computer holds for another address instead of being handed it.
    expect([...origins]).toEqual([[TOKEN_REF, 'http://127.0.0.1:3845']]);
  });

  it('names nothing for a server without a bearer token, because it has no key to move', async () => {
    const db = database(async () => []);
    expect([...(await migrationOrigins(db, settings([server({ url: 'https://mcp.example.com/mcp' })])))]).toEqual([]);
  });

  it('opens with no origins when the settings database will not answer', async () => {
    const db = database(async () => { throw new Error('The transaction aborted.'); });
    await expect(migrationOrigins(db, settings())).resolves.toEqual(new Map());
  });

  it('opens with no origins when the stored profiles are not a list', async () => {
    const db = database(async () => ({ not: 'a list' }));
    await expect(migrationOrigins(db, settings())).resolves.toEqual(new Map());
  });

  it('names no origin for a profile whose address does not parse, so its key is not placed', async () => {
    const db = database(async () => [{ id: PROFILE, baseUrl: 'not an address' }, { id: 'prv_ZZZZZZZZZZ' }]);
    await expect(migrationOrigins(db, settings())).resolves.toEqual(new Map());
  });

  it('has nothing to name without a settings database', async () => {
    await expect(migrationOrigins(null, settings())).resolves.toEqual(new Map());
  });
});
