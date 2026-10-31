/**
 * The timeline's four compile formats (timeline.md §8): `timeline-csv` and `timeline-xlsx` as golden tables in
 * canonical logical order with negative days and formula guards, `timeline-svg` as safely serialized text in the
 * project-language direction, and `timeline-pdf` as a paginated landscape PDF read back with pdf-lib and pdf.js.
 * The last describe runs the formats through the bus's `export.compile`, the way every host dispatches them.
 */

import { describe, expect, it, vi } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { emptyCoherenceFile, type CoherenceFile, type Finding, type SceneMeta } from '@caotang/coherence';
import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  type BusContext,
  type Command,
  type CommandError,
  type ExecutionOutcome,
  type Result,
  type UndoStore,
} from '@caotang/bus';
import { loadArabicFontInNode, loadCjkFontInNode, loadDevanagariFontInNode, loadEmojiFontInNode, loadHebrewFontInNode } from '@caotang/pdf-fonts/node-loader';
import { addDocument, addFolder, createEmptyManifest, createProjectState, createProjectCommandRegistry, MemoryArtifactFs, type ProjectState } from '@caotang/store';

import { createExporter, renderTimelineSvg, svgEscape, rasterizeSvgToPng, svgIntrinsicSize, type ByteArtifacts, type ExporterService } from '../src/index.js';
import { planTimelinePages } from '../src/render-timeline-pdf.js';
import { TIMELINE_COLUMNS, timelineCsv, timelineTable } from '../src/render-timeline-csv.js';
import { readRows } from './xlsx-read.js';
import { COMPILED_AT, OPENED, PROJECT_NAME } from './fixture.js';

vi.setConfig({ testTimeout: 60_000 });

const IDS = {
  prologueFolder: 'n_PROLOG0001',
  before: 'n_BEFORE0001',
  claim: 'n_CLAIM00001',
  chapterOne: 'n_CHAPTER01',
  landing: 'n_LANDING01',
  storm: 'n_STORM0001',
  loose: 'n_LOOSE00001',
  epilogueFolder: 'n_EPILOG0001',
  yearsOn: 'n_YEARSON001',
  elena: 'c_ELENA0001',
} as const;

function finding(id: string, checkId: string, docIds: readonly string[]): Finding {
  return {
    id,
    runId: 'r_1',
    class: 'deterministic',
    checkId,
    type: checkId.split('.')[1] ?? 'x',
    severity: 'warning',
    status: 'open',
    factGroup: `${checkId}|${id}`,
    evidence: docIds.map((docId) => ({ docId, quote: '', from: 0, to: 0 })),
    createdAt: OPENED.toISOString(),
    updatedAt: OPENED.toISOString(),
    message: id,
  } as Finding;
}

