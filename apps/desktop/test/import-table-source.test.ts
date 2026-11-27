/** The CSV/TSV import on the shared preview (#288): delimiter and encoding reads, role mapping, codex rows and timeline scene metadata. */
import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_REGISTRY } from '@caotang/bus';
import { emptyCoherenceFile } from '@caotang/coherence';
import { createEmptyManifest, createProjectState } from '@caotang/store';

import { pinFormatLocale } from '../src/i18n/locale.js';
import { activateEnglish } from '../src/i18n/runtime.js';
import { PREVIEW_HELPERS } from '../src/import-preview/helpers.js';
import { NO_EDITS, NO_OVERRIDES, buildCommit, initialSettings, type CommitInput, type PreviewPlan, type PreviewSettings } from '../src/import-preview/model.js';
import { createReaderSession } from '../src/import-preview/reader-session.js';
import type { ReaderOpen, ReaderRead } from '../src/import-preview/reader-protocol.js';
import { tablePreviewSource } from '../src/import-preview/table-source.js';

class InProcessWorker {
  static reads = 0;
  private readonly handle = createReaderSession();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  constructor(_url: unknown, _options?: unknown) {}
  postMessage(message: { id: number } & (ReaderOpen | ReaderRead)): void {
    if (message.kind === 'read') InProcessWorker.reads += 1;
    void this.handle(message).then(
      (result) => this.onmessage?.({ data: { id: message.id, ok: true, result } }),
      (error: unknown) => this.onmessage?.({ data: { id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) } }),
    );
  }
  terminate(): void {}
}

beforeEach(() => {
  activateEnglish();
  pinFormatLocale('en-US');
  InProcessWorker.reads = 0;
  vi.stubGlobal('Worker', InProcessWorker);
});
afterEach(() => {
  activateEnglish();
  pinFormatLocale(undefined);
  vi.unstubAllGlobals();
});

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const settingsWith = (base: PreviewSettings, chips: Record<string, string>): PreviewSettings => ({ chips: { ...base.chips, ...chips }, options: { ...base.options } });

async function open(bytes: Uint8Array, fileName = 'table.csv') {
  const opened = tablePreviewSource(fileName, bytes);
  if (!opened.ok) throw new Error(opened.message);
  await opened.source.load?.(() => {}, new AbortController().signal);
  return opened.source;
}

function commitOf(plan: PreviewPlan, source: Awaited<ReturnType<typeof open>>, codexAnswers: CommitInput["codexAnswers"] = {}, edits: CommitInput["edits"] = NO_EDITS) {
  const input: CommitInput = {
    plan,
    edits,
    destination: 'manuscript',
    mapping: {},
    statuses: [],
    labels: [],
    statusAnswers: {},
    labelAnswers: {},
    codexRows: source.codexRows?.() ?? [],
    codexAnswers,
    codexHeld: [],
    pictures: [],
  };
  return buildCommit(input, PREVIEW_HELPERS);
}

function project(withCodex = false) {
  const state = createProjectState(createEmptyManifest('Fixture', new Date('2026-11-01T10:00:00Z')));
  if (withCodex) {
    state.manifest.codex = [
      { id: 'c_ADA0000001', name: 'Ada', aliases: [], type: 'character', description: '', includePolicy: 'detected', caseSensitive: false, exclude: [], attachments: [], keywords: [], origin: 'manual', sources: [], createdAt: '', updatedAt: '' },
      { id: 'c_BOB0000001', name: 'Bob', aliases: [], type: 'character', description: '', includePolicy: 'detected', caseSensitive: false, exclude: [], attachments: [], keywords: [], origin: 'manual', sources: [], createdAt: '', updatedAt: '' },
    ];
  }
  return { ...state, coherence: emptyCoherenceFile() };
}

