/**
 * The TextBundle import on the shared preview (apps/desktop/src/import-preview/textbundle-source.ts, issue #282): a Bear `.bear2bk`
 * backup lands in Research with its dates kept as note lines, its tags as keywords or as folders by the writer's choice, and an iA
 * Writer project's Content Blocks come in in index order. The commit is the one `binder.importTree` the bus accepts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_REGISTRY } from '@caotang/bus';
import { createEmptyManifest, createProjectState } from '@caotang/store';

import { pinFormatLocale } from '../src/i18n/locale.js';
import { activateEnglish } from '../src/i18n/runtime.js';
import { PREVIEW_HELPERS } from '../src/import-preview/helpers.js';
import { NO_EDITS, NO_OVERRIDES, buildCommit, initialSettings, type CommitInput, type PreviewPlan, type PreviewSettings } from '../src/import-preview/model.js';
import { TEXTBUNDLE_CHIPS, textbundlePreviewSource } from '../src/import-preview/textbundle-source.js';
import { createReaderSession } from '../src/import-preview/reader-session.js';
import type { ReaderOpen, ReaderRead } from '../src/import-preview/reader-protocol.js';

/** The same reader session the real Worker runs, in process, so these tests exercise real reader output in Node. */
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

const bearInfo = (title: string, created: string): string =>
  JSON.stringify({ version: 2, creatorIdentifier: 'net.shinyfrog.bear', title, 'net.shinyfrog.bear': { creationDate: created, modificationDate: created } });

const BACKUP: Record<string, string> = {
  'Bear Notes/BBB.textbundle/info.json': bearInfo('The Lamp', '2024-05-02T10:00:00Z'),
  'Bear Notes/BBB.textbundle/text.md': 'She lit the lamp. #harbour/night\n',
  'Bear Notes/AAA.textbundle/info.json': bearInfo('The Landing', '2024-05-01T10:00:00Z'),
  'Bear Notes/AAA.textbundle/text.md': 'The ferry came. #sea\n',
  'Bear Notes/CCC.textbundle/info.json': bearInfo('A loose thought', '2024-05-03T10:00:00Z'),
  'Bear Notes/CCC.textbundle/text.md': 'No tags here.\n',
};

const PROJECT: Record<string, string> = {
  'Book.textbundle/info.json': JSON.stringify({ creatorIdentifier: 'pro.writer.mac', title: 'The Book' }),
  'Book.textbundle/text.md': ['/Chapter 2.md', '/data.csv', '/Chapter 1.md'].join('\n'),
  'Book.textbundle/Chapter 1.md': '# Chapter One\n\nThe ferry came.',
  'Book.textbundle/Chapter 2.md': '# Chapter Two\n\nThe letter arrived.',
  'Book.textbundle/data.csv': 'Name,Place\nAda,The Rock',
};

const filesOf = (files: Record<string, string>): { path: string; size: number; bytes: Uint8Array }[] =>
  Object.entries(files).map(([path, text]) => {
    const bytes = new TextEncoder().encode(text);
    return { path, size: bytes.length, bytes };
  });

async function open(files: Record<string, string>, fileName = 'notes.bear2bk') {
  const source = textbundlePreviewSource(fileName, filesOf(files));
  await source.load?.(() => {}, new AbortController().signal);
  return source;
}

function commitOf(plan: PreviewPlan): ReturnType<typeof buildCommit> {
  const input: CommitInput = {
    plan,
    edits: NO_EDITS,
    destination: 'manuscript',
    mapping: {},
    statuses: [],
    labels: [],
    statusAnswers: {},
    labelAnswers: {},
    codexRows: [],
    codexAnswers: {},
    codexHeld: [],
    pictures: [],
  };
  return buildCommit(input, PREVIEW_HELPERS);
}

const project = () => createProjectState(createEmptyManifest('Fixture', new Date('2026-11-01T10:00:00Z')), { now: new Date('2026-11-01T10:00:00Z') });

const withChip = (base: PreviewSettings, value: string): PreviewSettings => ({ ...base, chips: { ...base.chips, [TEXTBUNDLE_CHIPS.tags]: value } });

