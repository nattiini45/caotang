/**
 * The Argon2id adapter for the {@link Kdf} port — hosted.md §2. The WASM hash is imported lazily, so it loads
 * only on the setup, unlock and recovery paths and never enters the first-load bundle. The parameters travel
 * with the wrapped key ({@link KdfDescriptor}), so raising the cost later does not strand an existing account.
 */
import { KEY_BYTES } from './aead.js';
import { CryptoError } from './errors.js';
import { ARGON2ID_PROVISIONAL, MIN_SALT_BYTES, type Kdf, type KdfDescriptor } from './kdf.js';

export const ARGON2ID_ID = 'argon2id';

export interface Argon2idParams {
  readonly memoryKiB: number;
  readonly iterations: number;
  readonly parallelism: number;
}

export const ARGON2ID_DEFAULT: Argon2idParams = {
  memoryKiB: ARGON2ID_PROVISIONAL.memoryKiB,
  iterations: ARGON2ID_PROVISIONAL.iterations,
  parallelism: ARGON2ID_PROVISIONAL.parallelism,
};

/**
 * Upper bounds on the cost, so a descriptor read from an account record cannot exhaust the unlocking client.
 * The parameters in a record are plaintext the server can tamper with; far above any sane password hash, these
 * ceilings still refuse a catastrophic allocation or run time: four times the default memory, and a few lanes.
 * The default sits well inside them, leaving room to raise the cost later.
 */
const MAX_MEMORY_KIB = 262_144;
const MAX_ITERATIONS = 10;
const MAX_PARALLELISM = 4;

function assertParams(params: Argon2idParams): void {
  if (!Number.isSafeInteger(params.memoryKiB) || params.memoryKiB < 8 || params.memoryKiB > MAX_MEMORY_KIB) throw new CryptoError('invalid-argument', `Argon2id memory is a whole number from 8 KiB to ${MAX_MEMORY_KIB} KiB`);
  if (!Number.isSafeInteger(params.iterations) || params.iterations < 1 || params.iterations > MAX_ITERATIONS) throw new CryptoError('invalid-argument', `Argon2id iterations are a whole number from 1 to ${MAX_ITERATIONS}`);
  if (!Number.isSafeInteger(params.parallelism) || params.parallelism < 1 || params.parallelism > MAX_PARALLELISM) throw new CryptoError('invalid-argument', `Argon2id parallelism is a whole number from 1 to ${MAX_PARALLELISM}`);
  if (params.memoryKiB < 8 * params.parallelism) throw new CryptoError('invalid-argument', 'Argon2id memory is at least 8 KiB for each lane');
}

/** The descriptor stored beside the wrapped master key. */
export function argon2idDescriptor(params: Argon2idParams = ARGON2ID_DEFAULT): KdfDescriptor {
  assertParams(params);
  return { id: ARGON2ID_ID, params: { memoryKiB: params.memoryKiB, iterations: params.iterations, parallelism: params.parallelism } };
}

/** A Kdf that derives 32 bytes with Argon2id at the given parameters. hash-wasm is loaded on first derive. */
export function createArgon2idKdf(params: Argon2idParams = ARGON2ID_DEFAULT): Kdf {
  assertParams(params);
  return {
    id: ARGON2ID_ID,
    async derive(passphrase, salt) {
      if (salt.length < MIN_SALT_BYTES) throw new CryptoError('invalid-argument', `the salt is at least ${MIN_SALT_BYTES} bytes`);
      const { argon2id } = await import('hash-wasm');
      return argon2id({
        password: passphrase,
        salt,
        memorySize: params.memoryKiB,
        iterations: params.iterations,
        parallelism: params.parallelism,
        hashLength: KEY_BYTES,
        outputType: 'binary',
      });
    },
  };
}

/** Rebuilds the Kdf an account record names, so an unlock uses the parameters the account was set up with. */
export function resolveArgon2idKdf(descriptor: KdfDescriptor): Kdf {
  if (descriptor.id !== ARGON2ID_ID) throw new CryptoError('invalid-argument', `not an Argon2id descriptor: ${descriptor.id}`);
  const { memoryKiB, iterations, parallelism } = descriptor.params;
  if (memoryKiB === undefined || iterations === undefined || parallelism === undefined) throw new CryptoError('bad-format', 'the Argon2id descriptor is missing parameters');
  return createArgon2idKdf({ memoryKiB, iterations, parallelism });
}