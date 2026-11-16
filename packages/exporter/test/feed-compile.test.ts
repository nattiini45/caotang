/**
 * The `rss` and `atom` compiles (web-publishing.md §3): one file per compile named `<base>.rss.xml` /
 * `<base>.atom.xml`, the channel from the recipe's folder, drafts omitted with a skip line, and `siteUrl` required.
 */

import { describe, expect, it } from 'vitest';
import { MemoryArtifactFs } from '@caotang/store';

import { createExporter, type ExporterService } from '../src/exporter.js';
import { COMPILED_AT, IDS, makeProject } from './fixture.js';

function rig(): { readonly state: ReturnType<typeof makeProject>; readonly exporter: ExporterService; readonly fs: MemoryArtifactFs } {
  const state = makeProject();
  const fs = new MemoryArtifactFs();
  const exporter = createExporter({
    readState: () => state,
    artifacts: fs,
    clock: { now: () => COMPILED_AT },
  });
  return { state, exporter, fs };
}

function publishAll(state: ReturnType<typeof makeProject>): void {
  for (const [id, publish] of [
    [IDS.prologue, { publishedAt: '2026-11-10T09:00:00Z', canonical: 'https://example.com/prologue' }],
    [IDS.landing, { publishedAt: '2026-11-15T12:00:00Z', canonical: 'https://example.com/the-landing' }],
    [IDS.storm, { publishedAt: '2026-11-12T08:00:00Z' }],
  ] as const) {
    const node = state.manifest.tree.find((entry) => entry.id === id);
    if (node === undefined) throw new Error(`fixture lacks ${id}`);
    node.publish = { ...publish };
  }
}

describe('the feed formats', () => {
  it('writes one RSS file for the manuscript, drafts omitted and named in the log', async () => {
    const { state, exporter, fs } = rig();
    await exporter.ready();
    publishAll(state);
    state.manifest.recipes = [
      {
        name: 'Site feed',
        includeRootIds: ['manuscript'],
        format: 'rss',
        options: { siteUrl: 'https://example.com' },
      },
    ];
    const outcome = exporter.commandPort().compile(state, {
      selection: { kind: 'manuscript' },
      format: 'rss',
      recipeName: 'Site feed',
      at: COMPILED_AT,
    });
    await exporter.idle();
    expect(outcome.digest.output).toBe('exports/Site feed.rss.xml');
    const written = fs.snapshot()['exports/Site feed.rss.xml'];
    if (written === undefined) throw new Error('no feed written');
    expect(written).toContain('<rss version="2.0">');
    // Three published items: Morning and the two empty scenes stay drafts / skipped.
    expect((written.match(/<item>/g) ?? []).length).toBe(3);
    expect(written).toContain('<guid isPermaLink="false">n_LANDING01</guid>');
    expect(written).not.toContain('Morning');
    const log = JSON.parse(fs.snapshot()['exports/compile-log.json'] ?? '[]') as Array<{ notes?: string[] }>;
    const notes = log.at(-1)?.notes ?? [];
    expect(notes.some((note) => note.includes('Morning') && note.includes('draft'))).toBe(true);
  });

  it('writes the Atom feed with the article as each entry content', async () => {
    const { state, exporter, fs } = rig();
    await exporter.ready();
    publishAll(state);
    state.manifest.recipes = [
      { name: 'Site feed', includeRootIds: ['manuscript'], format: 'atom', options: { siteUrl: 'https://example.com' } },
    ];
    exporter.commandPort().compile(state, {
      selection: { kind: 'manuscript' },
      format: 'atom',
      recipeName: 'Site feed',
      at: COMPILED_AT,
    });
    await exporter.idle();
    const written = fs.snapshot()['exports/Site feed.atom.xml'];
    if (written === undefined) throw new Error('no feed written');
    expect(written).toContain('<feed xmlns="http://www.w3.org/2005/Atom"');
    expect(written).toContain('<id>https://example.com#n_LANDING01</id>');
    expect(written).toContain('<content type="html">');
  });

  it('refuses without siteUrl, and refuses a non-https one, before anything is reserved', async () => {
    const { state, exporter, fs } = rig();
    await exporter.ready();
    publishAll(state);
    state.manifest.recipes = [{ name: 'No site', includeRootIds: ['manuscript'], format: 'rss' }];
    expect(() =>
      exporter.commandPort().compile(state, {
        selection: { kind: 'manuscript' },
        format: 'rss',
        recipeName: 'No site',
        at: COMPILED_AT,
      }),
    ).toThrow('siteUrl');
    state.manifest.recipes = [
      { name: 'Bad site', includeRootIds: ['manuscript'], format: 'atom', options: { siteUrl: 'http://example.com' } },
    ];
    expect(() =>
      exporter.commandPort().compile(state, {
        selection: { kind: 'manuscript' },
        format: 'atom',
        recipeName: 'Bad site',
        at: COMPILED_AT,
      }),
    ).toThrow('siteUrl');
    expect(fs.snapshot()).toEqual({});
  });
});
