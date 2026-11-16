/**
 * Account-key orchestration — [hosted.md §2, §4](../../../docs/architecture/hosted.md). Setup, unlock, recovery
 * and passphrase rotation over the primitives. The master key never leaves the device; the server holds only
 * its wrapped form beside the account. The KDF descriptor travels with the wrapped key, so raising the cost
 * later never strands an existing account. Signing in proves identity to the server and never derives a key.
 */
import { decodeBase64, encodeBase64, type RandomBytes } from './bytes.js';
import { CryptoError } from './errors.js';
import type { Kdf, KdfDescriptor } from './kdf.js';
import { deriveKek, generateMasterKey, generateProjectKey, generateSalt, unwrapMasterKey, wrapMasterKey, wrapProjectKey, type SecretKey } from './keys.js';
import { decodeRecoveryKey, encodeRecoveryKey } from './recovery.js';

export const ACCOUNT_RECORD_FORMAT = 1;

/** What the server stores beside the account: the KDF descriptor, the salt and the wrapped master key. No plaintext key. */
export interface AccountKeyRecord {
  readonly format: number;
  readonly kdf: KdfDescriptor;
  /** base64, at least 16 bytes. */
  readonly salt: string;
  /** base64, the master key sealed under the KEK. */
  readonly wrappedMaster: string;
}

/** Maps a stored descriptor to the Kdf that reproduces it. The browser wires this to the Argon2id adapter. */
export type ResolveKdf = (descriptor: KdfDescriptor) => Kdf;

function parseRecord(record: AccountKeyRecord): { salt: Uint8Array; wrapped: Uint8Array } {
  if (record.format !== ACCOUNT_RECORD_FORMAT) throw new CryptoError('bad-format', `unknown account record format ${record.format}`);
  return { salt: decodeBase64(record.salt), wrapped: decodeBase64(record.wrappedMaster) };
}

export interface SetupAccountOptions {
  readonly passphrase: string;
  readonly descriptor: KdfDescriptor;
  readonly resolveKdf: ResolveKdf;
  readonly random?: RandomBytes;
}

export interface SetupAccountResult {
  readonly record: AccountKeyRecord;
  readonly master: SecretKey;
  /** Shown once and acknowledged before the account is usable; there is no escrow. */
  readonly recoveryKey: string;
}

/** Creates the account's master key, wraps it under the passphrase KEK and returns the printable recovery key. */
export async function setupAccountKeys(options: SetupAccountOptions): Promise<SetupAccountResult> {
  const kdf = options.resolveKdf(options.descriptor);
  const salt = generateSalt(options.random);
  const kek = await deriveKek(kdf, options.passphrase, salt);
  const master = generateMasterKey(options.random);
  const wrapped = await wrapMasterKey(kek, master, options.random);
  const record: AccountKeyRecord = {
    format: ACCOUNT_RECORD_FORMAT,
    kdf: options.descriptor,
    salt: encodeBase64(salt),
    wrappedMaster: encodeBase64(wrapped),
  };
  return { record, master, recoveryKey: await encodeRecoveryKey(master) };
}

/** Derives the KEK from the passphrase and the stored salt, then unwraps the master key. */
export async function unlockAccountKeys(options: { passphrase: string; record: AccountKeyRecord; resolveKdf: ResolveKdf }): Promise<SecretKey> {
  const { salt, wrapped } = parseRecord(options.record);
  const kdf = options.resolveKdf(options.record.kdf);
  const kek = await deriveKek(kdf, options.passphrase, salt);
  return unwrapMasterKey(kek, wrapped);
}

/** The recovery key is the master key itself; no passphrase is involved. */
export async function unlockWithRecoveryKey(recoveryKey: string): Promise<SecretKey> {
  return decodeRecoveryKey(recoveryKey);
}

export interface ChangePassphraseOptions {
  readonly oldPassphrase: string;
  readonly newPassphrase: string;
  readonly record: AccountKeyRecord;
  readonly resolveKdf: ResolveKdf;
  /** Defaults to the record's descriptor; pass a new one to raise the KDF cost at the same time. */
  readonly newDescriptor?: KdfDescriptor;
  readonly random?: RandomBytes;
}

/**
 * Re-wraps the master key under a new passphrase (and optionally new KDF parameters). No project file is
 * rewritten: the master key is unchanged, so every project key and sealed byte stays valid.
 */
export async function changeAccountPassphrase(options: ChangePassphraseOptions): Promise<{ record: AccountKeyRecord; master: SecretKey }> {
  const master = await unlockAccountKeys({ passphrase: options.oldPassphrase, record: options.record, resolveKdf: options.resolveKdf });
  const descriptor = options.newDescriptor ?? options.record.kdf;
  const kdf = options.resolveKdf(descriptor);
  const salt = generateSalt(options.random);
  const kek = await deriveKek(kdf, options.newPassphrase, salt);
  const wrapped = await wrapMasterKey(kek, master, options.random);
  return {
    record: { format: ACCOUNT_RECORD_FORMAT, kdf: descriptor, salt: encodeBase64(salt), wrappedMaster: encodeBase64(wrapped) },
    master,
  };
}

/**
 * A fresh project key wrapped under the master key, bound to the project id. This is both the first-create
 * and the rotation hook: rotating a project means a new key here and re-sealing its files under it (the sync
 * slice's job); the old wrapped key is kept until every file has moved.
 */
export async function createProjectKey(master: SecretKey, projectId: string, random?: RandomBytes): Promise<{ projectKey: SecretKey; wrappedProjectKey: Uint8Array }> {
  const projectKey = generateProjectKey(random);
  const wrappedProjectKey = await wrapProjectKey(master, projectKey, projectId, random);
  return { projectKey, wrappedProjectKey };
}