describe('a Bear backup in the preview', () => {
  it('proposes every note as a chapter, oldest first, and sends them to Research', async () => {
    const source = await open(BACKUP);
    const settings = initialSettings(source.chips(), source.options());
    const plan = source.plan(settings, NO_OVERRIDES);
    expect(plan.tree.map((node) => node.title)).toEqual(['The Landing', 'The Lamp', 'A loose thought']);
    expect(plan.tree.every((node) => node.place === 'research')).toBe(true);

    const commit = commitOf(plan);
    // Only top-level nodes carry `place`; a node inside a folder is already under it (the bus refuses place beside a parent).
    const top = commit.params.nodes.filter((node) => node.parent === undefined);
    expect(top).toHaveLength(3);
    expect(top.every((node) => node.place === 'research')).toBe(true);
    expect(commit.params.nodes.filter((node) => node.parent !== undefined).every((node) => node.place === undefined)).toBe(true);
    expect(COMMAND_REGISTRY['binder.importTree'].descriptor.validate({ ...commit.params, pictures: [] }, project() as never).ok).toBe(true);
  });

  it('keeps each note’s dates as a note line and says the project has no date field', async () => {
    const source = await open(BACKUP);
    const settings = initialSettings(source.chips(), source.options());
    const plan = source.plan(settings, NO_OVERRIDES);
    const notes = plan.tree.flatMap((node) => [node.notes ?? '', ...(node.children ?? []).map((child) => child.notes ?? '')]).join('\n');
    expect(notes).toContain('Created May 1, 2024');
    expect(notes).toContain('Modified May 1, 2024');
    const report = (source.report?.(plan) ?? []).flatMap((section) => section.lines).join(' ');
    expect(report).toContain('3 notes kept their Bear dates as note lines');
  });

  it('offers the tag choice, keeps keywords by default, and sorts into tag folders when asked', async () => {
    const source = await open(BACKUP);
    const chip = source.chips().find((entry) => entry.id === TEXTBUNDLE_CHIPS.tags);
    expect(chip?.options.map((option) => option.value)).toEqual(['keywords', 'folders']);
    const settings = initialSettings(source.chips(), source.options());
    expect(settings.chips[TEXTBUNDLE_CHIPS.tags]).toBe('keywords');

    const folders = withChip(settings, 'folders');
    // A plan choice, not a read choice: the document is already read for it.
    expect(source.prepared?.(folders)).toBe(true);
    const plan = source.plan(folders, NO_OVERRIDES);
    expect(plan.tree.map((node) => node.title)).toEqual(['sea', 'harbour', 'A loose thought']);
    expect(plan.tree[1]?.children?.map((node) => node.title)).toEqual(['night']);
    expect(plan.tree[1]?.children?.[0]?.children?.map((node) => node.title)).toEqual(['The Lamp']);
    // Sorted by tag, the notes go into the manuscript rather than Research.
    expect(plan.tree.every((node) => node.place === undefined)).toBe(true);
    const commit = commitOf(plan);
    expect(commit.params.nodes.some((node) => node.place === 'research')).toBe(false);
    expect(COMMAND_REGISTRY['binder.importTree'].descriptor.validate({ ...commit.params, pictures: [] }, project() as never).ok).toBe(true);
  });

  it('a tag folder spans the notes it holds', async () => {
    const source = await open(BACKUP);
    const settings = withChip(initialSettings(source.chips(), source.options()), 'folders');
    const plan = source.plan(settings, NO_OVERRIDES);
    const sea = plan.tree[0]!;
    const note = sea.children![0]!;
    expect(sea.startBlock).toBe(note.startBlock);
    expect(sea.endBlock).toBe(note.endBlock);
    expect(sea.words).toBe(note.words);
  });
});

describe('an iA Writer project in the preview', () => {
  it('shows the blocks in index order and names the CSV as an approximation', async () => {
    const source = await open(PROJECT, 'Book.textbundle');
    const settings = initialSettings(source.chips(), source.options());
    const plan = source.plan(settings, NO_OVERRIDES);
    const bodies = plan.tree.flatMap((node) => [node.body ?? '', ...(node.children ?? []).map((child) => child.body ?? '')]).join('\n');
    expect(bodies.indexOf('The letter arrived.')).toBeLessThan(bodies.indexOf('The ferry came.'));
    expect(bodies).toContain('Ada, The Rock');
    const report = (source.report?.(plan) ?? []).flatMap((section) => section.lines).join(' ');
    expect(report).toContain('2 iA Writer Content Blocks came in where the index lists them');
    expect(report).toContain('1 CSV file became paragraphs');
    // A project archive is a manuscript, not a note app's backup.
    expect(plan.tree.every((node) => node.place === undefined)).toBe(true);
    expect(source.chips().some((entry) => entry.id === TEXTBUNDLE_CHIPS.tags)).toBe(false);
  });
});
