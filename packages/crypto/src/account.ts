/**
 * Account-key orchestration — [hosted.md §2, §4](../../../docs/architecture/hosted.md). Setup, unlock, recovery
 * and passphrase rotation over the primitives. The master key never leaves the device; the server holds only
 * its wrapped form beside the account. The KDF descriptor travels with the wrapped key, so raising the cost
 * later never strands an existing account. Signing in proves identity to the server and never derives a key.
 */
import { decodeBase64, encodeBase64, type RandomBytes } from './bytes.js';
import { CryptoError } from './errors.js';
import type { Kdf, KdfDescriptor } from './kdf.js';
import { accountVerifier, deriveKek, generateMasterKey, generateProjectKey, generateSalt, matchesAccountVerifier, unwrapMasterKey, wrapMasterKey, wrapProjectKey, type SecretKey } from './keys.js';
import { decodeRecoveryKey, encodeRecoveryKey } from './recovery.js';

export const ACCOUNT_RECORD_FORMAT = 2;
/** The format the first records used: no account binding and no verifier. Readable, never written. */
export const ACCOUNT_RECORD_FORMAT_LEGACY = 1;

/**
 * What the server stores beside the account: the KDF descriptor, the salt, the wrapped master key and — from format 2 — the
 * account the record belongs to and a verifier for its master key. No plaintext key, and nothing here opens without the
 * passphrase or the recovery key.
 */
export interface AccountKeyRecord {
  readonly format: number;
  /** The account this record belongs to. Absent only on a legacy record. */
  readonly accountId?: string;
  readonly kdf: KdfDescriptor;
  /** base64, at least 16 bytes. */
  readonly salt: string;
  /** base64, the master key sealed under the KEK, with the account id as associated data from format 2. */
  readonly wrappedMaster: string;
  /** base64 of 32 bytes: the account's verifier for this master key. Absent only on a legacy record. */
  readonly verifier?: string;
}

/** Maps a stored descriptor to the Kdf that reproduces it. The browser wires this to the Argon2id adapter. */
export type ResolveKdf = (descriptor: KdfDescriptor) => Kdf;

interface ParsedRecord {
  readonly legacy: boolean;
  readonly salt: Uint8Array;
  readonly wrapped: Uint8Array;
  readonly verifier: Uint8Array | null;
}

function parseRecord(record: AccountKeyRecord): ParsedRecord {
  if (record.format === ACCOUNT_RECORD_FORMAT_LEGACY) {
    return { legacy: true, salt: decodeBase64(record.salt), wrapped: decodeBase64(record.wrappedMaster), verifier: null };
  }
  if (record.format !== ACCOUNT_RECORD_FORMAT) throw new CryptoError('bad-format', `unknown account record format ${record.format}`);
  if (typeof record.accountId !== 'string' || record.accountId === '') throw new CryptoError('bad-format', 'the account record does not name its account');
  const verifier = typeof record.verifier === 'string' ? decodeBase64(record.verifier) : null;
  if (verifier === null || verifier.length !== 32) throw new CryptoError('bad-format', 'the account record carries no usable verifier');
  return { legacy: false, salt: decodeBase64(record.salt), wrapped: decodeBase64(record.wrappedMaster), verifier };
}

/**
 * The record has to belong to the account asking for it. A server that serves one account's record to another is refused
 * here rather than installing a master key this account's vault can never open: two accounts may share a passphrase, so
 * nothing else in the format would notice.
 */
function requireAccount(record: AccountKeyRecord, accountId: string): void {
  if (record.format === ACCOUNT_RECORD_FORMAT_LEGACY) return;
  if (record.accountId !== accountId) throw new CryptoError('unauthentic', 'this account record belongs to another account');
}

export interface SetupAccountOptions {
  readonly passphrase: string;
  /** The account the record belongs to and the wrap is bound to. */
  readonly accountId: string;
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
  const wrapped = await wrapMasterKey(kek, master, options.accountId, options.random);
  const record: AccountKeyRecord = {
    format: ACCOUNT_RECORD_FORMAT,
    accountId: options.accountId,
    kdf: options.descriptor,
    salt: encodeBase64(salt),
    wrappedMaster: encodeBase64(wrapped),
    verifier: encodeBase64(await accountVerifier(master, options.accountId)),
  };
  return { record, master, recoveryKey: await encodeRecoveryKey(master) };
}

/**
 * Derives the KEK from the passphrase and the stored salt, then unwraps the master key. The record has to belong to
 * `accountId`, and a format-2 record only opens with that account id as its associated data.
 */
export async function unlockAccountKeys(options: { passphrase: string; accountId: string; record: AccountKeyRecord; resolveKdf: ResolveKdf }): Promise<SecretKey> {
  requireAccount(options.record, options.accountId);
  const parsed = parseRecord(options.record);
  const kdf = options.resolveKdf(options.record.kdf);
  const kek = await deriveKek(kdf, options.passphrase, parsed.salt);
  return unwrapMasterKey(kek, parsed.wrapped, parsed.legacy ? null : options.accountId);
}

/** What a record says a recovery key has to prove before this account accepts it. */
export interface RecoveryCheck {
  readonly accountId: string;
  /** base64 of the record's verifier. Undefined on a legacy record, which carries none to check against. */
  readonly verifier?: string;
}

/**
 * The recovery key is the master key itself; no passphrase is involved. A format-2 record's verifier is checked first, so a
 * key printed for another account is refused here instead of unlocking a session that could never open this account's vault
 * and would seal new entries where this account cannot read them.
 */
export async function unlockWithRecoveryKey(recoveryKey: string, check?: RecoveryCheck): Promise<SecretKey> {
  const master = await decodeRecoveryKey(recoveryKey);
  if (check?.verifier === undefined) return master;
  if (!(await matchesAccountVerifier(master, check.accountId, decodeBase64(check.verifier)))) {
    throw new CryptoError('unauthentic', 'this recovery key belongs to another account');
  }
  return master;
}

export interface ChangePassphraseOptions {
  readonly oldPassphrase: string;
  readonly newPassphrase: string;
  readonly accountId: string;
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
  const master = await unlockAccountKeys({ passphrase: options.oldPassphrase, accountId: options.accountId, record: options.record, resolveKdf: options.resolveKdf });
  const descriptor = options.newDescriptor ?? options.record.kdf;
  const kdf = options.resolveKdf(descriptor);
  const salt = generateSalt(options.random);
  const kek = await deriveKek(kdf, options.newPassphrase, salt);
  const wrapped = await wrapMasterKey(kek, master, options.accountId, options.random);
  return {
    record: {
      format: ACCOUNT_RECORD_FORMAT,
      accountId: options.accountId,
      kdf: descriptor,
      salt: encodeBase64(salt),
      wrappedMaster: encodeBase64(wrapped),
      verifier: encodeBase64(await accountVerifier(master, options.accountId)),
    },
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