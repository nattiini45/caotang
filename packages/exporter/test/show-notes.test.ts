/**
 * The AV script's reading formats (av-script.md §5): `show-notes`, `transcript-md` and `teleprompter` — the show's
 * description and the segments as a timestamped list, the spoken lines under each speaker's display name, and the
 * spoken text wrapped to the recipe's width. The show notes carry the YouTube-shaped chapter lines only when all
 * three gates hold, and the compile log names the gate that failed when they do not.
 */

import { describe, expect, it } from 'vitest';
import {
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectState,
  MemoryArtifactFs,
  type CodexEntry,
  type ProjectState,
} from '@caotang/store';
import { createExporter, type ExporterService } from '../src/index.js';
import { renderMedia } from '../src/media.js';
import { MediaRefusedError } from '../src/errors.js';
import { COMPILED_AT, PROJECT_NAME } from './fixture.js';

const OPENED = new Date(COMPILED_AT);

const SHOW_ID = 'n_SHOW000001';
const EPISODE_ID = 'n_EPISODE001';

/** Three timed segments — 0 s, 10 s and 41.6 s — so every YouTube gate holds. */
const EPISODE_BODY = [
  '# Episode 1',
  '',
  '## Cold open',
  'NARRATION: Previously, on the show. [0:10] <!-- lineId: sl_0K3M9T2Q7X -->',
  '',
  '## The interview',
  'HOST_A: Welcome back to the show today. [0:30] <!-- lineId: sl_1000000002 -->',
  'GUEST: We lit the lamp. <!-- lineId: sl_1000000003 -->',
  'A note for the editor, not to be read.',
  '',
  '## Outro',
  'HOST_A: See you next week.',
].join('\n');

function makeShowProject(options: { episode?: string; showMeta?: Record<string, unknown>; codex?: CodexEntry[] } = {}): ProjectState {
  const state = createProjectState(createEmptyManifest(PROJECT_NAME, OPENED, { locale: 'en-US' }));
  const show = addFolder(state, { parentId: 'manuscript', title: 'The Show', now: OPENED, id: SHOW_ID });
  Object.assign(show, { kind: 'show' });
  if (options.showMeta !== undefined) Object.assign(show, { showMeta: options.showMeta });
  const episode = addDocument(state, {
    parentId: SHOW_ID,
    title: 'Episode 1',
    body: options.episode ?? EPISODE_BODY,
    now: OPENED,
    id: EPISODE_ID,
  });
  Object.assign(episode, { kind: 'av-script' });
  for (const entry of options.codex ?? []) (state.manifest.codex ??= []).push(entry);
  return state;
}

function rig(options: { state?: ProjectState } = {}): { readonly exporter: ExporterService } {
  const state = options.state ?? makeShowProject();
  return {
    exporter: createExporter({
      readState: () => state,
      artifacts: new MemoryArtifactFs(),
      clock: { now: () => COMPILED_AT },
      metadata: () => ({ author: 'Ada Lovelace' }),
    }),
  };
}

async function textOf(state: ProjectState, format: 'show-notes' | 'transcript-md' | 'teleprompter'): Promise<string> {
  const result = await rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, format);
  return result.files[0]!.blob.text();
}

