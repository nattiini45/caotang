import { createHash, randomBytes } from 'node:crypto';
import type { OsKeyVault } from '@caotang/gateway/keys/os-vault';
import type { AccountRequest, AccountResponse, AccountState } from './account-contract.cjs';

const COOKIE_NAME = '__Host-caotang-session';
const LIMIT = 64 * 1024 * 1024;
const MAX_CALLS = 8;
const CONNECT = '/v1/auth/desktop/';
const SESSION = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ALLOWED_HEADERS = new Set(['content-type', 'if-match', 'if-none-match', 'idempotency-key', 'x-caotang-account', 'x-caotang-device', 'x-caotang-takeover']);
const PROJECT_API = /^\/v1\/projects\/[A-Za-z0-9_-]{1,64}\/(lease|blobs(?:\/[a-z0-9-]{1,64})?)$/;

export function accountOrigin(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 2048) return null;
  try {
    const url = new URL(input.trim());
    return url.protocol === 'https:' && !url.username && !url.password && url.href === `${url.origin}/` ? url.origin : null;
  } catch {
    return null;
  }
}

function vaultId(origin: string): string {
  return createHash('sha256').update(origin).digest('hex');
}

function allowedPath(path: string, method: string): boolean {
  if (['/v1/account', '/v1/session', '/v1/account/key-record', '/v1/projects'].includes(path)) return method === 'GET';
  const endpoint = PROJECT_API.exec(path)?.[1];
  if (endpoint === 'lease') return method === 'POST' || method === 'DELETE';
  if (endpoint === 'blobs') return method === 'GET';
  return endpoint !== undefined && ['GET', 'PUT', 'DELETE'].includes(method);
}

async function boundedBody(response: Response, max: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) throw new RangeError('Account response too large.');
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return bytes;
}

type Waiting = { readonly connection: string; readonly verifier: string; readonly code: string; readonly expires: number };
type Refusal = Extract<AccountState, { kind: 'refused' }>['reason'];
const refused = (reason: Refusal): AccountState => ({ kind: 'refused', reason });
const signedOut: AccountState = { kind: 'signed-out' };

