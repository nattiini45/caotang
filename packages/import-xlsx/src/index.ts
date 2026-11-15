/**
 * The Excel workbook reader (#289, epic #263): sheets, shared and inline strings, cached formula values and dates in the
 * 1900 or 1904 system, into the same grid the CSV reader maps. No DOM, no SheetJS, no dependency of its own.
 */

export { readXlsx, type XlsxImport, type XlsxOptions, type XlsxError, type XlsxResult } from './reader.js';
export { readWorkbook, isDateFormat, isDateStyle, type XlsxWorkbook, type XlsxSheet, type WorkbookError } from './workbook.js';
export { sheetGrid, serialDate, columnIndex, SHEET_LIMITS, type SheetReading, type SheetError } from './sheet.js';