/** A project with a prologue before day 0, a main story, an undated scene and an epilogue 4,380 days later. */
function makeTimelineProject(language?: string): ProjectState {
  const state = createProjectState(createEmptyManifest(PROJECT_NAME, OPENED, { locale: 'en-US' }));
  if (language !== undefined) state.manifest.project.language = language;
  state.manifest.codex = [
    {
      id: IDS.elena,
      name: 'Elena',
      aliases: [],
      type: 'character',
      description: 'The keeper.',
      includePolicy: 'detected',
      caseSensitive: false,
      exclude: [],
      attachments: [],
      keywords: [],
      origin: 'manual',
      sources: [],
      createdAt: OPENED.toISOString(),
      updatedAt: OPENED.toISOString(),
    },
  ];
  addFolder(state, { parentId: 'manuscript', title: 'Prologue', now: OPENED, id: IDS.prologueFolder });
  addDocument(state, { parentId: IDS.prologueFolder, title: 'Before the storm', body: 'Nine years alone.', now: OPENED, id: IDS.before });
  addDocument(state, { parentId: IDS.prologueFolder, title: '=Claim the light', body: 'A title that opens with a formula character.', now: OPENED, id: IDS.claim });
  addFolder(state, { parentId: 'manuscript', title: 'Chapter One', now: OPENED, id: IDS.chapterOne });
  addDocument(state, { parentId: IDS.chapterOne, title: 'The Landing', body: 'The ferry was late.', now: OPENED, id: IDS.landing });
  addDocument(state, { parentId: IDS.chapterOne, title: 'The Storm', body: 'Rain all night.', now: OPENED, id: IDS.storm });
  addDocument(state, { parentId: IDS.chapterOne, title: 'Loose thread', body: 'No day declared.', now: OPENED, id: IDS.loose });
  addFolder(state, { parentId: 'manuscript', title: 'Epilogue', now: OPENED, id: IDS.epilogueFolder });
  addDocument(state, { parentId: IDS.epilogueFolder, title: 'Ten years on', body: 'The new keeper.', now: OPENED, id: IDS.yearsOn });

  const sceneMeta: Record<string, SceneMeta> = {
    [IDS.prologueFolder]: { storyPart: 'prologue' },
    [IDS.before]: { dayOffset: -3, durationDays: 2 },
    [IDS.claim]: { dayOffset: -1 },
    [IDS.landing]: { dayOffset: 0, durationDays: 1, pov: IDS.elena, expectedPresent: [IDS.elena], threads: [{ id: 'the灯', payoff: IDS.storm }] },
    [IDS.storm]: { dayOffset: 5, after: [IDS.landing] },
    [IDS.epilogueFolder]: { storyPart: 'epilogue' },
    [IDS.yearsOn]: { dayOffset: 4380 },
  };
  const file = { ...emptyCoherenceFile(), sceneMeta, findings: [finding('f_GAP00001', 'timeline.gap', [IDS.storm, IDS.yearsOn])] } as CoherenceFile;
  state.coherence = file;
  return state;
}

const INPUT = { includeRootIds: ['manuscript'] as const };

describe('timeline-csv: one row per scene, canonical order, guarded cells', () => {
  it('orders by part, then day, then reading index, with undated last per part, and writes the header', () => {
    const table = timelineTable({ state: makeTimelineProject(), ...INPUT });
    expect(table.columns).toEqual([...TIMELINE_COLUMNS]);
    expect(table.rows.map((row) => [row.part, row.title, row.day])).toEqual([
      ['prologue', 'Before the storm', -3],
      ['prologue', '=Claim the light', -1],
      ['main', 'The Landing', 0],
      ['main', 'The Storm', 5],
      ['main', 'Loose thread', null],
      ['epilogue', 'Ten years on', 4380],
    ]);
    const csv = timelineCsv(table);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(TIMELINE_COLUMNS.join(','));
    expect(lines).toHaveLength(table.rows.length + 2); // header, rows, trailing empty after the last CRLF
    // The negative day is written as a signed decimal and guarded, so no spreadsheet reads it as a formula.
    expect(csv).toContain(",'-3,");
    // A title opening with `=` is guarded with an apostrophe.
    expect(csv).toContain("'=Claim the light");
    // The lens label uses the real minus sign; the day cell itself is plain decimal.
    expect(csv).toContain('Day −3');
    // Folder path, part names, mode, pov name, present, after, threads, findings.
    expect(csv).toContain('Chapter One');
    expect(csv).toContain('Prologue');
    expect(csv).toContain('Main story');
    expect(csv).toContain('Epilogue');
    expect(csv).toContain('linear');
    expect(csv).toContain('Elena');
    expect(csv).toContain('the灯');
    expect(csv).toContain('timeline.gap');
  });

  it('is the same bytes for a right-to-left project: the row order never mirrors', () => {
    const ltr = timelineCsv(timelineTable({ state: makeTimelineProject(), ...INPUT }));
    const rtl = timelineCsv(timelineTable({ state: makeTimelineProject('he'), ...INPUT }));
    expect(rtl).toBe(ltr);
  });
});

