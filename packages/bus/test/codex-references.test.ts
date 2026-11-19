import { describe, expect, it } from 'vitest';
import {
  CODEX_REFERENCE_MAX,
  CODEX_REFERENCE_TITLE_MAX,
  externalReferenceUrl,
  readCodexReference,
  referenceEditProblem,
} from '../src/index.js';

const LIVE = ['ref_0000000001', 'ref_0000000002'];
const edit = (value: unknown, remaining = CODEX_REFERENCE_MAX): string | undefined =>
  referenceEditProblem(value, LIVE, remaining);

describe('a reference link', () => {
  it('takes an HTTP or HTTPS address without credentials, spaces or control text', () => {
    expect(externalReferenceUrl('https://example.org/tides')).toBe('https://example.org/tides');
    expect(externalReferenceUrl('http://example.org')).toBe('http://example.org/');
    expect(externalReferenceUrl('ftp://example.org/tides')).toBeUndefined();
    expect(externalReferenceUrl('data:text/html,tides')).toBeUndefined();
    expect(externalReferenceUrl('https://user:pw@example.org/tides')).toBeUndefined();
    expect(externalReferenceUrl('https://example.org/tide tables')).toBeUndefined();
    expect(externalReferenceUrl('https://example.org/\u0007')).toBeUndefined();
  });

  it('counts characters, not UTF-16 code units, up to the URL cap', () => {
    const prefix = 'https://example.org/';
    const room = `${prefix}${'a'.repeat(2048 - prefix.length)}`;
    expect([...room]).toHaveLength(2048);
    expect(externalReferenceUrl(room)).toBe(room);
    expect(externalReferenceUrl(`${room}a`)).toBeUndefined();
    // A path of astral characters at the limit is 2048 characters but twice that in UTF-16 code units.
    const astral = `${prefix}${'🌊'.repeat(2048 - prefix.length)}`;
    expect([...astral]).toHaveLength(2048);
    expect(astral.length).toBeGreaterThan(2048);
    expect(externalReferenceUrl(astral)).toBeDefined();
  });
});

describe('reading a stored reference', () => {
  it('keeps a record whose fields all read, and takes a null optional field as absent', () => {
    expect(readCodexReference({ id: 'ref_0000000001', title: 'Tide Tables', url: 'https://example.org/t', publisher: null }))
      .toEqual({ id: 'ref_0000000001', title: 'Tide Tables', url: 'https://example.org/t' });
  });

  it('takes a record with an unreadable field out whole, so the panel can name it', () => {
    expect(readCodexReference({ id: 'ref_0000000001', title: 'Tide Tables', url: 'https://user:pw@example.org/t' })).toBeUndefined();
    expect(readCodexReference({ id: 'ref_0000000001', title: 'Tide Tables', publisher: 7 })).toBeUndefined();
    expect(readCodexReference({ id: 'ref_0000000001', title: 'Tide Tables', date: '2026-02-30' })).toBeUndefined();
  });

  it('refuses a record with no id, an unknown id shape or no title', () => {
    expect(readCodexReference({ title: 'Tide Tables' })).toBeUndefined();
    expect(readCodexReference({ id: 'ref_lower', title: 'Tide Tables' })).toBeUndefined();
    expect(readCodexReference({ id: 'ref_0000000001', title: '  ' })).toBeUndefined();
  });
});

describe('a reference edit', () => {
  it('creates with a title and refuses every other shape', () => {
    expect(edit({ action: 'create', title: 'Tide Tables' })).toBeUndefined();
    expect(edit({ action: 'create' })).toBe('title is required');
    expect(edit({ action: 'create', title: 'Tide Tables', id: 'ref_0000000001' })).toBe('unexpected field "id" for create');
    expect(edit({ action: 'create', title: 'Tide Tables', quote: 5 })).toBe('quote must be nonblank text of at most 1000 characters');
  });

  it('refuses a field the action does not take, or a shape that is not an operation', () => {
    expect(edit({ action: 'remove', id: 'ref_0000000001', title: 'Tide Tables' })).toBe('unexpected field "title" for remove');
    expect(edit({ action: 'move', id: 'ref_0000000001' })).toBe('action must be create, update or remove');
    expect(edit('remove')).toBe('must be an operation object');
  });

  it('updates by id, patches only what it names, and uses null to clear', () => {
    expect(edit({ action: 'update', id: 'ref_0000000001', publisher: 'Gull Press' })).toBeUndefined();
    expect(edit({ action: 'update', id: 'ref_0000000001', url: null })).toBeUndefined();
    expect(edit({ action: 'update', id: 'ref_0000000001' })).toBe('provide at least one field to update');
    expect(edit({ action: 'update', id: 'ref_0000000009', url: null })).toBe('id must name one existing reference on this entry');
    expect(edit({ action: 'remove', id: 'ref_0000000001' })).toBeUndefined();
    expect(edit({ action: 'remove', id: 'ref_0000000009' })).toBe('id must name one existing reference on this entry');
  });

  it('reads the cap as the room the batch left, not as the count that came before', () => {
    expect(edit({ action: 'create', title: 'Tide Tables' }, 1)).toBeUndefined();
    expect(edit({ action: 'create', title: 'Tide Tables' }, 0)).toBe(`an entry can hold at most ${CODEX_REFERENCE_MAX} references`);
    expect(edit({ action: 'remove', id: 'ref_0000000001' }, 0)).toBeUndefined();
  });

  it('counts a title or quote in characters, so astral text at the limit passes', () => {
    expect(edit({ action: 'create', title: '🌊'.repeat(CODEX_REFERENCE_TITLE_MAX) })).toBeUndefined();
    expect(edit({ action: 'create', title: '🌊'.repeat(CODEX_REFERENCE_TITLE_MAX + 1) }))
      .toBe(`title must be nonblank text of at most ${CODEX_REFERENCE_TITLE_MAX} characters`);
    expect(edit({ action: 'create', title: 'Tide Tables', url: 'example.org/tides' }))
      .toBe('url must be an HTTP or HTTPS address without credentials');
  });
});
