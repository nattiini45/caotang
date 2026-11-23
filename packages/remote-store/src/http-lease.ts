/**
 * The per-device project lease — [hosted.md §7](docs/architecture/hosted.md), [sync-server.md](../../../docs/architecture/sync-server.md).
 * One device edits a project at a time and the others read it. The lease is soft: a heartbeat renews it, it expires on
 * its own when this device stops sending one (a closed tab, a lost network), and any device may take it over once the
 * writer says so. A write from another device is refused while it is live, so the second device is read-only in fact
 * as well as in the interface.
 *
 * The device names itself with a label it draws once per session and keeps. It authorizes nothing — the account still
 * comes from the session cookie — and it is never shown to another device. Every call also names the signed-in account
 * (`X-Caotang-Account`), which the server checks as a precondition beside the cookie: a browser whose cookie moved to
 * another account gets a refusal to read again rather than another project's lease.
 */
import { RemoteSessionError } from './http-project-records.js';
import { RemoteUnavailableError } from './blob-store.js';

export interface LeaseState {
  /** Whether this device holds the lease now. A refusal to take it is an answer, not an error. */
  readonly leased: boolean;
  /** When the lease ends, as epoch milliseconds. With `leased: false`, when the other device's lease lapses. */
  readonly until: number;
}

export interface ProjectLease {
  /** Takes the lease, or renews this device's own; with `takeover`, takes it from another device. */
  take(options?: { readonly takeover?: boolean }): Promise<LeaseState>;
  /** Hands it back, so another device need not wait for it to lapse. */
  release(): Promise<void>;
}

export interface HttpLeaseOptions {
  /** The server's HTTPS origin, without a path. */
  readonly origin: string;
  readonly projectId: string;
  /** The account this browser is signed in as, as the shell read it. The server refuses a lease call without it. */
  readonly accountId: string;
  /** This session's label: at most 64 letters, digits, - and _. The same label goes on every blob write. */
  readonly device: string;
  readonly fetch?: typeof fetch;
  /** Total attempts per call, including the first. Defaults to 3. */
  readonly attempts?: number;
}

const DEVICE = /^[A-Za-z0-9_-]{1,64}$/;

export function createHttpLease(options: HttpLeaseOptions): ProjectLease {
  let origin: URL;
  try {
    origin = new URL(options.origin);
  } catch {
    throw new RangeError('Use the server’s HTTPS origin without a path.');
  }
  if (origin.protocol !== 'https:' || origin.origin !== options.origin) throw new RangeError('Use the server’s HTTPS origin without a path.');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.projectId)) throw new RangeError('Use a project id of at most 64 letters, digits, - and _.');
  if (options.accountId === '') throw new RangeError('Use the account id this browser is signed in as.');
  if (!DEVICE.test(options.device)) throw new RangeError('Use a device label of at most 64 letters, digits, - and _.');
  const attempts = options.attempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new RangeError('Use at least one attempt.');
  const call = options.fetch ?? fetch;
  const url = `${options.origin}/v1/projects/${options.projectId}/lease`;
  const headers = { 'X-Caotang-Account': options.accountId, 'X-Caotang-Device': options.device };

  async function request(method: string, extra: Record<string, string> = {}): Promise<Response> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      let response: Response;
      try {
        response = await call(url, { method, credentials: 'include', cache: 'no-store', headers: { ...headers, ...extra } });
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
    take: async (takeOptions): Promise<LeaseState> => {
      const response = await request('POST', takeOptions?.takeover === true ? { 'X-Caotang-Takeover': '1' } : {});
      if (response.status === 401 || response.status === 412) throw new RemoteSessionError(response.status);
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error(`the server refused the project lease (HTTP ${response.status})`);
      }
      const body: unknown = await response.json();
      if (body === null || typeof body !== 'object' || typeof (body as { leased?: unknown }).leased !== 'boolean' || !Number.isSafeInteger((body as { until?: unknown }).until)) {
        throw new Error('the server returned a malformed lease answer');
      }
      const { leased, until } = body as { leased: boolean; until: number };
      return { leased, until };
    },
    release: async (): Promise<void> => {
      const response = await request('DELETE');
      if (response.status === 401 || response.status === 412) throw new RemoteSessionError(response.status);
      if (response.status === 204 || response.status === 409) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
      throw new Error(`the server refused to release the project lease (HTTP ${response.status})`);
    },
  };
}
