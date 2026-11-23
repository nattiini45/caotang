/**
 * The account's project records: what a second device reads to list the projects an account has and open one it has
 * never seen. The server stores the wrapped project key and the sealed name as opaque bytes, per account, and refuses
 * anything but canonical base64 of the sizes the protocol names.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { Miniflare, Response } from 'miniflare';
import type { Request as RuntimeRequest } from 'miniflare';
import { accountOperatorSql } from '../account-policy.mjs';
import { applyMigrations } from './d1-fixture.js';
import { workerModules } from './worker-modules.js';

const ORIGIN = 'https://studio.example.invalid';
const SECRET = 'test-only-account-secret-not-a-real-credential';
const IDS: Record<string, number> = { 'reader-one': 101, 'reader-two': 202 };
const open: Miniflare[] = [];
let h: Awaited<ReturnType<typeof runtime>>;

// The runtime boots in the hook, not inside the case: it starts a workerd instance, which on GitHub's Windows
// runner can take seconds, and the case's own deadline is five.
beforeEach(async () => { h = await runtime(); }, 30_000);

/** 61 sealed bytes: format byte, 12-byte nonce, 32-byte key, 16-byte tag. */
const wrappedKey = (fill: number): string => Buffer.concat([Buffer.of(1), Buffer.alloc(60, fill)]).toString('base64');
const record = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
/** The same length, but the last character carries stray trailing bits: `atob` accepts it, canonical base64 does not. */
const nonCanonical = (value: string): string => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padding = value.search(/=+$/);
  const index = alphabet.indexOf(value[padding - 1]!);
  return `${value.slice(0, padding - 1)}${alphabet[(index + 1) % 64]}${value.slice(padding)}`;
};

async function runtime(bindings: Record<string, string> = {}) {
  const instance = new Miniflare({
    upstream: ORIGIN,
    modules: workerModules(),
    compatibilityDate: '2026-07-30',
    bindings: { PUBLIC_ORIGIN: ORIGIN, GITHUB_CLIENT_ID: 'mock-client', GITHUB_CLIENT_SECRET: 'mock-secret', SESSION_SECRET: SECRET, AUTHENTICATION_MODE: 'accounts', ...bindings },
    d1Databases: { ACCOUNT_DB: `accounts-${crypto.randomUUID()}` },
    durableObjects: { ACCOUNT_HUBS: { className: 'AccountHub', useSQLite: true } },
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
  await instance.ready;
  const db = await instance.getD1Database('ACCOUNT_DB');
  await applyMigrations(db, ['0001_accounts.sql', '0008_project_records.sql']);
  const invite = (login: string) => db.prepare(accountOperatorSql({ type: 'invite', identity: { id: `github:${IDS[login]}`, login }, limitBytes: 1_000 })).run();
  const dispatch = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => instance.dispatchFetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init });
  const signIn = async (login: string) => {
    const start = await dispatch('/v1/auth/github');
    const location = new URL(start.headers.get('Location')!);
    const pending = start.headers.getSetCookie()[0]!.split(';')[0]!;
    const finish = await dispatch(`/v1/auth/github/callback?${new URLSearchParams({ code: login, state: location.searchParams.get('state')! })}`, { headers: { Cookie: pending } });
    const session = finish.headers.getSetCookie().find((value) => value.startsWith('__Host-caotang-session='))!.split(';')[0]!;
    const account = await (await dispatch('/v1/account', { headers: { Cookie: session } })).json() as { id: string };
    return { session, accountId: account.id };
  };
  return { instance, db, invite, dispatch, signIn };
}

afterEach(async () => { await Promise.all(open.splice(0).map((instance) => instance.dispose())); });

const PROJECT = 'a1b2c3d4-0000-4000-8000-000000000001';

