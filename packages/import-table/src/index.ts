/** `@caotang/import-table` — CSV/TSV spreadsheet rows for codex entries and timeline scenes (#288). */

export { MAX_TABLE_COLUMNS, MAX_TABLE_ROWS, parseDelimitedText, parseTableText, sniffDelimiter, tableColumns, type TableCellRow, type TableDelimiter, type TableParse, type TableParseLoss, type TableParseLossCode, type TableParseResult } from './parse.js';
export { TYPE_WORDS, typeWord, buildTimelineRows, parseDurationDays, guessColumnRoles, mapCodexRows, splitCellList, TABLE_COLUMN_ROLES, type CodexColumnRole, type ColumnRole, type MappedCodexRow, type MappedTimelineRow, type MappingLoss, type TimelineColumnRole, type TimelineDateFormat } from './map.js';
