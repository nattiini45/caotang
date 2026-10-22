import { associatedData, aeadOpen, aeadSeal, KEY_BYTES } from './aead.js';
import { buf, concat, systemRandom, utf8, type RandomBytes } from './bytes.js';
import { CryptoError } from './errors.js';
import { MIN_SALT_BYTES, type Kdf } from './kdf.js';

export type KeyRole = 'kek' | 'master' | 'project';

/**
 * A 256-bit key and the role it plays. The bytes sit in a private field, so a key that is logged or
 * serialised prints as its role; code that needs the bytes (wrapping, the recovery key) asks with
 * {@link SecretKey.export}.
 */
export class SecretKey {
  readonly #bytes: Uint8Array;

  constructor(
    readonly role: KeyRole,
    bytes: Uint8Array,
  ) {
    if (bytes.length !== KEY_BYTES) throw new CryptoError('invalid-argument', `a ${role} key is ${KEY_BYTES} bytes, not ${bytes.length}`);
    this.#bytes = bytes.slice();
  }

  export(): Uint8Array {
    return this.#bytes.slice();
  }

  toJSON(): string {
    return `[${this.role} key]`;
  }

  toString(): string {
    return this.toJSON();
  }
}

function requireRole(key: SecretKey, role: KeyRole): void {
  if (key.role !== role) throw new CryptoError('invalid-argument', `expected a ${role} key, got a ${key.role} key`);
}

export function generateMasterKey(random: RandomBytes = systemRandom): SecretKey {
  return new SecretKey('master', random(KEY_BYTES));
}

export function generateProjectKey(random: RandomBytes = systemRandom): SecretKey {
  return new SecretKey('project', random(KEY_BYTES));
}

export function generateSalt(random: RandomBytes = systemRandom): Uint8Array {
  return random(MIN_SALT_BYTES);
}

/** KEK = KDF(passphrase, salt). The passphrase is NFKC-normalised first, so one typed on two keyboards is one passphrase. */
export async function deriveKek(kdf: Kdf, passphrase: string, salt: Uint8Array): Promise<SecretKey> {
  if (passphrase === '') throw new CryptoError('invalid-argument', 'the passphrase is empty');
  if (salt.length < MIN_SALT_BYTES) throw new CryptoError('invalid-argument', `the salt is at least ${MIN_SALT_BYTES} bytes`);
  return new SecretKey('kek', await kdf.derive(utf8(passphrase.normalize('NFKC')), salt));
}

const WRAP_MASTER = 'caotang/v1/wrap/master';
const WRAP_PROJECT = 'caotang/v1/wrap/project';

/** The master key under the KEK. What the server stores beside the account. */
export function wrapMasterKey(kek: SecretKey, master: SecretKey, random?: RandomBytes): Promise<Uint8Array> {
  requireRole(kek, 'kek');
  requireRole(master, 'master');
  return aeadSeal(kek.export(), associatedData(WRAP_MASTER), master.export(), random);
}

export async function unwrapMasterKey(kek: SecretKey, wrapped: Uint8Array): Promise<SecretKey> {
  requireRole(kek, 'kek');
  return new SecretKey('master', await aeadOpen(kek.export(), associatedData(WRAP_MASTER), wrapped));
}

/** A project key under the master key, bound to the project id so one project's wrapped key cannot stand in for another. */
export function wrapProjectKey(master: SecretKey, project: SecretKey, projectId: string, random?: RandomBytes): Promise<Uint8Array> {
  requireRole(master, 'master');
  requireRole(project, 'project');
  return aeadSeal(master.export(), associatedData(WRAP_PROJECT, projectId), project.export(), random);
}

export async function unwrapProjectKey(master: SecretKey, wrapped: Uint8Array, projectId: string): Promise<SecretKey> {
  requireRole(master, 'master');
  return new SecretKey('project', await aeadOpen(master.export(), associatedData(WRAP_PROJECT, projectId), wrapped));
}

/** Every key derived from a project key has its own label, so no two of them are ever the same key. */
export const INFO_LABELS = {
  file: 'caotang/v1/file-key',
  path: 'caotang/v1/path-hmac-key',
  manifest: 'caotang/v1/manifest-key',
} as const;

export type SubkeyPurpose = keyof typeof INFO_LABELS;

/** HKDF-SHA-256 over the project key. `context` (the path hash, for a file) makes each file's key its own. */
export async function deriveSubkey(project: SecretKey, purpose: SubkeyPurpose, context = ''): Promise<Uint8Array> {
  requireRole(project, 'project');
  const base = await globalThis.crypto.subtle.importKey('raw', buf(project.export()), 'HKDF', false, ['deriveBits']);
  const info = context === '' ? utf8(INFO_LABELS[purpose]) : concat(utf8(INFO_LABELS[purpose]), Uint8Array.of(0), utf8(context));
  const bits = await globalThis.crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: buf(info) }, base, KEY_BYTES * 8);
  return new Uint8Array(bits);
}
