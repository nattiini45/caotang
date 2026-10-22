import { KEY_BYTES } from './aead.js';
import { buf, concat, decodeBase32, encodeBase32, equalBytes, utf8 } from './bytes.js';
import { CryptoError } from './errors.js';
import { SecretKey } from './keys.js';

const VERSION = 1;
const CHECK_BYTES = 4;
const GROUP = 5;

async function checksum(master: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buf(concat(utf8('caotang/v1/recovery'), Uint8Array.of(VERSION), master)));
  return new Uint8Array(digest).slice(0, CHECK_BYTES);
}

/**
 * The master key as text a writer can print: version byte, key, a 4-byte checksum, in Crockford base32 and
 * groups of five. 60 characters; a mistyped one is caught by the checksum, not by a failed decrypt.
 */
export async function encodeRecoveryKey(master: SecretKey): Promise<string> {
  if (master.role !== 'master') throw new CryptoError('invalid-argument', 'a recovery key encodes the master key');
  const bytes = master.export();
  const text = encodeBase32(concat(Uint8Array.of(VERSION), bytes, await checksum(bytes)));
  const groups: string[] = [];
  for (let i = 0; i < text.length; i += GROUP) groups.push(text.slice(i, i + GROUP));
  return groups.join('-');
}

/** Accepts the printed form in any case, with or without dashes and spaces; O reads as 0, and I or L as 1. */
export async function decodeRecoveryKey(text: string): Promise<SecretKey> {
  let clean = '';
  for (const ch of text.toUpperCase()) {
    if (ch === '-' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    clean += ch === 'O' ? '0' : ch === 'I' || ch === 'L' ? '1' : ch;
  }
  const bytes = decodeBase32(clean);
  if (bytes.length !== 1 + KEY_BYTES + CHECK_BYTES) throw new CryptoError('bad-format', 'a recovery key is 60 characters');
  if (bytes[0] !== VERSION) throw new CryptoError('bad-format', `unknown recovery key version ${bytes[0]}`);
  const master = bytes.slice(1, 1 + KEY_BYTES);
  if (!equalBytes(bytes.slice(1 + KEY_BYTES), await checksum(master))) {
    throw new CryptoError('bad-checksum', 'the recovery key has a mistake in it: check each group against the page');
  }
  return new SecretKey('master', master);
}
