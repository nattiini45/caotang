/**
 * One worksheet as a grid of strings (#289, epic #263): shared and inline strings, numbers, booleans, errors, and a
 * formula's **cached value** (nothing is calculated). A date cell becomes `YYYY-MM-DD` in the workbook's own date
 * system, so the grid reads exactly as the CSV twin Excel would write.
 */

import type { CsvGrid } from '@caotang/import-csv';
import { attr, readXml, textOf, type XmlElement } from '@caotang/import-read/xml';

import { isDateStyle, type XlsxWorkbook } from './workbook.js';

/**
 * The most rows, columns, cells and characters one worksheet may hold. Excel's own row limit is 1,048,576 and its last column is
 * XFD (16,384 columns); a story bible is far smaller. The column cap is a safety bound, not a convenience: a cell's reference places
 * it, so an invented one like `AAAAAAAA1` asks for 8.35 billion columns and the grid would try to allocate them.
 */
export const SHEET_LIMITS = Object.freeze({ maxRows: 100_000, maxColumns: 16_384, maxCells: 2_000_000, maxCellChars: 32_768 });

export type SheetError = { kind: 'not-xml'; message: string } | { kind: 'too-many-rows' } | { kind: 'too-many-columns' } | { kind: 'too-many-cells' };

export interface SheetReading {
  grid: CsvGrid;
  /** Cells whose formula was read as its cached value. */
  formulas: number;
  /** Date cells that carried a time of day, which the grid does not keep. */
  times: number;
  /** Cells holding an error value (`#REF!`, `#N/A`, …), kept as their text. */
  errors: number;
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
 * February 1900, a day that never was, so every serial above it sits one day later than a plain count would give.
 */
export function serialDate(serial: number, date1904: boolean): { date: string; time: boolean } {
  const whole = Math.floor(serial);
  const fraction = serial - whole;
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  const shift = date1904 || whole < 60 ? whole : whole - 1;
  const at = new Date(base + shift * 86_400_000);
  return { date: at.toISOString().slice(0, 10), time: fraction > 0 };
}

/** A number as Excel would write it to CSV: no exponent for ordinary values, no trailing `.0`. */
function numberOf(text: string): string {
  const value = Number(text);
  if (!Number.isFinite(value)) return text;
  return String(value);
}

/** Read one worksheet part into a grid. */
export function sheetGrid(bytes: Uint8Array, workbook: XlsxWorkbook, path: string): { ok: true; value: SheetReading } | { ok: false; error: SheetError } {
  const xml = readXml(bytes);
  if (!xml.ok) return { ok: false, error: { kind: 'not-xml', message: `${path}: ${xml.error.message}` } };
  const data = kid(xml.document.root, 'sheetData');
  const rows: string[][] = [];
  let formulas = 0;
  let times = 0;
  let errors = 0;
  let cells = 0;
  let width = 0;

  for (const [index, row] of (data === undefined ? [] : kids(data, 'row')).entries()) {
    const at = rowNumber(attr(row, 'r') ?? '');
    const place = at >= 0 ? at : index;
    if (place >= SHEET_LIMITS.maxRows) return { ok: false, error: { kind: 'too-many-rows' } };
    while (rows.length <= place) rows.push([]);
    const cellsOfRow = rows[place] as string[];
    let next = 0;
    for (const cell of kids(row, 'c')) {
      cells += 1;
      if (cells > SHEET_LIMITS.maxCells) return { ok: false, error: { kind: 'too-many-cells' } };
      const reference = attr(cell, 'r') ?? '';
      const column = columnIndex(reference);
      const slot = column >= 0 ? column : next;
      if (slot >= SHEET_LIMITS.maxColumns) return { ok: false, error: { kind: 'too-many-columns' } };
      next = slot + 1;
      while (cellsOfRow.length <= slot) cellsOfRow.push('');
      const type = attr(cell, 't') ?? 'n';
      const value = kid(cell, 'v');
      const raw = value === undefined ? '' : textOf(value);
      if (kid(cell, 'f') !== undefined) formulas += 1;
      let text: string;
      if (type === 's') text = workbook.shared[Number(raw)] ?? '';
      else if (type === 'inlineStr') {
        const inline = kid(cell, 'is');
        text = inline === undefined ? '' : textOf(inline);
      } else if (type === 'b') text = raw === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'e') {
        errors += 1;
        text = raw;
      } else if (type === 'str') text = raw;
      else if (raw === '') text = '';
      else {
        const style = Number(attr(cell, 's') ?? '0');
        const serial = Number(raw);
        if (isDateStyle(workbook, style) && Number.isFinite(serial)) {
          const reading = serialDate(serial, workbook.date1904);
          if (reading.time) times += 1;
          text = reading.date;
        } else text = numberOf(raw);
      }
      cellsOfRow[slot] = text.length > SHEET_LIMITS.maxCellChars ? text.slice(0, SHEET_LIMITS.maxCellChars) : text;
      if (slot + 1 > width) width = slot + 1;
    }
  }

  // Every row as wide as the widest, and no trailing blank rows: the grid a CSV of this sheet would give.
  const grid: CsvGrid = { rows: rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? '')), delimiter: 'none', ragged: [] };
  while (grid.rows.length > 0 && (grid.rows[grid.rows.length - 1] ?? []).every((cell) => cell === '')) grid.rows.pop();
  return { ok: true, value: { grid, formulas, times, errors } };
}
