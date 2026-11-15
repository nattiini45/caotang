/**
 * The Argon2id adapter and its known-answer tests. The RFC 9106 vectors run through the independent reference
 * (hash-wasm has no associated-data input, so it cannot reproduce them); hash-wasm is then cross-checked against
 * that reference in the no-secret, no-associated-data mode the adapter actually uses.
 */
import { argon2id } from 'hash-wasm';
import { describe, expect, it } from 'vitest';
import {
  ARGON2ID_DEFAULT,
  ARGON2ID_ID,
  argon2idDescriptor,
  createArgon2idKdf,
  resolveArgon2idKdf,
} from '../src/index.js';
import { argon2Reference } from './argon2-reference.js';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const fill = (n: number, byte: number): Uint8Array => new Uint8Array(n).fill(byte);

/** RFC 9106 §5: password 32×01, salt 16×02, secret 8×03, associated data 12×04, p=4, t=3, m=32 KiB, tag 32. */
const rfcInput = { password: fill(32, 1), salt: fill(16, 2), secret: fill(8, 3), ad: fill(12, 4), p: 4, t: 3, m: 32, tagLength: 32 };

describe('RFC 9106 known-answer vectors (independent reference)', () => {
  it('reproduces the §5.3 Argon2id pre-hash H_0 and tag', () => {
    const { H0, tag } = argon2Reference({ ...rfcInput, type: 2 });
    expect(hex(H0)).toBe('2889de487eb42ae500c0007ed9252f1069eadec40d5765b485de6dc2437a67b8546a2f0acc1a0882db8fcf74714b472e94df421a5da1112ffa11434370a1e997');
    expect(hex(tag)).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  });

  it('reproduces the §5.2 Argon2i vector', () => {
    const { H0, tag } = argon2Reference({ ...rfcInput, type: 1 });
    expect(hex(H0)).toBe('c46065815276a0b3e731731c902f1fd80cf776907fbb7b6a5ca72e7b56011feeca446c86dd75b9469a5e6879dec4b72d0863fb939b982e5f397cc7d164fddaa9');
    expect(hex(tag)).toBe('c814d9d1dc7f37aa13f0d77f2494bda1c8de6b016dd388d29952a4c4672b6ce8');
  });

  it('reproduces the §5.1 Argon2d vector', () => {
    const { H0, tag } = argon2Reference({ ...rfcInput, type: 0 });
    expect(hex(H0)).toBe('b8819791a0359660bb7709c85fa48f04d5d82c05c5f215ccdb885491717cf757082c28b951be381410b5fc2eb7274033b9fdc7ae672bcaac5d179097a4af3109');
    expect(hex(tag)).toBe('512b391b6f1162975371d30919734294f868e3be3984f3c1a13a4db9fabe4acb');
  });
});

describe('hash-wasm matches the reference in the adapter mode (no secret, no associated data)', () => {
  const cases = [
    { p: 4, t: 3, m: 32, tagLength: 32 },
    { p: 1, t: 2, m: 64, tagLength: 32 },
    { p: 1, t: 3, m: 256, tagLength: 32 },
    { p: 2, t: 1, m: 128, tagLength: 64 },
  ];
  for (const c of cases) {
    it(`agrees at p=${c.p} t=${c.t} m=${c.m} tag=${c.tagLength}`, async () => {
      const password = fill(20, 1);
      const salt = fill(16, 2);
      const reference = argon2Reference({ password, salt, ...c });
      const wasm = await argon2id({ password, salt, iterations: c.t, parallelism: c.p, memorySize: c.m, hashLength: c.tagLength, outputType: 'binary' });
      expect(hex(wasm)).toBe(hex(reference.tag));
    });
  }
});

