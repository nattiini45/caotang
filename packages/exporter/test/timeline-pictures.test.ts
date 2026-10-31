/**
 * The pictures in the timeline exports (timeline.md §8, §9.1): the CSV and the spreadsheet list the ids and alt text of the pictures on
 * each scene, and the PDF draws them as thumbnails on the scene's bar only when the recipe's `timelinePictures` option asks. The PDF is
 * read back three ways: pdf.js paints the images, pdf-lib's own objects give each embedded image's size, and the decoded pixels of
 * a solid-colour picture say which picture it was.
 */

import { describe, expect, it, vi } from 'vitest';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument, PDFName, PDFRawStream, type PDFNumber } from 'pdf-lib';

import { emptyCoherenceFile, type CoherenceFile, type SceneMeta } from '@caotang/coherence';
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
import type { ProcessPicture, ReadAssetLink, ReadAssetRecord } from '@caotang/pictures';
import { addDocument, addFolder, createEmptyManifest, createProjectCommandRegistry, createProjectState, MemoryArtifactFs, type ProjectState } from '@caotang/store';

import { createExporter, timelineCsv, timelineTable, TIMELINE_COLUMNS, type ByteArtifacts, type ExporterService } from '../src/index.js';
import { processPictureInNode } from '../src/picture-process-node.js';
import { prepareThumbnail, timelinePicturesOf } from '../src/timeline-pictures.js';
import { COMPILED_AT, OPENED, PROJECT_NAME } from './fixture.js';
import { solidJpeg, solidPng } from './figure-fixtures.js';
import { readRows } from './xlsx-read.js';

vi.setConfig({ testTimeout: 60_000 });

const SCENE = {
  early: 'n_EARLY00001',
  landing: 'n_LANDING01',
  storm: 'n_STORM00001',
  plain: 'n_PLAIN00001',
  prologue: 'n_PROLOG0001',
  chapter: 'n_CHAPTER001',
} as const;

const PIC = {
  card: 'a_CARD000001',
  lamp: 'a_LAMP000001',
  big: 'a_BIGG000001',
  extra: 'a_EXTR000001',
  page: 'a_PAGE000001',
  gone: 'a_GONE000001',
  junk: 'a_JUNK000001',
  early: 'a_EARL000001',
  ghost: 'a_GHOS000001',
} as const;

/** The picture files: a red PNG, a blue JPEG, a large green PNG (shrunk to a thumbnail), and text that is no picture at all. */
const FILES: Readonly<Record<string, Uint8Array>> = {
  'assets/a_CARD000001.png': solidPng(40, 20, [200, 40, 40, 255]),
  'assets/a_LAMP000001.jpg': solidJpeg(30, 30, [40, 40, 200]),
  'assets/a_BIGG000001.png': solidPng(200, 100, [20, 200, 60, 255]),
  'assets/a_EXTR000001.png': solidPng(10, 10, [90, 90, 90, 255]),
  'assets/a_PAGE000001.png': solidPng(10, 10, [1, 2, 3, 255]),
  'assets/a_JUNK000001.png': new TextEncoder().encode('this is not a picture'),
  'assets/a_EARL000001.png': solidPng(12, 12, [250, 250, 0, 255]),
};

function record(id: string, file: string, extra: Partial<ReadAssetRecord> = {}): ReadAssetRecord {
  return { id, file, mime: file.endsWith('.jpg') ? 'image/jpeg' : 'image/png', sha256: id, bytes: 10, createdAt: OPENED.toISOString(), ...extra } as ReadAssetRecord;
}

let linkSerial = 0;
function link(assetId: string, nodeId: string, role: 'card' | 'reference' | 'source', order: number): ReadAssetLink {
  linkSerial += 1;
  return { id: `l_TL${String(linkSerial).padStart(8, '0')}`, assetId, target: { kind: 'node', nodeId }, role, order } as ReadAssetLink;
}

