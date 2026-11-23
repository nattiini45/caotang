/**
 * The spreadsheet reader (#288, epic #263): synthetic CSV and TSV files — a German Excel semicolon file, a UTF-16
 * "Unicode text" file, quoted newlines, a story bible and a timeline with ISO dates, "Day N" values and arcs.
 */

import { describe, expect, it } from 'vitest';

import { parseCsv, sniffDelimiter, splitList } from '../src/parse.js';
import { guessRoles, readDay, readDuration } from '../src/roles.js';
import { readCsv } from '../src/reader.js';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const utf16 = (text: string): Uint8Array => {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    bytes[2 + i * 2] = code & 0xff;
    bytes[3 + i * 2] = code >> 8;
  }
  return bytes;
};

const ANCHOR = new Date(Date.UTC(2026, 0, 1));

describe('the grid (#288)', () => {
  it('sniffs comma, semicolon, tab and pipe', () => {
    expect(sniffDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(sniffDelimiter('a|b|c\n1|2|3')).toBe('|');
    // A quoted comma is not a delimiter.
    expect(sniffDelimiter('a;b\n"x,y";2')).toBe(';');
  });

  it('keeps quoted commas, quotes and newlines, and reports a ragged row', () => {
    const grid = parseCsv('name,note\nElena,"She said ""hello"", then left\nand waited"\nMara,short,extra\n', ',');
    expect(grid.rows[0]).toEqual(['name', 'note']);
    expect(grid.rows[1]).toEqual(['Elena', 'She said "hello", then left\nand waited']);
    expect(grid.ragged).toEqual([2]);
  });

  it('keeps the spaces a writer put inside quotes, and trims only an unquoted cell', () => {
    const grid = parseCsv('name,note\nElena,"  spaced  "\nMara,  plain  \n', ',');
    expect(grid.rows[1]).toEqual(['Elena', '  spaced  ']);
    expect(grid.rows[2]).toEqual(['Mara', 'plain']);
  });

  it('reads a UTF-16 file and a BOM', () => {
    const text = 'name;type\nElena;character\n';
    const read = readCsv(utf16(text), { mode: 'codex' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.grid.delimiter).toBe(';');
    expect(read.value.codex.map((row) => row.name)).toEqual(['Elena']);
    const bom = readCsv(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('name,type\nMara,character\n')]), { mode: 'codex' });
    expect(bom.ok && bom.value.codex[0]?.name).toBe('Mara');
  });

  it('splits a list cell on semicolons, commas and newlines', () => {
    expect(splitList('Elena; Mara,Kai\nLena')).toEqual(['Elena', 'Mara', 'Kai', 'Lena']);
  });
});

describe('the columns (#288)', () => {
  it('guesses each role once, from the synonym table', () => {
    expect(guessRoles(['Name', 'Also known as', 'Type', 'Description', 'Tags', 'Notes'], 'codex')).toEqual(['name', 'aliases', 'type', 'description', 'tags', 'ignore']);
    expect(guessRoles(['Title', 'Start', 'Duration', 'POV', 'Characters', 'Plotline', 'Summary'], 'timeline')).toEqual(['title', 'start', 'duration', 'pov', 'participants', 'arc', 'summary']);
    expect(guessRoles(['Name', 'Name'], 'codex')).toEqual(['name', 'ignore']);
  });

  it('reads a date only in the chosen format, and Day N and integers in any', () => {
    expect(readDay('2026-01-04', 'iso', ANCHOR).day).toBe(3);
    expect(readDay('04.01.2026', 'dmy', ANCHOR).day).toBe(3);
    expect(readDay('01/04/2026', 'mdy', ANCHOR).day).toBe(3);
    expect(readDay('2025-12-31', 'iso', ANCHOR).day).toBe(-1);
    expect(readDay('Day 7', 'iso', ANCHOR).day).toBe(7);
    expect(readDay('-3', 'iso', ANCHOR).day).toBe(-3);
    expect(readDay('04.01.2026', 'iso', ANCHOR).problem).toBeDefined();
    expect(readDay('31.31.2026', 'dmy', ANCHOR).problem).toBeDefined();
    expect(readDuration('3 days')).toBe(3);
    expect(readDuration('2w')).toBe(14);
    expect(readDuration('soon')).toBeNull();
  });
});

