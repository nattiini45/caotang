/**
 * The base64 codec for the JSON account record, pinned against Node's Buffer and checked for canonical form.
 * A non-canonical trailing quantum (non-zero unused bits) must be refused, not silently accepted.
 */
import { describe, expect, it } from 'vitest';
import { CryptoError, decodeBase64, encodeBase64 } from '../src/index.js';
import { seeded, seededBytes } from './helpers.js';

describe('base64', () => {
  it('round-trips every length 0..40 and matches Buffer’s encoding', () => {
    const next = seeded(99);
    for (let n = 0; n <= 40; n++) {
      const bytes = seededBytes(next, n);
      const text = encodeBase64(bytes);
      expect(text).toBe(Buffer.from(bytes).toString('base64'));
      expect(decodeBase64(text)).toEqual(bytes);
    }
  });

  it('decodes what Buffer encoded, with and without padding', () => {
    expect(decodeBase64(Buffer.from('hello world').toString('base64'))).toEqual(new TextEncoder().encode('hello world'));
    expect(decodeBase64('AA==')).toEqual(new Uint8Array([0]));
    expect(decodeBase64('AAA=')).toEqual(new Uint8Array([0, 0]));
    expect(decodeBase64('AAAA')).toEqual(new Uint8Array([0, 0, 0]));
  });

  it('refuses a non-base64 character', () => {
    expect(() => decodeBase64('A!AA')).toThrow(CryptoError);
  });

  it('refuses non-canonical trailing bits in a partial quantum', () => {
    // One byte: the second character’s low four bits must be zero. "AB" leaves a stray bit.
    expect(() => decodeBase64('AB==')).toThrow(/trailing bits/);
    // Two bytes: the third character’s low two bits must be zero. "AAB" leaves a stray bit.
    expect(() => decodeBase64('AAB=')).toThrow(/trailing bits/);
  });

  it('handles a long run of padding without polynomial backtracking', () => {
    expect(decodeBase64('='.repeat(100000))).toEqual(new Uint8Array(0));
    // Many '=' followed by a non-'=' is the shape that backtracks a /=+$/ regex; it must stay linear.
    expect(() => decodeBase64('='.repeat(200000) + 'A')).toThrow(CryptoError);
  });
});