/**
 * A prologue scene at day −3, a landing with four pictures (a card, three references in the writer's order, and a source page that
 * is not a scene picture), a storm whose pictures are gone, unreadable or unrecorded, and a scene with none. Wide scenes, so every
 * bar has room for its pictures.
 */
function makeProject(): ProjectState {
  const state = createProjectState(createEmptyManifest(PROJECT_NAME, OPENED, { locale: 'en-US' }));
  addFolder(state, { parentId: 'manuscript', title: 'Prologue', now: OPENED, id: SCENE.prologue });
  addDocument(state, { parentId: SCENE.prologue, title: 'Before', body: 'Earlier.', now: OPENED, id: SCENE.early });
  addFolder(state, { parentId: 'manuscript', title: 'Chapter One', now: OPENED, id: SCENE.chapter });
  addDocument(state, { parentId: SCENE.chapter, title: 'The Landing', body: 'The ferry.', now: OPENED, id: SCENE.landing });
  addDocument(state, { parentId: SCENE.chapter, title: 'The Storm', body: 'Rain.', now: OPENED, id: SCENE.storm });
  addDocument(state, { parentId: SCENE.chapter, title: 'Quiet', body: 'Nothing.', now: OPENED, id: SCENE.plain });
  const sceneMeta: Record<string, SceneMeta> = {
    [SCENE.prologue]: { storyPart: 'prologue' },
    [SCENE.early]: { dayOffset: -3, durationDays: 3 },
    [SCENE.landing]: { dayOffset: 0, durationDays: 4 },
    [SCENE.storm]: { dayOffset: 6, durationDays: 4 },
    [SCENE.plain]: { dayOffset: 12, durationDays: 4 },
  };
  state.coherence = { ...emptyCoherenceFile(), sceneMeta } as CoherenceFile;
  state.manifest.assets = [
    record(PIC.card, 'a_CARD000001.png', { alt: 'A lantern on the pier', caption: 'The lantern' }),
    record(PIC.lamp, 'a_LAMP000001.jpg', { alt: 'Ignored: decorative', decorative: true }),
    record(PIC.big, 'a_BIGG000001.png', { caption: 'A green field' }),
    record(PIC.extra, 'a_EXTR000001.png', { alt: 'Grey square' }),
    record(PIC.page, 'a_PAGE000001.png', { alt: 'A scanned page' }),
    record(PIC.gone, 'a_GONE000001.png', { alt: '-Missing, with a comma' }),
    record(PIC.junk, 'a_JUNK000001.png', { alt: 'Not a picture' }),
    record(PIC.early, 'a_EARL000001.png', { alt: 'Yellow dawn' }),
  ] as ReadAssetRecord[];
  state.manifest.assetLinks = [
    // Written out of order on purpose: the card still leads, and the references follow in their own order.
    link(PIC.big, SCENE.landing, 'reference', 20),
    link(PIC.lamp, SCENE.landing, 'reference', 10),
    link(PIC.card, SCENE.landing, 'card', 30),
    link(PIC.extra, SCENE.landing, 'reference', 40),
    link(PIC.page, SCENE.landing, 'source', 50),
    link(PIC.gone, SCENE.storm, 'reference', 10),
    link(PIC.junk, SCENE.storm, 'reference', 20),
    link(PIC.ghost, SCENE.storm, 'reference', 30),
    link(PIC.early, SCENE.early, 'card', 10),
  ] as ReadAssetLink[];
  return state;
}

const INPUT = { includeRootIds: ['manuscript'] as const };

