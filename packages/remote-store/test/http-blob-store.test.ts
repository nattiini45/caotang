import { afterEach, describe, expect, it } from 'vitest';
import { BlobPreconditionFailedError, RemoteUnavailableError } from '../src/blob-store.js';
import { RemoteQuotaExceededError } from '../src/errors.js';
import { createHttpBlobStore } from '../src/http-blob-store.js';
import { HttpFake, TEST_ORIGIN } from './http-fake.js';

const opened: HttpFake[] = [];

async function fake(): Promise<{ server: HttpFake; store: ReturnType<typeof createHttpBlobStore> }> {
  const server = new HttpFake();
  opened.push(server);
  const address = await server.start();
  const store = createHttpBlobStore({
    origin: TEST_ORIGIN,
    projectId: 'p_testproject',
    attempts: 3,
    fetch: (url, init) => fetch(String(url).replace(TEST_ORIGIN, address), init),
  });
  return { server, store };
}

afterEach(async () => { await Promise.all(opened.splice(0).map((server) => server.stop())); });

describe('the HTTP blob client', () => {
  it('round-trips create, read, replace, list and soft delete with the contract fake', async () => {
    const { server, store } = await fake();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const created = await store.put('manifest', bytes, { ifNoneMatch: '*' });
    expect(created.etag).toMatch(/^"e\d+"$/);
    expect(await store.get('manifest')).toEqual({ bytes, etag: created.etag });
    const replaced = await store.put('manifest', new Uint8Array([9]), { ifMatch: created.etag });
    expect(replaced.etag).not.toBe(created.etag);
    expect(await store.list()).toEqual([{ name: 'manifest', etag: replaced.etag }]);
    await store.delete('manifest');
    expect(await store.get('manifest')).toBeNull();
    expect(await store.list()).toEqual([]);
    await store.delete('manifest');
    expect(server.fake.dump()[0]).toMatchObject({ name: 'manifest', deleted: true });
    expect(server.fake.dump()[0]!.versions).toHaveLength(2);
  });

  it('raises the precondition error on a stale replace and writes nothing', async () => {
    const { server, store } = await fake();
    const first = await store.put('blob-one', new Uint8Array([1]), { ifNoneMatch: '*' });
    await store.put('blob-one', new Uint8Array([2]), { ifMatch: first.etag });
    await expect(store.put('blob-one', new Uint8Array([3]), { ifMatch: first.etag })).rejects.toBeInstanceOf(BlobPreconditionFailedError);
    await expect(store.put('blob-one', new Uint8Array([4]), { ifNoneMatch: '*' })).rejects.toBeInstanceOf(BlobPreconditionFailedError);
    expect((await store.get('blob-one'))!.bytes).toEqual(new Uint8Array([2]));
    expect(server.fake.dump()[0]!.versions).toHaveLength(2);
  });

  it('surfaces an exhausted allowance as the quota error', async () => {
    const { server, store } = await fake();
    server.quotaFull = true;
    await expect(store.put('blob-one', new Uint8Array([1]), { ifNoneMatch: '*' })).rejects.toBeInstanceOf(RemoteQuotaExceededError);
    expect(server.fake.dump()).toEqual([]);
  });

  it('retries an unavailable server under the same Idempotency-Key and charges once', async () => {
    const { server, store } = await fake();
    server.failNext = 2;
    const { etag } = await store.put('blob-one', new Uint8Array([7]), { ifNoneMatch: '*' });
    expect(server.seenKeys).toHaveLength(3);
    expect(new Set(server.seenKeys).size).toBe(1);
    expect(server.replays.size).toBe(1);
    expect((await store.get('blob-one'))!.etag).toBe(etag);
  });

  it('gives up after the configured attempts and reports the server unreachable', async () => {
    const { server, store } = await fake();
    server.failNext = 5;
    await expect(store.put('blob-one', new Uint8Array([1]), { ifNoneMatch: '*' })).rejects.toBeInstanceOf(RemoteUnavailableError);
    expect(server.seenKeys).toHaveLength(3);
  });

  it('retries a settled upload under a fresh key, still guarded by the precondition', async () => {
    const { server, store } = await fake();
    server.conflictNext = 1;
    await store.put('blob-one', new Uint8Array([5]), { ifNoneMatch: '*' });
    expect(server.seenKeys).toHaveLength(2);
    expect(new Set(server.seenKeys).size).toBe(2);
    expect((await store.get('blob-one'))!.bytes).toEqual(new Uint8Array([5]));
  });

  it('reports a closed connection as unreachable without writing', async () => {
    const server = new HttpFake();
    const address = await server.start();
    await server.stop();
    const store = createHttpBlobStore({
      origin: TEST_ORIGIN,
      projectId: 'p_testproject',
      attempts: 1,
      fetch: (url, init) => fetch(String(url).replace(TEST_ORIGIN, address), init),
    });
    await expect(store.put('blob-one', new Uint8Array([1]), { ifNoneMatch: '*' })).rejects.toBeInstanceOf(RemoteUnavailableError);
    await expect(store.get('blob-one')).rejects.toBeInstanceOf(RemoteUnavailableError);
    await expect(store.list()).rejects.toBeInstanceOf(RemoteUnavailableError);
    await expect(store.delete('blob-one')).rejects.toBeInstanceOf(RemoteUnavailableError);
  });

  it('refuses a malformed origin, project id or object name before any request', async () => {
    expect(() => createHttpBlobStore({ origin: 'https://studio.example.invalid/path', projectId: 'p_testproject' })).toThrow(RangeError);
    expect(() => createHttpBlobStore({ origin: 'http://studio.example.invalid', projectId: 'p_testproject' })).toThrow(RangeError);
    expect(() => createHttpBlobStore({ origin: 'https://studio.example.invalid', projectId: '../escape' })).toThrow(RangeError);
    expect(() => createHttpBlobStore({ origin: 'https://studio.example.invalid', projectId: 'p_testproject', attempts: 0 })).toThrow(RangeError);
    const store = createHttpBlobStore({ origin: 'https://studio.example.invalid', projectId: 'p_testproject' });
    await expect(store.get('UPPER')).rejects.toBeInstanceOf(RangeError);
  });
});