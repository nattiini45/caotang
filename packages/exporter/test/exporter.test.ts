/**
 * The exporter end to end: the bus dispatches `export.compile` and
 * `export.compileSelection` into the store's registry, the registry calls the
 * exporter's port, and the artifact, the log row, the undo and the activity row are
 * all checked against the folder the exporter wrote.
 *
 * This file is where the brief's "compensable undo that deletes the emitted artifact
 * files" is proved: an undo is executed through the same `execute()` a user's click
 * goes through, and the folder is asserted afterwards.
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
  type CommandError,
  type ExecutionOutcome,
  type Result,
  type UndoStore,
} from '@caotang/bus';
import { countBody, createProjectCommandRegistry, MemoryArtifactFs, type ProjectState } from '@caotang/store';
import type { ExportRecipe } from '@caotang/store';
import { strFromU8, unzipSync } from 'fflate/browser';
import {
  createExporter,
  NoPersistentIdentifierError,
  type ByteArtifacts,
  type ExportMetadataInput,
  type ExporterService,
} from '../src/index.js';
import { BODIES, COMPILED_AT, IDS, makeProject, PROJECT_NAME } from './fixture.js';
import { pngHeaderOf } from './epub-fixtures.js';

type Dispatch = Result<ExecutionOutcome, CommandError>;

/** A stored EPUB identifier, the way an app would supply one through the metadata seam. */
const EPUB_IDENTIFIER = 'urn:uuid:3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d';

interface Rig {
  readonly state: ProjectState;
  readonly fs: MemoryArtifactFs;
  readonly exporter: ExporterService;
  readonly bus: BusContext<ProjectState>;
  readonly undo: UndoStore;
  readonly run: (name: Command['name'], params: Record<string, unknown>) => Dispatch;
  /** The byte binding's contents, when the rig has one. */
  readonly bytes: Map<string, Uint8Array>;
  /** The clock the exporter and the bus read. Set it to make a later compile. */
  readonly time: { at: number };
}

let serial = 0;

/** A fresh project, exporter and bus. The exporter is **not** awaited: a test that needs `exports/` listed says so. */
function rig(options: {
  bytes?: boolean;
  metadata?: ExportMetadataInput;
  readAsset?: (path: string) => Promise<Uint8Array | null>;
} = {}): Rig {
  const state = makeProject();
  const fs = new MemoryArtifactFs();
  const time = { at: COMPILED_AT };
  const clock = { now: () => time.at };
  const bytes = new Map<string, Uint8Array>();
  const binding: ByteArtifacts | undefined = options.bytes
    ? {
        writeBytes: async (path, data) => void bytes.set(path, data),
        removeBytes: async (path) => void bytes.delete(path),
      }
    : undefined;
  const exporter = createExporter({
    readState: () => state,
    artifacts: fs,
    ...(binding === undefined ? {} : { bytes: binding }),
    clock,
    metadata: () => options.metadata ?? {},
    ...(options.readAsset === undefined ? {} : { readAsset: options.readAsset }),
  });
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
  const run = (name: Command['name'], params: Record<string, unknown>): Dispatch => {
    serial += 1;
    const command = {
      id: `cmd_TEST${String(serial).padStart(6, '0')}`,
      name,
      params,
      issuedBy: 'user',
      createdAt: COMPILED_AT,
    } as Command;
    return execute(command, bus, registry);
  };
  return { state, fs, exporter, bus, undo, run, bytes, time };
}

function okValue(outcome: Dispatch): ExecutionOutcome {
  if (!outcome.ok) throw new Error(`refused: ${outcome.error.code}: ${outcome.error.message}`);
  return outcome.value;
}

function logRows(fs: MemoryArtifactFs): Array<Record<string, unknown>> {
  return JSON.parse(fs.snapshot()['exports/compile-log.json'] ?? '[]') as Array<Record<string, unknown>>;
}

/** The words of the four scenes the fixture compiles, counted by the store's own rule. */
function fixtureWords(): number {
  return [BODIES.prologue, BODIES.landing, BODIES.storm, BODIES.morning]
    .reduce((sum, body) => sum + countBody(body).words, 0);
}


/** A recipe as the manifest holds it: the exporter reads recipes from the state, and `recipe.save` is what writes them. */
function holdRecipe(r: { readonly state: ProjectState }, recipe: ExportRecipe): void {
  const kept = (r.state.manifest.recipes ?? []).filter((held) => held.name !== recipe.name);
  r.state.manifest.recipes = [...kept, recipe];
}

