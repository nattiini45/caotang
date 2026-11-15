/**
 * The Excel workbook reader (#289, epic #263): synthetic workbooks written to SpreadsheetML's own shape — shared and
 * inline strings, numbers, booleans, errors, cached formulas, sparse cells, dates in both date systems, several sheets.
 * No real workbook is copied. The last test reads a workbook and its CSV twin and asks for the same rows.
 */

import { describe, expect, it } from 'vitest';

import { readCsv } from '@caotang/import-csv';
import { rawZip } from '../../import-read/test/zip-fixtures.js';

import { readXlsx } from '../src/reader.js';
import { columnIndex, serialDate } from '../src/sheet.js';
import { isDateFormat } from '../src/workbook.js';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** One cell as SpreadsheetML writes it. */
function cell(reference: string, value: string, type?: string, style?: number, formula?: string): string {
  const attributes = ` r="${reference}"${type === undefined ? '' : ` t="${type}"`}${style === undefined ? '' : ` s="${style}"`}`;
  const body = `${formula === undefined ? '' : `<f>${formula}</f>`}${type === 'inlineStr' ? `<is><t>${value}</t></is>` : `<v>${value}</v>`}`;
  return `<c${attributes}>${body}</c>`;
}

interface SheetSpec {
  name: string;
  rows: string[][];
}

