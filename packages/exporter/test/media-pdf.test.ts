/**
 * The screenplay PDF (screenplay.md §5.3) as an export format: through the §4 API and through the bus, as a user's click
 * dispatches it. The page layout itself is the screenplay package's (paginate.test.ts, pdf.test.ts); these tests check what
 * the exporter owns: the gate, the file name and type, the embedded font, the log row, the byte store, the undo, and the
 * recipe options that reach the layout.
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
import { createProjectCommandRegistry, MemoryArtifactFs, type ExportRecipe, type ProjectState } from '@caotang/store';
import { loadCjkFontInNode, loadEmojiFontInNode } from '@caotang/pdf-fonts/node-loader';
import { createExporter, EXPORT_MIME, isBinaryFormat, isMediaFormat, MediaRefusedError, type ByteArtifacts, type ExporterService } from '../src/index.js';
import { COMPILED_AT } from './fixture.js';
import { ASSETS, MEDIA_IDS, PROJECT_NAME, makeMediaProject } from './media-fixture.js';

type Dispatch = Result<ExecutionOutcome, CommandError>;

interface Rig {
  readonly state: ProjectState;
  readonly fs: MemoryArtifactFs;
  readonly exporter: ExporterService;
  readonly undo: UndoStore;
  readonly bytes: Map<string, Uint8Array>;
  readonly run: (name: Command['name'], params: Record<string, unknown>) => Dispatch;
}

let serial = 0;

function rig(options: { bytes?: boolean; state?: ProjectState; fonts?: boolean } = {}): Rig {
  const state = options.state ?? makeMediaProject();
  const fs = new MemoryArtifactFs();
  const clock = { now: () => COMPILED_AT };
  const bytes = new Map<string, Uint8Array>();
  const binding: ByteArtifacts | undefined =
    options.bytes === false
      ? undefined
      : { writeBytes: async (path, data) => void bytes.set(path, data), removeBytes: async (path) => void bytes.delete(path) };
  const exporter = createExporter({
    readState: () => state,
    artifacts: fs,
    ...(binding === undefined ? {} : { bytes: binding }),
    clock,
    metadata: () => ({ author: 'Ada Lovelace' }),
    assets: () => ASSETS,
    ...(options.fonts === false ? {} : { loadFallbackFont: loadCjkFontInNode, loadEmojiFont: loadEmojiFontInNode }),
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
    const command = { id: `cmd_PDF${String(serial).padStart(7, '0')}`, name, params, issuedBy: 'user', createdAt: COMPILED_AT } as Command;
    return execute(command, bus, registry);
  };
  return { state, fs, exporter, undo, bytes, run };
}

function okValue(outcome: Dispatch): ExecutionOutcome {
  if (!outcome.ok) throw new Error(`refused: ${outcome.error.code}: ${outcome.error.message}`);
  return outcome.value;
}

const ascii = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function holdRecipe(state: ProjectState, recipe: ExportRecipe): void {
  state.manifest.recipes = [...(state.manifest.recipes ?? []).filter((held) => held.name !== recipe.name), recipe];
}

describe('pdf — the format', () => {
  it('is a media format with a binary artifact, served as application/pdf', () => {
    expect(isMediaFormat('pdf')).toBe(true);
    expect(isBinaryFormat('pdf')).toBe(true);
    expect(EXPORT_MIME.pdf).toBe('application/pdf');
  });
});

describe('pdf — through the §4 API', () => {
  it('writes one PDF named for the project, with the screenplay set in an embedded Courier Prime', async () => {
    const result = await rig().exporter.compile({ includeRootIds: ['manuscript'] }, 'pdf');
    expect(result.files).toHaveLength(1);
    expect(result.fileName).toBe(`${PROJECT_NAME}.pdf`);
    expect(result.mimeType).toBe('application/pdf');
    const pdf = ascii(new Uint8Array(await result.blob.arrayBuffer()));
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf.endsWith('%%EOF\n')).toBe(true);
    expect(pdf).toContain('/BaseFont /CourierPrime');
    expect(pdf).toContain('/FontFile2 ');
    expect(pdf).toContain('(INT. KITCHEN - DAY) Tj');
    expect(pdf).toContain('(MARA) Tj');
    expect(pdf).toContain('(Where were you?) Tj');
    // The title page, from the project's title and the byline.
    expect(pdf).toContain(`(${PROJECT_NAME}) Tj`);
    expect(pdf).toContain('(Ada Lovelace) Tj');
  });

  it('logs the page count, the title page apart, as an estimate of screen time', async () => {
    const { log } = await rig().exporter.compile({ includeRootIds: ['manuscript'] }, 'pdf');
    expect(log.format).toBe('pdf');
    expect(log.sceneCount).toBe(1);
    expect(log.notes).toContain('pdf: 1 script page, and a title page, about 1 minute of screen time at a page a minute');
  });

  it('refuses a selection with no screenplay scene, as the Fountain and FDX formats do', async () => {
    const attempt = rig().exporter.compile({ includeRootIds: ['research'] }, 'pdf');
    await expect(attempt).rejects.toBeInstanceOf(MediaRefusedError);
    await expect(attempt).rejects.toThrow('the selection holds no screenplay scene');
  });

  it('refuses a scene whose text prints nothing (only notes and boneyard), rather than writing a blank PDF', async () => {
    // The paginator writes at least one blank page so the PDF is always valid, so a scene with no printed text would
    // compile to a blank page that reports success. The gate refuses it as it refuses a selection with no scene.
    const state = makeMediaProject();
    const kitchen = state.documents.get(MEDIA_IDS.kitchen);
    if (kitchen === undefined) throw new Error('the fixture has no body for the kitchen scene');
    kitchen.body = ['[[a note that does not print]]', '', '/* a boneyard that does not print */'].join('\n');
    const attempt = rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'pdf');
    await expect(attempt).rejects.toBeInstanceOf(MediaRefusedError);
    await expect(attempt).rejects.toThrow('nothing to print');
  });

  it('prints CJK text and emoji in the embedded fallback fonts, and says in the log which characters no font can print', async () => {
    const state = makeMediaProject();
    const kitchen = state.documents.get(MEDIA_IDS.kitchen);
    if (kitchen === undefined) throw new Error('the fixture has no body for the kitchen scene');
    state.documents.set(MEDIA_IDS.kitchen, { ...kitchen, body: 'INT. KITCHEN - DAY\n\nMARA\nThe sign says 草堂, ようこそ, 환영합니다 🎬 👨‍👩‍👧, and \uE000.' });
    const { log, blob } = await rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'pdf');
    expect(log.notes).toContain('pdf: neither Courier Prime nor the CJK or emoji fallback font can print this character, so it is printed as "?": \uE000');
    const pdf = ascii(new Uint8Array(await blob.arrayBuffer()));
    expect(pdf).toContain('/BaseFont /CourierPrime');
    expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansMonoCJKsc-Regular/);
    expect(pdf).not.toContain('CIDFontType0');
    expect(pdf).toContain('/ToUnicode ');
    expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoEmoji-Regular/);
    expect(pdf).toContain('/Subtype /CIDFontType2');
  });

  it('prints CJK text and emoji as "?", and says so, when the compile has no font loaders', async () => {
    const state = makeMediaProject();
    const kitchen = state.documents.get(MEDIA_IDS.kitchen);
    if (kitchen === undefined) throw new Error('the fixture has no body for the kitchen scene');
    state.documents.set(MEDIA_IDS.kitchen, { ...kitchen, body: 'INT. KITCHEN - DAY\n\nMARA\nThe sign says 草堂 🎬.' });
    const { log, blob } = await rig({ state, fonts: false }).exporter.compile({ includeRootIds: ['manuscript'] }, 'pdf');
    expect(log.notes).toContain('pdf: this compile has no CJK fallback font, so these 2 characters are printed as "?": 草 堂');
    expect(log.notes).toContain('pdf: this compile has no emoji font, so this character is printed as "?": 🎬');
    const pdf = ascii(new Uint8Array(await blob.arrayBuffer()));
    expect(pdf).not.toContain('CIDFontType2');
  });
});

