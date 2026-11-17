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

  it('takes no cue for a line whose timing overflows a WebVTT timestamp, or for a line after it', async () => {
    const state = makeShowProject({
      episode:
        '## A\nHOST_A: Before. [0:10] <!-- lineId: sl_1000000011 -->\nHOST_A: Vast. [' + '9'.repeat(400) + 's] <!-- lineId: sl_1000000012 -->\nHOST_A: Still here. [1s] <!-- lineId: sl_1000000013 -->\n',
    });
    const result = await rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'vtt');
    const text = await result.files[0]!.blob.text();
    expect(text).not.toContain('Infinity');
    expect(text).not.toContain('Vast.');
    expect(text).toContain('<v HOST_A>Before.</v>');
    // The clock still advances by the overflowing duration, so the next line sits at a time no
    // timestamp can name — it takes no cue either rather than restarting at the old time.
    expect(text).not.toContain('Still here.');
    expect(result.log.notes.filter((n) => n.includes('overflows a WebVTT timestamp'))).toHaveLength(2);
  });

  it('refuses a selection with no episode, and an episode whose lines all lack a duration', async () => {
    const state = createProjectState(createEmptyManifest(PROJECT_NAME, OPENED, { locale: 'en-US' }));
    await expect(rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'vtt')).rejects.toBeInstanceOf(MediaRefusedError);
    // A body of text lines only parses to segments with no speech and no timing.
    const textOnly = makeShowProject({ episode: '## A\nOnly a text line.\n' });
    await expect(rig({ state: textOnly }).exporter.compile({ includeRootIds: ['manuscript'] }, 'vtt')).rejects.toThrow(
      /no episode in the selection holds a cue whose timing writes a caption/,
    );
  });

  it('names the cue it could not write when every timing overflows', async () => {
    const state = makeShowProject({
      episode: '## A\nHOST_A: Vast. [' + '9'.repeat(400) + 's] <!-- lineId: sl_1000000016 -->\n',
    });
    await expect(rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'vtt')).rejects.toThrow(
      /overflows a WebVTT timestamp/,
    );
  });

  it('gives two episodes of one title their own file names', async () => {
    const state = makeShowProject();
    const twin = addDocument(state, {
      parentId: SHOW_ID,
      title: 'Episode 1',
      body: '## A\nHOST_A: Same name. [0:10] <!-- lineId: sl_1000000017 -->\n',
      now: OPENED,
      id: 'n_EPISODE004',
    });
    Object.assign(twin, { kind: 'av-script' });
    const result = await rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'vtt');
    expect(result.files.length).toBe(2);
    expect(new Set(result.files.map((f) => f.fileName)).size).toBe(2);
    expect(result.files.some((f) => f.fileName.includes('n_EPISODE004'))).toBe(true);
  });

  it('keeps every file name its own when a real title equals a generated one', async () => {
    const state = makeShowProject();
    const twin = addDocument(state, {
      parentId: SHOW_ID,
      title: 'Episode 1',
      body: '## A\nHOST_A: Same name. [0:10] <!-- lineId: sl_1000000020 -->\n',
      now: OPENED,
      id: 'n_EPISODE005',
    });
    Object.assign(twin, { kind: 'av-script' });
    const lookalike = addDocument(state, {
      parentId: SHOW_ID,
      // This title is exactly the `title id` spelling the duplicate Episode 1s generate.
      title: 'Episode 1 n_EPISODE001',
      body: '## A\nHOST_A: Lookalike. [0:10] <!-- lineId: sl_1000000021 -->\n',
      now: OPENED,
      id: 'n_EPISODE006',
    });
    Object.assign(lookalike, { kind: 'av-script' });
    const result = await rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'vtt');
    expect(result.files.length).toBe(3);
    expect(new Set(result.files.map((f) => f.fileName)).size).toBe(3);
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

  it('skips a segment whose duration rounds to zero, so no chapter ends where it starts', async () => {
    const state = makeShowProject({
      episode: [
        '## One',
        'HOST_A: Hi. [0:10] <!-- lineId: sl_1000000001 -->',
        '## Blink',
        'HOST_A: Tiny. [0.0004s] <!-- lineId: sl_1000000002 -->',
        '## Three',
        'HOST_A: Bye. [0:10] <!-- lineId: sl_1000000003 -->',
      ].join('\n'),
    });
    const result = await rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'chapters-json');
    const doc = JSON.parse(await result.files[0]!.blob.text()) as { chapters: { startTime: number; title: string; endTime: number }[] };
    expect(doc.chapters.map((c) => c.title)).toEqual(['One', 'Three']);
    expect(doc.chapters.every((c) => c.endTime > c.startTime)).toBe(true);
    expect(result.log.notes.some((n) => n.includes('Blink') && n.includes('no positive finite duration'))).toBe(true);
  });

  it('writes no chapters document for an episode whose segments overflow a timestamp', async () => {
    const state = makeShowProject();
    const vast = addDocument(state, {
      parentId: SHOW_ID,
      title: 'Episode 2',
      body:
        '## Vast\nHOST_A: Hi. [' + '9'.repeat(400) + 's] <!-- lineId: sl_1000000014 -->\n## After\nHOST_A: Bye. [0:10] <!-- lineId: sl_1000000015 -->\n',
      now: OPENED,
      id: 'n_EPISODE003',
    });
    Object.assign(vast, { kind: 'av-script' });
    const result = await rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'chapters-json');
    // In Episode 2 the first segment's duration and the second's start both reach Infinity — each is
    // skipped rather than serializing a `null` timestamp, so it writes no chapters document.
    expect(result.files.length).toBe(1);
    expect(result.log.notes.filter((n) => n.includes('no positive finite duration'))).toHaveLength(2);
    expect(result.log.notes.some((n) => n.includes('Episode 2') && n.includes('no chapters document'))).toBe(true);
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

  it('titles a chapter after the document when the episode heading is bare', async () => {
    const state = makeShowProject({
      episode: '#\nHOST_A: Hi. [0:10] <!-- lineId: sl_1000000018 -->\n## Two\nHOST_A: Bye. [0:10] <!-- lineId: sl_1000000019 -->\n',
    });
    const result = await rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'chapters-json');
    const doc = JSON.parse(await result.files[0]!.blob.text()) as { chapters: { title: string }[] };
    // A bare `#` parses to an empty episode title — the chapter falls back to the document's title.
    expect(doc.chapters.map((c) => c.title)).toEqual(['Episode 1', 'Two']);
  });

  it('refuses an episode with no timed segment', async () => {
    const state = makeShowProject({ episode: '## A\nOnly a text line.\n' });
    await expect(rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'chapters-json')).rejects.toThrow(
      /no episode in the selection holds a segment whose timing writes a chapter/,
    );
  });
});