describe('the CSV/TSV preview', () => {
  it('reads a semicolon CSV with quoted newlines and maps codex rows', async () => {
    const text = 'Name;Aliases;Type;Description;Tags\n"Ada";"A.;The Countess";person;"line one\nline two";math;inventor\n';
    const source = await open(bytesOf(text), 'codex.csv');
    const settings = initialSettings(source.chips(), source.options());
    await source.prepare?.(settings, new AbortController().signal);
    const grid = source.grid?.(settings);
    expect(grid?.columns.slice(0, 4).map((column) => column.value)).toEqual(['name', 'aliases', 'type', 'description']);
    expect(grid?.rows[0]?.[3]).toBe('line one\nline two');

    const plan = source.plan(settings, NO_OVERRIDES);
    expect(plan.tree[0]?.role).toBe('front');
    expect(plan.tree[0]?.place).toBe('research');
    const rows = source.codexRows?.() ?? [];
    expect(rows[0]).toMatchObject({ name: 'Ada', type: 'character', aliases: ['A.', 'The Countess'], keywords: ['math'] });
    expect(rows[0]?.page?.body).toContain('line one\nline two');

    const commit = commitOf(plan, source);
    expect(commit.params.codex?.entries[0]).toMatchObject({ name: 'Ada', type: 'character' });
    expect(commit.params.codex?.pages).toHaveLength(1);
  });


  it('words an unknown type as a keyword without contradicting the chosen mapping', async () => {
    const source = await open(bytesOf('Name,Type\nAda,Vampire\n'));
    const settings = initialSettings(source.chips(), source.options());
    await source.prepare?.(settings, new AbortController().signal);
    const plan = source.plan(settings, NO_OVERRIDES);
    const warning = plan.losses.map((loss) => loss.message).join('\n');
    expect(warning).toContain('kept as a keyword');
    expect(warning).not.toContain('imported as Other');
  });

  it("uses the writer's type mapping for a formula-guarded type value", async () => {
    const source = await open(bytesOf("Name,Type\nAda,'=character\n"));
    const initial = initialSettings(source.chips(), source.options());
    const settings = settingsWith(initial, { 'table-type-0': 'location' });
    await source.prepare?.(settings, new AbortController().signal);
    source.plan(settings, NO_OVERRIDES);
    expect(source.codexRows?.()[0]?.type).toBe('location');
  });

  it('keeps a text table whose first letters are PK on the delimited-text reader', async () => {
    const source = await open(bytesOf('PK,Description\nAda,First\n'), 'pk.csv');
    const settings = initialSettings(source.chips(), source.options());
    await source.prepare?.(settings, new AbortController().signal);
    expect(source.chips().some((chip) => chip.id === 'table-delimiter')).toBe(true);
    expect(source.grid?.(settings).rows).toEqual([['Ada', 'First']]);
  });

  it('reads UTF-16LE text and round-trips the timeline export into scene declarations', async () => {
    const csv = [
      'reading index,part,title,folder path,day,duration days,end day,day label,mode,pov,expected present,after,threads,open findings,picture ids,picture alt',
      '0,main,Opening,Part 1 / Chapter 1,\'-14,2,\'-12,,linear,Ada,"Ada, Bob",,Quest,,,',
      '1,main,Aftermath,Part 1 / Chapter 1,\'-12,1,\'-11,,linear,Bob,Bob,,Quest,,,',
    ].join('\n');
    const bytes = new Uint8Array([0xff, 0xfe, ...[...csv].flatMap((ch) => [ch.charCodeAt(0), 0])]);
    const source = await open(bytes, 'timeline.csv');
    const initial = initialSettings(source.chips(), source.options());
    const settings = settingsWith(initial, { 'table-mode': 'timeline' });
    await source.prepare?.(settings, new AbortController().signal);
    const grid = source.grid?.(settings);
    expect(grid?.columns.slice(0, 13).map((column) => column.value)).toEqual(['order', 'part', 'title', 'folder', 'start', 'duration', 'end', 'ignore', 'ignore', 'pov', 'participants', 'ignore', 'arc']);

    const plan = source.plan(settings, NO_OVERRIDES);
    const part = plan.tree[0];
    expect(part?.title).toBe('Part 1');
    const chapter = part?.children?.[0];
    expect(chapter?.title).toBe('Chapter 1');
    const first = chapter?.children?.[0];
    expect(first?.sceneMeta).toMatchObject({ dayOffset: -14, durationDays: 2, pov: 'Ada', expectedPresent: ['Ada', 'Bob'], mainStory: true });
    expect(first?.sceneMeta?.threads?.[0]?.payoff).toMatch(/^pending-node:scene-/);

    const commit = commitOf(plan, source, Object.fromEntries((source.codexRows?.() ?? []).map((row) => [row.id, { action: 'skip' as const }])));
    const scene = commit.params.nodes.find((node) => node.title === 'Opening');
    expect(scene?.sceneMeta).toMatchObject({ dayOffset: -14, durationDays: 2 });
    expect(scene?.sceneMeta?.threads?.[0]?.payoff).toMatch(/^pending:import:\d+$/);
    const validated = COMMAND_REGISTRY['binder.importTree'].descriptor.validate({ ...commit.params, pictures: [] }, project(true) as never);
    expect(validated.ok, validated.ok ? '' : validated.error.message).toBe(true);
    if (validated.ok) {
      const validatedScene = validated.value.nodes.find((node) => node.title === 'Opening');
      expect(validatedScene?.sceneMeta?.pov).toBe('c_ADA0000001');
      expect(validatedScene?.sceneMeta?.expectedPresent).toEqual(['c_ADA0000001', 'c_BOB0000001']);
    }
  });





  it('leaves scene metadata off rows that declare none, so a project without coherence can import them', async () => {
    const source = await open(bytesOf('Title,Body\nOnly scene,Text\n'));
    const initial = initialSettings(source.chips(), source.options());
    const settings = settingsWith(initial, { 'table-mode': 'timeline' });
    await source.prepare?.(settings, new AbortController().signal);
    const plan = source.plan(settings, NO_OVERRIDES);
    const scene = plan.tree[0]?.children?.[0];
    expect(scene?.sceneMeta).toBeUndefined();
    const commit = commitOf(plan, source);
    const { coherence: _coherence, ...withoutCoherence } = project(false);
    const validated = COMMAND_REGISTRY['binder.importTree'].descriptor.validate({ ...commit.params, pictures: [] }, withoutCoherence as never);
    expect(validated.ok, validated.ok ? '' : validated.error.message).toBe(true);
  });

  it('links scene declarations to a renamed imported codex row rather than the colliding held entry', async () => {
    const source = await open(bytesOf('Title,Start,POV,Body\nFirst,0,Ada,A\nPayoff,1,,B\n'));
    const initial = initialSettings(source.chips(), source.options());
    const settings = settingsWith(initial, { 'table-mode': 'timeline' });
    await source.prepare?.(settings, new AbortController().signal);
    const plan = source.plan(settings, NO_OVERRIDES);
    const row = source.codexRows?.().find((candidate) => candidate.name === 'Ada');
    expect(row).toBeDefined();
    const commit = commitOf(plan, source, { [row?.id ?? '']: { action: 'rename', name: 'Ada imported' } });
    const scene = commit.params.nodes.find((node) => node.title === 'First');
    expect(scene?.sceneMeta?.pov).toBe('Ada imported');
    const validated = COMMAND_REGISTRY['binder.importTree'].descriptor.validate({ ...commit.params, pictures: [] }, project(true) as never);
    expect(validated.ok, validated.ok ? '' : validated.error.message).toBe(true);
    if (validated.ok) expect(validated.value.nodes.find((node) => node.title === 'First')?.sceneMeta?.pov).toBe('pending:import:codex:0');
  });

  it('orders timeline preview blocks by the same reading order as the scenes', async () => {
    const source = await open(bytesOf('Title,Order,Body\nFile first,2,A\nFile second,1,B\n'));
    const initial = initialSettings(source.chips(), source.options());
    const settings = settingsWith(initial, { 'table-mode': 'timeline' });
    await source.prepare?.(settings, new AbortController().signal);
    const plan = source.plan(settings, NO_OVERRIDES);
    expect(plan.tree[0]?.children?.map((node) => node.title)).toEqual(['File second', 'File first']);
    expect(plan.blocks.map((block) => block.text)).toEqual(['B', 'A']);
  });

  it('chooses a plotline payoff from reading order rather than folder traversal', async () => {
    const csv = 'Title,Order,Folder,Arc,Body\nA,1,Part 1,Quest,a\nB,2,Part 2,,b\nC,3,Part 1,,c\n';
    const source = await open(bytesOf(csv));
    const initial = initialSettings(source.chips(), source.options());
    const settings = settingsWith(initial, { 'table-mode': 'timeline' });
    await source.prepare?.(settings, new AbortController().signal);
    const plan = source.plan(settings, NO_OVERRIDES);
    const first = plan.tree.find((node) => node.title === 'Part 1')?.children?.find((node) => node.title === 'A');
    expect(first?.sceneMeta?.threads?.[0]?.payoff).toBe('pending-node:scene-2');
  });

  it('keeps a thread payoff with its scene when another scene is excluded', async () => {
    const csv = 'Title,Start,Arc,Body\nFirst,0,Quest,A\nMiddle,1,,B\nPayoff,2,,C\n';
    const source = await open(bytesOf(csv));
    const initial = initialSettings(source.chips(), source.options());
    const settings = settingsWith(initial, { 'table-mode': 'timeline' });
    await source.prepare?.(settings, new AbortController().signal);
    const plan = source.plan(settings, NO_OVERRIDES);
    const commit = commitOf(plan, source, {}, { ...NO_EDITS, excluded: ['scene-1'] });
    const first = commit.params.nodes.find((node) => node.title === 'First');
    const payoffIndex = Number(first?.sceneMeta?.threads?.[0]?.payoff.slice('pending:import:'.length));
    expect(commit.params.nodes[payoffIndex]?.title).toBe('Payoff');
  });

  it('re-reads a previous parse setting instead of retaining every table parse', async () => {
    const source = await open(bytesOf('Title,Body\nA,B\n'));
    const initial = initialSettings(source.chips(), source.options());
    const comma = settingsWith(initial, { 'table-mode': 'timeline', 'table-delimiter': ',' });
    const semicolon = settingsWith(initial, { 'table-mode': 'timeline', 'table-delimiter': ';' });
    await source.prepare?.(comma, new AbortController().signal);
    await source.prepare?.(semicolon, new AbortController().signal);
    await source.prepare?.(comma, new AbortController().signal);
    expect(InProcessWorker.reads).toBe(4);
  });

  it('reads the UTF-16 Unicode text fixture', async () => {
    const bytes = new Uint8Array(Buffer.from(readFileSync('packages/import-table/test/fixtures/unicode-text.txt.base64', 'utf8').trim(), 'base64'));
    const source = await open(bytes, 'unicode-text.txt');
    const settings = initialSettings(source.chips(), source.options());
    await source.prepare?.(settings, new AbortController().signal);
    expect(source.grid?.(settings).rows[0]).toEqual(['Ada', 'Unicode text']);
  });

  it('anchors ISO calendar dates at the earliest dated row', async () => {
    const source = await open(bytesOf('Title,Start,Body\nFirst,2024-03-01,A\nSecond,2024-03-03,B\n'));
    const initial = initialSettings(source.chips(), source.options());
    const settings = settingsWith(initial, { 'table-mode': 'timeline' });
    await source.prepare?.(settings, new AbortController().signal);
    const plan = source.plan(settings, NO_OVERRIDES);
    const folder = plan.tree[0];
    expect(folder?.children?.map((row) => row.sceneMeta?.dayOffset)).toEqual([0, 2]);
  });

  it('keeps a long codex description as an excerpt plus the full research page', async () => {
    const long = 'x'.repeat(2100);
    const source = await open(bytesOf(`Name,Description\nAda,"${long}"\n`));
    const settings = initialSettings(source.chips(), source.options());
    source.plan(settings, NO_OVERRIDES);
    const row = source.codexRows?.()[0];
    expect([...(row?.description ?? '')]).toHaveLength(1998);
    expect(row?.description.endsWith('…')).toBe(true);
    expect(row?.page?.body).toContain(long);
  });
});

