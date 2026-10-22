/**
 * The table's locale and the Yarn Spinner strings file (dialogue-narrative.md §2.1, §6): each row's locale is its container's
 * `locBaseline`, else the table's default; `toCsv` appends the `locale` column only when asked; `toYarnCsv` writes Yarn's columns.
 */
import { createHash } from 'node:crypto';

import type { CodexEntry } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import { TABLE_COLUMNS, YARN_COLUMNS, buildRows, toCsv, toYarnCsv, type TableRow } from '../src/index.js';

const lockOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);

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
      'en,line:l_0000000001,Hello from the top.,The hall,,1,3b0caa91,',
      'en,line:l_0000000002,"Alice: Welcome, friend.",The hall,hall,4,58c93c51,hall / Alice',
      'en,line:l_0000000003,"Bob: ""Thanks.""",The hall,hall,5,2c719ae6,hall',
      'en,line:l_0000000004_c,Sit down,The hall,hall,6,f2808121,hall',
      '',
    ]);
  });

  it('fills lock with the first 8 hex characters of the SHA-256 of the text before the cell transform', () => {
    const odd = ['say "hi", ok', 'tab\there', 'two\nlines', '\u{1F600} café', '=1+1'];
    const source = odd.map((text) => ({ ...(rows[0] as TableRow), text, speakerName: '' }));
    const records = toYarnCsv(source, { cell: (value) => `'${value}` }).split('\r\n').slice(1, -1);
    // Every record ends `,<lock>,<comment>`; the comment here is the guarded context, which holds no comma.
    const locks = records.map((record) => record.split(',').slice(-2)[0]);
    expect(locks).toEqual(odd.map(lockOf));
  });

  it('hashes the speaker-prefixed text of a line and the bare label of a choice', () => {
    const locks = toYarnCsv(rows)
      .split('\r\n')
      .map((record) => record.split(',').slice(-2)[0]);
    expect(locks[2]).toBe(lockOf('Alice: Welcome, friend.'));
    expect(locks[4]).toBe(lockOf('Sit down'));
  });

  it('writes the container id as the file when no name is given, and applies the cell transform to the language and the free text', () => {
    const lines = toYarnCsv(rows, { cell: (value) => (value === '' ? value : `[${value}]`) }).split('\r\n');
    expect(lines[2]).toBe('[en],line:l_0000000002,"[Alice: Welcome, friend.]",[d1],hall,4,58c93c51,[hall / Alice]');
  });
});
