import { CryptoError } from './errors.js';

/** Random bytes. Injectable so a test can pin a nonce; production code never passes one. */
export type RandomBytes = (length: number) => Uint8Array;

export const systemRandom: RandomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** WebCrypto's `BufferSource` wants an `ArrayBuffer`-backed view; ours always are. */
export function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Crockford base32, no padding characters, upper case. */
export function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/** The inverse of {@link encodeBase32}, canonical only: an unknown character or non-zero trailing bits is refused. */
export function decodeBase32(text: string): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of text) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) throw new CryptoError('bad-format', `"${ch}" is not a base32 character`);
    acc = (acc << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 255);
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  if (acc !== 0) throw new CryptoError('bad-format', 'the base32 text has stray trailing bits');
  return Uint8Array.from(out);
}