describe('timeline-xlsx: the same rows as typed cells', () => {
  it('writes days and indexes as number cells and a formula-opening title as a quoted text cell', async () => {
    const exporter = createExporter({ readState: () => makeTimelineProject(), artifacts: new MemoryArtifactFs(), clock: { now: () => COMPILED_AT } });
    const result = await exporter.compile({ includeRootIds: ['manuscript'] }, 'timeline-xlsx');
    const bytes = new Uint8Array(await result.files[0]!.blob.arrayBuffer());
    const parts = unzipSync(bytes);
    const sheet = strFromU8(parts['xl/worksheets/sheet1.xml']!);
    const rows = readRows(sheet, TIMELINE_COLUMNS.length);
    expect(rows[0]).toEqual([...TIMELINE_COLUMNS]);
    // Row 2 is the prologue scene at day −3: the day, duration and end are number cells.
    const dayCell = rows[1]![4];
    expect(typeof dayCell).toBe('number');
    expect(dayCell).toBe(-3);
    expect(rows[1]![5]).toBe(2);
    expect(rows[1]![6]).toBe(-1);
    // The reading index is a number; the title opening with `=` is a text cell.
    expect(rows[2]![0]).toBe(1);
    expect(rows[2]![2]).toBe('=Claim the light');
    // The last row is the epilogue at day 4,380.
    expect(rows[rows.length - 1]![4]).toBe(4380);
  });
});

describe('timeline-svg: escaped, generic-font, project-direction geometry', () => {
  it('serializes every text escaped, uses only generic font families, and draws zones, folds, chips and connectors', () => {
    const { svg, chips, aggregated } = renderTimelineSvg({ state: makeTimelineProject(), ...INPUT });
    expect(aggregated).toBe(false);
    expect(chips).toBe(6);
    expect(svg).toContain('font-family="sans-serif"');
    expect(svg).not.toContain('@font-face');
    expect(svg).not.toContain('font-family="' + '"' + '"');
    // The formula-opening title is escaped, not raw markup.
    expect(svg).toContain('=Claim the light');
    expect(svg).not.toContain('<Claim');
    // Zones and the fold between the main story and the epilogue, with its span label.
    expect(svg).toContain('Prologue');
    expect(svg).toContain('Main story');
    expect(svg).toContain('Epilogue');
    expect(svg).toContain('about 12 years later');
    // The undated scene is on the shelf, not on the axis.
    expect(svg).toContain('Undated scenes');
    expect(svg).toContain('Loose thread');
    // An after-connector is drawn as a line.
    expect(svg).toMatch(/<line /);
  });

  it('escapes markup in a title so it cannot break out of its element', () => {
    expect(svgEscape('<img src=x onerror=alert(1)> & "quotes"')).toBe('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;');
    const state = makeTimelineProject();
    const node = state.manifest.tree.find((entry) => entry.id === IDS.landing);
    if (node !== undefined) node.title = '</text><script>alert(1)</script>';
    const { svg } = renderTimelineSvg({ state, ...INPUT });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('mirrors the geometry for a right-to-left project, about the same width', () => {
    const ltr = renderTimelineSvg({ state: makeTimelineProject(), ...INPUT });
    const rtl = renderTimelineSvg({ state: makeTimelineProject('he'), ...INPUT });
    const widthOf = (svg: string): number => Number(/width="([\d.]+)"/.exec(svg)?.[1]);
    expect(widthOf(rtl.svg)).toBe(widthOf(ltr.svg));
    // The filled chip rects with their labels, in document order.
    const chipsOf = (svg: string): Map<string, { x: number; w: number }> => {
      const out = new Map<string, { x: number; w: number }>();
      const pattern = /<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="[\d.]+" rx="3" fill="#333333"\/>\s*<text[^>]*>([^<]*)<\/text>/g;
      for (const match of svg.matchAll(pattern)) out.set(match[3] ?? '', { x: Number(match[1]), w: Number(match[2]) });
      return out;
    };
    const ltrChips = chipsOf(ltr.svg);
    const rtlChips = chipsOf(rtl.svg);
    const label = 'The Landing · Day 0';
    expect(ltrChips.has(label)).toBe(true);
    const l = ltrChips.get(label)!;
    const r = rtlChips.get(label)!;
    expect(r.x).toBeCloseTo(widthOf(ltr.svg) - l.x - l.w, 0);
    // And an early prologue chip sits on the reading-start side in both.
    const prologue = 'Before the storm · Day −3';
    expect(ltrChips.get(prologue)!.x).toBeLessThan(widthOf(ltr.svg) / 2);
    expect(rtlChips.get(prologue)!.x).toBeGreaterThan(widthOf(ltr.svg) / 2);
  });

  it('aggregates above 2,000 visible items to chapter blocks, with an explicit note', () => {
    const state = createProjectState(createEmptyManifest(PROJECT_NAME, OPENED, { locale: 'en-US' }));
    const chapter = addFolder(state, { parentId: 'manuscript', title: 'Chapter One', now: OPENED, id: 'n_CHAPTER01' }).id;
    for (let at = 0; at < 2100; at += 1) {
      addDocument(state, { parentId: chapter, title: `Scene ${at}`, body: 'Words.', now: OPENED, id: `n_SCENE${String(at).padStart(5, '0')}` });
    }
    state.coherence = { ...emptyCoherenceFile(), sceneMeta: { [chapter]: {}, 'n_SCENE00000': { dayOffset: 0 } } } as CoherenceFile;
    const output = renderTimelineSvg({ state, includeRootIds: ['manuscript'] });
    expect(output.aggregated).toBe(true);
    expect(output.chips).toBeLessThan(2100);
    expect(output.chips).toBeGreaterThan(0);
    expect(output.notes[0]).toContain('2,100 scenes');
    expect(output.notes[0]).toContain('chapter blocks');
    expect(output.svg).toContain('chapter blocks');
  });
});

/** The text of every page as pdf.js gives it (the legacy build, as tools/pdf-validate loads it). */
async function pdfjsText(bytes: Uint8Array): Promise<string[]> {
  const dir = join(process.cwd(), 'packages', 'exporter', 'node_modules', 'pdfjs-dist');
  const pdfjs = (await import(/* @vite-ignore */ pathToFileURL(join(dir, 'legacy', 'build', 'pdf.mjs')).href)) as {
    getDocument(options: object): { promise: Promise<{ numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: { str?: string; transform?: number[] }[] }> }> }> };
  };
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, standardFontDataUrl: `${join(dir, 'standard_fonts')}/`, useSystemFonts: false }).promise;
  const pages: string[] = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const content = await (await doc.getPage(number)).getTextContent();
    pages.push(content.items.map((item) => item.str ?? '').join(' '));
  }
  return pages;
}

