/**
 * The account record is bound to its account (P12 M2). A record served to another account does not open, and a recovery key
 * printed for one account is refused by another — the finding the review's F1 test demonstrated, stated here as what the code
 * now does. A record written before the binding still opens, and is upgraded the next time the passphrase is rotated.
 */
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_RECORD_FORMAT,
  ACCOUNT_RECORD_FORMAT_LEGACY,
  CryptoError,
  changeAccountPassphrase,
  decodeBase64,
  deriveKek,
  encodeBase64,
  encodeRecoveryKey,
  generateMasterKey,
  generateSalt,
  setupAccountKeys,
  unlockAccountKeys,
  unlockWithRecoveryKey,
  wrapMasterKey,
  type ResolveKdf,
} from '../src/index.js';
import { fastKdf } from './helpers.js';

const resolveFast: ResolveKdf = () => fastKdf;
const descriptor = { id: fastKdf.id, params: {} };
const A = 'acct_one';
const B = 'acct_two';

describe('the account record is bound to its account', () => {
  it('writes the account and a verifier into the record', async () => {
    const { record } = await setupAccountKeys({ passphrase: 'p', accountId: A, descriptor, resolveKdf: resolveFast });
    expect(record.format).toBe(ACCOUNT_RECORD_FORMAT);
    expect(record.accountId).toBe(A);
    expect(decodeBase64(record.verifier ?? '')).toHaveLength(32);
  });

  it('refuses a record that belongs to another account, even when the passphrases match', async () => {
    const forA = await setupAccountKeys({ passphrase: 'one passphrase', accountId: A, descriptor, resolveKdf: resolveFast });
    await expect(unlockAccountKeys({ passphrase: 'one passphrase', accountId: B, record: forA.record, resolveKdf: resolveFast }))
      .rejects.toBeInstanceOf(CryptoError);
    expect((await unlockAccountKeys({ passphrase: 'one passphrase', accountId: A, record: forA.record, resolveKdf: resolveFast })).export())
      .toEqual(forA.master.export());
  });

  it('refuses a record whose account id was rewritten to name the asking account', async () => {
    const forA = await setupAccountKeys({ passphrase: 'p', accountId: A, descriptor, resolveKdf: resolveFast });
    // The wrap is bound to A, so renaming the record reaches a key that does not open it.
    await expect(unlockAccountKeys({ passphrase: 'p', accountId: B, record: { ...forA.record, accountId: B }, resolveKdf: resolveFast }))
      .rejects.toBeInstanceOf(CryptoError);
  });

  it("refuses another account's recovery key, which the review found accepted", async () => {
    const a = await setupAccountKeys({ passphrase: 'the passphrase of account A', accountId: A, descriptor, resolveKdf: resolveFast });
    const b = await setupAccountKeys({ passphrase: 'the passphrase of account B', accountId: B, descriptor, resolveKdf: resolveFast });

    // The writer is signed in as A and types B's printed key: refused, where before it unlocked B's master key into A's session.
    await expect(unlockWithRecoveryKey(b.recoveryKey, { accountId: A, verifier: a.record.verifier })).rejects.toBeInstanceOf(CryptoError);
    // Its own account still accepts it.
    expect((await unlockWithRecoveryKey(b.recoveryKey, { accountId: B, verifier: b.record.verifier })).export()).toEqual(b.master.export());
  });

  it('keeps the binding and the verifier through a passphrase rotation, and upgrades a legacy record', async () => {
    const legacy = await legacyRecord('legacy passphrase');
    // A format-1 record has no account to check and no verifier, so it opens for whichever account asks, as it always did.
    expect((await unlockAccountKeys({ passphrase: 'legacy passphrase', accountId: A, record: legacy.record, resolveKdf: resolveFast })).export())
      .toEqual(legacy.master.export());
    expect((await unlockWithRecoveryKey(legacy.recoveryKey, { accountId: A })).export()).toEqual(legacy.master.export());

    const rotated = await changeAccountPassphrase({ oldPassphrase: 'legacy passphrase', newPassphrase: 'new passphrase', accountId: A, record: legacy.record, resolveKdf: resolveFast });
    expect(rotated.record.format).toBe(ACCOUNT_RECORD_FORMAT);
    expect(rotated.record.accountId).toBe(A);
    expect(rotated.record.verifier).toBeDefined();
    // And the rotated record is now bound: it no longer opens for another account.
    await expect(unlockAccountKeys({ passphrase: 'new passphrase', accountId: B, record: rotated.record, resolveKdf: resolveFast }))
      .rejects.toBeInstanceOf(CryptoError);
  });
});

/** A record as the first shipped format wrote it: no account id, no verifier, and the one-argument wrap label. */
async function legacyRecord(passphrase: string) {
  const salt = generateSalt();
  const kek = await deriveKek(fastKdf, passphrase, salt);
  const master = generateMasterKey();
  const wrapped = await wrapMasterKey(kek, master, null);
  return {
    master,
    recoveryKey: await encodeRecoveryKey(master),
    record: {
      format: ACCOUNT_RECORD_FORMAT_LEGACY,
      kdf: descriptor,
      salt: encodeBase64(salt),
      wrappedMaster: encodeBase64(wrapped),
    },
  };
}