describe('project records', () => {
  it('records a project for one account, lists it for that account only, and stores exactly the bytes it was given', async () => {
    await h.invite('reader-one');
    await h.invite('reader-two');
    const one = await h.signIn('reader-one');
    const two = await h.signIn('reader-two');
    const put = (body: unknown, session = one.session, account = one.accountId) => h.dispatch(`/v1/projects/${PROJECT}`, {
      method: 'PUT',
      headers: { Cookie: session, Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Caotang-Account': account, 'If-None-Match': '*' },
      body: JSON.stringify(body),
    });

    expect((await put({ wrappedKey: wrappedKey(1), record: record('{"v":1,"name":"The Lighthouse"}') })).status).toBe(201);
    expect((await put({ wrappedKey: wrappedKey(2), record: record('{"v":1,"name":"another"}') })).status).toBe(409);

    const listed = await h.dispatch('/v1/projects', { headers: { Cookie: one.session, 'X-Caotang-Account': one.accountId } });
    expect(listed.status).toBe(200);
    const body = await listed.json() as { projects: { id: string; wrappedKey: string; record: string; createdAt: number; updatedAt: number }[] };
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]).toMatchObject({ id: PROJECT, wrappedKey: wrappedKey(1), record: record('{"v":1,"name":"The Lighthouse"}') });
    expect(body.projects[0]!.createdAt).toBeTypeOf('number');

    const other = await h.dispatch('/v1/projects', { headers: { Cookie: two.session, 'X-Caotang-Account': two.accountId } });
    expect((await other.json() as { projects: unknown[] }).projects).toEqual([]);
    expect((await h.dispatch(`/v1/projects/${PROJECT}`, {
      method: 'PUT',
      headers: { Cookie: two.session, Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Caotang-Account': two.accountId, 'If-None-Match': '*' },
      body: JSON.stringify({ wrappedKey: wrappedKey(3), record: record('theirs') }),
    })).status).toBe(201);
    const row = await h.db.prepare('SELECT wrapped_key AS wrappedKey, record FROM project_records WHERE account_id = ? AND project_id = ?').bind(one.accountId, PROJECT).first<{ wrappedKey: string; record: string }>();
    expect(row).toEqual({ wrappedKey: wrappedKey(1), record: record('{"v":1,"name":"The Lighthouse"}') });
  });

  it('replaces a record without a precondition, and a second device of the same account sees the rename', async () => {
    await h.invite('reader-one');
    const first = await h.signIn('reader-one');
    const second = await h.signIn('reader-one');
    const put = (body: unknown, session = first.session, precondition = '') => h.dispatch(`/v1/projects/${PROJECT}`, {
      method: 'PUT',
      headers: { Cookie: session, Origin: ORIGIN, 'Content-Type': 'application/json', 'X-Caotang-Account': first.accountId, ...(precondition === '' ? {} : { 'If-None-Match': precondition }) },
      body: JSON.stringify(body),
    });
    expect((await put({ wrappedKey: wrappedKey(1), record: record('first') })).status).toBe(200);
    expect((await put({ wrappedKey: wrappedKey(1), record: record('renamed') }, second.session)).status).toBe(200);

    const listed = await (await h.dispatch('/v1/projects', { headers: { Cookie: second.session, 'X-Caotang-Account': first.accountId } })).json() as { projects: { record: string }[] };
    expect(Buffer.from(listed.projects[0]!.record, 'base64').toString('utf8')).toBe('renamed');
  });

  it('refuses a body that is not canonical base64 of the sizes the protocol names', async () => {
    await h.invite('reader-one');
    const one = await h.signIn('reader-one');
    const put = (body: string, contentType = 'application/json') => h.dispatch(`/v1/projects/${PROJECT}`, {
      method: 'PUT',
      headers: { Cookie: one.session, Origin: ORIGIN, 'Content-Type': contentType, 'X-Caotang-Account': one.accountId, 'If-None-Match': '*' },
      body,
    });
    const valid = { wrappedKey: wrappedKey(1), record: record('a name!') };

    expect((await put(JSON.stringify(valid), 'text/plain')).status).toBe(400);
    expect((await put(JSON.stringify({ ...valid, wrappedKey: Buffer.alloc(60, 1).toString('base64') }))).status).toBe(400);
    expect((await put(JSON.stringify({ ...valid, wrappedKey: `${valid.wrappedKey.slice(0, -2)}=` }))).status).toBe(400);
    expect((await put(JSON.stringify({ ...valid, wrappedKey: nonCanonical(valid.wrappedKey) }))).status).toBe(400);
    expect((await put(JSON.stringify({ ...valid, record: nonCanonical(valid.record) }))).status).toBe(400);
    expect((await put(JSON.stringify({ ...valid, record: '' }))).status).toBe(400);
    expect((await put(JSON.stringify({ ...valid, record: Buffer.alloc(1025, 7).toString('base64') }))).status).toBe(400);
    expect((await put(JSON.stringify({ ...valid, extra: 'x' }))).status).toBe(400);
    expect((await put(JSON.stringify({ record: valid.record }))).status).toBe(400);
    expect((await put('not json')).status).toBe(400);
    expect((await put(JSON.stringify({ ...valid, record: 'not base64 !' }))).status).toBe(400);
    expect((await put(JSON.stringify(valid))).status).toBe(201);
  });

  it('refuses a project id it cannot address and a method it does not serve', async () => {
    await h.invite('reader-one');
    const one = await h.signIn('reader-one');
    const headers = { Cookie: one.session, 'X-Caotang-Account': one.accountId };
    expect((await h.dispatch('/v1/projects/not%20a%20project', { headers })).status).toBe(400);
    expect((await h.dispatch('/v1/projects', { method: 'PUT', headers: { ...headers, Origin: ORIGIN }, body: '{}' })).status).toBe(405);
    expect((await h.dispatch(`/v1/projects/${PROJECT}`, { headers })).status).toBe(405);
  });

  it('needs the account precondition and a signed-in session, and does not exist outside account mode', async () => {
    await h.invite('reader-one');
    await h.invite('reader-two');
    const one = await h.signIn('reader-one');
    const two = await h.signIn('reader-two');
    const put = (account: string | null, session: string | null) => h.dispatch(`/v1/projects/${PROJECT}`, {
      method: 'PUT',
      headers: { ...(session === null ? {} : { Cookie: session }), Origin: ORIGIN, 'Content-Type': 'application/json', ...(account === null ? {} : { 'X-Caotang-Account': account }), 'If-None-Match': '*' },
      body: JSON.stringify({ wrappedKey: wrappedKey(1), record: record('a name') }),
    });
    expect((await put(null, one.session)).status).toBe(412);
    expect((await put(two.accountId, one.session)).status).toBe(412);
    expect((await put(one.accountId, null)).status).toBe(401);
    expect((await h.dispatch('/v1/projects', { headers: {} })).status).toBe(401);

    const legacy = await runtime({ AUTHENTICATION_MODE: 'allowlist', ALLOWED_GITHUB_LOGINS: 'reader-one' });
    const payload = Buffer.from(JSON.stringify({ purpose: 'session', origin: ORIGIN, expires: Date.now() + 60_000, identity: { id: 'github:101', login: 'reader-one' } })).toString('base64url');
    const cookie = `__Host-caotang-session=${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
    expect((await legacy.dispatch('/v1/projects', { headers: { Cookie: cookie } })).status).toBe(404);
  });
});