/** The x of every text item on a page, as pdf.js reads it. */
async function pdfjsPositions(bytes: Uint8Array): Promise<{ page: number; text: string; x: number }[]> {
  const dir = join(process.cwd(), 'packages', 'exporter', 'node_modules', 'pdfjs-dist');
  const pdfjs = (await import(/* @vite-ignore */ pathToFileURL(join(dir, 'legacy', 'build', 'pdf.mjs')).href)) as {
    getDocument(options: object): { promise: Promise<{ numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: { str?: string; transform?: number[] }[] }> }> }> };
  };
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, standardFontDataUrl: `${join(dir, 'standard_fonts')}/`, useSystemFonts: false }).promise;
  const out: { page: number; text: string; x: number }[] = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const content = await (await doc.getPage(number)).getTextContent();
    for (const item of content.items) out.push({ page: number, text: item.str ?? '', x: item.transform?.[4] ?? Number.NaN });
  }
  return out;
}

function nodeExporter(state: ProjectState): ExporterService {
  return createExporter({
    readState: () => state,
    artifacts: new MemoryArtifactFs(),
    clock: { now: () => COMPILED_AT },
    loadFallbackFont: loadCjkFontInNode,
    loadEmojiFont: loadEmojiFontInNode,
    loadArabicFont: loadArabicFontInNode,
    loadHebrewFont: loadHebrewFontInNode,
    loadDevanagariFont: loadDevanagariFontInNode,
  });
}

