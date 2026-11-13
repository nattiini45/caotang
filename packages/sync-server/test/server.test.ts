import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Miniflare, Response } from 'miniflare';
import type { Request as RuntimeRequest, RequestInit as RuntimeRequestInit } from 'miniflare';
import ts from 'typescript';
import WebSocketClient from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ORIGIN = 'https://studio.example.invalid';
const TEST_SECRET = 'test-only-session-secret-not-a-real-credential';
const source = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url).href), 'utf8');
const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
let runtime: Miniflare;
const challenges = new Map<string, string>();
const exchanges: URLSearchParams[] = [];

function dispatch(url: string, init: RuntimeRequestInit = {}) {
  return runtime.dispatchFetch(url, { redirect: 'manual', ...init });
}

function signedTestCookie(purpose: 'session' | 'oauth', expires: number, origin = ORIGIN): string {
  const payload = Buffer.from(JSON.stringify({ purpose, origin, expires, identity: { id: 'github:101', login: 'reader-one' }, state: 'mock-state', verifier: 'mock-verifier' })).toString('base64url');
  const signed = `${payload}.${createHmac('sha256', TEST_SECRET).update(payload).digest('base64url')}`;
  return `${purpose === 'session' ? '__Host-caotang-session' : '__Host-caotang-oauth'}=${signed}`;
}

async function login(code = 'reader-one'): Promise<string> {
  const start = await dispatch(`${ORIGIN}/v1/auth/github`);
  const location = new URL(start.headers.get('Location')!);
  expect(location.origin).toBe('https://github.com');
  expect(location.searchParams.get('code_challenge_method')).toBe('S256');
  expect(location.searchParams.get('scope')).toBe('');
  challenges.set(code, location.searchParams.get('code_challenge')!);
  const pending = start.headers.getSetCookie()[0]!.split(';')[0]!;
  const finish = await dispatch(`${ORIGIN}/v1/auth/github/callback?${new URLSearchParams({ code, state: location.searchParams.get('state')! })}`, { headers: { Cookie: pending } });
  expect(exchanges.some((body) => body.get('code') === code), 'The token exchange uses the local mock.').toBe(true);
  expect(finish.status).toBe(302);
  expect(finish.headers.get('Location')).toBe(`${ORIGIN}/`);
  const session = finish.headers.getSetCookie().find((value) => value.startsWith('__Host-caotang-session='))!;
  expect(session).toContain('HttpOnly');
  expect(session).toContain('Secure');
  expect(session).toContain('SameSite=Lax');
  expect(session).toContain('Path=/');
  expect(session).not.toContain('Domain=');
  expect(session).not.toContain('mock-access');
  expect(finish.headers.getSetCookie().some((value) => value.startsWith('__Host-caotang-oauth=;') && value.includes('Max-Age=0'))).toBe(true);
  return session.split(';')[0]!;
}

function createRuntime(bindings: Record<string, string> = {}, upstream?: string) {
  return new Miniflare({
    ...(upstream ? { upstream } : {}),
    modules: [{ type: 'ESModule', path: 'server.mjs', contents: script }],
    compatibilityDate: '2026-07-30',
    bindings: { PUBLIC_ORIGIN: ORIGIN, ALLOWED_GITHUB_LOGINS: 'reader-one,reader-two', GITHUB_CLIENT_ID: 'mock-client', GITHUB_CLIENT_SECRET: 'mock-secret', SESSION_SECRET: TEST_SECRET, ...bindings },
    durableObjects: { ACCOUNT_HUBS: { className: 'AccountHub', useSQLite: true } },
    serviceBindings: { ASSETS: () => new Response('static shell') },
    outboundService: async (request: RuntimeRequest) => {
      const url = new URL(request.url);
      if (url.href === 'https://github.com/login/oauth/access_token') {
        const body = new URLSearchParams(await request.text());
        exchanges.push(body);
        const code = body.get('code')!;
        if (code === 'provider-error') return Response.json({ error: 'mock-private-provider-response' }, { status: 500 });
        if (code === 'provider-redirect') return new Response(null, { status: 302, headers: { Location: 'https://other.example.invalid' } });
        if (code === 'provider-oversized') return new Response('x'.repeat(65_537));
        if (code === 'provider-invalid-json') return new Response('not json');
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')!));
        expect(Buffer.from(hash).toString('base64url')).toBe(challenges.get(code));
        return Response.json({ access_token: `mock-access-${code}` });
      }
      if (url.href === 'https://api.github.com/user') {
        const login = request.headers.get('Authorization')!.replace('Bearer mock-access-', '');
        return Response.json({ id: login === 'reader-one' ? 101 : 202, login });
      }
      throw new Error('Unexpected outbound request in the local test.');
    },
  });
}

beforeAll(async () => {
  runtime = createRuntime();
  await runtime.ready;
}, 30_000);

afterAll(async () => { await runtime?.dispose(); });

