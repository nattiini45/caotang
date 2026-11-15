import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BlobPreconditionFailedError, RemoteUnavailableError } from '../src/blob-store.js';
import { RemoteQuotaExceededError } from '../src/errors.js';
import { createHttpBlobStore } from '../src/http-blob-store.js';
import { FakeBlobServer } from './fake-blob-server.js';

/** The HTTP contract of hosted.md §6 over the contract's own fake, with idempotency and fault injection. */
class HttpFake {
  readonly fake = new FakeBlobServer();
  readonly seenKeys: string[] = [];
  readonly replays = new Map<string, { name: string; size: number; etag: string }>();
  failNext = 0;
  conflictNext = 0;
  quotaFull = false;
  #server: Server | null = null;

  async start(): Promise<string> {
    const client = this.fake.client();
    this.#server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        void (async () => {
          const url = new URL(request.url ?? '/', 'https://studio.example.invalid');
          const match = /^\/v1\/projects\/p_testproject\/blobs(?:\/([a-z0-9-]+))?$/.exec(url.pathname);
          const send = (status: number, body?: Buffer | string, headers: Record<string, string> = {}) => {
            response.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
            response.end(body);
          };
          if (!match) return send(404, JSON.stringify({ message: 'This API route does not exist.' }));
          const name = match[1];
          if (name === undefined) {
            if (request.method !== 'GET') return send(405);
            const dump = this.fake.dump();
            const listing = (await client.list()).map((entry) => ({
              ...entry,
              size: dump.find((object) => object.name === entry.name)?.versions.at(-1)?.byteLength ?? 0,
            }));
            return send(200, JSON.stringify(listing), { 'Content-Type': 'application/json' });
          }
          if (request.method === 'GET') {
            const blob = await client.get(name);
            if (blob === null) return send(404, JSON.stringify({ message: 'This object does not exist.' }));
            return send(200, Buffer.from(blob.bytes), { ETag: blob.etag, 'Content-Type': 'application/octet-stream' });
          }
          if (request.method === 'DELETE') {
            await client.delete(name);
            return send(204);
          }
          if (request.method !== 'PUT') return send(405);
          const key = request.headers['idempotency-key'];
          if (typeof key === 'string') this.seenKeys.push(key);
          if (this.failNext > 0) { this.failNext -= 1; return send(503, JSON.stringify({ message: 'Storage is unavailable.' })); }
          if (this.quotaFull) return send(507, JSON.stringify({ message: 'The account’s storage allowance is exhausted.' }));
          if (this.conflictNext > 0) { this.conflictNext -= 1; return send(409, JSON.stringify({ message: 'The upload was refused.' })); }
          const bytes = new Uint8Array(Buffer.concat(chunks));
          if (typeof key === 'string') {
            const replay = this.replays.get(key);
            if (replay) {
              if (replay.name !== name || replay.size !== bytes.byteLength) return send(409, JSON.stringify({ message: 'conflict' }));
              return send(200, undefined, { ETag: replay.etag });
            }
          }
          const ifMatch = request.headers['if-match'];
          const precondition = typeof ifMatch === 'string' ? { ifMatch } : { ifNoneMatch: '*' as const };
          try {
            const { etag } = await client.put(name, bytes, precondition);
            if (typeof key === 'string') this.replays.set(key, { name, size: bytes.byteLength, etag });
            return send(201, undefined, { ETag: etag });
          } catch (error) {
            if (error instanceof BlobPreconditionFailedError) return send(412, JSON.stringify({ message: 'changed' }));
            throw error;
          }
        })().catch(() => { response.writeHead(500); response.end(); });
      });
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.#server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.#server ? this.#server.close((error) => error ? reject(error) : resolve()) : resolve());
    this.#server = null;
  }
}

const opened: HttpFake[] = [];
const TEST_ORIGIN = 'https://studio.example.invalid';

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