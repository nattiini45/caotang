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
import { loadArabicFontInNode, loadCjkFontInNode, loadEmojiFontInNode, loadHebrewFontInNode } from '@caotang/pdf-fonts/node-loader';
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { createExporter, EXPORT_MIME, isBinaryFormat, isMediaFormat, MediaRefusedError, type ByteArtifacts, type ExporterService } from '../src/index.js';
import { COMPILED_AT } from './fixture.js';
import { drawnWords } from './rtl-text.js';
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

function rig(options: { bytes?: boolean; state?: ProjectState; fonts?: boolean; language?: string; rtlFonts?: boolean } = {}): Rig {
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
    metadata: () => ({ author: 'Ada Lovelace', ...(options.language === undefined ? {} : { language: options.language }) }),
    assets: () => ASSETS,
    ...(options.fonts === false ? {} : { loadFallbackFont: loadCjkFontInNode, loadEmojiFont: loadEmojiFontInNode }),
    ...(options.fonts === false || options.rtlFonts === false ? {} : { loadArabicFont: loadArabicFontInNode, loadHebrewFont: loadHebrewFontInNode }),
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

/** Every page's content stream of a file, read back with pdf-lib, which also proves the file parses. */
async function contentOf(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const streams = doc.getPages().flatMap((page) => {
    const contents = page.node.Contents();
    return contents instanceof PDFRawStream ? [contents] : [];
  });
  return streams.map((stream) => new TextDecoder().decode(decodePDFRawStream(stream).decode())).join('\n');
}

/** The Arabic and Hebrew words of a file's pages as a reader copies them (rtl-text.ts). */
async function copiedWords(bytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().flatMap((_, index) => drawnWords(pdf, undefined, index));
}

/** The `/ActualText` strings of a content stream, in the order they are written. */
const actualTexts = (content: string): string[] =>
  [...content.matchAll(/\/ActualText <FEFF([0-9A-F]*)>/g)].map((match) =>
    String.fromCharCode(...(match[1]?.match(/.{4}/g) ?? []).map((hex) => parseInt(hex, 16))),
  );

describe('pdf — Arabic and Hebrew', () => {
  const body = 'INT. غرفة - NIGHT\n\n@سارة\n(بهدوء)\nمرحبا Bob، هل رأيت الفيلم؟\n\n@דוד\n(בשקט)\nשלום עולם, מה שלומך?';
  const withBody = (text: string): ProjectState => {
    const state = makeMediaProject();
    const kitchen = state.documents.get(MEDIA_IDS.kitchen);
    if (kitchen === undefined) throw new Error('the fixture has no body for the kitchen scene');
    state.documents.set(MEDIA_IDS.kitchen, { ...kitchen, body: text });
    return state;
  };

  it('prints both scripts in their own embedded fonts, with no "?" and no log line naming a character', async () => {
    const { log, blob } = await rig({ state: withBody(body) }).exporter.compile({ includeRootIds: ['manuscript'] }, 'pdf');
    expect(log.notes.filter((note) => note.includes('"?"'))).toEqual([]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const pdf = ascii(bytes);
    expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansArabic-Regular/);
    expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansHebrew-Regular/);
    // Read back with pdf-lib: the file parses, and each word is glyphs in visual order whose ToUnicode texts, last drawn first,
    // are its logical text. The brackets of the parentheticals are the one thing marked content still carries: a mirrored "(".
    const content = await contentOf(bytes);
    expect(actualTexts(content).filter((text) => /[\u0590-\u06ff]/.test(text))).toEqual([]);
    const copied = await copiedWords(bytes);
    for (const word of ['غرفة', 'سارة', 'بهدوء', 'مرحبا', 'رأيت', 'דוד', 'בשקט', 'שלום', 'עולם', 'שלומך']) expect(copied, word).toContain(word);
  });

  it('measures the words in their fonts before it draws, and keeps the log page count when the measured layout has the same', async () => {
    const { log } = await rig({ state: withBody(body) }).exporter.compile({ includeRootIds: ['manuscript'] }, 'pdf');
    expect(log.notes).toContain('pdf: 1 script page, and a title page, about 1 minute of screen time at a page a minute');
    expect(log.notes.some((note) => note.includes('measured in their fonts'))).toBe(false);
  });

  it('says which marks are left out, once for each script', async () => {
    const state = withBody('INT. A - DAY\n\n@سارة\nبِسْمِ اللّٰهِ\n\n@דוד\nשָׁלוֹם');
    const { log } = await rig({ state }).exporter.compile({ includeRootIds: ['manuscript'] }, 'pdf');
    expect(log.notes.filter((note) => note.includes('left out of the print'))).toHaveLength(2);
  });

  it('prints both scripts as "?", and says so, when the compile has no font for them', async () => {
    const { log, blob } = await rig({ state: withBody(body), rtlFonts: false }).exporter.compile({ includeRootIds: ['manuscript'] }, 'pdf');
    expect(log.notes).toContain('pdf: this compile has no Arabic font, so the Arabic text is printed as "?"');
    expect(log.notes).toContain('pdf: this compile has no Hebrew font, so the Hebrew text is printed as "?"');
    const pdf = ascii(new Uint8Array(await blob.arrayBuffer()));
    expect(pdf).not.toContain('NotoSansArabic');
    expect(pdf).not.toContain('NotoSansHebrew');
  });

  it('lays out a neutral paragraph right to left in a project whose language is Arabic or Hebrew, and left to right otherwise', async () => {
    const text = 'INT. A - DAY\n\n...\n\n@سارة\nمرحبا.';
    const content = async (language: string | undefined): Promise<string> => {
      const { blob } = await rig({ state: withBody(text), ...(language === undefined ? {} : { language }) }).exporter.compile({ includeRootIds: ['manuscript'] }, 'pdf');
      return contentOf(new Uint8Array(await blob.arrayBuffer()));
    };
    const x = (stream: string): number => Number(/1 0 0 1 (\S+) \S+ Tm\n\(\.\.\.\) Tj/.exec(stream)?.[1] ?? Number.NaN);
    expect(x(await content('ar'))).toBeGreaterThan(x(await content('en')));
    expect(x(await content(undefined))).toBe(x(await content('en')));
  });

  it('writes a Latin-only script byte for byte as it was, whether or not the project is in an Arabic language', async () => {
    const compile = async (language: string | undefined): Promise<string> => {
      const { blob } = await rig({ ...(language === undefined ? {} : { language }) }).exporter.compile({ includeRootIds: ['manuscript'] }, 'pdf');
      return ascii(new Uint8Array(await blob.arrayBuffer()));
    };
    const plain = await compile(undefined);
    expect(await compile('ar')).toBe(plain);
    expect(plain).not.toContain('NotoSans');
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
