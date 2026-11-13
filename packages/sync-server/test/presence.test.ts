import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Miniflare, Response } from 'miniflare';
import ts from 'typescript';
import WebSocketClient from 'ws';
import { expect, it } from 'vitest';

const ORIGIN = 'https://studio.example.invalid';
const SECRET = 'test-only-presence-secret-not-a-real-credential';
const ONE = '00000000-0000-4000-8000-000000000001';
const TWO = '00000000-0000-4000-8000-000000000002';
const THREE = '00000000-0000-4000-8000-000000000003';
const source = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url).href), 'utf8');
const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;

function cookie(id = 'github:101', expires = Date.now() + 60_000): string {
  const payload = Buffer.from(JSON.stringify({ purpose: 'session', origin: ORIGIN, expires, identity: { id, login: 'reader-one' } })).toString('base64url');
  return `__Host-caotang-session=${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
}

async function harness() {
  const runtime = new Miniflare({
    upstream: ORIGIN,
    modules: [{ type: 'ESModule', path: 'server.mjs', contents: script + `
export class TestAccountHub extends AccountHub {
  async ageProfile(profile, sweep = true) {
    for (const socket of this.ctx.getWebSockets()) {
      const value = socket.deserializeAttachment();
      if (value?.profile === profile) socket.serializeAttachment({ ...value, connectedAt: Date.now() - 60_001 });
    }
    if (sweep) await this.alarm();
  }
  failProfile(profile) {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(message) {
      if (this.deserializeAttachment()?.profile === profile) throw new Error('Synthetic send failure');
      return send.call(this, message);
    };
  }
  async nextAlarm() { return this.ctx.storage.getAlarm(); }
}
` }],
    compatibilityDate: '2026-07-30',
    bindings: { PUBLIC_ORIGIN: ORIGIN, ALLOWED_GITHUB_LOGINS: 'reader-one', GITHUB_CLIENT_ID: 'mock-client', GITHUB_CLIENT_SECRET: 'mock-secret', SESSION_SECRET: SECRET },
    durableObjects: { ACCOUNT_HUBS: { className: 'TestAccountHub', useSQLite: true } },
    serviceBindings: { ASSETS: () => new Response('static shell') },
    outboundService: () => { throw new Error('Presence tests never contact a provider.'); },
  });
  const address = String(await runtime.ready);
  const clients: WebSocketClient[] = [];
  const connect = async (profile?: string, session = cookie()) => {
    const url = new URL('/v1/live', address);
    url.protocol = 'ws:';
    if (profile) url.searchParams.set('presence', profile);
    const options = { headers: { Cookie: session, Origin: ORIGIN }, closeTimeout: 100 };
    const socket = new WebSocketClient(url.href, options);
    clients.push(socket);
    const messages: string[] = [];
    const events: { type: string; peers: number; change: string }[] = [];
    let closeCode: number | undefined;
    socket.on('close', (code) => { closeCode = code; });
    socket.on('message', (data) => {
      const text = String(data);
      messages.push(text);
      if (text.startsWith('{')) {
        const event = JSON.parse(text);
        if (event.type === 'presence') events.push(event);
      }
    });
    await once(socket, 'open');
    if (profile) await expect.poll(() => events.length).toBeGreaterThan(0);
    return { socket, messages, events, get closeCode() { return closeCode; } };
  };
  const namespace = await runtime.getDurableObjectNamespace('ACCOUNT_HUBS');
  const hub = namespace.get(namespace.idFromName('github:101')) as unknown as { ageProfile(profile: string, sweep?: boolean): Promise<void>; failProfile(profile: string): Promise<void>; nextAlarm(): Promise<number | null> };
  return {
    runtime, connect, hub,
    ping: (profile?: string) => runtime.dispatchFetch(`${ORIGIN}/v1/live/ping${profile ? `?presence=${profile}` : ''}`, { method: 'POST', headers: { Cookie: cookie(), Origin: ORIGIN } }),
    close: async () => { for (const client of clients) client.terminate(); await runtime.dispose(); },
  };
}

it('counts other profiles, deduplicates tabs and isolates accounts without disclosing identifiers', async () => {
  const h = await harness();
  try {
    const first = await h.connect(ONE);
    expect(first.events).toEqual([{ type: 'presence', peers: 0, change: 'snapshot' }]);
    const duplicate = await h.connect(ONE);
    expect(duplicate.events.at(-1)?.peers).toBe(0);
    expect(first.events.some((event) => event.change === 'joined')).toBe(false);
    const otherAccount = await h.connect(THREE, cookie('github:202'));
    const second = await h.connect(TWO);
    await expect.poll(() => first.events.at(-1)).toEqual({ type: 'presence', peers: 1, change: 'joined' });
    expect(second.events.at(-1)).toEqual({ type: 'presence', peers: 1, change: 'snapshot' });
    first.socket.close();
    await expect.poll(() => first.socket.readyState).toBe(WebSocketClient.CLOSED);
    expect(second.events.some((event) => event.change === 'left')).toBe(false);
    duplicate.socket.close();
    await expect.poll(() => second.events.at(-1)).toEqual({ type: 'presence', peers: 0, change: 'left' });
    expect(otherAccount.events).toEqual([{ type: 'presence', peers: 0, change: 'snapshot' }]);
    for (const text of [...first.messages, ...second.messages]) {
      expect(text).not.toContain(ONE);
      expect(text).not.toContain(TWO);
      expect(text).not.toContain('github:');
    }
  } finally { await h.close(); }
});

it('keeps legacy pings exact and announces only another live profile’s explicit activity', async () => {
  const h = await harness();
  try {
    const legacy = await h.connect();
    const first = await h.connect(ONE);
    const duplicate = await h.connect(ONE);
    const second = await h.connect(TWO);
    expect(legacy.messages).toEqual([]);
    expect((await h.ping(ONE)).status).toBe(204);
    await expect.poll(() => second.events.at(-1)?.change).toBe('activity');
    expect(first.events.some((event) => event.change === 'activity')).toBe(false);
    expect(duplicate.events.some((event) => event.change === 'activity')).toBe(false);
    expect(legacy.messages).toEqual(['{"type":"ping"}']);
    const activities = second.events.filter((event) => event.change === 'activity').length;
    await h.ping();
    await h.ping(THREE);
    await expect.poll(() => legacy.messages.length).toBe(3);
    expect(second.events.filter((event) => event.change === 'activity')).toHaveLength(activities);
    first.socket.send('ping');
    await expect.poll(() => first.messages).toContain('pong');
  } finally { await h.close(); }
});

it('uses persisted attachments and automatic heartbeat timestamps for lease expiry, then stops the alarm', async () => {
  const h = await harness();
  try {
    const first = await h.connect(ONE);
    const second = await h.connect(TWO);
    expect(await h.hub.nextAlarm()).not.toBeNull();
    second.socket.send('ping');
    await expect.poll(() => second.messages).toContain('pong');
    await h.hub.ageProfile(TWO);
    expect(second.socket.readyState).toBe(WebSocketClient.OPEN);
    await h.hub.ageProfile(ONE);
    await expect.poll(() => first.socket.readyState).toBe(WebSocketClient.CLOSED);
    expect(first.closeCode).toBe(1008);
    await expect.poll(() => second.events.at(-1)).toEqual({ type: 'presence', peers: 0, change: 'left' });
    second.socket.send('unexpected');
    await expect.poll(() => second.socket.readyState).toBe(WebSocketClient.CLOSED);
    await expect.poll(() => h.hub.nextAlarm()).toBeNull();
  } finally { await h.close(); }
});

it('expires presence at the actual session deadline without waiting for another notification', async () => {
  const h = await harness();
  try {
    const short = await h.connect(ONE, cookie('github:101', Date.now() + 1500));
    const second = await h.connect(TWO);
    await expect.poll(() => short.socket.readyState, { timeout: 5000 }).toBe(WebSocketClient.CLOSED);
    expect(short.closeCode).toBe(1008);
    await expect.poll(() => second.events.at(-1)).toEqual({ type: 'presence', peers: 0, change: 'left' });
  } finally { await h.close(); }
});

it('announces lease cleanup during a ping and a join, rather than losing the departure in a snapshot', async () => {
  const h = await harness();
  try {
    await h.connect(ONE);
    const second = await h.connect(TWO);
    await h.hub.ageProfile(ONE, false);
    await h.ping(TWO);
    await expect.poll(() => second.events.at(-1)).toEqual({ type: 'presence', peers: 0, change: 'left' });
    await h.connect(ONE);
    const before = second.events.length;
    await h.hub.ageProfile(ONE, false);
    await h.connect(THREE);
    await expect.poll(() => second.events.slice(before)).toEqual([
      { type: 'presence', peers: 1, change: 'left' },
      { type: 'presence', peers: 1, change: 'joined' },
    ]);
  } finally { await h.close(); }
});

it('republishes corrected counts and a departure if a presence send fails mid-broadcast', async () => {
  const h = await harness();
  try {
    await h.connect(ONE);
    const second = await h.connect(TWO);
    await h.hub.failProfile(ONE);
    const third = await h.connect(THREE);
    await expect.poll(() => second.events.at(-1)).toEqual({ type: 'presence', peers: 1, change: 'left' });
    await expect.poll(() => third.events.at(-1)).toEqual({ type: 'presence', peers: 1, change: 'left' });
    await h.ping(TWO);
    await expect.poll(() => third.events.at(-1)).toEqual({ type: 'presence', peers: 1, change: 'activity' });
  } finally { await h.close(); }
});

it('rejects malformed and repeated presence labels behind the usual authentication and origin guards', async () => {
  const h = await harness();
  try {
    for (const query of ['presence=', 'presence=not-a-uuid', `presence=${ONE}&presence=${TWO}`]) {
      for (const [path, method] of [['live', 'GET'], ['live/ping', 'POST']]) {
        const response = await h.runtime.dispatchFetch(`${ORIGIN}/v1/${path}?${query}`, { method, headers: { Cookie: cookie(), Origin: ORIGIN, ...(method === 'GET' ? { Upgrade: 'websocket' } : {}) } });
        expect(response.status).toBe(400);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
      }
    }
    expect((await h.runtime.dispatchFetch(`${ORIGIN}/v1/live?presence=${ONE}`, { headers: { Origin: ORIGIN, Upgrade: 'websocket' } })).status).toBe(401);
    expect((await h.runtime.dispatchFetch(`${ORIGIN}/v1/live?presence=${ONE}`, { headers: { Cookie: cookie(), Origin: 'https://other.example.invalid', Upgrade: 'websocket' } })).status).toBe(403);
  } finally { await h.close(); }
});