describe('the pictures a scene carries in the timeline', () => {
  it('lists the card first, then the references in order, leaves out a source page, and counts a placement with no record', () => {
    const held = timelinePicturesOf(makeProject(), [SCENE.landing, SCENE.storm, SCENE.plain]);
    expect(held.of(SCENE.landing).map((picture) => picture.assetId)).toEqual([PIC.card, PIC.lamp, PIC.big, PIC.extra]);
    expect(held.of(SCENE.storm).map((picture) => picture.assetId)).toEqual([PIC.gone, PIC.junk]);
    expect(held.of(SCENE.plain)).toEqual([]);
    expect(held.unrecorded).toBe(1);
  });

  it('gives a decorative picture an empty alt, and falls back from alt to caption', () => {
    const held = timelinePicturesOf(makeProject(), [SCENE.landing]);
    expect(held.of(SCENE.landing).map((picture) => picture.alt)).toEqual(['A lantern on the pier', '', 'A green field', 'Grey square']);
  });
});

describe('timeline-csv and timeline-xlsx: picture ids and alt text', () => {
  it('appends the two picture columns after every column the table already had', () => {
    expect([...TIMELINE_COLUMNS].slice(0, 14)).toEqual([
      'reading index',
      'part',
      'title',
      'folder path',
      'day',
      'duration days',
      'end day',
      'day label',
      'mode',
      'pov',
      'expected present',
      'after',
      'threads',
      'open findings',
    ]);
    expect([...TIMELINE_COLUMNS].slice(14)).toEqual(['picture ids', 'picture alt']);
  });

  it('writes each scene’s picture ids and the alt text in the same order, in canonical row order and with the negative day kept', () => {
    const table = timelineTable({ state: makeProject(), ...INPUT });
    expect(table.rows.map((row) => [row.title, row.day, row.pictureIds, row.pictureAlt])).toEqual([
      ['Before', -3, PIC.early, 'Yellow dawn'],
      ['The Landing', 0, `${PIC.card}, ${PIC.lamp}, ${PIC.big}, ${PIC.extra}`, 'A lantern on the pier |  | A green field | Grey square'],
      ['The Storm', 6, `${PIC.gone}, ${PIC.junk}`, "-Missing, with a comma | Not a picture"],
      ['Quiet', 12, '', ''],
    ]);
    const csv = timelineCsv(table);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(TIMELINE_COLUMNS.join(','));
    expect(lines[0]).toMatch(/,picture ids,picture alt$/);
    // A scene with pictures ends its row with the ids and the alt text; the comma in an alt is quoted and a leading `-` guarded.
    expect(lines[2]).toMatch(new RegExp(`,"${PIC.card}, ${PIC.lamp}, ${PIC.big}, ${PIC.extra}",A lantern on the pier \\|  \\| A green field \\| Grey square$`));
    expect(lines[3]).toContain(`"'-Missing, with a comma | Not a picture"`);
    expect(lines[1]).toContain(",'-3,");
    // A scene without any ends in two empty cells.
    expect(lines[4]).toMatch(/,,$/);
  });

  it('notes a placement whose picture has no record, and leaves it out of the columns', () => {
    const table = timelineTable({ state: makeProject(), ...INPUT });
    expect(table.notes.join('\n')).toContain('1 picture placement on scenes names a picture the project has no record of');
    expect(table.rows.some((row) => row.pictureIds.includes(PIC.ghost))).toBe(false);
  });

  it('is unchanged for a project with no pictures but for two empty cells on every row', () => {
    const state = makeProject();
    state.manifest.assets = [];
    state.manifest.assetLinks = [];
    const table = timelineTable({ state, ...INPUT });
    expect(table.notes.join('\n')).not.toContain('picture');
    for (const row of table.rows) {
      expect(row.pictureIds).toBe('');
      expect(row.pictureAlt).toBe('');
    }
  });

  it('writes the same two columns to the spreadsheet as text cells', async () => {
    const exporter = createExporter({ readState: () => makeProject(), artifacts: new MemoryArtifactFs(), clock: { now: () => COMPILED_AT } });
    const result = await exporter.compile({ includeRootIds: ['manuscript'] }, 'timeline-xlsx');
    const parts = unzipSync(new Uint8Array(await result.files[0]!.blob.arrayBuffer()));
    const rows = readRows(strFromU8(parts['xl/worksheets/sheet1.xml']!), TIMELINE_COLUMNS.length);
    expect(rows[0]!.slice(-2)).toEqual(['picture ids', 'picture alt']);
    expect(rows[2]![14]).toBe(`${PIC.card}, ${PIC.lamp}, ${PIC.big}, ${PIC.extra}`);
    expect(rows[2]![15]).toBe('A lantern on the pier |  | A green field | Grey square');
    expect(rows[1]![4]).toBe(-3);
  });
});

