/**
 * The spreadsheet writer: one table as an XLSX workbook — the XLSX variant of the shot list (storyboard.md §6, §8 A4) and of
 * the dialogue table (dialogue-narrative.md §4, §6). One spreadsheet stack serves both, as the two specs ask.
 *
 * ## Shape
 *
 * ```
 * [Content_Types].xml          the part types
 * _rels/.rels                  → xl/workbook.xml
 * docProps/core.xml            the title
 * xl/workbook.xml              one sheet
 * xl/_rels/workbook.xml.rels   → the sheet and the styles
 * xl/styles.xml                normal, bold header, text kept as text, wrapped text
 * xl/worksheets/sheet1.xml     the header row, then one row per record
 * ```
 *
 * ## Why this is hand-written and not a library
 *
 * The workbook is one sheet of plain cells. That is a few small XML parts in a ZIP, and the ZIP engine is `fflate`, which the
 * EPUB renderer already loads (exporter.md §3a). A spreadsheet library would add a large dependency for the part that is
 * ~200 lines here. Text is written as inline strings, so there is no shared-string table to keep.
 *
 * ## Cells
 *
 * - A string cell is an inline string. A spreadsheet never evaluates one as a formula, so the text is written as typed and is
 *   not given the CSV's apostrophe. A text cell that opens with a formula character also carries Excel's `quotePrefix` style,
 *   so it stays text when the writer edits it.
 * - A number cell is a number, so a spreadsheet can sort and sum it. A number that is not finite is left empty.
 * - An empty string or `null` writes no cell.
 * - Text is stripped of the code points XML forbids. A Windows or old Mac line ending becomes a line feed, the line break a
 *   spreadsheet cell uses. A literal `_xHHHH_` is escaped the way Excel escapes it, so it reads back as written. A cell longer
 *   than Excel's limit of 32,767 characters is cut, and the compile says so ({@link prepareSheet}).
 *
 * ## Loaded lazily, from the browser build
 *
 * `fflate/browser` is imported with a dynamic `import()`, as the EPUB renderer does and for the same reason: the editor bundle
 * never pays for it, and the tested file is the shipped file.
 */

import type { ZipOptions } from 'fflate/browser';
import { stripXmlIllegal } from './xml-text.js';

/** The MIME type of an XLSX workbook. */
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The most characters an Excel cell holds. */
export const XLSX_CELL_MAX = 32767;

/** The most characters a sheet name holds. */
const SHEET_NAME_MAX = 31;

/** One cell: text, a number, or nothing. */
export type XlsxCell = string | number | null;

/** One sheet: its name, the header row's labels, and the rows under it. */
export interface XlsxSheet {
  readonly name: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly XlsxCell[])[];
  /** The workbook's title, in its document properties. */
  readonly title?: string;
}

/** The first characters a spreadsheet reads as the start of a formula (the CSV guard's list). */
const FORMULA_TRIGGERS: readonly string[] = ['=', '+', '-', '@', '\t', '\r'];

/** Every entry is stamped with this time, so the same table always makes the same bytes. ZIP time starts in 1980. */
const ZIP_TIME = new Date(1980, 0, 1, 0, 0, 0);

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** The style index of each cell kind, in `xl/styles.xml`'s `cellXfs` order. */
const STYLE = { normal: 0, header: 1, text: 2, wrap: 3, textWrap: 4 } as const;

/**
 * The sheets {@link prepareSheet} returned. Writing one of them writes it as it is; any other sheet is prepared first, so the
 * preparation runs once for a sheet the compile prepared, and a caller that never prepared still gets a sheet a spreadsheet
 * opens without a repair prompt.
 */
const PREPARED = new WeakSet<XlsxSheet>();

/**
 * The sheet as it will be written, and what the compile log says about it: a cell cut to Excel's limit is named by its
 * spreadsheet row (the header is row 1, so the first record is row 2) and its column. The cut is made here, before anything
 * is written, and {@link xlsxParts} writes the sheet this returns without preparing it again, so the log and the file agree.
 * A sheet this already returned comes back as it is, with no notes: its cuts were reported when it was prepared.
 */
export function prepareSheet(sheet: XlsxSheet): { readonly sheet: XlsxSheet; readonly notes: readonly string[] } {
  if (PREPARED.has(sheet)) return { sheet, notes: [] };
  const notes: string[] = [];
  const rows = sheet.rows.map((row, r) =>
    row.map((cell, c) => {
      if (typeof cell !== 'string') return cell;
      const clean = stripXmlIllegal(cell);
      if (clean.length <= XLSX_CELL_MAX) return clean;
      notes.push(
        `xlsx: row ${r + 2}, column ${sheet.columns[c] ?? String(c + 1)} is longer than the ${XLSX_CELL_MAX.toLocaleString('en-US')} characters a spreadsheet cell holds, so it was cut`,
      );
      return clean.slice(0, XLSX_CELL_MAX);
    }),
  );
  const prepared: XlsxSheet = { ...sheet, rows };
  PREPARED.add(prepared);
  return { sheet: prepared, notes };
}

/**
 * The workbook's parts, by path, in archive order. Pure: the ZIP is the only thing {@link renderXlsx} adds. A sheet that
 * {@link prepareSheet} returned is written as it is; any other is prepared here first (its notes are dropped, so a caller
 * that wants them prepares the sheet itself and passes the result).
 */
export function xlsxParts(input: XlsxSheet): ReadonlyArray<readonly [string, string]> {
  const sheet = prepareSheet(input).sheet;
  return [
    ['[Content_Types].xml', contentTypesXml()],
    ['_rels/.rels', rootRelsXml()],
    ['docProps/core.xml', corePropsXml(sheet.title ?? sheet.name)],
    ['xl/workbook.xml', workbookXml(sheetName(sheet.name))],
    ['xl/_rels/workbook.xml.rels', workbookRelsXml()],
    ['xl/styles.xml', stylesXml()],
    ['xl/worksheets/sheet1.xml', worksheetXml(sheet)],
  ];
}

