/**
 * Account-key orchestration — [hosted.md §2, §4](../../../docs/architecture/hosted.md). Setup, unlock, recovery
 * and passphrase rotation over the primitives. The master key never leaves the device; the server holds only
 * its wrapped form beside the account. The KDF descriptor travels with the wrapped key, so raising the cost
 * later never strands an existing account. Signing in proves identity to the server and never derives a key.
 */
import { aeadOpen, aeadSeal, associatedData } from './aead.js';
import { decodeBase64, encodeBase64, type RandomBytes } from './bytes.js';
import { CryptoError } from './errors.js';
import type { Kdf, KdfDescriptor } from './kdf.js';
import { SecretKey, accountVerifier, deriveKek, generateMasterKey, generateProjectKey, generateSalt, matchesAccountVerifier, unwrapMasterKey, unwrapProjectKey, wrapMasterKey, wrapProjectKey } from './keys.js';
import { decodeRecoveryKey, encodeRecoveryKey } from './recovery.js';

export const ACCOUNT_RECORD_FORMAT = 2;
/** The format the first records used: no account binding and no verifier. Readable, never written. */
export const ACCOUNT_RECORD_FORMAT_LEGACY = 1;
/**
 * A record between a rotation's two steps. It opens with the new master key, and it carries the master key it retires sealed
 * under that new key, so a rotation interrupted after the record was written can be finished by anyone who can open it.
 */
export const ACCOUNT_RECORD_FORMAT_ROTATING = 3;

/** What the retired master key is sealed under, bound to the account, so a record moved between accounts does not open. */
const ROTATE_RETIRED = 'caotang/v1/rotate/retired';
/** The bytes of a sealed master key: format byte, nonce, key and tag. */
const SEALED_MASTER_BYTES = 1 + 12 + 32 + 16;

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
  /**
   * base64 of the master key this record retires, sealed under the record's own master key with the account id as associated
   * data. Present only on a record whose rotation has not finished; it is what lets an interrupted rotation finish instead of
   * leaving the account's vault under a key nothing reaches any more.
   */
  readonly retired?: string;
}

/** Maps a stored descriptor to the Kdf that reproduces it. The browser wires this to the Argon2id adapter. */
export type ResolveKdf = (descriptor: KdfDescriptor) => Kdf;

interface ParsedRecord {
  readonly legacy: boolean;
  readonly salt: Uint8Array;
  readonly wrapped: Uint8Array;
  readonly verifier: Uint8Array | null;
  readonly retired: Uint8Array | null;
}

function parseRecord(record: AccountKeyRecord): ParsedRecord {
  if (record.format === ACCOUNT_RECORD_FORMAT_LEGACY) {
    return { legacy: true, salt: decodeBase64(record.salt), wrapped: decodeBase64(record.wrappedMaster), verifier: null, retired: null };
  }
  if (record.format !== ACCOUNT_RECORD_FORMAT && record.format !== ACCOUNT_RECORD_FORMAT_ROTATING) {
    throw new CryptoError('bad-format', `unknown account record format ${record.format}`);
  }
  if (typeof record.accountId !== 'string' || record.accountId === '') throw new CryptoError('bad-format', 'the account record does not name its account');
  const verifier = typeof record.verifier === 'string' ? decodeBase64(record.verifier) : null;
  if (verifier === null || verifier.length !== 32) throw new CryptoError('bad-format', 'the account record carries no usable verifier');
  return {
    legacy: false,
    salt: decodeBase64(record.salt),
    wrapped: decodeBase64(record.wrappedMaster),
    verifier,
    retired: record.format === ACCOUNT_RECORD_FORMAT_ROTATING ? retiredSeal(record.retired) : null,
  };
}