describe('prepareThumbnail: the stored bytes under the thumbnail profile', () => {
  const host = (process?: ProcessPicture): Parameters<typeof prepareThumbnail>[1] => ({ readAsset: async (path) => FILES[path] ?? null, process });

  it('passes a small PNG or JPEG through and shrinks a large one to 64 pixels', async () => {
    const small = await prepareThumbnail({ assetId: PIC.card, file: 'a_CARD000001.png', alt: '' }, host(processPictureInNode));
    expect(small).toMatchObject({ ok: true, mime: 'image/png' });
    const jpeg = await prepareThumbnail({ assetId: PIC.lamp, file: 'a_LAMP000001.jpg', alt: '' }, host(processPictureInNode));
    expect(jpeg).toMatchObject({ ok: true, mime: 'image/jpeg' });
    const big = await prepareThumbnail({ assetId: PIC.big, file: 'a_BIGG000001.png', alt: '' }, host(processPictureInNode));
    expect(big.ok).toBe(true);
    if (big.ok) {
      const pdf = await PDFDocument.create();
      const image = await pdf.embedPng(big.bytes);
      expect([image.width, image.height]).toEqual([64, 32]);
    }
  });

  it('gives a reason, never an exception, for bytes that are gone, are not a picture, or cannot be shrunk here', async () => {
    expect(await prepareThumbnail({ assetId: PIC.gone, file: 'a_GONE000001.png', alt: '' }, host(processPictureInNode))).toEqual({
      ok: false,
      reason: 'a_GONE000001.png is not in assets/',
    });
    expect(await prepareThumbnail({ assetId: PIC.junk, file: 'a_JUNK000001.png', alt: '' }, host(processPictureInNode))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('is not a PNG, JPEG or WebP picture'),
    });
    expect(await prepareThumbnail({ assetId: PIC.big, file: 'a_BIGG000001.png', alt: '' }, host())).toMatchObject({
      ok: false,
      reason: expect.stringContaining('needs shrinking'),
    });
    const failing: Parameters<typeof prepareThumbnail>[1] = {
      readAsset: async () => {
        throw new Error('disk gone');
      },
    };
    expect(await prepareThumbnail({ assetId: PIC.card, file: 'a_CARD000001.png', alt: '' }, failing)).toMatchObject({ ok: false, reason: expect.stringContaining('disk gone') });
  });
});

/* ------------------------------------------------------------------ *
 * The PDF, through the bus
 * ------------------------------------------------------------------ */

type Dispatch = Result<ExecutionOutcome, CommandError>;

interface Rig {
  readonly state: ProjectState;
  readonly fs: MemoryArtifactFs;
  readonly bytes: Map<string, Uint8Array>;
  readonly reads: string[];
  readonly exporter: ExporterService;
  readonly undo: UndoStore;
  readonly run: (name: Command['name'], params: Record<string, unknown>) => Dispatch;
}

let serial = 0;

