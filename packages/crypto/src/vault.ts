/**
 * The sealed provider-key vault — hosted.md §2.4 and §2.5, plan §4.5. Provider keys and the profiles they belong to
 * live under a key derived from the master key under a label no project key uses, so a vault value can never be opened
 * as a file and the reverse. Plaintext keys never leave the browser unsealed: the server stores one opaque object per
 * account and cannot tell which profiles exist.
 *
 * Two seals, for two different mistakes. The outer seal binds the whole vault to the account and the version the server
 * holds, so a replayed or moved vault fails to open. Each profile's entry carries its own seal bound to the account, the
 * profile id and the endpoint origin, so a key cannot be read as another profile's, or as the same provider at another
 * address — a bug or an altered manifest inside the page fails the same way an altered byte does.
 */
import { NONCE_BYTES, TAG_BYTES, aeadOpen, aeadSeal, associatedData } from './aead.js';
import { type RandomBytes } from './bytes.js';
import { CryptoError } from './errors.js';
import { deriveVaultKey, type SecretKey } from './keys.js';

/** The vault's own format byte, so a vault value is refused by the file and manifest readers and the reverse. */
export const VAULT_FORMAT_TAG = 2;

/** What the whole vault is bound to: the account, and the version the server holds it at. */
export interface VaultContext {
  readonly accountId: string;
  readonly version: number;
}

/** What one profile's entry is bound to: the account, the profile, and the endpoint it may be sent to. */
export interface VaultEntryContext {
  readonly accountId: string;
  readonly profileId: string;
  readonly origin: string;
}

function vaultAd(ctx: VaultContext): Uint8Array {
  if (!Number.isSafeInteger(ctx.version) || ctx.version < 1) {
    throw new CryptoError('invalid-argument', `a vault version is a positive integer, not ${ctx.version}`);
  }
  return associatedData('caotang/v1/vault', ctx.accountId, ctx.version);
}

function entryAd(ctx: VaultEntryContext): Uint8Array {
  return associatedData('caotang/v1/vault-entry', ctx.accountId, ctx.profileId, ctx.origin);
}

/** Seals one profile's key material under the vault key. */
export async function sealVaultEntry(master: SecretKey, ctx: VaultEntryContext, entry: Uint8Array, random?: RandomBytes): Promise<Uint8Array> {
  return aeadSeal(await deriveVaultKey(master), entryAd(ctx), entry, random, VAULT_FORMAT_TAG);
}

/** Refuses an entry sealed for another account, another profile or another origin, and any altered byte. */
export async function openVaultEntry(master: SecretKey, ctx: VaultEntryContext, sealed: Uint8Array): Promise<Uint8Array> {
  return aeadOpen(await deriveVaultKey(master), entryAd(ctx), sealed, VAULT_FORMAT_TAG);
}

/**
 * Seals the vault itself at one version. `entries` is the caller's own layout of already sealed profile entries; the
 * vault key never sees a plaintext provider key.
 */
export async function sealVault(master: SecretKey, ctx: VaultContext, entries: Uint8Array, random?: RandomBytes): Promise<Uint8Array> {
  return aeadSeal(await deriveVaultKey(master), vaultAd(ctx), entries, random, VAULT_FORMAT_TAG);
}

/** Refuses a vault from another account or another version, and any altered byte. */
export async function openVault(master: SecretKey, ctx: VaultContext, sealed: Uint8Array): Promise<Uint8Array> {
  return aeadOpen(await deriveVaultKey(master), vaultAd(ctx), sealed, VAULT_FORMAT_TAG);
}

/** What the server stores for a vault of this many plaintext bytes; an empty vault is one sealed block. */
export function sealedVaultLength(plaintextLength: number): number {
  return 1 + NONCE_BYTES + plaintextLength + TAG_BYTES;
}