describe('export.compile — the whole manuscript', () => {
  it('writes the artifact to exports/ and returns the digest, not the blob', async () => {
    const r = rig();
    await r.exporter.ready();
    const outcome = okValue(r.run('export.compile', { format: 'md' }));
    await r.exporter.idle();

    const digest = outcome.result as { output: string; chapterCount: number; sceneCount: number; skippedDocs: string[] };
    expect(digest.output).toBe(`exports/${PROJECT_NAME}.md`);
    expect(digest.chapterCount).toBe(2);
    expect(digest.sceneCount).toBe(4);
    expect(digest.skippedDocs).toEqual(['Chapter Two → The Call', 'Chapter Three → Blank']);
    expect(r.fs.snapshot()[digest.output]).toContain('## 1. Chapter One');
  });

  it('appends one compile-log row with the spec fields, the skipped documents, and their notes', async () => {
    const r = rig();
    await r.exporter.ready();
    okValue(r.run('export.compile', { format: 'md' }));
    await r.exporter.idle();

    const rows = logRows(r.fs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      at: '2026-10-08T09:30:00.000Z',
      recipe: 'manuscript',
      format: 'md',
      output: `exports/${PROJECT_NAME}.md`,
      blockCount: 8,
      chapterCount: 2,
      sceneCount: 4,
      wordCount: fixtureWords(),
      skippedDocs: ['Chapter Two → The Call', 'Chapter Three → Blank'],
      tocIncluded: true,
      notes: ['skipped: Chapter Two → The Call (empty)', 'skipped: Chapter Three → Blank (empty)'],
    });
  });

  it('writes a §8 row whose digest says what was compiled and what was skipped, with no affected node', async () => {
    const r = rig();
    await r.exporter.ready();
    okValue(r.run('export.compile', { format: 'txt' }));

    const row = r.bus.log.entries()[0];
    expect(row?.command).toBe('export.compile');
    expect(row?.affected).toEqual([]);
    expect(row?.summary).toBe(
      `compiled 2 chapters and 4 scenes (${fixtureWords()} words) as txt to exports/${PROJECT_NAME}.txt; skipped 2 empty documents`,
    );
  });

  it('undoes to the folder before the compile: the artifact is deleted, and the log row stays', async () => {
    const r = rig();
    await r.exporter.ready();
    const outcome = okValue(r.run('export.compile', { format: 'md' }));
    await r.exporter.idle();
    const output = (outcome.result as { output: string }).output;
    expect(r.fs.snapshot()[output]).toBeDefined();

    expect(outcome.undoGroupId).toBeDefined();
    expect(r.undo.undo(outcome.undoGroupId ?? '').ok).toBe(true);
    await r.exporter.idle();

    expect(r.fs.snapshot()[output]).toBeUndefined();
    expect(logRows(r.fs)).toHaveLength(1);
  });

  it('auto-versions a second compile of the same name, and keeps the first', async () => {
    const r = rig();
    await r.exporter.ready();
    const first = (okValue(r.run('export.compile', { format: 'md' })).result as { output: string }).output;
    const second = (okValue(r.run('export.compile', { format: 'md' })).result as { output: string }).output;
    await r.exporter.idle();

    expect(first).toBe(`exports/${PROJECT_NAME}.md`);
    expect(second).toBe(`exports/${PROJECT_NAME}-2.md`);
    expect(r.fs.snapshot()[first]).toBeDefined();
    expect(r.fs.snapshot()[second]).toBeDefined();
  });

  it('compiles EPUB through the bus when a byte binding and a stored identifier are attached, and logs the language fallback', async () => {
    const r = rig({ bytes: true, metadata: { identifier: EPUB_IDENTIFIER } });
    await r.exporter.ready();
    const outcome = okValue(r.run('export.compile', { format: 'epub' }));
    await r.exporter.idle();

    const output = (outcome.result as { output: string }).output;
    expect(output).toBe(`exports/${PROJECT_NAME}.epub`);
    const files = unzipSync(r.bytes.get(output) ?? new Uint8Array());
    expect(Object.keys(files)[0]).toBe('mimetype');
    expect(strFromU8(files['mimetype'] ?? new Uint8Array())).toBe('application/epub+zip');
    expect(strFromU8(files['OEBPS/content.opf'] ?? new Uint8Array())).toContain(
      `<dc:identifier id="pub-id">${EPUB_IDENTIFIER}</dc:identifier>`,
    );

    const notes = (logRows(r.fs)[0]?.['notes'] ?? []) as string[];
    expect(logRows(r.fs)[0]?.['output']).toBe(output);
    expect(notes.some((note) => note.startsWith('epub: the project has no language on record'))).toBe(true);
    expect(notes.some((note) => note.includes('persistent identifier'))).toBe(false);
  });

  it('reads the cover through the asset reader, so an image the artifact port does not hold still reaches the EPUB', async () => {
    const cover = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const coverPath = 'assets/a_ABCDEFGHJK.png';
    const asked: string[] = [];
    const r = rig({
      bytes: true,
      metadata: { identifier: EPUB_IDENTIFIER, coverAssetId: 'a_ABCDEFGHJK' },
      readAsset: async (path) => {
        asked.push(path);
        return path === coverPath ? cover : null;
      },
    });
    await r.exporter.ready();
    const outcome = okValue(r.run('export.compile', { format: 'epub' }));
    await r.exporter.idle();

    const output = (outcome.result as { output: string }).output;
    const files = unzipSync(r.bytes.get(output) ?? new Uint8Array());
    expect(strFromU8(files['OEBPS/content.opf'] ?? new Uint8Array())).toContain('properties="cover-image"');
    expect(Array.from(files['OEBPS/cover.png'] ?? [])).toEqual(Array.from(cover));
    expect(asked).toContain(coverPath);
  });

  it('notes in the compile log a cover below the retail minimum on its short side, and no cover at or above it', async () => {
    const notesFor = async (width: number, height: number): Promise<string[]> => {
      const r = rig({
        bytes: true,
        metadata: { identifier: EPUB_IDENTIFIER, coverAssetId: 'a_ABCDEFGHJK' },
        readAsset: async (path) => (path === 'assets/a_ABCDEFGHJK.png' ? pngHeaderOf(width, height) : null),
      });
      await r.exporter.ready();
      okValue(r.run('export.compile', { format: 'epub' }));
      await r.exporter.idle();
      return (logRows(r.fs)[0]?.['notes'] ?? []) as string[];
    };
    // The short side decides it: a tall cover that is 1000 px across is below the minimum, and one 1400 px across is not.
    const small = await notesFor(800, 1000);
    expect(small.some((note) => note.startsWith('epub: cover below common retail minimums'))).toBe(true);
    expect(small.find((note) => note.includes('retail minimums'))).toContain('its short side is 800 px');
    const atMinimum = await notesFor(1400, 2100);
    expect(atMinimum.some((note) => note.includes('retail minimums'))).toBe(false);
  });

  it('gives the same cover note on a download, which is the compile log the download carries', async () => {
    const r = rig({
      bytes: true,
      metadata: { identifier: EPUB_IDENTIFIER, coverAssetId: 'a_ABCDEFGHJK' },
      readAsset: async (path) => (path === 'assets/a_ABCDEFGHJK.png' ? pngHeaderOf(600, 800) : null),
    });
    await r.exporter.ready();
    const result = await r.exporter.compile({ includeRootIds: ['manuscript'] }, 'epub');
    expect(result.log.notes.some((note) => note.startsWith('epub: cover below common retail minimums'))).toBe(true);
  });

  it('compiles the EPUB without a cover when the asset reader does not hold the named file, and says so in the log', async () => {
    const r = rig({
      bytes: true,
      metadata: { identifier: EPUB_IDENTIFIER, coverAssetId: 'a_ABCDEFGHJK' },
      readAsset: async () => null,
    });
    await r.exporter.ready();
    const outcome = okValue(r.run('export.compile', { format: 'epub' }));
    await r.exporter.idle();

    const output = (outcome.result as { output: string }).output;
    const files = unzipSync(r.bytes.get(output) ?? new Uint8Array());
    expect(strFromU8(files['OEBPS/content.opf'] ?? new Uint8Array())).not.toContain('cover-image');
    // The writer set a cover; dropping it silently would read as if it were never considered. The book is still valid
    // without one, so this is a note and not a refusal.
    const notes = (logRows(r.fs)[0]?.['notes'] ?? []) as string[];
    expect(notes.some((note) => note.includes('cover asset on record') && note.includes('no cover'))).toBe(true);
  });

  it('undoes a binary compile by removing it from the byte binding', async () => {
    const r = rig({ bytes: true });
    await r.exporter.ready();
    const outcome = okValue(r.run('export.compile', { format: 'docx' }));
    await r.exporter.idle();
    const output = (outcome.result as { output: string }).output;
    expect(r.bytes.has(output)).toBe(true);

    r.undo.undo(outcome.undoGroupId ?? '');
    await r.exporter.idle();
    expect(r.bytes.has(output)).toBe(false);
  });
});

