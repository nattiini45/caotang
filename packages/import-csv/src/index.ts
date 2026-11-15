/**
 * The spreadsheet reader (#288, epic #263): a `.csv`, `.tsv` or `.txt` grid read into codex rows or timeline rows —
 * RFC 4180 quoting, delimiter sniffing, a synonym table for the columns, and dates read only in the chosen format.
 * No DOM, no dependency.
 */

export { parseCsv, sniffDelimiter, splitList, DELIMITERS, type CsvGrid, type Delimiter } from './parse.js';
export {
  guessRole,
  guessRoles,
  readDay,
  readDuration,
  CODEX_ROLES,
  TIMELINE_ROLES,
  DATE_FORMATS,
  type CsvMode,
  type CsvRole,
  type CodexRole,
  type TimelineRole,
  type DateFormat,
  type DayReading,
} from './roles.js';
export { readCsv, readGrid, type CsvImport, type CsvOptions, type GridOptions, type CsvError, type CsvResult, type CsvCodexRow, type CsvTimelineRow } from './reader.js';