/** A workbook: `rows` are already SpreadsheetML `row` elements. */
function xlsx(sheets: SheetSpec[], extra: { shared?: string[]; styles?: string; date1904?: boolean; targets?: string[] } = {}): Uint8Array {
  const shared = extra.shared ?? [];
  const files = [
    {
      name: 'xl/workbook.xml',
      data: enc(
        `<?xml version="1.0"?><workbook ${NS}><workbookPr${extra.date1904 === true ? ' date1904="1"' : ''}/><sheets>${sheets
          .map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
          .join('')}</sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: enc(
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
          .map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${extra.targets?.[index] ?? `worksheets/sheet${index + 1}.xml`}"/>`)
          .join('')}</Relationships>`,
      ),
    },
    {
      name: 'xl/sharedStrings.xml',
      data: enc(`<?xml version="1.0"?><sst ${NS} count="${shared.length}">${shared.map((text) => `<si><t>${text}</t></si>`).join('')}</sst>`),
    },
    {
      name: 'xl/styles.xml',
      data: enc(`<?xml version="1.0"?><styleSheet ${NS}>${extra.styles ?? '<cellXfs count="1"><xf numFmtId="0"/></cellXfs>'}</styleSheet>`),
    },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: enc(`<?xml version="1.0"?><worksheet ${NS}><sheetData>${sheet.rows.map((cells, row) => `<row r="${row + 1}">${cells.join('')}</row>`).join('')}</sheetData></worksheet>`),
    })),
  ];
  return rawZip(files);
}

const DATE_STYLES = '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd\\.mm\\.yyyy"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs>';

describe('readXlsx — the workbook reader', () => {
  it('reads shared strings, inline strings, numbers and booleans into the grid a CSV would give', async () => {
    const book = xlsx(
      [
        {
          name: 'Bible',
          rows: [
            [cell('A1', '0', 's'), cell('B1', '1', 's'), cell('C1', '2', 's')],
            [cell('A2', '3', 's'), cell('B2', 'A cartographer', 'inlineStr'), cell('C2', '42')],
            [cell('A3', '4', 's'), cell('B3', '', 'inlineStr'), cell('C3', '1', 'b')],
          ],
        },
      ],
      { shared: ['Name', 'Description', 'Age', 'Elena', 'Mara'] },
    );
    const read = await readXlsx(book);
    expect(read.ok, read.ok ? '' : JSON.stringify(read.error)).toBe(true);
    if (!read.ok) return;
    expect(read.value.sheets).toEqual(['Bible']);
    expect(read.value.sheet).toBe('Bible');
    expect(read.value.rows.grid.rows).toEqual([
      ['Name', 'Description', 'Age'],
      ['Elena', 'A cartographer', '42'],
      ['Mara', '', 'TRUE'],
    ]);
    expect(read.value.rows.grid.delimiter).toBe('none');
    expect(read.value.rows.headers).toEqual(['Name', 'Description', 'Age']);
    expect(read.value.rows.codex.map((row) => row.name)).toEqual(['Elena', 'Mara']);
  });

  it('fills the cells a sparse row leaves out, and keeps a blank row inside the sheet', async () => {
    const book = xlsx([
      {
        name: 'Sparse',
        rows: [[cell('A1', '0', 's'), cell('C1', '1', 's')], [cell('C2', '2', 's')], [], [cell('B4', '3', 's')]],
      },
    ], { shared: ['Name', 'Tags', 'harbour', 'Mara'] });
    const read = await readXlsx(book);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.rows.grid.rows).toEqual([
      ['Name', '', 'Tags'],
      ['', '', 'harbour'],
      ['', '', ''],
      ['', 'Mara', ''],
    ]);
  });

  it('reads a formula as its cached value, and keeps an error cell as its text', async () => {
    const book = xlsx([
      {
        name: 'Sums',
        rows: [
          [cell('A1', '0', 's'), cell('B1', '1', 's')],
          [cell('A2', '2', 's'), cell('B2', '7', undefined, undefined, 'SUM(3+4)')],
          [cell('A3', '3', 's'), cell('B3', '#REF!', 'e')],
          [cell('A4', '4', 's'), cell('B4', 'joined', 'str', undefined, 'CONCAT(A2,A3)')],
        ],
      },
    ], { shared: ['Name', 'Value', 'Elena', 'Mara', 'Kai'] });
    const read = await readXlsx(book);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.rows.grid.rows[1]).toEqual(['Elena', '7']);
    expect(read.value.rows.grid.rows[2]).toEqual(['Mara', '#REF!']);
    expect(read.value.rows.grid.rows[3]).toEqual(['Kai', 'joined']);
    expect(read.value.formulas).toBe(2);
    expect(read.value.errors).toBe(1);
  });

  it('reads a date cell in the 1900 system, with Lotus’s leap-year bug, and in the 1904 system', async () => {
    const rows = [[cell('A1', '0', 's'), cell('B1', '1', 's')], [cell('A2', '2', 's'), cell('B2', '46026', undefined, 1)], [cell('A3', '3', 's'), cell('B3', '60', undefined, 2)]];
    const book = xlsx([{ name: 'Timeline', rows }], { shared: ['Title', 'Start', 'The Landing', 'Old'], styles: DATE_STYLES });
    const read = await readXlsx(book, { mode: 'timeline' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.rows.grid.rows[1]).toEqual(['The Landing', '2026-01-04']);
    // Serial 60 is the 29th of February 1900, which never was; it reads as the 28th rather than shifting every later date.
    expect(read.value.rows.grid.rows[2]).toEqual(['Old', '1900-02-28']);
    // Day 0 is the first date in the file, which here is the older of the two rows.
    expect(read.value.rows.timeline[1]?.startDay).toBe(0);
    expect(read.value.rows.anchor).toBe('1900-02-28');

    const mac = xlsx([{ name: 'Timeline', rows }], { shared: ['Title', 'Start', 'The Landing', 'Old'], styles: DATE_STYLES, date1904: true });
    const readMac = await readXlsx(mac, { mode: 'timeline' });
    expect(readMac.ok).toBe(true);
    if (!readMac.ok) return;
    expect(readMac.value.rows.grid.rows[1]?.[1]).toBe('2030-01-05');
  });

  it('reports a date cell’s time of day, which the grid does not keep', async () => {
    const book = xlsx(
      [{ name: 'Timeline', rows: [[cell('A1', '0', 's'), cell('B1', '1', 's')], [cell('A2', '2', 's'), cell('B2', '46026.5', undefined, 1)]] }],
      { shared: ['Title', 'Start', 'Noon'], styles: DATE_STYLES },
    );
    const read = await readXlsx(book, { mode: 'timeline' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.times).toBe(1);
    expect(read.value.rows.grid.rows[1]).toEqual(['Noon', '2026-01-04']);
  });

  it('reads the sheet the writer chose, and refuses a name the workbook does not hold', async () => {
    const book = xlsx([
      { name: 'Bible', rows: [[cell('A1', '0', 's')], [cell('A2', '1', 's')]] },
      { name: 'Timeline', rows: [[cell('A1', '2', 's')], [cell('A2', '3', 's')]] },
    ], { shared: ['Name', 'Elena', 'Title', 'The Landing'] });
    const second = await readXlsx(book, { sheet: 'Timeline', mode: 'timeline' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.sheets).toEqual(['Bible', 'Timeline']);
    expect(second.value.rows.timeline.map((row) => row.title)).toEqual(['The Landing']);
    const missing = await readXlsx(book, { sheet: 'Nope' });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.kind).toBe('unknown-sheet');
  });

  it('follows a relationship target that names its own path from the package root', async () => {
    const book = xlsx([{ name: 'Bible', rows: [[cell('A1', '0', 's')], [cell('A2', '1', 's')]] }], { shared: ['Name', 'Elena'], targets: ['/xl/worksheets/sheet1.xml'] });
    const read = await readXlsx(book);
    expect(read.ok).toBe(true);
  });

  it('refuses a zip that is no workbook, and a workbook with no sheets', async () => {
    const notBook = rawZip([{ name: 'hello.txt', data: enc('not a workbook') }]);
    const refused = await readXlsx(notBook);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.kind).toBe('not-xlsx');
    const empty = await readXlsx(xlsx([]));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.kind).toBe('no-sheets');
  });

  it('refuses a sheet with more rows than the reader takes', async () => {
    const rows = Array.from({ length: 100_001 }, (_, index) => [`<c r="A${index + 1}" t="inlineStr"><is><t>x</t></is></c>`]);
    const read = await readXlsx(xlsx([{ name: 'Huge', rows }]));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.kind).toBe('too-many-rows');
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
    const sheetRows = rows.map((row, rowIndex) =>
      row.map((text, column) => {
        const reference = `${String.fromCharCode(65 + column)}${rowIndex + 1}`;
        if (rowIndex > 0 && column === 1) {
          const days = Math.round((Date.UTC(Number(text.slice(0, 4)), Number(text.slice(5, 7)) - 1, Number(text.slice(8, 10))) - Date.UTC(1899, 11, 31)) / 86_400_000) + 1;
          return cell(reference, String(days), undefined, 1);
        }
        if (rowIndex > 0 && column === 2) return cell(reference, text);
        return cell(reference, String(indexOf(text)), 's');
      }),
    );
    const book = xlsx([{ name: 'Timeline', rows: sheetRows }], { shared, styles: DATE_STYLES });
    const csv = rows.map((row) => row.map((text) => (text.includes(',') ? `"${text}"` : text)).join(',')).join('\n');
    const fromBook = await readXlsx(book, { mode: 'timeline' });
    const fromCsv = readCsv(enc(csv), { mode: 'timeline' });
    expect(fromBook.ok).toBe(true);
    expect(fromCsv.ok).toBe(true);
    if (!fromBook.ok || !fromCsv.ok) return;
    expect(fromBook.value.rows.grid.rows).toEqual(fromCsv.value.grid.rows);
    expect(fromBook.value.rows.timeline).toEqual(fromCsv.value.timeline);
    expect(fromBook.value.rows.anchor).toBe(fromCsv.value.anchor);
  });
});

describe('the workbook’s own pieces', () => {
  it('reads a column reference as an index', () => {
    expect([columnIndex('A1'), columnIndex('B3'), columnIndex('Z1'), columnIndex('AA1'), columnIndex('BC12'), columnIndex('12')]).toEqual([0, 1, 25, 26, 54, -1]);
  });

  it('knows a date format from a number format, and a quoted word from a format letter', () => {
    expect([isDateFormat('dd\\.mm\\.yyyy'), isDateFormat('yyyy-mm-dd'), isDateFormat('0.00'), isDateFormat('General'), isDateFormat('"day "0'), isDateFormat('[Red]0'), isDateFormat('[$-407]dd/mm/yyyy')]).toEqual([true, true, false, false, false, false, true]);
  });

  it('counts a serial in both date systems', () => {
    expect(serialDate(1, false).date).toBe('1900-01-01');
    expect(serialDate(61, false).date).toBe('1900-03-01');
    expect(serialDate(0, true).date).toBe('1904-01-01');
    expect(serialDate(46026.25, false)).toEqual({ date: '2026-01-04', time: true });
  });
});
