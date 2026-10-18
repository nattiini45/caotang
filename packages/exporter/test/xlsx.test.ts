/**
 * The spreadsheet exports: the XLSX variant of the shot list (storyboard.md §6, §8 A4) and of the dialogue table
 * (dialogue-narrative.md §4, §6). The writer is checked part by part (every part parses, the cells say what was given), and
 * the two formats are checked through the §4 API and the bus, against the CSV they share their rows with.
 */

import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate/browser';
import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  type BusContext,
  type Command,
  type UndoStore,
} from '@caotang/bus';
import { createProjectCommandRegistry, MemoryArtifactFs, nodeById, type ProjectState } from '@caotang/store';
import {
  EXPORT_MIME,
  XLSX_CELL_MAX,
  XLSX_MIME,
  createExporter,
  isBinaryFormat,
  prepareSheet,
  renderMedia,
  renderXlsx,
  sheetName,
  xlsxParts,
  xlsxText,
  type ByteArtifacts,
  type ExportFormat,
  type ExporterService,
  type XlsxSheet,
} from '../src/index.js';
import { columnName } from '../src/render-xlsx.js';
import { stripXmlIllegal } from '../src/xml-text.js';
import { COMPILED_AT, PROJECT_NAME } from './fixture.js';
import { ASSET_FILE, ASSETS, MEDIA_IDS, UNKEYED_INK, makeMediaProject } from './media-fixture.js';
import { assertWellFormedXml, unzipText } from './xml.js';

