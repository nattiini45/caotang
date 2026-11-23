/**
 * The per-device lease: while one device edits a project, another device's write is refused and its read is not; the
 * lease lapses on its own, and only a request that says so takes it over. The lease is soft, so a device that never
 * takes one is not blocked by it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Miniflare, Response } from 'miniflare';
import type { Request as RuntimeRequest } from 'miniflare';
import { accountOperatorSql } from '../account-policy.mjs';
import { applyMigrations } from './d1-fixture.js';
import { workerModules } from './worker-modules.js';

const ORIGIN = 'https://studio.example.invalid';
const SECRET = 'test-only-lease-secret-not-a-real-credential';
const IDS: Record<string, number> = { 'reader-one': 101, 'reader-two': 202 };
const PROJECT = 'p_lighthouse';
const open: Miniflare[] = [];

async function runtime() {
  const instance = new Miniflare({
    upstream: ORIGIN,
    modules: workerModules(),
    compatibilityDate: '2026-07-30',
    bindings: { PUBLIC_ORIGIN: ORIGIN, GITHUB_CLIENT_ID: 'mock-client', GITHUB_CLIENT_SECRET: 'mock-secret', SESSION_SECRET: SECRET, AUTHENTICATION_MODE: 'accounts' },
    d1Databases: { ACCOUNT_DB: `accounts-${crypto.randomUUID()}` },
    r2Buckets: { PROJECT_STORE: `projects-${crypto.randomUUID()}` },
    durableObjects: { ACCOUNT_HUBS: { className: 'AccountHub', useSQLite: true }, STORAGE_COORDINATOR: { className: 'StorageCoordinator', useSQLite: true } },
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
  await applyMigrations(db, ['0001_accounts.sql', '0002_quota.sql', '0003_quota_prune.sql', '0009_project_leases.sql']);
  const invite = (login: string) => db.prepare(accountOperatorSql({ type: 'invite', identity: { id: `github:${IDS[login]}`, login }, limitBytes: 1_000_000 })).run();
  const dispatch = (path: string, init: { method?: string; headers?: Record<string, string>; body?: Uint8Array | string } = {}) =>
    instance.dispatchFetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init });
  const signIn = async (login: string) => {
    const start = await dispatch('/v1/auth/github');
    const location = new URL(start.headers.get('Location')!);
    const pending = start.headers.getSetCookie()[0]!.split(';')[0]!;
    const finish = await dispatch(`/v1/auth/github/callback?${new URLSearchParams({ code: login, state: location.searchParams.get('state')! })}`, { headers: { Cookie: pending } });
    const session = finish.headers.getSetCookie().find((value) => value.startsWith('__Host-caotang-session='))!.split(';')[0]!;
    const accountId = (await (await dispatch('/v1/account', { headers: { Cookie: session } })).json() as { id: string }).id;
    return { session, accountId };
  };
  const lease = (device: string | null, account: string | null, session: string, method = 'POST', takeover = false) =>
    dispatch(`/v1/projects/${PROJECT}/lease`, {
      method,
      headers: {
        Cookie: session, Origin: ORIGIN,
        ...(device === null ? {} : { 'X-Caotang-Device': device }),
        ...(account === null ? {} : { 'X-Caotang-Account': account }),
        ...(takeover ? { 'X-Caotang-Takeover': '1' } : {}),
      },
    });
  const put = (session: string, device: string | null, bytes: string, precondition: Record<string, string> = { 'If-None-Match': '*' }) =>
    dispatch(`/v1/projects/${PROJECT}/blobs/manifest`, {
      method: 'PUT',
      headers: {
        Cookie: session, Origin: ORIGIN, 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length),
        ...(device === null ? {} : { 'X-Caotang-Device': device }), ...precondition,
      },
      body: bytes,
    });
  const get = (session: string) => dispatch(`/v1/projects/${PROJECT}/blobs/manifest`, { headers: { Cookie: session } });
  return { instance, db, invite, dispatch, signIn, lease, put, get };
}

afterEach(async () => { await Promise.all(open.splice(0).map((instance) => instance.dispose())); });

describe('the project lease', () => {
  it('lets the holder write and refuses another device, which can still read, until the lease lapses', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const one = await h.signIn('reader-one');
    const two = await h.signIn('reader-one');

    const taken = await h.lease('laptop', one.accountId, one.session);
    expect(taken.status).toBe(200);
    expect(await taken.json()).toMatchObject({ leased: true });

    expect((await h.put(one.session, 'laptop', 'from the laptop')).status).toBe(201);
    const refused = await h.put(two.session, 'desktop', 'from the desktop');
    expect(refused.status).toBe(423);
    expect(((await refused.json()) as { message: string }).message).toMatch(/Another device is editing this project/);
    // The second device is read-only, not blind.
    expect((await h.get(two.session)).status).toBe(200);
    // A save from the holder is not refused by its own lease.
    const first = await h.get(one.session);
    expect((await h.put(one.session, 'laptop', 'second save', { 'If-Match': first.headers.get('ETag')! })).status).toBe(200);

    // The heartbeat keeps the lease: a second beat from the holder renews it rather than losing it.
    expect(await (await h.lease('laptop', one.accountId, one.session)).json()).toMatchObject({ leased: true });
    // A beat from the other device does not take it over; it is told when the lease ends.
    const lost = await (await h.lease('desktop', one.accountId, two.session)).json() as { leased: boolean; until: number };
    expect(lost.leased).toBe(false);
    expect(lost.until).toBeGreaterThan(Date.now());

    // Lapse it the way a closed tab does, and the second device may take it.
    await h.db.prepare('UPDATE project_leases SET expires_at = ? WHERE project_id = ?').bind(Date.now() - 1, PROJECT).run();
    expect(await (await h.lease('desktop', one.accountId, two.session)).json()).toMatchObject({ leased: true });
    const etag = (await h.get(one.session)).headers.get('ETag')!;
    expect((await h.put(two.session, 'desktop', 'now from the desktop', { 'If-Match': etag })).status).toBe(200);
  });

  it('is taken over only when the request says so, and released by the device that holds it', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const one = await h.signIn('reader-one');
    await h.lease('laptop', one.accountId, one.session);

    expect(await (await h.lease('desktop', one.accountId, one.session)).json()).toMatchObject({ leased: false });
    expect(await (await h.lease('desktop', one.accountId, one.session, 'POST', true)).json()).toMatchObject({ leased: true });
    expect((await h.put(one.session, 'laptop', 'the laptop again')).status).toBe(423);

    // Releasing is the holder's alone.
    expect((await h.lease('laptop', one.accountId, one.session, 'DELETE')).status).toBe(409);
    expect((await h.lease('desktop', one.accountId, one.session, 'DELETE')).status).toBe(204);
    expect((await h.put(one.session, 'laptop', 'free again')).status).toBe(201);
  });

  it('asks a write that names no device for one while a lease is live, and never blocks a device that took none', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const one = await h.signIn('reader-one');
    expect((await h.put(one.session, null, 'no lease held')).status).toBe(201);

    await h.lease('laptop', one.accountId, one.session);
    expect((await h.put(one.session, null, 'unnamed while held')).status).toBe(428);
  });

  it('cannot be taken or read for another account, from no session, or with a malformed device', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    await h.invite('reader-two');
    const one = await h.signIn('reader-one');
    const two = await h.signIn('reader-two');

    expect((await h.lease('laptop', one.accountId, one.session)).status).toBe(200);
    expect((await h.lease('laptop', one.accountId, two.session)).status).toBe(412);
    expect((await h.lease('laptop', two.accountId, two.session)).status).toBe(200);
    expect((await h.lease('laptop', null, one.session)).status).toBe(412);
    expect((await h.lease('laptop', one.accountId, '')).status).toBe(401);
    expect((await h.lease('not a device!', one.accountId, one.session)).status).toBe(400);
    expect((await h.dispatch(`/v1/projects/${PROJECT}/lease`, { headers: { Cookie: one.session, Origin: ORIGIN, 'X-Caotang-Account': one.accountId } })).status).toBe(400);
    // Another account's session sees a free project of its own, never one's lease.
    expect(await (await h.lease('laptop', two.accountId, two.session)).json()).toMatchObject({ leased: true });
    expect((await h.put(one.session, 'desktop', 'refused while the laptop holds it')).status).toBe(423);
    expect((await h.put(one.session, 'laptop', 'the holder writes')).status).toBe(201);
  });
});
