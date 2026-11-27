import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { openOsVault } from '@caotang/gateway/keys/os-vault';
import { accountOrigin, createAccountPort } from '../src/account-port.mjs';

const ORIGIN = 'https://account.example';
const OTHER = 'https://other.example';
const TEST_COOKIE = 'test-session.signature';

async function fixture(available: boolean) {
  let saved: string | undefined;
  const vault = await openOsVault({
    available: async () => available,
    read: async () => saved,
    write: async (value) => { saved = value; },
    seal: async (value) => Buffer.from(value).toString('base64'),
    open: async (value) => Buffer.from(value, 'base64').toString(),
  });
  const code = 'ABCD2345';
  const descriptor = 'test-descriptor.signature';
  let approved = false;
  const call = vi.fn<typeof fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/start')) return Response.json({ connection: descriptor, code, expires: Date.now() + 300_000 });
    if (path.endsWith('/redeem')) return approved
      ? new Response(null, { status: 204, headers: { 'Set-Cookie': `__Host-caotang-session=${TEST_COOKIE}; Secure; HttpOnly; Path=/` } })
      : new Response(null, { status: 202 });
    if (path.endsWith('/cancel')) return new Response(null, { status: 204 });
    expect(new Headers(init?.headers).get('Cookie')).toBe(`__Host-caotang-session=${TEST_COOKIE}`);
    return Response.json({ id: 'account-reader' }, { headers: { 'Set-Cookie': 'synthetic=hidden', ETag: '"1"' } });
  });
  const openBrowser = vi.fn<(url: string) => Promise<void>>(async () => {});
  const port = createAccountPort({ vault, call, openBrowser });
  return { port, vault, call, openBrowser, approve: () => { approved = true; }, get sealed() { return saved; } };
}

describe('the native account port', () => {
  it.each(['http://account.example', 'https://sub:pass@account.example', `${ORIGIN}/projects`, `${ORIGIN}#account`])('refuses unpinned server address %s', (origin) => {
    expect(accountOrigin(origin)).toBeNull();
  });

  it('holds the verifier natively and seals one session for the confirmed origin', async () => {
    const h = await fixture(true);
    const result = await h.port.begin(ORIGIN);
    expect(result).toMatchObject({ kind: 'waiting', code: 'ABCD2345' });
    const link = new URL(h.openBrowser.mock.calls[0]![0]);
    expect(link.origin).toBe(ORIGIN);
    expect([...link.searchParams.keys()]).toEqual(['desktop_connection']);
    expect(await h.port.check()).toMatchObject({ kind: 'waiting' });
    h.approve();
    expect(await h.port.check()).toEqual({ kind: 'signed-in' });
    expect(JSON.stringify(result)).not.toContain(TEST_COOKIE);
    expect(h.sealed).not.toContain(TEST_COOKIE);
    expect(h.vault.keysFor(ORIGIN)).toHaveLength(1);
    h.port.reset();
    expect(await h.port.restore(OTHER)).toEqual({ kind: 'signed-out' });
    expect(await h.port.restore(ORIGIN)).toEqual({ kind: 'signed-in' });
    const request = { id: randomUUID(), url: `${ORIGIN}/v1/account`, method: 'GET', headers: [] };
    expect((await h.port.request(request)).headers).toEqual([['content-type', 'application/json'], ['etag', '"1"']]);
    expect(h.call.mock.lastCall?.[1]).toMatchObject({ redirect: 'error' });
    const before = h.call.mock.calls.length;
    await expect(h.port.request({ ...request, url: `${OTHER}/v1/account` })).rejects.toThrow('Invalid account route');
    await expect(h.port.request({ ...request, url: `${ORIGIN}/v1/auth/github` })).rejects.toThrow('Invalid account route');
    await expect(h.port.request({ ...request, headers: [['Cookie', 'not-the-session']] })).rejects.toThrow('Invalid account header');
    expect(h.call).toHaveBeenCalledTimes(before);
    expect(await h.port.signOut()).toEqual({ kind: 'signed-out' });
    expect(h.vault.keysFor(ORIGIN)).toHaveLength(0);
  });

  it('allows only an in-memory session when OS sealing is unavailable', async () => {
    const h = await fixture(false);
    await h.port.begin(ORIGIN);
    h.approve();
    expect(await h.port.check()).toEqual({ kind: 'signed-in' });
    expect(h.sealed).toBeUndefined();
    h.port.reset();
    expect(await h.port.restore(ORIGIN)).toEqual({ kind: 'signed-out' });
  });
});
