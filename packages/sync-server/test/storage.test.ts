import { request as httpRequest } from 'node:http';
import { Miniflare, Response } from 'miniflare';
import type { Request as RuntimeRequest } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import { accountOperatorSql } from '../account-policy.mjs';
import { QuotaStore } from '../src/quota.js';
import { MAX_OBJECT_BYTES } from '../src/storage.js';
import { BlobPreconditionFailedError } from '../../remote-store/src/blob-store.js';
import { RemoteQuotaExceededError } from '../../remote-store/src/errors.js';
import { createHttpBlobStore } from '../../remote-store/src/http-blob-store.js';
import { applyMigrations } from './d1-fixture.js';
import { workerModules } from './worker-modules.js';

const ORIGIN = 'https://studio.example.invalid';
const SECRET = 'test-only-storage-secret-not-a-real-credential';
const IDS: Record<string, number> = { 'reader-one': 101, 'reader-two': 202 };
const PROJECT = 'p_0123456789';
const open: Miniflare[] = [];

async function runtime(bindings: Record<string, string> = {}, options: { store?: boolean; mode?: string } = {}) {
  const instance = new Miniflare({
    upstream: ORIGIN,
    modules: workerModules(),
    compatibilityDate: '2026-07-30',
    unsafeTriggerHandlers: true,
    bindings: {
      PUBLIC_ORIGIN: ORIGIN, GITHUB_CLIENT_ID: 'mock-client', GITHUB_CLIENT_SECRET: 'mock-secret', SESSION_SECRET: SECRET,
      AUTHENTICATION_MODE: options.mode ?? 'accounts', ...bindings,
    },
    d1Databases: { ACCOUNT_DB: `accounts-${crypto.randomUUID()}` },
    ...(options.store === false ? {} : { r2Buckets: { PROJECT_STORE: `projects-${crypto.randomUUID()}` } }),
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
  const address = String(await instance.ready);
  const db = await instance.getD1Database('ACCOUNT_DB');
  await applyMigrations(db, ['0001_accounts.sql', '0002_quota.sql']);
  const bucket = options.store === false ? undefined : await instance.getR2Bucket('PROJECT_STORE');
  const invite = (login: string, limitBytes = 1_000) => db.prepare(accountOperatorSql({ type: 'invite', identity: { id: `github:${IDS[login]}`, login }, limitBytes })).run();
  const dispatch = (path: string, init: { method?: string; headers?: Record<string, string>; body?: Uint8Array | ReadableStream | string; duplex?: 'half' } = {}) =>
    instance.dispatchFetch(`${ORIGIN}${path}`, { redirect: 'manual', ...init });
  const signIn = async (login: string) => {
    const start = await dispatch('/v1/auth/github');
    const location = new URL(start.headers.get('Location')!);
    const pending = start.headers.getSetCookie()[0]!.split(';')[0]!;
    const finish = await dispatch(`/v1/auth/github/callback?${new URLSearchParams({ code: login, state: location.searchParams.get('state')! })}`, { headers: { Cookie: pending } });
    const session = finish.headers.getSetCookie().find((value) => value.startsWith('__Host-caotang-session='))?.split(';')[0];
    return session ?? '';
  };
  const call = (session: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: Uint8Array | ReadableStream | string; duplex?: 'half' } = {}) =>
    dispatch(path, { ...init, headers: { Cookie: session, Origin: ORIGIN, ...init.headers } });
  const put = (session: string, name: string, bytes: Uint8Array, precondition: Record<string, string>, key?: string) =>
    call(session, `/v1/projects/${PROJECT}/blobs/${name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength), ...precondition, ...(key ? { 'Idempotency-Key': key } : {}) },
      body: bytes,
    });
  const usage = async (session: string) => (await (await dispatch('/v1/account', { headers: { Cookie: session } })).json() as { usage: { limitBytes: number; usedBytes: number; reservedBytes: number } }).usage;
  const sweep = () => dispatch('/cdn-cgi/handler/scheduled');
  const accountId = async (session: string) => (await (await dispatch('/v1/account', { headers: { Cookie: session } })).json() as { id: string }).id;
  return { instance, address, db, bucket, invite, dispatch, signIn, call, put, usage, sweep, accountId };
}

afterEach(async () => { await Promise.all(open.splice(0).map((instance) => instance.dispose())); });

describe('the Worker’s encrypted object storage', () => {
  it('creates, reads, replaces, lists and soft-deletes with ETag preconditions, retaining every version', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const session = await h.signIn('reader-one');
    const account = await h.accountId(session);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const created = await h.put(session, 'manifest', bytes, { 'If-None-Match': '*' });
    expect(created.status).toBe(201);
    const etag = created.headers.get('ETag')!;
    expect(etag).toMatch(/^"[^"]+"$/);
    const read = await h.call(session, `/v1/projects/${PROJECT}/blobs/manifest`);
    expect(read.status).toBe(200);
    expect(read.headers.get('ETag')).toBe(etag);
    expect(read.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);
    expect(await h.call(session, `/v1/projects/${PROJECT}/blobs/absent`)).toMatchObject({ status: 404 });

    const replaced = await h.put(session, 'manifest', new Uint8Array([9]), { 'If-Match': etag });
    expect(replaced.status).toBe(200);
    const nextEtag = replaced.headers.get('ETag')!;
    expect(nextEtag).not.toBe(etag);
    const listing = await (await h.call(session, `/v1/projects/${PROJECT}/blobs`)).json() as { name: string; etag: string; size: number }[];
    expect(listing).toEqual([{ name: 'manifest', etag: nextEtag, size: 1 }]);

    const deleted = await h.call(session, `/v1/projects/${PROJECT}/blobs/manifest`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect(await h.call(session, `/v1/projects/${PROJECT}/blobs/manifest`)).toMatchObject({ status: 404 });
    expect(await (await h.call(session, `/v1/projects/${PROJECT}/blobs`)).json()).toEqual([]);
    expect((await h.call(session, `/v1/projects/${PROJECT}/blobs/manifest`, { method: 'DELETE' })).status).toBe(204);
    expect(await h.usage(session)).toEqual({ limitBytes: 1_000, usedBytes: 5, reservedBytes: 0 });

    const objects = await h.bucket!.list({ prefix: `${account}/` });
    const keys = objects.objects.map((object) => object.key);
    expect(keys.filter((key) => key.startsWith(`${account}/o/`))).toHaveLength(2);
    expect(keys.filter((key) => key.startsWith(`${account}/history/`))).toHaveLength(2);
    expect(keys).toContain(`${account}/live/${PROJECT}/manifest`);
    const tombstone = await h.bucket!.head(`${account}/live/${PROJECT}/manifest`);
    expect(tombstone?.customMetadata?.deleted).toBe('1');

    const recreated = await h.put(session, 'manifest', new Uint8Array([7, 7]), { 'If-None-Match': '*' });
    expect(recreated.status).toBe(201);
    expect(new Uint8Array(await (await h.call(session, `/v1/projects/${PROJECT}/blobs/manifest`)).arrayBuffer())).toEqual(new Uint8Array([7, 7]));
  });

  it('refuses missing, malformed and stale preconditions without writing or keeping a charge', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const session = await h.signIn('reader-one');
    const bytes = new Uint8Array([1]);
    expect((await h.put(session, 'blob-one', bytes, {})).status).toBe(400);
    expect((await h.put(session, 'blob-one', bytes, { 'If-None-Match': '*', 'If-Match': '"x"' })).status).toBe(400);
    expect((await h.put(session, 'blob-one', bytes, { 'If-None-Match': '"x"' })).status).toBe(400);
    expect((await h.put(session, 'blob-one', bytes, { 'If-Match': 'W/"x"' })).status).toBe(400);
    const created = await h.put(session, 'blob-one', bytes, { 'If-None-Match': '*' });
    const etag = created.headers.get('ETag')!;
    expect((await h.put(session, 'blob-one', new Uint8Array([2]), { 'If-None-Match': '*' })).status).toBe(412);
    expect((await h.put(session, 'blob-one', new Uint8Array([2]), { 'If-Match': '"stale"' })).status).toBe(412);
    expect((await h.put(session, 'blob-two', bytes, { 'If-Match': etag })).status).toBe(412);
    expect(new Uint8Array(await (await h.call(session, `/v1/projects/${PROJECT}/blobs/blob-one`)).arrayBuffer())).toEqual(bytes);
    expect(await h.usage(session)).toEqual({ limitBytes: 1_000, usedBytes: 1, reservedBytes: 3 });
    await h.sweep();
    expect(await h.usage(session)).toEqual({ limitBytes: 1_000, usedBytes: 1, reservedBytes: 0 });
    const account = await h.accountId(session);
    expect((await h.bucket!.list({ prefix: `${account}/o/` })).objects).toHaveLength(1);
  });

  it('validates the route, the content type and the declared length', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const session = await h.signIn('reader-one');
    const bytes = new Uint8Array([1]);
    expect((await h.put(session, 'UPPER', bytes, { 'If-None-Match': '*' })).status).toBe(400);
    expect((await h.call(session, `/v1/projects/${PROJECT}/blobs/${'a'.repeat(65)}`)).status).toBe(400);
    expect((await h.call(session, '/v1/projects/bad%2Fid/blobs/manifest')).status).toBe(400);
    expect((await h.call(session, `/v1/projects/${PROJECT}/blobs/manifest`, { method: 'POST', body: bytes })).status).toBe(405);
    expect((await h.call(session, `/v1/projects/${PROJECT}/blobs`, { method: 'PUT', body: bytes })).status).toBe(405);
    expect((await h.call(session, `/v1/projects/${PROJECT}/blobs/manifest`, {
      method: 'PUT', headers: { 'If-None-Match': '*', 'Content-Length': '1' }, body: bytes,
    })).status).toBe(400);
    expect((await h.call(session, `/v1/projects/${PROJECT}/blobs/manifest`, {
      method: 'PUT', headers: { 'If-None-Match': '*', 'Content-Type': 'application/octet-stream' },
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      duplex: 'half',
    })).status).toBe(411);
    const rawPut = (headers: Record<string, string>, body: Buffer) => new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${h.address}/v1/projects/${PROJECT}/blobs/manifest`, {
        method: 'PUT',
        headers: { 'MF-Original-URL': `${ORIGIN}/v1/projects/${PROJECT}/blobs/manifest`, Cookie: session, Origin: ORIGIN, ...headers },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end(body);
    });
    expect(await rawPut({ 'Content-Type': 'application/octet-stream', 'If-None-Match': '*', 'Content-Length': String(MAX_OBJECT_BYTES + 1) }, Buffer.from([1]))).toBe(413);
    expect(await h.usage(session)).toEqual({ limitBytes: 1_000, usedBytes: 0, reservedBytes: 0 });
  }, 15_000);

  it('charges the exact payload once and refuses one byte over the allowance', async () => {
    const h = await runtime();
    await h.invite('reader-one', 64);
    const session = await h.signIn('reader-one');
    expect((await h.put(session, 'blob-one', new Uint8Array(60), { 'If-None-Match': '*' })).status).toBe(201);
    expect(await h.usage(session)).toEqual({ limitBytes: 64, usedBytes: 60, reservedBytes: 0 });
    const refused = await h.put(session, 'blob-two', new Uint8Array(5), { 'If-None-Match': '*' });
    expect(refused.status).toBe(507);
    expect(await h.call(session, `/v1/projects/${PROJECT}/blobs/blob-two`)).toMatchObject({ status: 404 });
    expect((await h.put(session, 'blob-two', new Uint8Array(4), { 'If-None-Match': '*' })).status).toBe(201);
    expect(await h.usage(session)).toEqual({ limitBytes: 64, usedBytes: 64, reservedBytes: 0 });
    const account = await h.accountId(session);
    expect((await h.bucket!.list({ prefix: `${account}/o/` })).objects).toHaveLength(2);
  });

  it('replays an idempotent upload without a second charge and refuses a repurposed or superseded key', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const session = await h.signIn('reader-one');
    const bytes = new Uint8Array([4, 4, 4]);
    const first = await h.put(session, 'manifest', bytes, { 'If-None-Match': '*' }, 'upload-key-one');
    expect(first.status).toBe(201);
    const replay = await h.put(session, 'manifest', bytes, { 'If-None-Match': '*' }, 'upload-key-one');
    expect(replay.status).toBe(200);
    expect(replay.headers.get('ETag')).toBe(first.headers.get('ETag'));
    expect(await h.usage(session)).toEqual({ limitBytes: 1_000, usedBytes: 3, reservedBytes: 0 });
    expect((await h.put(session, 'manifest', new Uint8Array([1]), { 'If-None-Match': '*' }, 'upload-key-one')).status).toBe(409);
    expect((await h.put(session, 'other-name', bytes, { 'If-None-Match': '*' }, 'upload-key-one')).status).toBe(409);
    const replaced = await h.put(session, 'manifest', new Uint8Array([5]), { 'If-Match': first.headers.get('ETag')! });
    expect(replaced.status).toBe(200);
    expect((await h.put(session, 'manifest', bytes, { 'If-None-Match': '*' }, 'upload-key-one')).status).toBe(409);
    expect((await h.put(session, 'manifest', bytes, { 'If-None-Match': '*' }, 'x'.repeat(121))).status).toBe(400);
  });

  it('keeps two accounts’ objects apart under the same project id and name', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    await h.invite('reader-two');
    const one = await h.signIn('reader-one');
    const two = await h.signIn('reader-two');
    expect((await h.put(one, 'manifest', new Uint8Array([1]), { 'If-None-Match': '*' })).status).toBe(201);
    expect(await h.call(two, `/v1/projects/${PROJECT}/blobs/manifest`)).toMatchObject({ status: 404 });
    expect(await (await h.call(two, `/v1/projects/${PROJECT}/blobs`)).json()).toEqual([]);
    expect((await h.put(two, 'manifest', new Uint8Array([2]), { 'If-None-Match': '*' })).status).toBe(201);
    expect(new Uint8Array(await (await h.call(one, `/v1/projects/${PROJECT}/blobs/manifest`)).arrayBuffer())).toEqual(new Uint8Array([1]));
    expect(new Uint8Array(await (await h.call(two, `/v1/projects/${PROJECT}/blobs/manifest`)).arrayBuffer())).toEqual(new Uint8Array([2]));
    const oneId = await h.accountId(one);
    const twoId = await h.accountId(two);
    const keys = (await h.bucket!.list()).objects.map((object) => object.key);
    expect(keys.some((key) => key.startsWith(`${oneId}/`))).toBe(true);
    expect(keys.some((key) => key.startsWith(`${twoId}/`))).toBe(true);
    expect(keys.every((key) => key.startsWith(`${oneId}/`) || key.startsWith(`${twoId}/`))).toBe(true);
  });

  it('exposes storage only to an account-mode session with a configured bucket', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const session = await h.signIn('reader-one');
    expect((await h.dispatch(`/v1/projects/${PROJECT}/blobs/manifest`)).status).toBe(401);
    expect((await h.put(session, 'manifest', new Uint8Array([1]), { 'If-None-Match': '*' })).status).toBe(201);
    const crossOrigin = await h.dispatch(`/v1/projects/${PROJECT}/blobs/manifest`, {
      method: 'PUT', headers: { Cookie: session, Origin: 'https://elsewhere.example.invalid', 'Content-Type': 'application/octet-stream', 'If-None-Match': '*' }, body: new Uint8Array([2]),
    });
    expect(crossOrigin.status).toBe(403);
    const noStore = await runtime({}, { store: false });
    await noStore.invite('reader-one');
    const noStoreSession = await noStore.signIn('reader-one');
    expect((await noStore.put(noStoreSession, 'manifest', new Uint8Array([1]), { 'If-None-Match': '*' })).status).toBe(503);
    const allowlist = await runtime({ AUTHENTICATION_MODE: 'allowlist', ALLOWED_GITHUB_LOGINS: 'reader-one' }, { mode: 'allowlist' });
    const legacy = await allowlist.signIn('reader-one');
    expect((await allowlist.put(legacy, 'manifest', new Uint8Array([1]), { 'If-None-Match': '*' })).status).toBe(404);
    expect((await allowlist.call(legacy, `/v1/projects/${PROJECT}/blobs`)).status).toBe(404);
    expect((await allowlist.sweep()).status).toBe(200);
  }, 20_000);

  it('sweeps an expired uncommitted write, fences the old writer and releases its charge', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const session = await h.signIn('reader-one');
    const account = await h.accountId(session);
    const quota = new QuotaStore(h.db, { accountId: account, revision: 1 }, { leaseMs: 100, now: () => 1_000 });
    expect(await quota.reserve('orphan-op', 'orphan-op', 10)).toMatchObject({ ok: true });
    expect(await quota.beginWrite('orphan-op')).toMatchObject({ ok: true });
    await h.bucket!.put(`${account}/o/orphan-op`, new Uint8Array(10), { customMetadata: { project: PROJECT, name: 'manifest' } });
    expect(await h.usage(session)).toEqual({ limitBytes: 1_000, usedBytes: 0, reservedBytes: 10 });
    await h.sweep();
    expect(await h.usage(session)).toEqual({ limitBytes: 1_000, usedBytes: 0, reservedBytes: 0 });
    expect(await h.bucket!.head(`${account}/o/orphan-op`)).toBeNull();
    expect(await h.bucket!.head(`${account}/fences/orphan-op`)).not.toBeNull();
    expect((await h.put(session, 'manifest', new Uint8Array(10), { 'If-None-Match': '*' }, 'orphan-op')).status).toBe(409);
    expect(await h.usage(session)).toEqual({ limitBytes: 1_000, usedBytes: 0, reservedBytes: 0 });
  });

  it('keeps the charge and the data when an uncommitted write already reached the live pointer', async () => {
    const h = await runtime();
    await h.invite('reader-one');
    const session = await h.signIn('reader-one');
    const account = await h.accountId(session);
    const quota = new QuotaStore(h.db, { accountId: account, revision: 1 }, { leaseMs: 100, now: () => 1_000 });
    await quota.reserve('stuck-op', 'stuck-op', 10);
    await quota.beginWrite('stuck-op');
    await h.bucket!.put(`${account}/o/stuck-op`, new Uint8Array(10), { customMetadata: { project: PROJECT, name: 'manifest' } });
    await h.bucket!.put(`${account}/live/${PROJECT}/manifest`, JSON.stringify({ operationId: 'stuck-op', size: 10, uploaded: 1_000 }), { customMetadata: { operation: 'stuck-op', size: '10' } });
    await h.sweep();
    expect(await h.usage(session)).toEqual({ limitBytes: 1_000, usedBytes: 0, reservedBytes: 10 });
    const read = await h.call(session, `/v1/projects/${PROJECT}/blobs/manifest`);
    expect(read.status).toBe(200);
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(new Uint8Array(10));
    expect((await h.put(session, 'manifest', new Uint8Array(10), { 'If-None-Match': '*' }, 'stuck-op')).status).toBe(409);
    await h.sweep();
    expect(await h.usage(session)).toEqual({ limitBytes: 1_000, usedBytes: 0, reservedBytes: 10 });
    expect(await h.bucket!.head(`${account}/o/stuck-op`)).not.toBeNull();
  });

  it('round-trips the HTTP blob client through the real Worker and surfaces its typed errors', async () => {
    const h = await runtime();
    await h.invite('reader-one', 32);
    const session = await h.signIn('reader-one');
    const store = createHttpBlobStore({
      origin: ORIGIN,
      projectId: PROJECT,
      fetch: (url, init) => h.instance.dispatchFetch(String(url), {
        method: init?.method,
        redirect: 'manual',
        headers: {
          Cookie: session, Origin: ORIGIN, ...init?.headers,
          ...(init?.body instanceof Uint8Array ? { 'Content-Length': String(init.body.byteLength) } : {}),
        },
        body: init?.body as Uint8Array | string | undefined,
      }) as unknown as Promise<globalThis.Response>,
    });
    const bytes = new Uint8Array([8, 8, 8]);
    const created = await store.put('manifest', bytes, { ifNoneMatch: '*' });
    expect(await store.get('manifest')).toEqual({ bytes, etag: created.etag });
    const replaced = await store.put('manifest', new Uint8Array([9]), { ifMatch: created.etag });
    expect(await store.list()).toEqual([{ name: 'manifest', etag: replaced.etag }]);
    await expect(store.put('manifest', new Uint8Array([10]), { ifMatch: created.etag })).rejects.toBeInstanceOf(BlobPreconditionFailedError);
    await expect(store.put('blob-big', new Uint8Array(30), { ifNoneMatch: '*' })).rejects.toBeInstanceOf(RemoteQuotaExceededError);
    await store.delete('manifest');
    expect(await store.get('manifest')).toBeNull();
    expect(await store.list()).toEqual([]);
    await h.sweep();
    expect(await h.usage(session)).toEqual({ limitBytes: 32, usedBytes: 4, reservedBytes: 0 });
  });
});