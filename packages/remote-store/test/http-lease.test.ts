import { describe, expect, it } from 'vitest';
import { RemoteLeaseHeldError, RemoteSessionError, RemoteUnavailableError, createHttpBlobStore, createHttpLease } from '../src/index.js';

const ORIGIN = 'https://studio.example.test';
const PROJECT = 'p_lighthouse';

interface Call {
  readonly method: string;
  readonly url: string;
  readonly device: string | null;
  readonly takeover: string | null;
}

function leaseServer(answer: (call: Call) => Response | null, state = { leased: true, until: 1_000 }) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = { method: init?.method ?? 'GET', url: String(input), device: headers['X-Caotang-Device'] ?? null, takeover: headers['X-Caotang-Takeover'] ?? null };
    calls.push(call);
    return answer(call) ?? (call.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json(state));
  };
  return {
    calls,
    lease: createHttpLease({ origin: ORIGIN, projectId: PROJECT, device: 'laptop', fetch: fetch as typeof window.fetch, attempts: 1 }),
    store: createHttpBlobStore({ origin: ORIGIN, projectId: PROJECT, device: 'laptop', fetch: fetch as typeof window.fetch, attempts: 1 }),
  };
}

describe('the project lease client', () => {
  it('takes, renews and releases the lease, naming the device on every call', async () => {
    const { lease, calls } = leaseServer(() => null);

    expect(await lease.take()).toEqual({ leased: true, until: 1_000 });
    expect(await lease.take({ takeover: true })).toEqual({ leased: true, until: 1_000 });
    await lease.release();

    expect(calls.map((call) => call.method)).toEqual(['POST', 'POST', 'DELETE']);
    expect(calls.map((call) => call.device)).toEqual(['laptop', 'laptop', 'laptop']);
    expect(calls[1]!.takeover).toBe('1');
    expect(calls[0]!.url).toBe(`${ORIGIN}/v1/projects/${PROJECT}/lease`);
  });

  it('reports a refusal to take it as an answer, not an error', async () => {
    const { lease } = leaseServer(() => Response.json({ leased: false, until: 2_000 }));
    expect(await lease.take()).toEqual({ leased: false, until: 2_000 });
  });

  it('reports a session that is not the account it thinks, and a server it cannot reach', async () => {
    await expect(leaseServer(() => Response.json({ message: 'no' }, { status: 401 })).lease.take()).rejects.toBeInstanceOf(RemoteSessionError);
    await expect(leaseServer(() => Response.json({ message: 'no' }, { status: 412 })).lease.take()).rejects.toBeInstanceOf(RemoteSessionError);
    const offline = createHttpLease({
      origin: ORIGIN,
      projectId: PROJECT,
      device: 'laptop',
      attempts: 2,
      fetch: (async () => {
        throw new TypeError('offline');
      }) as unknown as typeof fetch,
    });
    await expect(offline.take()).rejects.toBeInstanceOf(RemoteUnavailableError);
  });

  it('lets a release that lost the lease pass, so signing out of a stale tab is not an error', async () => {
    await expect(leaseServer(() => new Response(null, { status: 409 })).lease.release()).resolves.toBeUndefined();
    await expect(leaseServer(() => new Response(null, { status: 204 })).lease.release()).resolves.toBeUndefined();
  });

  it('carries the device label on a write, and reports the refused write as a held lease', async () => {
    const { store, calls } = leaseServer((call) => (call.method === 'PUT' ? Response.json({ message: 'held' }, { status: 423 }) : null));

    await expect(store.put('manifest', new Uint8Array([1, 2, 3]), { ifNoneMatch: '*' })).rejects.toBeInstanceOf(RemoteLeaseHeldError);
    expect(calls[0]).toMatchObject({ method: 'PUT', device: 'laptop' });
  });

  it('refuses a device label the server could never accept', () => {
    expect(() => createHttpLease({ origin: ORIGIN, projectId: PROJECT, device: 'not a device!' })).toThrow(/device label/);
    expect(() => createHttpBlobStore({ origin: ORIGIN, projectId: PROJECT, device: 'x'.repeat(65) })).toThrow(/device label/);
  });
});
