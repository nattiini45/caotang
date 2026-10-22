import { scryptSync } from 'node:crypto';
import type { Kdf, RandomBytes } from '../src/index.js';

/** A fast stand-in for Argon2id: scrypt at the smallest cost, so the tests stay quick. It is never shipped. */
export const fastKdf: Kdf = {
  id: 'test-scrypt-n16',
  async derive(passphrase, salt) {
    return new Uint8Array(scryptSync(passphrase, salt, 32, { N: 16, r: 1, p: 1 }));
  },
};

/** mulberry32: a seeded generator, so a failing case can be replayed. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededBytes(next: () => number, length: number): Uint8Array {
  return Uint8Array.from({ length }, () => Math.floor(next() * 256));
}

/** A counter for a "random" source, so a vector is reproducible. */
export function fixedRandom(fill: number): RandomBytes {
  return (length) => new Uint8Array(length).fill(fill);
}
