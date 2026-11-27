/**
 * One worksheet as table rows (#289): shared and inline strings, numbers, booleans, errors, and a formula's
 * cached value (nothing is calculated). A date cell becomes `YYYY-MM-DD` in the workbook's own date system,
 * so the rows read exactly as the CSV twin Excel would write.
 */

import { attr, readXml, textOf, type XmlElement } from '@caotang/import-read/xml';
import { MAX_TABLE_COLUMNS, MAX_TABLE_ROWS, type TableCellRow } from '@caotang/import-table';

import { isDateStyle, xlsxString, type XlsxWorkbook } from './workbook.js';

/**
 * The safety caps one worksheet may hold. Excel's own last column is XFD (16,384): a cell reference places its cell,
 * so accepting an invented reference such as `AAAAAAAA1` would otherwise ask for billions of columns. Rows and output
 * columns then use the shared table import's caps, because wider or taller output cannot be mapped in its grid.
 */
export const SHEET_LIMITS = Object.freeze({
  maxRows: MAX_TABLE_ROWS,
  maxColumns: MAX_TABLE_COLUMNS,
  maxReferenceColumns: 16_384,
  maxCells: 2_000_000,
  maxCellChars: 32_767,
});

export type SheetError = { readonly kind: 'not-xml'; readonly message: string } | { readonly kind: 'too-many-rows' } | { readonly kind: 'too-many-columns' } | { readonly kind: 'too-many-cells' } | { readonly kind: 'empty' };

export interface SheetReading {
  readonly rows: TableCellRow[];
  /** Cells whose formula was read as its cached value. */
  readonly formulas: number;
  /** Date cells that carried a time of day, which the rows do not keep. */
  readonly times: number;
  /** Cells holding an error value (`#REF!`, `#N/A`, …), kept as their text. */
  readonly errors: number;
  /** Cells cut at Excel's own character limit. */
  readonly truncatedCells: number;
}

function kids(element: XmlElement, local: string): XmlElement[] {
  return element.children.filter((child): child is XmlElement => child.type === 'element' && child.local === local);
}
const kid = (element: XmlElement, local: string): XmlElement | undefined => kids(element, local)[0];

