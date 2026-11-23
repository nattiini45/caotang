/**
 * The sealed provider-key vault: two seals for two different mistakes. The vault as a whole is bound to the account and
 * the version the server holds, so a replay or a vault moved to another account fails to open; each profile entry is
 * bound to its account, profile id and endpoint origin, so a key cannot be read as another profile's or as the same
 * provider at another address. Nothing here learns what a provider key is.
 */
import { describe, expect, it } from 'vitest';
import { FORMAT_TAG } from '../src/aead.js';
import {
  CryptoError,
  SecretKey,
  importVaultKey,
  openVault,
  openVaultEntry,
  openVaultEntryWith,
  openVaultWith,
  sealVault,
  sealVaultEntry,
  sealVaultEntryWith,
  sealVaultWith,
  sealedVaultLength,
  VAULT_FORMAT_TAG,
} from '../src/index.js';

const master = (): SecretKey => new SecretKey('master', new Uint8Array(32).fill(5));
const project = (): SecretKey => new SecretKey('project', new Uint8Array(32).fill(6));

async function rejected(action: Promise<unknown>): Promise<string> {
  try {
    await action;
    return 'opened';
  } catch (error) {
    return error instanceof CryptoError ? error.code : `other: ${String(error)}`;
  }
}

const entry = (fill = 1): Uint8Array => new TextEncoder().encode(JSON.stringify({ v: 2, apiKey: `key-${fill}`, headers: { 'x-note': fill } }));
const vaultContext = { accountId: '00000000-0000-4000-8000-000000000001', version: 3 };
const entryContext = { accountId: vaultContext.accountId, profileId: 'profile-a', origin: 'https://api.example.test' };

describe('a profile entry in the vault', () => {
  it('round-trips under the vault key, and looks like nothing else the server stores', async () => {
    const plain = entry();
    const sealed = await sealVaultEntry(master(), entryContext, plain);
    expect(sealed[0]).toBe(VAULT_FORMAT_TAG);
    expect(sealed.length).toBe(1 + 12 + plain.length + 16);
    expect(new TextDecoder().decode(await openVaultEntry(master(), entryContext, sealed))).toBe(new TextDecoder().decode(plain));
    expect(new TextDecoder().decode(sealed)).not.toContain('key-1');
  });

  it('refuses another profile, another origin, another account, another key and an altered byte', async () => {
    const sealed = await sealVaultEntry(master(), entryContext, entry());
    expect(await rejected(openVaultEntry(master(), { ...entryContext, profileId: 'profile-b' }, sealed))).toBe('unauthentic');
    expect(await rejected(openVaultEntry(master(), { ...entryContext, origin: 'https://api.elsewhere.test' }, sealed))).toBe('unauthentic');
    expect(await rejected(openVaultEntry(master(), { ...entryContext, accountId: '00000000-0000-4000-8000-000000000002' }, sealed))).toBe('unauthentic');
    expect(await rejected(openVaultEntry(new SecretKey('master', new Uint8Array(32).fill(7)), entryContext, sealed))).toBe('unauthentic');
    const altered = sealed.slice();
    altered[altered.length - 1] = (altered[altered.length - 1] ?? 0) ^ 1;
    expect(await rejected(openVaultEntry(master(), entryContext, altered))).toBe('unauthentic');
  });

  it('refuses the project key and a file sealed under it, so a vault key is never a project subkey', async () => {
    const entryUnderProject = await rejected(sealVaultEntry(project(), entryContext, entry()));
    expect(entryUnderProject).toBe('invalid-argument');
    const sealed = await sealVaultEntry(master(), entryContext, entry());
    expect(sealed[0]).not.toBe(FORMAT_TAG);
    const other = await sealVaultEntry(master(), entryContext, entry());
    expect(sealed).not.toEqual(other);
  });

  it('gives every seal its own nonce', async () => {
    const plain = entry();
    const first = await sealVaultEntry(master(), entryContext, plain);
    const second = await sealVaultEntry(master(), entryContext, plain);
    expect(first.slice(1, 13)).not.toEqual(second.slice(1, 13));
    expect(first).not.toEqual(second);
  });
});

