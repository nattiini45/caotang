/**
 * The Excel workbook reader (#289): synthetic workbooks written to SpreadsheetML's shape — shared and inline strings,
 * numbers, booleans, errors, cached formulas, sparse cells, dates in both systems and several sheets, plus two small openpyxl-produced workbooks.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseTableText } from '@caotang/import-table';
import { rawZip } from '../../import-read/test/zip-fixtures.js';
import { cell, DATE_STYLES, enc, xlsx } from './fixtures/workbook.js';

import { readXlsx } from '../src/index.js';
import { columnIndex, serialDate } from '../src/sheet.js';
import { isDateFormat } from '../src/workbook.js';

describe('readXlsx', () => {
  it('reads shared strings, inline strings, numbers and booleans as table rows', async () => {
    const book = xlsx([{ name: 'Bible', rows: [
      [cell('A1', '0', 's'), cell('B1', '1', 's'), cell('C1', '2', 's')],
      [cell('A2', '3', 's'), cell('B2', 'A cartographer', 'inlineStr'), cell('C2', '42')],
      [cell('A3', '4', 's'), cell('B3', '', 'inlineStr'), cell('C3', '1', 'b')],
    ] }], { shared: ['Name', 'Description', 'Age', 'Elena', 'Mara'] });
    const read = await readXlsx(book);
    expect(read.ok, read.ok ? '' : JSON.stringify(read.error)).toBe(true);
    if (!read.ok) return;
    expect(read.value.sheets).toEqual(['Bible']);
    expect(read.value.rows.map((row) => row.cells)).toEqual([
      ['Name', 'Description', 'Age'],
      ['Elena', 'A cartographer', '42'],
      ['Mara', '', 'TRUE'],
    ]);
  });

  it('reads a typed cell with no cached value as empty, never as the first shared string', async () => {
    const book = xlsx([{ name: 'Blank', rows: [[cell('A1', '0', 's'), '<c r="B1" t="s"/>', '<c r="C1" t="b"/>', '<c r="D1" t="e"/>']] }], { shared: ['Name'] });
    const read = await readXlsx(book);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.rows[0]?.cells[0]).toBe('Name');
    expect(read.value.rows[0]?.cells).toEqual(['Name']);
    expect(read.value.errors).toBe(0);
  });

  it('reads rich inline text without its phonetic aids and keeps escaped markup characters as text', async () => {
    const book = xlsx([{ name: 'Text', rows: [[
      '<c r="A1" t="inlineStr"><is><r><t>Fish &amp; </t></r><r><t>&lt;chips&gt;</t></r><rPh><t>für</t></rPh></is></c>',
    ]] }]);
    const read = await readXlsx(book);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.rows[0]?.cells).toEqual(['Fish & <chips>']);
  });

  it('reads SpreadsheetML character escapes as the text Excel shows', async () => {
    const book = xlsx([{ name: 'Text', rows: [[
      '<c r="A1" t="inlineStr"><is><t>literal _x005F_x000D_</t></is></c>',
      '<c r="B1" t="inlineStr"><is><t>line_x000A_break</t></is></c>',
    ]] }]);
    const read = await readXlsx(book);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.rows[0]?.cells).toEqual(['literal _x000D_', 'line\nbreak']);
  });

  it('keeps empty cells inside a sparse row and drops wholly blank rows as the CSV parser would', async () => {
    const book = xlsx([{ name: 'Sparse', rows: [[cell('A1', '0', 's'), cell('C1', '1', 's')], [cell('C2', '2', 's')], [], [cell('B4', '3', 's')]] }], { shared: ['Name', 'Tags', 'harbour', 'Mara'] });
    const read = await readXlsx(book);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.rows).toEqual([
      { line: 1, cells: ['Name', '', 'Tags'] },
      { line: 2, cells: ['', '', 'harbour'] },
      { line: 4, cells: ['', 'Mara', ''] },
    ]);
  });

  it('reads a formula as its cached value and keeps an error cell as text', async () => {
    const book = xlsx([{ name: 'Sums', rows: [
      [cell('A1', '0', 's'), cell('B1', '1', 's')],
      [cell('A2', '2', 's'), cell('B2', '7', undefined, undefined, 'SUM(3+4)')],
      [cell('A3', '3', 's'), cell('B3', '#REF!', 'e')],
      [cell('A4', '4', 's'), cell('B4', 'joined', 'str', undefined, 'CONCAT(A2,A3)')],
    ] }], { shared: ['Name', 'Value', 'Elena', 'Mara', 'Kai'] });
    const read = await readXlsx(book);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.rows.slice(1).map((row) => row.cells)).toEqual([['Elena', '7'], ['Mara', '#REF!'], ['Kai', 'joined']]);
    expect(read.value.formulas).toBe(2);
    expect(read.value.errors).toBe(1);
  });

  it('reads dates in the 1900 and 1904 systems and counts dropped times', async () => {
    const rows = [[cell('A1', '0', 's'), cell('B1', '1', 's')], [cell('A2', '2', 's'), cell('B2', '46026.5', undefined, 1)], [cell('A3', '3', 's'), cell('B3', '60', undefined, 2)]];
    const book = xlsx([{ name: 'Timeline', rows }], { shared: ['Title', 'Start', 'The Landing', 'Old'], styles: DATE_STYLES });
    const read = await readXlsx(book);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.rows.map((row) => row.cells)).toEqual([['Title', 'Start'], ['The Landing', '2026-01-04'], ['Old', '1900-02-28']]);
    expect(read.value.times).toBe(1);
    const mac = xlsx([{ name: 'Timeline', rows }], { shared: ['Title', 'Start', 'The Landing', 'Old'], styles: DATE_STYLES, date1904: true });
    const readMac = await readXlsx(mac);
    expect(readMac.ok).toBe(true);
    if (readMac.ok) expect(readMac.value.rows[1]?.cells[1]).toBe('2030-01-05');
  });

  it.each(['openpyxl-1900.xlsx', 'openpyxl-1904.xlsx'])('reads the openpyxl-produced %s date workbook as its CSV twin', async (file) => {
    const bytes = new Uint8Array(Buffer.from(readFileSync(resolve(__dirname, 'fixtures', `${file}.base64`), 'utf8'), 'base64'));
    const read = await readXlsx(bytes);
    expect(read.ok, read.ok ? '' : JSON.stringify(read.error)).toBe(true);
    if (!read.ok) return;
    expect(read.value.sheets).toEqual(['Timeline']);
    expect(read.value.rows.map((row) => row.cells)).toEqual([
      ['Title', 'Start', 'Summary'],
      ['Landing', '2026-01-04', 'A cartographer'],
      ['Salt', '2026-01-09', 'Fish & <chips>'],
    ]);
  });

  it('uses the first populated sheet when the first sheet is empty', async () => {
    const book = xlsx([
      { name: 'Empty', rows: [] },
      { name: 'Bible', rows: [[cell('A1', '0', 's')], [cell('A2', '1', 's')]] },
    ], { shared: ['Name', 'Ada'] });
    const read = await readXlsx(book);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.sheet).toBe('Bible');
      expect(read.value.sheets).toEqual(['Empty', 'Bible']);
      expect(read.value.rows[1]?.cells).toEqual(['Ada']);
    }
  });

  it('omits a time-only value instead of inventing its calendar date', async () => {
    const styles = '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="20"/></cellXfs>';
    const book = xlsx([{ name: 'Times', rows: [[cell('A1', '0.5', undefined, 1), cell('B1', 'plain')]] }], { styles });
    const read = await readXlsx(book);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.rows[0]?.cells).toEqual(['', 'plain']);
      expect(read.value.times).toBe(1);
    }
  });

  it('keeps an out-of-range date serial as its number instead of throwing', async () => {
    const book = xlsx([{ name: 'Dates', rows: [[cell('A1', '1e300', undefined, 1), cell('B1', '-1', undefined, 1), cell('C1', '2958465', undefined, 1)]] }], { styles: DATE_STYLES });
    const read = await readXlsx(book);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.rows[0]?.cells).toEqual(['1e+300', '-1', '9999-12-31']);
  });

  it('does not offer a chart sheet as a worksheet', async () => {
    const book = xlsx([
      { name: 'Chart', rows: [] },
      { name: 'Bible', rows: [[cell('A1', '0', 's')]] },
    ], { shared: ['Name'], types: ['chartsheet', 'worksheet'] });
    const read = await readXlsx(book);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.sheets).toEqual(['Bible']);
  });

  it('reads the chosen sheet and refuses one the workbook does not hold', async () => {
    const book = xlsx([
      { name: 'Bible', rows: [[cell('A1', '0', 's')], [cell('A2', '1', 's')]] },
      { name: 'Timeline', rows: [[cell('A1', '2', 's')], [cell('A2', '3', 's')]] },
    ], { shared: ['Name', 'Elena', 'Title', 'The Landing'] });
    const second = await readXlsx(book, { sheet: 'Timeline' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.sheets).toEqual(['Bible', 'Timeline']);
    expect(second.value.rows.map((row) => row.cells)).toEqual([['Title'], ['The Landing']]);
    const missing = await readXlsx(book, { sheet: 'Nope' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.kind).toBe('unknown-sheet');
  });

  it('follows a root-relative relationship target', async () => {
    const book = xlsx([{ name: 'Bible', rows: [[cell('A1', '0', 's')], [cell('A2', '1', 's')]] }], { shared: ['Name', 'Elena'], targets: ['/xl/worksheets/sheet1.xml'] });
    expect((await readXlsx(book)).ok).toBe(true);
  });

  it('refuses a zip that is no workbook and a workbook with no sheets', async () => {
    const refused = await readXlsx(rawZip([{ name: 'hello.txt', data: enc('not a workbook') }]));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.kind).toBe('not-xlsx');
    const empty = await readXlsx(xlsx([]));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.kind).toBe('no-sheets');
  });

  it('refuses a workbook whose sheets are wholly blank', async () => {
    const read = await readXlsx(xlsx([{ name: 'Blank', rows: [[]] }]));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.kind).toBe('empty');
  });

  it('refuses a cell reference beyond Excel’s last column instead of allocating it', async () => {
    const beyond = await readXlsx(xlsx([{ name: 'Crafted', rows: [['<c r="AAAA1" t="inlineStr"><is><t>x</t></is></c>']] }]));
    expect(beyond.ok).toBe(false);
    if (!beyond.ok) expect(beyond.error.kind).toBe('too-many-columns');
  });

  it('counts a cell whose text is cut at the worksheet limit', async () => {
    const long = 'x'.repeat(32_769);
    const read = await readXlsx(xlsx([{ name: 'Long', rows: [[cell('A1', long, 'inlineStr')]] }]));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.rows[0]?.cells[0]).toHaveLength(32_767);
    expect(read.value.truncatedCells).toBe(1);
  });

  it('cuts a long cell at characters rather than splitting a surrogate pair', async () => {
    const long = '𐌰'.repeat(32_769);
    const read = await readXlsx(xlsx([{ name: 'Long', rows: [[cell('A1', long, 'inlineStr')]] }]));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const kept = read.value.rows[0]?.cells[0] ?? '';
    expect([...kept]).toHaveLength(32_767);
    expect([...kept].at(-1)).toBe('𐌰');
  });

  it('reads a workbook and its CSV twin to the same rows, dates included', async () => {
    const rows = [
      ['Title', 'Start', 'Duration', 'POV', 'Summary'],
      ['The Landing', '2026-01-04', '2', 'Elena', 'The ferry came at noon.'],
      ['Salt', '2026-01-09', '1', 'Mara', 'The letter arrived.'],
    ];
    const shared: string[] = [];
    const indexOf = (text: string): number => {
      const held = shared.indexOf(text);
      if (held >= 0) return held;
      shared.push(text);
      return shared.length - 1;
    };
    const sheetRows = rows.map((row, rowIndex) => row.map((text, column) => {
      const reference = `${String.fromCharCode(65 + column)}${rowIndex + 1}`;
      if (rowIndex > 0 && column === 1) {
        const days = Math.round((Date.UTC(Number(text.slice(0, 4)), Number(text.slice(5, 7)) - 1, Number(text.slice(8, 10))) - Date.UTC(1899, 11, 31)) / 86_400_000) + 1;
        return cell(reference, String(days), undefined, 1);
      }
      if (rowIndex > 0 && column === 2) return cell(reference, text);
      return cell(reference, String(indexOf(text)), 's');
    }));
    const fromBook = await readXlsx(xlsx([{ name: 'Timeline', rows: sheetRows }], { shared, styles: DATE_STYLES }));
    const fromCsv = parseTableText(rows.map((row) => row.join(',')).join('\n'));
    expect(fromBook.ok).toBe(true);
    expect(fromCsv.ok).toBe(true);
    if (!fromBook.ok || !fromCsv.ok) return;
    expect(fromBook.value.rows.map((row) => row.cells)).toEqual(fromCsv.value.rows.map((row) => row.cells));
  });
});

describe('the workbook pieces', () => {
  it('reads a column reference as an index', () => {
    expect([columnIndex('A1'), columnIndex('B3'), columnIndex('Z1'), columnIndex('AA1'), columnIndex('BC12'), columnIndex('12')]).toEqual([0, 1, 25, 26, 54, -1]);
  });

  it('knows a date format from a number format', () => {
    expect([isDateFormat('dd\\.mm\\.yyyy'), isDateFormat('yyyy-mm-dd'), isDateFormat('0.00'), isDateFormat('General'), isDateFormat('"day "0'), isDateFormat('[Red]0'), isDateFormat('[$-407]dd/mm/yyyy')]).toEqual([true, true, false, false, false, false, true]);
  });

  it('counts a serial in both date systems', () => {
    expect(serialDate(1, false).date).toBe('1900-01-01');
    expect(serialDate(61, false).date).toBe('1900-03-01');
    expect(serialDate(0, true).date).toBe('1904-01-01');
    expect(serialDate(46026.25, false)).toEqual({ date: '2026-01-04', time: true });
  });
});
