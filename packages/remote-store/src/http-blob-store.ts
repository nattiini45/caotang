/**
 * The HTTP client for the blob service — [hosted.md §6](../../../docs/architecture/hosted.md). One project, opaque
 * names, ETag preconditions. Each logical write carries one `Idempotency-Key` across its retries, so a lost
 * response never charges the account twice; a settled upload is retried under a fresh key, still guarded by the
 * caller's precondition. Same-origin session cookies authenticate every call.
 */
import {
  BlobPreconditionFailedError,
  RemoteUnavailableError,
  type Precondition,
  type RemoteBlob,
  type RemoteBlobStore,
} from './blob-store.js';
import { RemoteQuotaExceededError } from './errors.js';

export interface HttpBlobStoreOptions {
  /** The server's HTTPS origin, without a path. */
  readonly origin: string;
  readonly projectId: string;
  readonly fetch?: typeof fetch;
  /** Total attempts per call, including the first. Defaults to 3. */
  readonly attempts?: number;
}

const NAME = /^[a-z0-9-]{1,64}$/;

function assertName(name: string): void {
  if (!NAME.test(name)) throw new RangeError('Use an object name of at most 64 lower-case letters, digits and -.');
}

export function createHttpBlobStore(options: HttpBlobStoreOptions): RemoteBlobStore {
  let origin: URL;
  try {
    origin = new URL(options.origin);
  } catch {
    throw new RangeError('Use the server’s HTTPS origin without a path.');
  }
  if (origin.protocol !== 'https:' || origin.origin !== options.origin) throw new RangeError('Use the server’s HTTPS origin without a path.');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.projectId)) throw new RangeError('Use a project id of at most 64 letters, digits, - and _.');
  const attempts = options.attempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new RangeError('Use at least one attempt.');
  const call = options.fetch ?? fetch;
  const base = `${options.origin}/v1/projects/${options.projectId}/blobs`;

  async function request(method: string, url: string, init: RequestInit, operationId?: string): Promise<Response> {
    let key = operationId;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      let response: Response;
      try {
        const requestInit: RequestInit & { credentials: 'include' } = {
          ...init,
          method,
          credentials: 'include',
          headers: { ...init.headers, ...(key !== undefined ? { 'Idempotency-Key': key } : {}) },
        };
        response = await call(url, requestInit);
      } catch {
        continue;
      }
      if (response.status === 503 || (response.status === 409 && key !== undefined)) {
        await response.body?.cancel();
        if (response.status === 409) key = crypto.randomUUID();
        continue;
      }
      return response;
    }
    throw new RemoteUnavailableError();
  }

  function etagOf(response: Response, name: string): string {
    const etag = response.headers.get('ETag');
    if (etag === null) throw new Error(`the server did not return an ETag for ${name}`);
    return etag;
  }

  return {
    get: async (name): Promise<RemoteBlob | null> => {
      assertName(name);
      const response = await request('GET', `${base}/${name}`, {});
      if (response.status === 404) return null;
      if (response.status !== 200) throw new Error(`the server refused the read of ${name} (HTTP ${response.status})`);
      return { bytes: new Uint8Array(await response.arrayBuffer()), etag: etagOf(response, name) };
    },
    put: async (name, bytes, precondition: Precondition): Promise<{ etag: string }> => {
      assertName(name);
      const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        ...('ifMatch' in precondition ? { 'If-Match': precondition.ifMatch } : { 'If-None-Match': '*' }),
      };
      const response = await request('PUT', `${base}/${name}`, { headers, body: bytes.slice() }, crypto.randomUUID());
      if (response.status === 412) throw new BlobPreconditionFailedError(name);
      if (response.status === 507) throw new RemoteQuotaExceededError();
      if (response.status !== 200 && response.status !== 201) throw new Error(`the server refused the upload of ${name} (HTTP ${response.status})`);
      return { etag: etagOf(response, name) };
    },
    delete: async (name): Promise<void> => {
      assertName(name);
      const response = await request('DELETE', `${base}/${name}`, {});
      if (response.status !== 204 && response.status !== 404) throw new Error(`the server refused the delete of ${name} (HTTP ${response.status})`);
    },
    list: async (): Promise<{ name: string; etag: string }[]> => {
      const response = await request('GET', base, {});
      if (response.status !== 200) throw new Error(`the server refused the object listing (HTTP ${response.status})`);
      const parsed: unknown = await response.json();
      if (!Array.isArray(parsed)) throw new Error('the server returned a malformed object listing');
      return parsed.map((entry) => {
        if (entry === null || typeof entry !== 'object' || typeof (entry as { name?: unknown }).name !== 'string' || typeof (entry as { etag?: unknown }).etag !== 'string') {
          throw new Error('the server returned a malformed object listing');
        }
        return { name: (entry as { name: string }).name, etag: (entry as { etag: string }).etag };
      });
    },
  };
}