/** The project's own XLSX writer and reader agree (#289): an exported table can be read back without a library in either direction. */

import { describe, expect, it } from 'vitest';

import { renderXlsx } from '../packages/exporter/src/index.js';
import { readXlsx } from '../packages/import-xlsx/src/index.js';

describe('the project XLSX writer read back by the project XLSX reader', () => {
  it('keeps inline text, numbers, blanks and SpreadsheetML character escapes', async () => {
    const bytes = await renderXlsx({
      name: 'Timeline',
      columns: ['Title', 'Count', 'Note'],
      rows: [
        ['Landing', 2, 'literal _x000D_ stays literal'],
        ['Salt', null, 'Fish & <chips>'],
      ],
    });
    const read = await readXlsx(bytes);
    expect(read.ok, read.ok ? '' : JSON.stringify(read.error)).toBe(true);
    if (!read.ok) return;
    expect(read.value.sheets).toEqual(['Timeline']);
    expect(read.value.rows.map((row) => row.cells)).toEqual([
      ['Title', 'Count', 'Note'],
      ['Landing', '2', 'literal _x000D_ stays literal'],
      ['Salt', '', 'Fish & <chips>'],
    ]);
  });
});
