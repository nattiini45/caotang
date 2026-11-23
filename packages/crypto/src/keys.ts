import { associatedData, aeadOpen, aeadSeal, KEY_BYTES } from './aead.js';
import { buf, concat, equalBytes, systemRandom, utf8, type RandomBytes } from './bytes.js';
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
const ACCOUNT_VERIFY = 'caotang/v1/account-verify';

/**
 * The master key under the KEK, bound to the account the record belongs to: the associated data is the label and the
 * account id, so a record served to another account does not open. `null` is the one-argument label a record written before
 * the binding used; it is read-only, and passing it is the only way such a record still opens.
 */
export function wrapMasterKey(kek: SecretKey, master: SecretKey, accountId: string | null, random?: RandomBytes): Promise<Uint8Array> {
  requireRole(kek, 'kek');
  requireRole(master, 'master');
  return aeadSeal(kek.export(), masterAssociatedData(accountId), master.export(), random);
}

export async function unwrapMasterKey(kek: SecretKey, wrapped: Uint8Array, accountId: string | null): Promise<SecretKey> {
  requireRole(kek, 'kek');
  return new SecretKey('master', await aeadOpen(kek.export(), masterAssociatedData(accountId), wrapped));
}

function masterAssociatedData(accountId: string | null): Uint8Array {
  return accountId === null ? associatedData(WRAP_MASTER) : associatedData(WRAP_MASTER, accountId);
}

/**
 * `KEY_BYTES` that prove a master key belongs to an account: HMAC-SHA-256 of the label and the account id, under the master
 * key. The account record carries it so a recovery key printed for one account is refused by another, instead of unlocking
 * into a vault it can never open and sealing new entries there.
 */
export async function accountVerifier(master: SecretKey, accountId: string): Promise<Uint8Array> {
  requireRole(master, 'master');
  const key = await globalThis.crypto.subtle.importKey('raw', buf(master.export()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, buf(associatedData(ACCOUNT_VERIFY, accountId))));
}

/** Whether `verifier` is this account's, compared in constant time. */
export async function matchesAccountVerifier(master: SecretKey, accountId: string, verifier: Uint8Array): Promise<boolean> {
  return equalBytes(await accountVerifier(master, accountId), verifier);
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
  /** The project record: the project's name as the host shows it before anything is opened (hosted.md §5). */
  name: 'caotang/v1/name-key',
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

/** The label for the provider-key vault key (P9). The vault sync is its own slice; this is the seam it derives from. */
export const VAULT_INFO_LABEL = 'caotang/v1/vault-key';

/**
 * HKDF-SHA-256 over the master key for the sealed provider-key vault (hosted.md, plan §4.5). Distinct from
 * every project subkey label, so the vault key can never collide with a file, path or manifest key.
 */
export async function deriveVaultKey(master: SecretKey): Promise<Uint8Array> {
  requireRole(master, 'master');
  const base = await globalThis.crypto.subtle.importKey('raw', buf(master.export()), 'HKDF', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: buf(utf8(VAULT_INFO_LABEL)) }, base, KEY_BYTES * 8);
  return new Uint8Array(bits);
}
