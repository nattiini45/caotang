/**
 * A host that unwraps a project key hands the code that opens the project's files the *imported* form: a non-extractable
 * HKDF key. Everything derived from it must be identical to what the key's own bytes derive — the same file keys, the
 * same path hashes, the same seals — and the key itself must not be exportable.
 */
import { describe, expect, it } from 'vitest';
import { CryptoError, SecretKey, deriveSubkey, hashPath, importProjectKey, openFile, openManifest, sealFile, sealManifest } from '../src/index.js';

const project = (): SecretKey => new SecretKey('project', Uint8Array.from({ length: 32 }, (_, index) => index + 1));
const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const file = { projectId: 'p_LIGHTHOUSE', pathHash: 'abc123', version: 4 };
const manifest = { projectId: 'p_LIGHTHOUSE', version: 7 };

describe('an imported project key', () => {
  it('cannot be exported, and derives exactly what the key\'s bytes derive', async () => {
    const key = project();
    const imported = await importProjectKey(key);

    expect(imported.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey('raw', imported)).rejects.toBeTruthy();

    for (const purpose of ['file', 'path', 'manifest', 'name'] as const) {
      expect(hex(await deriveSubkey(imported, purpose))).toBe(hex(await deriveSubkey(key, purpose)));
    }
    expect(hex(await deriveSubkey(imported, 'file', 'h1'))).toBe(hex(await deriveSubkey(key, 'file', 'h1')));
    expect(await hashPath(imported, 'docs/n_3W8RN2TQ6C.md')).toBe(await hashPath(key, 'docs/n_3W8RN2TQ6C.md'));
  });

  it('opens what the key\'s bytes sealed, and the reverse', async () => {
    const key = project();
    const imported = await importProjectKey(key);
    const text = new TextEncoder().encode('The lighthouse kept its own hours.');

    const sealedByKey = await sealFile(key, file, text);
    expect(new TextDecoder().decode(await openFile(imported, file, sealedByKey))).toBe('The lighthouse kept its own hours.');

    const sealedByImport = await sealFile(imported, file, text);
    expect(new TextDecoder().decode(await openFile(key, file, sealedByImport))).toBe('The lighthouse kept its own hours.');

    const sealedManifest = await sealManifest(imported, manifest, new TextEncoder().encode('{"format":1}'));
    expect(new TextDecoder().decode(await openManifest(key, manifest, sealedManifest))).toBe('{"format":1}');
  });

  it('refuses another project\'s key and another project id', async () => {
    const imported = await importProjectKey(project());
    const sealed = await sealFile(imported, file, new TextEncoder().encode('x'));
    const other = await importProjectKey(new SecretKey('project', new Uint8Array(32).fill(9)));

    await expect(openFile(other, file, sealed)).rejects.toMatchObject({ code: 'unauthentic' });
    await expect(openFile(imported, { ...file, projectId: 'p_OTHER' }, sealed)).rejects.toMatchObject({ code: 'unauthentic' });
    expect(sealed).toBeInstanceOf(Uint8Array);
  });

  it('still refuses a key of the wrong role by its bytes, because the role check is on the key it was made from', async () => {
    await expect(importProjectKey(new SecretKey('master', new Uint8Array(32)))).rejects.toBeInstanceOf(CryptoError);
  });
});
