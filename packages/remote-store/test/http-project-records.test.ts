import { describe, expect, it } from 'vitest';
import { encodeBase64 } from '@caotang/crypto';
import {
  RemoteProjectExistsError,
  RemoteSessionError,
  RemoteUnavailableError,
  createHttpProjectRegistry,
  type RemoteProjectRegistry,
} from '../src/index.js';

const ORIGIN = 'https://studio.example.test';
const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const PROJECT = 'a1b2c3d4-0000-4000-8000-000000000001';

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: string | null;
  readonly account: string | null;
  readonly credentials: RequestCredentials | undefined;
}

/** A stand-in for the two record routes; `answer` may refuse a call to model a failure. */
function server(answer?: (call: Call) => Response | null): { registry: RemoteProjectRegistry; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : null,
      account: (init?.headers as Record<string, string> | undefined)?.['X-Caotang-Account'] ?? null,
      credentials: init?.credentials,
    };
    calls.push(call);
    const refused = answer?.(call) ?? null;
    if (refused !== null) return refused;
    if (call.method === 'GET') {
      return Response.json({
        projects: [
          { id: PROJECT, wrappedKey: encodeBase64(new Uint8Array(61).fill(1)), record: encodeBase64(new Uint8Array(8).fill(2)), createdAt: 10, updatedAt: 20 },
        ],
      });
    }
    return new Response(null, { status: 201 });
  };
  return { registry: createHttpProjectRegistry({ origin: ORIGIN, accountId: ACCOUNT, fetch: fetch as typeof window.fetch, attempts: 1 }), calls };
}

describe('the project registry client', () => {
  it('lists the account\'s projects decoded, naming the account on the request', async () => {
    const { registry, calls } = server();

    const projects = await registry.list();

    expect(projects).toEqual([
      { id: PROJECT, wrappedKey: new Uint8Array(61).fill(1), record: new Uint8Array(8).fill(2), createdAt: 10, updatedAt: 20 },
    ]);
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${ORIGIN}/v1/projects`, account: ACCOUNT, credentials: 'include' });
  });

  it('records a project as canonical base64, and refuses one that is already recorded', async () => {
    const { registry, calls } = server((call) => (call.method === 'PUT' ? new Response(null, { status: 409 }) : null));

    await expect(registry.put(PROJECT, { wrappedKey: new Uint8Array(61).fill(3), record: new Uint8Array(4).fill(4) }, { create: true })).rejects.toBeInstanceOf(RemoteProjectExistsError);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ wrappedKey: encodeBase64(new Uint8Array(61).fill(3)), record: encodeBase64(new Uint8Array(4).fill(4)) });
    // Replacing a record (a rename) is allowed over an existing one.
    await expect(server().registry.put(PROJECT, { wrappedKey: new Uint8Array(61).fill(3), record: new Uint8Array(4).fill(4) })).resolves.toBeUndefined();
  });

  it('reports a session that is not the account it thinks, and a server it cannot reach', async () => {
    await expect(server(() => new Response(null, { status: 401 })).registry.list()).rejects.toBeInstanceOf(RemoteSessionError);
    await expect(server(() => new Response(null, { status: 412 })).registry.list()).rejects.toBeInstanceOf(RemoteSessionError);
    const offline = createHttpProjectRegistry({
      origin: ORIGIN,
      accountId: ACCOUNT,
      attempts: 2,
      fetch: (async () => {
        throw new TypeError('offline');
      }) as unknown as typeof fetch,
    });
    await expect(offline.list()).rejects.toBeInstanceOf(RemoteUnavailableError);
  });

  it('refuses a project id it could never address, before any request', async () => {
    const { registry, calls } = server();
    await expect(registry.put('not a project', { wrappedKey: new Uint8Array(61), record: new Uint8Array(4) })).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
  });

  it('refuses a listing that is not what the routes promise', async () => {
    await expect(server(() => Response.json({ projects: [{ id: 'x y' }] })).registry.list()).rejects.toThrow(/malformed/);
    await expect(server(() => Response.json({ nope: true })).registry.list()).rejects.toThrow(/malformed/);
    await expect(
      server(() => Response.json({ projects: [{ id: PROJECT, wrappedKey: 'not base64!', record: 'AAAA', createdAt: 1, updatedAt: 2 }] })).registry.list(),
    ).rejects.toThrow(/malformed/);
  });
});
