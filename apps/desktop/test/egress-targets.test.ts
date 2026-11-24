/**
 * The addresses the desktop app publishes to its own port (desktop.md §Native provider calls, §The keychain). A provider
 * profile on this computer carries a key held in the keychain, and the page can only ever put a handle in its place, so the
 * profile has to reach the port as a local entry or the server is sent `caotang-key:<id>` as if it were the key (issue #867).
 *
 * The page publishes addresses and never key ids (#864): the key each address may carry is the main process's answer, read from
 * the address the vault stored with it. Every check here therefore builds the port's allowlist the way the shell does — the
 * published entry plus the ids the vault has stored for that address.
 */

import { attachKeys, checkNativeEgress, keyHandle, nativeEgressTargets, type ProfileView } from '@caotang/gateway';
import { EMPTY_MCP_SETTINGS } from '@caotang/mcp-client';
import { describe, expect, it } from 'vitest';

import { egressTargets } from '../src/app/native-egress.js';

/** The port's allowlist as the shell builds it: what the page published, plus the ids the vault stored for each address. */
function withKeys(published: ReturnType<typeof egressTargets>, keysByOrigin: ReadonlyMap<string, readonly string[]>): ReturnType<typeof nativeEgressTargets> {
  return nativeEgressTargets(published.map((entry) => ({ ...entry, keys: keysByOrigin.get(entry.origin) ?? [] })));
}

function profile(over: Partial<ProfileView> & { readonly id: string }): ProfileView {
  return { name: over.id, kind: 'endpoint', preset: 'generic', baseUrl: 'https://api.example.com/v1', defaultModel: 'm', isActive: false, hasKey: true, ...over };
}

const chat = (origin: string, id: string): Record<string, unknown> => ({
  url: `${origin}/v1/chat/completions`,
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${keyHandle(id)}` },
  body: '{"model":"m","messages":[]}',
});

describe('the addresses the desktop port is given', () => {
  it('publishes a provider on this computer as a local entry, so the real key reaches it instead of a handle', () => {
    const local = profile({ id: 'prv_LOCALMODEL', preset: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' });
    const targets = egressTargets([local], EMPTY_MCP_SETTINGS);
    expect(targets).toEqual([{ origin: 'http://127.0.0.1:1234', local: true }]);

    const checked = checkNativeEgress(withKeys(targets, new Map([['http://127.0.0.1:1234', ['prv_LOCALMODEL']]])), chat('http://127.0.0.1:1234', 'prv_LOCALMODEL'));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.request.keys).toEqual(['prv_LOCALMODEL']);

    const sent = attachKeys(checked.request, new Map([['prv_LOCALMODEL', 'sk-local-secret']]));
    expect(sent.headers['authorization']).toBe('Bearer sk-local-secret');
    expect(JSON.stringify(sent)).not.toContain('caotang-key:');
  });

  it('keeps the key of one profile out of another address', () => {
    const local = profile({ id: 'prv_LOCALMODEL', baseUrl: 'http://127.0.0.1:1234/v1' });
    const elsewhere = profile({ id: 'prv_CLOUD', baseUrl: 'https://api.example.com/v1' });
    const targets = withKeys(egressTargets([local, elsewhere], EMPTY_MCP_SETTINGS), new Map([
      ['http://127.0.0.1:1234', ['prv_LOCALMODEL']],
      ['https://api.example.com', ['prv_CLOUD']],
    ]));
    const checked = checkNativeEgress(targets, chat('https://api.example.com', 'prv_LOCALMODEL'));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.refusal).toBe('denied');
  });

  it('still refuses plain http to any host but a loopback literal', () => {
    // No profile record can be saved with an address like this, so the guard is the port's own rule: a target that says
    // `local` does not make a public plain-http address reachable.
    expect(egressTargets([profile({ id: 'prv_PUBLIC', baseUrl: 'http://api.example.com/v1' })], EMPTY_MCP_SETTINGS))
      .toEqual([{ origin: 'http://api.example.com' }]);
    expect(nativeEgressTargets([{ origin: 'http://api.example.com', local: true }]).size).toBe(0);
    const checked = checkNativeEgress(new Map(), chat('http://api.example.com', 'prv_PUBLIC'));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.refusal).toBe('invalid');
  });
});
