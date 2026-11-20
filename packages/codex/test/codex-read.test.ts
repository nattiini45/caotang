/**
 * `codex.read` (agent-harness row 12, codex.md §7): what the model reads back.
 */
import { describe, expect, it } from 'vitest';

import type { CodexEntry } from '@caotang/store';

import {
  CODEX_READ_MAX_LIMIT,
  CODEX_READ_TOKEN_CAP,
  codexRead,
  type CodexReadItem,
  type CodexReadSource,
} from '../src/index.js';
import { entry } from './fixtures/detection-corpus.js';

const ELENA = entry('Elena', {
  aliases: ['Ellie'],
  description: 'The protagonist, a cartographer who maps the harbor.',
  attachments: ['ch1'],
  keywords: ['SECRETKEYWORD'],
  origin: 'agent',
});
const HARBOR = entry('Harbor', {
  type: 'location',
  includePolicy: 'always',
  description: 'A fog-bound port.',
});
const WOLF = entry('Wolf', {
  type: 'object',
  includePolicy: 'never',
  description: 'Private notes about the wolf.',
});
const SOURCE: CodexReadSource = { entries: [ELENA, HARBOR, WOLF] };

function ids(items: readonly CodexReadItem[]): string[] {
  return items.map((item) => item.id);
}

describe('codexRead — search (codex.md §7)', () => {
  it('matches name, alias and description, case-insensitively', () => {
    expect(ids(codexRead({ query: 'ELENA' }, SOURCE).entries)).toEqual(['c_Elena']);
    expect(ids(codexRead({ query: 'ellie' }, SOURCE).entries)).toEqual(['c_Elena']);
    expect(ids(codexRead({ query: 'cartographer' }, SOURCE).entries)).toEqual(['c_Elena']);
  });

  it('records which fields matched', () => {
    const [elena] = codexRead({ query: 'ellie' }, SOURCE).entries;
    expect(elena?.matchedOn).toEqual(['alias']);
    const [byDescription] = codexRead({ query: 'cartographer' }, SOURCE).entries;
    expect(byDescription?.matchedOn).toEqual(['description']);
  });

  it('lists a name or alias hit above a description-only hit, then in codex order', () => {
    const bella = entry('Bella', { description: 'Elena trusts her.' });
    const result = codexRead({ query: 'elena' }, { entries: [bella, ELENA] });
    expect(ids(result.entries)).toEqual(['c_Elena', 'c_Bella']);
  });

  it('filters by type and by include policy, and "all" disables either filter', () => {
    expect(ids(codexRead({ type: 'location' }, SOURCE).entries)).toEqual(['c_Harbor']);
    expect(ids(codexRead({ includePolicy: 'never' }, SOURCE).entries)).toEqual(['c_Wolf']);
    expect(ids(codexRead({ type: 'all', includePolicy: 'all' }, SOURCE).entries)).toEqual([
      'c_Harbor',
      'c_Elena',
      'c_Wolf',
    ]);
  });

  it('matches an unknown type only against entries carrying that type', () => {
    const result = codexRead({ type: 'faction' }, SOURCE);
    expect(result.entries).toEqual([]);
    expect(result.note).toContain('no entries match');
  });

  it('treats a blank query as no query', () => {
    expect(codexRead({ query: '   ' }, SOURCE).total).toBe(3);
    expect(codexRead({ query: '   ' }, SOURCE).entries[0]?.matchedOn).toBeUndefined();
  });

  it('never searches or returns keywords, since they are the human-only lane (§2)', () => {
    const hidden = codexRead({ query: 'SECRETKEYWORD' }, SOURCE);
    expect(hidden.entries).toEqual([]);
    expect(JSON.stringify(codexRead({}, SOURCE))).not.toContain('SECRETKEYWORD');
  });

  it('returns only the fields the model reads, and omits optional ones it was not given', () => {
    const [item] = codexRead({ id: 'c_Elena' }, SOURCE).entries;
    expect(Object.keys(item ?? {}).sort()).toEqual([
      'aliases',
      'attachments',
      'description',
      'excerpt',
      'id',
      'includePolicy',
      'name',
      'origin',
      'type',
    ]);
  });
});

