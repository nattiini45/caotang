/**
 * The pure-TypeScript SHA-256 behind the Yarn Spinner `lock` column: the FIPS 180-4 example vectors, and a cross-check
 * against Node's own `crypto` over fixed edge cases and seeded random strings.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../src/sha256.js';

const node = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('sha256Hex — FIPS 180-4 vectors', () => {
  it('hashes the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes the 448-bit message', () => {
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('hashes the 896-bit message', () => {
    expect(sha256Hex('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu')).toBe(
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    );
  });

  it('hashes one million "a"', () => {
    expect(sha256Hex('a'.repeat(1_000_000))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });
});

describe('sha256Hex — against Node crypto', () => {
  it('agrees at every padding boundary, from 0 to 130 characters', () => {
    for (let length = 0; length <= 130; length += 1) {
      const text = 'x'.repeat(length);
      expect(sha256Hex(text), `length ${length}`).toBe(node(text));
    }
  });

  it('agrees on quotes, commas, emoji, newlines and non-Latin text', () => {
    for (const text of ['say "hi", ok', 'a,b,c', 'tab\there', 'one\r\ntwo\nthree', '\u{1F600} and \u{1F468}\u200D\u{1F469}\u200D\u{1F467}', 'café', '日本語のテキスト', 'مرحبا', "it's", 'Anna: =1+1']) {
      expect(sha256Hex(text), text).toBe(node(text));
    }
  });

  it('agrees on seeded random strings', () => {
    let seed = 0x2545f491;
    const next = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    const alphabet = ['a', 'Z', '7', ' ', '"', ',', '\n', '\r', '\t', "'", 'é', 'ß', '漢', '\u{1F600}', '\u{1F44D}\u{1F3FD}'];
    for (let run = 0; run < 300; run += 1) {
      const length = next() % 200;
      let text = '';
      for (let i = 0; i < length; i += 1) text += alphabet[next() % alphabet.length];
      expect(sha256Hex(text)).toBe(node(text));
    }
  });
});
