/**
 * The timeline's table as a spreadsheet (timeline.md §8, `timeline-xlsx`): the CSV's rows and columns through the
 * one workbook writer, `render-xlsx.ts`. The reading index, day, duration and end day are number cells, so the
 * spreadsheet sorts and sums them — a negative day is a number, not a text cell starting with `-`. Text cells are
 * inline strings, which a spreadsheet never evaluates as a formula, and a text cell that opens with a formula
 * character carries Excel's `quotePrefix` style, so it stays text when the writer edits it (render-xlsx.ts's own
 * rule). The row order is the CSV's canonical order; a spreadsheet never mirrors it.
 */

import { prepareSheet, type XlsxCell, type XlsxSheet } from './render-xlsx.js';
import { timelineRowCells, timelineTable, type TimelineTable, type TimelineTableInput } from './render-timeline-csv.js';

/** The sheet the timeline's table writes: one sheet, the CSV's columns, one row per scene. */
export function timelineSheet(input: TimelineTableInput, title: string): { readonly sheet: XlsxSheet; readonly table: TimelineTable; readonly notes: readonly string[] } {
  const table = timelineTable(input);
  const rows: XlsxCell[][] = table.rows.map((row) => timelineRowCells(row, table.labels) as XlsxCell[]);
  const prepared = prepareSheet({ name: 'Timeline', title: `${title} (timeline)`, columns: [...table.columns], rows });
  return { sheet: prepared.sheet, table, notes: [...table.notes, ...prepared.notes] };
}
