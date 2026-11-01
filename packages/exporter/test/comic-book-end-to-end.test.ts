/**
 * A comic book made only through the command bus, compiled to a PDF and read back: the whole chain a writer's click takes.
 * The commands write the manifest (`comic.createBook`, `comic.setPage`), a saved recipe carries the print options (`recipe.save`), the
 * compile selects the book through `export.compileSelection`, and the file the byte store received is opened as a PDF and measured.
 * The page drawing is render-comic-pdf.test.ts's; what this pins is that what the commands wrote is what the PDF shows, and that a
 * recipe's `bleed` and `cropMarks` reach the page size while the reading direction stays the book's own.
 */

import { describe, expect, it, vi } from 'vitest';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
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
import { createProjectCommandRegistry, MemoryArtifactFs, type ProjectState } from '@caotang/store';
import { loadComicLetteringFontInNode } from '@caotang/pdf-fonts/node-loader';
import { createExporter, type ByteArtifacts, type ExporterService } from '../src/index.js';
import { COMPILED_AT } from './fixture.js';
import { ASSET_FILE, ASSET_ID, ASSETS, makeMediaProject } from './media-fixture.js';
import { PNG_1X1 } from './epub-fixtures.js';

vi.setConfig({ testTimeout: 30_000 });

type Dispatch = Result<ExecutionOutcome, CommandError>;

interface Rig {
  readonly state: ProjectState;
  readonly exporter: ExporterService;
  readonly bytes: Map<string, Uint8Array>;
  readonly undo: UndoStore;
  readonly run: (name: Command['name'], params: Record<string, unknown>) => Dispatch;
}

let serial = 0;

function rig(): Rig {
  const state = makeMediaProject();
  state.manifest.assets = [
    { id: ASSET_ID, file: ASSET_FILE, mime: 'image/png', sha256: 'a'.repeat(64), bytes: PNG_1X1.length, createdAt: '2026-10-02T15:00:00.000Z' },
  ];
  const clock = { now: () => COMPILED_AT };
  const bytes = new Map<string, Uint8Array>();
  const binding: ByteArtifacts = { writeBytes: async (path, data) => void bytes.set(path, data), removeBytes: async (path) => void bytes.delete(path) };
  const exporter = createExporter({
    readState: () => state,
    artifacts: new MemoryArtifactFs(),
    bytes: binding,
    clock,
    metadata: () => ({ author: 'Ada Lovelace' }),
    assets: () => ASSETS,
    readAsset: async (path) => (path === `assets/${ASSET_FILE}` ? PNG_1X1 : null),
    loadComicFont: loadComicLetteringFontInNode,
  });
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
  const run = (name: Command['name'], params: Record<string, unknown>): Dispatch => {
    serial += 1;
    return execute({ id: `cmd_COMICE2E${String(serial).padStart(5, '0')}`, name, params, issuedBy: 'user', createdAt: COMPILED_AT } as Command, bus, registry);
  };
  return { state, exporter, bytes, undo, run };
}

function okValue(outcome: Dispatch): ExecutionOutcome {
  if (!outcome.ok) throw new Error(`refused: ${outcome.error.code}: ${outcome.error.message}`);
  return outcome.value;
}

/** The trim size of a US comic page, in points (6.625 x 10.25 in). */
const TRIM = { width: 6.625 * 72, height: 10.25 * 72 };

async function book(r: Rig, settings: Record<string, unknown>): Promise<{ bookId: string; pages: string[] }> {
  const made = okValue(r.run('comic.createBook', { parentId: 'manuscript', title: 'Night Ferry', settings, pages: 2 })).result as {
    nodeId: string;
    pageIds: string[];
  };
  const first = r.state.manifest.tree.find((node) => node.id === made.pageIds[0])!;
  const page = structuredClone(first.comicPage!);
  const panels = page['panels'] as Record<string, unknown>[];
  panels[0] = { ...panels[0], assetId: ASSET_ID, balloons: [{ id: 'bl_8M2QX7K4A1', kind: 'speech', text: 'Where were you?', rect: [0.05, 0.05, 0.3, 0.1] }] };
  okValue(r.run('comic.setPage', { nodeId: made.pageIds[0], stored: page, expect: first.comicPage }));
  return { bookId: made.nodeId, pages: made.pageIds };
}

