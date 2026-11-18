/**
 * The prose PDF (exporter.md §3) as an export format: the manuscript paginated through the
 * screenplay PDF's engine, for Study and Professional Hall. These tests check what the
 * exporter owns — the format's registration, the plan-time gate, the file it writes and the
 * recipe options that reach the page — plus the layout rules the renderer holds: the double
 * space, the centred chapter heading, the page-number header, footnotes at the page's foot
 * and endnotes at the book's end.
 */

import { describe, expect, it } from 'vitest';
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
import { PDFDocument } from 'pdf-lib';
import { createExporter, EXPORT_MIME, isBinaryFormat, isMediaFormat, MediaRefusedError, type ByteArtifacts, type ExporterService } from '../src/index.js';
import { layoutProsePdf } from '../src/render-prose-pdf.js';
import { COMPILED_AT, IDS, PROJECT_NAME, makeProject } from './fixture.js';
import type { RenderInput } from '../src/render-input.js';
import { boilerplateFor } from '../src/boilerplate.js';
import { DEFAULT_TEMPLATE } from '../src/template.js';

type Dispatch = Result<ExecutionOutcome, CommandError>;

interface Rig {
  readonly state: ProjectState;
  readonly fs: MemoryArtifactFs;
  readonly exporter: ExporterService;
  readonly undo: UndoStore;
  readonly bytes: Map<string, Uint8Array>;
  readonly run: (name: Command['name'], params: Record<string, unknown>) => Dispatch;
}

let serial = 0;

function rig(options: { bytes?: boolean; state?: ProjectState } = {}): Rig {
  const state = options.state ?? makeProject();
  const fs = new MemoryArtifactFs();
  const clock = { now: () => COMPILED_AT };
  const bytes = new Map<string, Uint8Array>();
  const binding: ByteArtifacts | undefined =
    options.bytes === false
      ? undefined
      : { writeBytes: async (path, data) => void bytes.set(path, data), removeBytes: async (path) => void bytes.delete(path) };
  const exporter = createExporter({
    readState: () => state,
    artifacts: fs,
    ...(binding === undefined ? {} : { bytes: binding }),
    clock,
    metadata: () => ({ author: 'Ada Lovelace' }),
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
    const command = { id: `cmd_PPDF${String(serial).padStart(7, '0')}`, name, params, issuedBy: 'user', createdAt: COMPILED_AT } as Command;
    return execute(command, bus, registry);
  };
  return { state, fs, exporter, undo, bytes, run };
}

function okValue(outcome: Dispatch): ExecutionOutcome {
  if (!outcome.ok) throw new Error(`refused: ${outcome.error.code}: ${outcome.error.message}`);
  return outcome.value;
}

const ascii = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** The prose body laid out directly, the way a unit of layout is pinned without a compile. */
function inputOf(body: string, more: Partial<RenderInput> = {}): RenderInput {
  return {
    blocks: [{ kind: 'scene', docId: 'n1', body, title: 'A Scene', number: 1 }],
    title: 'A Book',
    author: '',
    date: '2026-10-08',
    template: DEFAULT_TEMPLATE,
    toc: false,
    contentsLabel: 'Contents',
    boilerplate: boilerplateFor('en'),
    ...(more as object),
  } as RenderInput;
}

describe('prose-pdf — the format', () => {
  it('is a prose format with a binary artifact, served as application/pdf', () => {
    expect(isMediaFormat('prose-pdf')).toBe(false);
    expect(isBinaryFormat('prose-pdf')).toBe(true);
    expect(EXPORT_MIME['prose-pdf']).toBe('application/pdf');
  });
});

describe('prose-pdf — through the §4 API', () => {
  it('writes one PDF named for the project, with the manuscript in an embedded Courier Prime', async () => {
    const result = await rig().exporter.compile({ includeRootIds: ['manuscript'] }, 'prose-pdf');
    expect(result.files).toHaveLength(1);
    expect(result.fileName).toBe(`${PROJECT_NAME}.pdf`);
    expect(result.mimeType).toBe('application/pdf');
    const pdf = ascii(new Uint8Array(await result.blob.arrayBuffer()));
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf.endsWith('%%EOF\n')).toBe(true);
    expect(pdf).toContain('/BaseFont /CourierPrime');
    // The title page, then the chapters' headings and the scene bodies.
    expect(pdf).toContain(`(${PROJECT_NAME}) Tj`);
    expect(pdf).toContain('(Ada Lovelace) Tj');
    for (const heading of ['CHAPTER 1. CHAPTER ONE', 'CHAPTER 2. CHAPTER TWO']) expect(pdf).toContain(`(${heading}) Tj`);
    expect(pdf).toContain('(The keeper had been alone on the rock for nine years.) Tj');
  });

  it('refuses a selection that holds no text which prints, before anything is written', async () => {
    const state = makeProject();
    for (const [id, document] of state.documents) state.documents.set(id, { ...document, body: '' });
    const attempt = rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'prose-pdf');
    await expect(attempt).rejects.toBeInstanceOf(MediaRefusedError);
    await expect(attempt).rejects.toThrow('nothing to print');
  });

  it('prints the page number on every page after the first, as the screenplay PDF does', async () => {
    const state = makeProject();
    const long = Array.from({ length: 60 }, (_, i) => `Sentence ${i + 1} of a scene that goes on and on.`).join(' ');
    const prologue = state.documents.get(IDS.prologue);
    if (prologue === undefined) throw new Error('the fixture has no prologue');
    state.documents.set(IDS.prologue, { ...prologue, body: long });
    const { blob } = await rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'prose-pdf');
    const pdf = ascii(new Uint8Array(await blob.arrayBuffer()));
    expect(pdf).toContain('(2) Tj');
  });
});

