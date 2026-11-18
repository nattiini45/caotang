/**
 * The captions import on the shared preview (apps/desktop/src/import-preview/captions-source.ts, issue #287): the plan it proposes,
 * the writer's four choices, the losses it names, and the one `binder.importTree` the bus accepts. The body is read back with the AV
 * script's own parser, and the round trip goes through the **real exporter's** `vtt` compile, so the check is independent of this
 * source's own idea of the format.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_REGISTRY } from '@caotang/bus';
import { parseEpisode } from '@caotang/script';
import { addDocument, addFolder, createEmptyManifest, createProjectState, MemoryArtifactFs } from '@caotang/store';
import { createExporter } from '@caotang/exporter';

import { pinFormatLocale } from '../src/i18n/locale.js';
import { activateCatalogue, activateEnglish } from '../src/i18n/runtime.js';
import { PREVIEW_HELPERS } from '../src/import-preview/helpers.js';
import { NO_EDITS, NO_OVERRIDES, buildCommit, initialSettings, type CommitInput, type ImportPreviewSource, type PreviewPlan, type PreviewSettings } from '../src/import-preview/model.js';
import { CAPTIONS_CHIPS, CAPTIONS_OPTIONS, captionsBaseName, captionsPreviewSource, captionsSizeRefusal } from '../src/import-preview/captions-source.js';
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

const VTT = [
  'WEBVTT - The Lighthouse Keeper',
  '',
  'NOTE Recorded on the pier',
  '',
  '00:00:01.000 --> 00:00:04.000',
  '<v Ada>We lit the lamp.</v>',
  '',
  '00:00:04.500 --> 00:00:06.000',
  '<v Bob>And then we waited.</v>',
  '',
  '00:00:20.000 --> 00:00:22.000',
  '<v Ada>Much later.</v>',
  '',
].join('\n');

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

function project(): ReturnType<typeof createProjectState> {
  const now = new Date('2026-11-01T10:00:00Z');
  return createProjectState(createEmptyManifest('Fixture', now), { now });
}

async function open(text: string, fileName = 'episode-12.vtt'): Promise<ImportPreviewSource> {
  const opened = captionsPreviewSource(fileName, bytesOf(text));
  if (!opened.ok) throw new Error(opened.message);
  await opened.source.load?.(() => {}, new AbortController().signal);
  return opened.source;
}

function commitOf(plan: PreviewPlan, _source: ImportPreviewSource, _settings: PreviewSettings): ReturnType<typeof buildCommit> {
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

const withSettings = (base: PreviewSettings, chips: Record<string, string> = {}, options: Record<string, boolean> = {}): PreviewSettings => ({
  chips: { ...base.chips, ...chips },
  options: { ...base.options, ...options },
});

describe('the captions preview', () => {
  it('proposes one show folder holding one AV script episode, and the bus accepts the commit', async () => {
    const source = await open(VTT);
    const settings = initialSettings(source.chips(), source.options());
    const plan = source.plan(settings, NO_OVERRIDES);
    expect(plan.tree).toHaveLength(1);
    const show = plan.tree[0]!;
    expect(show.kind).toBe('show');
    expect(show.title).toBe('The Lighthouse Keeper');
    expect(show.children).toHaveLength(1);
    const episode = show.children![0]!;
    expect(episode.kind).toBe('av-script');
    expect(plan.counts.scenes).toBe(1);
    expect(plan.counts.parts).toBe(1);
    expect(plan.markers).toHaveLength(2);

    const parsed = parseEpisode(episode.body!);
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0]!.lines.filter((line) => line.kind === 'speech').map((line) => line.speaker)).toEqual(['Ada', 'Bob']);
    expect(parsed.segments[0]!.lines.some((line) => line.kind === 'text' && line.text === '> Recorded on the pier')).toBe(true);

    const commit = commitOf(plan, source, settings);
    expect(commit.params.nodes.map((node) => [node.type, node.kind])).toEqual([
      ['folder', 'show'],
      ['document', 'av-script'],
    ]);
    expect(COMMAND_REGISTRY['binder.importTree'].descriptor.validate({ ...commit.params, pictures: [] }, project() as never).ok).toBe(true);
  });

  it('names the file after itself when the captions carry no title', async () => {
    const source = await open(['1', '00:00:01,000 --> 00:00:03,000', 'Words.', ''].join('\n'), 'My Podcast.srt');
    const plan = source.plan(initialSettings(source.chips(), source.options()), NO_OVERRIDES);
    expect(plan.tree[0]?.title).toBe('My Podcast');
    expect(captionsBaseName('C:\\recordings\\My Podcast.srt')).toBe('My Podcast');
    expect(captionsBaseName('take.vtt')).toBe('take');
  });

  it('the merge choice joins one speaker’s cues, and turning it off keeps them apart', async () => {
    const text = ['WEBVTT', '', '00:00.000 --> 00:02.000', '<v Ada>One sentence</v>', '', '00:02.100 --> 00:04.000', '<v Ada>that keeps going.</v>', ''].join('\n');
    const source = await open(text);
    const base = initialSettings(source.chips(), source.options());
    expect(source.plan(base, NO_OVERRIDES).counts.words).toBe(5);
    expect(source.report().find((list) => list.label === 'What the import does')?.lines.join(' ')).toContain('joined an earlier line');
    const apart = source.plan(withSettings(base, {}, { [CAPTIONS_OPTIONS.merge]: false }), NO_OVERRIDES);
    const body = apart.tree[0]!.children![0]!.body!;
    expect(body.split('\n').filter((line) => line.startsWith('Ada: '))).toHaveLength(2);
    expect(source.report().find((list) => list.label === 'What the import does')?.lines.join(' ')).not.toContain('joined an earlier line');
  });

  it('the show folder choice leaves a lone episode, which the manuscript puts in a chapter of its own name', async () => {
    const source = await open(VTT);
    const base = initialSettings(source.chips(), source.options());
    const plan = source.plan(withSettings(base, {}, { [CAPTIONS_OPTIONS.show]: false }), NO_OVERRIDES);
    expect(plan.tree).toHaveLength(1);
    expect(plan.tree[0]?.kind).toBe('av-script');
    expect(plan.counts.parts).toBe(0);
    const commit = commitOf(plan, source, withSettings(base, {}, { [CAPTIONS_OPTIONS.show]: false }));
    expect(commit.params.nodes.map((node) => node.type)).toEqual(['folder', 'document']);
    expect(commit.params.nodes[0]?.kind).toBeUndefined();
    expect(COMMAND_REGISTRY['binder.importTree'].descriptor.validate({ ...commit.params, pictures: [] }, project() as never).ok).toBe(true);
  });

  it('the gap choice makes one segment or two, and the silence choice changes the runtime', async () => {
    const source = await open(VTT);
    const base = initialSettings(source.chips(), source.options());
    expect(source.plan(base, NO_OVERRIDES).markers).toHaveLength(2);
    expect(source.plan(withSettings(base, { [CAPTIONS_CHIPS.gap]: '0' }), NO_OVERRIDES).markers).toHaveLength(1);
    const folded = source.report().find((list) => list.label === 'What the import does')?.lines.join(' ') ?? '';
    expect(folded).toContain('added to the line before it');
    source.plan(withSettings(base, { [CAPTIONS_CHIPS.silence]: 'leave' }), NO_OVERRIDES);
    const left = source.report().find((list) => list.label === 'What the import does')?.lines.join(' ') ?? '';
    expect(left).toContain('is left out, so the episode is shorter');
    expect(left).not.toContain('added to the line before it');
  });

  it('names every loss in words, with the count beside it', async () => {
    const source = await open([
      'WEBVTT', '',
      'STYLE', '::cue { color: white }', '',
      'cue-1', '00:00.000 --> 00:02.000 align:start', '<v Ada>Some <b>bold</b> words.</v>', '',
    ].join('\n'));
    const plan = source.plan(initialSettings(source.chips(), source.options()), NO_OVERRIDES);
    const messages = plan.losses.map((loss) => loss.message);
    expect(messages.some((message) => message.startsWith('caption styling'))).toBe(true);
    expect(messages.some((message) => message.startsWith('STYLE blocks left out'))).toBe(true);
    expect(messages.some((message) => message.startsWith('cue positions and alignments'))).toBe(true);
    expect(messages.some((message) => message.startsWith('cue identifiers left out'))).toBe(true);
    expect(plan.losses.every((loss) => loss.count !== undefined)).toBe(true);
  });

  it('refuses a file with no timed cue, and says what a captions file needs', async () => {
    const opened = captionsPreviewSource('notes.txt', bytesOf('Just words, no timings.\n'));
    if (!opened.ok) throw new Error(opened.message);
    await expect(opened.source.load?.(() => {}, new AbortController().signal)).rejects.toThrow('holds no timed cue');
  });

  it('refuses a file past the size cap before its bytes are read', () => {
    expect(captionsSizeRefusal('huge.srt', 33 * 1024 * 1024)).toContain('too large to import as captions');
    expect(captionsSizeRefusal('small.srt', 1024)).toBeUndefined();
  });

  it('speaks German in a German interface, with the app’s own words for a cue, a speech line and a show', async () => {
    await activateCatalogue('de');
    const source = await open(VTT);
    const settings = initialSettings(source.chips(), source.options());
    source.plan(settings, NO_OVERRIDES);
    expect(source.title).toBe('Untertitel importieren?');
    expect(source.chips().find((chip) => chip.id === CAPTIONS_CHIPS.gap)?.label).toBe('Neues Segment ab einer Pause von');
    expect(source.options().map((option) => option.label)).toEqual([
      'Aufeinanderfolgende Cues eines Sprechers zusammenfassen',
      'Die Episode in einen Sendungsordner legen',
    ]);
    const said = source.report().find((list) => list.label === 'Was der Import tut')?.lines[0] ?? '';
    expect(said).toContain('Sprechzeilen');
    expect(said).toContain('Segmenten');
    expect(said).toContain('Jede Dauer stammt aus den Zeiten der Datei selbst.');
  });
});

describe('the round trip with the exporter’s own WebVTT compile', () => {
  /** Compiles a body as an episode of a show, with the real exporter (av-script.md §5, #694). */
  async function compileVtt(body: string): Promise<string> {
    const now = new Date('2026-11-01T10:00:00Z');
    const state = createProjectState(createEmptyManifest('Fixture', now), { now });
    const show = addFolder(state, { id: 'n_SHOW000001', parentId: 'manuscript', title: 'The Lighthouse Keeper', now });
    Object.assign(show, { kind: 'show' });
    const episode = addDocument(state, { id: 'n_EPISODE001', parentId: show.id, title: 'The Lighthouse Keeper', body, now });
    Object.assign(episode, { kind: 'av-script' });
    const exporter = createExporter({
      readState: () => state,
      artifacts: new MemoryArtifactFs(),
      clock: { now: () => now.toISOString() },
      metadata: () => ({ author: 'Ada Lovelace' }),
    });
    const compiled = await exporter.compile({ includeRootIds: ['manuscript'] }, 'vtt');
    return await compiled.files[0]!.blob.text();
  }

  it('keeps every speaker, word and duration through the exporter and back, and the second pass is stable', async () => {
    const source = await open(VTT);
    const settings = withSettings(initialSettings(source.chips(), source.options()), {}, { [CAPTIONS_OPTIONS.merge]: false });
    const body = source.plan(settings, NO_OVERRIDES).tree[0]!.children![0]!.body!;

    const first = await compileVtt(body);
    expect(first.startsWith('WEBVTT')).toBe(true);
    expect(first).toContain('<v Ada>We lit the lamp.</v>');
    expect(first).toContain('<v Bob>And then we waited.</v>');

    const again = await open(first, 'round-trip.vtt');
    const second = again.plan(settings, NO_OVERRIDES).tree[0]!.children![0]!.body!;
    const before = parseEpisode(body);
    const after = parseEpisode(second);
    const spoken = (parsed: ReturnType<typeof parseEpisode>): (string | number | undefined)[][] =>
      parsed.segments.flatMap((segment) => segment.lines.filter((line) => line.kind === 'speech').map((line) => [line.speaker, line.text, line.durationSec]));
    expect(spoken(after)).toEqual(spoken(before));

    // The export carries no segment markers, so the second pass is where the shape settles; from there it must not move.
    const third = await compileVtt(second);
    const fourth = await open(third, 'round-trip-2.vtt');
    const settled = fourth.plan(settings, NO_OVERRIDES).tree[0]!.children![0]!.body!;
    expect(await compileVtt(settled)).toBe(third);
  });
});

