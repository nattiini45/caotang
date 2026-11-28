/**
 * The Excel workbook reader (#289): an `.xlsx` opened on the shared zip reader, one worksheet chosen by name,
 * its cells read into the same rows the CSV/TSV table import maps. No SheetJS: a workbook is a zip of XML this
 * project already reads.
 */

import { openZip } from '@caotang/import-read/zip';
import type { TableCellRow } from '@caotang/import-table';

import { sheetGrid, type SheetError } from './sheet.js';
import { readWorkbook, type WorkbookError } from './workbook.js';

export interface XlsxOptions {
  /** The worksheet to read, by the name the writer sees. The first sheet when absent. */
  readonly sheet?: string;
}

export interface XlsxImport {
  /** Every worksheet's name, in workbook order, for the sheet picker. */
  readonly sheets: string[];
  /** The worksheet these rows came from. */
  readonly sheet: string;
  readonly rows: TableCellRow[];
  /** Cells read as their formula's cached value. */
  readonly formulas: number;
  /** Date cells whose time of day the rows do not keep. */
  readonly times: number;
  /** Cells holding an error value, kept as their text. */
  readonly errors: number;
  /** Cells cut at Excel's own character limit. */
  readonly truncatedCells: number;
}

export type XlsxError = WorkbookError | SheetError | { readonly kind: 'archive'; readonly message: string } | { readonly kind: 'unknown-sheet'; readonly name: string };
export type XlsxResult = { readonly ok: true; readonly value: XlsxImport } | { readonly ok: false; readonly error: XlsxError };

/** Read a workbook's chosen worksheet as table rows. */
export async function readXlsx(bytes: Uint8Array, options: XlsxOptions = {}): Promise<XlsxResult> {
  const archive = await openZip(bytes);
  if (!archive.ok) return { ok: false, error: { kind: 'archive', message: archive.error.message } };
  const workbook = await readWorkbook(archive.value);
  if (!workbook.ok) return { ok: false, error: workbook.error };
  const names = workbook.value.sheets.map((sheet) => sheet.name);
  const candidates = options.sheet === undefined ? workbook.value.sheets : workbook.value.sheets.filter((sheet) => sheet.name === options.sheet);
  if (candidates.length === 0) return { ok: false, error: { kind: 'unknown-sheet', name: options.sheet ?? '' } };
  let empty: SheetError | undefined;
  let chosen = candidates[0] as (typeof candidates)[number];
  let reading: ReturnType<typeof sheetGrid> | undefined;
  for (const candidate of candidates) {
    const bytesOfSheet = await archive.value.read(candidate.path);
    if (!bytesOfSheet.ok) return { ok: false, error: { kind: 'archive', message: bytesOfSheet.error.message } };
    reading = sheetGrid(bytesOfSheet.value, workbook.value, candidate.path);
    chosen = candidate;
    if (reading.ok || reading.error.kind !== 'empty' || options.sheet !== undefined) break;
    empty ??= reading.error;
    reading = undefined;
  }
  if (reading === undefined) return { ok: false, error: empty ?? { kind: 'empty' } };
  if (!reading.ok) return { ok: false, error: reading.error };
  return {
    ok: true,
    value: {
      sheets: names,
      sheet: chosen.name,
      rows: reading.value.rows,
      formulas: reading.value.formulas,
      times: reading.value.times,
      errors: reading.value.errors,
      truncatedCells: reading.value.truncatedCells,
    },
  };
}
