/**
 * The Highland preview source (issue #284): the shared preview over the Worker's Highland read. The Fountain structure becomes
 * screenplay documents under their sections, the assets ride along (placed ones in their scene, unplaced ones in a Pictures
 * chapter), and the commit is one binder.importTree with the document kind. The reader itself is covered in
 * packages/import-highland and the Worker dispatch in import-highland-session.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pinFormatLocale } from '../src/i18n/locale.js';
import { activateEnglish } from '../src/i18n/runtime.js';
import { PREVIEW_HELPERS } from '../src/import-preview/helpers.js';
import { NO_EDITS, buildCommit, initialSettings, type CommitInput, type ImportPreviewSource, type PreviewPlan } from '../src/import-preview/model.js';
import { highlandPreviewSource } from '../src/import-preview/highland-source.js';
import { createReaderSession } from '../src/import-preview/reader-session.js';
import type { ReaderOpen, ReaderRead } from '../src/import-preview/reader-protocol.js';
import { textZip } from '../../../packages/import-read/test/zip-fixtures.js';

/** An in-process stand-in for the preview's `'self'` Worker, running the same reader session the real Worker runs. */
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

const SCRIPT = [
  'Title: The Landing',
  '',
  '# Act One',
  '',
  'INT. HARBOUR - DAY',
  '',
  'Mara watches the ferry. ![map](assets/referenced.png)',
  '',
  'EXT. ROCKS - NIGHT',
  '',
  'The lamp turns.',
].join('\n');

function package_(extra: Record<string, string> = {}): Uint8Array {
  return textZip({
    'text.fountain': SCRIPT,
    'info.json': JSON.stringify({ title: 'The Landing' }),
    'assets/referenced.png': 'placed-picture-bytes',
    'assets/unplaced.png': 'unplaced-picture-bytes',
    'bin/trashed.fountain': 'INT. DELETED - DAY',
    ...extra,
  });
}

async function loaded(bytes: Uint8Array, fileName = 'story.highland'): Promise<ImportPreviewSource> {
  const source = highlandPreviewSource(fileName, bytes);
  await source.load?.(() => undefined, new AbortController().signal);
  return source;
}

function planOf(source: ImportPreviewSource): PreviewPlan {
  return source.plan(initialSettings(source.chips(), source.options()), NO_EDITS.overrides);
}

function commitOf(source: ImportPreviewSource, plan: PreviewPlan): ReturnType<typeof buildCommit> {
  const settings = initialSettings(source.chips(), source.options());
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
    pictures: source.picturesOption === undefined || settings.options[source.picturesOption] === true ? (source.pictures?.() ?? []) : [],
  };
  return buildCommit(input, PREVIEW_HELPERS);
}

describe('the Highland preview source', () => {
  it('makes screenplay documents under their sections, and reports the bin as a loss', async () => {
    const source = await loaded(package_());
    const plan = planOf(source);
    expect(plan.counts.scenes).toBeGreaterThanOrEqual(2);
    expect(plan.losses.some((loss) => loss.message.startsWith('bin/'))).toBe(true);
    // Every scene node carries the screenplay kind; the sections are folders.
    const kinds: string[] = [];
    const walk = (nodes: readonly { role: string; kind?: string; children?: readonly unknown[] }[]): void => {
      for (const node of nodes) {
        if (node.role === 'scene') kinds.push(node.kind ?? 'prose');
        walk((node.children ?? []) as typeof nodes);
      }
    };
    walk(plan.tree);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every((kind) => kind === 'screenplay')).toBe(true);
    expect(source.metadata?.().title).toBe('The Landing');
  });

  it('commits one binder.importTree whose documents carry the screenplay kind and whose pictures ride along', async () => {
    const source = await loaded(package_());
    const plan = planOf(source);
    const commit = commitOf(source, plan);
    const documents = commit.params.nodes.filter((node) => node.type === 'document');
    expect(documents.length).toBeGreaterThan(0);
    expect(documents.every((node) => node.kind === 'screenplay')).toBe(true);
    // Both the placed and the unplaced picture are imported.
    expect(commit.pictures.map((picture) => picture.ref).sort()).toEqual(['import:assets/referenced.png', 'import:assets/unplaced.png']);
    // The placed picture's ref was rewritten into its scene's body; the unplaced one sits in a Pictures chapter.
    const bodies = commit.params.nodes.map((node) => node.body ?? '').join('\n');
    expect(bodies).toContain('](import:assets/referenced.png)');
    expect(bodies).toContain('](import:assets/unplaced.png)');
    expect(bodies).not.toContain('](assets/');
  });

  it('leaves the pictures out when the pictures option is off', async () => {
    const source = await loaded(package_());
    const plan = planOf(source);
    const settings = initialSettings(source.chips(), source.options());
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
    const commit = buildCommit(input, PREVIEW_HELPERS);
    expect(commit.pictures).toEqual([]);
    expect(settings.options[source.picturesOption ?? '']).toBe(true);
  });

  it('refuses a package with no script, without throwing', async () => {
    const source = highlandPreviewSource('empty.highland', textZip({ 'info.json': '{}' }));
    await expect(source.load?.(() => undefined, new AbortController().signal)).rejects.toThrow();
  });
});
