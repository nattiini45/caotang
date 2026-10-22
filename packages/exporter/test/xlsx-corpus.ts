/**
 * The XLSX interop corpus: workbooks made by the exporter's real code path (a compile for the two media formats, `renderXlsx`
 * for the sheet-name case), each with a hand-written description of what a spreadsheet must read back. The description is
 * the spec's, not the writer's: a value and a type per cell, which cells keep their text as text (Excel's `quotePrefix`), and
 * which wrap. xlsx-write-corpus.test.ts writes both to disk for tools/office-interop/check_xlsx.py (openpyxl and LibreOffice).
 */

import { MemoryArtifactFs, nodeById, type ProjectState } from '@caotang/store';
import { addShotNode } from '@caotang/storyboard';
import { XLSX_CELL_MAX, createExporter, renderXlsx, type ExportFormat } from '../src/index.js';
import { COMPILED_AT } from './fixture.js';
import { MEDIA_IDS, OPENED, makeMediaProject } from './media-fixture.js';

/** What one cell must read back as: empty, a number, or text with the two flags the writer sets by the text itself. */
export type ExpectedCell =
  | null
  | { readonly t: 'n'; readonly v: number }
  | { readonly t: 's'; readonly v: string; readonly quotePrefix?: true; readonly wrap?: true };

/** One workbook: its file, its one sheet's name and title, the header labels and every row, as wide as the header. */
export interface ExpectedBook {
  readonly file: string;
  readonly sheet: string;
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly ExpectedCell[])[];
}

export interface XlsxCase {
  readonly expected: ExpectedBook;
  readonly build: () => Promise<Uint8Array>;
}

/** The characters a spreadsheet reads as the start of a formula; a text cell that opens with one keeps its text as text. */
const GUARDED = ['=', '+', '-', '@', '\t', '\r'];

const n = (v: number): ExpectedCell => ({ t: 'n', v });

/** A text cell; the flags follow from the text: a formula character first, a line break inside. */
function s(v: string): ExpectedCell {
  return {
    t: 's',
    v,
    ...(GUARDED.includes(v.charAt(0)) ? { quotePrefix: true as const } : {}),
    ...(v.includes('\n') ? { wrap: true as const } : {}),
  };
}

/** A cell that is not written. Only `s('')` and `null` write nothing, so a blank column is `null`. */
const EMPTY: ExpectedCell = null;

/** Compiles `state` to `format` through the exporter's command port, as a click on Export does, and returns the one file. */
async function compiled(state: ProjectState, format: ExportFormat, options: { charLimit?: number } = {}): Promise<Uint8Array> {
  const written = new Map<string, Uint8Array>();
  const exporter = createExporter({
    readState: () => state,
    artifacts: new MemoryArtifactFs(),
    bytes: { writeBytes: async (path, data) => void written.set(path, data), removeBytes: async (path) => void written.delete(path) },
    clock: { now: () => COMPILED_AT },
    metadata: () => ({ author: 'Ada Lovelace' }),
    assets: () => new Map(),
  });
  await exporter.ready();
  state.manifest.recipes = [{ name: 'Corpus', includeRootIds: ['manuscript'], format, options }];
  exporter.commandPort().compile(state, { selection: { kind: 'manuscript' }, format, recipeName: 'Corpus', at: COMPILED_AT });
  await exporter.idle();
  if (exporter.failures().length > 0) throw new Error(`the ${format} compile failed: ${JSON.stringify(exporter.failures())}`);
  if (written.size !== 1) throw new Error(`the ${format} compile wrote ${written.size} files, not one`);
  return [...written.values()][0] ?? new Uint8Array();
}

/** A knot of dialogue lines, each with its line id: the table's rows. */
const DIALOGUE_INK = [
  '=== start ===',
  'The innkeeper looks up. # lineId: l_0000000001',
  'Innkeeper: Welcome, señor! Crème brûlée? # lineId: l_0000000002',
  'Innkeeper: 草堂へようこそ, 欢迎光临 # lineId: l_0000000003',
  'Innkeeper: Cheers 🍻 and 👨‍👩‍👧! # lineId: l_0000000004',
  'Innkeeper: =SUM(A1) # lineId: l_0000000005',
  'Innkeeper: +1 for the road # lineId: l_0000000006',
  'Innkeeper: -x marks the spot # lineId: l_0000000007',
  'Innkeeper: @harbour # lineId: l_0000000008',
  'Innkeeper: Literal _x0041_ and 12 # lineId: l_0000000009',
  '* [Order an ale # lineId: l_0000000010_c] -> END',
].join('\n');

const DIALOGUE_COLUMNS = ['lineId', 'speaker', 'text', 'context', 'charLimit', 'locale'] as const;

/** One dialogue row: the id, the speaker, the text, the knot as its context, the limit the compile was given (42), and the project's language. */
const line = (id: string, speaker: string, text: string): ExpectedCell[] => [
  s(id),
  speaker === '' ? EMPTY : s(speaker),
  s(text),
  s('start'),
  n(42),
  s('en'),
];

/** The shot list's columns, as storyboard's SHOT_LIST_COLUMNS names them. */
const SHOT_COLUMNS = [
  'shotNumber',
  'image filename',
  'shotSize',
  'cameraAngle',
  'cameraMovement',
  'lens',
  'action',
  'dialogue',
  'durationSec',
  'transition',
] as const;

/** A shot row: its number, size, action and duration, and nothing else. */
const shot = (no: number, size: string, action: ExpectedCell, duration: ExpectedCell): ExpectedCell[] => [
  n(no),
  EMPTY,
  s(size),
  EMPTY,
  EMPTY,
  EMPTY,
  action,
  EMPTY,
  duration,
  EMPTY,
];