function rig(state: ProjectState, options: { readonly process?: ProcessPicture | null; readonly readAsset?: boolean } = {}): Rig {
  const fs = new MemoryArtifactFs();
  const bytes = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const binding: ByteArtifacts = { writeBytes: async (path, data) => void bytes.set(path, data), removeBytes: async (path) => void bytes.delete(path) };
  const process = options.process === undefined ? processPictureInNode : options.process;
  const exporter = createExporter({
    readState: () => state,
    artifacts: fs,
    bytes: binding,
    clock: { now: () => COMPILED_AT },
    ...(options.readAsset === false
      ? {}
      : {
          readAsset: async (path: string) => {
            reads.push(path);
            return FILES[path] ?? null;
          },
        }),
    ...(process === null ? {} : { processPicture: process }),
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
    return execute({ id: `cmd_TP${String(serial).padStart(6, '0')}`, name, params, issuedBy: 'user', createdAt: COMPILED_AT } as Command, bus, registry);
  };
  return { state, fs, bytes, reads, exporter, undo, run };
}

function okValue(outcome: Dispatch): ExecutionOutcome {
  if (!outcome.ok) throw new Error(`refused: ${outcome.error.code}: ${outcome.error.message}`);
  return outcome.value;
}

/** Saves a timeline-pdf recipe holding `options`, compiles it through `export.compile`, and returns the file and the log row's notes. */
async function compilePdf(r: Rig, options: Record<string, unknown> | undefined): Promise<{ readonly bytes: Uint8Array; readonly notes: readonly string[] }> {
  await r.exporter.ready();
  okValue(r.run('recipe.save', { name: 'Print', includeRootIds: ['manuscript'], format: 'timeline-pdf', ...(options === undefined ? {} : { options }) }));
  const outcome = okValue(r.run('export.compile', { format: 'timeline-pdf', recipeName: 'Print' }));
  await r.exporter.idle();
  const path = (outcome.result as { output: string }).output;
  const log = JSON.parse(r.fs.snapshot()['exports/compile-log.json'] ?? '[]') as { notes: string[] }[];
  return { bytes: r.bytes.get(path)!, notes: log[log.length - 1]?.notes ?? [] };
}

interface EmbeddedImage {
  readonly width: number;
  readonly height: number;
  readonly filter: string;
  readonly space: string;
  readonly contents: Uint8Array;
}

/** Every colour image XObject the PDF holds, as pdf-lib wrote it (the soft masks of a picture with alpha are not listed). */
async function imagesOf(bytes: Uint8Array): Promise<EmbeddedImage[]> {
  const pdf = await PDFDocument.load(bytes);
  const out: EmbeddedImage[] = [];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const dict = object.dict;
    if (dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    const space = String(dict.get(PDFName.of('ColorSpace')));
    if (space === '/DeviceGray') continue;
    out.push({
      width: (dict.get(PDFName.of('Width')) as PDFNumber).asNumber(),
      height: (dict.get(PDFName.of('Height')) as PDFNumber).asNumber(),
      filter: String(dict.get(PDFName.of('Filter'))),
      space,
      contents: object.contents,
    });
  }
  return out;
}

const firstPixel = (image: EmbeddedImage): number[] => [...inflateSync(image.contents).subarray(0, 3)];

interface Pdfjs {
  OPS: { paintImageXObject: number };
  getDocument(options: object): { promise: Promise<{ numPages: number; getPage(n: number): Promise<PdfjsPage> }> };
}
interface PdfjsPage {
  getTextContent(): Promise<{ items: { str?: string }[] }>;
  getOperatorList(): Promise<{ fnArray: number[] }>;
}

async function readWithPdfjs(bytes: Uint8Array): Promise<{ readonly text: string; readonly painted: number }> {
  const dir = join(process.cwd(), 'packages', 'exporter', 'node_modules', 'pdfjs-dist');
  const pdfjs = (await import(/* @vite-ignore */ pathToFileURL(join(dir, 'legacy', 'build', 'pdf.mjs')).href)) as Pdfjs;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, standardFontDataUrl: `${join(dir, 'standard_fonts')}/`, useSystemFonts: false }).promise;
  const text: string[] = [];
  let painted = 0;
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number);
    text.push((await page.getTextContent()).items.map((item) => item.str ?? '').join(' '));
    painted += (await page.getOperatorList()).fnArray.filter((op) => op === pdfjs.OPS.paintImageXObject).length;
  }
  return { text: text.join(' '), painted };
}

