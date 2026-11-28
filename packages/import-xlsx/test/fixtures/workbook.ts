/** Small synthetic SpreadsheetML workbooks for the workbook reader and preview tests. No real workbook is copied. */

import { rawZip } from '../../../import-read/test/zip-fixtures.js';

export const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

export function cell(reference: string, value: string, type?: string, style?: number, formula?: string): string {
  const attributes = ` r="${reference}"${type === undefined ? '' : ` t="${type}"`}${style === undefined ? '' : ` s="${style}"`}`;
  const body = `${formula === undefined ? '' : `<f>${formula}</f>`}${type === 'inlineStr' ? `<is><t>${value}</t></is>` : `<v>${value}</v>`}`;
  return `<c${attributes}>${body}</c>`;
}

export interface SheetSpec {
  readonly name: string;
  readonly rows: readonly (readonly string[])[];
}

export function xlsx(sheets: readonly SheetSpec[], extra: { shared?: string[]; styles?: string; date1904?: boolean; targets?: string[]; types?: string[] } = {}): Uint8Array {
  const shared = extra.shared ?? [];
  return rawZip([
    {
      name: 'xl/workbook.xml',
      data: enc(`<?xml version="1.0"?><workbook ${NS}><workbookPr${extra.date1904 === true ? ' date1904="1"' : ''}/><sheets>${sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: enc(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${extra.types?.[index] ?? 'worksheet'}" Target="${extra.targets?.[index] ?? `worksheets/sheet${index + 1}.xml`}"/>`).join('')}</Relationships>`),
    },
    { name: 'xl/sharedStrings.xml', data: enc(`<?xml version="1.0"?><sst ${NS}>${shared.map((text) => `<si><t>${text}</t></si>`).join('')}</sst>`) },
    { name: 'xl/styles.xml', data: enc(`<?xml version="1.0"?><styleSheet ${NS}>${extra.styles ?? '<cellXfs count="1"><xf numFmtId="0"/></cellXfs>'}</styleSheet>`) },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: enc(`<?xml version="1.0"?><worksheet ${NS}><sheetData>${sheet.rows.map((cells, row) => `<row r="${row + 1}">${cells.join('')}</row>`).join('')}</sheetData></worksheet>`),
    })),
  ]);
}

export const DATE_STYLES = '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd\\.mm\\.yyyy"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs>';