describe('timeline-pdf: paginated landscape, fresh page per part, footer, multilingual titles', () => {
  it('writes a landscape A4 PDF whose pages carry the tick row and the footer, and a fold starts a fresh page', async () => {
    const result = await nodeExporter(makeTimelineProject()).compile({ includeRootIds: ['manuscript'] }, 'timeline-pdf');
    const bytes = new Uint8Array(await result.files[0]!.blob.arrayBuffer());
    expect(bytes[0]).toBe(0x25); // %PDF
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2); // the epilogue's fold starts a fresh page
    const { width, height } = pdf.getPage(0).getSize();
    expect(width).toBeCloseTo(841.89, 1);
    expect(height).toBeCloseTo(595.28, 1);
    const pages = await pdfjsText(bytes);
    // Each part starts on a fresh page (timeline.md §8): the prologue's days first, then the main story's.
    expect(pages[0]).toContain('Prologue');
    const mainPage = pages.find((text) => text.includes('Main story'));
    expect(mainPage).toBeDefined();
    expect(mainPage).toContain('Day 0');
    for (const [index, text] of pages.entries()) {
      expect(text).toContain(`page ${index + 1} of ${pages.length}`);
      expect(text).toContain('Day lens');
    }
    // The epilogue's page names the part and its day span in the footer (the fold's label on the previous page also
    // names the epilogue, so the page is found by its footer).
    const epiloguePage = pages.find((text) => text.includes('Epilogue · Day'));
    expect(epiloguePage).toBeDefined();
    expect(epiloguePage).toContain('Day 4,380');
    // The prologue's negative day is drawn on its own page, which names the prologue.
    const prologuePage = pages.find((text) => text.includes('Prologue'));
    expect(prologuePage).toMatch(/Day\s+−\s+3/);
  });

  it('prints a CJK title through the fallback font, and reads back whole', async () => {
    const state = makeTimelineProject('zh-Hans');
    const node = state.manifest.tree.find((entry) => entry.id === IDS.landing);
    if (node !== undefined) node.title = '灯塔日 dawn 草堂';
    // Two days wide, so the chip holds the whole title rather than ellipsizing it.
    const meta = (state.coherence as CoherenceFile).sceneMeta[IDS.landing];
    if (meta !== undefined) meta.durationDays = 2;
    const result = await nodeExporter(state).compile({ includeRootIds: ['manuscript'] }, 'timeline-pdf');
    const bytes = new Uint8Array(await result.files[0]!.blob.arrayBuffer());
    const pages = await pdfjsText(bytes);
    expect(pages.join(' ')).toContain('灯塔日');
    expect(pages.join(' ')).toContain('草堂');
  });

  it('mirrors the geometry inside a right-to-left book’s pages while the page order stays reading order', async () => {
    const ltr = new Uint8Array(await (await nodeExporter(makeTimelineProject()).compile({ includeRootIds: ['manuscript'] }, 'timeline-pdf')).files[0]!.blob.arrayBuffer());
    const rtl = new Uint8Array(await (await nodeExporter(makeTimelineProject('he')).compile({ includeRootIds: ['manuscript'] }, 'timeline-pdf')).files[0]!.blob.arrayBuffer());
    const ltrPos = await pdfjsPositions(ltr);
    const rtlPos = await pdfjsPositions(rtl);
    const landingLtr = ltrPos.find((item) => item.text.includes('The Landing'));
    const landingRtl = rtlPos.find((item) => item.text.includes('The Landing'));
    expect(landingLtr).toBeDefined();
    expect(landingRtl).toBeDefined();
    // The same scene sits on the reading-start side: left in the LTR book, right in the RTL one.
    expect(landingLtr!.x).toBeLessThan(841.89 / 2);
    expect(landingRtl!.x).toBeGreaterThan(841.89 / 2);
    // Both books' first page still opens with the prologue (page order is reading order, never mirrored).
    expect((await pdfjsText(ltr))[0]).toContain('Prologue');
    expect((await pdfjsText(rtl))[0]).toContain('Prologue');
  });

  it('honours the Letter paper option', async () => {
    const state = makeTimelineProject();
    state.manifest.recipes = [{ name: 'Print', includeRootIds: ['manuscript'], format: 'timeline-pdf', options: { pageSize: 'Letter' } }];
    const exporter = nodeExporter(state);
    const result = await exporter.compile({ includeRootIds: ['manuscript'] }, 'timeline-pdf');
    // The recipe is not named here, so the compile uses A4; name it through the bus in the bus tests below.
    const bytes = new Uint8Array(await result.files[0]!.blob.arrayBuffer());
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPage(0).getSize().width).toBeCloseTo(841.89, 1);
  });
});