/** A rotating record's retired key is a sealed master key and nothing else; anything of another length is not one. */
function retiredSeal(value: string | undefined): Uint8Array {
  const sealed = value === undefined ? null : decodeBase64(value);
  if (sealed === null || sealed.length !== SEALED_MASTER_BYTES || sealed[0] !== 1) {
    throw new CryptoError('bad-format', 'the account record carries no usable retired master key');
  }
  return sealed;
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
/** One project key as the account holds it: the key sealed under the master key and bound to the project it belongs to. */
export interface WrappedProjectKey {
  readonly projectId: string;
  /** The bytes {@link createProjectKey} returned, wrapped under the master key being replaced. */
  readonly wrapped: Uint8Array;
}

export interface RotateAccountOptions {
  readonly accountId: string;
  /** The record as it was read, at the version the caller will replace it at. */
  readonly record: AccountKeyRecord;
  /** The passphrase that opens the record now. A rotation keeps the passphrase; what changes is the key under it. */
  readonly passphrase: string;
  readonly resolveKdf: ResolveKdf;
  /** Defaults to the record's descriptor; pass a new one to raise the KDF cost at the same time. */
  readonly newDescriptor?: KdfDescriptor;
  /** Every project key the account holds, so each is re-wrapped under the new master key and no file is re-encrypted. */
  readonly projectKeys?: readonly WrappedProjectKey[];
  readonly random?: RandomBytes;
}

export interface RotationStarted {
  /**
   * The record to store at the version the live one was read at. It opens with the new master key and carries the retired
   * one, so the rotation can be finished after an interruption instead of stranding what is sealed under it.
   */
  readonly record: AccountKeyRecord;
  readonly master: SecretKey;
  /** The master key this rotation retires: still needed to open the account's vault until the rotation finishes. */
  readonly retired: SecretKey;
  /** The new master key as a printable recovery key, shown once before the record is stored. */
  readonly recoveryKey: string;
  readonly projectKeys: readonly WrappedProjectKey[];
}

/** Whether this record is a rotation that has not finished, whatever wrote it. */
export function rotationPending(record: AccountKeyRecord): boolean {
  return record.format === ACCOUNT_RECORD_FORMAT_ROTATING;
}

/**
 * Starts a rotation: it retires the account's master key for a fresh one, re-wraps every project key the caller names under
 * the new key, and returns the record that stores the result. Nothing is written here — the caller replaces the record
 * under the version it read, and the vault re-seal that follows is the one step that can be interrupted and resumed.
 *
 * The passphrase is unchanged, so a writer who forgets the new recovery key can still open the account with it. That is also
 * why a rotation revokes the master key rather than the passphrase: a device that knows the passphrase unlocks again, a device
 * that remembered the retired key does not.
 */
export async function beginAccountRotation(options: RotateAccountOptions): Promise<RotationStarted> {
  if (rotationPending(options.record)) {
    throw new CryptoError('invalid-argument', 'a rotation of this account is waiting to be finished; finish it before starting another');
  }
  const retired = await unlockAccountKeys({ passphrase: options.passphrase, accountId: options.accountId, record: options.record, resolveKdf: options.resolveKdf });
  const descriptor = options.newDescriptor ?? options.record.kdf;
  const kdf = options.resolveKdf(descriptor);
  const salt = generateSalt(options.random);
  const kek = await deriveKek(kdf, options.passphrase, salt);
  const master = generateMasterKey(options.random);
  const wrapped = await wrapMasterKey(kek, master, options.accountId, options.random);
  return {
    record: {
      format: ACCOUNT_RECORD_FORMAT_ROTATING,
      accountId: options.accountId,
      kdf: descriptor,
      salt: encodeBase64(salt),
      wrappedMaster: encodeBase64(wrapped),
      verifier: encodeBase64(await accountVerifier(master, options.accountId)),
      retired: encodeBase64(await aeadSeal(master.export(), associatedData(ROTATE_RETIRED, options.accountId), retired.export(), options.random)),
    },
    master,
    retired,
    recoveryKey: await encodeRecoveryKey(master),
    projectKeys: await rewrapProjectKeys(retired, master, options.projectKeys ?? [], options.random),
  };
}

/**
 * The retired master key of an unfinished rotation, unsealed under the record's own master key. A device that can open the
 * record — with the passphrase, or on the passphrase it remembered — can therefore finish a rotation another device started.
 */
export async function retiredMaster(options: { readonly accountId: string; readonly record: AccountKeyRecord; readonly master: SecretKey }): Promise<SecretKey> {
  requireAccount(options.record, options.accountId);
  const parsed = parseRecord(options.record);
  if (parsed.retired === null) throw new CryptoError('bad-format', 'this account record retires no key');
  return new SecretKey('master', await aeadOpen(options.master.export(), associatedData(ROTATE_RETIRED, options.accountId), parsed.retired));
}

/**
 * Re-wraps project keys under a new master key. The project keys stay the same, so nothing they seal is re-encrypted and no
 * file moves; what changes is which master key opens their wrapped form.
 */
export async function rewrapProjectKeys(retired: SecretKey, master: SecretKey, projectKeys: readonly WrappedProjectKey[], random?: RandomBytes): Promise<WrappedProjectKey[]> {
  const rewrapped: WrappedProjectKey[] = [];
  for (const entry of projectKeys) {
    const project = await unwrapProjectKey(retired, entry.wrapped, entry.projectId);
    rewrapped.push({ projectId: entry.projectId, wrapped: await wrapProjectKey(master, project, entry.projectId, random) });
  }
  return rewrapped;
}

/**
 * The record a finished rotation leaves behind: the same wrapped master key and verifier, with nothing left to retire. It is
 * stored at the version the rotating record occupied, and until that write lands an unfinished rotation can still be resumed.
 */
export function finishAccountRotation(options: { readonly accountId: string; readonly record: AccountKeyRecord }): AccountKeyRecord {
  const { record } = options;
  if (!rotationPending(record)) throw new CryptoError('invalid-argument', 'this account record is not waiting for a rotation to finish');
  requireAccount(record, options.accountId);
  parseRecord(record);
  return { format: ACCOUNT_RECORD_FORMAT, accountId: options.accountId, kdf: record.kdf, salt: record.salt, wrappedMaster: record.wrappedMaster, verifier: record.verifier! };
}
