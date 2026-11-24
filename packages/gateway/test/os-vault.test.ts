/**
 * The keychain, sealed by the operating system — desktop.md §The keychain, as this repository's gate sees it: the rule that
 * decides the whole file — a key and the address it was entered for are one entry, committed in one write — and what happens
 * when the file will not parse, when the seal is broken, when a write does not survive its own read-back, and when a caller
 * wants back what it just replaced. The seal is a scripted host, so nothing here needs a keychain.
 */

import { describe, expect, it } from 'vitest';
import { KeyBoundElsewhere, openOsVault, VAULT_ID, type OsKeyVault, type OsVaultHost } from '../src/keys/os-vault.js';
import { nativeKeyStore } from '../src/keys/native-store.js';
import { createProfileStore } from '../src/profiles.js';

const ID = 'prv_ABCDEFGHJK';
const TOKEN = 'mcp:one';
const A = 'https://a.example';
const B = 'https://b.example';
const KEY = '[redacted]';

/** A host that seals by prefixing and opens by stripping, and keeps the vault's file in memory: enough for the rules above it. */
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

/** What the file holds: the entries as they were written, so a test can read the pairing the vault committed. */
function entriesOf(held: { readonly file: { text: string | undefined } }): Record<string, unknown> {
  const text = held.file.text;
  if (text === undefined) throw new Error('the vault wrote nothing');
  return (JSON.parse(text) as { entries: Record<string, unknown> }).entries;
}

