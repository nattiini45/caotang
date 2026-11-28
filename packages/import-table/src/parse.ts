/**
 * RFC 4180 delimited text for spreadsheet imports (#288): quoting with embedded newlines, comma/semicolon/tab/pipe
 * delimiter sniffing, row/column caps, and losses instead of silent repairs. Pure and DOM-free.
 */

export type TableDelimiter = ',' | ';' | '\t' | '|';

export interface TableCellRow {
  readonly cells: string[];
  /** The 1-based line on which the row starts in the decoded text. */
  readonly line: number;
}

export type TableParseLossCode = 'unterminated-quote' | 'inconsistent-row' | 'empty' | 'too-many-rows' | 'too-many-columns';

export interface TableParseLoss {
  readonly code: TableParseLossCode;
  readonly line?: number;
  readonly count?: number;
}

export interface TableParse {
  readonly delimiter: TableDelimiter;
  readonly rows: TableCellRow[];
  readonly losses: TableParseLoss[];
}

export type TableParseResult = { readonly ok: true; readonly value: TableParse } | { readonly ok: false; readonly error: { readonly kind: 'empty' | 'too-many-rows' | 'too-many-columns'; readonly limit?: number } };

export const MAX_TABLE_ROWS = 10_000;
export const MAX_TABLE_COLUMNS = 200;

interface ParseOptions {
  readonly delimiter?: TableDelimiter;
  readonly maxRows?: number;
  readonly maxColumns?: number;
}

interface MutableParse {
  rows: TableCellRow[];
  losses: TableParseLoss[];
  error: 'too-many-rows' | 'too-many-columns' | null;
}

/** Parse already-normalized text with one delimiter. Unterminated quoting keeps the text read so far and is named. */
export function parseDelimitedText(text: string, delimiter: TableDelimiter, options: ParseOptions = {}): MutableParse {
  const maxRows = options.maxRows ?? MAX_TABLE_ROWS;
  const maxColumns = options.maxColumns ?? MAX_TABLE_COLUMNS;
  const rows: TableCellRow[] = [];
  const losses: TableParseLoss[] = [];
  let error: MutableParse['error'] = null;
  let field = '';
  let cells: string[] = [];
  let rowLine = 1;
  let line = 1;
  let quoted = false;
  let atFieldStart = true;
  let inconsistent = 0;

  const endField = (): void => {
    cells.push(field);
    field = '';
    atFieldStart = true;
  };
  const endRow = (): void => {
    endField();
    if (cells.length > maxColumns && error === null) error = 'too-many-columns';
    rows.push({ cells, line: rowLine });
    if (rows.length > maxRows && error === null) error = 'too-many-rows';
    if (rows.length > 1 && cells.length !== rows[0]?.cells.length) inconsistent += 1;
    cells = [];
    rowLine = line + 1;
  };

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
        if (ch === '\n') line += 1;
      }
      continue;
    }
    if (ch === '"' && atFieldStart && field === '') {
      quoted = true;
      atFieldStart = false;
      continue;
    }
    if (ch === delimiter) {
      endField();
      continue;
    }
    if (ch === '\n') {
      endRow();
      line += 1;
      if (error !== null) break;
      continue;
    }
    if (ch === '\r') {
      if (text[index + 1] === '\n') continue;
      endRow();
      line += 1;
      if (error !== null) break;
      continue;
    }
    field += ch;
    atFieldStart = false;
  }
  if (quoted) losses.push({ code: 'unterminated-quote', line: rowLine });
  if (error === null && (field !== '' || cells.length > 0 || text.endsWith(delimiter))) endRow();
  if (inconsistent > 0) losses.push({ code: 'inconsistent-row', count: inconsistent });
  return { rows: rows.filter((row) => row.cells.some((cell) => cell !== '')), losses, error };
}

const DELIMITERS: readonly TableDelimiter[] = [',', ';', '\t', '|'];

function score(parse: MutableParse): number {
  if (parse.rows.length === 0) return 0;
  const widths = parse.rows.map((row) => row.cells.length);
  const width = widths[0] ?? 0;
  if (width <= 1) return 0;
  const consistent = widths.filter((candidate) => candidate === width).length;
  return consistent * 100 + width * 10 + Math.min(parse.rows.length, 20);
}

/** Pick the delimiter that makes the most consistent multi-column rows; an explicit delimiter wins. */
export function sniffDelimiter(text: string): TableDelimiter {
  let best: TableDelimiter = ',';
  let bestScore = -1;
  for (const delimiter of DELIMITERS) {
    const candidate = parseDelimitedText(text, delimiter, { maxRows: 50 });
    const value = score(candidate);
    if (value > bestScore) {
      best = delimiter;
      bestScore = value;
    }
  }
  return best;
}

/** Parse table text, sniffing the delimiter when the caller does not name one. */
export function parseTableText(text: string, options: ParseOptions = {}): TableParseResult {
  const delimiter = options.delimiter ?? sniffDelimiter(text);
  const parsed = parseDelimitedText(text.replace(/\r\n?/g, '\n'), delimiter, options);
  if (parsed.error !== null) {
    return { ok: false, error: { kind: parsed.error, limit: parsed.error === 'too-many-rows' ? (options.maxRows ?? MAX_TABLE_ROWS) : (options.maxColumns ?? MAX_TABLE_COLUMNS) } };
  }
  if (parsed.rows.length === 0) return { ok: false, error: { kind: 'empty' } };
  return { ok: true, value: { delimiter, rows: parsed.rows, losses: parsed.losses } };
}

/** Split the first row into column names when the writer says it is a header. */
export function tableColumns(rows: readonly TableCellRow[], header: boolean): { columns: string[]; data: readonly TableCellRow[] } {
  const width = Math.max(...rows.map((row) => row.cells.length));
  const first = rows[0]?.cells ?? [];
  const columns = Array.from({ length: width }, (_, index) => (header ? (first[index] ?? '').trim() : '') || `Column ${index + 1}`);
  return { columns, data: header ? rows.slice(1) : rows };
}