describe('timeline-pdf: thumbnails only when the recipe asks', () => {
  it('draws no picture, reads no file and writes the same bytes with the option absent or false', async () => {
    const absent = await compilePdf(rig(makeProject()), undefined);
    const noOptions = await compilePdf(rig(makeProject()), { pageSize: 'A4' });
    const offRig = rig(makeProject());
    const off = await compilePdf(offRig, { timelinePictures: false });
    expect(offRig.reads).toEqual([]);
    expect(await imagesOf(absent.bytes)).toEqual([]);
    expect((await readWithPdfjs(absent.bytes)).painted).toBe(0);
    expect(Buffer.from(noOptions.bytes).equals(Buffer.from(absent.bytes))).toBe(true);
    expect(Buffer.from(off.bytes).equals(Buffer.from(absent.bytes))).toBe(true);
    expect(absent.notes.join('\n')).not.toContain('timeline PDF');
  });

  it('embeds the card, reference and shrunk pictures as images, with a "+N" for the rest, when the recipe turns it on', async () => {
    const r = rig(makeProject());
    const on = await compilePdf(r, { timelinePictures: true });
    const images = await imagesOf(on.bytes);
    // The prologue's yellow dawn, then the landing's first three: the red card, the blue reference, the green one shrunk to 64 × 32.
    const sizes = images.map((image) => [image.width, image.height, image.filter, image.space]);
    expect(sizes).toContainEqual([40, 20, '/FlateDecode', '/DeviceRGB']);
    expect(sizes).toContainEqual([30, 30, '/DCTDecode', '/DeviceRGB']);
    expect(sizes).toContainEqual([64, 32, '/FlateDecode', '/DeviceRGB']);
    expect(sizes).toContainEqual([12, 12, '/FlateDecode', '/DeviceRGB']);
    expect(images).toHaveLength(4);
    const pixels = (width: number): number[] => firstPixel(images.find((image) => image.width === width && image.filter === '/FlateDecode')!);
    expect(pixels(40)).toEqual([200, 40, 40]);
    expect(pixels(64)).toEqual([20, 200, 60]);
    expect(pixels(12)).toEqual([250, 250, 0]);
    const blue = images.find((image) => image.filter === '/DCTDecode')!;
    expect([blue.contents[0], blue.contents[1]]).toEqual([0xff, 0xd8]);
    // The fourth picture of the landing is not drawn; the bar says so, and the source page is never read.
    const shown = await readWithPdfjs(on.bytes);
    expect(shown.painted).toBe(4);
    expect(shown.text).toContain('+1');
    expect(r.reads).not.toContain('assets/a_EXTR000001.png');
    expect(r.reads).not.toContain('assets/a_PAGE000001.png');
  });

  it('draws an empty frame, and says why in the compile log, for a picture that is gone, is not a picture or has no record', async () => {
    const r = rig(makeProject());
    const on = await compilePdf(r, { timelinePictures: true });
    const notes = on.notes.join('\n');
    expect(notes).toContain('timeline PDF: a_GONE000001.png is not in assets/, so its thumbnail is an empty frame');
    expect(notes).toContain('timeline PDF: a_JUNK000001.png is not a PNG, JPEG or WebP picture, so its thumbnail is an empty frame');
    expect(notes).toContain('1 picture placement on scenes names a picture the project has no record of, so it has no thumbnail');
    // The rest of the file is still drawn: every scene's title is on the page and the four real pictures are painted.
    const shown = await readWithPdfjs(on.bytes);
    expect(shown.text).toContain('The Storm');
    expect(shown.painted).toBe(4);
    // Each missing file is named once, however it is drawn.
    expect(notes.match(/a_GONE000001\.png is not in assets/g)).toHaveLength(1);
  });

  it('leaves a picture it cannot shrink as a frame when the host has no converter, never embedding it whole', async () => {
    const r = rig(makeProject(), { process: null });
    const on = await compilePdf(r, { timelinePictures: true });
    expect(on.notes.join('\n')).toContain('timeline PDF: a_BIGG000001.png needs shrinking to a thumbnail, which this compile cannot do');
    const images = await imagesOf(on.bytes);
    expect(images.some((image) => image.width === 200)).toBe(false);
    expect(images.some((image) => image.width === 64)).toBe(false);
    expect(images).toHaveLength(3);
  });

  it('draws a frame for every picture when the exporter’s own folder holds none of the files', async () => {
    const r = rig(makeProject(), { readAsset: false });
    await r.exporter.ready();
    okValue(r.run('recipe.save', { name: 'Print', includeRootIds: ['manuscript'], format: 'timeline-pdf', options: { timelinePictures: true } }));
    const outcome = okValue(r.run('export.compile', { format: 'timeline-pdf', recipeName: 'Print' }));
    await r.exporter.idle();
    const bytes = r.bytes.get((outcome.result as { output: string }).output)!;
    // With no store given, the exporter still reads `assets/` from its artifact folder, which holds nothing here: every picture is a frame.
    expect(await imagesOf(bytes)).toEqual([]);
  });

  it('leaves the pictures out, with a note, when the bars are too narrow to carry one', async () => {
    const state = makeProject();
    // Two days over a wide axis: each bar is a few points wide.
    (state.coherence as CoherenceFile).sceneMeta[SCENE.landing] = { dayOffset: 0, durationDays: 1 };
    (state.coherence as CoherenceFile).sceneMeta[SCENE.plain] = { dayOffset: 900 };
    const on = await compilePdf(rig(state), { timelinePictures: true });
    expect(on.notes.join('\n')).toMatch(/too narrow at this scale to show one|too close together/);
  });

  it('mirrors the picture strip to the other end of the bar in a right-to-left book', async () => {
    const ltr = rig(makeProject());
    const rtlState = makeProject();
    rtlState.manifest.project.language = 'he';
    const rtl = rig(rtlState);
    const a = await compilePdf(ltr, { timelinePictures: true });
    const b = await compilePdf(rtl, { timelinePictures: true });
    expect((await imagesOf(a.bytes)).map((image) => image.width).sort()).toEqual((await imagesOf(b.bytes)).map((image) => image.width).sort());
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(false);
  });
});

