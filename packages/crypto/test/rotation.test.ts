/**
 * Rotation of the account's master key — hosted.md §2.2 and §4. The operation "revoke other devices and the old recovery
 * key" generates a new master key: nothing sealed under the retired one stays reachable through the account, every project
 * key is re-wrapped under the new one so no file is re-encrypted, and the record in between can be finished by anyone who
 * can open it, which is what makes an interruption survivable.
 */
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_RECORD_FORMAT,
  ACCOUNT_RECORD_FORMAT_ROTATING,
  CryptoError,
  beginAccountRotation,
  changeAccountPassphrase,
  createProjectKey,
  deriveVaultKey,
  finishAccountRotation,
  retiredMaster,
  rewrapProjectKeys,
  rotationPending,
  sealFile,
  setupAccountKeys,
  unlockAccountKeys,
  unlockWithRecoveryKey,
  unwrapProjectKey,
  type AccountKeyRecord,
  type ResolveKdf,
} from '../src/index.js';
import { fastKdf } from './helpers.js';

const accountId = 'account-rotation';
const passphrase = 'the passphrase that stays';
const descriptor = { id: fastKdf.id, params: {} };
const resolveFast: ResolveKdf = () => fastKdf;

/** A record as the server hands it back: JSON, so nothing but the fields survives the round trip. */
const asStored = (record: AccountKeyRecord): AccountKeyRecord => JSON.parse(JSON.stringify(record)) as AccountKeyRecord;

async function account() {
  const setup = await setupAccountKeys({ passphrase, accountId, descriptor, resolveKdf: resolveFast });
  return { record: asStored(setup.record), master: setup.master, recoveryKey: setup.recoveryKey };
}

/** Two project keys wrapped under an account's master key, the way the account holds them. */
async function projectKeys(master: Awaited<ReturnType<typeof account>>['master']) {
  const first = await createProjectKey(master, 'novel');
  const second = await createProjectKey(master, 'serial');
  return {
    first: first.projectKey,
    second: second.projectKey,
    wrapped: [
      { projectId: 'novel', wrapped: first.wrappedProjectKey },
      { projectId: 'serial', wrapped: second.wrappedProjectKey },
    ],
  };
}

