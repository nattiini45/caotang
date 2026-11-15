/**
 * The Excel workbook reader (#289, epic #263): an `.xlsx` opened on the shared zip reader, one worksheet chosen by name,
 * its cells read into the grid the CSV reader maps (`readGrid`), so a workbook and its CSV twin give the same rows.
 * No SheetJS: its licence and size do not fit, and a workbook is a zip of XML this project already reads.
 */

import { readGrid, type CsvError, type CsvImport, type GridOptions } from '@caotang/import-csv';
import { openZip } from '@caotang/import-read/zip';

import { sheetGrid, type SheetError } from './sheet.js';
import { readWorkbook, type WorkbookError } from './workbook.js';

export interface XlsxOptions extends GridOptions {
  /** The worksheet to read, by the name the writer sees. The first sheet when absent. */
  sheet?: string;
}

export interface XlsxImport {
  /** Every worksheet's name, in workbook order, for the sheet picker. */
  sheets: string[];
  /** The worksheet these rows came from. */
  sheet: string;
  rows: CsvImport;
  /** Cells read as their formula's cached value. */
  formulas: number;
  /** Date cells whose time of day the grid does not keep. */
  times: number;
  /** Cells holding an error value, kept as their text. */
  errors: number;
}

export type XlsxError = WorkbookError | SheetError | CsvError | { kind: 'archive'; message: string } | { kind: 'unknown-sheet'; name: string };
export type XlsxResult = { ok: true; value: XlsxImport } | { ok: false; error: XlsxError };

/** Read a workbook's chosen worksheet as codex rows or timeline rows. */
export async function readXlsx(bytes: Uint8Array, options: XlsxOptions = {}): Promise<XlsxResult> {
  const archive = await openZip(bytes);
  if (!archive.ok) return { ok: false, error: { kind: 'archive', message: archive.error.message } };
  const workbook = await readWorkbook(archive.value);
  if (!workbook.ok) return { ok: false, error: workbook.error };
  const names = workbook.value.sheets.map((sheet) => sheet.name);
  const chosen = options.sheet === undefined ? workbook.value.sheets[0] : workbook.value.sheets.find((sheet) => sheet.name === options.sheet);
  if (chosen === undefined) return { ok: false, error: { kind: 'unknown-sheet', name: options.sheet ?? '' } };
  const bytesOfSheet = await archive.value.read(chosen.path);
  if (!bytesOfSheet.ok) return { ok: false, error: { kind: 'archive', message: bytesOfSheet.error.message } };
  const reading = sheetGrid(bytesOfSheet.value, workbook.value, chosen.path);
  if (!reading.ok) return { ok: false, error: reading.error };
  const rows = readGrid(reading.value.grid, options, 'xlsx');
  if (!rows.ok) return { ok: false, error: rows.error };
  return {
    ok: true,
    value: { sheets: names, sheet: chosen.name, rows: rows.value, formulas: reading.value.formulas, times: reading.value.times, errors: reading.value.errors },
  };
}
