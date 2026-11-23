/**
 * The storage port behind the key store, and its in-memory binding.
 *
 * A port holds two things: the wrapping key (a non-extractable `CryptoKey`, which the
 * browser stores as-is) and the sealed entries keyed by profile id. It holds nothing
 * that is readable without the wrapping key, so a port can be inspected, copied, or
 * dumped without exposing a credential.
 */

export interface SealedEntry {
  readonly iv: Uint8Array<ArrayBuffer>;
  /** AES-GCM output, tag included */
  readonly ciphertext: Uint8Array<ArrayBuffer>;
}

export interface KeyVaultPort {
  getWrappingKey(): Promise<CryptoKey | undefined>;
  /**
   * Stores `candidate` as the wrapping key only if none is stored, and returns the key that
   * is stored afterwards. Two tabs can both find the vault empty and both generate a key.
   * A plain overwrite would let the later one strand every entry sealed under the earlier,
   * so the check and the write are one atomic step, and the loser adopts the winner.
   */
  putWrappingKeyIfAbsent(candidate: CryptoKey): Promise<CryptoKey>;
  getEntry(profileId: string): Promise<SealedEntry | undefined>;
  /**
   * Every id the vault holds an entry for. Optional because a port does not have to enumerate itself: a host that migrates
   * away from this vault needs the list once, and a port without it reports that it cannot say.
   */
  listEntryIds?(): Promise<readonly string[]>;
  putEntry(profileId: string, entry: SealedEntry): Promise<void>;
  deleteEntry(profileId: string): Promise<void>;
}

/**
 * Keeps everything in a `Map`. For tests, and for hosts with no IndexedDB. The entries
 * are copied on the way in and out, so a caller that keeps a reference cannot change
 * what the vault later returns.
 */
export function createMemoryVaultPort(): KeyVaultPort {
  let wrapping: CryptoKey | undefined;
  const entries = new Map<string, SealedEntry>();

  return {
    async getWrappingKey() {
      return wrapping;
    },
    async putWrappingKeyIfAbsent(candidate) {
      wrapping ??= candidate;
      return wrapping;
    },
    async getEntry(profileId) {
      const entry = entries.get(profileId);
      if (entry === undefined) return undefined;
      return { iv: new Uint8Array(entry.iv), ciphertext: new Uint8Array(entry.ciphertext) };
    },
    async putEntry(profileId, entry) {
      entries.set(profileId, { iv: new Uint8Array(entry.iv), ciphertext: new Uint8Array(entry.ciphertext) });
    },
    async deleteEntry(profileId) {
      entries.delete(profileId);
    },
  };
}