describe('the standalone Worker', () => {
  it('serves health and static assets without a session and never redirects a protected API call', async () => {
    expect(await (await dispatch(`${ORIGIN}/healthz`)).json()).toEqual({ ok: true });
    expect(await (await dispatch(`${ORIGIN}/`)).text()).toBe('static shell');
    const denied = await dispatch(`${ORIGIN}/v1/session`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('Location')).toBeNull();
    expect(denied.headers.get('Cache-Control')).toBe('no-store');
  });

  it('binds state and PKCE to the browser, then returns only the verified identity', async () => {
    const session = await login();
    const result = await dispatch(`${ORIGIN}/v1/session`, { headers: { Cookie: session } });
    expect(await result.json()).toEqual({ id: 'github:101', login: 'reader-one' });
    expect(exchanges.at(-1)!.get('client_secret')).toBe('mock-secret');
    expect(exchanges.at(-1)!.get('redirect_uri')).toBe(`${ORIGIN}/v1/auth/github/callback`);
  });

  it('refuses missing, swapped and tampered OAuth state without exchanging a code', async () => {
    const start = await dispatch(`${ORIGIN}/v1/auth/github`);
    const location = new URL(start.headers.get('Location')!);
    const pending = start.headers.getSetCookie()[0]!.split(';')[0]!;
    const before = exchanges.length;
    for (const [state, cookie] of [[location.searchParams.get('state')!, ''], ['other-state', pending], [location.searchParams.get('state')!, `${pending}tampered`]]) {
      const result = await dispatch(`${ORIGIN}/v1/auth/github/callback?${new URLSearchParams({ code: 'reader-one', state: state! })}`, { headers: { Cookie: cookie! } });
      expect(result.status).toBe(400);
      expect(result.headers.get('Cache-Control')).toBe('no-store');
      expect(result.headers.getSetCookie().some((value) => value.includes('Max-Age=0'))).toBe(true);
    }
    expect(exchanges.length).toBe(before);
  });

  it('refuses uninvited logins and sanitizes upstream errors', async () => {
    for (const [code, status] of [['uninvited-reader', 403], ['provider-error', 502], ['provider-redirect', 502], ['provider-oversized', 502], ['provider-invalid-json', 502]] as const) {
      const start = await dispatch(`${ORIGIN}/v1/auth/github`);
      const location = new URL(start.headers.get('Location')!);
      challenges.set(code, location.searchParams.get('code_challenge')!);
      const pending = start.headers.getSetCookie()[0]!.split(';')[0]!;
      const result = await dispatch(`${ORIGIN}/v1/auth/github/callback?${new URLSearchParams({ code, state: location.searchParams.get('state')! })}`, { headers: { Cookie: pending } });
      expect(result.status).toBe(status);
      expect(result.headers.getSetCookie().some((value) => value.startsWith('__Host-caotang-session='))).toBe(false);
      expect(await result.text()).not.toContain('mock-private-provider-response');
    }
  });

  it('refuses forged, duplicated and purpose-swapped session cookies', async () => {
    const session = await login();
    const start = await dispatch(`${ORIGIN}/v1/auth/github`);
    const pending = start.headers.getSetCookie()[0]!.split(';')[0]!.replace('__Host-caotang-oauth=', '__Host-caotang-session=');
    for (const cookie of [`${session}tampered`, `${session}; ${session}`, pending]) {
      expect((await dispatch(`${ORIGIN}/v1/session`, { headers: { Cookie: cookie } })).status).toBe(401);
    }
  });

  it('requires an exact same-origin mutation and uses POST to sign out', async () => {
    const session = await login();
    for (const origin of ['', 'https://other.example.invalid', `${ORIGIN}.other.example.invalid`]) {
      expect((await dispatch(`${ORIGIN}/v1/auth/logout`, { method: 'POST', headers: { Cookie: session, Origin: origin } })).status).toBe(403);
    }
    expect((await dispatch(`${ORIGIN}/v1/auth/logout`, { headers: { Cookie: session } })).status).toBe(405);
    const result = await dispatch(`${ORIGIN}/v1/auth/logout`, { method: 'POST', headers: { Cookie: session, Origin: ORIGIN } });
    expect(result.status).toBe(204);
    expect(result.headers.getSetCookie()[0]).toContain('Max-Age=0');
  });

  it('refuses expired cookies, a different audience and an untrusted request origin', async () => {
    for (const [purpose, origin, expires] of [
      ['session', ORIGIN, Date.now() - 1],
      ['session', 'https://other.example.invalid', Date.now() + 60_000],
      ['oauth', ORIGIN, Date.now() - 1],
    ] as const) {
      const path = purpose === 'session' ? '/v1/session' : '/v1/auth/github/callback?state=mock-state&code=reader-one';
      const result = await dispatch(`${ORIGIN}${path}`, { headers: { Cookie: signedTestCookie(purpose, expires, origin) } });
      expect(result.status).toBe(purpose === 'session' ? 401 : 400);
    }
    expect((await dispatch('https://other.example.invalid/v1/auth/github')).status).toBe(403);
  });

  it('fails closed on missing authentication configuration without blocking the shell', async () => {
    const configurations: Record<string, string>[] = [{ SESSION_SECRET: '' }, { SESSION_SECRET: 'short-test-secret' }, { PUBLIC_ORIGIN: `${ORIGIN}/path` }, { PUBLIC_ORIGIN: 'http://studio.example.invalid' }];
    for (const config of configurations) {
      const missing = createRuntime(config);
      try {
        const result = await missing.dispatchFetch(`${ORIGIN}/v1/auth/github`, { redirect: 'manual' });
        expect(result.status).toBe(503);
        expect(result.headers.get('Cache-Control')).toBe('no-store');
        expect((await missing.dispatchFetch(`${ORIGIN}/healthz`)).status).toBe(200);
        expect(await (await missing.dispatchFetch(`${ORIGIN}/`)).text()).toBe('static shell');
      } finally {
        await missing.dispose();
      }
    }
  });

  it('rechecks the allowlist on an existing signed session', async () => {
    const session = await login();
    const changed = createRuntime({ ALLOWED_GITHUB_LOGINS: 'reader-two' });
    try {
      expect((await changed.dispatchFetch(`${ORIGIN}/v1/session`, { headers: { Cookie: session } })).status).toBe(401);
    } finally {
      await changed.dispose();
    }
  });

  it('closes expired sockets before a fresh same-identity session publishes a notification', async () => {
    const session = await login();
    const local = createRuntime({}, ORIGIN);
    let socket: WebSocketClient | undefined;
    try {
      const endpoint = new URL('/v1/live', String(await local.ready));
      endpoint.protocol = 'ws:';
      const expires = Date.now() + 1000;
      const clientOptions = { headers: { Cookie: signedTestCookie('session', expires), Origin: ORIGIN }, closeTimeout: 100 };
      socket = new WebSocketClient(endpoint.href, clientOptions);
      const messages: string[] = [];
      let closed: number | undefined;
      socket.on('message', (message) => messages.push(String(message)));
      socket.on('close', (code) => { closed = code; });
      await once(socket, 'open');
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, expires - Date.now() + 10)));
      expect((await local.dispatchFetch(`${ORIGIN}/v1/live/ping`, { method: 'POST', headers: { Cookie: session, Origin: ORIGIN } })).status).toBe(204);
      await expect.poll(() => closed).toBe(1008);
      expect(messages).toEqual([]);
    } finally {
      socket?.terminate();
      await local.dispose();
    }
  });

  it('upgrades real sockets, responds to heartbeats and isolates account pings', async () => {
    const first = await login();
    const second = await login('reader-two');
    const connect = async (cookie: string) => {
      const result = await dispatch(`${ORIGIN}/v1/live?account=other`, { headers: { Cookie: cookie, Origin: ORIGIN, Upgrade: 'websocket' } });
      expect(result.status).toBe(101);
      expect(result.headers.get('Cache-Control')).toBe('no-store');
      const socket = result.webSocket!;
      socket.accept();
      return socket;
    };
    const one = await connect(first);
    const anotherOne = await connect(first);
    const two = await connect(second);
    const firstMessages: string[] = [];
    const otherFirstMessages: string[] = [];
    const secondMessages: string[] = [];
    one.addEventListener('message', (event) => firstMessages.push(String(event.data)));
    anotherOne.addEventListener('message', (event) => otherFirstMessages.push(String(event.data)));
    two.addEventListener('message', (event) => secondMessages.push(String(event.data)));
    one.send('ping');
    await expect.poll(() => firstMessages).toContain('pong');
    const ping = await dispatch(`${ORIGIN}/v1/live/ping`, { method: 'POST', headers: { Cookie: first, Origin: ORIGIN } });
    expect(ping.status).toBe(204);
    await expect.poll(() => otherFirstMessages).toEqual(['{"type":"ping"}']);
    await expect.poll(() => firstMessages).toContain('{"type":"ping"}');
    two.send('ping');
    await expect.poll(() => secondMessages).toEqual(['pong']);
    let closed: number | undefined;
    two.addEventListener('close', (event) => { closed = event.code; });
    two.send('unexpected content');
    await expect.poll(() => closed).toBe(1008);
    one.close(); anotherOne.close(); two.close();
  });

  it('refuses unauthenticated and cross-origin WebSocket handshakes', async () => {
    expect((await dispatch(`${ORIGIN}/v1/live`, { headers: { Origin: ORIGIN, Upgrade: 'websocket' } })).status).toBe(401);
    const session = await login();
    for (const origin of ['', 'https://other.example.invalid']) {
      expect((await dispatch(`${ORIGIN}/v1/live`, { headers: { Cookie: session, Origin: origin, Upgrade: 'websocket' } })).status).toBe(403);
    }
    expect((await dispatch(`${ORIGIN}/v1/live`, { headers: { Cookie: session, Origin: ORIGIN } })).status).toBe(426);
  });
});
