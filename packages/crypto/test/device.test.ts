/**
 * Remember this device (P8): the master key wrapped under a non-extractable device key. The store is a port, so
 * these tests bind it to memory; the browser binds it to IndexedDB. The wrapping key must never be extractable.
 */
import { describe, expect, it } from 'vitest';
import {
  CryptoError,
  SecretKey,
  forgetDevice,
  rememberDevice,
  unlockRememberedDevice,
  type DeviceWrapRecord,
  type DeviceWrapStore,
} from '../src/index.js';

class MemoryStore implements DeviceWrapStore {
  record: DeviceWrapRecord | null = null;
  async load(): Promise<DeviceWrapRecord | null> {
    return this.record;
  }
  async save(record: DeviceWrapRecord): Promise<void> {
    this.record = record;
  }
  async clear(): Promise<void> {
    this.record = null;
  }
}

const master = (): SecretKey => new SecretKey('master', Uint8Array.from({ length: 32 }, (_, i) => i));

describe('remember this device', () => {
  it('wraps the master key and unlocks back to the same bytes', async () => {
    const store = new MemoryStore();
    const key = master();
    await rememberDevice(key, store);
    const unlocked = await unlockRememberedDevice(store);
    expect(unlocked?.export()).toEqual(key.export());
    expect(unlocked?.role).toBe('master');
  });

  it('keeps the wrapping key non-extractable, usable only to encrypt and decrypt', async () => {
    const store = new MemoryStore();
    await rememberDevice(master(), store);
    const wrapping = store.record!.key;
    expect(wrapping.extractable).toBe(false);
    expect(wrapping.type).toBe('secret');
    expect([...wrapping.usages].sort()).toEqual(['decrypt', 'encrypt']);
    expect(store.record!.wrapped).toHaveLength(12 + 32 + 16);
  });

  it('returns null when the device remembers nothing, and after forgetting', async () => {
    const store = new MemoryStore();
    expect(await unlockRememberedDevice(store)).toBeNull();
    await rememberDevice(master(), store);
    await forgetDevice(store);
    expect(store.record).toBeNull();
    expect(await unlockRememberedDevice(store)).toBeNull();
  });

  it('refuses a tampered wrap and a truncated one', async () => {
    const store = new MemoryStore();
    await rememberDevice(master(), store);
    const wrapped = store.record!.wrapped.slice();
    wrapped[wrapped.length - 1] = (wrapped[wrapped.length - 1] ?? 0) ^ 1;
    store.record = { key: store.record!.key, wrapped };
    await expect(unlockRememberedDevice(store)).rejects.toBeInstanceOf(CryptoError);
    store.record = { key: store.record!.key, wrapped: new Uint8Array(4) };
    await expect(unlockRememberedDevice(store)).rejects.toThrow(/short/);
  });

  it('refuses to wrap a key that is not the master key', async () => {
    const store = new MemoryStore();
    await expect(rememberDevice(new SecretKey('project', new Uint8Array(32)), store)).rejects.toBeInstanceOf(CryptoError);
  });

  it('uses a fresh wrapping key each time', async () => {
    const a = new MemoryStore();
    const b = new MemoryStore();
    const key = master();
    await rememberDevice(key, a);
    await rememberDevice(key, b);
    expect(a.record!.wrapped).not.toEqual(b.record!.wrapped);
    expect((await unlockRememberedDevice(a))?.export()).toEqual(key.export());
    expect((await unlockRememberedDevice(b))?.export()).toEqual(key.export());
  });
});