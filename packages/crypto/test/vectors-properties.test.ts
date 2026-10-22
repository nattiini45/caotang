/**
 * Fixed vectors and property loops. The vectors recompute each value with `node:crypto`, an implementation that
 * shares no code with the package, so the format is pinned by two readings and not by itself.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  INFO_LABELS,
  SecretKey,
  decodeRecoveryKey,
  deriveKek,
  deriveSubkey,
  encodeRecoveryKey,
  generateMasterKey,
  generateProjectKey,
  generateSalt,
  hashPath,
  openFile,
  openManifest,
  paddedLength,
  sealFile,
  sealManifest,
  unwrapMasterKey,
  wrapMasterKey,
} from '../src/index.js';
import { fastKdf, fixedRandom, seeded, seededBytes } from './helpers.js';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
/** The project key 00 01 02 .. 1f. */
const project = new SecretKey('project', Uint8Array.from({ length: 32 }, (_, i) => i));

function nodeHkdf(info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(project.export()), Buffer.alloc(0), Buffer.from(info), 32));
}

/** An independent Crockford base32 encoder (big-integer arithmetic, not the package's bit buffer). */
function crockford(raw: Buffer): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bits = raw.length * 8;
  const chars = Math.ceil(bits / 5);
  let n = BigInt(`0x${raw.toString('hex')}`) << BigInt(chars * 5 - bits);
  let out = '';
  for (let i = 0; i < chars; i++) {
    out = alphabet[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

const mac = (key: Buffer, message: string): Buffer => createHmac('sha256', key).update(message).digest();

describe('fixed vectors', () => {
  it('derives the file, path and manifest keys as HKDF-SHA-256 with their own info labels', async () => {
    expect(Object.values(INFO_LABELS)).toEqual(['caotang/v1/file-key', 'caotang/v1/path-hmac-key', 'caotang/v1/manifest-key']);
    expect(hex(await deriveSubkey(project, 'path'))).toBe(hex(nodeHkdf('caotang/v1/path-hmac-key')));
    expect(hex(await deriveSubkey(project, 'manifest'))).toBe(hex(nodeHkdf('caotang/v1/manifest-key')));
    expect(hex(await deriveSubkey(project, 'file', 'h1'))).toBe(hex(nodeHkdf('caotang/v1/file-key\0h1')));
  });

  it('pins the path key for the project key 00 01 02 .. 1f', async () => {
    expect(hex(await deriveSubkey(project, 'path'))).toBe('5b33d432837c1df2696143c75dfa65a8a5cece6fea8c46187c3938d2ac2bf8fe');
  });

  it('hashes a path as base32 of HMAC-SHA-256 under the path key', async () => {
    const pathKey = nodeHkdf('caotang/v1/path-hmac-key');
    const hash = await hashPath(project, 'docs/n_3W8RN2TQ6C.md');
    expect(hash).toBe(crockford(mac(pathKey, 'path\0docs/n_3W8RN2TQ6C.md')).toLowerCase());
    expect(hash).toBe('79cwcrht1pjajzr604qms7ezdnm5myg2bqsjs5kvnvxkrj4xb8cg');
  });

  it('seals a file as tag, nonce, then AES-256-GCM over the framed and padded content, bound to the NUL-joined associated data', async () => {
    const ctx = { projectId: 'p_ONE', pathHash: 'h1', version: 7 };
    const plain = new TextEncoder().encode('hello');
    const sealed = await sealFile(project, ctx, plain, fixedRandom(9));

    const framed = Buffer.alloc(256);
    framed.writeUInt32BE(5, 0);
    framed.set(plain, 4);
    const cipher = createCipheriv('aes-256-gcm', nodeHkdf('caotang/v1/file-key\0h1'), Buffer.alloc(12, 9));
    cipher.setAAD(Buffer.from('caotang/v1/file\0p_ONE\0h1\x007'));
    const expected = Buffer.concat([Buffer.of(1), Buffer.alloc(12, 9), cipher.update(framed), cipher.final(), cipher.getAuthTag()]);

    expect(sealed).toHaveLength(1 + 12 + 256 + 16);
    expect(hex(sealed)).toBe(hex(expected));
  });

  it('opens a value that node:crypto sealed to the same format', async () => {
    const framed = Buffer.alloc(256);
    framed.writeUInt32BE(3, 0);
    framed.set(Buffer.from('abc'), 4);
    const nonce = Buffer.alloc(12, 5);
    const cipher = createCipheriv('aes-256-gcm', nodeHkdf('caotang/v1/file-key\0h1'), nonce);
    cipher.setAAD(Buffer.from('caotang/v1/file\0p_ONE\0h1\x001'));
    const sealed = Buffer.concat([Buffer.of(1), nonce, cipher.update(framed), cipher.final(), cipher.getAuthTag()]);

    const opened = await openFile(project, { projectId: 'p_ONE', pathHash: 'h1', version: 1 }, new Uint8Array(sealed));
    expect(new TextDecoder().decode(opened)).toBe('abc');
  });

  it('seals a manifest under the manifest key with its own associated data', async () => {
    const ctx = { projectId: 'p_ONE', version: 4 };
    const sealed = await sealManifest(project, ctx, new Uint8Array([1, 2, 3]), fixedRandom(1));
    const decipher = createDecipheriv('aes-256-gcm', nodeHkdf('caotang/v1/manifest-key'), Buffer.from(sealed.subarray(1, 13)));
    decipher.setAAD(Buffer.from('caotang/v1/manifest\0p_ONE\x004'));
    decipher.setAuthTag(Buffer.from(sealed.subarray(sealed.length - 16)));
    const framed = Buffer.concat([decipher.update(sealed.subarray(13, sealed.length - 16)), decipher.final()]);
    expect(framed.readUInt32BE(0)).toBe(3);
    expect([...framed.subarray(4, 7)]).toEqual([1, 2, 3]);
    expect(await openManifest(project, ctx, sealed)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('encodes the recovery key as base32 of version, key and the first four bytes of its SHA-256 checksum', async () => {
    const master = new SecretKey('master', Uint8Array.from({ length: 32 }, (_, i) => 255 - i));
    const check = createHash('sha256')
      .update(Buffer.concat([Buffer.from('caotang/v1/recovery'), Buffer.of(1), Buffer.from(master.export())]))
      .digest()
      .subarray(0, 4);
    const text = await encodeRecoveryKey(master);
    expect(text.replaceAll('-', '')).toBe(crockford(Buffer.concat([Buffer.of(1), Buffer.from(master.export()), check])));
    expect(text).toBe('07ZZX-ZFWZF-XFKY7-QYVTZ-9WZJY-7REZV-QDXKN-YNTF8-WZKEB-S73WB-GY0TJ-XZ3E0');
  });
});

describe('property loops (seeded)', () => {
  it('round-trips random content, paths and versions, and refuses every wrong context', async () => {
    const next = seeded(20261022);
    const key = generateProjectKey();
    for (let i = 0; i < 60; i++) {
      const plain = seededBytes(next, Math.floor(next() * next() * 3000));
      const ctx = { projectId: `p_${i}`, pathHash: await hashPath(key, `docs/${i}.md`), version: Math.floor(next() * 1000) };
      const sealed = await sealFile(key, ctx, plain);
      expect(await openFile(key, ctx, sealed)).toEqual(plain);
      await expect(openFile(key, { ...ctx, version: ctx.version + 1 }, sealed)).rejects.toBeInstanceOf(Error);
      await expect(openFile(generateProjectKey(), ctx, sealed)).rejects.toBeInstanceOf(Error);
      const altered = sealed.slice();
      const at = Math.floor(next() * altered.length);
      altered[at] = (altered[at] ?? 0) ^ (1 + Math.floor(next() * 255));
      await expect(openFile(key, ctx, altered)).rejects.toBeInstanceOf(Error);
    }
  });

  it('never pads below the content and keeps the padded length monotonic', () => {
    let previous = 0;
    for (let n = 0; n < 5000; n++) {
      const size = paddedLength(n);
      expect(size).toBeGreaterThanOrEqual(n);
      expect(size).toBeGreaterThanOrEqual(previous);
      previous = size;
    }
  });

  it('round-trips random master keys through the recovery key and the passphrase wrap', async () => {
    const next = seeded(7);
    for (let i = 0; i < 20; i++) {
      const master = new SecretKey('master', seededBytes(next, 32));
      expect((await decodeRecoveryKey(await encodeRecoveryKey(master))).export()).toEqual(master.export());
      const kek = await deriveKek(fastKdf, `passphrase ${i}`, generateSalt());
      expect((await unwrapMasterKey(kek, await wrapMasterKey(kek, master))).export()).toEqual(master.export());
    }
    expect(generateMasterKey().export()).not.toEqual(generateMasterKey().export());
  });
});