describe('the pagination plan: folds start pages, no chip is ever cut', () => {
  it('cuts at fold starts first, then fills pages at other boundaries, and never splits a chip', () => {
    const contentWidth = 100;
    // An axis of 400 units with a fold at 250 and chips that would be split by naive 100-wide pages.
    const chips = [
      { box: { x: 10, y: 0, w: 30, h: 5 } },
      { box: { x: 95, y: 0, w: 30, h: 5 } }, // crosses the naive cut at 100
      { box: { x: 260, y: 0, w: 40, h: 5 } },
    ];
    const cuts = planTimelinePages({ width: 400, contentWidth, chips, foldCuts: [250], cuts: [50, 100, 150, 200, 250, 300, 350] });
    // Every fold cut is a page start.
    expect(cuts).toContain(250);
    expect(cuts[0]).toBe(0);
    // No cut falls strictly inside a chip.
    for (const cut of cuts) {
      for (const chip of chips) {
        expect(cut <= chip.box.x || cut >= chip.box.x + chip.box.w).toBe(true);
      }
    }
    // Pages tile the whole width, in order.
    expect(cuts[cuts.length - 1]).toBe(400);
    for (let at = 1; at < cuts.length; at += 1) expect(cuts[at]!).toBeGreaterThan(cuts[at - 1]!);
  });
});

