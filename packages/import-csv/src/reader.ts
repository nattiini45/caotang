/**
 * The spreadsheet reader (#288, epic #263): a `.csv`, `.tsv` or `.txt` grid read into codex rows or timeline rows.
 * The delimiter is sniffed unless the writer chose one, the encoding comes from the shared plain-text reader
 * (UTF-8 with or without a BOM, UTF-16), and a date is read only in the format the writer picked. The mapping itself
 * is `readGrid`, which an XLSX worksheet shares (#289).
 */

import { decodePlainText } from '@caotang/import-read/text';

import { parseCsv, sniffDelimiter, type Delimiter } from './parse.js';
import { readGrid, type CsvResult, type GridOptions } from './grid.js';

export type { CsvCodexRow, CsvTimelineRow, CsvImport, CsvError, CsvResult, GridOptions } from './grid.js';
export { readGrid } from './grid.js';

export interface CsvOptions extends GridOptions {
  /** A chosen delimiter, or `auto` (the default) to sniff it. */
  delimiter?: Delimiter | 'auto';
}

/** Read a spreadsheet's bytes. */
export function readCsv(bytes: Uint8Array, options: CsvOptions = {}): CsvResult {
  const decoded = decodePlainText(bytes);
  if (decoded.status !== 'decoded') return { ok: false, error: { kind: 'ask-encoding' } };
  const text = decoded.text;
  if (text.trim() === '') return { ok: false, error: { kind: 'empty' } };
  const delimiter = options.delimiter === undefined || options.delimiter === 'auto' ? sniffDelimiter(text) : options.delimiter;
  return readGrid(parseCsv(text, delimiter), options, decoded.encoding);
}
