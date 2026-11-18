/**
 * The CSV grid (#288, epic #263): an RFC 4180 reader with delimiter sniffing. Quoted fields keep their commas, their
 * quotes and their newlines; a field that is not quoted is trimmed. No dependency, no streaming, nothing executed.
 */

export type Delimiter = ',' | ';' | '\t' | '|';

export const DELIMITERS: readonly Delimiter[] = [',', ';', '\t', '|'];

/** The grid a file gave: its rows of cells, and the delimiter it was read with. */
export interface CsvGrid {
  rows: string[][];
  delimiter: Delimiter;
  /** Rows whose cell count differs from the first row's: kept, and reported. */
  ragged: number[];
}

/**
 * Which delimiter this text uses: the one that gives the most columns in the most rows, counted outside quotes.
 * A tie goes to the earlier of comma, semicolon, tab, pipe, so a one-column file reads as comma-separated.
 */
export function sniffDelimiter(text: string): Delimiter {
  const sample = text.split(/\r\n|\n|\r/).slice(0, 20).join('\n');
  let best: Delimiter = ',';
  let bestScore = -1;
  for (const delimiter of DELIMITERS) {
    const counts = new Map<number, number>();
    let fields = 1;
    let quoted = false;
    for (let i = 0; i < sample.length; i += 1) {
      const char = sample[i];
      if (char === '"') {
        if (quoted && sample[i + 1] === '"') {
          i += 1;
          continue;
        }
        quoted = !quoted;
        continue;
      }
      if (quoted) continue;
      if (char === delimiter) fields += 1;
      else if (char === '\n') {
        counts.set(fields, (counts.get(fields) ?? 0) + 1);
        fields = 1;
      }
    }
    counts.set(fields, (counts.get(fields) ?? 0) + 1);
    // The most common column count above one, weighted by how many rows agree on it.
    let score = 0;
    for (const [columns, rows] of counts) if (columns > 1) score = Math.max(score, columns * rows);
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

/** Read the text as a grid with this delimiter. */
export function parseCsv(text: string, delimiter: Delimiter): CsvGrid {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;
  // Whether this field opened with a quote. `quoted` goes false again at the closing quote, so it cannot answer this: a quoted
  // field keeps the spaces the writer put inside the quotes, and only an unquoted one is trimmed.
  let wasQuoted = false;
  const endField = (): void => {
    row.push(wasQuoted ? field : field.trim());
    field = '';
    quoted = false;
    started = false;
    wasQuoted = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
          continue;
        }
        quoted = false;
        continue;
      }
      field += char;
      continue;
    }
    if (char === '"' && !started) {
      quoted = true;
      started = true;
      wasQuoted = true;
      continue;
    }
    if (char === delimiter) {
      endField();
      continue;
    }
    if (char === '\r') {
      if (text[i + 1] === '\n') i += 1;
      endRow();
      continue;
    }
    if (char === '\n') {
      endRow();
      continue;
    }
    field += char;
    started = true;
  }
  if (field !== '' || row.length > 0 || started) endRow();
  // A trailing blank line is not a row.
  while (rows.length > 0 && (rows[rows.length - 1] ?? []).every((cell) => cell === '')) rows.pop();
  const width = rows[0]?.length ?? 0;
  const ragged: number[] = [];
  for (const [index, cells] of rows.entries()) if (cells.length !== width) ragged.push(index);
  return { rows, delimiter, ragged };
}

/** Split a list cell: `;`, `,` or a newline, as the spreadsheet exporters write them. */
export function splitList(value: string): string[] {
  return value
    .split(/[;,\n]/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}
