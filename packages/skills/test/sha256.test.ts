import { describe, expect, it } from 'vitest';

import { sha256HexOfBytes, sha256HexOfText } from '../src/sha256.js';

const viaSubtle = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('sha256', () => {
  it('matches the published vectors', () => {
    expect(sha256HexOfText('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256HexOfText('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256HexOfText('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('agrees with crypto.subtle across every length around the block boundaries', async () => {
    let seed = 12345;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed >>> 24;
    };
    for (let length = 0; length <= 200; length += 1) {
      const bytes = Uint8Array.from({ length }, next);
      expect(sha256HexOfBytes(bytes)).toBe(await viaSubtle(bytes));
    }
    const large = Uint8Array.from({ length: 100_000 }, next);
    expect(sha256HexOfBytes(large)).toBe(await viaSubtle(large));
  });
});
