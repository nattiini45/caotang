/**
 * The podcast feed (`podcast-rss`, av-script.md §5): RSS 2.0 with the itunes and podcastindex namespaces, one
 * file per compile, an item per published episode that carries all three enclosure fields. The six
 * Apple-required channel tags are the checklist — a missing one is named in the compile log — and the draft
 * rule applies: no `publishedAt`, no item.
 */

import { describe, expect, it } from 'vitest';
import { addDocument, addFolder } from '@caotang/store';
import { MemoryArtifactFs } from '@caotang/store';

import { createExporter, type ExporterService } from '../src/exporter.js';
import { COMPILED_AT, OPENED, makeProject } from './fixture.js';

const SHOW = 'n_SHOW00001';
const EP1 = 'n_EPISODE01';
const EP2 = 'n_EPISODE02';
const EP3 = 'n_EPISODE03';

/** A timed episode body: two segments of declared durations. */
const EP1_BODY = '## Cold open\n\nELENA: The ferry is late. [1:00]\n\n## The count\n\nNARRATOR: He counted the ships. [1:30]';
const EP2_BODY = '## Only outro\n\nELENA: Goodnight. [0:30]';
const EP3_BODY = 'NARRATOR: Not ready.';

function showRig(): { readonly state: ReturnType<typeof makeProject>; readonly exporter: ExporterService; readonly fs: MemoryArtifactFs } {
  const state = makeProject();
  addFolder(state, { parentId: 'manuscript', title: 'The Rock Hour', now: OPENED, id: SHOW });
  addDocument(state, { parentId: SHOW, title: 'The Ferry', body: EP1_BODY, now: OPENED, id: EP1, kind: 'av-script' });
  addDocument(state, { parentId: SHOW, title: 'The Outro', body: EP2_BODY, now: OPENED, id: EP2, kind: 'av-script' });
  addDocument(state, { parentId: SHOW, title: 'A Draft', body: EP3_BODY, now: OPENED, id: EP3, kind: 'av-script' });
  const show = state.manifest.tree.find((n) => n.id === SHOW);
  if (show === undefined) throw new Error('no show');
  show.kind = 'show';
  show.synopsis = 'Nine years on the rock.';
  show.showMeta = {
    description: 'A keeper alone on the rock.',
    language: 'en',
    explicit: false,
    category: 'Arts',
    link: 'https://example.com/show',
    fundingUrl: 'https://example.com/fund',
  };
  const ep1 = state.manifest.tree.find((n) => n.id === EP1);
  const ep2 = state.manifest.tree.find((n) => n.id === EP2);
  const ep3 = state.manifest.tree.find((n) => n.id === EP3);
  if (ep1 === undefined || ep2 === undefined || ep3 === undefined) throw new Error('no episodes');
  ep1.publish = { publishedAt: '2026-11-15T12:00:00Z' };
  ep1.episodeMeta = {
    audioUrl: 'https://cdn.example.com/ep1.mp3',
    audioBytes: 3200000,
    audioMime: 'audio/mpeg',
    episode: 4,
    season: 2,
    episodeType: 'full',
    transcriptUrl: 'https://example.com/ep1.md',
    chaptersUrl: 'https://example.com/ep1.json',
  };
  ep2.publish = { publishedAt: '2026-11-10T09:00:00Z' };
  // Missing audioBytes: the enclosure checklist leaves it out.
  ep2.episodeMeta = { audioUrl: 'https://cdn.example.com/ep2.mp3', audioMime: 'audio/mpeg' };
  ep3.episodeMeta = { audioUrl: 'https://cdn.example.com/ep3.mp3', audioBytes: 1000, audioMime: 'audio/mpeg' };
  const fs = new MemoryArtifactFs();
  const exporter = createExporter({ readState: () => state, artifacts: fs, clock: { now: () => COMPILED_AT } });
  return { state, exporter, fs };
}

