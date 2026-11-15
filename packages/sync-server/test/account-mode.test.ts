import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { Miniflare, Response } from 'miniflare';
import type { Request as RuntimeRequest } from 'miniflare';
import WebSocketClient from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { accountOperatorSql } from '../account-policy.mjs';
import { applyMigrations } from './d1-fixture.js';
import { workerModules } from './worker-modules.js';

const ORIGIN = 'https://studio.example.invalid';
const SECRET = 'test-only-account-secret-not-a-real-credential';
const IDS: Record<string, number> = { 'reader-one': 101, 'reader-two': 202, 'uninvited-reader': 303 };
const hubs = `
export class TestAccountHub extends AccountHub {
  async runAlarm() { await this.alarm(); }
  async nextAlarm() { return this.ctx.storage.getAlarm(); }
  async ageProfile(profile) {
    for (const socket of this.ctx.getWebSockets()) {
      const value = socket.deserializeAttachment();
      if (value?.profile === profile) socket.serializeAttachment({ ...value, connectedAt: Date.now() - 60_001 });
    }
    await this.alarm();
  }
}
`;
const ONE = '00000000-0000-4000-8000-000000000001';
const TWO = '00000000-0000-4000-8000-000000000002';
const open: Miniflare[] = [];

async function runtime(bindings: Record<string, string> = {}, options: { migrate?: boolean; database?: boolean } = {}) {
  const instance = new Miniflare({
    upstream: ORIGIN,
    modules: workerModules(hubs),
    compatibilityDate: '2026-07-30',
    bindings: { PUBLIC_ORIGIN: ORIGIN, GITHUB_CLIENT_ID: 'mock-client', GITHUB_CLIENT_SECRET: 'mock-secret', SESSION_SECRET: SECRET, AUTHENTICATION_MODE: 'accounts', ...bindings },
    ...(options.database === false ? {} : { d1Databases: { ACCOUNT_DB: `accounts-${crypto.randomUUID()}` } }),
    durableObjects: { ACCOUNT_HUBS: { className: 'TestAccountHub', useSQLite: true } },
    serviceBindings: { ASSETS: () => new Response('static shell') },
    outboundService: async (request: RuntimeRequest) => {
      const url = new URL(request.url);
      if (url.href === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: `mock-access-${new URLSearchParams(await request.text()).get('code')}` });
      if (url.href === 'https://api.github.com/user') {
        const login = request.headers.get('Authorization')!.replace('Bearer mock-access-', '');
        return Response.json({ id: IDS[login], login });
      }
      throw new Error('Unexpected outbound request in the local test.');
    },
  });
  open.push(instance);
  const address = String(await instance.ready);
  const db = options.database === false ? undefined : await instance.getD1Database('ACCOUNT_DB');
  if (db && options.migrate !== false) await applyMigrations(db, ['0001_accounts.sql']);
  const invite = (login: string, limitBytes = 1_000) => db!.prepare(accountOperatorSql({ type: 'invite', identity: { id: `github:${IDS[login]}`, login }, limitBytes })).run();
  const revoke = (login: string) => db!.prepare(accountOperatorSql({ type: 'revoke', githubId: `github:${IDS[login]}` })).run();
  const dispatch = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) => instance.dispatchFetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init });
  const signIn = async (login: string) => {
    const start = await dispatch('/v1/auth/github');
    const location = new URL(start.headers.get('Location')!);
    const pending = start.headers.getSetCookie()[0]!.split(';')[0]!;
    const finish = await dispatch(`/v1/auth/github/callback?${new URLSearchParams({ code: login, state: location.searchParams.get('state')! })}`, { headers: { Cookie: pending } });
    const session = finish.headers.getSetCookie().find((value) => value.startsWith('__Host-caotang-session='))?.split(';')[0];
    return { finish, session };
  };
  const connect = async (session: string, profile?: string) => {
    const url = new URL('/v1/live', address);
    url.protocol = 'ws:';
    if (profile) url.searchParams.set('presence', profile);
    const options = { headers: { Cookie: session, Origin: ORIGIN }, closeTimeout: 100 };
    const socket = new WebSocketClient(url.href, options);
    const messages: string[] = [];
    let closeCode: number | undefined;
    socket.on('message', (data) => messages.push(String(data)));
    socket.on('close', (code) => { closeCode = code; });
    await once(socket, 'open');
    return { socket, messages, get closeCode() { return closeCode; } };
  };
  return { instance, db, invite, revoke, dispatch, signIn, connect };
}

