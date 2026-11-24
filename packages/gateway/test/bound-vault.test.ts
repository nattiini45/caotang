/**
 * The keychain with each secret's address kept beside it — desktop.md §The keychain, #864. The vault's own seal and file are
 * `os-vault.test.ts`; what is proved here is the rule above them: a key belongs to one address, a page cannot move one, the
 * undo of a write puts back the address with the secret, and a key stored before the pairings existed gets exactly the address
 * its profile names.
 */

import { describe, expect, it } from 'vitest';
import { openBoundKeyVault } from '../src/keys/bound-vault.js';
import { KeyBoundElsewhere, openKeyBindings } from '../src/keys/key-bindings.js';
import { openOsVault, type OsKeyVault, type OsVaultHost } from '../src/keys/os-vault.js';
import { nativeKeyStore } from '../src/keys/native-store.js';
import { createProfileStore } from '../src/profiles.js';

const ID = 'prv_ABCDEFGHJK';
const TOKEN = 'mcp:one-token';
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
    open: async (sealed) => Buffer.from(sealed.slice('sealed:'.length), 'base64').toString('utf8'),
    ...overrides,
  };
  return made;
}

async function vault(overrides: Partial<OsVaultHost> = {}): Promise<{ os: OsKeyVault; bound: ReturnType<typeof openBoundKeyVault>; bindings: Awaited<ReturnType<typeof openKeyBindings>> }> {
  const saved: { text: string | undefined } = { text: undefined };
  const bindings = await openKeyBindings({
    read: async () => saved.text,
    write: async (text) => { saved.text = text; },
  });
  const os = await openOsVault(host(overrides));
  return { os, bound: openBoundKeyVault(os, bindings), bindings };
}

describe('a key belongs to one address', () => {
  it('stores a key for the address it was entered for, and refuses a second address', async () => {
    const { os, bound, bindings } = await vault();
    await bound.put(ID, { apiKey: KEY }, A);
    expect(bindings.originOf(ID)).toBe(A);
    expect(bindings.keysFor(A)).toEqual([ID]);

    await expect(bound.put(ID, { apiKey: 'sk-other' }, B)).rejects.toBeInstanceOf(KeyBoundElsewhere);
    // The refusal changed nothing: the key and its address are the ones the writer entered.
    expect(bindings.originOf(ID)).toBe(A);
    expect((await os.read(ID))?.apiKey).toBe(KEY);
  });

  it('moves an id to the address of the key a writer typed again for a changed endpoint', async () => {
    const { os, bound, bindings } = await vault();
    await bound.put(ID, { apiKey: KEY }, A);
    await bound.putReplacement(ID, { apiKey: 'sk-typed-again' }, B);
    expect(bindings.originOf(ID)).toBe(B);
    expect(bindings.keysFor(A)).toEqual([]);
    expect(bindings.keysFor(B)).toEqual([ID]);
    expect((await os.read(ID))?.apiKey).toBe('sk-typed-again');
  });

  it('puts the address back, not only the secret, when the writer’s replacement is undone', async () => {
    const { os, bound, bindings } = await vault();
    await bound.put(ID, { apiKey: KEY }, A);
    await bound.putReplacement(ID, { apiKey: 'sk-typed-again' }, B);
    await bound.restore(ID);
    // The old key is back, and only at the address the writer entered it for: the undo cannot carry it to the new endpoint.
    expect((await os.read(ID))?.apiKey).toBe(KEY);
    expect(bindings.originOf(ID)).toBe(A);
    expect(bindings.keysFor(B)).toEqual([]);
  });

  it('puts a removed key back at its own address, and never in reach of another one', async () => {
    const { os, bound, bindings } = await vault();
    await bound.put(ID, { apiKey: 'sk-first' }, A);
    await bound.put(ID, { apiKey: KEY }, A);
    await bound.remove(ID);
    expect(bindings.originOf(ID)).toBeUndefined();
    // Nothing is stored, so nothing is bound while the key is gone.
    expect(await bound.bind(ID, B)).toBe(false);

    await bound.restore(ID);
    expect((await os.read(ID))?.apiKey).toBe('sk-first');
    expect(bindings.originOf(ID)).toBe(A);
    expect(bindings.keysFor(B)).toEqual([]);
    // A restored key is placed, so the upgrade path cannot move it either.
    expect(await bound.bind(ID, B)).toBe(false);
    expect(bindings.originOf(ID)).toBe(A);
  });

  it('undoes a headers edit with the key and its address intact', async () => {
    const { bound, bindings } = await vault();
    await bound.put(ID, { apiKey: KEY, customHeaders: { 'x-team': 'one' } }, A);
    await bound.putHeaders(ID, { 'x-team': 'two' });
    await bound.restore(ID);
    expect(await bound.headers(ID)).toEqual({ 'x-team': 'one' });
    expect(bindings.originOf(ID)).toBe(A);
  });

  it('puts the address back when the seal itself fails after the address was recorded', async () => {
    const { bound, bindings } = await vault({ available: async () => false });
    await expect(bound.put(ID, { apiKey: KEY }, A)).rejects.toThrow(/not available/u);
    // A key that was not stored leaves no address behind: a later save may use the id for the address it was entered for.
    expect(bindings.originOf(ID)).toBeUndefined();
    expect(bindings.keysFor(A)).toEqual([]);
  });
});

