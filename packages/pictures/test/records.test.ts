import { describe, expect, it } from 'vitest';

import { readAssetRecords, validateAssetRecord, validateLinkNotePatch, validateRecordPatch } from '../src/validate.js';
import type { AssetRecord } from '../src/model.js';

const SHA = 'a'.repeat(64);

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'a_7K2QX9M4A1', file: 'a_7K2QX9M4A1.png', mime: 'image/png', sha256: SHA, bytes: 1234, createdAt: '2026-01-02T03:04:05.000Z', ...over };
}

describe('readAssetRecords (tolerant)', () => {
  it('reads a complete record and round-trips through JSON', () => {
    const full = record({
      width: 800,
      height: 600,
      caption: 'The lighthouse',
      alt: 'A lighthouse at dusk',
      decorative: true,
      tags: ['sea', 'dusk'],
      source: { kind: 'mcp', server: 's', tool: 't', label: 'l', url: 'https://example.test/x' },
      transcription: { docId: 'n_1', anchor: { from: 0, to: 4, exact: 'text', prefix: '', suffix: '', capturedRevision: 2 }, text: 'text', model: 'm', at: '2026-01-03T00:00:00.000Z' },
      workingCopy: { fromBytes: 9_000_000, fromWidth: 6000, fromHeight: 4000 },
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
    const read = readAssetRecords([full]);
    expect(read.notices).toEqual([]);
    expect(read.unreadable).toEqual([]);
    expect(read.records).toEqual([full]);
    expect(readAssetRecords(JSON.parse(JSON.stringify(read.records))).records).toEqual(read.records);
  });

  it('keeps fields this build does not know, at every level', () => {
    const entry = record({ palette: ['#fff'], source: { kind: 'import', futureField: 7 }, workingCopy: { fromBytes: 1, fromWidth: 1, fromHeight: 1, algo: 'lanczos' } });
    const [kept] = readAssetRecords([entry]).records;
    expect(kept).toMatchObject({ palette: ['#fff'], source: { futureField: 7 }, workingCopy: { algo: 'lanczos' } });
  });

  it('keeps an over-long caption and says so', () => {
    const long = 'x'.repeat(2001);
    const read = readAssetRecords([record({ caption: long })]);
    expect(read.records[0]?.caption).toBe(long);
    expect(read.notices).toMatchObject([{ code: 'over-limit', path: 'assets[0].caption' }]);
  });

  it('drops a known optional field with an unusable value and says so', () => {
    const read = readAssetRecords([record({ caption: 42, width: -3, tags: ['a', 1], decorative: false, source: { kind: 'carrier-pigeon' } })]);
    const [kept] = read.records;
    expect(kept).toBeDefined();
    for (const key of ['caption', 'width', 'tags', 'decorative', 'source']) expect(kept).not.toHaveProperty(key);
    expect(read.notices.map((n) => n.path).sort()).toEqual(['assets[0].caption', 'assets[0].decorative', 'assets[0].source', 'assets[0].tags', 'assets[0].width']);
  });

  it('keeps a record whose file is missing: absence is decided against a listing, not here', () => {
    expect(readAssetRecords([record({ file: 'a_7K2QX9M4A1.png' })]).records).toHaveLength(1);
  });

  it('hands back, untouched, any entry whose core fields cannot be trusted', () => {
    const bad = [
      record({ id: 'nope' }),
      record({ sha256: 'ABC' }),
      record({ mime: 'image/gif' }),
      record({ file: '../x.png' }),
      record({ bytes: -1 }),
      { id: 'a_7K2QX9M4A2' },
      'text',
      null,
      7,
    ];
    const read = readAssetRecords([record(), ...bad]);
    expect(read.records).toHaveLength(1);
    expect(read.unreadable).toEqual(bad);
    expect(read.notices.length).toBeGreaterThanOrEqual(bad.length);
  });

  it('uses the first of two records with one id and returns the other as unreadable', () => {
    const first = record({ caption: 'first' });
    const second = record({ caption: 'second' });
    const read = readAssetRecords([first, second]);
    expect(read.records.map((r) => r.caption)).toEqual(['first']);
    expect(read.unreadable).toEqual([second]);
    expect(read.notices.some((n) => n.code === 'duplicate-id')).toBe(true);
  });

  it('treats a missing list as empty and a non-list as ignored with a notice', () => {
    expect(readAssetRecords(undefined)).toEqual({ records: [], unreadable: [], notices: [] });
    const read = readAssetRecords({ not: 'a list' });
    expect(read.records).toEqual([]);
    expect(read.notices[0]?.code).toBe('not-a-list');
  });

  it('never throws on arbitrary JSON', () => {
    for (const raw of [1, 'x', [[]], [{}], [{ id: {} }], [[], [[]]], { assets: [] }]) expect(() => readAssetRecords(raw)).not.toThrow();
  });
});

describe('validateAssetRecord (strict)', () => {
  it('accepts a well-formed record', () => {
    const result = validateAssetRecord(record({ width: 10, height: 10, caption: 'c', tags: ['x'] }));
    expect(result.ok).toBe(true);
  });

  const refused: [string, Record<string, unknown>, string][] = [
    ['an unknown field', { palette: [] }, 'palette'],
    ['a file name that is not the id plus the type', { file: 'a_7K2QX9M4A1.jpg' }, 'file'],
    ['an upper-case hash', { sha256: 'A'.repeat(64) }, 'sha256'],
    ['a short hash', { sha256: 'a'.repeat(63) }, 'sha256'],
    ['a caption over 2000 characters', { caption: 'x'.repeat(2001) }, 'caption'],
    ['alt over 500 characters', { alt: 'x'.repeat(501) }, 'alt'],
    ['decorative: false', { decorative: false }, 'decorative'],
    ['33 tags', { tags: Array.from({ length: 33 }, (_, i) => `t${i}`) }, 'tags'],
    ['a 65 character tag', { tags: ['x'.repeat(65)] }, 'tags'],
    ['a width without a height', { width: 10 }, 'width'],
    ['an unknown source kind', { source: { kind: 'fax' } }, 'source'],
    ['an unknown key inside source', { source: { kind: 'import', extra: 1 } }, 'source'],
    ['a transcription without a time', { transcription: { text: 'x' } }, 'transcription'],
    ['a fractional byte count', { bytes: 1.5 }, 'bytes'],
    ['an unknown mime type', { mime: 'image/gif' }, 'mime'],
  ];

  it.each(refused)('refuses %s', (_name, over, path) => {
    const result = validateAssetRecord(record(over));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.path.startsWith(path))).toBe(true);
  });

  it('names a missing required field', () => {
    const { sha256: _omit, ...rest } = record();
    const result = validateAssetRecord(rest);
    expect(!result.ok && result.issues[0]).toMatchObject({ code: 'missing', path: 'sha256' });
  });

  it('names the file after the sniffed type for each format', () => {
    for (const [mime, ext] of [['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']] as const) {
      expect(validateAssetRecord(record({ mime, file: `a_7K2QX9M4A1.${ext}` })).ok).toBe(true);
    }
  });

  it('returns a value usable as an AssetRecord', () => {
    const result = validateAssetRecord(record({ alt: 'x' }));
    if (result.ok) {
      const typed: AssetRecord = result.value;
      expect(typed.id).toBe('a_7K2QX9M4A1');
    }
  });

  it('rejects non-objects', () => {
    for (const v of [null, 1, 'x', [], undefined]) expect(validateAssetRecord(v).ok).toBe(false);
  });
});

