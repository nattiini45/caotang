import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildTimelineRows, guessColumnRoles, mapCodexRows, parseTableText, sniffDelimiter, tableColumns } from '../src/index.js';

describe('parseTableText', () => {
  it('sniffs commas, semicolons, tabs and pipes', () => {
    expect(sniffDelimiter('a,b\nc,d\n')).toBe(',');
    expect(sniffDelimiter('a;b\nc;d\n')).toBe(';');
    expect(sniffDelimiter('a\tb\nc\td\n')).toBe('\t');
    expect(sniffDelimiter('a|b\nc|d\n')).toBe('|');
  });

  it('keeps quoted separators, doubled quotes and embedded newlines', () => {
    const parsed = parseTableText('Name,Description\n"Ada, A.","line one\nline ""two"""\nBob,plain\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.rows).toHaveLength(3);
    expect(parsed.value.rows[1]?.cells).toEqual(['Ada, A.', 'line one\nline "two"']);
  });

  it('names an unterminated quote and inconsistent rows', () => {
    const parsed = parseTableText('a,b\n"open,still open\nnext,row\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.losses.some((loss) => loss.code === 'unterminated-quote')).toBe(true);
  });

  it('splits header rows from data rows and names missing columns', () => {
    const parsed = parseTableText('Name,Type\nAda,character\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { columns, data } = tableColumns(parsed.value.rows, true);
    expect(columns).toEqual(['Name', 'Type']);
    expect(data).toHaveLength(1);
    const plain = tableColumns(parsed.value.rows, false);
    expect(plain.columns).toEqual(['Column 1', 'Column 2']);
    expect(plain.data).toHaveLength(2);
  });
});

describe('guessColumnRoles', () => {
  it('guesses codex synonyms', () => {
    expect(guessColumnRoles(['Name', 'Also known as', 'Category', 'Tags'], 'codex')).toEqual(['name', 'aliases', 'type', 'tags']);
  });

  it('guesses timeline export columns', () => {
    expect(guessColumnRoles(['title', 'day', 'duration days', 'pov', 'expected present', 'threads', 'summary'], 'timeline')).toEqual(['title', 'start', 'duration', 'pov', 'participants', 'arc', 'summary']);
  });
});

describe('mapCodexRows', () => {
  it('maps aliases, types, keywords, long text and include policy', () => {
    const rows = [{ line: 2, cells: ['Ada', 'A.;The Countess', 'person', 'short', 'long article', 'math;inventor', 'private'] }];
    const mapped = mapCodexRows(['Name', 'Aliases', 'Type', 'Description', 'Long text', 'Tags', 'Policy'], rows, ['name', 'aliases', 'type', 'description', 'long-text', 'tags', 'include-policy']);
    expect(mapped.losses).toEqual([]);
    expect(mapped.rows[0]).toMatchObject({ name: 'Ada', aliases: ['A.', 'The Countess'], type: 'character', longText: 'long article', keywords: ['math', 'inventor'], includePolicy: 'manual' });
  });

  it('keeps a vendor type as a keyword and names unknown types', () => {
    const mapped = mapCodexRows(['Name', 'Type'], [{ line: 2, cells: ['Ada', 'Vampire'] }], ['name', 'type']);
    expect(mapped.rows[0]?.type).toBe('other');
    expect(mapped.rows[0]?.vendorType).toBe('Vampire');
    expect(mapped.losses.some((loss) => loss.code === 'unknown-type')).toBe(true);
  });

  it('treats inherited object property names as unknown vendor types', () => {
    const mapped = mapCodexRows(['Name', 'Type'], [{ line: 2, cells: ['Ada', 'constructor'] }], ['name', 'type']);
    expect(mapped.rows[0]?.type).toBe('other');
    expect(mapped.rows[0]?.vendorType).toBe('constructor');
    expect(mapped.losses).toEqual([expect.objectContaining({ code: 'unknown-type', value: 'constructor' })]);
  });

  it('keeps a name or alias once case-insensitively for one entry', () => {
    const mapped = mapCodexRows(['Name', 'Aliases'], [{ line: 2, cells: ['Ada', 'ada;A.;a.;ADA'] }], ['name', 'aliases']);
    expect(mapped.rows[0]?.aliases).toEqual(['A.']);
  });

  it('keeps commas inside an alias when semicolons separate the list', () => {
    const mapped = mapCodexRows(['Name', 'Aliases'], [{ line: 2, cells: ['Ada', 'Smith, Jr.;Charlie'] }], ['name', 'aliases']);
    expect(mapped.rows[0]?.aliases).toEqual(['Smith, Jr.', 'Charlie']);
  });

  it('keeps meaningful whitespace in prose cells', () => {
    const mapped = buildTimelineRows(['Title', 'Summary', 'Body'], [{ line: 2, cells: ['A', '  summary  ', '    code'] }], ['title', 'summary', 'body']);
    expect(mapped.rows[0]?.summary).toBe('  summary  ');
    expect(mapped.rows[0]?.body).toBe('    code');
  });

  it('keeps meaningful whitespace in relation and detail text', () => {
    const mapped = mapCodexRows(['Name', 'Relation', 'Detail'], [{ line: 2, cells: ['Ada', '  mentor  ', ' detail '] }], ['name', 'relation', 'detail']);
    expect(mapped.rows[0]?.keptFields).toEqual({ Relation: '  mentor  ', Detail: ' detail ' });
  });

  it('keeps every duplicate relation or detail cell', () => {
    const mapped = mapCodexRows(['Name', 'Relation', 'Relation'], [{ line: 2, cells: ['Ada', 'first', 'second'] }], ['name', 'relation', 'relation']);
    expect(mapped.rows[0]?.keptFields.Relation).toBe('first\n\nsecond');
  });

  it('names an invalid order once', () => {
    const mapped = buildTimelineRows(['Title', 'Order'], [{ line: 2, cells: ['A', 'first'] }], ['title', 'order']);
    expect(mapped.losses.filter((loss) => loss.code === 'bad-number' && loss.column === 'order')).toHaveLength(1);
  });

  it('names an unsafe duration integer instead of rounding it', () => {
    const mapped = buildTimelineRows(['Title', 'Duration'], [{ line: 2, cells: ['A', '9007199254740993 days'] }], ['title', 'duration']);
    expect(mapped.rows[0]?.duration).toBeUndefined();
    expect(mapped.losses).toEqual([expect.objectContaining({ code: 'bad-number', row: 2, column: 'duration' })]);
  });

  it('keeps only the first ten aliases and names the omitted ones', () => {
    const aliases = Array.from({ length: 12 }, (_, index) => `A${index}`).join(';');
    const mapped = mapCodexRows(['Name', 'Aliases'], [{ line: 2, cells: ['Ada', aliases] }], ['name', 'aliases']);
    expect(mapped.rows[0]?.aliases).toHaveLength(10);
    expect(mapped.rows[0]?.aliases).not.toContain('A10');
    expect(mapped.losses).toEqual([expect.objectContaining({ code: 'aliases-truncated', row: 2, count: 2, value: 'A10; A11' })]);
  });

  it('skips rows without the required name', () => {
    const mapped = mapCodexRows(['Name'], [{ line: 2, cells: [''] }], ['name']);
    expect(mapped.rows).toEqual([]);
    expect(mapped.losses).toEqual([expect.objectContaining({ code: 'missing-required', row: 2 })]);
  });
});

describe('buildTimelineRows', () => {
  it('round-trips Caotang timeline export cells', () => {
    const rows = [{ line: 2, cells: ["1", 'main', 'Opening', "'-14", "2", "'-12", 'Ada', 'Ada;Bob', 'Quest;Home', 'The start', 'Body'] }];
    const mapped = buildTimelineRows(['reading index', 'part', 'title', 'day', 'duration days', 'end day', 'pov', 'expected present', 'threads', 'summary', 'body'], rows, ['order', 'part', 'title', 'start', 'duration', 'end', 'pov', 'participants', 'arc', 'summary', 'body']);
    expect(mapped.losses).toEqual([]);
    expect(mapped.rows[0]).toMatchObject({ title: 'Opening', start: -14, duration: 2, end: -12, order: 1, pov: 'Ada', participants: ['Ada', 'Bob'], arcs: ['Quest', 'Home'], summary: 'The start', body: 'Body' });
  });

  it('parses Day N, explicit DMY dates and negative integers', () => {
    const rows = [
      { line: 2, cells: ['A', 'Day 4'] },
      { line: 3, cells: ['B', '02.03.2024'] },
      { line: 4, cells: ['C', '-5'] },
    ];
    const mapped = buildTimelineRows(['Title', 'Start'], rows, ['title', 'start'], { dateFormat: 'dmy' });
    expect(mapped.rows[0]?.start).toBe(4);
    expect(mapped.rows[1]?.start).toBe(Math.floor(Date.UTC(2024, 2, 2) / 86_400_000));
    expect(mapped.rows[2]?.start).toBe(-5);
    expect(mapped.rows[0]?.startAbsolute).toBeUndefined();
    expect(mapped.rows[1]?.startAbsolute).toBe(true);
  });

  it('rejects an impossible calendar date instead of normalizing it', () => {
    const mapped = buildTimelineRows(['Title', 'Start'], [{ line: 2, cells: ['A', '2024-02-31'] }], ['title', 'start'], { dateFormat: 'iso' });
    expect(mapped.rows[0]?.start).toBeUndefined();
    expect(mapped.losses).toEqual([expect.objectContaining({ code: 'bad-date', row: 2 })]);
  });

  it('never guesses ambiguous slash dates in ISO mode', () => {
    const mapped = buildTimelineRows(['Title', 'Start'], [{ line: 2, cells: ['A', '02/03/2024'] }], ['title', 'start'], { dateFormat: 'iso' });
    expect(mapped.rows[0]?.start).toBeUndefined();
    expect(mapped.losses).toEqual([expect.objectContaining({ code: 'bad-date', row: 2 })]);
  });

  it('keeps one case-insensitive spelling of a plotline handle', () => {
    const mapped = buildTimelineRows(['Title', 'Arc'], [{ line: 2, cells: ['A', 'Quest;QUEST;Home'] }], ['title', 'arc']);
    expect(mapped.rows[0]?.arcs).toEqual(['Quest', 'Home']);
  });

  it('names a day outside the coherence range as a bad date before commit', () => {
    const mapped = buildTimelineRows(['Title', 'Start'], [{ line: 2, cells: ['A', '10000001'] }], ['title', 'start']);
    expect(mapped.rows[0]?.start).toBeUndefined();
    expect(mapped.losses).toEqual([expect.objectContaining({ code: 'bad-date', row: 2, value: '10000001' })]);
  });

  it('does not derive a duration across relative and calendar endpoints', () => {
    const mapped = buildTimelineRows(['Title', 'Start', 'End'], [{ line: 2, cells: ['A', 'Day 0', '2024-01-01'] }], ['title', 'start', 'end']);
    expect(mapped.rows[0]?.start).toBe(0);
    expect(mapped.rows[0]?.duration).toBeUndefined();
  });

  it('rejects trailing text after a calendar date', () => {
    for (const value of ['2024-04-03garbage', '03.04.2024garbage']) {
      const mapped = buildTimelineRows(['Title', 'Start'], [{ line: 2, cells: ['A', value] }], ['title', 'start'], { dateFormat: 'dmy' });
      expect(mapped.rows[0]?.start).toBeUndefined();
      expect(mapped.losses).toEqual([expect.objectContaining({ code: 'bad-date', row: 2, value })]);
    }
  });
});

describe('duration units and folder roles', () => {
  it('parses duration units and keeps folder paths separate from story parts', () => {
    expect(guessColumnRoles(['part', 'folder path'], 'timeline')).toEqual(['part', 'folder']);
    const rows = [
      { line: 2, cells: ['A', '2 weeks'] },
      { line: 3, cells: ['B', '1 month'] },
    ];
    const mapped = buildTimelineRows(['Title', 'Duration'], rows, ['title', 'duration']);
    expect(mapped.rows[0]?.duration).toBe(14);
    expect(mapped.rows[1]?.duration).toBe(30);
  });
});

describe('the package fixtures', () => {
  const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

  it('reads the codex bible, German semicolon CSV and timeline arc fixtures', () => {
    const codex = parseTableText(fixture('codex-bible.csv'));
    expect(codex.ok).toBe(true);
    if (codex.ok) {
      const { columns, data } = tableColumns(codex.value.rows, true);
      const roles = guessColumnRoles(columns, 'codex');
      expect(columns.slice(0, 4)).toEqual(['Name', 'Aliases', 'Type', 'Description']);
      expect(roles.slice(0, 6)).toEqual(['name', 'aliases', 'type', 'description', 'long-text', 'tags']);
      const mapped = mapCodexRows(columns, data, roles);
      expect(mapped.rows[0]).toMatchObject({ name: 'Ada', type: 'character', imageFile: 'ada.png' });
      expect(mapped.rows[0]?.keptFields['Relation to mentor']).toBe('student');
    }

    const german = parseTableText(fixture('german-excel.csv'));
    expect(german.ok).toBe(true);
    if (german.ok) expect(german.value.rows[1]?.cells[2]).toBe('Zeile eins\nZeile zwei');

    const timeline = parseTableText(fixture('timeline-arcs.tsv'));
    expect(timeline.ok).toBe(true);
    if (timeline.ok) {
      const { columns, data } = tableColumns(timeline.value.rows, true);
      const roles = guessColumnRoles(columns, 'timeline');
      const mapped = buildTimelineRows(columns, data, roles);
      expect(mapped.rows[0]).toMatchObject({ title: 'Opening', start: -14, duration: 14, pov: 'Ada', locations: ['Harbour'], arcs: ['Quest'] });
    }
  });

  it('round-trips the exported Caotang timeline fixture', () => {
    const parsed = parseTableText(fixture('caotang-timeline.csv'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { columns, data } = tableColumns(parsed.value.rows, true);
    const roles = guessColumnRoles(columns, 'timeline');
    expect(roles.slice(0, 6)).toEqual(['order', 'part', 'title', 'folder', 'start', 'duration']);
    const mapped = buildTimelineRows(columns, data, roles);
    expect(mapped.rows.map((row) => [row.title, row.start, row.duration])).toEqual([
      ['Opening', -14, 2],
      ['Aftermath', -12, 1],
    ]);
  });
});