/** `BC12` → column 54 (0-based). Letters only; a malformed reference gives -1. */
export function columnIndex(reference: string): number {
  const letters = /^([A-Za-z]+)/.exec(reference)?.[1];
  if (letters === undefined) return -1;
  let index = 0;
  for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/** The row number a `row` or `c` reference names, or -1. */
function rowNumber(reference: string): number {
  const digits = /(\d+)$/.exec(reference)?.[1];
  return digits === undefined ? -1 : Number(digits) - 1;
}

/**
 * An Excel serial as `YYYY-MM-DD`. The 1900 system carries Lotus 1-2-3's leap-year bug: serial 60 is the 29th of
 * February 1900, a day that never was, so it reads as the 28th rather than shifting every later date.
 */
export function serialDate(serial: number, date1904: boolean): { date: string; time: boolean } {
  const whole = Math.floor(serial);
  const fraction = serial - whole;
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  const shift = date1904 || whole < 60 ? whole : whole - 1;
  const at = new Date(base + shift * 86_400_000);
  return { date: at.toISOString().slice(0, 10), time: fraction > 0 };
}

/** An inline string: its own `t`, or every run's `t`, without phonetic reading aids. */
function inlineText(container: XmlElement): string {
  const own = kid(container, 't');
  if (own !== undefined) return xlsxString(textOf(own));
  return kids(container, 'r')
    .map((run) => kid(run, 't'))
    .filter((text): text is XmlElement => text !== undefined)
    .map((text) => xlsxString(textOf(text)))
    .join('');
}

/** A number as Excel would write it to CSV: no exponent for ordinary values, no trailing `.0`. */
function numberOf(text: string): string {
  const value = Number(text);
  if (!Number.isFinite(value)) return text;
  return String(value);
}

/** Read one worksheet part into table rows. Wholly blank rows are omitted, as the RFC 4180 reader omits them. */
export function sheetGrid(bytes: Uint8Array, workbook: XlsxWorkbook, path: string): { ok: true; value: SheetReading } | { ok: false; error: SheetError } {
  const xml = readXml(bytes);
  if (!xml.ok) return { ok: false, error: { kind: 'not-xml', message: `${path}: ${xml.error.message}` } };
  const data = kid(xml.document.root, 'sheetData');
  const sparse = new Map<number, Map<number, string>>();
  let formulas = 0;
  let times = 0;
  let errors = 0;
  let truncatedCells = 0;
  let cells = 0;

  for (const [index, row] of (data === undefined ? [] : kids(data, 'row')).entries()) {
    const at = rowNumber(attr(row, 'r') ?? '');
    const place = at >= 0 ? at : index;
    let next = 0;
    for (const cell of kids(row, 'c')) {
      cells += 1;
      if (cells > SHEET_LIMITS.maxCells) return { ok: false, error: { kind: 'too-many-cells' } };
      const reference = attr(cell, 'r') ?? '';
      const column = columnIndex(reference);
      const slot = column >= 0 ? column : next;
      if (slot >= SHEET_LIMITS.maxReferenceColumns) return { ok: false, error: { kind: 'too-many-columns' } };
      next = slot + 1;
      const type = attr(cell, 't') ?? 'n';
      const value = kid(cell, 'v');
      const raw = value === undefined ? '' : textOf(value);
      if (kid(cell, 'f') !== undefined) formulas += 1;
      let text: string;
      if (type === 's') text = raw === '' ? '' : workbook.shared[Number(raw)] ?? '';
      else if (type === 'inlineStr') {
        const inline = kid(cell, 'is');
        text = inline === undefined ? '' : inlineText(inline);
      } else if (type === 'b') text = raw === '' ? '' : raw === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'e') {
        if (raw !== '') errors += 1;
        text = raw;
      } else if (type === 'str') text = xlsxString(raw);
      else if (raw === '') text = '';
      else {
        const style = Number(attr(cell, 's') ?? '0');
        const serial = Number(raw);
        const newestSerial = workbook.date1904 ? 2_957_003 : 2_958_465;
        if (isDateStyle(workbook, style) && Number.isFinite(serial) && serial >= 0 && serial < newestSerial + 1) {
          const reading = serialDate(serial, workbook.date1904);
          if (reading.time) times += 1;
          text = reading.date;
        } else text = numberOf(raw);
      }
      if (text.length > SHEET_LIMITS.maxCellChars) {
        const characters = [...text];
        if (characters.length > SHEET_LIMITS.maxCellChars) {
          truncatedCells += 1;
          text = characters.slice(0, SHEET_LIMITS.maxCellChars).join('');
        }
      }
      if (text !== '') {
        let rowCells = sparse.get(place);
        if (rowCells === undefined) {
          rowCells = new Map();
          sparse.set(place, rowCells);
        }
        rowCells.set(slot, text);
      }
    }
  }

  const filled = [...sparse.entries()].sort(([left], [right]) => left - right);
  if (filled.length > SHEET_LIMITS.maxRows) return { ok: false, error: { kind: 'too-many-rows' } };
  const widestKey = filled.reduce((widest, [, row]) => Math.max(widest, ...row.keys()), -1);
  const width = widestKey + 1;
  if (width > SHEET_LIMITS.maxColumns) return { ok: false, error: { kind: 'too-many-columns' } };
  if (filled.length === 0) return { ok: false, error: { kind: 'empty' } };
  const rows = filled.map(([line, row]) => ({ line: line + 1, cells: Array.from({ length: width }, (_, column) => row.get(column) ?? '') }));
  return { ok: true, value: { rows, formulas, times, errors, truncatedCells } };
}
