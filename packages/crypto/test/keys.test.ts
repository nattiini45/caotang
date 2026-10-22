import { describe, expect, it } from 'vitest';
import {
  CryptoError,
  SecretKey,
  deriveKek,
  deriveSubkey,
  generateMasterKey,
  generateProjectKey,
  generateSalt,
  unwrapMasterKey,
  unwrapProjectKey,
  wrapMasterKey,
  wrapProjectKey,
} from '../src/index.js';
import { fastKdf } from './helpers.js';

async function refused(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'CryptoError', code });
}

describe('the key hierarchy', () => {
  it('passphrase, KEK, master key and project key round-trip', async () => {
    const salt = generateSalt();
    const kek = await deriveKek(fastKdf, 'correct horse battery staple', salt);
    const master = generateMasterKey();
    const project = generateProjectKey();

    const wrappedMaster = await wrapMasterKey(kek, master);
    const wrappedProject = await wrapProjectKey(master, project, 'p_ONE');

    const kek2 = await deriveKek(fastKdf, 'correct horse battery staple', salt);
    const master2 = await unwrapMasterKey(kek2, wrappedMaster);
    expect(master2.export()).toEqual(master.export());
    expect((await unwrapProjectKey(master2, wrappedProject, 'p_ONE')).export()).toEqual(project.export());
  });

  it('refuses a wrong passphrase and a wrong salt', async () => {
    const salt = generateSalt();
    const wrapped = await wrapMasterKey(await deriveKek(fastKdf, 'one passphrase', salt), generateMasterKey());

    await refused(unwrapMasterKey(await deriveKek(fastKdf, 'another passphrase', salt), wrapped), 'unauthentic');
    await refused(unwrapMasterKey(await deriveKek(fastKdf, 'one passphrase', generateSalt()), wrapped), 'unauthentic');
  });

  it('normalises the passphrase, so the same word typed two ways is one key', async () => {
    const salt = generateSalt();
    const composed = await deriveKek(fastKdf, 'café au lait', salt);
    const decomposed = await deriveKek(fastKdf, 'café au lait', salt);
    expect(decomposed.export()).toEqual(composed.export());
  });

  it('refuses an empty passphrase and a short salt', async () => {
    await refused(deriveKek(fastKdf, '', generateSalt()), 'invalid-argument');
    await refused(deriveKek(fastKdf, 'x', new Uint8Array(8)), 'invalid-argument');
  });

  it('binds a wrapped project key to its project id', async () => {
    const master = generateMasterKey();
    const wrapped = await wrapProjectKey(master, generateProjectKey(), 'p_ONE');
    await refused(unwrapProjectKey(master, wrapped, 'p_TWO'), 'unauthentic');
    await refused(unwrapProjectKey(generateMasterKey(), wrapped, 'p_ONE'), 'unauthentic');
  });

  it('refuses a key in the wrong role', async () => {
    const kek = await deriveKek(fastKdf, 'a passphrase', generateSalt());
    await expect(Promise.resolve().then(() => wrapMasterKey(kek, generateProjectKey()))).rejects.toThrow(CryptoError);
    await expect(Promise.resolve().then(() => wrapProjectKey(kek, generateProjectKey(), 'p_ONE'))).rejects.toThrow(CryptoError);
    expect(() => new SecretKey('master', new Uint8Array(31))).toThrow(CryptoError);
  });

  it('does not print its bytes', () => {
    const key = generateMasterKey();
    expect(JSON.stringify({ key })).toBe('{"key":"[master key]"}');
    expect(`${key}`).toBe('[master key]');
  });
});

describe('domain separation', () => {
  it('derives a different key for files, paths and the manifest from one project key', async () => {
    const project = generateProjectKey();
    const keys = [await deriveSubkey(project, 'file', 'abc'), await deriveSubkey(project, 'path'), await deriveSubkey(project, 'manifest')];
    expect(new Set(keys.map((key) => Buffer.from(key).toString('hex'))).size).toBe(3);
  });

  it('derives a different file key per path hash and per project key, and the same one twice', async () => {
    const project = generateProjectKey();
    const a = await deriveSubkey(project, 'file', 'abc');
    expect(await deriveSubkey(project, 'file', 'abc')).toEqual(a);
    expect(await deriveSubkey(project, 'file', 'abd')).not.toEqual(a);
    expect(await deriveSubkey(generateProjectKey(), 'file', 'abc')).not.toEqual(a);
  });
});