describe('codexRead — id fetch', () => {
  it('returns the full description, not a preview', () => {
    const long = 'word '.repeat(300).trim();
    const result = codexRead({ id: 'c_Long' }, { entries: [entry('Long', { id: 'c_Long', description: long })] });
    expect(result.entries[0]?.description).toBe(long);
    expect(result.entries[0]?.excerpt).toBe(false);
  });

  it('caps an over-long description at the token cap, shows a prefix marked as an excerpt, and states the full length', () => {
    // 68,000 characters. The JSON escapes the quotes and newlines, so the cap binds on the serialised form.
    const long = 'He said "hello".\n'.repeat(4000);
    const result = codexRead({ id: 'c_Long' }, { entries: [entry('Long', { id: 'c_Long', description: long })] });
    const shown = result.entries[0]?.description ?? '';
    expect(Math.ceil(JSON.stringify(result).length / 4)).toBeLessThanOrEqual(CODEX_READ_TOKEN_CAP);
    expect(result.entries[0]?.excerpt).toBe(true);
    expect(shown.length).toBeGreaterThan(0);
    expect(long.startsWith(shown)).toBe(true);
    expect(result.note).toContain('68000 characters');
  });

  it('never splits a surrogate pair when it cuts an over-long description', () => {
    // Every code point is two code units. The cut lands at the same offset whatever the
    // lead, so a lead of one character moves the pairs onto the other alignment, and one
    // of the two descriptions has its naive cut inside a pair.
    for (const lead of ['', 'x']) {
      const long = `${lead}${'\u{1D49C}'.repeat(40000)}`;
      const result = codexRead({ id: 'c_Astral' }, { entries: [entry('Astral', { id: 'c_Astral', description: long })] });
      const shown = result.entries[0]?.description ?? '';
      expect(shown.length).toBeGreaterThan(0);
      expect(long.startsWith(shown)).toBe(true);
      expect(shown).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      expect(Math.ceil(JSON.stringify(result).length / 4)).toBeLessThanOrEqual(CODEX_READ_TOKEN_CAP);
    }
  });

  it('returns no entry, with a note, when the name and aliases alone overflow the cap', () => {
    // The store keeps an over-long alias whole, so the envelope itself can overflow.
    const big = entry('Big', { id: 'c_Big', aliases: ['x'.repeat(40000)] });
    const result = codexRead({ id: 'c_Big' }, { entries: [big] });
    expect(result.entries).toEqual([]);
    expect(result.total).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.note).toContain('8k-token');
    expect(Math.ceil(JSON.stringify(result).length / 4)).toBeLessThanOrEqual(CODEX_READ_TOKEN_CAP);
  });

  it('returns a note, not an error, for an id that does not exist', () => {
    const result = codexRead({ id: 'c_missing' }, SOURCE);
    expect(result.entries).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.note).toContain('no codex entry with id "c_missing"');
  });

  it('says so when the entry exists but the filters exclude it', () => {
    const result = codexRead({ id: 'c_Elena', type: 'location' }, SOURCE);
    expect(result.entries).toEqual([]);
    expect(result.note).toContain('does not match the type or includePolicy filter');
  });
});

