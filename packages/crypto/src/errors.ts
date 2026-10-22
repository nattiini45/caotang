export type CryptoErrorCode =
  /** A caller passed a value the primitive cannot take (a key of the wrong length, a negative version). */
  | 'invalid-argument'
  /** The bytes are not in the sealed format (wrong tag, too short, non-canonical padding). */
  | 'bad-format'
  /** The data did not authenticate. AES-GCM cannot tell a wrong key from a wrong context from an altered byte, so neither does this. */
  | 'unauthentic'
  /** A recovery key was typed with a mistake in it. */
  | 'bad-checksum'
  /** A server served a version older than one this device has already seen. */
  | 'rollback';

export class CryptoError extends Error {
  constructor(
    readonly code: CryptoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CryptoError';
  }
}

export class RollbackError extends CryptoError {
  constructor(
    readonly key: string,
    readonly served: number,
    readonly seen: number,
  ) {
    super('rollback', `the server served version ${served} of ${key}, but this device has already seen version ${seen}`);
    this.name = 'RollbackError';
  }
}
