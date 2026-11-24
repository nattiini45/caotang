/**
 * A vault sealed by the operating system — desktop.md §The keychain, as this repository's gate sees it: what happens when the
 * file will not parse, when the seal is broken, when a write does not survive its own read-back, and when a caller wants back
 * what it just replaced. The seal is a scripted host, so nothing here needs a keychain.
 */

import { describe, expect, it } from 'vitest';
import { openOsVault, VAULT_ID, type OsVaultHost } from '../src/keys/os-vault.js';

/** A host that seals by prefixing and opens by stripping: enough to prove the vault's own rules, and to break on demand. */
function host(overrides: Partial<OsVaultHost> = {}): OsVaultHost & { readonly file: { text: string | undefined }; readonly writes: number } {
  const file: { text: string | undefined } = { text: undefined };
  let writes = 0;
  const made: OsVaultHost & { readonly file: typeof file; readonly writes: number } = {
    file,
    get writes() { return writes; },
    available: async () => true,
    read: async () => file.text,
    write: async (text) => { writes += 1; file.text = text; },
    seal: async (plain) => `sealed:${Buffer.from(plain, 'utf8').toString('base64')}`,
    open: async (sealed) => {
      if (!sealed.startsWith('sealed:')) throw new Error('not a sealed value');
      return Buffer.from(sealed.slice('sealed:'.length), 'base64').toString('utf8');
    },
    ...overrides,
  };
  return made;
}

const ID = 'prv_ABCDEFGHJK';
const TOKEN = 'mcp:one';
const KEY = 'sk-live-0123456789abcdef';

describe('a vault with entries', () => {
  it('stores a key, reads it back in the host, and answers the page with a revision instead', async () => {
    const vault = await openOsVault(host());
    await vault.put(ID, { apiKey: KEY });
    expect((await vault.read(ID))?.apiKey).toBe(KEY);
    expect(await vault.has(ID)).toBe(true);
    expect(await vault.headers(ID)).toEqual({});
    expect(await vault.revision(ID)).toMatch(/^[0-9a-f]{64}$/);
    expect(await vault.revision('prv_ZZZZZZZZZZ')).toBe('empty');
  });

  it('keeps the extra header values with the key, and gives back only those to the page', async () => {
    const vault = await openOsVault(host());
    await vault.put(ID, { apiKey: KEY, customHeaders: { 'x-workspace': 'w1' } });
    expect(await vault.headers(ID)).toEqual({ 'x-workspace': 'w1' });
    expect(await vault.read(ID)).toEqual({ apiKey: KEY, customHeaders: { 'x-workspace': 'w1' } });
  });

  it('keeps an entry whose key is empty, because a profile may authenticate with its headers alone (#868)', async () => {
    const vault = await openOsVault(host());
    await vault.put(ID, { apiKey: '', customHeaders: { 'x-workspace': 'w1' } });
    // The empty key is sealed and read back as an empty key, not as a missing entry and not as a header-only payload.
    expect(await vault.read(ID)).toEqual({ apiKey: '', customHeaders: { 'x-workspace': 'w1' } });
    expect(await vault.headers(ID)).toEqual({ 'x-workspace': 'w1' });
    expect(await vault.keyState(ID)).toBe('empty');
    expect(await vault.keyState(TOKEN)).toBe('none');
    await vault.put(TOKEN, { apiKey: KEY });
    expect(await vault.keyState(TOKEN)).toBe('key');
    // An edit that changes only the headers keeps the empty key where it was.
    await vault.putHeaders(ID, { 'x-workspace': 'w2' });
    expect(await vault.read(ID)).toEqual({ apiKey: '', customHeaders: { 'x-workspace': 'w2' } });
  });

  it('opens its file again, so a key survives a restart', async () => {
    const one = host();
    await (await openOsVault(one)).put(ID, { apiKey: KEY });
    const reopened = await openOsVault(one);
    expect((await reopened.read(ID))?.apiKey).toBe(KEY);
    expect(await reopened.has(TOKEN)).toBe(false);
  });

  it('removes a key, and a removal of nothing is not a failure', async () => {
    const held = host();
    const vault = await openOsVault(held);
    await vault.put(ID, { apiKey: KEY });
    const before = held.writes;
    await vault.remove(ID);
    expect(await vault.has(ID)).toBe(false);
    expect(held.writes).toBe(before + 1);
    await vault.remove(ID);
    expect(held.writes).toBe(before + 1);
  });

  it('revises on every store, even of the same key, because a revision says when the record changed', async () => {
    const vault = await openOsVault(host({
      seal: (() => {
        let count = 0;
        return async (plain: string) => `sealed:${Buffer.from(`${plain}:${count += 1}`, 'utf8').toString('base64')}`;
      })(),
      open: async (sealed) => {
        const plain = Buffer.from(sealed.slice('sealed:'.length), 'base64').toString('utf8');
        return plain.replace(/:\d+$/u, '');
      },
    }));
    await vault.put(ID, { apiKey: KEY });
    const first = await vault.revision(ID);
    await vault.put(ID, { apiKey: KEY });
    expect(await vault.revision(ID)).not.toBe(first);
  });
});