describe('the Argon2id adapter', () => {
  it('defaults to the hosted.md parameters: 64 MiB, 3 passes, 1 lane', () => {
    expect(ARGON2ID_DEFAULT).toEqual({ memoryKiB: 65536, iterations: 3, parallelism: 1 });
    expect(argon2idDescriptor()).toEqual({ id: ARGON2ID_ID, params: { memoryKiB: 65536, iterations: 3, parallelism: 1 } });
  });

  it('derives 32 deterministic bytes at the production parameters', async () => {
    const kdf = createArgon2idKdf();
    const salt = fill(16, 7);
    const a = await kdf.derive(new TextEncoder().encode('correct horse battery staple'), salt);
    const b = await kdf.derive(new TextEncoder().encode('correct horse battery staple'), salt);
    expect(a).toHaveLength(32);
    expect(hex(a)).toBe(hex(b));
    const other = await kdf.derive(new TextEncoder().encode('correct horse battery staple'), fill(16, 8));
    expect(hex(other)).not.toBe(hex(a));
  });

  it('resolves a stored descriptor to the same derivation, so a parameter change does not strand an account', async () => {
    const params = { memoryKiB: 256, iterations: 3, parallelism: 1 };
    const descriptor = argon2idDescriptor(params);
    const passphrase = new TextEncoder().encode('a passphrase');
    const salt = fill(16, 3);
    const resolved = await resolveArgon2idKdf(descriptor).derive(passphrase, salt);
    const direct = await createArgon2idKdf(params).derive(passphrase, salt);
    const reference = argon2Reference({ password: passphrase, salt, p: 1, t: 3, m: 256, tagLength: 32 });
    expect(hex(resolved)).toBe(hex(direct));
    expect(hex(resolved)).toBe(hex(reference.tag));
  });

  it('refuses a salt shorter than 16 bytes', async () => {
    await expect(createArgon2idKdf({ memoryKiB: 64, iterations: 1, parallelism: 1 }).derive(fill(8, 1), fill(8, 2))).rejects.toThrow(/salt/);
  });

  it('refuses invalid parameters and descriptors', () => {
    expect(() => argon2idDescriptor({ memoryKiB: 4, iterations: 3, parallelism: 1 })).toThrow(/memory/);
    expect(() => argon2idDescriptor({ memoryKiB: 64, iterations: 0, parallelism: 1 })).toThrow(/iterations/);
    expect(() => argon2idDescriptor({ memoryKiB: 64, iterations: 3, parallelism: 0 })).toThrow(/parallelism/);
    expect(() => resolveArgon2idKdf({ id: 'scrypt', params: {} })).toThrow(/Argon2id/);
    expect(() => resolveArgon2idKdf({ id: ARGON2ID_ID, params: { memoryKiB: 64 } })).toThrow(/missing/);
  });

  it('refuses a cost above the ceiling, so a tampered record cannot exhaust the client', () => {
    expect(() => argon2idDescriptor({ memoryKiB: 262_145, iterations: 3, parallelism: 1 })).toThrow(/memory/);
    expect(() => argon2idDescriptor({ memoryKiB: 64, iterations: 11, parallelism: 1 })).toThrow(/iterations/);
    expect(() => argon2idDescriptor({ memoryKiB: 64, iterations: 3, parallelism: 5 })).toThrow(/parallelism/);
    expect(() => argon2idDescriptor({ memoryKiB: 8, iterations: 1, parallelism: 4 })).toThrow(/lane/);
    expect(() => argon2idDescriptor({ memoryKiB: 32, iterations: 1, parallelism: 4 })).not.toThrow();
    expect(() => resolveArgon2idKdf({ id: ARGON2ID_ID, params: { memoryKiB: 1_048_576, iterations: 3, parallelism: 1 } })).toThrow(/memory/);
    expect(() => resolveArgon2idKdf({ id: ARGON2ID_ID, params: { memoryKiB: 2_000_000_000, iterations: 3, parallelism: 1 } })).toThrow(/memory/);
    expect(() => resolveArgon2idKdf({ id: ARGON2ID_ID, params: { memoryKiB: 64, iterations: 1_000_000_000, parallelism: 1 } })).toThrow(/iterations/);
  });
});