describe('a guessed encoding the writer changes', () => {
  /** UTF-16LE without a BOM, so the encoding is guessed and a single-byte choice reads no timed cue. */
  const utf16 = (text: string): Uint8Array => Uint8Array.from([...text].flatMap((c) => [c.charCodeAt(0), 0]));
  const ONE_CUE = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Ada>The café lamp is lit.</v>\n';

  async function openGuessed(): Promise<{ source: ImportPreviewSource; settings: PreviewSettings; choices: string[] }> {
    const opened = captionsPreviewSource('episode.vtt', utf16(ONE_CUE));
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.message);
    await opened.source.load?.(() => {}, new AbortController().signal);
    const chips = opened.source.chips();
    const chip = chips.find((held) => held.id === CAPTIONS_CHIPS.encoding);
    return { source: opened.source, settings: initialSettings(chips, opened.source.options()), choices: (chip?.options ?? []).map((option) => option.value) };
  }

  it('an encoding that reads no cue fails with a reason instead of leaving the preview on Reading', async () => {
    const { source, settings, choices } = await openGuessed();
    expect(choices).toContain('utf-16le');
    expect(choices).toContain('windows-1252');
    const wrong = withSettings(settings, { [CAPTIONS_CHIPS.encoding]: 'windows-1252' });
    await expect(source.prepare?.(wrong, new AbortController().signal)).rejects.toThrow(/no timed cue/);
  });

  it('the report names the encoding the text is read as, not the first guess', async () => {
    const latin = Uint8Array.from([...ONE_CUE.replace('lamp', 'café')].map((c) => (c === 'é' ? 0xe9 : c.charCodeAt(0))));
    const opened = captionsPreviewSource('episode.vtt', latin);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    await opened.source.load?.(() => {}, new AbortController().signal);
    const settings = initialSettings(opened.source.chips(), opened.source.options());
    const lineOf = (): string => opened.source.report?.().find((list) => list.heading === 'Encoding')?.lines[0] ?? '';
    expect(lineOf()).toContain('Windows-1252');
    const other = withSettings(settings, { [CAPTIONS_CHIPS.encoding]: 'iso-8859-15' });
    await opened.source.prepare?.(other, new AbortController().signal);
    opened.source.plan(other, NO_OVERRIDES);
    expect(lineOf()).toContain('ISO-8859-15');
    expect(lineOf()).not.toContain('Windows-1252');
    // Choosing the first encoding again reads it from the cache; the report must follow the choice back.
    const back = withSettings(settings, { [CAPTIONS_CHIPS.encoding]: 'windows-1252' });
    await opened.source.prepare?.(back, new AbortController().signal);
    opened.source.plan(back, NO_OVERRIDES);
    expect(lineOf()).toContain('Windows-1252');
    expect(lineOf()).not.toContain('ISO-8859-15');
  });
});

describe('a cue that starts and ends at the same time', () => {
  it('the report says which lines carry no duration and that the show’s speech rate estimates them', async () => {
    const source = await open([
      'WEBVTT', '',
      '00:00:01.000 --> 00:00:01.000', '<v Ada>No span.</v>', '',
      '00:00:02.000 --> 00:00:04.000', '<v Ada>Two seconds.</v>', '',
    ].join('\n'));
    const settings = withSettings(initialSettings(source.chips(), source.options()), {}, { [CAPTIONS_OPTIONS.merge]: false });
    source.plan(settings, NO_OVERRIDES);
    const said = source.report().find((list) => list.heading === 'What the import does')?.lines ?? [];
    expect(said.join(' ')).toContain('1 line carry no duration');
    expect(said.join(' ')).toContain("The show's speech rate estimates them");
    // The runtime named beside it is the timed part alone.
    expect(said.join(' ')).toContain('The episode runs 2 s as imported.');
  });
});