export function createAccountPort({ vault, openBrowser, call = fetch }: {
  readonly vault: OsKeyVault;
  readonly openBrowser: (url: string) => Promise<void>;
  readonly call?: typeof fetch;
}) {
  let origin: string | null = null;
  let token: string | null = null;
  let waiting: Waiting | null = null;
  let lifetime = new AbortController();
  let turn: Promise<unknown> = Promise.resolve();
  const calls = new Map<string, AbortController>();

  function reset(): void {
    lifetime.abort();
    lifetime = new AbortController();
    calls.clear();
    origin = null;
    token = null;
    waiting = null;
  }

  function serial(action: () => Promise<AccountState>): Promise<AccountState> {
    const current = turn.then(action, action).catch(() => refused('unavailable'));
    turn = current;
    return current;
  }

  function send(address: string, path: string, method: string, headers: Headers, body?: Uint8Array | string, signal = lifetime.signal): Promise<Response> {
    headers.set('Origin', address);
    return call(new URL(path, address), {
      method, headers, redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : body.slice() }),
    });
  }

  function connection(address: string, route: string, data: object): Promise<Response> {
    return send(address, CONNECT + route, 'POST', new Headers({ 'Content-Type': 'application/json' }), JSON.stringify(data));
  }

  async function forget(address: string): Promise<void> {
    const id = vaultId(address);
    if (vault.originOf(id) === address) await vault.remove(id);
  }

  function waitState(pending: Waiting): AccountState {
    return { kind: 'waiting', code: pending.code, expires: pending.expires };
  }

  return {
    reset,
    restore(raw: unknown): Promise<AccountState> {
      return serial(async () => {
        const address = accountOrigin(raw);
        if (!address) return refused('invalid-address');
        reset();
        const signal = lifetime.signal;
        const id = vaultId(address);
        if (!await vault.available() || vault.originOf(id) !== address) return signedOut;
        const saved = (await vault.readFor(address, [id]))?.get(id)?.apiKey;
        signal.throwIfAborted();
        if (saved === undefined || saved.length > 4096 || !SESSION.test(saved)) return signedOut;
        const response = await send(address, '/v1/session', 'GET', new Headers({ Cookie: `${COOKIE_NAME}=${saved}` }));
        await response.body?.cancel();
        signal.throwIfAborted();
        if (response.status === 401) {
          await forget(address);
          return signedOut;
        }
        if (response.status !== 200) return refused('unavailable');
        origin = address;
        token = saved;
        return { kind: 'signed-in' };
      });
    },
    begin(raw: unknown): Promise<AccountState> {
      return serial(async () => {
        const address = accountOrigin(raw);
        if (!address) return refused('invalid-address');
        reset();
        const signal = lifetime.signal;
        const verifier = randomBytes(32).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const response = await connection(address, 'start', { challenge });
        if (response.status === 404) {
          await response.body?.cancel();
          return refused('unsupported');
        }
        if (!response.ok) {
          await response.body?.cancel();
          return refused('unavailable');
        }
        const data: unknown = JSON.parse(new TextDecoder().decode(await boundedBody(response, 8192) ?? undefined));
        if (data === null || typeof data !== 'object') return refused('unavailable');
        const { connection: descriptor, code, expires } = data as Record<string, unknown>;
        if (typeof descriptor !== 'string' || descriptor.length > 4096 || !SESSION.test(descriptor) ||
          typeof code !== 'string' || !/^[2-9A-HJ-NP-Z]{8}$/.test(code) || typeof expires !== 'number' ||
          !Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + 6 * 60_000) return refused('unavailable');
        const approval = new URL('/', address);
        approval.searchParams.set('desktop_connection', descriptor);
        signal.throwIfAborted();
        await openBrowser(approval.href);
        signal.throwIfAborted();
        origin = address;
        waiting = { connection: descriptor, verifier, code, expires };
        return waitState(waiting);
      });
    },
    check(): Promise<AccountState> {
      return serial(async () => {
        const address = origin;
        const pending = waiting;
        if (!address || !pending) return token === null ? signedOut : { kind: 'signed-in' };
        if (Date.now() >= pending.expires) {
          reset();
          return refused('expired');
        }
        const signal = lifetime.signal;
        const response = await connection(address, 'redeem', { connection: pending.connection, verifier: pending.verifier });
        await response.body?.cancel();
        signal.throwIfAborted();
        if (response.status === 202) return waitState(pending);
        if (response.status === 410 || response.status === 401) {
          reset();
          return refused('expired');
        }
        if (response.status !== 204) return refused('unavailable');
        const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${COOKIE_NAME}=`));
        const saved = cookie?.split(';', 1)[0]?.slice(COOKIE_NAME.length + 1);
        if (saved === undefined || saved.length > 4096 || !SESSION.test(saved)) {
          reset();
          return refused('unavailable');
        }
        waiting = null;
        token = saved;
        if (await vault.available().catch(() => false)) {
          signal.throwIfAborted();
          await vault.put(vaultId(address), { apiKey: saved }, address).catch(() => undefined);
        }
        signal.throwIfAborted();
        return { kind: 'signed-in' };
      });
    },
    cancel(): Promise<AccountState> {
      return serial(async () => {
        const address = origin;
        const pending = waiting;
        if (address && pending) {
          reset();
          const result = await connection(address, 'cancel', { connection: pending.connection, verifier: pending.verifier }).catch(() => undefined);
          await result?.body?.cancel();
        }
        return signedOut;
      });
    },
    signOut(): Promise<AccountState> {
      return serial(async () => {
        const address = origin;
        if (address) await forget(address);
        reset();
        return signedOut;
      });
    },
    abort(id: unknown): void {
      if (typeof id === 'string') calls.get(id)?.abort();
    },
    async request(raw: unknown): Promise<AccountResponse> {
      const address = origin;
      const secret = token;
      if (address === null || secret === null) return { status: 401, headers: [], body: null };
      if (raw === null || typeof raw !== 'object') throw new TypeError('Invalid account request.');
      const { id, url, method, headers, body } = raw as Partial<AccountRequest>;
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id) || calls.has(id) || calls.size >= MAX_CALLS ||
        typeof url !== 'string' || url.length > 2048 || typeof method !== 'string' || !Array.isArray(headers) || headers.length > 12) {
        throw new TypeError('Invalid account request.');
      }
      const target = new URL(url);
      if (target.origin !== address || target.href !== address + target.pathname || !allowedPath(target.pathname, method) ||
        (body !== undefined && (!(body instanceof Uint8Array) || body.byteLength > LIMIT || method !== 'PUT'))) {
        throw new TypeError('Invalid account route.');
      }
      const safe = new Headers({ Cookie: `${COOKIE_NAME}=${secret}` });
      for (const header of headers) {
        if (!Array.isArray(header) || header.length !== 2 || typeof header[0] !== 'string' || typeof header[1] !== 'string' ||
          !ALLOWED_HEADERS.has(header[0].toLowerCase()) || header[1].length > 1024) throw new TypeError('Invalid account header.');
        safe.set(header[0], header[1]);
      }
      const controller = new AbortController();
      calls.set(id, controller);
      const signal = AbortSignal.any([lifetime.signal, controller.signal]);
      try {
        const response = await send(address, target.pathname, method, safe, body, signal);
        const exposed = [...response.headers].filter(([name]) => name === 'etag' || name === 'content-type');
        const bytes = await boundedBody(response, LIMIT);
        signal.throwIfAborted();
        return { status: response.status, headers: exposed, body: bytes };
      } finally {
        if (calls.get(id) === controller) calls.delete(id);
      }
    },
  };
}
