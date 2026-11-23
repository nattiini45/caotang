/**
 * The account's project records — [hosted.md §5](docs/architecture/hosted.md), [sync-server.md](../../../docs/architecture/sync-server.md).
 * The client for the two routes that say which projects an account has: the project key wrapped under the master key,
 * and the project's sealed record. Both are opaque to the server, so the caller seals and opens them; this module only
 * carries them, and never holds a key.
 *
 * Every call names the signed-in account (`X-Caotang-Account`), which the server checks as a precondition rather than
 * an account selector: a cookie that changed in another tab cannot record a project under the wrong account.
 */
import { decodeBase64, encodeBase64 } from '@caotang/crypto';
import { RemoteUnavailableError } from './blob-store.js';

/** One project as the server holds it, decoded: opaque bytes this device seals and opens itself. */
export interface RemoteProjectRecord {
  readonly id: string;
  readonly wrappedKey: Uint8Array;
  readonly record: Uint8Array;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RemoteProjectRegistry {
  /** Every project this account has, oldest first. */
  list(): Promise<RemoteProjectRecord[]>;
  /**
   * Records a new project, or replaces an existing one's record — which is what renaming it is. `create` refuses a
   * project that is already recorded instead of replacing it.
   */
  put(id: string, record: { readonly wrappedKey: Uint8Array; readonly record: Uint8Array }, options?: { readonly create?: boolean }): Promise<void>;
}

export interface HttpProjectRegistryOptions {
  /** The server's HTTPS origin, without a path. */
  readonly origin: string;
  /** The opaque account id from `GET /v1/account`. */
  readonly accountId: string;
  readonly fetch?: typeof fetch;
  /** Total attempts per call, including the first. Defaults to 3. */
  readonly attempts?: number;
}

/** The session is not the one the caller thinks it is: sign in again, or load the account again. */
export class RemoteSessionError extends Error {
  constructor(readonly status: number) {
    super('this browser is no longer signed in to that account. Sign in again.');
    this.name = 'RemoteSessionError';
  }
}

/** A project id is already recorded; nothing was replaced. */
export class RemoteProjectExistsError extends Error {
  constructor(readonly id: string) {
    super(`the project ${id} is already recorded on this account`);
    this.name = 'RemoteProjectExistsError';
  }
}

const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;

async function malformed(response: Response, what: string): Promise<never> {
  await response.body?.cancel();
  throw new Error(`the server answered a ${what} it should not have (HTTP ${response.status})`);
}

export function createHttpProjectRegistry(options: HttpProjectRegistryOptions): RemoteProjectRegistry {
  let origin: URL;
  try {
    origin = new URL(options.origin);
  } catch {
    throw new RangeError('Use the server’s HTTPS origin without a path.');
  }
  if (origin.protocol !== 'https:' || origin.origin !== options.origin) throw new RangeError('Use the server’s HTTPS origin without a path.');
  if (options.accountId === '') throw new RangeError('Use the account id this browser is signed in as.');
  const attempts = options.attempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new RangeError('Use at least one attempt.');
  const call = options.fetch ?? fetch;
  const headers = { 'X-Caotang-Account': options.accountId };

  async function request(method: string, path: string, body?: string): Promise<Response> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      let response: Response;
      try {
        response = await call(`${options.origin}${path}`, {
          method,
          credentials: 'include',
          headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body }),
          cache: 'no-store',
        });
      } catch {
        continue;
      }
      if (response.status === 503) {
        await response.body?.cancel();
        continue;
      }
      return response;
    }
    throw new RemoteUnavailableError();
  }

  return {
    list: async (): Promise<RemoteProjectRecord[]> => {
      const response = await request('GET', '/v1/projects');
      if (response.status === 401 || response.status === 412) throw new RemoteSessionError(response.status);
      if (response.status !== 200) return malformed(response, 'project list');
      const parsed: unknown = await response.json();
      const projects = parsed !== null && typeof parsed === 'object' ? (parsed as { projects?: unknown }).projects : undefined;
      if (!Array.isArray(projects)) throw new Error('the server returned a malformed project list');
      return projects.map((entry: unknown) => {
        if (entry === null || typeof entry !== 'object') throw new Error('the server returned a malformed project record');
        const { id, wrappedKey, record, createdAt, updatedAt } = entry as Record<string, unknown>;
        if (typeof id !== 'string' || !PROJECT_ID.test(id) || typeof wrappedKey !== 'string' || typeof record !== 'string') {
          throw new Error('the server returned a malformed project record');
        }
        if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(updatedAt)) throw new Error('the server returned a malformed project record');
        try {
          return { id, wrappedKey: decodeBase64(wrappedKey), record: decodeBase64(record), createdAt: createdAt as number, updatedAt: updatedAt as number };
        } catch {
          throw new Error('the server returned a malformed project record');
        }
      });
    },
    put: async (id, record, putOptions): Promise<void> => {
      if (!PROJECT_ID.test(id)) throw new RangeError('Use a project id of at most 64 letters, digits, - and _.');
      const create = putOptions?.create === true;
      const response = await request('PUT', `/v1/projects/${id}`, JSON.stringify({ wrappedKey: encodeBase64(record.wrappedKey), record: encodeBase64(record.record) }));
      if (response.status === 401 || response.status === 412) throw new RemoteSessionError(response.status);
      if (response.status === 409 && create) throw new RemoteProjectExistsError(id);
      if (response.status !== 200 && response.status !== 201) return malformed(response, 'project record');
      await response.body?.cancel();
    },
  };
}