/** Renders the sheet as an XLSX workbook and returns the ZIP's bytes. The sheet is prepared once, by {@link xlsxParts}. */
export async function renderXlsx(sheet: XlsxSheet): Promise<Uint8Array> {
  const { zipSync, strToU8 } = await import('fflate/browser');
  const files: Record<string, [Uint8Array, ZipOptions]> = {};
  for (const [path, xml] of xlsxParts(sheet)) {
    files[path] = [strToU8(xml), { level: 9, mtime: ZIP_TIME }];
  }
  return zipSync(files, { level: 9, mtime: ZIP_TIME });
}

/** The five markup characters as entities. */
function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * A cell's text as Excel stores it. A line ending becomes a line feed: XML reads a carriage return as one anyway, and a
 * spreadsheet breaks a cell's lines on it. A literal `_xHHHH_` would be read as an escaped character, so its underscore is
 * escaped (ECMA-376 `ST_Xstring`). Then the markup is escaped.
 */
export function xlsxText(text: string): string {
  const escaped = stripXmlIllegal(text)
    .replace(/\r\n?/g, '\n')
    .replace(/_(x[0-9A-Fa-f]{4}_)/g, '_x005F_$1');
  return escapeXmlText(escaped);
}

/** A sheet name Excel accepts: none of `[]:*?/\`, no leading or trailing apostrophe, at most 31 characters, never empty. */
export function sheetName(name: string): string {
  const cleaned = stripXmlIllegal(name)
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/^'+|'+$/g, '')
    .trim()
    .slice(0, SHEET_NAME_MAX)
    .trim();
  return cleaned === '' ? 'Sheet1' : cleaned;
}

/** The column letters of a zero-based index: 0 is A, 25 is Z, 26 is AA. */
export function columnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function textStyle(text: string): number {
  const guarded = FORMULA_TRIGGERS.includes(text.charAt(0));
  const wraps = text.includes('\n') || text.includes('\r');
  if (guarded && wraps) return STYLE.textWrap;
  if (guarded) return STYLE.text;
  if (wraps) return STYLE.wrap;
  return STYLE.normal;
}

function cellXml(ref: string, cell: XlsxCell, header: boolean): string {
  if (cell === null || cell === '') return '';
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) return '';
    return `<c r="${ref}"${header ? ` s="${STYLE.header}"` : ''}><v>${String(cell)}</v></c>`;
  }
  const style = header ? STYLE.header : textStyle(cell);
  const s = style === STYLE.normal ? '' : ` s="${style}"`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xlsxText(cell)}</t></is></c>`;
}

/** A column's width in characters: the longest first line in it, between 8 and 60. */
function columnWidths(sheet: XlsxSheet): number[] {
  return sheet.columns.map((label, c) => {
    let longest = [...label].length;
    for (const row of sheet.rows) {
      const cell = row[c];
      if (cell === null || cell === undefined) continue;
      const line = String(cell).split(/\r?\n|\r/)[0] ?? '';
      longest = Math.max(longest, [...line].length);
    }
    return Math.min(60, Math.max(8, longest + 2));
  });
}

function worksheetXml(sheet: XlsxSheet): string {
  const width = Math.max(1, sheet.columns.length);
  const lastRef = `${columnName(width - 1)}${sheet.rows.length + 1}`;
  const rows: string[] = [];
  const all: readonly (readonly XlsxCell[])[] = [sheet.columns, ...sheet.rows];
  all.forEach((row, r) => {
    const header = r === 0;
    const cells = row
      .slice(0, width)
      .map((cell, c) => cellXml(`${columnName(c)}${r + 1}`, cell, header))
      .join('');
    rows.push(`<row r="${r + 1}">${cells}</row>`);
  });
  const cols = columnWidths(sheet)
    .map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`)
    .join('');
  return (
    XML_HEAD +
    `<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    `<dimension ref="A1:${lastRef}"/>` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (cols === '' ? '' : `<cols>${cols}</cols>`) +
    `<sheetData>${rows.join('')}</sheetData>` +
    '</worksheet>'
  );
}

function contentTypesXml(): string {
  return (
    XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>'
  );
}

function rootRelsXml(): string {
  return (
    XML_HEAD +
    `<Relationships xmlns="${PKG_REL_NS}">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '</Relationships>'
  );
}

function corePropsXml(title: string): string {
  return (
    XML_HEAD +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:title>${escapeXmlText(stripXmlIllegal(title))}</dc:title>` +
    '</cp:coreProperties>'
  );
}

function workbookXml(name: string): string {
  return (
    XML_HEAD +
    `<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    '<bookViews><workbookView/></bookViews>' +
    `<sheets><sheet name="${escapeXmlText(name)}" sheetId="1" r:id="rId1"/></sheets>` +
    '</workbook>'
  );
}

function workbookRelsXml(): string {
  return (
    XML_HEAD +
    `<Relationships xmlns="${PKG_REL_NS}">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>'
  );
}

function stylesXml(): string {
  const xf = (attrs: string, inner = ''): string =>
    inner === '' ? `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"${attrs}/>` : `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"${attrs}>${inner}</xf>`;
  const wrap = '<alignment vertical="top" wrapText="1"/>';
  return (
    XML_HEAD +
    `<styleSheet xmlns="${MAIN_NS}">` +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="5">' +
    xf('') +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    xf(' quotePrefix="1"') +
    xf(' applyAlignment="1"', wrap) +
    xf(' quotePrefix="1" applyAlignment="1"', wrap) +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>'
  );
}
