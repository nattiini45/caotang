/**
 * The XLSX write corpus: the workbooks of xlsx-corpus.ts, written to disk for tools/office-interop/check_xlsx.py (openpyxl and
 * LibreOffice). It writes only when CAOTANG_XLSX_OUT names a directory, so `pnpm verify` is unchanged; CI's office-interop job
 * sets it, then runs `python3 tools/office-interop/check_xlsx.py`.
 *
 * Next to the files it writes expected.json: per file, its sheet name, title and header, and for every cell the value and type
 * a spreadsheet must read back (xlsx-corpus.ts). The checker trusts that file, and this test checks it against the file it
 * describes with the unit tests' own reader, so it cannot drift from what was written.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate/browser';
import { columnName } from '../src/render-xlsx.js';
import { XLSX_CORPUS, type ExpectedCell } from './xlsx-corpus.js';
import { readCells } from './xlsx-read.js';

const OUT = process.env['CAOTANG_XLSX_OUT'] ?? '';

/** The style index the writer gives a cell, from the flags expected.json carries (render-xlsx.ts STYLE). */
function styleOf(cell: NonNullable<ExpectedCell>, header: boolean): number {
  if (header) return 1;
  if (cell.t === 'n') return 0;
  if (cell.quotePrefix === true) return cell.wrap === true ? 4 : 2;
  return cell.wrap === true ? 3 : 0;
}

describe.skipIf(OUT === '')('the XLSX write corpus', () => {
  it.each(XLSX_CORPUS.map((entry) => [entry.expected.file, entry] as const))('writes %s through the exporter', async (_name, entry) => {
    const bytes = await entry.build();
    const { expected } = entry;
    const parts = unzipSync(bytes);
    const sheet = strFromU8(parts['xl/worksheets/sheet1.xml'] ?? new Uint8Array());
    const cells = readCells(sheet);

    // The description is checked against the file: the checker must not be handed a cell the writer did not write.
    expect(strFromU8(parts['xl/workbook.xml'] ?? new Uint8Array())).toContain(`<sheet name="${expected.sheet}" `);
    expect(strFromU8(parts['docProps/core.xml'] ?? new Uint8Array())).toContain(`<dc:title>${expected.title.replace('&', '&amp;')}</dc:title>`);
    const read = (ref: string) => cells.get(ref);
    expected.columns.forEach((label, c) => {
      expect(read(`${columnName(c)}1`)).toEqual({ kind: 'string', style: 1, value: label });
    });
    expected.rows.forEach((row, r) => {
      expect(row).toHaveLength(expected.columns.length);
      row.forEach((cell, c) => {
        const ref = `${columnName(c)}${r + 2}`;
        if (cell === null) return expect(read(ref), ref).toBeUndefined();
        expect(read(ref), ref).toEqual({ kind: cell.t === 'n' ? 'number' : 'string', style: styleOf(cell, false), value: cell.v });
      });
    });
    expect(Math.max(...[...cells.keys()].map((ref) => Number(/\d+$/.exec(ref)?.[0])))).toBe(expected.rows.length + 1);

    mkdirSync(OUT, { recursive: true });
    writeFileSync(resolve(OUT, expected.file), bytes);
  });

  it('writes expected.json for the files above', () => {
    writeFileSync(resolve(OUT, 'expected.json'), `${JSON.stringify({ files: XLSX_CORPUS.map((entry) => entry.expected) }, null, 2)}\n`);
  });
});