describe('a key is one entry with the address it was entered for', () => {
  it('commits the sealed secret and its address in one write, and answers with both', async () => {
    const held = host();
    const vault = await openOsVault(held);
    await vault.put(ID, { apiKey: KEY }, A);

    // One write of the file holds the sealed value and the address: there is no turn in which a key exists without its address.
    expect(held.writes).toBe(1);
    expect(entriesOf(held)[ID]).toEqual({ sealed: expect.any(String), origin: A });
    expect(held.file.text).not.toContain(KEY);

    expect(vault.originOf(ID)).toBe(A);
    expect(vault.keysFor(A)).toEqual([ID]);
    expect(vault.keysFor(B)).toEqual([]);
    expect((await vault.readFor(A, [ID]))?.get(ID)?.apiKey).toBe(KEY);
    // The same id at another address is answered with nothing: a key is only ever sent to where it was entered.
    expect(await vault.readFor(B, [ID])).toBeUndefined();
  });

  it('refuses a second address for a key already stored, and writes nothing', async () => {
    const held = host();
    const vault = await openOsVault(held);
    await vault.put(ID, { apiKey: KEY }, A);

    await expect(vault.put(ID, { apiKey: 'sk-other' }, B)).rejects.toBeInstanceOf(KeyBoundElsewhere);
    // The refusal changed nothing: the key and its address are the pair the writer entered, and nothing was written for it.
    expect(held.writes).toBe(1);
    expect(vault.originOf(ID)).toBe(A);
    expect((await vault.read(ID))?.apiKey).toBe(KEY);
  });

  it('moves the key and the address together when the writer types it again for a changed endpoint', async () => {
    const held = host();
    const vault = await openOsVault(held);
    await vault.put(ID, { apiKey: KEY }, A);
    await vault.putReplacement(ID, { apiKey: 'sk-typed-again' }, B);

    expect(held.writes).toBe(2);
    expect(entriesOf(held)[ID]).toEqual({ sealed: expect.any(String), origin: B });
    expect(vault.originOf(ID)).toBe(B);
    expect(vault.keysFor(A)).toEqual([]);
    expect((await vault.readFor(B, [ID]))?.get(ID)?.apiKey).toBe('sk-typed-again');
    expect(await vault.readFor(A, [ID])).toBeUndefined();
  });

  it('settles two saves of one id at once: one address wins and the other is refused', async () => {
    const vault = await openOsVault(host());
    const results = await Promise.allSettled([
      vault.put(ID, { apiKey: 'sk-one' }, A),
      vault.put(ID, { apiKey: 'sk-two' }, B),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected' && result.reason instanceof KeyBoundElsewhere)).toHaveLength(1);
    const held = vault.originOf(ID);
    expect([A, B]).toContain(held);
    // The address the id did not keep is answered with nothing, so neither save's secret can be sent to the other's endpoint.
    expect(await vault.readFor(held === A ? B : A, [ID])).toBeUndefined();
    expect((await vault.readFor(held ?? '', [ID]))?.get(ID)?.apiKey).toBe(held === A ? 'sk-one' : 'sk-two');
  });

  it('drops the key and its address together, and the undo with them', async () => {
    const vault = await openOsVault(host());
    await vault.put(ID, { apiKey: 'sk-first' }, A);
    await vault.put(ID, { apiKey: KEY }, A);
    await vault.remove(ID);

    expect(await vault.has(ID)).toBe(false);
    expect(vault.originOf(ID)).toBeUndefined();
    expect(vault.keysFor(A)).toEqual([]);
    expect(await vault.readFor(A, [ID])).toBeUndefined();
    // A removal is final: there is nothing left to put back, so no later restore can bring the secret back at any address.
    await expect(vault.restore(ID)).rejects.toThrow(/nothing to put back/u);
    expect(await vault.has(ID)).toBe(false);
  });
});

describe('a vault with entries', () => {
  it('stores a key, reads it back in the host, and answers the page with a revision instead', async () => {
    const vault = await openOsVault(host());
    await vault.put(ID, { apiKey: KEY }, A);
    expect((await vault.read(ID))?.apiKey).toBe(KEY);
    expect(await vault.has(ID)).toBe(true);
    expect(await vault.headers(ID)).toEqual({});
    expect(await vault.revision(ID)).toMatch(/^[0-9a-f]{64}$/);
    expect(await vault.revision('prv_ZZZZZZZZZZ')).toBe('empty');
  });

  it('keeps the extra header values with the key, and gives back only those to the page', async () => {
    const vault = await openOsVault(host());
    await vault.put(ID, { apiKey: KEY, customHeaders: { 'x-workspace': 'w1' } }, A);
    expect(await vault.headers(ID)).toEqual({ 'x-workspace': 'w1' });
    expect(await vault.read(ID)).toEqual({ apiKey: KEY, customHeaders: { 'x-workspace': 'w1' } });
  });

  it('keeps an entry whose key is empty, because a profile may authenticate with its headers alone (#868)', async () => {
    const vault = await openOsVault(host());
    await vault.put(ID, { apiKey: '', customHeaders: { 'x-workspace': 'w1' } }, A);
    // The empty key is sealed and read back as an empty key, not as a missing entry and not as a header-only payload.
    expect(await vault.read(ID)).toEqual({ apiKey: '', customHeaders: { 'x-workspace': 'w1' } });
    expect(await vault.headers(ID)).toEqual({ 'x-workspace': 'w1' });
    expect(await vault.keyState(ID)).toBe('empty');
    expect(await vault.keyState(TOKEN)).toBe('none');
    await vault.put(TOKEN, { apiKey: KEY }, A);
    expect(await vault.keyState(TOKEN)).toBe('key');
    // An edit that changes only the headers keeps the empty key where it was, at the address it was stored for.
    await vault.putHeaders(ID, { 'x-workspace': 'w2' });
    expect(await vault.read(ID)).toEqual({ apiKey: '', customHeaders: { 'x-workspace': 'w2' } });
    expect(vault.originOf(ID)).toBe(A);
  });

  it('opens its file again, so a key and its address survive a restart', async () => {
    const held = host();
    await (await openOsVault(held)).put(ID, { apiKey: KEY }, A);
    const reopened = await openOsVault(held);
    expect((await reopened.read(ID))?.apiKey).toBe(KEY);
    expect(reopened.originOf(ID)).toBe(A);
    expect(await reopened.has(TOKEN)).toBe(false);
  });

  it('removes a key, and a removal of nothing is not a failure', async () => {
    const held = host();
    const vault = await openOsVault(held);
    await vault.put(ID, { apiKey: KEY }, A);
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
    await vault.put(ID, { apiKey: KEY }, A);
    const first = await vault.revision(ID);
    await vault.put(ID, { apiKey: KEY }, A);
    expect(await vault.revision(ID)).not.toBe(first);
  });
});

describe('a save that fails leaves neither the key nor the address', () => {
  it('keeps nothing when the file cannot be written', async () => {
    const held = host();
    let fail = false;
    const vault = await openOsVault({
      ...held,
      write: async (text) => {
        if (fail) throw new Error('the file could not be written');
        held.file.text = text;
      },
    });
    fail = true;
    await expect(vault.put(ID, { apiKey: KEY }, A)).rejects.toThrow(/could not be written/u);
    // No address was left behind for a key that was not stored, so the writer's next save may take the id for the address
    // they enter it for.
    expect(await vault.has(ID)).toBe(false);
    expect(vault.originOf(ID)).toBeUndefined();
    expect(vault.keysFor(A)).toEqual([]);
  });

  it('keeps nothing when the seal itself fails', async () => {
    const vault = await openOsVault(host({ seal: async () => { throw new Error('the keychain refused to seal it'); } }));
    await expect(vault.put(ID, { apiKey: KEY }, A)).rejects.toThrow(/refused to seal/u);
    expect(await vault.has(ID)).toBe(false);
    expect(vault.originOf(ID)).toBeUndefined();
    expect(vault.keysFor(A)).toEqual([]);
  });

  it('costs its keys, not the window, when the file will not parse', async () => {
    const vault = await openOsVault(host({ read: async () => '{ not json' }));
    expect(await vault.has(ID)).toBe(false);
    await vault.put(ID, { apiKey: KEY }, A);
    expect((await vault.read(ID))?.apiKey).toBe(KEY);
  });

  it('drops an entry it cannot open rather than failing to start', async () => {
    const one = host();
    await (await openOsVault(one)).put(ID, { apiKey: KEY }, A);
    const vault = await openOsVault(host({ read: async () => one.file.text, open: async () => { throw new Error('wrong key'); } }));
    expect(await vault.read(ID)).toBeUndefined();
    expect(await vault.headers(ID)).toBeUndefined();
    expect(await vault.has(ID)).toBe(true);
    // The address is plain text beside a sealed value, so it survives a machine that cannot open the value: the entry is known
    // to be there and refused, which is the honest answer rather than an empty vault.
    expect(vault.originOf(ID)).toBe(A);
    expect(await vault.readFor(A, [ID])).toBeUndefined();
  });

  it('refuses to store anything where there is no keychain, and stores nothing', async () => {
    const held = host();
    await held.write(JSON.stringify({ version: 2, entries: {} }));
    const vault = await openOsVault({ ...held, available: async () => false });
    await expect(vault.put(ID, { apiKey: KEY }, A)).rejects.toThrow(/keychain is not available/u);
    expect(await vault.has(ID)).toBe(false);
    expect(await vault.read(ID)).toBeUndefined();
    expect(vault.originOf(ID)).toBeUndefined();
  });

  it('puts the earlier file back when a store does not survive its own read-back', async () => {
    const held = host();
    const vault = await openOsVault(held);
    await vault.put(ID, { apiKey: KEY }, A);
    const before = held.file.text;
    const broken = await openOsVault({
      ...held,
      read: async () => before,
      // The seal works, but what comes back is not what went in.
      open: async () => JSON.stringify({ apiKey: 'sk-something-else' }),
    });
    await expect(broken.put(ID, { apiKey: 'sk-new' }, A)).rejects.toThrow(/did not survive/u);
    expect(held.file.text).toBe(before);
  });

  it('leaves a replacement at the address it was stored for when its write does not survive', async () => {
    const held = host();
    const vault = await openOsVault(held);
    await vault.put(ID, { apiKey: 'sk-at-a' }, A);
    const before = held.file.text;
    const broken = await openOsVault({
      ...held,
      read: async () => before,
      open: async () => JSON.stringify({ apiKey: 'sk-not-what-was-written' }),
    });
    await expect(broken.putReplacement(ID, { apiKey: 'sk-at-b' }, B)).rejects.toThrow(/did not survive/u);
    // The failed write put the earlier file back, so the key the writer had is still the key this vault holds, at its own address.
    expect(held.file.text).toBe(before);
    const reopened = await openOsVault({ ...held, read: async () => before });
    expect(reopened.originOf(ID)).toBe(A);
    expect((await reopened.readFor(A, [ID]))?.get(ID)?.apiKey).toBe('sk-at-a');
    expect(await reopened.readFor(B, [ID])).toBeUndefined();
  });

  it('does not call a store that lost its extra headers stored, because the first call needing one would fail', async () => {
    const held = host();
    const vault = await openOsVault(held);
    await vault.put(ID, { apiKey: KEY }, A);
    const before = held.file.text;
    const lossy = await openOsVault({
      ...held,
      read: async () => before,
      // The key comes back and the headers beside it do not: a read-back that compared only the key would pass this.
      open: async () => JSON.stringify({ apiKey: 'sk-with-headers' }),
    });
    await expect(lossy.put(ID, { apiKey: 'sk-with-headers', customHeaders: { 'x-workspace': 'w1' } }, A)).rejects.toThrow(/did not survive/u);
    expect(held.file.text).toBe(before);
  });
});

describe('undoing a store', () => {
  it('puts back the key and the address the last store replaced', async () => {
    const vault = await openOsVault(host());
    await vault.put(TOKEN, { apiKey: 'old-token' }, A);
    await vault.putReplacement(TOKEN, { apiKey: 'new-token' }, B);
    expect((await vault.read(TOKEN))?.apiKey).toBe('new-token');
    await vault.restore(TOKEN);
    // The undo names an entry that was stored as a pair, so it comes back as one: the older key at the address it was entered for.
    expect((await vault.read(TOKEN))?.apiKey).toBe('old-token');
    expect(vault.originOf(TOKEN)).toBe(A);
    expect(await vault.readFor(B, [TOKEN])).toBeUndefined();
  });

  it('removes an entry that had nothing before it when it puts back', async () => {
    const vault = await openOsVault(host());
    await vault.put(TOKEN, { apiKey: 'first-token' }, A);
    await vault.restore(TOKEN);
    expect(await vault.has(TOKEN)).toBe(false);
    expect(vault.originOf(TOKEN)).toBeUndefined();
  });

  it('names the state before the last attempted write, so a restore after a failed one puts back a pair that was stored', async () => {
    const held = host();
    let failNext = false;
    const vault = await openOsVault({
      ...held,
      write: async (text) => {
        if (failNext) {
          failNext = false;
          throw new Error('the file could not be written');
        }
        held.file.text = text;
      },
    });
    await vault.put(TOKEN, { apiKey: 'one' }, A);
    await vault.putReplacement(TOKEN, { apiKey: 'two' }, B);
    // A save for the address the key has now, whose write fails. The undo names the state before it, so the writer's undo of a
    // write that did not happen puts back exactly what they had, with the address it was stored for.
    failNext = true;
    await expect(vault.put(TOKEN, { apiKey: 'three' }, B)).rejects.toThrow(/could not be written/u);
    expect(vault.originOf(TOKEN)).toBe(B);
    await vault.restore(TOKEN);
    expect((await vault.read(TOKEN))?.apiKey).toBe('two');
    expect(vault.originOf(TOKEN)).toBe(B);
    expect(await vault.readFor(A, [TOKEN])).toBeUndefined();
  });

  it('keeps the address of a failed headers edit, so a later undo returns a pair that was stored', async () => {
    const held = host();
    let failNext = false;
    const vault = await openOsVault({
      ...held,
      write: async (text) => {
        if (failNext) {
          failNext = false;
          throw new Error('the file could not be written');
        }
        held.file.text = text;
      },
    });
    await vault.put(ID, { apiKey: 'sk-at-a', customHeaders: { 'x-team': 'one' } }, A);
    failNext = true;
    await expect(vault.putHeaders(ID, { 'x-team': 'two' })).rejects.toThrow(/could not be written/u);
    // The edit did not happen, and the address it would have kept is the one the key was entered for.
    expect(await vault.headers(ID)).toEqual({ 'x-team': 'one' });
    await vault.restore(ID);
    expect(await vault.headers(ID)).toEqual({ 'x-team': 'one' });
    expect(vault.originOf(ID)).toBe(A);
    expect((await vault.readFor(A, [ID]))?.get(ID)?.apiKey).toBe('sk-at-a');
  });

  it('undoes a headers edit with the key and its address intact', async () => {
    const vault = await openOsVault(host());
    await vault.put(ID, { apiKey: KEY, customHeaders: { 'x-team': 'one' } }, A);
    await vault.putHeaders(ID, { 'x-team': 'two' });
    expect(await vault.headers(ID)).toEqual({ 'x-team': 'two' });
    await vault.restore(ID);
    expect(await vault.headers(ID)).toEqual({ 'x-team': 'one' });
    expect(vault.originOf(ID)).toBe(A);
    expect((await vault.readFor(A, [ID]))?.get(ID)?.apiKey).toBe(KEY);
  });

  it('does not give a headers edit an address an entry did not have', async () => {
    const sealed = `sealed:${Buffer.from(JSON.stringify({ apiKey: KEY }), 'utf8').toString('base64')}`;
    const vault = await openOsVault(host({ read: async () => JSON.stringify({ version: 1, entries: { [ID]: sealed } }) }));
    await vault.putHeaders(ID, { 'x-team': 'one' });
    expect(await vault.headers(ID)).toEqual({ 'x-team': 'one' });
    expect(vault.originOf(ID)).toBeUndefined();
    expect(await vault.readFor(A, [ID])).toBeUndefined();
  });

  it('answers that there is nothing to put back when nothing was stored', async () => {
    const vault = await openOsVault(host());
    await expect(vault.restore(ID)).rejects.toThrow(/nothing to put back/u);
  });

  it('does not invent a key when what it would put back was nothing', async () => {
    const vault = await openOsVault(host());
    await vault.put(TOKEN, { apiKey: 'first-token' }, A);
    await vault.remove(TOKEN);
    await expect(vault.restore(TOKEN)).rejects.toThrow(/nothing to put back/u);
    // Nothing appears that was not stored before the call it undoes, and nothing is left for an address to reach.
    expect(await vault.has(TOKEN)).toBe(false);
    expect(await vault.read(TOKEN)).toBeUndefined();
    expect(vault.keysFor(A)).toEqual([]);
  });
});

describe('the ids a vault holds', () => {
  it('accepts a profile id and an mcp reference, and nothing that could be a path', () => {
    for (const id of ['prv_ABCDEFGHJK', 'mcp:abc-1_2.3', 'plain']) expect(VAULT_ID.test(id), id).toBe(true);
    for (const id of ['', '../escape', 'a/b', 'a\\b', 'x'.repeat(129)]) expect(VAULT_ID.test(id), id).toBe(false);
  });

  it('reads no entry for a name that could not be a vault id, whatever a file says', async () => {
    const sealed = `sealed:${Buffer.from(JSON.stringify({ apiKey: KEY }), 'utf8').toString('base64')}`;
    const vault = await openOsVault(host({
      read: async () => JSON.stringify({ version: 2, entries: { '../escape': { sealed, origin: A }, [ID]: { sealed, origin: A } } }),
    }));
    expect(vault.keysFor(A)).toEqual([ID]);
    expect(vault.originOf('../escape')).toBeUndefined();
  });
});

describe('a key stored before the addresses were kept', () => {
  /** What an earlier build wrote: the sealed payload alone, under a file version that had no addresses in it. */
  function legacy(payload: { apiKey: string }): string {
    const sealed = `sealed:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}`;
    return JSON.stringify({ version: 1, entries: { [ID]: sealed } });
  }

  it('stays denied at every address until the writer enters it again for the one they mean', async () => {
    const vault = await openOsVault(host({ read: async () => legacy({ apiKey: KEY }) }));
    // The secret is still there and it belongs to nothing: no page call can place it, so it is refused at every address.
    expect(await vault.has(ID)).toBe(true);
    expect((await vault.read(ID))?.apiKey).toBe(KEY);
    expect(vault.originOf(ID)).toBeUndefined();
    expect(vault.keysFor(A)).toEqual([]);
    expect(await vault.readFor(A, [ID])).toBeUndefined();

    // The writer enters the key again for the endpoint the profile names, which is the one act that gives it an address.
    await vault.put(ID, { apiKey: KEY }, A);
    expect(vault.originOf(ID)).toBe(A);
    expect((await vault.readFor(A, [ID]))?.get(ID)?.apiKey).toBe(KEY);
  });

  it('refuses an address in the file that is not one a key may be stored for', async () => {
    const sealed = `sealed:${Buffer.from(JSON.stringify({ apiKey: KEY }), 'utf8').toString('base64')}`;
    const vault = await openOsVault(host({
      read: async () => JSON.stringify({ version: 2, entries: { [ID]: { sealed, origin: 'http://api.example.com' } } }),
    }));
    // Plain http is a loopback address's privilege, so this is no address at all and the key waits to be entered again.
    expect(vault.originOf(ID)).toBeUndefined();
    expect(await vault.readFor('http://api.example.com', [ID])).toBeUndefined();
  });
});

describe('a profile whose endpoint the writer moves', () => {
  /** The desktop's key store over the vault: what the settings form actually saves through. */
  async function store(): Promise<{ profiles: ReturnType<typeof createProfileStore>; keys: ReturnType<typeof nativeKeyStore>; vault: OsKeyVault }> {
    const vault = await openOsVault(host());
    const keys = nativeKeyStore(vault);
    return { profiles: createProfileStore({ keys }), keys, vault };
  }

  it('saves the key entered again for the new endpoint, and the id follows it', async () => {
    const { profiles, keys, vault } = await store();
    const created = await profiles.create({
      name: 'Moved', kind: 'endpoint', baseUrl: 'https://a.example/v1', apiKey: KEY, defaultModel: 'model-x',
    });
    expect(vault.originOf(created.id)).toBe(A);

    const moved = await profiles.update(created.id, { baseUrl: 'https://b.example/v1', apiKey: 'sk-entered-again' });
    expect(moved.baseUrl).toBe('https://b.example/v1');
    // The page is answered with the handle, and the vault holds the key the writer typed for the new endpoint at that endpoint.
    expect(await keys.reveal(created.id)).toBe(`caotang-key:${created.id}`);
    expect((await vault.read(created.id))?.apiKey).toBe('sk-entered-again');
    expect(vault.originOf(created.id)).toBe(B);
    expect(vault.keysFor(A)).toEqual([]);
  });

  it('still refuses to move a key the writer did not enter again', async () => {
    const { profiles, keys, vault } = await store();
    const created = await profiles.create({
      name: 'Kept', kind: 'endpoint', baseUrl: 'https://a.example/v1', apiKey: KEY, defaultModel: 'model-x',
    });
    await expect(profiles.update(created.id, { baseUrl: 'https://b.example/v1' })).rejects.toThrow(/Enter the API key again/u);
    expect(vault.originOf(created.id)).toBe(A);
    expect((await vault.read(created.id))?.apiKey).toBe(KEY);
    expect(await keys.reveal(created.id)).toBe(`caotang-key:${created.id}`);
  });
});