describe('the upgrade for a key stored before the pairings existed', () => {
  it('gives a held key the address its profile names, once', async () => {
    const { os, bound, bindings } = await vault();
    // What an earlier build left: the secret in the vault, and no address anywhere.
    await os.put(ID, { apiKey: KEY });
    expect(await bound.bind(ID, A)).toBe(true);
    expect(bindings.originOf(ID)).toBe(A);
    expect(bindings.keysFor(A)).toEqual([ID]);
    // A placed key is an ordinary key: the upgrade cannot move it afterwards.
    expect(await bound.bind(ID, B)).toBe(false);
    expect(bindings.originOf(ID)).toBe(A);
  });

  it('places nothing for an id the vault does not hold', async () => {
    const { bound, bindings } = await vault();
    expect(await bound.bind(ID, A)).toBe(false);
    expect(bindings.originOf(ID)).toBeUndefined();
  });
});

describe('the file the pairings are kept in', () => {
  it('reads what an earlier run recorded, and writes each change through', async () => {
    const saved: { text: string | undefined } = { text: undefined };
    const bindings = await openKeyBindings({ read: async () => saved.text, write: async (text) => { saved.text = text; } });
    await bindings.bind(ID, A);
    await bindings.bind(TOKEN, A);

    const reopened = await openKeyBindings({ read: async () => saved.text, write: async () => undefined });
    expect(reopened.originOf(ID)).toBe(A);
    expect(reopened.keysFor(A)).toEqual([ID, TOKEN]);
    expect(saved.text).not.toContain('secret');
  });

  it('refuses to bind an id already bound to another address, and writes nothing for the same one', async () => {
    let writes = 0;
    const bindings = await openKeyBindings({ read: async () => undefined, write: async () => { writes += 1; } });
    await bindings.bind(ID, A);
    await bindings.bind(ID, A);
    expect(writes).toBe(1);
    await expect(bindings.bind(ID, B)).rejects.toBeInstanceOf(KeyBoundElsewhere);
    expect(bindings.originOf(ID)).toBe(A);
  });

  it('settles two saves of one id at once: one address wins and the other is refused', async () => {
    const bindings = await openKeyBindings({ read: async () => undefined, write: async () => undefined });
    const results = await Promise.allSettled([bindings.bind(ID, A), bindings.bind(ID, B)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect([A, B]).toContain(bindings.originOf(ID));
  });

  it('frees an id when its address is forgotten, and reads a damaged file as no addresses at all', async () => {
    const saved: { text: string | undefined } = { text: undefined };
    const bindings = await openKeyBindings({ read: async () => saved.text, write: async (text) => { saved.text = text; } });
    await bindings.bind(ID, A);
    await bindings.forget(ID);
    expect(bindings.originOf(ID)).toBeUndefined();

    const damaged = await openKeyBindings({ read: async () => '{"version":1,"bindings":', write: async () => undefined });
    expect(damaged.keysFor(A)).toEqual([]);
  });

  it('keeps an entry that could not be a vault id out of the file it reads', async () => {
    const saved = JSON.stringify({ version: 1, bindings: { '../escape': A, [ID]: A } });
    const bindings = await openKeyBindings({ read: async () => saved, write: async () => undefined });
    expect(bindings.keysFor(A)).toEqual([ID]);
  });
});

describe('a profile whose endpoint the writer moves', () => {
  /** The desktop's key store over the bound vault: what the settings form actually saves through. */
  async function store() {
    const { os, bound, bindings } = await vault();
    const keys = nativeKeyStore({
      available: async () => true,
      put: bound.put,
      putReplacement: bound.putReplacement,
      putHeaders: bound.putHeaders,
      headers: bound.headers,
      revision: bound.revision,
      has: bound.has,
      remove: bound.remove,
      restore: bound.restore,
    });
    return { profiles: createProfileStore({ keys }), keys, bindings, os };
  }

  it('saves the key entered again for the new endpoint, and the id follows it', async () => {
    const { profiles, keys, bindings, os } = await store();
    const created = await profiles.create({
      name: 'Moved', kind: 'endpoint', baseUrl: 'https://a.example/v1', apiKey: KEY, defaultModel: 'model-x',
    });
    expect(bindings.originOf(created.id)).toBe(A);

    const moved = await profiles.update(created.id, { baseUrl: 'https://b.example/v1', apiKey: 'sk-entered-again' });
    expect(moved.baseUrl).toBe('https://b.example/v1');
    // The page is answered with the handle, and the host holds the key the writer typed for the new endpoint.
    expect(await keys.reveal(created.id)).toBe(`caotang-key:${created.id}`);
    expect((await os.read(created.id))?.apiKey).toBe('sk-entered-again');
    expect(bindings.originOf(created.id)).toBe(B);
    expect(bindings.keysFor(A)).toEqual([]);
  });

  it('still refuses to move a key the writer did not enter again', async () => {
    const { profiles, keys, bindings, os } = await store();
    const created = await profiles.create({
      name: 'Kept', kind: 'endpoint', baseUrl: 'https://a.example/v1', apiKey: KEY, defaultModel: 'model-x',
    });
    await expect(profiles.update(created.id, { baseUrl: 'https://b.example/v1' })).rejects.toThrow(/Enter the API key again/u);
    expect(bindings.originOf(created.id)).toBe(A);
    expect((await os.read(created.id))?.apiKey).toBe(KEY);
    expect(await keys.reveal(created.id)).toBe(`caotang-key:${created.id}`);
  });
});