describe('multi-episode export filenames', () => {
  it.each(['show-notes', 'transcript-md', 'teleprompter', 'vtt', 'chapters-json'] as const)(
    'reserves portable, case-insensitively unique %s names after cleaning episode titles',
    async (format) => {
      const state = makeShowProject();
      for (const [i, title] of ['Arrival: Part 1', 'Arrival/Part 1', 'arrival Part 1'].entries()) {
        const episode = addDocument(state, { parentId: SHOW_ID, title, body: EPISODE_BODY, now: OPENED, id: `n_EPISODE00${i + 2}` });
        Object.assign(episode, { kind: 'av-script' });
      }
      const { exporter } = rig({ state });
      await exporter.ready();
      const { digest } = exporter.commandPort().compile(state, { selection: { kind: 'manuscript' }, format, at: COMPILED_AT });
      expect(digest.outputs?.every((path) => path.startsWith('exports/'))).toBe(true);
      const names = digest.outputs?.map((path) => path.slice('exports/'.length)) ?? [];
      expect(names).toHaveLength(4);
      expect(names.every((name) => !/[<>:"/\\|?*]/u.test(name))).toBe(true);
      expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(4);
      expect(names.filter((name) => name.toLowerCase().includes('arrival part 1'))).toHaveLength(3);
      expect((await exporter.settled(digest.jobId)).state.kind).toBe('written');
    },
  );
});

describe('show notes', () => {
  it('lists the segments with their timestamps, the show description first, then the YouTube chapter lines', async () => {
    const text = await textOf(makeShowProject({ showMeta: { description: 'A show about lamps.' } }), 'show-notes');
    expect(text).toBe(
      [
        '# Episode 1',
        '',
        'A show about lamps.',
        '',
        '- 00:00 Cold open',
        '- 00:10 The interview',
        '- 00:42 Outro',
        '',
        '## Chapters',
        '',
        '00:00 Cold open',
        '00:10 The interview',
        '00:42 Outro',
        '',
      ].join('\n'),
    );
  });

  it('names the gate that failed in the compile log and leaves the chapter lines out', async () => {
    // Two segments: the "at least three" gate fails.
    const state = makeShowProject({ episode: '## One\nHOST_A: Hi. [0:10] <!-- lineId: sl_1000000001 -->\n## Two\nHOST_A: Bye. [0:10] <!-- lineId: sl_1000000002 -->' });
    const result = await rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'show-notes');
    const text = await result.files[0]!.blob.text();
    expect(text).not.toContain('## Chapters');
    expect(result.log.notes.some((n) => n.includes('fewer than three chapters'))).toBe(true);
  });

  it('names the spacing gate when two segments are under ten seconds apart', async () => {
    const state = makeShowProject({
      episode: [
        '## One',
        'HOST_A: Hi. [0:05] <!-- lineId: sl_1000000001 -->',
        '## Two',
        'HOST_A: And. [0:10] <!-- lineId: sl_1000000002 -->',
        '## Three',
        'HOST_A: Bye. [0:10] <!-- lineId: sl_1000000003 -->',
      ].join('\n'),
    });
    const result = await rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'show-notes');
    expect(result.log.notes.some((n) => n.includes('under 10 s apart'))).toBe(true);
  });

  it('marks an untimed segment in the list and names it in the log', async () => {
    const state = makeShowProject({
      episode: [
        '## One',
        'HOST_A: Hi. [0:10] <!-- lineId: sl_1000000001 -->',
        '## Untimed middle',
        'A note for the editor.',
        '## Three',
        'HOST_A: Bye. [0:10] <!-- lineId: sl_1000000003 -->',
      ].join('\n'),
    });
    const result = await rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'show-notes');
    const text = await result.files[0]!.blob.text();
    expect(text).toContain('- (untimed) Untimed middle');
    expect(result.log.notes.some((n) => n.includes('untimed segments'))).toBe(true);
  });
});

describe('the transcript', () => {
  it('writes each speaker and the text, segment by segment, narration set apart — no cues or timings', async () => {
    const text = await textOf(makeShowProject(), 'transcript-md');
    expect(text).toBe(
      [
        '# Episode 1',
        '',
        '## Cold open',
        '',
        '_Previously, on the show._',
        '',
        '## The interview',
        '',
        '**HOST_A:** Welcome back to the show today.',
        '',
        '**GUEST:** We lit the lamp.',
        '',
        '## Outro',
        '',
        '**HOST_A:** See you next week.',
        '',
      ].join('\n'),
    );
  });

  it('writes the codex entry’s display name when the speaker resolved to one', async () => {
    const codex: CodexEntry[] = [
      {
        id: 'c_HOSTA00001',
        name: 'Host Alice',
        aliases: ['HOST_A'],
        type: 'character',
        description: '',
        includePolicy: 'auto',
        caseSensitive: false,
        exclude: [],
        attachments: [],
        keywords: [],
      } as unknown as CodexEntry,
    ];
    const text = await textOf(makeShowProject({ codex }), 'transcript-md');
    expect(text).toContain('**Host Alice:** Welcome back to the show today.');
  });
});

describe('the teleprompter', () => {
  it('writes the spoken lines only — no labels, cues or headings — one script line per paragraph', async () => {
    const text = await textOf(makeShowProject(), 'teleprompter');
    expect(text).toBe(
      [
        'Previously, on the show.',
        '',
        'Welcome back to the show today.',
        '',
        'We lit the lamp.',
        '',
        'See you next week.',
        '',
      ].join('\n'),
    );
  });

  it('wraps at the recipe’s teleprompterWidth when one is set', () => {
    const output = renderMedia({
      state: makeShowProject(),
      format: 'teleprompter',
      includeRootIds: ['manuscript'],
      title: 'The Show',
      author: '',
      date: '2026-11-15',
      titlePage: false,
      base: 'Episode 1',
      assets: new Map(),
      teleprompterWidth: 20,
    });
    expect(output.files[0]?.text).toContain('Welcome back to the\nshow today.');
  });

  it('refuses a selection with no episode', async () => {
    const state = createProjectState(createEmptyManifest(PROJECT_NAME, OPENED, { locale: 'en-US' }));
    await expect(rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'teleprompter')).rejects.toBeInstanceOf(
      MediaRefusedError,
    );
    await expect(rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'show-notes')).rejects.toThrow(/no episode/);
    await expect(rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'transcript-md')).rejects.toThrow(/no episode/);
  });
});