/** One cell as the sheet stores it: its kind, its style index and its value. */
interface ReadCell {
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
function unescapeExcel(text: string): string {
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** The cells of a worksheet part, by reference (`A1`). A small reader for the two cell kinds the writer makes. */
function readCells(xml: string): Map<string, ReadCell> {
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
function readRows(xml: string, width: number): (string | number)[][] {
  const cells = readCells(xml);
  const last = Math.max(0, ...[...cells.keys()].map((ref) => Number(/\d+$/.exec(ref)?.[0] ?? 0)));
  const rows: (string | number)[][] = [];
  for (let r = 1; r <= last; r += 1) {
    rows.push(Array.from({ length: width }, (_, c) => cells.get(`${columnName(c)}${r}`)?.value ?? ''));
  }
  return rows;
}

function partsOf(sheet: XlsxSheet): Record<string, string> {
  return Object.fromEntries(xlsxParts(sheet));
}

const SAMPLE: XlsxSheet = {
  name: 'Shot list',
  title: 'The Lighthouse Keeper (shot list)',
  columns: ['n', 'text', 'seconds'],
  rows: [
    [1, 'Fish & chips <hot>', 2.5],
    [2, '=SUM(A1:A2)', null],
    [3, '', 0],
  ],
};

describe('the workbook parts', () => {
  it('are the seven parts of a one-sheet workbook, and each one is well-formed XML', () => {
    const parts = partsOf(SAMPLE);
    expect(Object.keys(parts)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/core.xml',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    for (const [name, xml] of Object.entries(parts)) assertWellFormedXml(name, xml);
  });

  it('declares a type for every part the relationships point at', () => {
    const parts = partsOf(SAMPLE);
    const types = parts['[Content_Types].xml'] ?? '';
    for (const part of ['/xl/workbook.xml', '/xl/worksheets/sheet1.xml', '/xl/styles.xml', '/docProps/core.xml']) {
      expect(types).toContain(`PartName="${part}"`);
    }
    expect(parts['_rels/.rels']).toContain('Target="xl/workbook.xml"');
    expect(parts['xl/_rels/workbook.xml.rels']).toContain('Target="worksheets/sheet1.xml"');
    expect(parts['xl/workbook.xml']).toContain('<sheet name="Shot list" sheetId="1" r:id="rId1"/>');
    expect(parts['docProps/core.xml']).toContain('<dc:title>The Lighthouse Keeper (shot list)</dc:title>');
  });

  it('writes the header row bold and frozen, and the dimension of the table', () => {
    const sheet = partsOf(SAMPLE)['xl/worksheets/sheet1.xml'] ?? '';
    expect(sheet).toContain('<dimension ref="A1:C4"/>');
    expect(sheet).toContain('state="frozen"');
    const cells = readCells(sheet);
    expect(cells.get('A1')).toEqual({ kind: 'string', style: 1, value: 'n' });
    expect(cells.get('C1')).toEqual({ kind: 'string', style: 1, value: 'seconds' });
  });
});

describe('the cells', () => {
  const cells = readCells(partsOf(SAMPLE)['xl/worksheets/sheet1.xml'] ?? '');

  it('keeps a number a number and text text', () => {
    expect(cells.get('A2')).toEqual({ kind: 'number', style: 0, value: 1 });
    expect(cells.get('C2')).toEqual({ kind: 'number', style: 0, value: 2.5 });
    expect(cells.get('C4')).toEqual({ kind: 'number', style: 0, value: 0 });
    expect(cells.get('B2')).toEqual({ kind: 'string', style: 0, value: 'Fish & chips <hot>' });
  });

  it('escapes the markup characters, so the part parses', () => {
    expect(partsOf(SAMPLE)['xl/worksheets/sheet1.xml']).toContain('Fish &amp; chips &lt;hot&gt;');
  });

  it('writes no cell for an empty string or a null', () => {
    expect(cells.has('C3')).toBe(false);
    expect(cells.has('B4')).toBe(false);
  });

  it('writes a formula-looking cell as text, never as a formula, and marks it to stay text', () => {
    expect(cells.get('B3')).toEqual({ kind: 'string', style: 2, value: '=SUM(A1:A2)' });
    expect(partsOf(SAMPLE)['xl/worksheets/sheet1.xml']).not.toContain('<f>');
    expect(partsOf(SAMPLE)['xl/styles.xml']).toContain('quotePrefix="1"');
  });

  it('leaves a number that is not finite empty', () => {
    const sheet = partsOf({ name: 'x', columns: ['a', 'b'], rows: [[Number.NaN, Number.POSITIVE_INFINITY]] })['xl/worksheets/sheet1.xml'];
    expect(readCells(sheet ?? '').has('A2')).toBe(false);
    expect(readCells(sheet ?? '').has('B2')).toBe(false);
  });

  it('keeps unicode as written: Chinese, accents and an emoji', () => {
    const text = '草堂 — Abeßer says “ni hao” 👋';
    const sheet = partsOf({ name: '对白', columns: ['text'], rows: [[text]] });
    expect(readCells(sheet['xl/worksheets/sheet1.xml'] ?? '').get('A2')?.value).toBe(text);
    expect(sheet['xl/workbook.xml']).toContain('name="对白"');
  });

  it('keeps line breaks, wraps the cell, and writes a Windows or old Mac line ending as a line feed', () => {
    const sheet = partsOf({ name: 'x', columns: ['text'], rows: [['one\ntwo'], ['a\r\nb\rc']] })['xl/worksheets/sheet1.xml'] ?? '';
    const read = readCells(sheet);
    expect(read.get('A2')).toEqual({ kind: 'string', style: 3, value: 'one\ntwo' });
    expect(read.get('A3')).toEqual({ kind: 'string', style: 3, value: 'a\nb\nc' });
    expect(sheet).not.toContain('\r');
  });

  it('escapes a literal _xHHHH_, so Excel reads it back as written', () => {
    expect(xlsxText('code _x0041_ here')).toBe('code _x005F_x0041_ here');
    expect(unescapeExcel(xlsxText('code _x0041_ here'))).toBe('code _x0041_ here');
  });

  it('drops the control characters XML forbids', () => {
    const parts = partsOf({ name: 'x', columns: ['text'], rows: [['bell\u0007 and nul\u0000']] });
    assertWellFormedXml('sheet1.xml', parts['xl/worksheets/sheet1.xml'] ?? '');
    expect(readCells(parts['xl/worksheets/sheet1.xml'] ?? '').get('A2')?.value).toBe('bell and nul');
  });

  it('cuts a cell longer than a spreadsheet holds, and names the spreadsheet row it is on', () => {
    const long = 'a'.repeat(XLSX_CELL_MAX + 5);
    const prepared = prepareSheet({ name: 'x', columns: ['n', 'text'], rows: [[1, long], [2, 'short'], [3, long]] });
    expect((prepared.sheet.rows[0]?.[1] as string).length).toBe(XLSX_CELL_MAX);
    // The header is row 1, so the first record is row 2: the note names the row the writer sees in the spreadsheet.
    expect(prepared.notes).toEqual([
      'xlsx: row 2, column text is longer than the 32,767 characters a spreadsheet cell holds, so it was cut',
      'xlsx: row 4, column text is longer than the 32,767 characters a spreadsheet cell holds, so it was cut',
    ]);
    const cells = readCells(partsOf(prepared.sheet)['xl/worksheets/sheet1.xml'] ?? '');
    expect((cells.get('B2')?.value as string).length).toBe(XLSX_CELL_MAX);
    expect(cells.get('B3')?.value).toBe('short');
    expect((cells.get('B4')?.value as string).length).toBe(XLSX_CELL_MAX);
  });

  it('cleans and cuts a header label too, so a sheet with an oversized label still opens without a repair prompt', () => {
    const prepared = prepareSheet({ name: 'x', columns: ['n', `bell\u0007${'h'.repeat(XLSX_CELL_MAX)}`], rows: [[1, 'a']] });
    expect(prepared.sheet.columns[1]?.length).toBe(XLSX_CELL_MAX);
    expect(prepared.sheet.columns[1]?.startsWith('bellh')).toBe(true);
    expect(prepared.notes).toEqual([
      'xlsx: the header of column B is longer than the 32,767 characters a spreadsheet cell holds, so it was cut',
    ]);
    const cells = readCells(partsOf(prepared.sheet)['xl/worksheets/sheet1.xml'] ?? '');
    expect((cells.get('B1')?.value as string).length).toBe(XLSX_CELL_MAX);
  });
});

describe('preparation runs once', () => {
  const OVERSIZED: XlsxSheet = { name: 'x', columns: ['text'], rows: [['b'.repeat(XLSX_CELL_MAX + 1)], ['bell\u0007']] };

  it('a prepared sheet is written as it is, and preparing it again changes nothing and reports nothing', () => {
    const once = prepareSheet(OVERSIZED);
    expect(once.notes).toHaveLength(1);
    const twice = prepareSheet(once.sheet);
    expect(twice.sheet).toBe(once.sheet);
    expect(twice.notes).toEqual([]);
    // The cut itself is idempotent too: a copy of the prepared rows, which the writer has not seen, comes back unchanged.
    const copy = prepareSheet({ ...once.sheet, rows: once.sheet.rows.map((row) => [...row]) });
    expect(copy.sheet.rows).toEqual(once.sheet.rows);
    expect(copy.notes).toEqual([]);
    expect(partsOf(once.sheet)).toEqual(partsOf(copy.sheet));
  });

  it('a sheet that was never prepared is prepared by the writer, so its parts hold the cut cell', () => {
    const cells = readCells(partsOf(OVERSIZED)['xl/worksheets/sheet1.xml'] ?? '');
    expect((cells.get('A2')?.value as string).length).toBe(XLSX_CELL_MAX);
    expect(cells.get('A3')?.value).toBe('bell');
    expect(partsOf(OVERSIZED)).toEqual(partsOf(prepareSheet(OVERSIZED).sheet));
  });

  it('the archive holds the same sheet whether the caller prepared it or not', async () => {
    const fromRaw = unzipText(await renderXlsx(OVERSIZED));
    const fromPrepared = unzipText(await renderXlsx(prepareSheet(OVERSIZED).sheet));
    expect(fromRaw).toEqual(fromPrepared);
    expect(fromRaw['xl/worksheets/sheet1.xml']).toBe(partsOf(OVERSIZED)['xl/worksheets/sheet1.xml']);
  });
});

describe('names', () => {
  it('a sheet name drops the characters Excel refuses and keeps to 31 characters', () => {
    expect(sheetName('Act 1: [draft] / notes?')).toBe('Act 1   draft    notes');
    expect(sheetName('x'.repeat(40))).toHaveLength(31);
    expect(sheetName("''")).toBe('Sheet1');
  });

  it('columns are lettered as a spreadsheet letters them', () => {
    expect([0, 9, 25, 26, 27, 701, 702].map(columnName)).toEqual(['A', 'J', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  });
});

describe('the archive', () => {
  it('is a ZIP holding the parts, and the same table makes the same bytes', async () => {
    const first = await renderXlsx(SAMPLE);
    const second = await renderXlsx(SAMPLE);
    expect(first).toEqual(second);
    const parts = unzipText(first);
    expect(Object.keys(parts).sort()).toEqual(Object.keys(partsOf(SAMPLE)).sort());
    for (const [name, xml] of Object.entries(parts)) assertWellFormedXml(name, xml);
  });

  it('loads its ZIP engine lazily, from the browser build', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/render-xlsx.ts', import.meta.url), 'utf8');
    expect(source).toContain("await import('fflate/browser')");
    expect(source).not.toMatch(/^import \{[^}]*\} from 'fflate/m);
  });
});

/* ------------------------------------------------------------------ *
 * The two formats through the exporter
 * ------------------------------------------------------------------ */

function exporterFor(state: ProjectState = makeMediaProject(), bytes?: ByteArtifacts, fs = new MemoryArtifactFs()): ExporterService {
  return createExporter({
    readState: () => state,
    artifacts: fs,
    ...(bytes === undefined ? {} : { bytes }),
    clock: { now: () => COMPILED_AT },
    metadata: () => ({ author: 'Ada Lovelace' }),
    assets: () => ASSETS,
  });
}

async function compiled(format: ExportFormat, state?: ProjectState, selection = ['manuscript']) {
  const result = await exporterFor(state).compile({ includeRootIds: selection }, format);
  const file = result.files[0];
  if (file === undefined || result.files.length !== 1) throw new Error(`expected one file, got ${result.files.length}`);
  const bytes = new Uint8Array(await file.blob.arrayBuffer());
  return { result, file, bytes, sheet: strFromU8(unzipSync(bytes)['xl/worksheets/sheet1.xml'] ?? new Uint8Array()) };
}

/** An RFC 4180 CSV as rows of cells. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += ch;
  }
  return rows;
}

describe('the formats are binary and named as spreadsheets', () => {
  it('both are binary, with the spreadsheet MIME type', () => {
    for (const format of ['dialogue-xlsx', 'shot-list-xlsx'] as const) {
      expect(isBinaryFormat(format)).toBe(true);
      expect(EXPORT_MIME[format]).toBe(XLSX_MIME);
    }
  });
});

describe('shot-list-xlsx — the shot list as a spreadsheet', () => {
  it('names the file for the shot list and writes the spec’s columns, one row per shot, numbers as numbers', async () => {
    const { file, sheet } = await compiled('shot-list-xlsx');
    expect(file.fileName).toBe(`${PROJECT_NAME} (shot list).xlsx`);
    expect(file.mimeType).toBe(XLSX_MIME);
    expect(readRows(sheet, 10)).toEqual([
      ['shotNumber', 'image filename', 'shotSize', 'cameraAngle', 'cameraMovement', 'lens', 'action', 'dialogue', 'durationSec', 'transition'],
      [1, ASSET_FILE, 'MS', 'eye', 'static', '', 'Mara sets the kettle down.', 'INT. KITCHEN - DAY:MARA', 5, 'cut'],
      [2, '', 'WS', '', '', '', 'The harbour, empty.', '', 6, ''],
    ]);
    const cells = readCells(sheet);
    expect(cells.get('A2')?.kind).toBe('number');
    expect(cells.get('I3')?.kind).toBe('number');
    expect(cells.get('G3')?.kind).toBe('string');
  });

  it('lists the CSV’s rows and cells, except where the formats differ by design', async () => {
    // The formats agree on every cell of plain text and numbers. They differ by design where a CSV guards a text cell that
    // opens with a formula character (an apostrophe; the spreadsheet keeps the text as typed), and where the spreadsheet
    // alone turns CR or CRLF into LF, drops the characters XML forbids, and cuts a cell past 32,767 characters. This fixture
    // carries the first difference on purpose, so a parity check that ignores it cannot pass.
    const state = makeMediaProject();
    const shot = nodeById(state, MEDIA_IDS.shotTwo) as { shot?: { action?: string } } | undefined;
    if (shot?.shot === undefined) throw new Error('the fixture has no second shot');
    shot.shot.action = '=1+1 the harbour';
    const xlsx = await compiled('shot-list-xlsx', state);
    const csv = await exporterFor(state).compile({ includeRootIds: ['manuscript'] }, 'shot-list-csv');
    const fromCsv = csvRows((await csv.files[0]?.blob.text()) ?? '');
    const fromXlsx = readRows(xlsx.sheet, 10).map((row) => row.map(String));
    // The intended divergence: the CSV writes the guard, the spreadsheet writes the text as typed, kept as text.
    expect(fromCsv[2]?.[6]).toBe("'=1+1 the harbour");
    expect(fromXlsx[2]?.[6]).toBe('=1+1 the harbour');
    expect(readCells(xlsx.sheet).get('G3')).toEqual({ kind: 'string', style: 2, value: '=1+1 the harbour' });
    // Every other cell is the same.
    const unguard = (rows: string[][]) => rows.map((row, r) => row.map((cell, c) => (r === 2 && c === 6 ? cell.replace(/^'/, '') : cell)));
    expect(fromXlsx).toEqual(unguard(fromCsv));
  });

  it('writes an action that opens with a formula character as text, without the CSV’s apostrophe', async () => {
    const state = makeMediaProject();
    const shot = nodeById(state, MEDIA_IDS.shotTwo) as { shot?: { action?: string } } | undefined;
    if (shot?.shot === undefined) throw new Error('the fixture has no second shot');
    shot.shot.action = '=HYPERLINK("http://example.com")';
    const { sheet } = await compiled('shot-list-xlsx', state);
    expect(readCells(sheet).get('G3')).toEqual({ kind: 'string', style: 2, value: '=HYPERLINK("http://example.com")' });
  });

  it('refuses a selection with no shot, in the words of the shot list', async () => {
    await expect(exporterFor().compile({ includeRootIds: ['research'] }, 'shot-list-xlsx')).rejects.toThrow(
      'this compile as the shot list is refused: the selection holds no shot',
    );
  });
});

describe('dialogue-xlsx — the dialogue table as a spreadsheet', () => {
  it('writes the table’s columns, one row per line and choice, in the same order as the CSV', async () => {
    const { file, sheet } = await compiled('dialogue-xlsx');
    expect(file.fileName).toBe(`${PROJECT_NAME} (dialogue).xlsx`);
    const rows = readRows(sheet, 6);
    expect(rows[0]).toEqual(['lineId', 'speaker', 'text', 'context', 'charLimit', 'locale']);
    const csv = await exporterFor().compile({ includeRootIds: ['manuscript'] }, 'dialogue-csv');
    const fromCsv = csvRows((await csv.files[0]?.blob.text()) ?? '');
    // Cell for cell only because this fixture holds none of the text the formats treat differently by design (a cell that opens
    // with a formula character, a CR line ending, a character XML forbids, a cell past the length limit; the shot list's test
    // pins the first). Its precondition catches a CR anywhere, a character XML forbids and a cell past the length limit; a cell that opens with =, +, -, @ or a tab fails instead at the parity assertion below.
    // A leading apostrophe is not listed: one the source began with is written identically by both formats, and one the guard
    // added to a formula character would sit on a cell that already starts with that character in the source, which the parity
    // assertion below catches as a difference.
    const divergent = (cell: string): boolean =>
      /^[=+\-@\t\r]|\r/.test(cell) || stripXmlIllegal(cell) !== cell || cell.length > XLSX_CELL_MAX;
    expect(fromCsv.flat().filter(divergent)).toEqual([]);
    expect(rows.map((row) => row.map(String))).toEqual(fromCsv);
    expect(rows.slice(1).map((row) => row[0])).toEqual(['l_0000000001', 'l_0000000002', 'l_0000000003_c', 'l_0000000004_c', 'l_0000000005']);
  });

  it('writes the character limit as a number on every row', () => {
    const output = renderMedia({
      state: makeMediaProject(),
      format: 'dialogue-xlsx',
      includeRootIds: ['manuscript'],
      title: PROJECT_NAME,
      author: '',
      date: '2026-10-02',
      titlePage: false,
      base: PROJECT_NAME,
      charLimit: 42,
      assets: new Map(),
    });
    const file = output.files[0];
    expect(file?.bytes).toBeTypeOf('function');
    expect(output.blockCount).toBe(5);
    return file?.bytes?.().then((bytes) => {
      const cells = readCells(strFromU8(unzipSync(bytes)['xl/worksheets/sheet1.xml'] ?? new Uint8Array()));
      for (const row of [2, 3, 4, 5, 6]) expect(cells.get(`E${row}`)).toEqual({ kind: 'number', style: 0, value: 42 });
    });
  });

  it('refuses a table with a line that has no id, as the CSV does', async () => {
    await expect(
      exporterFor(makeMediaProject({ innkeeper: UNKEYED_INK })).compile({ includeRootIds: ['manuscript'] }, 'dialogue-xlsx'),
    ).rejects.toThrow('this compile as the dialogue table is refused');
  });
});

describe('the spreadsheets through the bus', () => {
  function busRig(withBytes: boolean) {
    const state = makeMediaProject();
    const fs = new MemoryArtifactFs();
    const written = new Map<string, Uint8Array>();
    const bytes: ByteArtifacts | undefined = withBytes
      ? {
          writeBytes: async (path, data) => void written.set(path, data),
          removeBytes: async (path) => void written.delete(path),
        }
      : undefined;
    const exporter = exporterFor(state, bytes, fs);
    const clock = { now: () => COMPILED_AT };
    const registry = createProjectCommandRegistry({ clock, exporter: exporter.commandPort() });
    const undo: UndoStore = createUndoStore({ dispatch: (command) => execute(command, bus, registry) });
    const bus: BusContext<ProjectState> = {
      state,
      view: createViewState(),
      read: () => state,
      undo,
      log: createActivityLog(),
      idempotency: createIdempotencyCache(),
      notify: () => {},
    };
    let serial = 0;
    const run = (params: Record<string, unknown>) => {
      serial += 1;
      const command = {
        id: `cmd_XLSX${String(serial).padStart(6, '0')}`,
        name: 'export.compile',
        params,
        issuedBy: 'user',
        createdAt: COMPILED_AT,
      } as Command;
      return execute(command, bus, registry);
    };
    return { fs, exporter, written, run, undo };
  }

  it('writes the workbook to exports/ through the byte store, and logs the compile', async () => {
    const r = busRig(true);
    await r.exporter.ready();
    const outcome = r.run({ format: 'shot-list-xlsx' });
    if (!outcome.ok) throw new Error(outcome.error.message);
    await r.exporter.idle();
    expect(r.exporter.failures()).toEqual([]);
    const path = `exports/${PROJECT_NAME} (shot list).xlsx`;
    expect((outcome.value.result as { output: string }).output).toBe(path);
    const bytes = r.written.get(path);
    expect(bytes).toBeDefined();
    expect(Object.keys(unzipText(bytes ?? new Uint8Array()))).toContain('xl/worksheets/sheet1.xml');
    const log = JSON.parse(r.fs.snapshot()['exports/compile-log.json'] ?? '[]') as { format: string; blockCount: number }[];
    expect(log).toMatchObject([{ format: 'shot-list-xlsx', blockCount: 2 }]);
  });

  it('is refused, with nothing written, when the project has no byte store', async () => {
    const r = busRig(false);
    await r.exporter.ready();
    const outcome = r.run({ format: 'dialogue-xlsx' });
    expect(outcome.ok).toBe(false);
    await r.exporter.idle();
    expect(r.fs.snapshot()['exports/compile-log.json']).toBeUndefined();
  });
});