async function compile(r: Rig, bookId: string, recipeName?: string): Promise<PDFDocument> {
  await r.exporter.ready();
  const outcome = okValue(
    r.run('export.compileSelection', { includeRootIds: [bookId], format: 'comic-pdf', ...(recipeName === undefined ? {} : { recipeName }) }),
  );
  await r.exporter.idle();
  expect(r.exporter.failures()).toEqual([]);
  const output = (outcome.result as { output: string }).output;
  const written = r.bytes.get(output);
  expect(written, output).toBeDefined();
  return PDFDocument.load(written as Uint8Array);
}

describe('a comic book made by commands and compiled to a PDF', () => {
  it('writes one PDF page per page of the book, at trim plus the default bleed, with the picture on the first', async () => {
    const r = rig();
    const { bookId } = await book(r, { pageSize: 'us-comic' });
    const pdf = await compile(r, bookId);

    expect(pdf.getPageCount()).toBe(2);
    expect(pdf.getTitle()).toBe('Night Ferry');
    const size = pdf.getPage(0).getSize();
    expect(size.width).toBeGreaterThan(TRIM.width);
    expect(size.height).toBeGreaterThan(TRIM.height);
    const images = pdf.context.enumerateIndirectObjects().filter(([, object]) => String((object as { dict?: PDFDict }).dict?.get(PDFName.of('Subtype'))) === '/Image');
    expect(images.length).toBeGreaterThanOrEqual(1);
  });

  it('takes the reading direction from the book, not from a recipe', async () => {
    const r = rig();
    const { bookId } = await book(r, { readingDirection: 'rtl', pageSize: 'us-comic' });
    const pdf = await compile(r, bookId);
    const prefs = pdf.catalog.lookup(PDFName.of('ViewerPreferences'), PDFDict);
    expect(prefs.get(PDFName.of('Direction'))).toBe(PDFName.of('R2L'));

    okValue(r.run('recipe.save', { name: 'Print', includeRootIds: [bookId], format: 'comic-pdf', options: { bleed: false } }));
    const printed = await compile(r, bookId, 'Print');
    expect(printed.catalog.lookup(PDFName.of('ViewerPreferences'), PDFDict).get(PDFName.of('Direction'))).toBe(PDFName.of('R2L'));
  });

  it('carries a recipe\'s bleed and crop marks to the page: no bleed is the trim, marks make it larger', async () => {
    const r = rig();
    const { bookId } = await book(r, { pageSize: 'us-comic' });
    const withBleed = (await compile(r, bookId)).getPage(0).getSize();

    okValue(r.run('recipe.save', { name: 'Flat', includeRootIds: [bookId], format: 'comic-pdf', options: { bleed: false } }));
    const flat = (await compile(r, bookId, 'Flat')).getPage(0).getSize();
    expect(flat.width).toBeCloseTo(TRIM.width, 1);
    expect(flat.height).toBeCloseTo(TRIM.height, 1);
    expect(withBleed.width).toBeGreaterThan(flat.width);

    okValue(r.run('recipe.save', { name: 'Marked', includeRootIds: [bookId], format: 'comic-pdf', options: { bleed: true, cropMarks: true } }));
    const marked = (await compile(r, bookId, 'Marked')).getPage(0).getSize();
    expect(marked.width).toBeGreaterThan(withBleed.width);
    expect(r.state.manifest.recipes?.find((recipe) => recipe.name === 'Marked')?.options).toMatchObject({ bleed: true, cropMarks: true });
  });

  it('refuses a recipe that names a reading direction, because the book owns it', () => {
    const r = rig();
    const refused = r.run('recipe.save', { name: 'Backwards', includeRootIds: ['manuscript'], format: 'comic-pdf', options: { readingDirection: 'rtl' } });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain('readingDirection');
  });

  it('is undone to the project as it was, files included', async () => {
    const r = rig();
    const { bookId } = await book(r, {});
    await r.exporter.ready();
    const outcome = okValue(r.run('export.compileSelection', { includeRootIds: [bookId], format: 'comic-pdf' }));
    await r.exporter.idle();
    const output = (outcome.result as { output: string }).output;
    expect(r.bytes.has(output)).toBe(true);
    r.undo.undo(outcome.undoGroupId ?? '');
    await r.exporter.idle();
    expect(r.bytes.has(output)).toBe(false);
  });
});
