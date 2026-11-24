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

  it('leaves a restored key with no address rather than the replacement one when its own cannot be written back', async () => {
    const saved: { text: string | undefined } = { text: undefined };
    let writes = 0;
    let failAt = Number.POSITIVE_INFINITY;
    const bindings = await openKeyBindings({
      read: async () => saved.text,
      write: async (text) => {
        writes += 1;
        if (writes === failAt) throw new Error('the bindings file could not be written');
        saved.text = text;
      },
    });
    const os = await openOsVault(host());
    const bound = openBoundKeyVault(os, bindings);
    await bound.put(ID, { apiKey: 'sk-at-a' }, A);
    await bound.putReplacement(ID, { apiKey: 'sk-at-b' }, B);

    // The restore hides the id, puts the older secret back, and then cannot write the address it belongs to.
    failAt = writes + 2;
    await expect(bound.restore(ID)).rejects.toThrow(/could not be written/u);
    // The older secret is back, and no address may carry it: not the one it was moved away from, and not the one it was moved to.
    expect((await os.read(ID))?.apiKey).toBe('sk-at-a');
    expect(bindings.originOf(ID)).toBeUndefined();
    expect(await bound.readFor(A, [ID])).toBeUndefined();
    expect(await bound.readFor(B, [ID])).toBeUndefined();
  });

  it('puts a removed key back at its own address, and never in reach of another one', async () => {
    const { os, bound, bindings } = await vault();
    await bound.put(ID, { apiKey: 'sk-first' }, A);
    await bound.put(ID, { apiKey: KEY }, A);
    await bound.remove(ID);
    expect(bindings.originOf(ID)).toBeUndefined();
    // Nothing is stored, so nothing may be sent with the id while the key is gone.
    expect(await bound.readFor(A, [ID])).toBeUndefined();

    await bound.restore(ID);
    expect((await os.read(ID))?.apiKey).toBe('sk-first');
    expect(bindings.originOf(ID)).toBe(A);
    expect(bindings.keysFor(B)).toEqual([]);
    expect((await bound.readFor(A, [ID]))?.get(ID)?.apiKey).toBe('sk-first');
    // The restored key belongs to A, so a request to B is answered with nothing rather than the older secret.
    expect(await bound.readFor(B, [ID])).toBeUndefined();
  });

  it('hides a key being replaced, so no request is answered with the older secret at the new address', async () => {
    let reached!: () => void;
    const started = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const sealing = new Promise<void>((resolve) => { release = resolve; });
    let seals = 0;
    const slow = await vault({
      seal: async (plain) => {
        seals += 1;
        // The first seal is the key being stored; the second is the replacement, and only that one is held open.
        if (seals === 2) {
          reached();
          await sealing;
        }
        return `sealed:${Buffer.from(plain, 'utf8').toString('base64')}`;
      },
    });
    await slow.bound.put(ID, { apiKey: 'sk-old' }, A);
    const replacing = slow.bound.putReplacement(ID, { apiKey: 'sk-new' }, B);
    // Halfway through the replacement: the id is bound to neither address, so a request to either one is refused rather than
    // answered with the key that was stored for the other.
    await started;
    expect(slow.bindings.keysFor(A)).toEqual([]);
    expect(slow.bindings.keysFor(B)).toEqual([]);

    release();
    await replacing;
    expect(slow.bindings.originOf(ID)).toBe(B);
    expect((await slow.bound.readFor(B, [ID]))?.get(ID)?.apiKey).toBe('sk-new');
    expect(await slow.bound.readFor(A, [ID])).toBeUndefined();
  });

  it('puts the key and its address back when the replacement cannot be placed', async () => {
    const saved: { text: string | undefined } = { text: undefined };
    let writes = 0;
    const bindings = await openKeyBindings({
      read: async () => saved.text,
      // The replacement's first write hides the id, and the second cannot be written: the transaction must undo itself.
      write: async (text) => {
        writes += 1;
        if (writes === 3) throw new Error('the bindings file could not be written');
        saved.text = text;
      },
    });
    const os = await openOsVault(host());
    const bound = openBoundKeyVault(os, bindings);
    await bound.put(ID, { apiKey: 'sk-old' }, A);
    await expect(bound.putReplacement(ID, { apiKey: 'sk-new' }, B)).rejects.toThrow(/could not be written/u);
    // The replaced key is back, with the address it was entered for, and the address the writer moved to carries nothing.
    expect((await os.read(ID))?.apiKey).toBe('sk-old');
    expect(bindings.originOf(ID)).toBe(A);
    expect(await bound.readFor(B, [ID])).toBeUndefined();
    expect((await bound.readFor(A, [ID]))?.get(ID)?.apiKey).toBe('sk-old');
  });

  it('stores a first key while the id has no address, so an interrupted save cannot place an older secret', async () => {
    const saved: { text: string | undefined } = { text: undefined };
    const bindings = await openKeyBindings({ read: async () => saved.text, write: async (text) => { saved.text = text; } });
    let failSeal = false;
    let seenAtSeal: string | undefined;
    const os = await openOsVault(host({
      seal: async (plain) => {
        if (failSeal) {
          // What the address record says while the new secret is being sealed: nothing may be sent with the id yet.
          seenAtSeal = bindings.originOf(ID);
          throw new Error('the seal failed');
        }
        return `sealed:${Buffer.from(plain, 'utf8').toString('base64')}`;
      },
    }));
    const bound = openBoundKeyVault(os, bindings);
    // A secret an earlier build left with no address, and the writer entering the key again for their endpoint.
    await os.put(ID, { apiKey: 'sk-legacy' });
    failSeal = true;
    await expect(bound.put(ID, { apiKey: 'sk-entered-again' }, A)).rejects.toThrow(/the seal failed/u);

    expect(seenAtSeal).toBeUndefined();
    expect(bindings.originOf(ID)).toBeUndefined();
    // The older secret is exactly where it was, and neither secret can be sent anywhere.
    expect((await os.read(ID))?.apiKey).toBe('sk-legacy');
    expect(await bound.readFor(A, [ID])).toBeUndefined();
  });

  it('puts back the right secret when a write after a replacement fails, so restore cannot send a B secret to A', async () => {
    const saved: { value: string | undefined } = { value: undefined };
    let failNext = false;
    const v = await vault({
      read: async () => saved.value,
      write: async (text) => {
        if (failNext) {
          failNext = false;
          throw new Error('the vault file could not be written');
        }
        saved.value = text;
      },
    });
    await v.bound.put(ID, { apiKey: 'sk-at-a' }, A);
    await v.bound.putReplacement(ID, { apiKey: 'sk-at-b' }, B);

    // A save for the address the key now has, whose write fails after the vault recorded what it would put back.
    failNext = true;
    await expect(v.bound.put(ID, { apiKey: 'sk-at-c' }, B)).rejects.toThrow(/the vault file could not be written/u);
    await v.bound.restore(ID);
    // The undo still names the key the replacement replaced, and the address it was entered for.
    expect((await v.os.read(ID))?.apiKey).toBe('sk-at-a');
    expect(v.bindings.originOf(ID)).toBe(A);
    expect(await v.bound.readFor(B, [ID])).toBeUndefined();
  });

  it('keeps the undo history aligned when a write is refused, so restore cannot pair an older secret with a later address', async () => {
    const { os, bound, bindings } = await vault();
    await bound.put(ID, { apiKey: 'sk-at-a' }, A);
    await bound.putReplacement(ID, { apiKey: 'sk-at-b' }, B);
    // A write for the address the key has left is refused and changes nothing about where the undo points.
    await expect(bound.put(ID, { apiKey: 'sk-refused' }, A)).rejects.toBeInstanceOf(KeyBoundElsewhere);
    expect(bindings.originOf(ID)).toBe(B);

    await bound.restore(ID);
    // The key the replacement replaced comes back at the address it was stored for, never at the one the refused write named.
    expect((await os.read(ID))?.apiKey).toBe('sk-at-a');
    expect(bindings.originOf(ID)).toBe(A);
    expect(await bound.readFor(B, [ID])).toBeUndefined();
  });

  it('refuses to read a key for an address other than the one it is bound to', async () => {
    const { bound, bindings } = await vault();
    await bound.put(ID, { apiKey: KEY }, A);
    expect(bindings.keysFor(A)).toEqual([ID]);
    expect(bindings.keysFor(B)).toEqual([]);
    expect(await bound.readFor(B, [ID])).toBeUndefined();
    expect(await bound.readFor(A, ['prv_NOTHINGSTORED'])).toBeUndefined();
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

describe('a key stored before the addresses were kept', () => {
  it('stays denied until the writer enters it again for the address they mean', async () => {
    const { os, bound, bindings } = await vault();
    // What an earlier build left: the secret in the vault, and no address anywhere.
    await os.put(ID, { apiKey: KEY });
    expect(bindings.originOf(ID)).toBeUndefined();
    // Nothing a page can call places it: an unaddressed key is refused at every address rather than open to a new one.
    expect(await bound.readFor(A, [ID])).toBeUndefined();
    expect(bindings.keysFor(A)).toEqual([]);

    // The writer enteres the key again for the endpoint the profile names, which is what gives it an address.
    await bound.put(ID, { apiKey: KEY }, A);
    expect(bindings.originOf(ID)).toBe(A);
    expect((await bound.readFor(A, [ID]))?.get(ID)?.apiKey).toBe(KEY);
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