describe('pdf — through the bus', () => {
  it('writes the PDF to exports/ through the byte store, logs it, and the undo removes it', async () => {
    const r = rig();
    await r.exporter.ready();
    const outcome = okValue(r.run('export.compile', { format: 'pdf' }));
    await r.exporter.idle();
    const digest = outcome.result as { output: string; format: string; sceneCount: number };
    expect(digest).toMatchObject({ output: `exports/${PROJECT_NAME}.pdf`, format: 'pdf', sceneCount: 1 });
    expect(r.exporter.failures()).toEqual([]);
    const written = r.bytes.get(digest.output);
    expect(written).toBeDefined();
    expect(ascii(written ?? new Uint8Array()).startsWith('%PDF-1.4\n')).toBe(true);
    const rows = JSON.parse(r.fs.snapshot()['exports/compile-log.json'] ?? '[]') as Array<Record<string, unknown>>;
    expect(rows.at(-1)).toMatchObject({ format: 'pdf', output: digest.output });

    r.undo.undo(outcome.undoGroupId ?? '');
    await r.exporter.idle();
    expect(r.bytes.has(digest.output)).toBe(false);
  });

  it('is refused where there is no byte store, as DOCX and EPUB are, and writes nothing', async () => {
    const r = rig({ bytes: false });
    await r.exporter.ready();
    const outcome = r.run('export.compile', { format: 'pdf' });
    expect(outcome.ok).toBe(false);
    await r.exporter.idle();
    expect(r.fs.snapshot()['exports/compile-log.json']).toBeUndefined();
  });

  it('a recipe’s scene numbers and continuation setting reach the page', async () => {
    const r = rig();
    holdRecipe(r.state, {
      name: 'Shooting script',
      includeRootIds: ['manuscript'],
      format: 'pdf',
      options: { titlePage: false, sceneNumbers: 'both', continued: false },
    });
    await r.exporter.ready();
    const digest = okValue(r.run('export.compile', { format: 'pdf', recipeName: 'Shooting script' })).result as { output: string };
    await r.exporter.idle();
    expect(digest.output).toBe('exports/Shooting script.pdf');
    const pdf = ascii(r.bytes.get(digest.output) ?? new Uint8Array());
    // The scene number in both margins, and no title page.
    expect(pdf.match(/\(1\) Tj/g)).toHaveLength(2);
    expect(pdf).not.toContain('(Ada Lovelace) Tj');
  });

  it('a recipe’s continuation setting decides whether a speech that crosses a page carries (MORE) and (CONT’D)', async () => {
    const r = rig();
    // Some action, then a speech of 60 one-row sentences: taller than a page, so it must cross one.
    const filler = Array.from({ length: 10 }, (_, i) => `Filler ${i}.`).join('\n\n');
    const speech = Array.from({ length: 60 }, () => `${'w'.repeat(34)}.`).join(' ');
    const kitchen = r.state.documents.get(MEDIA_IDS.kitchen);
    if (kitchen === undefined) throw new Error('no kitchen scene');
    kitchen.body = `INT. KITCHEN - DAY\n\n${filler}\n\nMARA\n${speech}`;
    holdRecipe(r.state, { name: 'Off', includeRootIds: ['manuscript'], format: 'pdf', options: { titlePage: false, continued: false } });
    holdRecipe(r.state, { name: 'On', includeRootIds: ['manuscript'], format: 'pdf', options: { titlePage: false } });
    await r.exporter.ready();
    const compiled = async (recipeName: string): Promise<string> => {
      const digest = okValue(r.run('export.compile', { format: 'pdf', recipeName })).result as { output: string };
      await r.exporter.idle();
      return ascii(r.bytes.get(digest.output) ?? new Uint8Array());
    };
    const on = await compiled('On');
    const off = await compiled('Off');
    // Control: the speech crosses a page in both files, so the difference is the setting, not the layout.
    for (const pdf of [on, off]) expect(Number(/\/Count (\d+) /.exec(pdf)?.[1])).toBeGreaterThanOrEqual(2);
    expect(on).toContain('(\\(MORE\\)) Tj');
    expect(on).toContain("(MARA \\(CONT'D\\)) Tj");
    expect(off).not.toContain('MORE');
    expect(off).not.toContain("CONT'D");
  });
});
