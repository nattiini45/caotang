/**
 * The passphrase-to-key step, as a port. hosted.md §2 specifies Argon2id here; the adapter is a Phase 1
 * decision (a WASM dependency whose bundle size is measured first), so this package ships none. A test passes
 * a fast stand-in, and the port is the only place a slow hash enters.
 */
export interface Kdf {
  /** Names the algorithm and its parameters, for the record kept beside the wrapped master key. */
  readonly id: string;
  /** 32 bytes derived from the passphrase (already NFKC-normalised and UTF-8 encoded) and the per-account salt. */
  derive(passphrase: Uint8Array, salt: Uint8Array): Promise<Uint8Array>;
}

/** The Argon2id parameters hosted.md §2 starts from. Provisional until measured on low-end phones. */
export const ARGON2ID_PROVISIONAL = { memoryKiB: 64 * 1024, iterations: 3, parallelism: 1 } as const;

export const MIN_SALT_BYTES = 16;