function signed(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `__Host-caotang-session=${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}

afterEach(async () => { await Promise.all(open.splice(0).map((instance) => instance.dispose())); });

describe('the Worker in account mode', () => {
  it('claims an invited numeric identity at sign-in and serves its own account and usage', async () => {
    const h = await runtime();
    await h.invite('reader-one', 64);
    const { finish, session } = await h.signIn('reader-one');
    expect(finish.status).toBe(302);
    expect(session).toBeDefined();
    const identity = await (await h.dispatch('/v1/session', { headers: { Cookie: session! } })).json();
    expect(identity).toEqual({ id: 'github:101', login: 'reader-one' });
    const account = await (await h.dispatch('/v1/account', { headers: { Cookie: session! } })).json() as { id: string; usage: unknown };
    expect(account.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(account.usage).toEqual({ limitBytes: 64, usedBytes: 0, reservedBytes: 0 });
    expect(JSON.stringify(account)).not.toContain('101');
    expect((await h.dispatch('/v1/account')).status).toBe(401);
    expect((await h.signIn('reader-one')).session).toBeDefined();
  });

  it('never falls back to the allowlist for an uninvited, missing or misconfigured account store', async () => {
    const h = await runtime({ ALLOWED_GITHUB_LOGINS: 'uninvited-reader' });
    const refused = await h.signIn('uninvited-reader');
    expect(refused.finish.status).toBe(403);
    expect(refused.session).toBeUndefined();
    const withoutDatabase = await runtime({ ALLOWED_GITHUB_LOGINS: 'reader-one' }, { database: false });
    expect((await withoutDatabase.dispatch('/v1/auth/github')).status).toBe(503);
    expect(await (await withoutDatabase.dispatch('/')).text()).toBe('static shell');
    expect((await withoutDatabase.dispatch('/healthz')).status).toBe(200);
    const unknown = await runtime({ AUTHENTICATION_MODE: 'accounts-only' });
    expect((await unknown.dispatch('/v1/auth/github')).status).toBe(503);
  });

  it('returns a sanitized 503 when the account database fails and issues no session', async () => {
    const h = await runtime({}, { migrate: false });
    const { finish, session } = await h.signIn('reader-one');
    expect(finish.status).toBe(503);
    expect(session).toBeUndefined();
    const text = await finish.text();
    expect(text).not.toMatch(/no such table|SQL|D1_ERROR/i);
    const protectedCall = await h.dispatch('/v1/session', { headers: { Cookie: signed({ purpose: 'session', origin: ORIGIN, expires: Date.now() + 60_000, mode: 'accounts', identity: { id: 'github:101', login: 'reader-one' }, account: { id: 'any', revision: 1 } }) } });
    expect(protectedCall.status).toBe(503);
    expect(await protectedCall.text()).not.toMatch(/no such table|SQL|D1_ERROR/i);
    const cookie = signed({ purpose: 'session', origin: ORIGIN, expires: Date.now() + 60_000, mode: 'accounts', identity: { id: 'github:101', login: 'reader-one' }, account: { id: 'any', revision: 1 } });
    const signOut = await h.dispatch('/v1/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN } });
    expect(signOut.status).toBe(204);
    expect(signOut.headers.getSetCookie()[0]).toContain('Max-Age=0');
    expect((await h.dispatch('/v1/auth/logout', { headers: { Cookie: cookie } })).status).toBe(405);
    expect((await h.dispatch('/v1/auth/logout', { method: 'POST', headers: { Cookie: cookie } })).status).toBe(403);
  });

  it('revalidates on every call, so revocation stops old sessions and regranting never revives them', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const first = (await h.signIn('reader-one')).session!;
    const before = await (await h.dispatch('/v1/account', { headers: { Cookie: first } })).json() as { id: string };
    await h.revoke('reader-one');
    expect((await h.dispatch('/v1/session', { headers: { Cookie: first } })).status).toBe(401);
    expect((await h.signIn('reader-one')).finish.status).toBe(403);
    await h.invite('reader-one');
    expect((await h.dispatch('/v1/session', { headers: { Cookie: first } })).status).toBe(401);
    const second = (await h.signIn('reader-one')).session!;
    const after = await (await h.dispatch('/v1/account', { headers: { Cookie: second } })).json() as { id: string };
    expect(after.id).toBe(before.id);
  });

  it('keeps the two cookie families apart', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const legacy = signed({ purpose: 'session', origin: ORIGIN, expires: Date.now() + 60_000, identity: { id: 'github:101', login: 'reader-one' } });
    expect((await h.dispatch('/v1/session', { headers: { Cookie: legacy } })).status).toBe(401);
    const account = (await h.signIn('reader-one')).session!;
    const allowlist = await runtime({ AUTHENTICATION_MODE: 'allowlist', ALLOWED_GITHUB_LOGINS: 'reader-one' });
    expect((await allowlist.dispatch('/v1/session', { headers: { Cookie: account } })).status).toBe(401);
    expect((await allowlist.dispatch('/v1/account', { headers: { Cookie: legacy } })).status).toBe(404);
  });

  it('signs out everywhere with a same-origin POST that advances the revision', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const one = (await h.signIn('reader-one')).session!;
    const two = (await h.signIn('reader-one')).session!;
    expect((await h.dispatch('/v1/auth/logout-all', { method: 'POST', headers: { Cookie: one } })).status).toBe(403);
    expect((await h.dispatch('/v1/auth/logout-all', { headers: { Cookie: one } })).status).toBe(405);
    const result = await h.dispatch('/v1/auth/logout-all', { method: 'POST', headers: { Cookie: one, Origin: ORIGIN } });
    expect(result.status).toBe(204);
    expect(result.headers.getSetCookie()[0]).toContain('Max-Age=0');
    for (const session of [one, two]) expect((await h.dispatch('/v1/session', { headers: { Cookie: session } })).status).toBe(401);
    expect((await h.signIn('reader-one')).session).toBeDefined();
  });

  it('names the hub from the account, checks every heartbeat and closes revoked sockets', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    await h.invite('reader-two');
    const session = (await h.signIn('reader-one')).session!;
    const other = (await h.signIn('reader-two')).session!;
    const accountId = (await (await h.dispatch('/v1/account', { headers: { Cookie: session } })).json() as { id: string }).id;
    const namespace = await h.instance.getDurableObjectNamespace('ACCOUNT_HUBS');
    const hub = namespace.get(namespace.idFromName(accountId)) as unknown as { nextAlarm(): Promise<number | null>; runAlarm(): Promise<void> };
    expect(await hub.nextAlarm()).toBeNull();
    const first = await h.connect(session);
    const second = await h.connect(session);
    const stranger = await h.connect(other);
    expect(await hub.nextAlarm()).not.toBeNull();
    first.socket.send('ping');
    await expect.poll(() => first.messages).toEqual(['pong']);
    expect((await h.dispatch('/v1/live/ping', { method: 'POST', headers: { Cookie: session, Origin: ORIGIN } })).status).toBe(204);
    await expect.poll(() => second.messages).toEqual(['{"type":"ping"}']);
    expect(stranger.messages).toEqual([]);
    await h.revoke('reader-one');
    first.socket.send('ping');
    await expect.poll(() => first.closeCode).toBe(1008);
    expect(first.messages).toEqual(['pong', '{"type":"ping"}']);
    await hub.runAlarm();
    await expect.poll(() => second.closeCode).toBe(1008);
    expect(await hub.nextAlarm()).toBeNull();
    expect(stranger.closeCode).toBeUndefined();
    stranger.socket.terminate();
  });

  it('refuses a socket handshake for a revoked account and cancels the alarm after the last socket closes', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const session = (await h.signIn('reader-one')).session!;
    const accountId = (await (await h.dispatch('/v1/account', { headers: { Cookie: session } })).json() as { id: string }).id;
    const namespace = await h.instance.getDurableObjectNamespace('ACCOUNT_HUBS');
    const hub = namespace.get(namespace.idFromName(accountId)) as unknown as { nextAlarm(): Promise<number | null> };
    const live = await h.connect(session);
    expect(await hub.nextAlarm()).not.toBeNull();
    live.socket.close();
    await expect.poll(() => hub.nextAlarm()).toBeNull();
    await h.revoke('reader-one');
    const refused = await h.dispatch('/v1/live', { headers: { Cookie: session, Origin: ORIGIN, Upgrade: 'websocket' } });
    expect(refused.status).toBe(401);
  });
  it('keeps presence and its heartbeat lease working in account mode without auto-responses',  async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const session = (await h.signIn('reader-one')).session!;
    const accountId = (await (await h.dispatch('/v1/account', { headers: { Cookie: session } })).json() as { id: string }).id;
    const namespace = await h.instance.getDurableObjectNamespace('ACCOUNT_HUBS');
    const hub = namespace.get(namespace.idFromName(accountId)) as unknown as { ageProfile(profile: string): Promise<void> };
    const laptop = await h.connect(session, ONE);
    const phone = await h.connect(session, TWO);
    const events = (client: { messages: string[] }) => client.messages.filter((text) => text.startsWith('{"type":"presence"')).map((text) => JSON.parse(text) as { peers: number; change: string });
    await expect.poll(() => events(laptop).at(-1)).toEqual({ type: 'presence', peers: 1, change: 'joined' });
    phone.socket.send('ping');
    await expect.poll(() => phone.messages).toContain('pong');
    await hub.ageProfile(TWO);
    expect(phone.closeCode).toBeUndefined();
    await hub.ageProfile(ONE);
    await expect.poll(() => laptop.closeCode).toBe(1008);
    await expect.poll(() => events(phone).at(-1)).toEqual({ type: 'presence', peers: 0, change: 'left' });
    phone.socket.terminate();
  });
});
