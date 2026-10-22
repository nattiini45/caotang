import { describe, expect, it } from 'vitest';
import {
  HighWaterMarks,
  RollbackError,
  decodeRecoveryKey,
  encodeRecoveryKey,
  generateMasterKey,
  generateProjectKey,
  hashPath,
} from '../src/index.js';

describe('path hashing', () => {
  it('is stable per project key and path, and differs across both', async () => {
    const key = generateProjectKey();
    const hash = await hashPath(key, 'docs/n_3W8RN2TQ6C.md');
    expect(hash).toMatch(/^[0-9a-hjkmnp-tv-z]{52}$/);
    expect(await hashPath(key, 'docs/n_3W8RN2TQ6C.md')).toBe(hash);
    expect(await hashPath(key, 'docs/n_3W8RN2TQ6D.md')).not.toBe(hash);
    expect(await hashPath(generateProjectKey(), 'docs/n_3W8RN2TQ6C.md')).not.toBe(hash);
  });
});

describe('the recovery key', () => {
  it('round-trips the master key as 12 groups of 5', async () => {
    const master = generateMasterKey();
    const text = await encodeRecoveryKey(master);
    expect(text).toMatch(/^([0-9A-Z]{5}-){11}[0-9A-Z]{5}$/);
    expect((await decodeRecoveryKey(text)).export()).toEqual(master.export());
  });

  it('reads the typed form: lower case, no dashes, spaces, O for 0 and I or L for 1', async () => {
    const master = generateMasterKey();
    const text = await encodeRecoveryKey(master);
    expect((await decodeRecoveryKey(text.toLowerCase().replaceAll('-', ' '))).export()).toEqual(master.export());
    expect((await decodeRecoveryKey(text.replaceAll('0', 'O').replaceAll('1', 'l'))).export()).toEqual(master.export());
  });

  it('catches a mistyped character by its checksum', async () => {
    const text = await encodeRecoveryKey(generateMasterKey());
    const at = text.indexOf('-') + 2;
    const swapped = text.slice(0, at) + (text[at] === '2' ? '3' : '2') + text.slice(at + 1);
    await expect(decodeRecoveryKey(swapped)).rejects.toMatchObject({ code: 'bad-checksum' });
  });

  it('refuses text of the wrong length or alphabet', async () => {
    const text = await encodeRecoveryKey(generateMasterKey());
    await expect(decodeRecoveryKey(text.slice(0, -1))).rejects.toMatchObject({ code: 'bad-format' });
    await expect(decodeRecoveryKey(`${text}2`)).rejects.toMatchObject({ code: 'bad-format' });
    await expect(decodeRecoveryKey(`U${text.slice(1)}`)).rejects.toMatchObject({ code: 'bad-format' });
    await expect(encodeRecoveryKey(generateProjectKey())).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('the rollback high-water mark', () => {
  it('refuses a version below the highest seen and accepts the same or a higher one', () => {
    const marks = new HighWaterMarks();
    marks.advance('f1', 3);
    expect(() => marks.check('f1', 2)).toThrow(RollbackError);
    expect(() => marks.advance('f1', 2)).toThrow(RollbackError);
    marks.advance('f1', 3);
    marks.advance('f1', 5);
    expect(marks.get('f1')).toBe(5);
  });

  it('keeps one mark per file', () => {
    const marks = new HighWaterMarks();
    marks.advance('f1', 9);
    marks.advance('f2', 1);
    expect(marks.get('f2')).toBe(1);
    expect(() => marks.check('f3', 0)).not.toThrow();
  });

  it('names the file and both versions in the error', () => {
    const marks = new HighWaterMarks([['f1', 4]]);
    expect(() => marks.check('f1', 1)).toThrowError(expect.objectContaining({ code: 'rollback', key: 'f1', served: 1, seen: 4 }));
  });

  it('round-trips through its entries, sorted', () => {
    const marks = new HighWaterMarks();
    marks.advance('b', 2);
    marks.advance('a', 7);
    const entries = marks.entries();
    expect(entries).toEqual([
      ['a', 7],
      ['b', 2],
    ]);
    expect(() => new HighWaterMarks(entries).check('a', 6)).toThrow(RollbackError);
  });

  it('holds a key that would be a prototype property as an ordinary key', () => {
    const marks = new HighWaterMarks();
    marks.advance('__proto__', 2);
    expect(marks.get('__proto__')).toBe(2);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