describe('the two modes (#288)', () => {
  const bible = 'Name,Also known as,Type,Description,Tags,Long text\nElena,Lena;El,Protagonist,"A cartographer, back from sea",harbour;returning,"She maps the harbour.\n\nNine steps down."\n';

  it('reads a story bible into codex rows', () => {
    const read = readCsv(enc(bible), { mode: 'codex' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.roles).toEqual(['name', 'aliases', 'type', 'description', 'tags', 'text']);
    const row = read.value.codex[0];
    expect(row?.name).toBe('Elena');
    expect(row?.aliases).toEqual(['Lena', 'El']);
    expect(row?.type).toBe('Protagonist');
    expect(row?.description).toBe('A cartographer, back from sea');
    expect(row?.tags).toEqual(['harbour', 'returning']);
    expect(row?.text).toBe('She maps the harbour.\n\nNine steps down.');
  });

  it('reads a timeline with day offsets, durations, POV, participants and arcs', () => {
    const csv = 'Title,Start,Duration,POV,Characters,Plotline,Summary\nThe Landing,2026-01-04,2 days,Elena,"Mara;Kai",The Pier,"The ferry came at noon."\nSalt,Day 9,1,Mara,Elena,The Pier,"The letter arrived."\n';
    const read = readCsv(enc(csv), { mode: 'timeline', anchor: ANCHOR });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.timeline.map((row) => [row.title, row.startDay, row.durationDays, row.pov, row.participants, row.arc])).toEqual([
      ['The Landing', 3, 2, 'Elena', ['Mara', 'Kai'], 'The Pier'],
      ['Salt', 9, 1, 'Mara', ['Elena'], 'The Pier'],
    ]);
    expect(read.value.problems).toEqual([]);
    expect(read.value.anchor).toBe('2026-01-01');
  });

  it('counts days from the first date in the file when the writer gave no anchor', () => {
    const csv = 'Title,Start\nThe Landing,2026-01-04\nSalt,2026-01-09\n';
    const read = readCsv(enc(csv), { mode: 'timeline' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.anchor).toBe('2026-01-04');
    expect(read.value.timeline.map((row) => row.startDay)).toEqual([0, 5]);
  });

  it('reports a row with no name, a bad date and a ragged row rather than dropping them silently', () => {
    const read = readCsv(enc('Name,Type\n,character\nElena,character,extra\n'), { mode: 'codex' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.codex.map((row) => row.name)).toEqual(['Elena']);
    expect(read.value.problems.some((problem) => problem.includes('has no name'))).toBe(true);
    expect(read.value.problems.some((problem) => problem.includes('cells where the first row'))).toBe(true);

    const bad = readCsv(enc('Title,Start\nThe Landing,04.01.2026\n'), { mode: 'timeline', dateFormat: 'iso', anchor: ANCHOR });
    expect(bad.ok).toBe(true);
    if (!bad.ok) return;
    expect(bad.value.timeline[0]?.startDay).toBeNull();
    expect(bad.value.problems.some((problem) => problem.includes('not a date in the chosen format'))).toBe(true);
  });

  it('takes the writer’s delimiter, header and column choices over its own guess', () => {
    const read = readCsv(enc('Elena;Protagonist\nMara;Antagonist\n'), { mode: 'codex', delimiter: ';', header: false, roles: ['name', 'type'] });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.headers).toEqual(['Column 1', 'Column 2']);
    expect(read.value.codex.map((row) => [row.name, row.type])).toEqual([
      ['Elena', 'Protagonist'],
      ['Mara', 'Antagonist'],
    ]);
  });

  it('refuses an empty file', () => {
    const read = readCsv(enc('   \n'));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.kind).toBe('empty');
  });
});