describe('a vault that cannot do what it was asked', () => {
  it('costs its keys, not the window, when the file will not parse', async () => {
    const vault = await openOsVault(host({ read: async () => '{ not json' }));
    expect(await vault.has(ID)).toBe(false);
    await vault.put(ID, { apiKey: KEY });
    expect((await vault.read(ID))?.apiKey).toBe(KEY);
  });

  it('drops an entry it cannot open rather than failing to start', async () => {
    const one = host();
    await (await openOsVault(one)).put(ID, { apiKey: KEY });
    const vault = await openOsVault(host({ read: async () => one.file.text, open: async () => { throw new Error('wrong key'); } }));
    expect(await vault.read(ID)).toBeUndefined();
    expect(await vault.headers(ID)).toBeUndefined();
    expect(await vault.has(ID)).toBe(true);
  });

  it('refuses to store anything where there is no keychain, and stores nothing', async () => {
    const held = host();
    await held.write(JSON.stringify({ version: 1, entries: {} }));
    const vault = await openOsVault({ ...held, available: async () => false });
    await expect(vault.put(ID, { apiKey: KEY })).rejects.toThrow(/keychain is not available/u);
    expect(await vault.has(ID)).toBe(false);
    expect(await vault.read(ID)).toBeUndefined();
  });

  it('puts the earlier file back when a store does not survive its own read-back', async () => {
    const held = host();
    const vault = await openOsVault(held);
    await vault.put(ID, { apiKey: KEY });
    const before = held.file.text;
    const broken = await openOsVault({
      ...held,
      read: async () => before,
      // The seal works, but what comes back is not what went in.
      open: async () => JSON.stringify({ apiKey: 'sk-something-else' }),
    });
    await expect(broken.put(ID, { apiKey: 'sk-new' })).rejects.toThrow(/did not survive/u);
    expect(held.file.text).toBe(before);
  });

  it('does not call a store that lost its extra headers stored, because the first call needing one would fail', async () => {
    const held = host();
    const vault = await openOsVault(held);
    await vault.put(ID, { apiKey: KEY });
    const before = held.file.text;
    const lossy = await openOsVault({
      ...held,
      read: async () => before,
      // The key comes back and the headers beside it do not: a read-back that compared only the key would pass this.
      open: async () => JSON.stringify({ apiKey: 'sk-with-headers' }),
    });
    await expect(lossy.put(ID, { apiKey: 'sk-with-headers', customHeaders: { 'x-workspace': 'w1' } })).rejects.toThrow(/did not survive/u);
    expect(held.file.text).toBe(before);
  });
});

describe('undoing a store', () => {
  it('puts back the key a failed replace overwrote', async () => {
    const vault = await openOsVault(host());
    await vault.put(TOKEN, { apiKey: 'old-token' });
    await vault.put(TOKEN, { apiKey: 'new-token' });
    expect((await vault.read(TOKEN))?.apiKey).toBe('new-token');
    await vault.restore(TOKEN);
    expect((await vault.read(TOKEN))?.apiKey).toBe('old-token');
  });

  it('removes an entry that had nothing before it when it puts back', async () => {
    const vault = await openOsVault(host());
    await vault.put(TOKEN, { apiKey: 'first-token' });
    await vault.restore(TOKEN);
    expect(await vault.has(TOKEN)).toBe(false);
  });

  it('answers that there is nothing to put back when nothing was stored', async () => {
    const vault = await openOsVault(host());
    await expect(vault.restore(ID)).rejects.toThrow(/nothing to put back/u);
  });

  it('does not invent a key when what it would put back was nothing', async () => {
    const vault = await openOsVault(host());
    await vault.put(TOKEN, { apiKey: 'first-token' });
    await vault.remove(TOKEN);
    await vault.restore(TOKEN);
    // The undo of the first store is "there was nothing here", so putting it back leaves nothing: a key never appears that was
    // not stored before the call it undoes.
    expect(await vault.has(TOKEN)).toBe(false);
    expect(await vault.read(TOKEN)).toBeUndefined();
  });
});

describe('the ids a vault holds', () => {
  it('accepts a profile id and an mcp reference, and nothing that could be a path', () => {
    for (const id of ['prv_ABCDEFGHJK', 'mcp:abc-1_2.3', 'plain']) expect(VAULT_ID.test(id), id).toBe(true);
    for (const id of ['', '../escape', 'a/b', 'a\\b', 'x'.repeat(129)]) expect(VAULT_ID.test(id), id).toBe(false);
  });
});