describe('the timelinePictures recipe option', () => {
  it('is saved on the recipe as a boolean and refuses anything else before it is stored', async () => {
    const r = rig(makeProject());
    await r.exporter.ready();
    okValue(r.run('recipe.save', { name: 'Pictures', includeRootIds: ['manuscript'], format: 'timeline-pdf', options: { timelinePictures: true } }));
    expect(r.state.manifest.recipes?.find((recipe) => recipe.name === 'Pictures')?.options).toEqual({ timelinePictures: true });
    const refused = r.run('recipe.save', { name: 'Odd', includeRootIds: ['manuscript'], format: 'timeline-pdf', options: { timelinePictures: 'yes' } });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain('params.options.timelinePictures must be true or false');
    expect(r.state.manifest.recipes?.some((recipe) => recipe.name === 'Odd')).toBe(false);
  });

  it('comes back when a replaced recipe is undone', async () => {
    const r = rig(makeProject());
    await r.exporter.ready();
    okValue(r.run('recipe.save', { name: 'Pictures', includeRootIds: ['manuscript'], format: 'timeline-pdf', options: { timelinePictures: true } }));
    const replaced = okValue(r.run('recipe.save', { name: 'Pictures', includeRootIds: ['manuscript'], format: 'timeline-pdf', options: { timelinePictures: false } }));
    expect(r.state.manifest.recipes?.find((recipe) => recipe.name === 'Pictures')?.options).toEqual({ timelinePictures: false });
    expect(r.undo.undo(replaced.undoGroupId ?? '').ok).toBe(true);
    expect(r.state.manifest.recipes?.find((recipe) => recipe.name === 'Pictures')?.options).toEqual({ timelinePictures: true });
  });
});