describe('metadata patches keep record fields and link notes apart', () => {
  it('accepts record fields and null to clear', () => {
    expect(validateRecordPatch({ caption: 'c', alt: null, tags: ['a'], decorative: true, sourceLabel: 'scan 3' }).ok).toBe(true);
    expect(validateRecordPatch({ decorative: null }).ok).toBe(true);
  });

  it('refuses a note, pointing at the link', () => {
    const result = validateRecordPatch({ note: 'x' });
    expect(!result.ok && result.issues[0]?.message).toMatch(/belongs to a link/);
  });

  it('refuses unknown, over-limit and empty patches', () => {
    expect(validateRecordPatch({ sha256: 'x' }).ok).toBe(false);
    expect(validateRecordPatch({ caption: 'x'.repeat(2001) }).ok).toBe(false);
    expect(validateRecordPatch({}).ok).toBe(false);
    expect(validateRecordPatch({ decorative: 'yes' }).ok).toBe(false);
  });

  it('validates a link note patch on its own', () => {
    expect(validateLinkNotePatch({ note: 'n' }).ok).toBe(true);
    expect(validateLinkNotePatch({ note: null }).ok).toBe(true);
    expect(validateLinkNotePatch({ note: 'x'.repeat(2001) }).ok).toBe(false);
    expect(validateLinkNotePatch({}).ok).toBe(false);
    expect(validateLinkNotePatch({ note: 'n', caption: 'c' }).ok).toBe(false);
  });
});
