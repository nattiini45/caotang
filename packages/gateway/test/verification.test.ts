import { describe, expect, it } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';
import { createKeyStore, createMemoryVaultPort, createProfileStore, type ProfileVerification } from '../src/index.js';
import { providerVerificationMachine, readVerification, type VerificationEvent } from '../src/verification.js';

const states: ProfileVerification[] = [
  { kind: 'unknown' }, { kind: 'checking', attempt: 1 },
  { kind: 'verified', checkedAt: 10 }, { kind: 'failed', checkedAt: 10 },
];
const events: VerificationEvent[] = [
  { type: 'check', attempt: 1 }, { type: 'check', attempt: 2 }, { type: 'invalidate' },
  { type: 'passed', attempt: 1, checkedAt: 20 }, { type: 'failed', attempt: 1, checkedAt: 20 },
  { type: 'passed', attempt: 2, checkedAt: 20 }, { type: 'failed', attempt: 2, checkedAt: 20 },
];

describe('provider verification', () => {
  it('agrees with every table row and ignores superseded completions', () => {
    expect(checkMachine(providerVerificationMachine, { states, events })).toEqual([]);
    const checking: ProfileVerification = { kind: 'checking', attempt: 2 };
    expect(providerVerificationMachine.step(checking, { type: 'passed', attempt: 1, checkedAt: 30 })).toBe(checking);
    expect(providerVerificationMachine.step(checking, { type: 'failed', attempt: 1, checkedAt: 30 })).toBe(checking);
  });

  it.each([undefined, null, {}, { kind: 'checking', attempt: 1 }, { kind: 'verified' }, { kind: 'failed', checkedAt: -1 }, { kind: 'verified', checkedAt: NaN }, { kind: 'future', checkedAt: 10 }])('reads an old, interrupted or malformed record as unknown: %j', (record) => {
    expect(readVerification(record)).toEqual({ kind: 'unknown' });
  });

  it.each(['verified', 'failed'] as const)('restores a %s result without retaining extra fields', (kind) => {
    expect(readVerification({ kind, checkedAt: 10, detail: 'not retained' })).toEqual({ kind, checkedAt: 10 });
  });

  it('copies verification views, invalidates changed configuration and refuses stale format results', async () => {
    const profiles = createProfileStore({ keys: createKeyStore(createMemoryVaultPort()) });
    const profile = await profiles.create({ name: 'Endpoint', kind: 'endpoint', baseUrl: 'https://127.0.0.1:5999/v1', defaultModel: 'first' });
    const verification: ProfileVerification = { kind: 'checking', attempt: 1 };
    profiles.recordVerification(profile.id, verification);
    expect(profiles.get(profile.id)?.verification).not.toBe(verification);
    await profiles.update(profile.id, { defaultModel: 'second' });
    expect(profiles.get(profile.id)?.verification).toEqual({ kind: 'unknown' });
    profiles.recordProbe(profile.id, { supportsJsonObject: true, probedAt: 10 }, 1);
    expect(profiles.get(profile.id)?.responseFormat).toBeUndefined();
    profiles.recordVerification(profile.id, { kind: 'checking', attempt: 2 });
    profiles.recordProbe(profile.id, { supportsJsonObject: false, probedAt: 20 }, 2);
    expect(profiles.get(profile.id)?.responseFormat).toEqual({ supportsJsonObject: false, probedAt: 20 });
    profiles.recordVerification(profile.id, { kind: 'verified', checkedAt: 20 });
    await profiles.update(profile.id, { name: 'Renamed', temperature: 0.5 });
    expect(profiles.get(profile.id)?.verification).toEqual({ kind: 'verified', checkedAt: 20 });
    await profiles.update(profile.id, { customHeaders: { 'X-Project': 'changed' } });
    expect(profiles.get(profile.id)?.verification).toEqual({ kind: 'unknown' });
    await profiles.remove(profile.id);
    profiles.recordVerification(profile.id, { kind: 'failed', checkedAt: 30 });
    expect(profiles.get(profile.id)).toBeUndefined();
  });
});
