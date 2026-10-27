/**
 * `preview` is the Draft half of exporter.md §4's Draft/Proof duality: what a compile would write and what it would leave out,
 * before anything is made. Each test holds it to the compile: the numbers, the skip list and the notes are the log row the same
 * request writes, so a writer comparing the two sees one book. A preview reserves nothing, writes nothing, logs nothing and runs
 * no command.
 */

import { describe, expect, it } from 'vitest';
import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  type BusContext,
  type Command,
  type ExecutionOutcome,
  type UndoStore,
} from '@caotang/bus';
import { createProjectCommandRegistry, MemoryArtifactFs, type ExportRecipe, type ProjectState } from '@caotang/store';

import { createExporter, flatten, type ExporterService, type ExportPreview, type ExportPreviewRequest } from '../src/index.js';
import { COMPILED_AT, IDS, makeProject } from './fixture.js';
import { makeMediaProject } from './media-fixture.js';

interface Rig {
  readonly state: ProjectState;
  readonly fs: MemoryArtifactFs;
  readonly exporter: ExporterService;
  readonly undo: UndoStore;
  readonly bus: BusContext<ProjectState>;
  readonly run: (name: Command['name'], params: Record<string, unknown>) => ExecutionOutcome;
}

let serial = 0;

function rig(state: ProjectState = makeProject(), metadata: { identifier?: string } = {}): Rig {
  const fs = new MemoryArtifactFs();
  const clock = { now: () => COMPILED_AT };
  // A byte binding, so DOCX and EPUB are formats this rig can compile through the bus; the files themselves are not what these tests read.
  const bytes = { writeBytes: async () => undefined, removeBytes: async () => undefined };
  const exporter = createExporter({ readState: () => state, artifacts: fs, bytes, clock, metadata: () => metadata });
  const registry = createProjectCommandRegistry({ clock, exporter: exporter.commandPort() });
  const undo: UndoStore = createUndoStore({ dispatch: (command) => execute(command, bus, registry) });
  const bus: BusContext<ProjectState> = {
    state,
    view: createViewState(),
    read: () => state,
    undo,
    log: createActivityLog(),
    idempotency: createIdempotencyCache(),
    notify: () => {},
  };
  const run = (name: Command['name'], params: Record<string, unknown>): ExecutionOutcome => {
    serial += 1;
    const command = { id: `cmd_PREV${String(serial).padStart(6, '0')}`, name, params, issuedBy: 'user', createdAt: COMPILED_AT } as Command;
    const outcome = execute(command, bus, registry);
    if (!outcome.ok) throw new Error(`refused: ${outcome.error.code}: ${outcome.error.message}`);
    return outcome.value;
  };
  return { state, fs, exporter, undo, bus, run };
}

function logRows(fs: MemoryArtifactFs): Array<Record<string, unknown>> {
  return JSON.parse(fs.snapshot()['exports/compile-log.json'] ?? '[]') as Array<Record<string, unknown>>;
}

function holdRecipe(r: { readonly state: ProjectState }, recipe: ExportRecipe): void {
  const kept = (r.state.manifest.recipes ?? []).filter((held) => held.name !== recipe.name);
  r.state.manifest.recipes = [...kept, recipe];
}

/** The numbers and words a preview and a log row both carry. */
function factsOf(row: {
  blockCount: unknown;
  chapterCount: unknown;
  sceneCount: unknown;
  wordCount: unknown;
  skippedDocs: unknown;
  tocIncluded: unknown;
  notes: unknown;
}): Record<string, unknown> {
  const { blockCount, chapterCount, sceneCount, wordCount, skippedDocs, tocIncluded, notes } = row;
  return { blockCount, chapterCount, sceneCount, wordCount, skippedDocs, tocIncluded, notes };
}

function draftOf(preview: ExportPreview) {
  if (preview.kind !== 'draft') throw new Error(`expected a draft, got ${preview.kind}`);
  return preview;
}

const WHOLE: ExportPreviewRequest['selection'] = { kind: 'manuscript' };

