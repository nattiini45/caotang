/**
 * Key storage — [provider-gateway.md §7](docs/architecture/provider-gateway.md).
 *
 * Each API key is sealed with AES-GCM under one wrapping key that is generated
 * non-extractable, so script cannot export it: `crypto.subtle.exportKey` throws. The
 * sealed bytes live in a `KeyVaultPort`, which is outside any project data (§7: keys
 * "never written to any file in the project artifact").
 *
 * Two details carry weight. The IV is fresh per seal, so sealing the same key twice
 * produces different bytes. And the profile id is bound in as additional authenticated
 * data, so an entry copied from one profile to another fails to open. Without that
 * binding, anything that can write to the vault could move a key to a profile that
 * points at an endpoint the user did not intend it for.
 *
 * **Payload versions.** v1 entries sealed the bare key bytes. v2 seals a JSON payload
 * `{v: 2, apiKey, customHeaders?}` so a generic profile's custom headers are sealed
 * with the key they travel beside. A v1 entry decodes transparently on reveal and is
 * lazily rewritten as v2 under a fresh IV — nothing is re-sealed under the old bytes.
 *
 * What this does not do is in §7's threat model: it protects against dumped storage,
 * not against script in the app origin, which can call `decrypt` while the app is open.
 */

import type { KeyVaultPort } from './vault.js';

/** What is sealed for one profile: the API key, plus the generic profile's custom headers. */
export interface KeyPayload {
  readonly apiKey: string;
  /** Sealed extra headers a generic endpoint sends. Present only when headers were set. */
  readonly customHeaders?: Readonly<Record<string, string>>;
}

export interface KeyStore {
  /** Seals and stores the key for `profileId`, replacing any earlier one. */
  put(profileId: string, apiKey: string): Promise<void>;
  /** Seals and stores a full payload — key plus custom headers — for `profileId`. */
  putPayload(profileId: string, payload: KeyPayload): Promise<void>;
  /**
   * Opens the stored key. Only the transport calls this, and only for a request it is
   * about to send. Returns undefined when nothing is stored, or when the entry or the
   * wrapping key cannot be read (a cleared site-data store, say). The caller decides
   * what to tell the user.
   */
  reveal(profileId: string): Promise<string | undefined>;
  /** Opens the stored payload — key and custom headers. Same rules as {@link KeyStore.reveal}. */
  revealPayload(profileId: string): Promise<KeyPayload | undefined>;
  has(profileId: string): Promise<boolean>;
  remove(profileId: string): Promise<void>;
}

export interface KeyStoreOptions {
  subtle?: SubtleCrypto;
  randomBytes?: (n: number) => Uint8Array<ArrayBuffer>;
}

const IV_BYTES = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Domain separation: the same profile id under another purpose cannot produce a valid tag. */
function additionalData(profileId: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`caotang:provider-key:${profileId}`);
}

function defaultRandomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** The v2 plaintext: a JSON envelope. `customHeaders` is written only when it holds entries. */
function encodePayload(payload: KeyPayload): Uint8Array<ArrayBuffer> {
  const headers = payload.customHeaders;
  const body: { v: 2; apiKey: string; customHeaders?: Record<string, string> } = { v: 2, apiKey: payload.apiKey };
  if (headers !== undefined && Object.keys(headers).length > 0) body.customHeaders = { ...headers };
  return encoder.encode(JSON.stringify(body));
}

/** Decodes sealed plaintext: a v2 envelope, or a v1 bare key (which never starts with `{`). */
function decodePayload(plain: string): { payload: KeyPayload; legacy: boolean } {
  if (plain.startsWith('{')) {
    try {
      const parsed = JSON.parse(plain) as { v?: unknown; apiKey?: unknown; customHeaders?: unknown };
      if (parsed.v === 2 && typeof parsed.apiKey === 'string') {
        const headers = parsed.customHeaders;
        return {
          payload: {
            apiKey: parsed.apiKey,
            ...(headers !== null && typeof headers === 'object' ? { customHeaders: { ...(headers as Record<string, string>) } } : {}),
          },
          legacy: false,
        };
      }
    } catch {
      // A key that happens to start with '{' but is not a v2 envelope is a v1 key.
    }
  }
  return { payload: { apiKey: plain }, legacy: true };
}

export function createKeyStore(port: KeyVaultPort, options: KeyStoreOptions = {}): KeyStore {
  const subtle = options.subtle ?? globalThis.crypto.subtle;
  const randomBytes = options.randomBytes ?? defaultRandomBytes;

  // Resolved at most once per store, so two concurrent first saves in one tab share one key.
  // Across tabs the vault arbitrates: a candidate is generated, and `putWrappingKeyIfAbsent`
  // returns whichever key is stored, so every tab converges on the same one. A lookup that
  // failed is not kept: the vault may only have been briefly unavailable, so the next call
  // tries again.
  let ensuring: Promise<CryptoKey> | undefined;
  const ensureWrappingKey = (): Promise<CryptoKey> => {
    ensuring ??= (async () => {
      const existing = await port.getWrappingKey();
      if (existing !== undefined) return existing;
      const candidate = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      return port.putWrappingKeyIfAbsent(candidate);
    })().catch((error: unknown) => {
      ensuring = undefined;
      throw error;
    });
    return ensuring;
  };

  const seal = async (profileId: string, payload: KeyPayload): Promise<void> => {
    const key = await ensureWrappingKey();
    const iv = randomBytes(IV_BYTES);
    const sealed = await subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData(profileId) },
      key,
      encodePayload(payload),
    );
    await port.putEntry(profileId, { iv, ciphertext: new Uint8Array(sealed) });
  };

  const open = async (profileId: string): Promise<KeyPayload | undefined> => {
    const entry = await port.getEntry(profileId);
    if (entry === undefined) return undefined;
    const key = await port.getWrappingKey();
    if (key === undefined) return undefined;
    let plain: string;
    try {
      const opened = await subtle.decrypt(
        { name: 'AES-GCM', iv: entry.iv, additionalData: additionalData(profileId) },
        key,
        entry.ciphertext,
      );
      plain = decoder.decode(opened);
    } catch {
      // A failed tag check means the entry is corrupt or was moved between profiles.
      // Either way the honest answer is "no usable key", not a partial one.
      return undefined;
    }
    const { payload, legacy } = decodePayload(plain);
    if (legacy) {
      // v1 → v2 lazy migration: re-seal under a fresh IV. A failed rewrite leaves the
      // readable v1 entry where it was, which is safe to try again next time.
      try {
        await seal(profileId, payload);
      } catch {
        // The reveal still answered; the migration retries on the next reveal.
      }
    }
    return payload;
  };

  return {
    async put(profileId, apiKey) {
      await seal(profileId, { apiKey });
    },

    async putPayload(profileId, payload) {
      await seal(profileId, payload);
    },

    async reveal(profileId) {
      return (await open(profileId))?.apiKey;
    },

    async revealPayload(profileId) {
      return open(profileId);
    },

    async has(profileId) {
      return (await port.getEntry(profileId)) !== undefined;
    },

    async remove(profileId) {
      await port.deleteEntry(profileId);
    },
  };
}
