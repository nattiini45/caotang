/**
 * The table's locale and the Yarn Spinner strings file (dialogue-narrative.md §2.1, §6): each row's locale is its container's
 * `locBaseline`, else the table's default; `toCsv` appends the `locale` column only when asked; `toYarnCsv` writes Yarn's columns.
 */
import type { CodexEntry } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import { TABLE_COLUMNS, YARN_COLUMNS, buildRows, toCsv, toYarnCsv } from '../src/index.js';

const ALICE: CodexEntry = {
  id: 'c_ALICE00001',
  name: 'Alice',
  aliases: ['Al'],
  type: 'character',
  description: '',
  includePolicy: 'detected',
  caseSensitive: false,
  exclude: [],
  attachments: [],
  keywords: [],
  origin: 'manual',
  sources: [],
};

const BODY = [
  'Hello from the top. # lineId: l_0000000001',
  '-> hall',
  '=== hall ===',
  'Al: Welcome, friend. # lineId: l_0000000002',
  'Bob: "Thanks." # lineId: l_0000000003',
  '* [Sit down # lineId: l_0000000004_c] -> END',
].join('\n');

describe('the rows’ locale', () => {
  it('takes the container’s locBaseline, then the table’s default, then nothing', () => {
    const own = buildRows([{ id: 'd1', title: 'Hall', body: BODY, meta: { locBaseline: 'de' } }], { locale: 'en' });
    const fallback = buildRows([{ id: 'd1', title: 'Hall', body: BODY }], { locale: ' en-GB ' });
    const none = buildRows([{ id: 'd1', title: 'Hall', body: BODY }]);
    expect(new Set(own.map((row) => row.locale))).toEqual(new Set(['de']));
    expect(new Set(fallback.map((row) => row.locale))).toEqual(new Set(['en-GB']));
    expect(new Set(none.map((row) => row.locale))).toEqual(new Set(['']));
  });

  it('names the speaker as a reader sees it: the codex name, else the typed name', () => {
    const rows = buildRows([{ id: 'd1', title: 'Hall', body: BODY }], { entries: [ALICE] });
    expect(rows.map((row) => row.speakerName)).toEqual(['', 'Alice', 'Bob', '']);
  });
});

describe('toCsv and the locale column', () => {
  const rows = buildRows([{ id: 'd1', title: 'Hall', body: BODY }], { locale: 'en', charLimit: 30 });

  it('keeps §6’s five columns unless the locale is asked for', () => {
    expect(toCsv(rows).split('\r\n')[0]).toBe(TABLE_COLUMNS.join(','));
  });

  it('appends locale after charLimit, and condition after locale', () => {
    const lines = toCsv(rows, { includeLocale: true, includeConditions: true }).split('\r\n');
    expect(lines[0]).toBe('lineId,speaker,text,context,charLimit,locale,condition');
    expect(lines[1]).toBe('l_0000000001,,Hello from the top.,,30,en,');
  });
});

describe('toYarnCsv — the yarn-csv target', () => {
  const rows = buildRows([{ id: 'd1', title: 'Hall', body: BODY }], { entries: [ALICE], locale: 'en', charLimit: 30 });

  it('writes Yarn’s columns, a line: id, the speaker in the text and RFC 4180 records', () => {
    const csv = toYarnCsv(rows, { fileOf: () => 'The hall' });
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.split('\r\n')).toEqual([
      YARN_COLUMNS.join(','),
      'en,line:l_0000000001,Hello from the top.,The hall,,1,,',
      'en,line:l_0000000002,"Alice: Welcome, friend.",The hall,hall,4,,hall / Alice',
      'en,line:l_0000000003,"Bob: ""Thanks.""",The hall,hall,5,,hall',
      'en,line:l_0000000004_c,Sit down,The hall,hall,6,,hall',
      '',
    ]);
  });

  it('writes the container id as the file when no name is given, and applies the cell transform to the language and the free text', () => {
    const lines = toYarnCsv(rows, { cell: (value) => (value === '' ? value : `[${value}]`) }).split('\r\n');
    expect(lines[2]).toBe('[en],line:l_0000000002,"[Alice: Welcome, friend.]",[d1],hall,4,,[hall / Alice]');
  });
});
