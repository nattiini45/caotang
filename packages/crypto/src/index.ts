/**
 * Hosted-instance cryptography — [hosted.md §2–§4, §7](docs/architecture/hosted.md). WebCrypto (AES-256-GCM,
 * HKDF-SHA-256, HMAC-SHA-256, SHA-256) with a lazily loaded Argon2id adapter for the passphrase hash. The
 * account-key orchestration and remember-device are pure over an injectable KDF and device-store port; the
 * browser binds them. Nothing in the local app imports this package.
 */
export { CryptoError, RollbackError, type CryptoErrorCode } from './errors.js';
export { systemRandom, encodeBase64, decodeBase64, type RandomBytes } from './bytes.js';
export { ARGON2ID_PROVISIONAL, MIN_SALT_BYTES, type Kdf, type KdfDescriptor } from './kdf.js';
export {
  ARGON2ID_ID,
  ARGON2ID_DEFAULT,
  argon2idDescriptor,
  createArgon2idKdf,
  resolveArgon2idKdf,
  type Argon2idParams,
} from './argon2id.js';
export {
  INFO_LABELS,
  VAULT_INFO_LABEL,
  SecretKey,
  accountVerifier,
  deriveKek,
  deriveSubkey,
  deriveVaultKey,
  generateMasterKey,
  generateProjectKey,
  generateSalt,
  matchesAccountVerifier,
  unwrapMasterKey,
  unwrapProjectKey,
  wrapMasterKey,
  wrapProjectKey,
  type KeyRole,
  type SubkeyPurpose,
} from './keys.js';
export {
  PROJECT_RECORD_FORMAT_TAG,
  MAX_PROJECT_NAME,
  MAX_SEALED_PROJECT_RECORD,
  sealProjectRecord,
  openProjectRecord,
  sealedProjectRecordLength,
  type ProjectRecord,
  type ProjectRecordContext,
} from './project-record.js';
export {
  ACCOUNT_RECORD_FORMAT,
  ACCOUNT_RECORD_FORMAT_LEGACY,
  ACCOUNT_RECORD_FORMAT_ROTATING,
  beginAccountRotation,
  finishAccountRotation,
  retiredMaster,
  rewrapProjectKeys,
  rotationPending,
  setupAccountKeys,
  unlockAccountKeys,
  unlockWithRecoveryKey,
  changeAccountPassphrase,
  createProjectKey,
  type AccountKeyRecord,
  type RecoveryCheck,
  type ResolveKdf,
  type SetupAccountOptions,
  type SetupAccountResult,
  type ChangePassphraseOptions,
  type RotateAccountOptions,
  type RotationStarted,
  type WrappedProjectKey,
} from './account.js';
export {
  rememberDevice,
  unlockRememberedDevice,
  forgetDevice,
  type DeviceWrapRecord,
  type DeviceWrapStore,
} from './device.js';
export {
  PAD_MIN,
  PAD_STEP,
  openFile,
  openManifest,
  paddedLength,
  sealFile,
  sealManifest,
  sealedLength,
  type FileContext,
  type ManifestContext,
} from './seal.js';
export {
  VAULT_FORMAT_TAG,
  importVaultKey,
  openVault,
  openVaultEntry,
  openVaultEntryWith,
  openVaultWith,
  sealVault,
  sealVaultEntry,
  sealVaultEntryWith,
  sealVaultWith,
  sealedVaultLength,
  type VaultContext,
  type VaultEntryContext,
} from './vault.js';
export { hashPath } from './paths.js';
export { decodeRecoveryKey, encodeRecoveryKey } from './recovery.js';
export { HighWaterMarks } from './highwater.js';