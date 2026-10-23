/**
 * A small reader for the worksheets the XLSX writer makes (render-xlsx.ts): the two cell kinds it writes, read back as the
 * cell's kind, style index and value. Shared by the writer's unit tests and the interop corpus (xlsx-write-corpus.test.ts).
 */

import { columnName } from '../src/render-xlsx.js';

/** One cell as the sheet stores it: its kind, its style index and its value. */
export interface ReadCell {
  readonly kind: 'string' | 'number';
  readonly style: number;
  readonly value: string | number;
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** Excel's own reading of an `_xHHHH_` escape. */
export function unescapeExcel(text: string): string {
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** The cells of a worksheet part, by reference (`A1`). A small reader for the two cell kinds the writer makes. */
export function readCells(xml: string): Map<string, ReadCell> {
  const cells = new Map<string, ReadCell>();
  for (const match of xml.matchAll(/<c r="([A-Z]+\d+)"((?: [a-z]+="[^"]*")*)>([\s\S]*?)<\/c>/g)) {
    const [, ref = '', attrs = '', inner = ''] = match;
    const style = Number(/ s="(\d+)"/.exec(attrs)?.[1] ?? '0');
    if (attrs.includes('t="inlineStr"')) {
      const text = /<t xml:space="preserve">([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? '';
      cells.set(ref, { kind: 'string', style, value: unescapeExcel(unescapeXml(text)) });
    } else {
      cells.set(ref, { kind: 'number', style, value: Number(/<v>(.*?)<\/v>/.exec(inner)?.[1]) });
    }
  }
  return cells;
}

/** The rows of a worksheet as plain values, `''` for a cell that is not written, `width` columns wide. */
export function readRows(xml: string, width: number): (string | number)[][] {
  const cells = readCells(xml);
  const last = Math.max(0, ...[...cells.keys()].map((ref) => Number(/\d+$/.exec(ref)?.[0] ?? 0)));
  const rows: (string | number)[][] = [];
  for (let r = 1; r <= last; r += 1) {
    rows.push(Array.from({ length: width }, (_, c) => cells.get(`${columnName(c)}${r}`)?.value ?? ''));
  }
  return rows;
}