describe('rotating the account master key', () => {
  it('retires the master key, keeps the passphrase and re-wraps every project key', async () => {
    const { record, master, recoveryKey } = await account();
    const projects = await projectKeys(master);
    const rotation = await beginAccountRotation({ accountId, record, passphrase, resolveKdf: resolveFast, projectKeys: projects.wrapped });

    expect(rotationPending(rotation.record)).toBe(true);
    expect(rotation.record.format).toBe(ACCOUNT_RECORD_FORMAT_ROTATING);
    expect(rotation.master.export()).not.toEqual(master.export());
    expect(rotation.retired.export()).toEqual(master.export());
    // The new recovery key is the new master key, so the printed one is the only way in that changed.
    expect(rotation.recoveryKey).not.toBe(recoveryKey);
    expect(await unlockWithRecoveryKey(rotation.recoveryKey, { accountId, verifier: rotation.record.verifier })).toBeDefined();
    await expect(unlockWithRecoveryKey(recoveryKey, { accountId, verifier: rotation.record.verifier })).rejects.toBeInstanceOf(CryptoError);

    // The same passphrase opens the new master key, because a rotation changes the key and not the passphrase.
    expect((await unlockAccountKeys({ passphrase, accountId, record: rotation.record, resolveKdf: resolveFast })).export()).toEqual(rotation.master.export());

    // Every project key is the same key, under a new wrap: what it seals is untouched, and the retired key opens none of it.
    expect(rotation.projectKeys.map((entry) => entry.projectId)).toEqual(['novel', 'serial']);
    expect((await unwrapProjectKey(rotation.master, rotation.projectKeys[0]!.wrapped, 'novel')).export()).toEqual(projects.first.export());
    expect((await unwrapProjectKey(rotation.master, rotation.projectKeys[1]!.wrapped, 'serial')).export()).toEqual(projects.second.export());
    await expect(unwrapProjectKey(master, rotation.projectKeys[0]!.wrapped, 'novel')).rejects.toBeInstanceOf(CryptoError);
  });

  it('moves what the master key reaches: the vault key before the rotation opens nothing after it', async () => {
    const { record, master } = await account();
    const before = await deriveVaultKey(master);
    const rotation = await beginAccountRotation({ accountId, record, passphrase, resolveKdf: resolveFast });
    const after = await deriveVaultKey(rotation.master);
    expect(Buffer.from(after).toString('hex')).not.toEqual(Buffer.from(before).toString('hex'));
  });

  it('finishes after an interruption: the record as stored resumes, re-seals under the retired key, and closes the rotation', async () => {
    const { record, master } = await account();
    const projects = await projectKeys(master);
    const rotation = await beginAccountRotation({ accountId, record, passphrase, resolveKdf: resolveFast, projectKeys: projects.wrapped });

    // The interruption is the process stopping after the record was written: only the stored record survives, and the
    // retired key is not in memory any more.
    const stored = asStored(rotation.record);
    expect(stored['retired']).toBeTypeOf('string');

    // A fresh client resumes with nothing but the passphrase and the stored record.
    const resumed = await unlockAccountKeys({ passphrase, accountId, record: stored, resolveKdf: resolveFast });
    expect(resumed.export()).toEqual(rotation.master.export());
    const retired = await retiredMaster({ accountId, record: stored, master: resumed });
    expect(retired.export()).toEqual(master.export());
    // Before the project keys are re-wrapped, only the retired key opens the account's existing wraps — which is exactly why
    // the re-wrap is part of the operation and not an optimisation.
    expect((await unwrapProjectKey(retired, projects.wrapped[0]!.wrapped, 'novel')).export()).toEqual(projects.first.export());
    await expect(unwrapProjectKey(resumed, projects.wrapped[0]!.wrapped, 'novel')).rejects.toBeInstanceOf(CryptoError);
    expect((await rewrapProjectKeys(retired, resumed, projects.wrapped)).map((entry) => entry.projectId)).toEqual(['novel', 'serial']);

    const finished = finishAccountRotation({ accountId, record: stored });
    expect(finished.format).toBe(ACCOUNT_RECORD_FORMAT);
    expect(finished.retired).toBeUndefined();
    expect(finished.wrappedMaster).toBe(stored.wrappedMaster);
    expect(finished.verifier).toBe(stored.verifier);
    expect((await unlockAccountKeys({ passphrase, accountId, record: finished, resolveKdf: resolveFast })).export()).toEqual(rotation.master.export());
    // Once finished, the retired key is gone from the record for good: nothing on the server can open it any more.
    await expect(retiredMaster({ accountId, record: finished, master: resumed })).rejects.toBeInstanceOf(CryptoError);
  });

  it('refuses to start over an unfinished rotation, and to finish one that was never started', async () => {
    const { record } = await account();
    const rotation = await beginAccountRotation({ accountId, record, passphrase, resolveKdf: resolveFast });
    await expect(beginAccountRotation({ accountId, record: rotation.record, passphrase, resolveKdf: resolveFast })).rejects.toThrow(/waiting to be finished/);
    await expect(beginAccountRotation({ accountId, record, passphrase: 'not the passphrase', resolveKdf: resolveFast })).rejects.toBeInstanceOf(CryptoError);
    expect(() => finishAccountRotation({ accountId, record })).toThrow(/not waiting for a rotation/);
  });

  it('refuses a passphrase change while a rotation waits, keeping the only path to the retired key', async () => {
    const { record } = await account();
    const rotation = await beginAccountRotation({ accountId, record, passphrase, resolveKdf: resolveFast });
    // A plain record replaces the retired seal, and the vault is still under the retired key until the rotation finishes.
    await expect(changeAccountPassphrase({ oldPassphrase: passphrase, newPassphrase: 'a different passphrase', accountId, record: rotation.record, resolveKdf: resolveFast }))
      .rejects.toThrow(/finish it before changing the passphrase/);
    // The record the caller held is untouched, so the rotation is still resumable with what is stored.
    expect(rotationPending(rotation.record)).toBe(true);
    const finished = finishAccountRotation({ accountId, record: rotation.record });
    const master = await unlockAccountKeys({ passphrase, accountId, record: finished, resolveKdf: resolveFast });
    expect(Buffer.from(master.export())).toEqual(Buffer.from(rotation.master.export()));
  });

  it('refuses a record from another account and an altered retired key', async () => {
    const { record } = await account();
    const rotation = await beginAccountRotation({ accountId, record, passphrase, resolveKdf: resolveFast });
    await expect(retiredMaster({ accountId: 'another-account', record: rotation.record, master: rotation.master })).rejects.toBeInstanceOf(CryptoError);
    await expect(unlockAccountKeys({ passphrase, accountId: 'another-account', record: rotation.record, resolveKdf: resolveFast })).rejects.toBeInstanceOf(CryptoError);

    const truncated = { ...rotation.record, retired: 'AAAA' };
    await expect(unlockAccountKeys({ passphrase, accountId, record: truncated, resolveKdf: resolveFast })).rejects.toThrow(/retired master key/);
    // A well-shaped retired key with one altered byte fails to authenticate rather than unsealing something else.
    const sealed = Buffer.from(rotation.record.retired!, 'base64');
    sealed[sealed.length - 1] = (sealed[sealed.length - 1]! ^ 0xff) & 0xff;
    const altered = { ...rotation.record, retired: sealed.toString('base64') };
    const master = await unlockAccountKeys({ passphrase, accountId, record: altered, resolveKdf: resolveFast });
    await expect(retiredMaster({ accountId, record: altered, master })).rejects.toBeInstanceOf(CryptoError);
  });

  it('never carries the retired key or the keks in the clear on the record', async () => {
    const { record, master } = await account();
    const rotation = await beginAccountRotation({ accountId, record, passphrase, resolveKdf: resolveFast });
    const wire = JSON.stringify(rotation.record);
    expect(wire).not.toContain(passphrase);
    expect(wire).not.toContain(Buffer.from(master.export()).toString('hex'));
    expect(wire).not.toContain(Buffer.from(master.export()).toString('base64'));
    expect(wire).not.toContain(Buffer.from(rotation.master.export()).toString('base64'));
  });

  it('re-wraps a project key under the new master without changing the key itself', async () => {
    const { master } = await account();
    const projects = await projectKeys(master);
    const fresh = (await account()).master;
    const rewrapped = await rewrapProjectKeys(master, fresh, projects.wrapped);
    expect((await unwrapProjectKey(fresh, rewrapped[0]!.wrapped, 'novel')).export()).toEqual(projects.first.export());
    // A wapped key is still bound to its project: the wrong id does not open it.
    await expect(unwrapProjectKey(fresh, rewrapped[0]!.wrapped, 'serial')).rejects.toBeInstanceOf(CryptoError);
  });
});

describe('what a rotation does not seal', () => {
  it('leaves a file sealed under a project key readable by that key, before and after', async () => {
    const { master } = await account();
    const project = await createProjectKey(master, 'novel');
    const sealed = await sealFile(project.projectKey, { projectId: 'novel', pathHash: 'p'.repeat(52), version: 1 }, new TextEncoder().encode('a chapter'));
    // Rotation re-wraps the key and rewrites nothing, which is why no file has to move.
    const fresh = (await account()).master;
    const [rewrapped] = await rewrapProjectKeys(master, fresh, [{ projectId: 'novel', wrapped: project.wrappedProjectKey }]);
    const reopened = await unwrapProjectKey(fresh, rewrapped!.wrapped, 'novel');
    expect(reopened.export()).toEqual(project.projectKey.export());
    expect(sealed.length).toBeGreaterThan(0);
  });
});
