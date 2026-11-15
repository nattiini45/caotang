/**
 * The spreadsheet reader (#288, epic #263): a `.csv`, `.tsv` or `.txt` grid read into codex rows or timeline rows.
 * The delimiter is sniffed unless the writer chose one, the encoding comes from the shared plain-text reader
 * (UTF-8 with or without a BOM, UTF-16), and a date is read only in the format the writer picked.
 */

import { decodePlainText } from '@caotang/import-read/text';

import { parseCsv, sniffDelimiter, splitList, type CsvGrid, type Delimiter } from './parse.js';
import { guessRoles, readDay, readDuration, type CsvMode, type CsvRole, type DateFormat } from './roles.js';

export interface CsvOptions {
  /** A chosen delimiter, or `auto` (the default) to sniff it. */
  delimiter?: Delimiter | 'auto';
  /** Whether the first row is a header. On by default. */
  header?: boolean;
  mode?: CsvMode;
  /** A role per column, as the writer chose; the guess fills the rest. */
  roles?: readonly CsvRole[];
  dateFormat?: DateFormat;
  /** The date day 0 stands for. */
  anchor?: Date;
}

export interface CsvCodexRow {
  name: string;
  aliases: string[];
  type: string;
  description: string;
  text: string;
  tags: string[];
  include: string;
  image: string;
  relation: string;
  detail: string;
  /** The row's index in the grid, for the report. */
  row: number;
}

export interface CsvTimelineRow {
  title: string;
  startDay: number | null;
  endDay: number | null;
  durationDays: number | null;
  order: number | null;
  marker: string;
  pov: string;
  participants: string[];
  location: string;
  arc: string;
  summary: string;
  body: string;
  row: number;
}

export interface CsvImport {
  grid: CsvGrid;
  headers: string[];
  roles: CsvRole[];
  mode: CsvMode;
  codex: CsvCodexRow[];
  timeline: CsvTimelineRow[];
  /** Rows the reader could not read as asked: a date in the wrong format, a row with no name. */
  problems: string[];
  /** The encoding the bytes were read as, for the report. */
  encoding: string;
}

export type CsvError = { kind: 'ask-encoding' } | { kind: 'empty' } | { kind: 'no-columns' };
export type CsvResult = { ok: true; value: CsvImport } | { ok: false; error: CsvError };

const DEFAULT_ANCHOR = new Date(Date.UTC(2000, 0, 1));

/** Read a spreadsheet's bytes. */
export function readCsv(bytes: Uint8Array, options: CsvOptions = {}): CsvResult {
  const decoded = decodePlainText(bytes);
  if (decoded.status !== 'decoded') return { ok: false, error: { kind: 'ask-encoding' } };
  const text = decoded.text;
  if (text.trim() === '') return { ok: false, error: { kind: 'empty' } };
  const delimiter = options.delimiter === undefined || options.delimiter === 'auto' ? sniffDelimiter(text) : options.delimiter;
  const grid = parseCsv(text, delimiter);
  if (grid.rows.length === 0) return { ok: false, error: { kind: 'empty' } };
  const width = grid.rows[0]?.length ?? 0;
  if (width === 0) return { ok: false, error: { kind: 'no-columns' } };

  const withHeader = options.header !== false;
  const headers = withHeader ? (grid.rows[0] ?? []).map((cell, index) => (cell === '' ? `Column ${index + 1}` : cell)) : Array.from({ length: width }, (_, index) => `Column ${index + 1}`);
  const body = withHeader ? grid.rows.slice(1) : grid.rows;
  const mode = options.mode ?? 'codex';
  const guessed = guessRoles(headers, mode);
  const roles = headers.map((_, index) => options.roles?.[index] ?? guessed[index] ?? 'ignore');
  // A codex import needs a name; a timeline import needs a title. Neither is guessed away when the writer mapped none.
  const required = mode === 'codex' ? 'name' : 'title';
  if (!roles.includes(required)) {
    const first = roles.findIndex((role) => role === 'ignore');
    if (first >= 0) roles[first] = required;
    else roles[0] = required;
  }

  const anchor = options.anchor ?? DEFAULT_ANCHOR;
  const format = options.dateFormat ?? 'iso';
  const problems: string[] = [];
  const cellOf = (row: readonly string[], role: CsvRole): string => {
    const index = roles.indexOf(role);
    return index < 0 ? '' : (row[index] ?? '').trim();
  };

  const codex: CsvCodexRow[] = [];
  const timeline: CsvTimelineRow[] = [];
  for (const [index, row] of body.entries()) {
    const rowNumber = index + (withHeader ? 2 : 1);
    if (row.every((cell) => cell.trim() === '')) continue;
    if (mode === 'codex') {
      const name = cellOf(row, 'name');
      if (name === '') {
        problems.push(`Row ${rowNumber} has no name and was left out.`);
        continue;
      }
      codex.push({
        name,
        aliases: splitList(cellOf(row, 'aliases')),
        type: cellOf(row, 'type'),
        description: cellOf(row, 'description'),
        text: cellOf(row, 'text'),
        tags: splitList(cellOf(row, 'tags')),
        include: cellOf(row, 'include'),
        image: cellOf(row, 'image'),
        relation: cellOf(row, 'relation'),
        detail: cellOf(row, 'detail'),
        row: rowNumber,
      });
      continue;
    }
    const startText = cellOf(row, 'start');
    const endText = cellOf(row, 'end');
    const start = readDay(startText, format, anchor);
    const end = readDay(endText, format, anchor);
    if (start.problem !== undefined) problems.push(`Row ${rowNumber}: ${start.problem}.`);
    if (end.problem !== undefined) problems.push(`Row ${rowNumber}: ${end.problem}.`);
    const durationText = cellOf(row, 'duration');
    const duration = readDuration(durationText);
    if (durationText !== '' && duration === null) problems.push(`Row ${rowNumber}: “${durationText}” is not a length in days.`);
    const orderText = cellOf(row, 'order');
    timeline.push({
      title: cellOf(row, 'title') || `Row ${rowNumber}`,
      startDay: start.day,
      endDay: end.day,
      durationDays: duration,
      order: orderText === '' || !Number.isFinite(Number(orderText)) ? null : Number(orderText),
      marker: cellOf(row, 'marker'),
      pov: cellOf(row, 'pov'),
      participants: splitList(cellOf(row, 'participants')),
      location: cellOf(row, 'location'),
      arc: cellOf(row, 'arc'),
      summary: cellOf(row, 'summary'),
      body: cellOf(row, 'body'),
      row: rowNumber,
    });
  }
  for (const index of grid.ragged) problems.push(`Row ${index + 1} has ${(grid.rows[index] ?? []).length} cells where the first row has ${width}.`);

  return { ok: true, value: { grid, headers, roles, mode, codex, timeline, problems, encoding: decoded.encoding } };
}