describe('export.compileSelection — a part', () => {
  it('compiles only the named nodes, research included when it is named, under the node\'s name', async () => {
    const r = rig();
    await r.exporter.ready();
    const outcome = okValue(r.run('export.compileSelection', { includeRootIds: [IDS.timetable], format: 'md' }));
    await r.exporter.idle();

    const output = (outcome.result as { output: string; sceneCount: number }).output;
    expect(output).toBe('exports/Ferry timetable.md');
    expect((outcome.result as { sceneCount: number }).sceneCount).toBe(1);
    expect(r.fs.snapshot()[output]).toContain('Ferry at nine.');
    expect(r.fs.snapshot()[output]).not.toContain('## ');
  });

  it('refuses a selection that names a node the tree does not hold, as the recipe path does', () => {
    const r = rig();
    const outcome = r.run('export.compileSelection', { includeRootIds: [IDS.morning, 'n_NOSUCHNODE'], format: 'txt' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('not-found');
    expect(outcome.error.message).toContain('n_NOSUCHNODE');
    expect(r.bus.log.length).toBe(0);
    expect(r.undo.groups()).toHaveLength(0);
  });

  it('refuses an empty selection before the exporter is asked anything', () => {
    const r = rig();
    let asked = 0;
    const registry = createProjectCommandRegistry({
      clock: { now: () => COMPILED_AT },
      exporter: {
        compile: (state, request) => {
          asked += 1;
          return r.exporter.commandPort().compile(state, request);
        },
      },
    });
    const result = execute(
      {
        id: 'cmd_EMPTYSEL01',
        name: 'export.compileSelection',
        params: { includeRootIds: [], format: 'md' },
        issuedBy: 'user',
        createdAt: COMPILED_AT,
      } as Command,
      r.bus,
      registry,
    );
    expect(result.ok).toBe(false);
    expect(asked).toBe(0);
  });
});

describe('export.compile with a recipe', () => {
  it("compiles the recipe's selection under the recipe's name, to the format the command asks for", async () => {
    const r = rig();
    await r.exporter.ready();
    holdRecipe(r, {
      name: 'Research notes',
      includeRootIds: ['research'],
      format: 'docx',
      templateId: 'default',
      options: { titlePage: false, toc: false },
    });
    const outcome = okValue(r.run('export.compile', { format: 'txt', recipeName: 'Research notes' }));
    await r.exporter.idle();

    const output = (outcome.result as { output: string }).output;
    expect(output).toBe('exports/Research notes.txt');
    expect(r.fs.snapshot()[output]).toBe('Ferry at nine.\n');
  });

  it('refuses a recipe that does not exist, with nothing logged or grouped', () => {
    const r = rig();
    const outcome = r.run('export.compile', { format: 'md', recipeName: 'Nope' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The bus checks the name at validate, before any apply, so the refusal is the bus's own sentence.
    expect(outcome.error.message).toContain('there is no saved recipe named "Nope"');
    expect(r.bus.log.length).toBe(0);
    expect(r.undo.groups()).toHaveLength(0);
  });

  // The bus refuses a recipe name it does not hold at validate, as not-found, with the saved recipe names in the hint, and no undo
  // group or activity row. The exporter's own refusal for the same name (UnknownRecipeError, an ApplyRefusal) stays as the back-stop
  // for a caller that reaches the apply without the bus. It was a KNOWN GAP while the bus had no channel for an apply to refuse.
  it('an unknown recipe is not-found with a corrective hint, not internal', () => {
    const r = rig();
    const outcome = r.run('export.compile', { format: 'md', recipeName: 'Nope' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('not-found');
    expect(outcome.error.correctiveHint ?? '', 'the hint names the recipes that exist').toBeTruthy();
    expect(outcome.error.correctiveHint ?? '').not.toContain('defect in the apply');
  });
});

describe('refusals — nothing is written, logged or grouped', () => {
  it('refuses DOCX through the bus when no byte binding is attached, and says why', () => {
    const r = rig();
    const outcome = r.run('export.compile', { format: 'docx' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toContain('has no byte binding');
    expect(r.bus.log.length).toBe(0);
    expect(r.undo.groups()).toHaveLength(0);
  });

  // The same channel as the recipe refusal above: an ApplyRefusal, so invalid-params with the hint, not `internal`.
  it('a binary format with no byte binding is invalid-params with a corrective hint, not internal', () => {
    const r = rig();
    const outcome = r.run('export.compile', { format: 'docx' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('invalid-params');
    expect(outcome.error.correctiveHint ?? '', 'the hint says what to do').toBeTruthy();
    expect(outcome.error.correctiveHint ?? '').not.toContain('defect in the apply');
    // The hint names only formats the same gate accepts without a byte store. EPUB is a binary artifact
    // (BINARY_FORMATS), so pointing the writer at it would send them into the identical refusal.
    expect(outcome.error.correctiveHint ?? '').toContain('compile as md or txt');
    expect(outcome.error.correctiveHint ?? '').not.toContain('epub');
  });

  it('refuses a format this build does not compile, and names the formats it does', () => {
    const r = rig();
    const outcome = r.run('export.compile', { format: 'rtf' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toContain('"rtf" is not an export format in this build');
    // `rtf` is the probe for a format nothing ships.
    expect(outcome.error.message).toContain(
      'The formats are md, txt, docx, epub, fountain, fdx, ink-json, dialogue-csv, shot-list-csv, promptpack, coherence-md, coherence-json, dialogue-xlsx, shot-list-xlsx, pdf, contact-sheet-pdf.',
    );
    expect(r.bus.log.length).toBe(0);
    expect(r.undo.groups()).toHaveLength(0);
  });

  // The enum check is the bus validator's (packages/bus/src/descriptors.ts, `EXPORT_FORMATS`),
  // so an unknown format is refused before any apply, as invalid-params with a hint.
  it('an unknown format is invalid-params with a corrective hint, from the bus validator', () => {
    const r = rig();
    const outcome = r.run('export.compile', { format: 'rtf' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('invalid-params');
    expect(outcome.error.correctiveHint ?? '', 'the hint names the formats that exist').toBeTruthy();
    expect(outcome.error.correctiveHint ?? '').not.toContain('defect in the apply');
  });

  it('refuses to compile before exports/ has been listed, rather than guessing a name', () => {
    const r = rig();
    const outcome = r.run('export.compile', { format: 'md' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toContain('has not listed exports/ yet');
    expect(r.bus.log.length).toBe(0);
    expect(r.undo.groups()).toHaveLength(0);
    expect(r.fs.snapshot()).toEqual({});
  });
});

describe('exporter.compile — the §4 API, which downloads and writes nothing', () => {
  it('returns a blob of the right type and the log row it would append, and writes no file', async () => {
    const r = rig();
    await r.exporter.ready();
    const result = await r.exporter.compile({ includeRootIds: ['manuscript'] }, 'md');

    expect(result.fileName).toBe(`${PROJECT_NAME}.md`);
    expect(result.mimeType).toBe('text/markdown;charset=utf-8');
    expect(result.blob.size).toBeGreaterThan(0);
    expect(await result.blob.text()).toContain('## 1. Chapter One');
    expect(result.log.output).toBeNull();
    expect(result.log.skippedDocs).toHaveLength(2);
    expect(r.fs.snapshot()).toEqual({});
  });

  it('returns a DOCX blob for download even with no byte binding, since a download needs no folder', async () => {
    const r = rig();
    const result = await r.exporter.compile({ includeRootIds: ['manuscript'] }, 'docx');
    expect(result.blob.type).toContain('wordprocessingml.document');
    expect(result.blob.size).toBeGreaterThan(0);
  });

  it('previews the block list the compile will use', () => {
    const r = rig();
    const blocks = r.exporter.previewFlatten({ includeRootIds: ['manuscript'] });
    expect(blocks[0]).toEqual({ kind: 'frontmatter', fmKind: 'titlepage' });
    expect(blocks.filter((block) => block.kind === 'chapter')).toHaveLength(2);
  });
});

describe('the EPUB identifier — stored with the project, never derived from it (epub-metadata.md §5.5.2)', () => {
  const identifierIn = (opf: string): string | undefined => opf.match(/<dc:identifier id="pub-id">([^<]+)<\/dc:identifier>/)?.[1];

  /** The package document of an EPUB compiled through the §4 API, which downloads and writes nothing. */
  async function opfOf(r: Rig): Promise<string> {
    const result = await r.exporter.compile({ includeRootIds: ['manuscript'] }, 'epub');
    const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    return strFromU8(files['OEBPS/content.opf'] ?? new Uint8Array());
  }

  it('is byte-identical across two compiles, a later compile, a rename and a reassigned project id', async () => {
    const r = rig({ metadata: { identifier: EPUB_IDENTIFIER } });
    await r.exporter.ready();

    const first = await opfOf(r);
    const second = await opfOf(r);
    r.time.at = Date.parse('2026-10-09T11:00:00.000Z');
    const later = await opfOf(r);
    r.state.manifest.project.name = 'The Lantern Keeper';
    const renamed = await opfOf(r);
    r.state.manifest.project.id = 'p_RECOVERED01';
    const reassigned = await opfOf(r);

    expect(identifierIn(first)).toBe(EPUB_IDENTIFIER);
    expect([identifierIn(second), identifierIn(later), identifierIn(renamed), identifierIn(reassigned)]).toEqual([
      EPUB_IDENTIFIER,
      EPUB_IDENTIFIER,
      EPUB_IDENTIFIER,
      EPUB_IDENTIFIER,
    ]);
    // The rest of the package does move, so the equal identifiers are not a stale copy.
    expect(later).toContain('<meta property="dcterms:modified">2026-10-09T11:00:00Z</meta>');
    expect(renamed).toContain('<dc:title>The Lantern Keeper</dc:title>');
  });

  it.each([
    ['no identifier on record', {}],
    ['a blank identifier', { identifier: '   ' }],
  ])('refuses an EPUB with %s, through the bus and the §4 API, and writes nothing', async (_label, metadata) => {
    const r = rig({ bytes: true, metadata });
    await r.exporter.ready();

    const outcome = r.run('export.compile', { format: 'epub' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toContain('has no persistent identifier on record');
    expect(outcome.error.message).toContain('Nothing was compiled or written');
    // The hint names the routes a caller can take from where it stands: another format now, or the writer opening the project in Caotang.
    expect(outcome.error.correctiveHint).toContain('compile as md, txt or docx now');
    expect(outcome.error.correctiveHint).toContain('open the project in Caotang');
    await r.exporter.idle();
    expect(r.bus.log.length).toBe(0);
    expect(r.undo.groups()).toHaveLength(0);
    expect(r.bytes.size).toBe(0);
    expect(r.fs.snapshot()).toEqual({});

    await expect(r.exporter.compile({ includeRootIds: ['manuscript'] }, 'epub')).rejects.toBeInstanceOf(
      NoPersistentIdentifierError,
    );
  });

  it('does not refuse the other formats for want of an identifier', async () => {
    const r = rig();
    await r.exporter.ready();
    expect(r.run('export.compile', { format: 'md' }).ok).toBe(true);
    await r.exporter.idle();
  });
});

describe('recipes — the named selections', () => {
  it('lists the default Manuscript recipe before any is saved', () => {
    const r = rig();
    expect(r.exporter.listRecipes().map((recipe) => recipe.name)).toEqual(['Manuscript']);
  });

  // Recipes are the manifest's. The exporter reads them from the state it compiles and writes none; `recipe.save`
  // and `recipe.delete` are the writers, and their refusals are the bus's (descriptors-project.test.ts).
  it('lists a recipe the manifest holds, after the default', () => {
    const r = rig();
    holdRecipe(r, { name: 'Beta read', includeRootIds: ['manuscript'], format: 'epub', templateId: 'default', options: {} });
    expect(r.exporter.listRecipes().map((recipe) => recipe.name)).toEqual(['Manuscript', 'Beta read']);
  });

  it('reads the recipes from the state at each call, so one removed from the manifest is no longer listed', () => {
    const r = rig();
    holdRecipe(r, { name: 'Beta read', includeRootIds: ['manuscript'], format: 'epub', options: {} });
    r.state.manifest.recipes = (r.state.manifest.recipes ?? []).filter((recipe) => recipe.name !== 'Beta read');
    expect(r.exporter.listRecipes().map((recipe) => recipe.name)).toEqual(['Manuscript']);
  });

  it('lists no recipe for a project whose recipes were all deleted', () => {
    const r = rig();
    r.state.manifest.recipes = [];
    expect(r.exporter.listRecipes()).toEqual([]);
  });

  it('leaves out a recipe in a format this build does not compile, rather than listing one it cannot run', () => {
    const r = rig();
    holdRecipe(r, { name: 'X', includeRootIds: ['manuscript'], format: 'rtf', templateId: 'default', options: {} });
    expect(r.exporter.listRecipes().map((recipe) => recipe.name)).toEqual(['Manuscript']);
  });
});
