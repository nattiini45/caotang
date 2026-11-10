import { describe, expect, it } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';
import { healthMachine, type ConnectionHealth, type HealthEvent } from '../src/health.js';
import { createMcpClient, createMockWire, WireError, type McpWire } from '../src/index.js';
import { serverFor } from './support.js';

const KEY = 's_AAAAAAAAAA';
const states: ConnectionHealth[] = [
  { kind: 'configured' }, { kind: 'connecting' }, { kind: 'connected', pendingReview: true },
  { kind: 'healthy', toolsDiscovered: 1 }, { kind: 'failed', reason: 'network', detail: 'Unavailable.' },
];
const events: HealthEvent[] = [
  { type: 'connect' }, { type: 'reset', detail: 'Disconnected.' }, { type: 'fail', reason: 'network', detail: 'Unavailable.' },
  { type: 'listed', pendingReview: true, toolsDiscovered: 1 },
  { type: 'listed', pendingReview: false, toolsDiscovered: 1 },
  { type: 'approve', toolsDiscovered: 1 },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('MCP connection health', () => {
  it('agrees with every table row and refuses stale completions and approvals', () => {
    expect(checkMachine(healthMachine, { states, events })).toEqual([]);
    for (const state of states.filter((state) => state.kind !== 'connecting')) {
      expect(healthMachine.step(state, { type: 'listed', pendingReview: false, toolsDiscovered: 1 })).toBe(state);
    }
    expect(healthMachine.step(states[1]!, { type: 'approve', toolsDiscovered: 1 })).toBe(states[1]);
  });

  it.each(['network', 'cors', 'timeout', 'abort', 'auth', 'http', 'protocol', 'result', 'revision', 'not-found', 'input-required'] as const)('names a %s listing failure without parsing its detail', async (reason) => {
    const client = createMcpClient({
      settings: { enabled: true, servers: [serverFor(KEY)] },
      wire: () => ({ ...createMockWire({ listTools: [], respond: () => ({ content: [] }) }), listTools: async () => { throw new WireError(reason, 'Failure.'); } }),
    });
    expect(await client.connect(KEY)).toMatchObject({ state: 'failed', reason });
    expect(client.healthOf(KEY)).not.toHaveProperty('kind');
    await client.disconnect(KEY);
    expect(client.healthOf(KEY)).toMatchObject({ state: 'configured' });
    expect(client.healthOf(KEY)).not.toHaveProperty('reason');
    await client.close();
  });

  it('publishes connecting before credentials resolve, joins connects, and clears a failure on retry', async () => {
    const token = deferred<string>();
    let reads = 0;
    let listings = 0;
    const client = createMcpClient({
      settings: { enabled: true, servers: [serverFor(KEY, 'Private', { auth: { kind: 'bearer', tokenRef: 'ref' } })] },
      resolveBearer: () => { reads += 1; return token.promise; },
      wire: () => ({ ...createMockWire({ listTools: [], respond: () => ({ content: [] }) }), listTools: async () => {
        listings += 1;
        if (listings === 1) throw new WireError('auth', 'Rejected.', 401);
        return [];
      } }),
    });
    const transitions: string[] = [];
    client.onHealthChange((health) => { transitions.push(health.state); });
    const first = client.connect(KEY);
    const joined = client.connect(KEY);
    expect(client.healthOf(KEY)).toMatchObject({ state: 'connecting' });
    expect(reads).toBe(1);
    token.resolve('test-token');
    expect(await first).toMatchObject({ state: 'failed', reason: 'auth' });
    expect(await joined).toMatchObject({ state: 'failed', reason: 'auth' });
    expect(listings).toBe(1);
    await client.connect(KEY);
    expect(client.healthOf(KEY)).toMatchObject({ state: 'healthy' });
    expect(client.healthOf(KEY)).not.toHaveProperty('reason');
    expect(transitions).toEqual(['connecting', 'failed', 'connecting', 'healthy']);
    await client.close();
  });

  it.each(['disconnect', 'disable', 'master', 'remove'] as const)('ignores a late listing after %s', async (action) => {
    const listing = deferred<Awaited<ReturnType<McpWire['listTools']>>>();
    const client = createMcpClient({
      settings: { enabled: true, servers: [serverFor(KEY)] },
      wire: () => ({ ...createMockWire({ listTools: [], respond: () => ({ content: [] }) }), listTools: () => listing.promise }),
    });
    const pending = client.connect(KEY);
    expect(client.healthOf(KEY)?.state).toBe('connecting');
    if (action === 'disconnect') await client.disconnect(KEY);
    if (action === 'disable') await client.updateServer(KEY, { enabled: false });
    if (action === 'master') await client.setMasterEnabled(false);
    if (action === 'remove') await client.removeServer(KEY);
    listing.resolve([{ name: 'late', inputSchema: { type: 'object' } }]);
    await pending;
    expect(client.healthOf(KEY)?.state).toBe(action === 'remove' ? undefined : 'configured');
    expect(client.indexedTools().tools).toEqual([]);
    expect(client.review(KEY)).toBeUndefined();
    await client.close();
  });

  it('joins a connect requested by a health observer without starting another listing', async () => {
    const listing = deferred<Awaited<ReturnType<McpWire['listTools']>>>();
    let calls = 0;
    const client = createMcpClient({
      settings: { enabled: true, servers: [serverFor(KEY)] },
      wire: () => ({ ...createMockWire({ listTools: [], respond: () => ({ content: [] }) }), listTools: () => {
        calls += 1;
        return listing.promise;
      } }),
    });
    let joined: Promise<unknown> | undefined;
    client.onHealthChange((health) => { if (health.state === 'connecting') joined = client.connect(KEY); });
    const connected = client.connect(KEY);
    listing.resolve([]);
    await Promise.all([connected, joined]);
    expect(calls).toBe(1);
    await client.close();
  });

  it('does not contact a server disconnected by a connecting-state observer', async () => {
    let calls = 0;
    const client = createMcpClient({
      settings: { enabled: true, servers: [serverFor(KEY)] },
      wire: () => { calls += 1; return createMockWire({ listTools: [], respond: () => ({ content: [] }) }); },
    });
    client.onHealthChange((health) => { if (health.state === 'connecting') void client.disconnect(KEY); });
    expect(await client.connect(KEY)).toMatchObject({ state: 'configured' });
    expect(calls).toBe(0);
    await client.close();
  });
});
