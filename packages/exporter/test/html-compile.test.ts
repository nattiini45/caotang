/**
 * The `html` compile (web-publishing.md §3): one file per document in the selection, named by its slug or its title,
 * with the publish record carried through. Registered in `EXPORT_FORMATS`, text-typed like the other prose formats.
 */

import { describe, expect, it } from 'vitest';
import { MemoryArtifactFs } from '@caotang/store';

import { createExporter, type ExporterService } from '../src/exporter.js';
import { EXPORT_FORMATS } from '../src/types.js';
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

describe('the html format', () => {
  it('is registered last in the format order', () => {
    expect(EXPORT_FORMATS.at(-1)).toBe('html');
  });

  it('writes one self-contained file per document with a body, named by slug or title', async () => {
    const { state, exporter, fs } = rig();
    await exporter.ready();
    const landing = state.manifest.tree.find((node) => node.id === IDS.landing);
    if (landing === undefined) throw new Error('fixture lacks the landing');
    landing.publish = { slug: 'the-landing', canonical: 'https://example.com/landing' };
    const outcome = exporter.commandPort().compile(state, {
      selection: { kind: 'manuscript' },
      format: 'html',
      at: COMPILED_AT,
    });
    await exporter.idle();
    // Prologue, The Landing, The Storm, Morning — The Call and Blank are skipped (empty).
    expect(outcome.digest.outputs).toEqual([
      'exports/Prologue.html',
      'exports/the-landing.html',
      'exports/The Storm.html',
      'exports/Morning.html',
    ]);
    const written = fs.snapshot()['exports/the-landing.html'];
    if (written === undefined) throw new Error('no landing file written');
    expect(written).toContain('<link rel="canonical" href="https://example.com/landing">');
    expect(written).toContain('<!DOCTYPE html>');
    expect(written).not.toContain('<script');
  });

  it('reads the recipe options the save keeps: fragment and front matter', async () => {
    const { state, exporter, fs } = rig();
    await exporter.ready();
    state.manifest.recipes = [
      { name: 'Site posts', includeRootIds: [IDS.chapterTwo], format: 'html', options: { htmlMode: 'fragment', frontMatter: true } },
    ];
    exporter.commandPort().compile(state, {
      selection: { kind: 'manuscript' },
      format: 'html',
      recipeName: 'Site posts',
      at: COMPILED_AT,
    });
    await exporter.idle();
    const written = fs.snapshot()['exports/Morning.html'];
    if (written === undefined) throw new Error('no article written');
    expect(written).not.toContain('<html');
    expect(written).not.toContain('<style>');
    expect(written).toContain('published: false');
    expect(written).toContain('<article>');
  });

  it('refuses a selection with no document with a body, before anything is reserved', async () => {
    const { state, exporter, fs } = rig();
    await exporter.ready();
    expect(() =>
      exporter.commandPort().compile(state, {
        selection: { kind: 'nodes', includeRootIds: [IDS.chapterThree] },
        format: 'html',
        at: COMPILED_AT,
      }),
    ).toThrow('no article to write');
    expect(fs.snapshot()).toEqual({});
  });
});
