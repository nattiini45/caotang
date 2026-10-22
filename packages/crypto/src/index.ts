/**
 * Hosted-instance cryptography — [hosted.md §2–§4, §7](docs/architecture/hosted.md). Specified, not built: nothing in the
 * app imports this package. WebCrypto only (AES-256-GCM, HKDF-SHA-256, HMAC-SHA-256, SHA-256); the passphrase hash is
 * the injected {@link Kdf}.
 */
export { CryptoError, RollbackError, type CryptoErrorCode } from './errors.js';
export { systemRandom, type RandomBytes } from './bytes.js';
export { ARGON2ID_PROVISIONAL, MIN_SALT_BYTES, type Kdf } from './kdf.js';
export {
  INFO_LABELS,
  SecretKey,
  deriveKek,
  deriveSubkey,
  generateMasterKey,
  generateProjectKey,
  generateSalt,
  unwrapMasterKey,
  unwrapProjectKey,
  wrapMasterKey,
  wrapProjectKey,
  type KeyRole,
  type SubkeyPurpose,
} from './keys.js';
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
export { hashPath } from './paths.js';
export { decodeRecoveryKey, encodeRecoveryKey } from './recovery.js';
export { HighWaterMarks } from './highwater.js';
