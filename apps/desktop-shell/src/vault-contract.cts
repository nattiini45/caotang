/**
 * The key vault the preload exposes: put, delete, a presence check, a revision, and the extra header values stored beside a
 * key. There is no read, and that is the point ([desktop.md §The keychain](../../../docs/architecture/desktop.md#the-keychain-404)):
 * a page can store a secret, remove it, and ask whether one is there, and it can never take one out.
 */

export type VaultError = 'invalid' | 'unavailable';

export type VaultReply<T> = { readonly ok: true; readonly value: T } | {
  readonly ok: false;
  readonly error: VaultError;
};

/** What a key is stored as: the secret, and the extra headers a generic endpoint sends beside it. */
export interface VaultPayload {
  readonly apiKey: string;
  readonly customHeaders?: Readonly<Record<string, string>>;
}

export interface KeyVaultBridge {
  /** Whether this machine has a keychain the app can use. False means the browser's own vault stays in use. */
  available(): Promise<VaultReply<boolean>>;
  put(id: string, payload: VaultPayload, origin: string): Promise<VaultReply<null>>;
  /**
   * Stores the key a writer typed again for an endpoint they moved. The address moves with the key, and only this call may
   * move one: a key the page did not enter for the new address is refused (#864).
   */
  putReplacement(id: string, payload: VaultPayload, origin: string): Promise<VaultReply<null>>;
  /**
   * Gives a key the vault already holds and that has no address yet the one its profile names. This is the upgrade for keys
   * stored before the pairings existed, and it never moves a key that already has an address.
   */
  bind(id: string, origin: string): Promise<VaultReply<null>>;
  /**
   * Replaces the extra headers of a stored key and keeps its secret. What an edit that changes only the headers calls, because the
   * key it read is a handle and storing that handle would overwrite the key (#863).
   */
  putHeaders(id: string, headers: Readonly<Record<string, string>>): Promise<VaultReply<null>>;
  remove(id: string): Promise<VaultReply<null>>;
  has(id: string): Promise<VaultReply<boolean>>;
  /** A digest of what is stored under `id`, so a caller can tell one save from the next. */
  revision(id: string): Promise<VaultReply<string>>;
  /** Puts back what the last `put` for `id` replaced: the one undo a page has without a read. */
  restore(id: string): Promise<VaultReply<null>>;
  /** The extra header values stored with `id`, and null when nothing is stored there. Never the key. */
  headers(id: string): Promise<VaultReply<Readonly<Record<string, string>> | null>>;
}