describe('the vault as the server holds it', () => {
  it('round-trips at one version and refuses another version, another account or altered bytes', async () => {
    const plain = new TextEncoder().encode('{"profiles":[{"id":"profile-a"}]}');
    const sealed = await sealVault(master(), vaultContext, plain);
    expect(sealed[0]).toBe(VAULT_FORMAT_TAG);
    expect(new TextDecoder().decode(await openVault(master(), vaultContext, sealed))).toBe(new TextDecoder().decode(plain));
    expect(await rejected(openVault(master(), { ...vaultContext, version: 4 }, sealed))).toBe('unauthentic');
    expect(await rejected(openVault(master(), { ...vaultContext, accountId: '00000000-0000-4000-8000-000000000009' }, sealed))).toBe('unauthentic');
    const altered = sealed.slice();
    altered[1] = (altered[1] ?? 0) ^ 1;
    expect(await rejected(openVault(master(), vaultContext, altered))).toBe('unauthentic');
  });

  it('refuses a version that is not a positive integer, and a context field holding a NUL', async () => {
    const plain = new Uint8Array(4);
    expect(await rejected(sealVault(master(), { ...vaultContext, version: 0 }, plain))).toBe('invalid-argument');
    expect(await rejected(sealVault(master(), { ...vaultContext, accountId: 'a\0b' }, plain))).toBe('invalid-argument');
    expect(await rejected(sealVaultEntry(master(), { ...entryContext, origin: 'https://a\0.test' }, plain))).toBe('invalid-argument');
  });

  it('refuses a value sealed as a file, so the formats cannot be confused', async () => {
    const fileish = new Uint8Array(1 + 12 + 16);
    fileish[0] = 1;
    expect(await rejected(openVault(master(), vaultContext, fileish))).toBe('bad-format');
    expect(await rejected(openVaultEntry(master(), entryContext, fileish))).toBe('bad-format');
  });

  it('reports the size the server will store, which is the seal overhead plus the plaintext', async () => {
    const plain = new Uint8Array(700);
    const sealed = await sealVault(master(), vaultContext, plain);
    expect(sealed.length).toBe(sealedVaultLength(plain.length));
  });

  it('seals and opens the same vault through the imported key, which the holder cannot export', async () => {
    const key = await importVaultKey(master());
    const plain = new Uint8Array([1, 2, 3, 4]);
    const sealed = await sealVaultWith(key, vaultContext, plain);
    expect(Array.from(await openVaultWith(key, vaultContext, sealed))).toEqual([1, 2, 3, 4]);
    expect(Array.from(await openVault(master(), vaultContext, sealed))).toEqual([1, 2, 3, 4]);

    const entry = await sealVaultEntryWith(key, entryContext, plain);
    expect(Array.from(await openVaultEntryWith(key, entryContext, entry))).toEqual([1, 2, 3, 4]);

    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('binds the imported key the same way, to the account, the version, the profile and the origin', async () => {
    const key = await importVaultKey(master());
    const other = await importVaultKey(new SecretKey('master', new Uint8Array(32).fill(6)));
    const sealed = await sealVaultWith(key, vaultContext, new Uint8Array(4));
    expect(await rejected(openVaultWith(other, vaultContext, sealed))).toBe('unauthentic');
    expect(await rejected(openVaultWith(key, { ...vaultContext, version: vaultContext.version + 1 }, sealed))).toBe('unauthentic');
    expect(await rejected(openVaultWith(key, { ...vaultContext, accountId: 'another-account' }, sealed))).toBe('unauthentic');

    const entry = await sealVaultEntryWith(key, entryContext, new Uint8Array(4));
    expect(await rejected(openVaultEntryWith(key, { ...entryContext, origin: 'https://other.test' }, entry))).toBe('unauthentic');
  });
});
