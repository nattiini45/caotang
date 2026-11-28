/** The Plottr import on the shared preview (#290): beat hierarchy, scene cards, threads, codex rows, notes and pictures. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { activateEnglish } from '../src/i18n/runtime.js';
import { pinFormatLocale } from '../src/i18n/locale.js';
import { NO_EDITS, buildCommit, initialSettings, type PreviewSettings } from '../src/import-preview/model.js';
import { PREVIEW_HELPERS } from '../src/import-preview/helpers.js';
import { createReaderSession } from '../src/import-preview/reader-session.js';
import type { ReaderOpen, ReaderRead } from '../src/import-preview/reader-protocol.js';
import { plottrPreviewSource } from '../src/import-preview/plottr-source.js';

class InProcessWorker {
  private readonly handle = createReaderSession();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  postMessage(message: { id: number } & (ReaderOpen | ReaderRead)): void {
    void this.handle(message).then(
      (result) => this.onmessage?.({ data: { id: message.id, ok: true, result } }),
      (error: unknown) => this.onmessage?.({ data: { id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) } }),
    );
  }
  terminate(): void {}
}

beforeEach(() => { activateEnglish(); pinFormatLocale('en-US'); vi.stubGlobal('Worker', InProcessWorker); });
afterEach(() => { activateEnglish(); pinFormatLocale(undefined); vi.unstubAllGlobals(); });

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(__dirname, '../../../packages/import-plottr/test/fixtures', name)));
async function openBytes(name: string, bytes: Uint8Array) {
  const opened = plottrPreviewSource(name, bytes);
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error('not opened');
  await opened.source.load?.(() => {}, new AbortController().signal);
  return opened.source;
}
async function open(name = 'simple-story.pltr') {
  return openBytes(name, fixture(name));
}
const settings = (source: Awaited<ReturnType<typeof open>>): PreviewSettings => initialSettings(source.chips(), source.options());

describe('plottrPreviewSource', () => {
  it('turns flat beats and cards into chapters and synopsis-only scenes', async () => {
    const source = await open();
    const plan = source.plan(settings(source), { noSplit: [], sceneAt: [], chapterAt: [] });
    expect(plan.tree[0]?.title).toBe('Act 1');
    expect(plan.tree[0]?.children?.map((node) => node.title)).toEqual(['The Beginning', 'Discovery']);
    const scene = plan.tree[0]?.children?.[0];
    expect(scene?.synopsis).toContain('Opening scene.');
    expect(scene?.body).toBe('');
    expect(plan.counts.scenes).toBe(5);
  });

  it('maps Hamlet people, places, notes, tags, plotlines, scene participants and pictures', async () => {
    const source = await open('hamlet.pltr');
    const plan = source.plan(settings(source), { noSplit: [], sceneAt: [], chapterAt: [] });
    expect(plan.tree.map((node) => node.title)).toContain('Act 5');
    const scene = plan.tree.flatMap((node) => node.children ?? []).find((node) => node.title.includes('duel'));
    expect(scene?.sceneMeta?.expectedPresent).toContain('Hamlet');
    expect(scene?.sceneMeta?.locations).toContain('Elsinore Castle');
    expect(scene?.sceneMeta?.threads?.[0]?.id).toBeTruthy();
    expect(scene?.keywords).toContain('THEME: Mortality');
    expect(source.codexRows?.().some((row) => row.name === 'Hamlet' && row.type === 'character')).toBe(true);
    expect(source.codexRows?.().some((row) => row.name === 'Elsinore Castle' && row.type === 'location')).toBe(true);
    expect(plan.tree.some((node) => node.place === 'research' && node.title === 'Character Chart')).toBe(true);
    expect(source.pictures?.().length).toBeGreaterThan(0);
  });

  it('leaves a GIF out with a named loss instead of aborting the outline', async () => {
    const raw = JSON.parse(new TextDecoder().decode(fixture('simple-story.pltr'))) as Record<string, unknown>;
    raw['images'] = { 1: { id: 1, name: 'Motion', data: 'data:image/gif;base64,R0lGODdhAQABAIAAAP///////ywAAAAAAQABAAACAkQBADs=' } };
    const source = await openBytes('gif.pltr', new TextEncoder().encode(JSON.stringify(raw)));
    const plan = source.plan(settings(source), { noSplit: [], sceneAt: [], chapterAt: [] });
    expect(source.pictures?.()).toEqual([]);
    expect(plan.losses.map((loss) => loss.message).join('\n')).toContain('GIF images were left out');
  });

  it('turning images off removes picture markdown and codex visual references', async () => {
    const raw = JSON.parse(new TextDecoder().decode(fixture('simple-story.pltr'))) as Record<string, unknown>;
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    raw['images'] = { 1: { id: 1, name: 'Portrait', data: `data:image/png;base64,${png}` } };
    raw['characters'] = [{ id: 1, name: 'Ada', description: 'Navigator', imageId: 1 }];
    const source = await openBytes('no-pictures.pltr', new TextEncoder().encode(JSON.stringify(raw)));
    const initial = settings(source);
    initial.options['pictures'] = false;
    source.plan(initial, { noSplit: [], sceneAt: [], chapterAt: [] });
    const row = source.codexRows?.().find((item) => item.name === 'Ada');
    expect(row?.visualRefs).toBeUndefined();
    expect(row?.page?.body).not.toContain('import:plottr-image');
  });

  it('commits through the shared importTree shape in one plan', async () => {
    const source = await open();
    const initial = settings(source);
    const plan = source.plan(initial, { noSplit: [], sceneAt: [], chapterAt: [] });
    const commit = buildCommit({ plan, edits: NO_EDITS, destination: 'manuscript', mapping: {}, statuses: [], labels: [], statusAnswers: {}, labelAnswers: {}, codexRows: source.codexRows?.() ?? [], codexAnswers: {}, codexHeld: [], pictures: source.pictures?.() ?? [] }, PREVIEW_HELPERS);
    expect(commit.params.nodes.filter((node) => node.type === 'document')).toHaveLength(5);
    expect(commit.params.nodes[1]?.sceneMeta?.threads?.length).toBeGreaterThan(0);
    const hamlet = plottrPreviewSource('hamlet.pltr', fixture('hamlet.pltr'));
    if (hamlet.ok) {
      await hamlet.source.load?.(() => {}, new AbortController().signal);
      const hamletRow = hamlet.source.codexRows?.().find((row) => row.name === 'Hamlet');
    expect(hamletRow?.visualRefs?.length).toBe(1);
    expect(hamletRow?.keywords).toContain('Main');
    expect(hamletRow?.description).toContain('Prince of Denmark');
    expect(hamletRow?.attachmentNodes?.length).toBeGreaterThan(0);
    }
  });

  it('adds linked research notes as extra codex attachments', async () => {
    const source = await open('hamlet.pltr');
    const initial = settings(source);
    const plan = source.plan(initial, { noSplit: [], sceneAt: [], chapterAt: [] });
    const rows = source.codexRows?.() ?? [];
    const commit = buildCommit({ plan, edits: NO_EDITS, destination: 'manuscript', mapping: {}, statuses: [], labels: [], statusAnswers: {}, labelAnswers: {}, codexRows: rows, codexAnswers: {}, codexHeld: [], pictures: source.pictures?.() ?? [] }, PREVIEW_HELPERS);
    const hamlet = commit.params.codex?.entries.find((entry) => entry.name === 'Hamlet');
    expect(hamlet?.alsoAttach?.length).toBeGreaterThan(0);
    expect(hamlet?.alsoAttach?.every((at) => commit.params.nodes[at]?.place === 'research')).toBe(true);
  });
});