describe('the podcast feed', () => {
  it('writes one RSS file with the channel tags, an item per published episode with a full enclosure', async () => {
    const { state, exporter, fs } = showRig();
    await exporter.ready();
    state.manifest.recipes = [{ name: 'Podcast', includeRootIds: [SHOW], format: 'podcast-rss' }];
    const outcome = exporter.commandPort().compile(state, {
      selection: { kind: 'nodes', includeRootIds: [SHOW] },
      format: 'podcast-rss',
      recipeName: 'Podcast',
      at: COMPILED_AT,
    });
    await exporter.idle();
    expect(outcome.digest.output).toBe('exports/The Rock Hour.rss.xml');
    const xml = fs.snapshot()['exports/The Rock Hour.rss.xml'];
    if (xml === undefined) throw new Error('no feed written');
    expect(xml).toContain('xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"');
    expect(xml).toContain('xmlns:podcast="https://podcastindex.org/namespace/1.0"');
    // Channel: the six required tags.
    expect(xml).toContain('<title>The Rock Hour</title>');
    expect(xml).toContain('<link>https://example.com/show</link>');
    expect(xml).toContain('<description>A keeper alone on the rock.</description>');
    expect(xml).toContain('<language>en</language>');
    expect(xml).toContain('<itunes:category text="Arts"/>');
    expect(xml).toContain('<itunes:explicit>false</itunes:explicit>');
    expect(xml).toContain('<podcast:funding url="https://example.com/fund">Support the show</podcast:funding>');
    // One item: EP2 has no audioBytes, EP3 is a draft.
    expect((xml.match(/<item>/g) ?? []).length).toBe(1);
    expect(xml).toContain('<title>The Ferry</title>');
    expect(xml).toContain('<enclosure url="https://cdn.example.com/ep1.mp3" length="3200000" type="audio/mpeg"/>');
    expect(xml).toContain('<guid isPermaLink="false">n_EPISODE01</guid>');
    expect(xml).toContain('<pubDate>Sun, 15 Nov 2026 12:00:00 GMT</pubDate>');
    expect(xml).toContain('<itunes:duration>150</itunes:duration>');
    expect(xml).toContain('<itunes:episode>4</itunes:episode>');
    expect(xml).toContain('<itunes:season>2</itunes:season>');
    expect(xml).toContain('<itunes:episodeType>full</itunes:episodeType>');
    expect(xml).toContain('<podcast:transcript url="https://example.com/ep1.md" language="en" type="text/markdown"/>');
    expect(xml).toContain('<podcast:chapters url="https://example.com/ep1.json" type="application/json+chapters"/>');
    expect(xml).toContain('<podcast:guid>n_SHOW00001</podcast:guid>');
    const log = JSON.parse(fs.snapshot()['exports/compile-log.json'] ?? '[]') as Array<{ notes?: string[] }>;
    const notes = log.at(-1)?.notes ?? [];
    expect(notes.some((n) => n.includes('itunes:image'))).toBe(true);
    expect(notes.some((n) => n.includes('The Outro') && n.includes('audioBytes'))).toBe(true);
    expect(notes.some((n) => n.includes('A Draft') && n.includes('draft'))).toBe(true);
  });

  it('names every missing channel-required tag in the log', async () => {
    const { state, exporter, fs } = showRig();
    await exporter.ready();
    const show = state.manifest.tree.find((n) => n.id === SHOW);
    if (show === undefined) throw new Error('no show');
    show.showMeta = { link: 'https://example.com/show' };
    show.synopsis = '';
    state.manifest.recipes = [{ name: 'Podcast', includeRootIds: [SHOW], format: 'podcast-rss' }];
    exporter.commandPort().compile(state, {
      selection: { kind: 'nodes', includeRootIds: [SHOW] },
      format: 'podcast-rss',
      recipeName: 'Podcast',
      at: COMPILED_AT,
    });
    await exporter.idle();
    const xml = fs.snapshot()['exports/The Rock Hour.rss.xml'];
    if (xml === undefined) throw new Error('no feed written');
    // RSS 2.0 requires <description>; the channel title stands in.
    expect(xml).toContain('<description>The Rock Hour</description>');
    const log = JSON.parse(fs.snapshot()['exports/compile-log.json'] ?? '[]') as Array<{ notes?: string[] }>;
    const notes = log.at(-1)?.notes ?? [];
    expect(notes.some((n) => n.includes('description'))).toBe(true);
    expect(notes.some((n) => n.includes('language'))).toBe(true);
    expect(notes.some((n) => n.includes('itunes:image'))).toBe(true);
    expect(notes.some((n) => n.includes('itunes:category'))).toBe(true);
    expect(notes.some((n) => n.includes('itunes:explicit'))).toBe(true);
  });

  it('falls back to the project language when the show language is not a well-formed tag', async () => {
    const { state, exporter, fs } = showRig();
    await exporter.ready();
    const show = state.manifest.tree.find((n) => n.id === SHOW);
    if (show === undefined) throw new Error('no show');
    show.showMeta = { ...show.showMeta, language: 'english please' };
    state.manifest.recipes = [{ name: 'Podcast', includeRootIds: [SHOW], format: 'podcast-rss' }];
    exporter.commandPort().compile(state, {
      selection: { kind: 'nodes', includeRootIds: [SHOW] },
      format: 'podcast-rss',
      recipeName: 'Podcast',
      at: COMPILED_AT,
    });
    await exporter.idle();
    const xml = fs.snapshot()['exports/The Rock Hour.rss.xml'];
    if (xml === undefined) throw new Error('no feed written');
    expect(xml).not.toContain('english please');
    const log = JSON.parse(fs.snapshot()['exports/compile-log.json'] ?? '[]') as Array<{ notes?: string[] }>;
    const notes = log.at(-1)?.notes ?? [];
    expect(notes.some((n) => n.includes('not a well-formed tag'))).toBe(true);
  });

  it('refuses a compile when the show names no home link', async () => {
    const { state, exporter } = showRig();
    await exporter.ready();
    const show = state.manifest.tree.find((n) => n.id === SHOW);
    if (show === undefined) throw new Error('no show');
    show.showMeta = { description: 'No link here.' };
    state.manifest.recipes = [{ name: 'Podcast', includeRootIds: [SHOW], format: 'podcast-rss' }];
    expect(() =>
      exporter.commandPort().compile(state, {
        selection: { kind: 'nodes', includeRootIds: [SHOW] },
        format: 'podcast-rss',
        recipeName: 'Podcast',
        at: COMPILED_AT,
      }),
    ).toThrow('no home link');
  });

  it('refuses a selection whose episodes sit in more than one show', async () => {
    const { state, exporter } = showRig();
    await exporter.ready();
    addFolder(state, { parentId: 'manuscript', title: 'Second Show', now: OPENED, id: 'n_SHOW00002' });
    const second = state.manifest.tree.find((n) => n.id === 'n_SHOW00002');
    if (second === undefined) throw new Error('no second show');
    second.kind = 'show';
    second.showMeta = { link: 'https://example.com/two' };
    addDocument(state, { parentId: 'n_SHOW00002', title: 'Elsewhere', body: EP2_BODY, now: OPENED, id: 'n_EPISODE99', kind: 'av-script' });
    state.manifest.recipes = [{ name: 'Podcast', includeRootIds: ['manuscript'], format: 'podcast-rss' }];
    expect(() =>
      exporter.commandPort().compile(state, {
        selection: { kind: 'nodes', includeRootIds: ['manuscript'] },
        format: 'podcast-rss',
        recipeName: 'Podcast',
        at: COMPILED_AT,
      }),
    ).toThrow('more than one show');
  });

  it('keeps a leap-second publish date and skips a transcript whose address names no type', async () => {
    const { state, exporter, fs } = showRig();
    await exporter.ready();
    const ep1 = state.manifest.tree.find((n) => n.id === EP1);
    if (ep1 === undefined) throw new Error('no ep');
    ep1.publish = { publishedAt: '2016-12-31T23:59:60Z' };
    ep1.episodeMeta = { ...ep1.episodeMeta, transcriptUrl: 'https://example.com/transcript' };
    state.manifest.recipes = [{ name: 'Podcast', includeRootIds: [SHOW], format: 'podcast-rss' }];
    exporter.commandPort().compile(state, {
      selection: { kind: 'nodes', includeRootIds: [SHOW] },
      format: 'podcast-rss',
      recipeName: 'Podcast',
      at: COMPILED_AT,
    });
    await exporter.idle();
    const xml = fs.snapshot()['exports/The Rock Hour.rss.xml'];
    if (xml === undefined) throw new Error('no feed written');
    expect(xml).toContain('<pubDate>Sun, 01 Jan 2017 00:00:00 GMT</pubDate>');
    expect(xml).not.toContain('podcast:transcript');
    const log = JSON.parse(fs.snapshot()['exports/compile-log.json'] ?? '[]') as Array<{ notes?: string[] }>;
    const notes = log.at(-1)?.notes ?? [];
    expect(notes.some((n) => n.includes('podcast:transcript') && n.includes('The Ferry'))).toBe(true);
  });

  it('refuses a selection with no episode', async () => {
    const { state, exporter } = showRig();
    await exporter.ready();
    state.manifest.recipes = [{ name: 'No eps', includeRootIds: ['research'], format: 'podcast-rss' }];
    expect(() =>
      exporter.commandPort().compile(state, {
        selection: { kind: 'nodes', includeRootIds: ['research'] },
        format: 'podcast-rss',
        recipeName: 'No eps',
        at: COMPILED_AT,
      }),
    ).toThrow('the selection holds no episode');
  });
});
