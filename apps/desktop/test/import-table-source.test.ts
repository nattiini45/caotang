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
  private readonly handle = createReaderSession();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  constructor(_url: unknown, _options?: unknown) {}
  postMessage(message: { id: number } & (ReaderOpen | ReaderRead)): void {
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

function commitOf(plan: PreviewPlan, source: Awaited<ReturnType<typeof open>>, codexAnswers: CommitInput["codexAnswers"] = {}) {
  const input: CommitInput = {
    plan,
    edits: NO_EDITS,
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
    expect(first?.sceneMeta?.threads?.[0]?.payoff).toMatch(/^pending:import:/);

    const commit = commitOf(plan, source, Object.fromEntries((source.codexRows?.() ?? []).map((row) => [row.id, { action: 'skip' as const }])));
    const scene = commit.params.nodes.find((node) => node.title === 'Opening');
    expect(scene?.sceneMeta).toMatchObject({ dayOffset: -14, durationDays: 2 });
    const validated = COMMAND_REGISTRY['binder.importTree'].descriptor.validate({ ...commit.params, pictures: [] }, project(true) as never);
    expect(validated.ok, validated.ok ? '' : validated.error.message).toBe(true);
    if (validated.ok) {
      const validatedScene = validated.value.nodes.find((node) => node.title === 'Opening');
      expect(validatedScene?.sceneMeta?.pov).toBe('c_ADA0000001');
      expect(validatedScene?.sceneMeta?.expectedPresent).toEqual(['c_ADA0000001', 'c_BOB0000001']);
    }
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