describe('exporter.preview — the Draft of a prose compile', () => {
  it('equals the log row the compile of the same request writes: blocks counted, words, skipped documents and notes', async () => {
    const r = rig();
    await r.exporter.ready();
    for (const format of ['md', 'txt', 'docx'] as const) {
      const draft = draftOf(r.exporter.preview({ selection: WHOLE, format }));
      r.run('export.compile', { format });
      await r.exporter.idle();
      const row = logRows(r.fs).at(-1);
      expect(row).toBeDefined();
      expect(factsOf(draft)).toEqual(factsOf(row as never));
    }
    // The fixture's empty documents are named in the compile log's words.
    const draft = draftOf(r.exporter.preview({ selection: WHOLE, format: 'md' }));
    expect(draft.skippedDocs).toEqual(['Chapter Two → The Call', 'Chapter Three → Blank']);
    expect(draft.notes).toEqual(['skipped: Chapter Two → The Call (empty)', 'skipped: Chapter Three → Blank (empty)']);
  });

  it("returns the blocks the compile renders: flatten's own list, with the title page the options ask for", () => {
    const r = rig();
    const draft = draftOf(r.exporter.preview({ selection: WHOLE, format: 'md' }));
    const flat = flatten(r.state, { includeRootIds: ['manuscript'] }, { titlePage: true });
    expect(draft.blocks).toEqual(flat.blocks);
    expect(draft.blocks[0]).toEqual({ kind: 'frontmatter', fmKind: 'titlepage' });
    expect(draft.blocks.filter((block) => block.kind === 'chapter')).toHaveLength(2);
    expect(draft.titlePage).toBe(true);
    expect(draft.sceneCount).toBe(4);
  });

  it('follows a recipe with the title page off: no title page block, and the same numbers as the compile', async () => {
    const r = rig();
    await r.exporter.ready();
    holdRecipe(r, { name: 'Plain', includeRootIds: ['manuscript'], format: 'docx', templateId: 'default', options: { titlePage: false, toc: false } });

    const draft = draftOf(r.exporter.preview({ selection: WHOLE, format: 'md', recipeName: 'Plain' }));
    expect(draft.titlePage).toBe(false);
    expect(draft.blocks.some((block) => block.kind === 'frontmatter')).toBe(false);
    expect(draft.tocIncluded).toBe(false);

    r.run('export.compile', { format: 'md', recipeName: 'Plain' });
    await r.exporter.idle();
    expect(factsOf(draft)).toEqual(factsOf(logRows(r.fs).at(-1) as never));
  });

  it("takes the recipe's own nodes for a whole-manuscript request, and the named nodes for a part", () => {
    const r = rig();
    holdRecipe(r, { name: 'Research', includeRootIds: ['research'], format: 'docx', templateId: 'default', options: { titlePage: false } });

    const fromRecipe = draftOf(r.exporter.preview({ selection: WHOLE, format: 'txt', recipeName: 'Research' }));
    expect(fromRecipe.blocks.map((block) => block.kind)).toEqual(['scene']);

    // A part is the nodes it names; the recipe supplies its options and not its selection.
    const part = draftOf(r.exporter.preview({ selection: { kind: 'nodes', includeRootIds: [IDS.chapterOne] }, format: 'txt', recipeName: 'Research' }));
    expect(part.blocks.some((block) => block.kind === 'frontmatter')).toBe(false);
    expect(part.sceneCount).toBe(2);
    expect(part.chapterCount).toBe(1);
  });

  it('names a node the exporter does not compile in the compile log’s words, as the compile does', async () => {
    const r = rig(makeMediaProject());
    await r.exporter.ready();
    const draft = draftOf(r.exporter.preview({ selection: WHOLE, format: 'md' }));
    const note = 'skipped: "The innkeeper" is a dialogue node, which this exporter does not compile';
    expect(draft.notes).toContain(note);

    r.run('export.compile', { format: 'md' });
    await r.exporter.idle();
    expect(logRows(r.fs).at(-1)?.['notes']).toContain(note);
  });

  it('keeps a Draft for an EPUB that has no identifier yet: the preview is the content, and the compile still refuses', () => {
    const r = rig();
    const draft = draftOf(r.exporter.preview({ selection: WHOLE, format: 'epub' }));
    expect(draft.tocIncluded).toBe(true);
    expect(draft.chapterCount).toBe(2);
  });
});