describe('codexRead — empty results, limit and truncation', () => {
  it('is a result with guidance, not an error, when nothing matches', () => {
    const result = codexRead({ query: 'zzzz' }, SOURCE);
    expect(result).toEqual({
      entries: [],
      total: 0,
      truncated: false,
      note: 'no entries match; use codex.write to create',
    });
  });

  it('defaults to 25 entries and says how many matched', () => {
    const many = Array.from({ length: 60 }, (_, i) => entry(`Entry ${String(i).padStart(2, '0')}`));
    const result = codexRead({}, { entries: many });
    expect(result.entries).toHaveLength(25);
    expect(result.total).toBe(60);
    expect(result.truncated).toBe(true);
    expect(result.note).toContain('showing 25 of 60');
  });

  it('clamps the limit to 1–100, and falls back to the default for NaN', () => {
    const many = Array.from({ length: 150 }, (_, i) => entry(`Entry ${String(i).padStart(3, '0')}`));
    expect(codexRead({ limit: 500 }, { entries: many }).entries).toHaveLength(CODEX_READ_MAX_LIMIT);
    expect(codexRead({ limit: 0 }, { entries: many }).entries).toHaveLength(1);
    expect(codexRead({ limit: -4 }, { entries: many }).entries).toHaveLength(1);
    expect(codexRead({ limit: 2.9 }, { entries: many }).entries).toHaveLength(2);
    expect(codexRead({ limit: Number.NaN }, { entries: many }).entries).toHaveLength(25);
  });

  it('is untruncated and carries no note when everything fits', () => {
    const result = codexRead({ limit: 10 }, SOURCE);
    expect(result.entries).toHaveLength(3);
    expect(result.truncated).toBe(false);
    expect(result.note).toBeUndefined();
  });
});