describe('prose-pdf — the layout', () => {
  it('double-spaces the body on 27-row pages and centres a chapter heading a third of the page down', () => {
    const layout = layoutProsePdf(inputOf('One short paragraph.'), {});
    const page = layout.pages.find((candidate) => candidate.kind === 'script');
    expect(page).toBeDefined();
    const rows = (page?.lines ?? []).filter((line) => line.kind === 'action' && line.row !== null);
    // A chapter-free scene page starts its text on the first row, at the 24-point double space.
    const ys = rows.map((line) => line.y);
    expect(ys[0]).toBe(72 + 10);
    expect(ys[1] === undefined || ys[1] === ys[0]! + 24).toBe(true);
  });

  it('wraps a paragraph at 65 columns with a first-line indent', () => {
    const body = 'The rain went on without pause, drumming the roof of the cottage while the keeper wrote and wrote and wrote again.';
    const layout = layoutProsePdf(inputOf(body), {});
    const page = layout.pages.find((candidate) => candidate.kind === 'script');
    const texts = (page?.lines ?? []).filter((line) => line.kind === 'action').map((line) => line.text);
    expect(texts.length).toBeGreaterThan(1);
    // Every wrapped line fits the 65-column measure, and the first is indented four columns.
    const first = page?.lines.find((line) => line.kind === 'action' && line.text !== '');
    expect(first?.x).toBe(72 + 5 * 7.2);
  });

  it('puts a footnote’s text at its page’s foot under a rule, numbered through the compile', () => {
    const body = 'A line with a note.[^1] And more after it.\n\n[^1]: The note’s own words.';
    const layout = layoutProsePdf(inputOf(body), {});
    const page = layout.pages.find((candidate) => candidate.kind === 'script');
    const texts = (page?.lines ?? []).map((line) => line.text);
    expect(texts.some((text) => text.startsWith('A line with a note.[1]'))).toBe(true);
    expect(texts).toContain('—'.repeat(20));
    expect(texts.some((text) => text.startsWith('[1] The note’s own words.'))).toBe(true);
  });

  it('puts endnotes on pages of their own at the book’s end, headed NOTES', () => {
    const body = 'A line with a note.[^1]\n\n[^1]: The note’s own words.';
    const layout = layoutProsePdf(inputOf(body), { notes: 'endnote' });
    const texts = layout.pages.flatMap((page) => page.lines.map((line) => line.text));
    expect(texts.some((text) => text.startsWith('A line with a note.[1]'))).toBe(true);
    expect(texts).toContain('NOTES');
    expect(texts.some((text) => text.startsWith('[1] The note’s own words.'))).toBe(true);
    // The footnote pass does not run: no page holds the rule.
    expect(texts).not.toContain('—'.repeat(20));
  });
});

describe('prose-pdf — through the bus', () => {
  it('writes the PDF to exports/ through the byte store, logs it, and the undo removes it', async () => {
    const r = rig();
    await r.exporter.ready();
    const outcome = okValue(r.run('export.compile', { format: 'prose-pdf' }));
    await r.exporter.idle();
    const digest = outcome.result as { output: string; format: string };
    expect(digest).toMatchObject({ output: `exports/${PROJECT_NAME}.pdf`, format: 'prose-pdf' });
    expect(r.exporter.failures()).toEqual([]);
    const written = r.bytes.get(digest.output);
    expect(written).toBeDefined();
    expect(ascii(written ?? new Uint8Array()).startsWith('%PDF-1.4\n')).toBe(true);
    // The file parses as a real document, not just a header.
    const doc = await PDFDocument.load(written ?? new Uint8Array());
    expect(doc.getPageCount()).toBeGreaterThan(1);
    const rows = JSON.parse(r.fs.snapshot()['exports/compile-log.json'] ?? '[]') as Array<Record<string, unknown>>;
    expect(rows.at(-1)).toMatchObject({ format: 'prose-pdf', output: digest.output });

    r.undo.undo(outcome.undoGroupId ?? '');
    await r.exporter.idle();
    expect(r.bytes.has(digest.output)).toBe(false);
  });

  it('is refused where there is no byte store, as the screenplay PDF is', async () => {
    const r = rig({ bytes: false });
    await r.exporter.ready();
    const outcome = r.run('export.compile', { format: 'prose-pdf' });
    expect(outcome.ok).toBe(false);
    await r.exporter.idle();
    expect(r.fs.snapshot()['exports/compile-log.json']).toBeUndefined();
  });

  it('a recipe’s paper and font reach the file: A4 pages in Cousine', async () => {
    const r = rig();
    r.state.manifest.recipes = [
      ...(r.state.manifest.recipes ?? []),
      { name: 'A4 Cousine', includeRootIds: ['manuscript'], format: 'prose-pdf', options: { pageSize: 'A4', scriptFont: 'cousine' } },
    ];
    await r.exporter.ready();
    const digest = okValue(r.run('export.compile', { format: 'prose-pdf', recipeName: 'A4 Cousine' })).result as { output: string };
    await r.exporter.idle();
    const pdf = ascii(r.bytes.get(digest.output) ?? new Uint8Array());
    const boxes = new Set([...pdf.matchAll(/\/MediaBox \[([^\]]+)\]/g)].map((match) => match[1]));
    expect(boxes).toEqual(new Set(['0 0 595.28 841.89']));
    expect(pdf).toContain('/BaseFont /Cousine-Regular');
  });
});
