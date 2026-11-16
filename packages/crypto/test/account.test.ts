/**
 * Account-key orchestration: setup, unlock, recovery, passphrase rotation and project-key creation. Most cases
 * use the fast test KDF; one round-trip runs the real Argon2id adapter at a small cost to prove the descriptor
 * travels with the wrapped key and a parameter change does not strand an account.
 */
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_RECORD_FORMAT,
  CryptoError,
  argon2idDescriptor,
  changeAccountPassphrase,
  createProjectKey,
  decodeBase64,
  resolveArgon2idKdf,
  setupAccountKeys,
  unlockAccountKeys,
  unlockWithRecoveryKey,
  unwrapProjectKey,
  type ResolveKdf,
} from '../src/index.js';
import { fastKdf } from './helpers.js';

const resolveFast: ResolveKdf = () => fastKdf;
const descriptor = { id: fastKdf.id, params: {} };

describe('setup and unlock', () => {
  it('wraps the master key under the passphrase and unlocks back to the same bytes', async () => {
    const { record, master, recoveryKey } = await setupAccountKeys({ passphrase: 'a long passphrase', descriptor, resolveKdf: resolveFast });
    expect(record.format).toBe(ACCOUNT_RECORD_FORMAT);
    expect(record.kdf).toEqual(descriptor);
    expect(decodeBase64(record.salt)).toHaveLength(16);
    expect(decodeBase64(record.wrappedMaster).length).toBeGreaterThan(32);
    expect(recoveryKey.length).toBeGreaterThan(0);

    const unlocked = await unlockAccountKeys({ passphrase: 'a long passphrase', record, resolveKdf: resolveFast });
    expect(unlocked.export()).toEqual(master.export());
    expect(unlocked.role).toBe('master');
  });

  it('refuses the wrong passphrase and an empty passphrase', async () => {
    const { record } = await setupAccountKeys({ passphrase: 'right', descriptor, resolveKdf: resolveFast });
    await expect(unlockAccountKeys({ passphrase: 'wrong', record, resolveKdf: resolveFast })).rejects.toBeInstanceOf(CryptoError);
    await expect(setupAccountKeys({ passphrase: '', descriptor, resolveKdf: resolveFast })).rejects.toBeInstanceOf(CryptoError);
  });

  it('refuses a record with an unknown format or a tampered wrap', async () => {
    const { record } = await setupAccountKeys({ passphrase: 'p', descriptor, resolveKdf: resolveFast });
    await expect(unlockAccountKeys({ passphrase: 'p', record: { ...record, format: 99 }, resolveKdf: resolveFast })).rejects.toThrow(/format/);
    const bytes = decodeBase64(record.wrappedMaster);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    const tampered = { ...record, wrappedMaster: Buffer.from(bytes).toString('base64') };
    await expect(unlockAccountKeys({ passphrase: 'p', record: tampered, resolveKdf: resolveFast })).rejects.toBeInstanceOf(CryptoError);
  });
});

describe('recovery', () => {
  it('unlocks to the same master key from the printed recovery key, with no passphrase', async () => {
    const { master, recoveryKey } = await setupAccountKeys({ passphrase: 'p', descriptor, resolveKdf: resolveFast });
    const recovered = await unlockWithRecoveryKey(recoveryKey);
    expect(recovered.export()).toEqual(master.export());
  });

  it('refuses a corrupted recovery key', async () => {
    const { recoveryKey } = await setupAccountKeys({ passphrase: 'p', descriptor, resolveKdf: resolveFast });
    const broken = recoveryKey.slice(0, -2) + (recoveryKey.endsWith('00') ? '11' : '00');
    await expect(unlockWithRecoveryKey(broken)).rejects.toBeInstanceOf(Error);
  });
});

describe('passphrase rotation', () => {
  it('re-wraps the same master key under a new passphrase; the old one stops working and recovery still holds', async () => {
    const setup = await setupAccountKeys({ passphrase: 'old', descriptor, resolveKdf: resolveFast });
    const { record, master } = await changeAccountPassphrase({ oldPassphrase: 'old', newPassphrase: 'new', record: setup.record, resolveKdf: resolveFast });
    expect(master.export()).toEqual(setup.master.export());
    expect((await unlockAccountKeys({ passphrase: 'new', record, resolveKdf: resolveFast })).export()).toEqual(setup.master.export());
    await expect(unlockAccountKeys({ passphrase: 'old', record, resolveKdf: resolveFast })).rejects.toBeInstanceOf(CryptoError);
    expect((await unlockWithRecoveryKey(setup.recoveryKey)).export()).toEqual(setup.master.export());
  });

  it('refuses rotation when the old passphrase is wrong', async () => {
    const { record } = await setupAccountKeys({ passphrase: 'old', descriptor, resolveKdf: resolveFast });
    await expect(changeAccountPassphrase({ oldPassphrase: 'nope', newPassphrase: 'new', record, resolveKdf: resolveFast })).rejects.toBeInstanceOf(CryptoError);
  });
});

describe('project keys', () => {
  it('wraps a fresh project key under the master, bound to the project id', async () => {
    const { master } = await setupAccountKeys({ passphrase: 'p', descriptor, resolveKdf: resolveFast });
    const { projectKey, wrappedProjectKey } = await createProjectKey(master, 'p_ONE');
    expect(projectKey.role).toBe('project');
    expect((await unwrapProjectKey(master, wrappedProjectKey, 'p_ONE')).export()).toEqual(projectKey.export());
    await expect(unwrapProjectKey(master, wrappedProjectKey, 'p_TWO')).rejects.toBeInstanceOf(CryptoError);
    const other = await createProjectKey(master, 'p_ONE');
    expect(other.projectKey.export()).not.toEqual(projectKey.export());
  });
});

describe('the KDF descriptor travels with the wrapped key (real Argon2id)', () => {
  it('unlocks with the parameters the account was set up with, and raises them on rotation without stranding it', async () => {
    const low = argon2idDescriptor({ memoryKiB: 64, iterations: 1, parallelism: 1 });
    const setup = await setupAccountKeys({ passphrase: 'pass', descriptor: low, resolveKdf: resolveArgon2idKdf });
    expect(setup.record.kdf).toEqual(low);
    expect((await unlockAccountKeys({ passphrase: 'pass', record: setup.record, resolveKdf: resolveArgon2idKdf })).export()).toEqual(setup.master.export());

    const high = argon2idDescriptor({ memoryKiB: 128, iterations: 2, parallelism: 1 });
    const rotated = await changeAccountPassphrase({ oldPassphrase: 'pass', newPassphrase: 'pass2', record: setup.record, resolveKdf: resolveArgon2idKdf, newDescriptor: high });
    expect(rotated.record.kdf).toEqual(high);
    expect((await unlockAccountKeys({ passphrase: 'pass2', record: rotated.record, resolveKdf: resolveArgon2idKdf })).export()).toEqual(setup.master.export());
    // The original record still unlocks at its own stored cost, independent of the rotation.
    expect((await unlockAccountKeys({ passphrase: 'pass', record: setup.record, resolveKdf: resolveArgon2idKdf })).export()).toEqual(setup.master.export());
  });
});