describe('codexRead — excerpt windows (codex.md §7)', () => {
  it('shows 80 characters either side of a description hit, with ellipses where it was cut', () => {
    const description = `${'x'.repeat(300)}NEEDLE${'y'.repeat(300)}`;
    const [item] = codexRead({ query: 'needle' }, { entries: [entry('Pin', { description })] }).entries;
    expect(item?.description).toBe(`…${'x'.repeat(80)}NEEDLE${'y'.repeat(80)}…`);
    expect(item?.excerpt).toBe(true);
  });

  it('has no leading ellipsis when the hit is at the start', () => {
    const description = `NEEDLE${'y'.repeat(300)}`;
    const [item] = codexRead({ query: 'needle' }, { entries: [entry('Pin', { description })] }).entries;
    expect(item?.description).toBe(`NEEDLE${'y'.repeat(80)}…`);
  });

  it('shows the first 200 characters when the description has no hit', () => {
    const [item] = codexRead({ query: 'alpha' }, { entries: [entry('Alpha', { description: 'a'.repeat(500) })] }).entries;
    expect(item?.matchedOn).toEqual(['name']);
    expect(item?.description).toBe(`${'a'.repeat(200)}…`);
    expect(item?.excerpt).toBe(true);
  });

  it('shows a short description whole, and says it is not an excerpt', () => {
    const [item] = codexRead({ query: 'alpha' }, { entries: [entry('Alpha', { description: 'Short.' })] }).entries;
    expect(item?.description).toBe('Short.');
    expect(item?.excerpt).toBe(false);
  });

  it('never splits a surrogate pair at a window edge', () => {
    // An astral letter (U+1D49C) placed so the 80-character window would start between its halves.
    const description = `${'\u{1D49C}'.repeat(100)}x NEEDLE ${'\u{1D49C}'.repeat(100)}`;
    const [item] = codexRead({ query: 'needle' }, { entries: [entry('Pin', { description })] }).entries;
    expect(item?.description).toContain('NEEDLE');
    expect(item?.description).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe('codexRead — the token cap (agent-harness row 12)', () => {
  const heavy = Array.from({ length: 100 }, (_, i) =>
    entry(`Entry ${String(i).padStart(3, '0')}`, {
      aliases: Array.from({ length: 10 }, (_v, j) => `alias-${i}-${j}-${'z'.repeat(50)}`),
      description: 'lorem ipsum dolor sit amet '.repeat(70),
    }),
  );

  it('keeps the serialised result within the estimated token cap, and says it was capped', () => {
    const result = codexRead({ query: 'lorem', limit: 100 }, { entries: heavy });
    expect(result.truncated).toBe(true);
    expect(result.entries.length).toBeLessThan(100);
    expect(result.note).toContain('8k tokens');
    expect(Math.ceil(JSON.stringify(result).length / 4)).toBeLessThanOrEqual(CODEX_READ_TOKEN_CAP);
  });

  it('drops entries from the end, so what remains is a prefix of the ordered result', () => {
    const result = codexRead({ query: 'lorem', limit: 100 }, { entries: heavy });
    const kept = result.entries.map((item) => item.name);
    expect(kept).toEqual(heavy.slice(0, kept.length).map((e) => e.name));
  });
});

describe('codexRead — entries loaded without optional fields', () => {
  it('reads an entry with no aliases, attachments or description as empty, not as a crash', () => {
    const bare = { ...entry('Bare'), aliases: undefined, attachments: undefined, description: undefined } as unknown as CodexEntry;
    const byName = codexRead({ query: 'bare' }, { entries: [bare] });
    expect(byName.entries[0]).toMatchObject({ id: 'c_Bare', aliases: [], attachments: [], description: '', excerpt: false });
    expect(codexRead({ query: 'anything' }, { entries: [bare] }).entries).toEqual([]);
  });
});

describe('codexRead — cached mention counts', () => {
  it('carries a count on every item when counts are supplied, 0 for an entry not cached', () => {
    const result = codexRead({}, { entries: [ELENA, HARBOR], mentions: new Map([['c_Elena', 4]]) });
    const counts = Object.fromEntries(result.entries.map((item) => [item.id, item.mentions]));
    expect(counts).toEqual({ c_Harbor: 0, c_Elena: 4 });
  });

  it('carries no mention field when none were supplied', () => {
    const [item] = codexRead({ id: 'c_Elena' }, SOURCE).entries;
    expect(item).not.toHaveProperty('mentions');
  });
});

describe('codexRead — the ids codex.write takes', () => {
  const LINKS = new Map([['c_Elena', {
    references: [{ id: 'ref_0000000001', title: 'Tide Tables' }],
    relations: [{ id: 'rel_0000000001', targetId: 'c_Harbor', target: 'Harbor', label: 'ally' }],
  }]]);

  it('carries a supplied entry’s references and relations on its item, list and id fetch alike', () => {
    const [listed] = codexRead({ query: 'cartographer' }, { entries: [ELENA, HARBOR], links: LINKS }).entries;
    expect(listed).toMatchObject({
      references: [{ id: 'ref_0000000001', title: 'Tide Tables' }],
      relations: [{ id: 'rel_0000000001', targetId: 'c_Harbor', target: 'Harbor', label: 'ally' }],
    });
    const [fetched] = codexRead({ id: 'c_Elena' }, { entries: [ELENA, HARBOR], links: LINKS }).entries;
    expect(fetched?.references?.[0]?.id).toBe('ref_0000000001');
  });

  it('carries neither field for an entry the caller supplied none for, or when no links were supplied at all', () => {
    const harbor = codexRead({}, { entries: [ELENA, HARBOR], links: LINKS }).entries.find((item) => item.id === 'c_Harbor');
    expect(harbor).not.toHaveProperty('references');
    expect(harbor).not.toHaveProperty('relations');
    const [plain] = codexRead({ id: 'c_Elena' }, SOURCE).entries;
    expect(plain).not.toHaveProperty('references');
    expect(plain).not.toHaveProperty('relations');
  });

  it('counts the ids against the 8k cap, so a result is never over because of them', () => {
    const links = new Map([['c_Elena', {
      references: Array.from({ length: 1500 }, (_, index) => ({ id: `ref_${String(index).padStart(10, '0')}`, title: 'Tide Tables' })),
    }]]);
    const result = codexRead({}, { entries: [ELENA, HARBOR], links });
    expect(result.entries.map((item) => item.id)).not.toContain('c_Elena');
    expect(result.note).toContain('8k tokens');
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(CODEX_READ_TOKEN_CAP * 4);
  });
});
