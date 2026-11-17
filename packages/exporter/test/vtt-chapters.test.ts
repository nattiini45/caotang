/**
 * The AV script's captions and chapters (av-script.md §5): `vtt` — WebVTT cues with the period millisecond
 * separator and the standardised `<v Speaker>` voice span — and `chapters-json`, the Podcasting 2.0
 * `application/json+chapters` document with `startTime`, `title` and `endTime` per segment.
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
import { MediaRefusedError } from '../src/errors.js';
import { COMPILED_AT, PROJECT_NAME } from './fixture.js';

const OPENED = new Date(COMPILED_AT);

const SHOW_ID = 'n_SHOW000001';
const EPISODE_ID = 'n_EPISODE001';

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

function makeShowProject(options: { episode?: string; codex?: CodexEntry[] } = {}): ProjectState {
  const state = createProjectState(createEmptyManifest(PROJECT_NAME, OPENED, { locale: 'en-US' }));
  const show = addFolder(state, { parentId: 'manuscript', title: 'The Show', now: OPENED, id: SHOW_ID });
  Object.assign(show, { kind: 'show' });
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

describe('the WebVTT captions', () => {
  it('writes one cue per speech line with the period separator and the voice span', async () => {
    const result = await rig().exporter.compile({ includeRootIds: ['manuscript'] }, 'vtt');
    const file = result.files[0]!;
    expect(result.files.length).toBe(1);
    expect(file.fileName).toContain('captions');
    expect(file.mimeType).toBe('text/vtt;charset=utf-8');
    const text = await file.blob.text();
    expect(text).toBe(
      [
        'WEBVTT',
        '',
        '00:00:00.000 --> 00:00:10.000',
        '<v NARRATION>Previously, on the show.</v>',
        '',
        '00:00:10.000 --> 00:00:40.000',
        '<v HOST_A>Welcome back to the show today.</v>',
        '',
        '00:00:40.000 --> 00:00:41.600',
        '<v GUEST>We lit the lamp.</v>',
        '',
        '00:00:41.600 --> 00:00:43.200',
        '<v HOST_A>See you next week.</v>',
        '',
      ].join('\n'),
    );
  });

  it('writes the codex entry’s display name in the voice span', async () => {
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
    const result = await rig({ state: makeShowProject({ codex }) }).exporter.compile({ includeRootIds: ['manuscript'] }, 'vtt');
    expect(await result.files[0]!.blob.text()).toContain('<v Host Alice>Welcome back to the show today.</v>');
  });

  it('escapes the cue text and speaker so markup cannot close the voice span', async () => {
    const state = makeShowProject({
      episode: '## A\nHOST_A: Look at </v> and &lt; tags. [0:10] <!-- lineId: sl_1000000011 -->\n',
    });
    const result = await rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'vtt');
    const text = await result.files[0]!.blob.text();
    expect(text).toContain('<v HOST_A>Look at &lt;/v&gt; and &amp;lt; tags.</v>');
    expect(text).not.toContain('</v> and');
  });

  it('gives a sub-millisecond duration a one-millisecond cue, never a zero-length one', async () => {
    const state = makeShowProject({
      episode: '## A\nHOST_A: Tiny. [0.0004s] <!-- lineId: sl_1000000012 -->\n',
    });
    const result = await rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'vtt');
    const text = await result.files[0]!.blob.text();
    expect(text).toContain('00:00:00.000 --> 00:00:00.001\n<v HOST_A>Tiny.</v>');
  });

  it('never overlaps two consecutive sub-millisecond cues on one timestamp', async () => {
    const state = makeShowProject({
      episode: '## A\nHOST_A: One. [0.0004s] <!-- lineId: sl_1000000012 -->\nHOST_A: Two. [0.0004s] <!-- lineId: sl_1000000013 -->\n',
    });
    const result = await rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'vtt');
    const text = await result.files[0]!.blob.text();
    // Both starts would round to 0 ms; the second cue moves to the millisecond after the first's end.
    expect(text).toContain('00:00:00.000 --> 00:00:00.001\n<v HOST_A>One.</v>');
    expect(text).toContain('00:00:00.001 --> 00:00:00.002\n<v HOST_A>Two.</v>');
  });

  it('refuses a selection with no episode, and an episode whose lines all lack a duration', async () => {
    const state = createProjectState(createEmptyManifest(PROJECT_NAME, OPENED, { locale: 'en-US' }));
    await expect(rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'vtt')).rejects.toBeInstanceOf(MediaRefusedError);
    // A body of text lines only parses to segments with no speech and no timing.
    const textOnly = makeShowProject({ episode: '## A\nOnly a text line.\n' });
    await expect(rig({ state: textOnly }).exporter.compile({ includeRootIds: ['manuscript'] }, 'vtt')).rejects.toThrow(
      /no episode in the selection holds a speakable line with a duration/,
    );
  });
});

describe('the chapters document', () => {
  it('is application/json+chapters with startTime, title and endTime per segment', async () => {
    const result = await rig().exporter.compile({ includeRootIds: ['manuscript'] }, 'chapters-json');
    const file = result.files[0]!;
    expect(file.mimeType).toBe('application/json+chapters');
    expect(file.fileName).toContain('chapters');
    const doc = JSON.parse(await file.blob.text()) as { version: string; chapters: { startTime: number; title: string; endTime: number }[] };
    expect(doc.version).toBe('1.2.0');
    expect(doc.chapters).toEqual([
      { startTime: 0, title: 'Cold open', endTime: 10 },
      { startTime: 10, title: 'The interview', endTime: 41.6 },
      { startTime: 41.6, title: 'Outro', endTime: 43.2 },
    ]);
  });

  it('skips an untimed segment and names it in the compile log', async () => {
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
    const result = await rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'chapters-json');
    const doc = JSON.parse(await result.files[0]!.blob.text()) as { chapters: { title: string }[] };
    expect(doc.chapters.map((c) => c.title)).toEqual(['One', 'Three']);
    expect(result.log.notes.some((n) => n.includes('untimed'))).toBe(true);
  });

  it('writes no chapters document for an episode with no timed segment', async () => {
    const state = makeShowProject();
    const untimed = addDocument(state, {
      parentId: SHOW_ID,
      title: 'Episode 2',
      body: '## A\nOnly a note for the editor.\n',
      now: OPENED,
      id: 'n_EPISODE002',
    });
    Object.assign(untimed, { kind: 'av-script' });
    const result = await rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'chapters-json');
    expect(result.files.length).toBe(1);
    expect(result.log.notes.some((n) => n.includes('Episode 2') && n.includes('no chapters document'))).toBe(true);
  });

  it('refuses an episode with no timed segment', async () => {
    const state = makeShowProject({ episode: '## A\nOnly a text line.\n' });
    await expect(rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'chapters-json')).rejects.toThrow(
      /no timed segment|no episode in the selection holds a timed segment/,
    );
  });
});
