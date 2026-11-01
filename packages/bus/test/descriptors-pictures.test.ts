/**
 * The picture registry's descriptors (pictures.md §2.4): the closed key sets, the limits, and the patch/expect pairing of
 * `asset.setMeta`, against a project that holds the one record `asset.setMeta` names.
 */
import { describe, expect, it } from 'vitest';

import { ASSET_IMPORT_BATCH_MAX, COMMAND_REGISTRY, pictureCommands } from '../src/index.js';
import { makeSnapshot } from './fixtures.js';

const snapshot = makeSnapshot({
  // The record `asset.setMeta` names, with the caption its expect reads (the validate reads the record, pictures.md §2.4).
  assets: [{ id: 'a_7K2QX9M4A1', file: 'a_7K2QX9M4A1.png', mime: 'image/png', sha256: 'a'.repeat(64), bytes: 10, caption: 'Dawn', createdAt: '2026-10-30T10:00:00.000Z' }],
});

function codeOf(result: ReturnType<typeof pictureCommands.assetImport.validate>): string | undefined {
  return result.ok ? undefined : result.error.code;
}

describe('asset.import', () => {
  it('takes a staged id with a caption, alt, source and the large-photo answer', () => {
    const result = pictureCommands.assetImport.validate(
      { stagingId: 'stg_A', caption: 'Dawn', alt: 'A ferry', source: { kind: 'paste', label: 'clipboard' }, largePhotos: 'working-copies' },
      snapshot,
    );
    expect(result.ok && result.value).toEqual({ stagingId: 'stg_A', caption: 'Dawn', alt: 'A ferry', source: { kind: 'paste', label: 'clipboard' }, largePhotos: 'working-copies' });
  });

  it('refuses an agent-only source kind, a long alt, an unknown answer and an undeclared key', () => {
    expect(codeOf(pictureCommands.assetImport.validate({ stagingId: 'stg_A', source: { kind: 'agent' } }, snapshot))).toBe('invalid-params');
    expect(codeOf(pictureCommands.assetImport.validate({ stagingId: 'stg_A', alt: 'x'.repeat(501) }, snapshot))).toBe('limit-exceeded');
    expect(codeOf(pictureCommands.assetImport.validate({ stagingId: 'stg_A', largePhotos: 'shrink' }, snapshot))).toBe('invalid-params');
    expect(codeOf(pictureCommands.assetImport.validate({ stagingId: 'stg_A', colour: 'red' }, snapshot))).toBe('invalid-params');
  });

  it('is write-auto with a compensable undo, asynchronous, and the registry holds it', () => {
    expect(pictureCommands.assetImport).toMatchObject({ agentRisk: 'write-auto', undo: 'compensable', asyncApply: true, mutates: 'project' });
    expect(COMMAND_REGISTRY['asset.import'].descriptor).toBe(pictureCommands.assetImport);
  });
});

describe('asset.importBatch', () => {
  it('refuses an empty list, a staged id named twice and more than 200 items', () => {
    expect(pictureCommands.assetImportBatch.validate({ items: [] }, snapshot).ok).toBe(false);
    expect(pictureCommands.assetImportBatch.validate({ items: [{ stagingId: 's' }, { stagingId: 's' }] }, snapshot).ok).toBe(false);
    const many = Array.from({ length: ASSET_IMPORT_BATCH_MAX + 1 }, (_, i) => ({ stagingId: `s${i}` }));
    const result = pictureCommands.assetImportBatch.validate({ items: many }, snapshot);
    expect(!result.ok && result.error.code).toBe('limit-exceeded');
  });
});

describe('asset.setMeta', () => {
  it('takes a patch and an expect that name the same keys, with null clearing a field', () => {
    const result = pictureCommands.assetSetMeta.validate(
      { assetId: 'a_7K2QX9M4A1', patch: { caption: null, tags: ['sea'] }, expect: { caption: 'Dawn', tags: null } },
      snapshot,
    );
    expect(result.ok && result.value.patch).toEqual({ caption: null, tags: ['sea'] });
  });

  it('refuses an empty patch, mismatched expect keys, repeated tags and an unknown field', () => {
    const v = (params: Record<string, unknown>) => pictureCommands.assetSetMeta.validate(params, snapshot).ok;
    expect(v({ assetId: 'a_7K2QX9M4A1', patch: {}, expect: {} })).toBe(false);
    expect(v({ assetId: 'a_7K2QX9M4A1', patch: { caption: 'x' }, expect: { alt: null } })).toBe(false);
    expect(v({ assetId: 'a_7K2QX9M4A1', patch: { tags: ['a', 'a'] }, expect: { tags: null } })).toBe(false);
    expect(v({ assetId: 'a_7K2QX9M4A1', patch: { note: 'x' }, expect: { note: null } })).toBe(false);
  });
});

// PawCommit F1 (#322): asset.relink takes a renamed file with a different safe stem, but only of the record's own type, so the
// record it writes still loads on reopen.
describe('asset.relink file names', () => {
  const v = (file: string) => pictureCommands.assetRelink.validate({ pairs: [{ assetId: 'a_7K2QX9M4A1', file }] }, snapshot);
  const code = (file: string) => {
    const result = v(file);
    return result.ok ? undefined : result.error.code;
  };
  it('accepts a different stem with the MIME extension and refuses another extension', () => {
    expect(v('a_8M3RY4N5B2.png').ok).toBe(true);
    expect(code('a_8M3RY4N5B2.jpg')).toBe('invalid-params');
    expect(code('../a_8M3RY4N5B2.png')).toBe('invalid-params');
  });
});
