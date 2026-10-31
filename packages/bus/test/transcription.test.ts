/**
 * `asset.transcribe`'s descriptor (`packages/bus/src/descriptors-transcription.ts`) — the closed params surface of
 * [pictures.md §2.4 / §8.4](docs/architecture/pictures.md): `{into, pages, title?}` with each page
 * `{assetId, text, model?, expect}`. What a validate can check from the project alone is checked here: the two
 * destinations, 1–100 pages, a known picture named once per batch, a non-blank reviewed text, and the `expect` guard
 * holding the record's complete current transcription or `null`. The store's apply (`commands-transcription.ts`)
 * re-checks the same guards and owns the writes; its tests live in `packages/store/test/commands-transcription.test.ts`.
 *
 * The name joins `COMMAND_NAMES` with the command's own wiring, so this file imports the descriptor from its module
 * directly rather than through the index.
 */

import { describe, expect, it } from 'vitest';

import type { ValidationSnapshot } from '../src/index.js';
import {
  ASSET_TRANSCRIBE_PAGES_MAX,
  assetTranscribeDescriptor,
  type AssetTranscribeParams,
} from '../src/descriptors-transcription.js';
import { makeSnapshot } from './fixtures.js';

const ONE = 'a_7K2QX9M4A1';
const TWO = 'a_3W8RN2TQ6C';
const UNKNOWN = 'a_ZZZZZZZZZZ';

const record = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  file: `${id}.png`,
  mime: 'image/png' as const,
  sha256: 'ab'.repeat(32),
  bytes: 100,
  createdAt: '2026-10-09T09:00:00.000Z',
  ...extra,
});

const EXISTING_TRANSCRIPTION = {
  docId: 'n_3W8RN2TQ6C',
  anchor: { from: 0, to: 5, exact: 'Dear ', prefix: '', suffix: 'Elena', capturedRevision: 3 },
  model: 'vision-a',
  at: '2026-10-08T09:00:00.000Z',
};

function snapshot(assets: NonNullable<ValidationSnapshot['manifest']['assets']> = [record(ONE), record(TWO, { transcription: EXISTING_TRANSCRIPTION })]): ValidationSnapshot {
  return makeSnapshot({ assets });
}

interface Checked {
  readonly ok: boolean;
  readonly value?: AssetTranscribeParams;
  readonly code?: string;
  readonly target?: string;
  readonly message?: string;
}

function validate(params: unknown, snap: ValidationSnapshot = snapshot()): Checked {
  const result = assetTranscribeDescriptor.validate(params, snap) as {
    ok: boolean;
    value?: AssetTranscribeParams;
    error?: { code: string; target?: string; message: string };
  };
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, code: result.error?.code, target: result.error?.target, message: result.error?.message };
}

