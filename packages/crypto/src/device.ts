/**
 * Remember this device (P8) — [hosted.md §2](../../../docs/architecture/hosted.md), plan §4.4. After the first
 * passphrase unlock the master key is wrapped under a non-extractable WebCrypto key kept on the device, so the
 * passphrase is needed once per device. The wrapping key never leaves as bytes; script in the page can use it
 * while the app is open, the same limit as the provider-key vault. The storage is a port; the browser binds it
 * to IndexedDB. Signing out everywhere revokes the session, and {@link forgetDevice} removes the wrapping key.
 */
import { KEY_BYTES, NONCE_BYTES, TAG_BYTES } from './aead.js';
import { buf, concat, systemRandom, utf8, type RandomBytes } from './bytes.js';
import { CryptoError } from './errors.js';
import { SecretKey } from './keys.js';

const REMEMBER_AD = utf8('caotang/v1/remember-device');

/** The non-extractable wrapping key and the master key sealed under it, as the device keeps them. */
export interface DeviceWrapRecord {
  readonly key: CryptoKey;
  /** nonce(12) ‖ ciphertext ‖ tag(16). */
  readonly wrapped: Uint8Array;
}

/** Where the device keeps its wrapping key. The browser implements this over IndexedDB. */
export interface DeviceWrapStore {
  load(): Promise<DeviceWrapRecord | null>;
  save(record: DeviceWrapRecord): Promise<void>;
  clear(): Promise<void>;
}

/** Wraps the master key under a fresh non-extractable device key and stores it. */
export async function rememberDevice(master: SecretKey, store: DeviceWrapStore, random: RandomBytes = systemRandom): Promise<void> {
  if (master.role !== 'master') throw new CryptoError('invalid-argument', 'remember-device wraps the master key');
  const key = await globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: KEY_BYTES * 8 }, false, ['encrypt', 'decrypt']);
  const nonce = random(NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES) throw new CryptoError('invalid-argument', 'the nonce source returned the wrong length');
  const sealed = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: buf(nonce), additionalData: buf(REMEMBER_AD), tagLength: TAG_BYTES * 8 },
    key,
    buf(master.export()),
  );
  await store.save({ key, wrapped: concat(nonce, new Uint8Array(sealed)) });
}

/** Returns the master key the device remembers, or null when it remembers none. */
export async function unlockRememberedDevice(store: DeviceWrapStore): Promise<SecretKey | null> {
  const record = await store.load();
  if (record === null) return null;
  const { key, wrapped } = record;
  if (wrapped.length < NONCE_BYTES + TAG_BYTES) throw new CryptoError('bad-format', 'the remembered key is too short');
  const nonce = wrapped.subarray(0, NONCE_BYTES);
  const body = wrapped.subarray(NONCE_BYTES);
  try {
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buf(nonce), additionalData: buf(REMEMBER_AD), tagLength: TAG_BYTES * 8 },
      key,
      buf(body),
    );
    return new SecretKey('master', new Uint8Array(plain));
  } catch {
    throw new CryptoError('unauthentic', 'the remembered key did not authenticate');
  }
}

/** Removes the device's wrapping key; the next unlock needs the passphrase again. */
export async function forgetDevice(store: DeviceWrapStore): Promise<void> {
  await store.clear();
}