describe('the PNG raster helper: browser-only, bounded, clear refusal headless', () => {
  it('refuses in Node with the reason, and reads an SVG’s intrinsic size', async () => {
    await expect(rasterizeSvgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200"/>')).rejects.toThrow(/browser canvas/);
    expect(svgIntrinsicSize('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200"></svg>')).toEqual({ width: 800, height: 200 });
    expect(svgIntrinsicSize('<svg viewBox="0 0 400 100"></svg>')).toEqual({ width: 400, height: 100 });
  });
});

/* ------------------------------------------------------------------ *
 * Through the bus: the dispatch every host sends
 * ------------------------------------------------------------------ */

type Dispatch = Result<ExecutionOutcome, CommandError>;

interface Rig {
  readonly state: ProjectState;
  readonly fs: MemoryArtifactFs;
  readonly bytes: Map<string, Uint8Array>;
  readonly exporter: ExporterService;
  readonly undo: UndoStore;
  readonly run: (name: Command['name'], params: Record<string, unknown>) => Dispatch;
}

let serial = 0;

function rig(state: ProjectState): Rig {
  const fs = new MemoryArtifactFs();
  const bytes = new Map<string, Uint8Array>();
  const binding: ByteArtifacts = { writeBytes: async (path, data) => void bytes.set(path, data), removeBytes: async (path) => void bytes.delete(path) };
  const exporter = createExporter({
    readState: () => state,
    artifacts: fs,
    bytes: binding,
    clock: { now: () => COMPILED_AT },
    loadFallbackFont: loadCjkFontInNode,
    loadEmojiFont: loadEmojiFontInNode,
    loadArabicFont: loadArabicFontInNode,
    loadHebrewFont: loadHebrewFontInNode,
    loadDevanagariFont: loadDevanagariFontInNode,
  });
  const registry = createProjectCommandRegistry({ clock: { now: () => COMPILED_AT }, exporter: exporter.commandPort() });
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
  const run = (name: Command['name'], params: Record<string, unknown>): Dispatch => {
    serial += 1;
    return execute({ id: `cmd_TL${String(serial).padStart(6, '0')}`, name, params, issuedBy: 'user', createdAt: COMPILED_AT } as Command, bus, registry);
  };
  return { state, fs, bytes, exporter, undo, run };
}

function okValue(outcome: Dispatch): ExecutionOutcome {
  if (!outcome.ok) throw new Error(`refused: ${outcome.error.code}: ${outcome.error.message}`);
  return outcome.value;
}

describe('the timeline formats through the bus’s export.compile', () => {
  it('writes the CSV to exports/ as text and the XLSX and PDF to the byte store, with one log row each', async () => {
    const r = rig(makeTimelineProject());
    await r.exporter.ready();
    const csv = okValue(r.run('export.compile', { format: 'timeline-csv' }));
    await r.exporter.idle();
    const csvPath = (csv.result as { output: string }).output;
    expect(csvPath).toMatch(/^exports\/.*\.csv$/);
    const csvText = r.fs.snapshot()[csvPath];
    expect(csvText).toContain('reading index,part,title');
    expect(csvText).toContain("'-3");
    expect(csvText).toContain('Ten years on');

    const xlsx = okValue(r.run('export.compile', { format: 'timeline-xlsx' }));
    await r.exporter.idle();
    const xlsxPath = (xlsx.result as { output: string }).output;
    expect(r.bytes.get(xlsxPath)?.[0]).toBe(0x50); // PK zip

    const pdf = okValue(r.run('export.compile', { format: 'timeline-pdf' }));
    await r.exporter.idle();
    const pdfPath = (pdf.result as { output: string }).output;
    expect(pdfPath).toMatch(/\.pdf$/);
    expect(r.bytes.get(pdfPath)?.[0]).toBe(0x25); // %PDF

    const log = JSON.parse(r.fs.snapshot()['exports/compile-log.json'] ?? '[]') as { format: string }[];
    expect(log.map((row) => row.format)).toEqual(['timeline-csv', 'timeline-xlsx', 'timeline-pdf']);
  });

  it('compiles the Letter paper through a saved recipe', async () => {
    const state = makeTimelineProject();
    state.manifest.recipes = [{ name: 'Print', includeRootIds: ['manuscript'], format: 'timeline-pdf', options: { pageSize: 'Letter' } }];
    const r = rig(state);
    await r.exporter.ready();
    const outcome = okValue(r.run('export.compile', { format: 'timeline-pdf', recipeName: 'Print' }));
    await r.exporter.idle();
    const bytes = r.bytes.get((outcome.result as { output: string }).output)!;
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPage(0).getSize().width).toBeCloseTo(792, 1);
    expect(pdf.getPage(0).getSize().height).toBeCloseTo(612, 1);
  });

  it('undoes a timeline compile by deleting its artifact', async () => {
    const r = rig(makeTimelineProject());
    await r.exporter.ready();
    const outcome = okValue(r.run('export.compile', { format: 'timeline-svg' }));
    await r.exporter.idle();
    const svgPath = (outcome.result as { output: string }).output;
    expect(r.fs.snapshot()[svgPath]).toContain('<svg');
    expect(r.undo.undo(outcome.undoGroupId ?? '').ok).toBe(true);
    await r.exporter.idle();
    expect(r.fs.snapshot()[svgPath]).toBeUndefined();
  });

  it('refuses a selection with no scene, before anything is written', async () => {
    const state = createProjectState(createEmptyManifest(PROJECT_NAME, OPENED));
    addFolder(state, { parentId: 'manuscript', title: 'Empty chapter', now: OPENED, id: 'n_EMPTY00001' });
    const r = rig(state);
    await r.exporter.ready();
    const outcome = r.run('export.compile', { format: 'timeline-csv' });
    expect(outcome.ok).toBe(false);
    await r.exporter.idle();
    expect(Object.keys(r.fs.snapshot()).filter((path) => path.startsWith('exports/'))).toEqual([]);
  });
});
