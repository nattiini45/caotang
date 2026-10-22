import { buf, concat, systemRandom, type RandomBytes } from './bytes.js';
import { CryptoError } from './errors.js';

/** The first byte of every sealed value; a later format takes the next number. */
export const FORMAT_TAG = 1;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const KEY_BYTES = 32;

async function aesKey(raw: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  if (raw.length !== KEY_BYTES) throw new CryptoError('invalid-argument', `an AES-256 key is ${KEY_BYTES} bytes, not ${raw.length}`);
  return globalThis.crypto.subtle.importKey('raw', buf(raw), 'AES-GCM', false, [usage]);
}

/** `tag || nonce || ciphertext+tag`, the nonce random and fresh for every call. */
export async function aeadSeal(
  key: Uint8Array,
  associatedData: Uint8Array,
  plaintext: Uint8Array,
  random: RandomBytes = systemRandom,
): Promise<Uint8Array> {
  const nonce = random(NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES) throw new CryptoError('invalid-argument', 'the nonce source returned the wrong length');
  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: buf(nonce), additionalData: buf(associatedData), tagLength: TAG_BYTES * 8 },
    await aesKey(key, 'encrypt'),
    buf(plaintext),
  );
  return concat(Uint8Array.of(FORMAT_TAG), nonce, new Uint8Array(sealed));
}

export async function aeadOpen(key: Uint8Array, associatedData: Uint8Array, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < 1 + NONCE_BYTES + TAG_BYTES) throw new CryptoError('bad-format', 'the sealed value is too short');
  if (sealed[0] !== FORMAT_TAG) throw new CryptoError('bad-format', `unknown sealed format ${sealed[0]}`);
  const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
  const body = sealed.subarray(1 + NONCE_BYTES);
  try {
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buf(nonce), additionalData: buf(associatedData), tagLength: TAG_BYTES * 8 },
      await aesKey(key, 'decrypt'),
      buf(body),
    );
    return new Uint8Array(plain);
  } catch {
    throw new CryptoError('unauthentic', 'the data did not authenticate: wrong key, wrong context or altered bytes');
  }
}

/**
 * Associated data is a label plus fields joined by NUL. A field holding NUL could move a boundary and let one
 * context pass as another, so it is refused.
 */
export function associatedData(label: string, ...fields: readonly (string | number)[]): Uint8Array {
  const parts = [label];
  for (const field of fields) {
    const text = String(field);
    if (text.includes('\0')) throw new CryptoError('invalid-argument', 'associated data may not contain NUL');
    parts.push(text);
  }
  return new TextEncoder().encode(parts.join('\0'));
}

export function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) throw new CryptoError('invalid-argument', `a version is a non-negative integer, not ${version}`);
}