describe('asset.transcribe: the descriptor', () => {
  it('is a write-confirm project mutation, compensable, synchronous', () => {
    expect(assetTranscribeDescriptor.mutates).toBe('project');
    expect(assetTranscribeDescriptor.agentRisk).toBe('write-confirm');
    expect(assetTranscribeDescriptor.undo).toBe('compensable');
    expect(assetTranscribeDescriptor.asyncApply).toBeUndefined();
  });

  it('accepts a searchable batch with a null guard and returns it as the apply reads it', () => {
    const checked = validate({ into: 'searchable', pages: [{ assetId: ONE, text: 'Dear Elena,\nthe ferry was late.', expect: null }] });
    expect(checked).toEqual({
      ok: true,
      value: { into: 'searchable', pages: [{ assetId: ONE, text: 'Dear Elena,\nthe ferry was late.', expect: null }] },
    });
  });

  it('accepts a new-document batch with a title and a model, and a guard equal to the record’s whole transcription', () => {
    const checked = validate({
      into: 'new-document',
      title: 'Field notes',
      pages: [{ assetId: TWO, text: 'Second page.', model: 'vision-b', expect: EXISTING_TRANSCRIPTION }],
    });
    expect(checked.ok).toBe(true);
    expect(checked.value).toEqual({
      into: 'new-document',
      title: 'Field notes',
      pages: [{ assetId: TWO, text: 'Second page.', model: 'vision-b', expect: EXISTING_TRANSCRIPTION }],
    });
  });

  it('refuses a key the command does not declare, at the top level and on a page', () => {
    expect(validate({ into: 'searchable', pages: [{ assetId: ONE, text: 'x', expect: null }], assetIds: [ONE] }).code).toBe('invalid-params');
    expect(validate({ into: 'searchable', pages: [{ assetId: ONE, text: 'x', expect: null, note: 'hi' }] }).target).toBe('params.pages[0].note');
  });

  it('refuses a destination outside the two, and a title sent with searchable', () => {
    expect(validate({ into: 'ghost', pages: [{ assetId: ONE, text: 'x', expect: null }] }).target).toBe('into');
    const withTitle = validate({ into: 'searchable', title: 'Notes', pages: [{ assetId: ONE, text: 'x', expect: null }] });
    expect(withTitle).toMatchObject({ ok: false, code: 'invalid-params', target: 'title' });
    expect(validate({ into: 'new-document', title: '   ', pages: [{ assetId: ONE, text: 'x', expect: null }] }).target).toBe('title');
  });

  it('refuses an empty or over-long pages list', () => {
    expect(validate({ into: 'searchable', pages: [] }).code).toBe('invalid-params');
    expect(validate({ into: 'searchable', pages: 'x' }).code).toBe('invalid-params');
    const many = Array.from({ length: ASSET_TRANSCRIBE_PAGES_MAX + 1 }, () => ({ assetId: ONE, text: 'x', expect: null }));
    expect(validate({ into: 'searchable', pages: many })).toMatchObject({ ok: false, code: 'limit-exceeded', target: 'pages' });
    const atLimit = Array.from({ length: ASSET_TRANSCRIBE_PAGES_MAX }, (_, i) => ({ assetId: i === 0 ? ONE : `a_${String(i).padStart(9, '0')}A`, text: 'x', expect: null }));
    // The 100-page list is refused only where a page is bad — the first page is fine, so this refusal is the unknown second picture.
    expect(validate({ into: 'searchable', pages: atLimit }).code).toBe('not-found');
  });

  it('refuses a page that is not an object, a malformed asset id, an unknown picture and a repeated one', () => {
    expect(validate({ into: 'searchable', pages: ['x'] }).target).toBe('params.pages[0]');
    expect(validate({ into: 'searchable', pages: [{ assetId: 'not-an-id', text: 'x', expect: null }] }).target).toBe('params.pages[0].assetId');
    expect(validate({ into: 'searchable', pages: [{ assetId: UNKNOWN, text: 'x', expect: null }] })).toMatchObject({ ok: false, code: 'not-found', target: 'params.pages[0].assetId' });
    const twice = validate({ into: 'searchable', pages: [{ assetId: ONE, text: 'x', expect: null }, { assetId: ONE, text: 'y', expect: null }] });
    expect(twice).toMatchObject({ ok: false, code: 'invalid-params', target: 'params.pages[1].assetId' });
  });

  it('refuses a missing, non-string or blank text, and a missing or malformed expect', () => {
    expect(validate({ into: 'searchable', pages: [{ assetId: ONE, expect: null }] }).target).toBe('params.pages[0].text');
    expect(validate({ into: 'searchable', pages: [{ assetId: ONE, text: 42, expect: null }] }).target).toBe('params.pages[0].text');
    expect(validate({ into: 'searchable', pages: [{ assetId: ONE, text: '  \n \t ', expect: null }] }).target).toBe('params.pages[0].text');
    expect(validate({ into: 'searchable', pages: [{ assetId: ONE, text: 'x' }] }).target).toBe('params.pages[0].expect');
    expect(validate({ into: 'searchable', pages: [{ assetId: ONE, text: 'x', expect: 'none' }] }).target).toBe('params.pages[0].expect');
  });

  it('refuses an over-long model with the limit code', () => {
    const checked = validate({ into: 'searchable', pages: [{ assetId: ONE, text: 'x', model: 'm'.repeat(201), expect: null }] });
    expect(checked).toMatchObject({ ok: false, code: 'limit-exceeded', target: 'params.pages[0].model' });
  });

  it('treats a stale expect as a revision conflict, whether the record holds a transcription or none', () => {
    const staleAgainstExisting = validate({ into: 'searchable', pages: [{ assetId: TWO, text: 'x', expect: null }] });
    expect(staleAgainstExisting).toMatchObject({ ok: false, code: 'revision-conflict', target: 'params.pages[0].expect' });
    expect(staleAgainstExisting.message).toContain('changed since its transcription was read');
    const partial = validate({ into: 'searchable', pages: [{ assetId: TWO, text: 'x', expect: { at: EXISTING_TRANSCRIPTION.at } }] });
    expect(partial).toMatchObject({ ok: false, code: 'revision-conflict', target: 'params.pages[0].expect' });
    const staleAgainstNone = validate({ into: 'searchable', pages: [{ assetId: ONE, text: 'x', expect: { at: '2026-10-01T00:00:00.000Z' } }] });
    expect(staleAgainstNone).toMatchObject({ ok: false, code: 'revision-conflict', target: 'params.pages[0].expect' });
  });

  it('refuses params that are not an object', () => {
    expect(validate('asset.transcribe').ok).toBe(false);
    expect(validate(null).ok).toBe(false);
  });
});
