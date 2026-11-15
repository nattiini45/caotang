/**
 * The workbook's own parts (#289, epic #263): which sheets it holds and where they sit, its shared strings, its number
 * formats and which date system it counts in. Read on the shared XML reader; nothing here runs, fetches or evaluates.
 */

import { attr, readXml, textOf, type XmlElement } from '@caotang/import-read/xml';
import type { ImportArchive } from '@caotang/import-read/zip';

/** One worksheet: the name the writer sees, and the part that holds its cells. */
export interface XlsxSheet {
  name: string;
  path: string;
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
  /** The shared strings, by index. */
  shared: string[];
  /** A cell style index (`c/@s`) to its number format code. */
  formats: Map<number, string>;
  /** True when the workbook counts from 1904-01-01 (older Mac Excel), false for 1900. */
  date1904: boolean;
}

export type WorkbookError = { kind: 'not-xlsx' } | { kind: 'not-xml'; message: string } | { kind: 'no-sheets' };

const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function kids(element: XmlElement, local: string): XmlElement[] {
  return element.children.filter((child): child is XmlElement => child.type === 'element' && child.local === local);
}
const kid = (element: XmlElement, local: string): XmlElement | undefined => kids(element, local)[0];

/** Read one part as XML, or say why not. A missing part is `undefined`, not a refusal. */
async function part(archive: ImportArchive, path: string): Promise<{ ok: true; root: XmlElement | undefined } | { ok: false; message: string }> {
  if (archive.entry(path) === undefined) return { ok: true, root: undefined };
  const bytes = await archive.read(path);
  if (!bytes.ok) return { ok: false, message: bytes.error.message };
  const xml = readXml(bytes.value);
  if (!xml.ok) return { ok: false, message: `${path}: ${xml.error.message}` };
  return { ok: true, root: xml.document.root };
}

/** A shared string: its own `t`, or every run's `t`, without the phonetic reading aids. */
function stringOf(item: XmlElement): string {
  const own = kid(item, 't');
  if (own !== undefined) return textOf(own);
  return kids(item, 'r')
    .map((run) => kid(run, 't'))
    .filter((text): text is XmlElement => text !== undefined)
    .map((text) => textOf(text))
    .join('');
}

/** The target of a relationship as a path inside the package: `worksheets/sheet1.xml` or `/xl/worksheets/sheet1.xml`. */
function targetPath(target: string): string {
  const clean = target.replaceAll('\\', '/');
  if (clean.startsWith('/')) return clean.slice(1);
  return `xl/${clean}`;
}

/**
 * Whether a number format code shows a date or a time. Quoted words and bracketed sections (`[Red]`, `[$-407]`, `[h]`)
 * are not format letters; what is left must hold a date or time letter and no `General`.
 */
export function isDateFormat(code: string): boolean {
  const bare = code.replaceAll(/"[^"]*"/g, '').replaceAll(/\[[^\]]*\]/g, '').replaceAll(/\\./g, '');
  if (/general/i.test(bare)) return false;
  return /[ymdhs]/i.test(bare);
}

/** The built-in number format ids that show a date or a time (ECMA-376 Part 1, §18.8.30). */
const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

export function isDateStyle(workbook: XlsxWorkbook, style: number): boolean {
  const code = workbook.formats.get(style);
  return code !== undefined && isDateFormat(code);
}

/** Read the workbook's parts. The worksheet cells themselves are read by `sheetGrid`. */
export async function readWorkbook(archive: ImportArchive): Promise<{ ok: true; value: XlsxWorkbook } | { ok: false; error: WorkbookError }> {
  const book = await part(archive, 'xl/workbook.xml');
  if (!book.ok) return { ok: false, error: { kind: 'not-xml', message: book.message } };
  if (book.root === undefined) return { ok: false, error: { kind: 'not-xlsx' } };

  const rels = await part(archive, 'xl/_rels/workbook.xml.rels');
  if (!rels.ok) return { ok: false, error: { kind: 'not-xml', message: rels.message } };
  const targets = new Map<string, string>();
  for (const rel of rels.root === undefined ? [] : kids(rels.root, 'Relationship')) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (id !== undefined && target !== undefined) targets.set(id, targetPath(target));
  }

  const properties = kid(book.root, 'workbookPr');
  const date1904 = properties !== undefined && /^(1|true)$/i.test(attr(properties, 'date1904') ?? '');

  const sheets: XlsxSheet[] = [];
  const list = kid(book.root, 'sheets');
  for (const [index, sheet] of (list === undefined ? [] : kids(list, 'sheet')).entries()) {
    const name = attr(sheet, 'name') ?? `Sheet${index + 1}`;
    const id = attr(sheet, 'id', RELATIONSHIPS);
    const path = (id === undefined ? undefined : targets.get(id)) ?? `xl/worksheets/sheet${index + 1}.xml`;
    if (archive.entry(path) !== undefined) sheets.push({ name, path });
  }
  if (sheets.length === 0) return { ok: false, error: { kind: 'no-sheets' } };

  const strings = await part(archive, 'xl/sharedStrings.xml');
  if (!strings.ok) return { ok: false, error: { kind: 'not-xml', message: strings.message } };
  const shared = strings.root === undefined ? [] : kids(strings.root, 'si').map(stringOf);

  const styles = await part(archive, 'xl/styles.xml');
  if (!styles.ok) return { ok: false, error: { kind: 'not-xml', message: styles.message } };
  const formats = new Map<number, string>();
  if (styles.root !== undefined) {
    const custom = new Map<number, string>();
    const numFmts = kid(styles.root, 'numFmts');
    for (const format of numFmts === undefined ? [] : kids(numFmts, 'numFmt')) {
      const id = Number(attr(format, 'numFmtId'));
      const code = attr(format, 'formatCode');
      if (Number.isInteger(id) && code !== undefined) custom.set(id, code);
    }
    const cellXfs = kid(styles.root, 'cellXfs');
    for (const [index, xf] of (cellXfs === undefined ? [] : kids(cellXfs, 'xf')).entries()) {
      const id = Number(attr(xf, 'numFmtId') ?? '0');
      // Every style gets a code, so a style index is never mistaken for a format id.
      formats.set(index, custom.get(id) ?? (BUILTIN_DATE_IDS.has(id) ? builtinCode(id) : 'General'));
    }
  }

  return { ok: true, value: { sheets, shared, formats, date1904 } };
}

/** A built-in date id as a code, so `isDateFormat` sees the same thing for built-in and custom formats. */
function builtinCode(id: number): string {
  return id === 45 || id === 46 || id === 47 ? 'mm:ss' : 'yyyy-mm-dd';
}
