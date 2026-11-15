import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BlobPreconditionFailedError } from '../src/blob-store.js';
import { FakeBlobServer } from './fake-blob-server.js';

export const TEST_ORIGIN = 'https://studio.example.invalid';

/** The HTTP contract of hosted.md §6 over the contract's own fake, with idempotency and fault injection. */
export class HttpFake {
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
          const url = new URL(request.url ?? '/', TEST_ORIGIN);
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