/** A text longer than a cell holds, in a pattern that shows where it was cut. */
const LONG_ACTION = Array.from({ length: Math.ceil((XLSX_CELL_MAX + 3000) / 10) }, (_, i) => String(i % 10).repeat(10)).join('');

function shotListState(): ProjectState {
  const state = makeMediaProject();
  const shots = MEDIA_IDS.shots;
  const add = (id: string, title: string, size: string, action: string, durationSec: number): void => {
    addShotNode(state, { parentId: shots, title, id, now: OPENED, stored: { shotSize: size, action, durationSec } });
  };
  // The fixture's two shots are 1 and 2; these follow in binder order.
  add('n_SHOTACCENT', 'Accents', 'CU', 'Café, señor, Ærø, naïve', 2.5);
  add('n_SHOTCJKEMO', 'World', 'LS', '草堂 at dawn, ようこそ 🎬 👨‍👩‍👧', 3);
  add('n_SHOTLINES1', 'Lines', 'MS', 'First line\nSecond line\nThird line', 4);
  add('n_SHOTEQUALS', 'Equals', 'MS', '=SUM(A1)', 1);
  add('n_SHOTPLUS01', 'Plus', 'MS', '+1 for the road', 1);
  add('n_SHOTMINUS1', 'Minus', 'MS', '-x marks the spot', 1);
  add('n_SHOTAT0001', 'At', 'MS', '@harbour', 1);
  add('n_SHOTESCAPE', 'Escape', 'MS', 'Literal _x0041_ here', 1);
  add('n_SHOTLONG01', 'Long', 'MS', LONG_ACTION, 1);
  const noDuration = nodeShot(state, 'n_SHOTNONUM1', 'No duration');
  noDuration.durationSec = Number.NaN;
  return state;
}

/** Adds a shot and returns its stored fields, so a test can set what the add command would refuse. */
function nodeShot(state: ProjectState, id: string, title: string): { durationSec?: number } {
  addShotNode(state, { parentId: MEDIA_IDS.shots, title, id, now: OPENED, stored: { shotSize: 'LS', action: 'Held shot' } });
  const node = nodeById(state, id) as { shot?: { durationSec?: number } } | undefined;
  if (node?.shot === undefined) throw new Error(`shot ${id} was not added`);
  return node.shot;
}

const SHEET_NAME_RAW = 'Shot list: [draft]/v2?';

export const XLSX_CORPUS: readonly XlsxCase[] = [
  {
    expected: {
      file: 'dialogue.xlsx',
      sheet: 'Dialogue',
      title: 'The Lighthouse Keeper (dialogue)',
      columns: DIALOGUE_COLUMNS,
      rows: [
        line('l_0000000001', '', 'The innkeeper looks up.'),
        line('l_0000000002', 'Innkeeper', 'Welcome, señor! Crème brûlée?'),
        line('l_0000000003', 'Innkeeper', '草堂へようこそ, 欢迎光临'),
        line('l_0000000004', 'Innkeeper', 'Cheers 🍻 and 👨‍👩‍👧!'),
        line('l_0000000005', 'Innkeeper', '=SUM(A1)'),
        line('l_0000000006', 'Innkeeper', '+1 for the road'),
        line('l_0000000007', 'Innkeeper', '-x marks the spot'),
        line('l_0000000008', 'Innkeeper', '@harbour'),
        line('l_0000000009', 'Innkeeper', 'Literal _x0041_ and 12'),
        line('l_0000000010_c', '', 'Order an ale'),
      ],
    },
    build: () => compiled(makeMediaProject({ innkeeper: DIALOGUE_INK }), 'dialogue-xlsx', { charLimit: 42 }),
  },
  {
    expected: {
      file: 'shot-list.xlsx',
      sheet: 'Shot list',
      title: 'The Lighthouse Keeper (shot list)',
      columns: SHOT_COLUMNS,
      rows: [
        [n(1), EMPTY, s('MS'), s('eye'), s('static'), EMPTY, s('Mara sets the kettle down.'), s('INT. KITCHEN - DAY:MARA'), n(5), s('cut')],
        shot(2, 'WS', s('The harbour, empty.'), n(6)),
        shot(3, 'CU', s('Café, señor, Ærø, naïve'), n(2.5)),
        shot(4, 'LS', s('草堂 at dawn, ようこそ 🎬 👨‍👩‍👧'), n(3)),
        shot(5, 'MS', s('First line\nSecond line\nThird line'), n(4)),
        shot(6, 'MS', s('=SUM(A1)'), n(1)),
        shot(7, 'MS', s('+1 for the road'), n(1)),
        shot(8, 'MS', s('-x marks the spot'), n(1)),
        shot(9, 'MS', s('@harbour'), n(1)),
        shot(10, 'MS', s('Literal _x0041_ here'), n(1)),
        shot(11, 'MS', s(LONG_ACTION.slice(0, XLSX_CELL_MAX)), n(1)),
        shot(12, 'LS', s('Held shot'), EMPTY),
      ],
    },
    build: () => compiled(shotListState(), 'shot-list-xlsx'),
  },
  {
    // The compile names its sheets 'Dialogue' and 'Shot list', so the cleaning of a sheet name goes through the writer itself.
    expected: {
      file: 'sheet-name.xlsx',
      sheet: 'Shot list   draft  v2',
      title: SHEET_NAME_RAW,
      columns: ['n', 'text'],
      rows: [
        [n(1), s('_x0041_')],
        [n(2), s('plain')],
      ],
    },
    build: () =>
      renderXlsx({
        name: SHEET_NAME_RAW,
        columns: ['n', 'text'],
        rows: [
          [1, '_x0041_'],
          [2, 'plain'],
        ],
      }),
  },
];