describe('the Excel workbook preview', () => {
  it('reads a workbook sheet, offers the worksheet picker and re-reads the chosen sheet', async () => {
    const { cell, xlsx } = await import('../../../packages/import-xlsx/test/fixtures/workbook.js');
    const book = xlsx([
      { name: 'Bible', rows: [
        [cell('A1', '0', 's'), cell('B1', '1', 's')],
        [cell('A2', '2', 's'), cell('B2', 'A cartographer', 'inlineStr')],
      ] },
      { name: 'Timeline', rows: [
        [cell('A1', '3', 's'), cell('B1', '4', 's')],
        [cell('A2', '5', 's'), cell('B2', 'The ferry came at noon.', 'inlineStr')],
      ] },
    ], { shared: ['Name', 'Description', 'Elena', 'Title', 'Summary', 'The Landing'] });
    const source = await open(book, 'table.xlsx');
    const firstSettings = initialSettings(source.chips(), source.options());
    expect(source.chips().some((chip) => chip.id === 'table-delimiter')).toBe(false);
    const worksheet = source.chips().find((chip) => chip.id === 'table-sheet');
    expect(worksheet?.options?.map((option) => option.value)).toEqual(['Bible', 'Timeline']);
    await source.prepare?.(firstSettings, new AbortController().signal);
    expect(source.grid?.(firstSettings).rows).toEqual([['Elena', 'A cartographer']]);

    const sheetSettings = settingsWith(firstSettings, { 'table-sheet': 'Timeline' });
    expect(source.prepared?.(sheetSettings)).toBe(false);
    await source.prepare?.(sheetSettings, new AbortController().signal);
    expect(source.prepared?.(sheetSettings)).toBe(true);
    expect(source.grid?.(sheetSettings).rows).toEqual([['The Landing', 'The ferry came at noon.']]);
  });
});