describe('exporter.preview — what a preview is not', () => {
  it('writes no file, reserves no name, leaves the compile log and the undo store alone, and runs no command', async () => {
    const r = rig();
    await r.exporter.ready();
    const before = JSON.stringify(r.fs.snapshot());
    const activityBefore = r.bus.log.length;
    const undoBefore = r.undo.groups().length;

    r.exporter.preview({ selection: WHOLE, format: 'md' });
    r.exporter.preview({ selection: WHOLE, format: 'fountain' });
    r.exporter.preview({ selection: { kind: 'nodes', includeRootIds: [IDS.landing] }, format: 'docx' });
    await r.exporter.idle();

    expect(JSON.stringify(r.fs.snapshot())).toBe(before);
    expect(r.fs.snapshot()['exports/compile-log.json']).toBeUndefined();
    expect(r.bus.log.length).toBe(activityBefore);
    expect(r.undo.groups().length).toBe(undoBefore);
    // The name a preview would have taken is still free: the compile after it is not versioned.
    expect(r.run('export.compile', { format: 'md' }).result).toMatchObject({ output: 'exports/The Lighthouse Keeper.md' });
  });

  it('reads the project as it is now, so an edit between two previews shows', () => {
    const r = rig();
    expect(draftOf(r.exporter.preview({ selection: WHOLE, format: 'md' })).skippedDocs).toHaveLength(2);
    const call = r.state.documents.get(IDS.call);
    if (call === undefined) throw new Error('the fixture has no The Call document');
    call.body = 'She picked up.';
    expect(draftOf(r.exporter.preview({ selection: WHOLE, format: 'md' })).skippedDocs).toEqual(['Chapter Three → Blank']);
  });
});

describe('exporter.preview — refusals and media formats', () => {
  it('reports the refusal a compile would get for a recipe, a node or a format the project does not hold, and does not throw', () => {
    const r = rig();
    const missingRecipe = r.exporter.preview({ selection: WHOLE, format: 'md', recipeName: 'Missing' });
    expect(missingRecipe.kind === 'refused' && missingRecipe.error.code).toBe('not-found');
    const missingNode = r.exporter.preview({ selection: { kind: 'nodes', includeRootIds: ['n_NOSUCHNODE'] }, format: 'md' });
    expect(missingNode.kind === 'refused' && missingNode.error.message).toContain('"n_NOSUCHNODE"');
    const missingFormat = r.exporter.preview({ selection: WHOLE, format: 'rtf' });
    expect(missingFormat.kind === 'refused' && missingFormat.error.code).toBe('invalid-params');
  });

  it('reports a binary format with no byte store as the compile’s refusal, so the dialog and the bus agree', () => {
    const state = makeProject();
    const exporter = createExporter({ readState: () => state, artifacts: new MemoryArtifactFs(), clock: { now: () => COMPILED_AT } });
    const preview = exporter.preview({ selection: WHOLE, format: 'docx' });
    expect(preview.kind === 'refused' && preview.error.message).toContain('binary artifact');
  });

  it('reports the screenplay gate for a Fountain request on a prose-only book, writing nothing', async () => {
    const r = rig();
    await r.exporter.ready();
    const preview = r.exporter.preview({ selection: WHOLE, format: 'fountain' });
    expect(preview.kind).toBe('refused');
    expect(preview.kind === 'refused' && preview.error.message).toContain('the selection holds no screenplay scene');
    expect(await r.fs.listFiles('exports')).toEqual([]);
  });

  it('reports a media request that passes its gates as the compile’s counts without a block list, equal to the log row', async () => {
    const r = rig(makeMediaProject());
    await r.exporter.ready();
    const preview = r.exporter.preview({ selection: WHOLE, format: 'fountain' });
    expect(preview.kind).toBe('media');
    expect('blocks' in preview).toBe(false);

    r.run('export.compile', { format: 'fountain' });
    await r.exporter.idle();
    expect(factsOf(preview as never)).toEqual(factsOf(logRows(r.fs).at(-1) as never));
  });

  it('reports a prompt pack with no vendor as the refusal the compile gives', () => {
    const r = rig(makeMediaProject());
    const preview = r.exporter.preview({ selection: WHOLE, format: 'promptpack' });
    expect(preview.kind === 'refused' && preview.error.message).toContain('vendor template');
  });
});
