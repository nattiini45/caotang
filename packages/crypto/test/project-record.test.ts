/**
 * The project record: a project's name as the host lists it before anything is opened, sealed under a key of that
 * project's own. It must survive a master-key rotation (which re-wraps the project key and leaves everything under it
 * intact), must not open as another project's or another account's record, and must refuse a layout it does not know.
 */
import { describe, expect, it } from 'vitest';
import { FORMAT_TAG, aeadSeal, associatedData } from '../src/aead.js';
import {
  CryptoError,
  MAX_PROJECT_NAME,
  MAX_SEALED_PROJECT_RECORD,
  PROJECT_RECORD_FORMAT_TAG,
  SecretKey,
  deriveSubkey,
  openProjectRecord,
  sealProjectRecord,
  sealedProjectRecordLength,
} from '../src/index.js';

const project = (fill = 6): SecretKey => new SecretKey('project', new Uint8Array(32).fill(fill));
const context = { accountId: '00000000-0000-4000-8000-000000000001', projectId: 'p_LIGHTHOUSE' };
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function rejected(action: Promise<unknown>): Promise<string> {
  try {
    await action;
    return 'opened';
  } catch (error) {
    return error instanceof CryptoError ? error.code : `other: ${String(error)}`;
  }
}

describe('a project record', () => {
  it('round-trips the name the writer gave it', async () => {
    const sealed = await sealProjectRecord(project(), context, { name: 'The Lighthouse at Kraken Bay' });

    expect(await openProjectRecord(project(), context, sealed)).toEqual({ name: 'The Lighthouse at Kraken Bay' });
    expect(sealed[0]).toBe(PROJECT_RECORD_FORMAT_TAG);
  });

  it('trims the name it keeps, and refuses an empty one or one past the limit', async () => {
    const sealed = await sealProjectRecord(project(), context, { name: '  Salt and Iron  ' });
    expect(await openProjectRecord(project(), context, sealed)).toEqual({ name: 'Salt and Iron' });

    await expect(sealProjectRecord(project(), context, { name: '   ' })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(sealProjectRecord(project(), context, { name: 'a'.repeat(MAX_PROJECT_NAME + 1) })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(sealProjectRecord(project(), context, { name: 'a'.repeat(MAX_PROJECT_NAME) })).resolves.toBeInstanceOf(Uint8Array);
  });

  it('stays well inside the server cap for the longest name, and is the plaintext\'s own length plus overhead', async () => {
    const name = 'a'.repeat(MAX_PROJECT_NAME);
    const sealed = await sealProjectRecord(project(), context, { name });
    expect(sealed.length).toBeLessThanOrEqual(MAX_SEALED_PROJECT_RECORD);
    expect(sealedProjectRecordLength(name)).toBe(sealed.length);
  });

  it('does not open as another project\'s record, or under another account', async () => {
    const sealed = await sealProjectRecord(project(), context, { name: 'The Lighthouse' });

    expect(await rejected(openProjectRecord(project(), { ...context, projectId: 'p_OTHER' }, sealed))).toBe('unauthentic');
    expect(await rejected(openProjectRecord(project(), { ...context, accountId: '00000000-0000-4000-8000-000000000002' }, sealed))).toBe('unauthentic');
    expect(await rejected(openProjectRecord(project(7), context, sealed))).toBe('unauthentic');
  });

  it('refuses an altered byte, a file or vault value, and a layout it does not know', async () => {
    const sealed = await sealProjectRecord(project(), context, { name: 'The Lighthouse' });
    const altered = sealed.slice();
    altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
    expect(await rejected(openProjectRecord(project(), context, altered))).toBe('unauthentic');

    const asFile = sealed.slice();
    asFile[0] = FORMAT_TAG;
    expect(await rejected(openProjectRecord(project(), context, asFile))).toBe('bad-format');

    // A record sealed for this project whose contents are a layout this reader does not know is refused, not guessed at.
    const unknown = await aeadSeal(
      await deriveSubkey(project(), 'name'),
      associatedData('caotang/v1/project-record', context.accountId, context.projectId),
      new TextEncoder().encode(JSON.stringify({ v: 9, name: 'The Lighthouse' })),
      undefined,
      PROJECT_RECORD_FORMAT_TAG,
    );
    expect(await rejected(openProjectRecord(project(), context, unknown))).toBe('bad-format');

    expect(text(sealed)).not.toContain('Lighthouse');
  });
});
