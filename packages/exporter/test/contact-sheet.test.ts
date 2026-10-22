/**
 * The storyboard contact sheet as a PDF (`contact-sheet-pdf`, storyboard.md §6): the page plan from `@caotang/storyboard`,
 * drawn by this package's pdf-lib emitter. The plan's own geometry is tested in the storyboard package; these tests read the
 * file the compile produced back with pdf-lib and check what the spec says the file is: one page per planned page, on A4 or
 * Letter, the pictures embedded once, a caption, with a note, where a picture cannot be drawn, and text outside Latin script
 * set in the Noto Sans Mono CJK fallback font, which is read only when a sheet needs it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { unzlibSync } from 'fflate/browser';
import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  type BusContext,
  type Command,
} from '@caotang/bus';
import { createProjectCommandRegistry, MemoryArtifactFs, type ProjectState } from '@caotang/store';
import { addShotNode, planContactSheet } from '@caotang/storyboard';
import type { AssetRecord } from '@caotang/video-prompt-pack';
import { emojiStyleOf, graphemesOf, sfntFromWoff, type FontLoader } from '@caotang/pdf-fonts';
import { loadArabicFontInNode, loadCjkFontInNode, loadDevanagariFontInNode, loadEmojiFontInNode, loadHebrewFontInNode } from '@caotang/pdf-fonts/node-loader';
import { harfbuzzEmoji } from '../../pdf-fonts/test/harfbuzz-reference.js';
import { EmojiEmbedding, EmojiFace, type FontkitFont } from '../src/emoji-font.js';
import {
  CONTACT_SHEET_HEADER,
  containIn,
  createExporter,
  drawContactSheet,
  fitToWidth,
  renderMedia,
  type ByteArtifacts,
  type ExporterService,
} from '../src/index.js';
import { PNG_1X1 } from './epub-fixtures.js';
import { COMPILED_AT } from './fixture.js';
import { ASSET_FILE, ASSET_ID, ASSETS, MEDIA_IDS, OPENED, PROJECT_NAME, makeMediaProject } from './media-fixture.js';

const A4 = { width: 595.28, height: 841.89 };
const LETTER = { width: 612, height: 792 };

function rig(
  options: {
    state?: ProjectState;
    assets?: ReadonlyMap<string, AssetRecord>;
    files?: Record<string, Uint8Array>;
    loadFallbackFont?: FontLoader;
    loadEmojiFont?: FontLoader;
    loadArabicFont?: FontLoader;
    loadHebrewFont?: FontLoader;
    loadDevanagariFont?: FontLoader;
    readAsset?: (path: string) => Promise<Uint8Array | null>;
  } = {},
): { exporter: ExporterService; reads: string[] } {
  const state = options.state ?? makeMediaProject();
  const files = options.files ?? { [`assets/${ASSET_FILE}`]: PNG_1X1 };
  const reads: string[] = [];
  const exporter = createExporter({
    readState: () => state,
    artifacts: new MemoryArtifactFs(),
    clock: { now: () => COMPILED_AT },
    metadata: () => ({ author: 'Ada Lovelace' }),
    assets: () => options.assets ?? ASSETS,
    readAsset: async (path) => {
      reads.push(path);
      return options.readAsset === undefined ? (files[path] ?? null) : options.readAsset(path);
    },
    ...(options.loadFallbackFont === undefined ? {} : { loadFallbackFont: options.loadFallbackFont }),
    ...(options.loadEmojiFont === undefined ? {} : { loadEmojiFont: options.loadEmojiFont }),
    ...(options.loadArabicFont === undefined ? {} : { loadArabicFont: options.loadArabicFont }),
    ...(options.loadHebrewFont === undefined ? {} : { loadHebrewFont: options.loadHebrewFont }),
    ...(options.loadDevanagariFont === undefined ? {} : { loadDevanagariFont: options.loadDevanagariFont }),
  });
  return { exporter, reads };
}

async function compileSheet(exporter: ExporterService, selection: string[] = ['manuscript']) {
  const result = await exporter.compile({ includeRootIds: selection }, 'contact-sheet-pdf');
  const file = result.files[0];
  if (file === undefined || result.files.length !== 1) throw new Error(`expected one file, got ${result.files.length}`);
  const bytes = new Uint8Array(await file.blob.arrayBuffer());
  return { result, file, bytes, pdf: await PDFDocument.load(bytes, { updateMetadata: false }) };
}

/**
 * How many pictures the file embeds: each is one image XObject, however many cards draw it. A PNG with transparency also
 * carries its alpha as a second image (its soft mask), which is not a picture of its own, so masks are not counted.
 */
function imageCount(pdf: PDFDocument): number {
  const images = pdf.context
    .enumerateIndirectObjects()
    .filter(([, object]) => object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
  const masks = new Set(images.map(([, object]) => String((object as PDFRawStream).dict.get(PDFName.of('SMask')))));
  return images.filter(([ref]) => !masks.has(String(ref))).length;
}

/** The embedded font programs (FontFile2 streams) in the file, decompressed. Helvetica is built in, so it has none. */
function embeddedFontFiles(pdf: PDFDocument): Uint8Array[] {
  const files: Uint8Array[] = [];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict) || object.get(PDFName.of('Type')) !== PDFName.of('FontDescriptor')) continue;
    const ref = object.get(PDFName.of('FontFile2'));
    const stream = ref === undefined ? undefined : pdf.context.lookup(ref);
    if (stream instanceof PDFRawStream) files.push(inflated(stream));
  }
  return files;
}

function inflated(stream: PDFRawStream): Uint8Array {
  return stream.dict.get(PDFName.of('Filter')) === PDFName.of('FlateDecode') ? unzlibSync(stream.contents) : stream.contents;
}

/**
 * The text the file's ToUnicode maps hold: what a PDF reader extracts when it copies or searches the text set in the
 * fallback font. pdf-lib writes one `bfrange`/`bfchar` entry per glyph with its UTF-16 code units in hex.
 */
function toUnicodeText(pdf: PDFDocument): string {
  let text = '';
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict) || object.get(PDFName.of('Subtype')) !== PDFName.of('Type0')) continue;
    const ref = object.get(PDFName.of('ToUnicode'));
    const stream = ref === undefined ? undefined : pdf.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    const cmap = new TextDecoder().decode(inflated(stream));
    for (const match of cmap.matchAll(/<[0-9a-fA-F]+>\s*<([0-9a-fA-F]+)>/g)) {
      const hex = match[1] ?? '';
      const units: number[] = [];
      for (let i = 0; i + 4 <= hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
      // pdf-lib maps .notdef to U+FFFF, which is no character of the text.
      if (hex.toUpperCase() !== 'FFFF') text += String.fromCharCode(...units);
    }
  }
  return text;
}

/** One page's content stream, decompressed, as text. */
function pageContent(pdf: PDFDocument, index: number): string {
  const contents = pdf.getPage(index).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => pdf.context.lookup(ref)) : [contents];
  return streams.map((stream) => (stream instanceof PDFRawStream ? new TextDecoder('latin1').decode(inflated(stream)) : '')).join('\n');
}

function hexOf(text: string): string {
  return [...text].map((char) => (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(2, '0')).join('');
}

/** A loader over a package's font file that counts its calls. */
function countingLoader(read: FontLoader = loadCjkFontInNode): { load: FontLoader; calls: () => number } {
  let calls = 0;
  return {
    load: async () => {
      calls += 1;
      return read();
    },
    calls: () => calls,
  };
}

function withAction(action: string, imageAlt?: string): ProjectState {
  const state = makeMediaProject();
  addShotNode(state, {
    parentId: MEDIA_IDS.shots,
    title: 'World',
    id: 'n_WORLD00001',
    now: OPENED,
    stored: { action, ...(imageAlt === undefined ? {} : { imageAlt }) },
  });
  return state;
}

/** A project whose one storyboard holds `count` shots, with no pictures. */
function manyShots(count: number): ProjectState {
  const state = makeMediaProject();
  for (let i = 0; i < count; i += 1) {
    addShotNode(state, {
      parentId: MEDIA_IDS.shots,
      title: `Extra ${i + 1}`,
      id: `n_EXTRA${String(i).padStart(5, '0')}`,
      now: OPENED,
      stored: { shotSize: 'CU', action: `Extra shot ${i + 1}.`, durationSec: 1 },
    });
  }
  return state;
}

describe('contact-sheet-pdf — the storyboard as a PDF of shot cards', () => {
  it('writes one PDF named for the project, on A4, with its metadata set from the compile', async () => {
    const { file, bytes, pdf, result } = await compileSheet(rig().exporter);
    expect(file.fileName).toBe(`${PROJECT_NAME} (contact sheet).pdf`);
    expect(file.mimeType).toBe('application/pdf');
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    expect(pdf.getPageCount()).toBe(1);
    const size = pdf.getPage(0).getSize();
    expect(size.width).toBeCloseTo(A4.width, 2);
    expect(size.height).toBeCloseTo(A4.height, 2);
    expect(pdf.getTitle()).toMatch(/^The Lighthouse Keeper — Shots — \d{4}-\d{2}-\d{2}$/);
    expect(pdf.getAuthor()).toBe('Ada Lovelace');
    expect(pdf.getCreationDate()?.getTime()).toBe(Math.floor(COMPILED_AT / 1000) * 1000);
    expect(result.log.format).toBe('contact-sheet-pdf');
    expect(result.log.blockCount).toBe(2);
    expect(result.log.notes).toContain('contact sheet: 1 page of 15 shots each, A4');
  });

  it('embeds the stored picture, read from assets/ by its file name', async () => {
    const { exporter, reads } = rig();
    const { pdf, result } = await compileSheet(exporter);
    expect(reads).toEqual([`assets/${ASSET_FILE}`]);
    expect(imageCount(pdf)).toBe(1);
    expect(result.log.notes.some((note) => note.includes('caption'))).toBe(false);
  });

  it('embeds a picture once when several cards show it', async () => {
    const state = makeMediaProject();
    addShotNode(state, { parentId: MEDIA_IDS.shots, title: 'Again', id: 'n_AGAIN00001', now: OPENED, stored: { image: ASSET_ID } });
    const { exporter, reads } = rig({ state });
    const { pdf } = await compileSheet(exporter);
    expect(reads).toEqual([`assets/${ASSET_FILE}`]);
    expect(imageCount(pdf)).toBe(1);
  });

  it('has as many pages as the plan, and the plan fills A4 fifteen cards at a time', async () => {
    const state = manyShots(29); // 2 + 29 = 31 shots: 15 + 15 + 1
    const { pdf, result } = await compileSheet(rig({ state }).exporter);
    expect(pdf.getPageCount()).toBe(3);
    expect(result.log.blockCount).toBe(31);
    expect(result.log.notes).toContain('contact sheet: 3 pages of 15 shots each, A4');
  });

  it('shows the caption, and says why, when the picture’s bytes cannot be read', async () => {
    const { pdf, result } = await compileSheet(rig({ files: {} }).exporter);
    expect(pdf.getPageCount()).toBe(1);
    expect(imageCount(pdf)).toBe(0);
    expect(result.log.notes).toContain(`contact sheet: image ${ASSET_ID} could not be read, so its cards show the caption`);
  });

  it('shows the caption, and says why, when reading the picture fails, and draws the rest of the sheet', async () => {
    const readAsset = async (): Promise<Uint8Array | null> => {
      throw new Error('the disk was unplugged');
    };
    const { pdf, result } = await compileSheet(rig({ readAsset }).exporter);
    expect(pdf.getPageCount()).toBe(1);
    expect(imageCount(pdf)).toBe(0);
    expect(result.log.notes).toContain(`contact sheet: image ${ASSET_ID} could not be read (the disk was unplugged), so its cards show the caption`);
    // The card whose picture failed shows its caption, and the other cards are drawn as ever.
    const card = planContactSheet(makeMediaProject(), ['manuscript'], () => ({ drawn: true })).plan.pages[0]?.cards.find((placed) => placed.hasImage);
    const caption = card?.placeholder?.text ?? card?.fallback.text ?? '';
    expect(caption).not.toBe('');
    expect(pageContent(pdf, 0)).toContain(`<${hexOf(caption)}> Tj`);
  });

  it('degrades a picture whose read rejects to its caption in the emitter too, once per picture', async () => {
    const planned = planContactSheet(makeMediaProject(), ['manuscript'], () => ({ drawn: true }));
    let reads = 0;
    const drawn = await drawContactSheet({
      plan: planned.plan,
      pictures: planned.pictures,
      readPicture: async () => {
        reads += 1;
        throw new Error('EIO');
      },
      title: 'T',
      at: new Date(COMPILED_AT),
    });
    expect(reads).toBe(new Set(planned.pictures.values()).size);
    expect(drawn.notes).toContain(`contact sheet: image ${ASSET_ID} could not be read (EIO), so its cards show the caption`);
    expect((await PDFDocument.load(drawn.contents)).getPageCount()).toBe(planned.plan.pages.length);
  });

  it('shows the caption when the picture is not in assets/, and says so before anything is drawn', async () => {
    const { exporter, reads } = rig({ assets: new Map() });
    const { result } = await compileSheet(exporter);
    expect(reads).toEqual([]);
    expect(result.log.notes).toContain(`image ${ASSET_ID} is not in assets/, so its cards show the caption`);
  });

  it('shows the caption for a WebP picture, which the PDF cannot embed', async () => {
    const webp = new Map([[ASSET_ID, { id: ASSET_ID, fileName: `${ASSET_ID}.webp` }]]);
    const { exporter, reads } = rig({ assets: webp });
    const { pdf, result } = await compileSheet(exporter);
    expect(reads).toEqual([]);
    expect(imageCount(pdf)).toBe(0);
    expect(result.log.notes).toContain(`image ${ASSET_ID} is a WebP file, which the PDF cannot embed, so its cards show the caption`);
  });

  it('shows the caption when the stored bytes are not an image the engine can read', async () => {
    const broken = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const { pdf, result } = await compileSheet(rig({ files: { [`assets/${ASSET_FILE}`]: broken } }).exporter);
    expect(imageCount(pdf)).toBe(0);
    expect(result.log.notes.some((note) => note.startsWith(`contact sheet: image ${ASSET_ID} could not be embedded`))).toBe(true);
  });

  it('draws text outside Latin script as "?", and names it in the log, when the compile has no fallback font', async () => {
    const state = makeMediaProject();
    addShotNode(state, { parentId: MEDIA_IDS.shots, title: 'Tea', id: 'n_TEAHOUSE01', now: OPENED, stored: { action: '草堂 at dawn' } });
    const { result, pdf } = await compileSheet(rig({ state }).exporter);
    expect(result.log.notes).toContain(
      'contact sheet: 2 characters the PDF\'s built-in font cannot show, and this compile has no fallback font, were drawn as "?": 草 (U+8349), 堂 (U+5802)',
    );
    expect(embeddedFontFiles(pdf)).toHaveLength(0);
  });

  it('keeps accented Latin text, which the built-in font shows', async () => {
    const state = makeMediaProject();
    addShotNode(state, { parentId: MEDIA_IDS.shots, title: 'Café', id: 'n_CAFE000001', now: OPENED, stored: { action: 'Abeßer crosses the café — slowly…' } });
    const { result } = await compileSheet(rig({ state }).exporter);
    expect(result.log.notes.some((note) => note.includes('built-in font'))).toBe(false);
  });

  it('notes a shot with no metadata on record, whose card shows its number and "No image", with no camera details or action', async () => {
    const state = makeMediaProject();
    addShotNode(state, { parentId: MEDIA_IDS.shots, title: 'Bare', id: 'n_BARE000001', now: OPENED, stored: {} });
    const shot = state.manifest.tree.find((node) => node.id === 'n_BARE000001') as { shot?: unknown } | undefined;
    if (shot !== undefined) delete shot.shot;
    const { result, pdf } = await compileSheet(rig({ state }).exporter);
    expect(result.log.notes).toContain('shot 3: no shot metadata is on record, so its card shows its number and "No image", with no camera details or action');
    // What the note says is what the card holds.
    const card = planContactSheet(state, ['manuscript'], () => ({ drawn: true })).plan.pages[0]?.cards.find((placed) => placed.shotId === 'n_BARE000001');
    expect(card?.chipText.text).toBe('3');
    expect(card?.hasImage).toBe(false);
    expect(card?.placeholder?.text).toBe('No image');
    expect(card?.spec).toEqual([]);
    expect(card?.action).toEqual([]);
    expect(pageContent(pdf, 0)).toContain(`<${hexOf('No image')}> Tj`);
  });

  it('refuses a selection with no shot, and writes nothing', async () => {
    await expect(rig().exporter.compile({ includeRootIds: ['research'] }, 'contact-sheet-pdf')).rejects.toThrow(
      'this compile as the contact sheet is refused: the selection holds no shot, so there is no contact sheet to draw',
    );
  });

  it('refuses through the images port when the assets folder cannot be listed', async () => {
    const exporter = createExporter({
      readState: () => makeMediaProject(),
      artifacts: new MemoryArtifactFs(),
      clock: { now: () => COMPILED_AT },
      assets: () => {
        throw new Error('EACCES: permission denied, scandir assets');
      },
    });
    await expect(exporter.compile({ includeRootIds: ['manuscript'] }, 'contact-sheet-pdf')).rejects.toThrow('EACCES');
  });
});

describe('the page size: A4 or Letter (storyboard.md §6)', () => {
  it('draws Letter pages, twelve cards each, when the request asks for Letter', async () => {
    const state = manyShots(11); // 13 shots: 12 + 1 on Letter
    const output = renderMedia({
      state,
      format: 'contact-sheet-pdf',
      includeRootIds: ['manuscript'],
      title: PROJECT_NAME,
      author: '',
      date: '2026-10-17',
      titlePage: false,
      base: PROJECT_NAME,
      assets: ASSETS,
      readAsset: async () => PNG_1X1,
      pageSize: 'Letter',
      at: COMPILED_AT,
    });
    expect(output.notes).toContain('contact sheet: 2 pages of 12 shots each, Letter');
    const render = output.files[0]?.bytes;
    if (render === undefined) throw new Error('the contact sheet has no render');
    const rendered = await render();
    const bytes = typeof rendered === 'object' && !(rendered instanceof Uint8Array) ? rendered.contents : rendered;
    const pdf = await PDFDocument.load(bytes as Uint8Array);
    expect(pdf.getPageCount()).toBe(2);
    expect(pdf.getPage(1).getSize()).toEqual(LETTER);
  });

  it('takes the page size from a saved recipe through the bus, writes the PDF to exports/, and undo removes it', async () => {
    const state = makeMediaProject();
    const fs = new MemoryArtifactFs();
    const written = new Map<string, Uint8Array>();
    const bytes: ByteArtifacts = {
      writeBytes: async (path, data) => void written.set(path, data),
      removeBytes: async (path) => void written.delete(path),
    };
    const clock = { now: () => COMPILED_AT };
    const exporter = createExporter({
      readState: () => state,
      artifacts: fs,
      bytes,
      clock,
      assets: () => ASSETS,
      readAsset: async () => PNG_1X1,
    });
    await exporter.ready();
    const registry = createProjectCommandRegistry({ clock, exporter: exporter.commandPort() });
    const undo = createUndoStore({ dispatch: (command) => execute(command, bus, registry) });
    const bus: BusContext<ProjectState> = {
      state,
      view: createViewState(),
      read: () => state,
      undo,
      log: createActivityLog(),
      idempotency: createIdempotencyCache(),
      notify: () => {},
    };
    let serial = 0;
    const run = (name: Command['name'], params: Record<string, unknown>) => {
      serial += 1;
      return execute({ id: `cmd_SHEET${String(serial).padStart(6, '0')}`, name, params, issuedBy: 'user', createdAt: COMPILED_AT } as Command, bus, registry);
    };

    const saved = run('recipe.save', {
      name: 'Letter sheets',
      includeRootIds: [MEDIA_IDS.shots],
      format: 'contact-sheet-pdf',
      options: { pageSize: 'Letter' },
    });
    expect(saved.ok).toBe(true);
    expect(state.manifest.recipes?.find((recipe) => recipe.name === 'Letter sheets')?.options).toEqual({ pageSize: 'Letter' });

    const compiled = run('export.compile', { format: 'contact-sheet-pdf', recipeName: 'Letter sheets' });
    expect(compiled.ok).toBe(true);
    await exporter.idle();
    expect(exporter.failures()).toEqual([]);
    const path = 'exports/Letter sheets (contact sheet).pdf';
    const file = written.get(path);
    if (file === undefined) throw new Error(`nothing at ${path}: ${[...written.keys()].join(', ')}`);
    const pdf = await PDFDocument.load(file);
    expect(pdf.getPage(0).getSize()).toEqual(LETTER);

    // Undo removes the PDF from the byte store, where it was written, as it removes a DOCX or an EPUB.
    if (!compiled.ok) throw new Error('the compile was refused');
    expect(undo.undo(compiled.value.undoGroupId ?? '').ok).toBe(true);
    await exporter.idle();
    expect(written.has(path)).toBe(false);
    expect(exporter.failures()).toEqual([]);
  });

  it('refuses a page size that is not A4 or Letter at validate', () => {
    const state = makeMediaProject();
    const clock = { now: () => COMPILED_AT };
    const registry = createProjectCommandRegistry({ clock });
    const bus: BusContext<ProjectState> = {
      state,
      view: createViewState(),
      read: () => state,
      undo: createUndoStore({ dispatch: (command) => execute(command, bus, registry) }),
      log: createActivityLog(),
      idempotency: createIdempotencyCache(),
      notify: () => {},
    };
    const outcome = execute(
      {
        id: 'cmd_SHEETBAD001',
        name: 'recipe.save',
        params: { name: 'Odd', includeRootIds: ['manuscript'], format: 'contact-sheet-pdf', options: { pageSize: 'A3' } },
        issuedBy: 'user',
        createdAt: COMPILED_AT,
      } as Command,
      bus,
      registry,
    );
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.message).toContain('params.options.pageSize must be one of A4, Letter');
  });
});

describe('contact-sheet-pdf — text outside Latin script, in the Noto Sans Mono CJK fallback font', () => {
  const CHINESE = '草堂的早晨，繁體字也行';
  const JAPANESE = 'ひらがなとカタカナ';
  const KOREAN = '한국어 문장';

  it('sets Chinese, Japanese and Korean text in the fallback font, and the text extracts back', async () => {
    const loader = countingLoader();
    const state = withAction(`${CHINESE} ${JAPANESE}`, KOREAN);
    const { pdf, result } = await compileSheet(rig({ state, files: {}, loadFallbackFont: loader.load }).exporter);
    expect(loader.calls()).toBe(1);
    const extracted = toUnicodeText(pdf);
    for (const char of `${CHINESE}${JAPANESE}${KOREAN}`.replace(/\s/g, '')) expect(extracted).toContain(char);
    expect(result.log.notes).toContain('contact sheet: text outside Latin script is set in Noto Sans Mono CJK SC, embedded with only the glyphs it uses');
    expect(result.log.notes.some((note) => note.includes('drawn as "?"'))).toBe(false);
  });

  it('embeds only the glyphs the sheet uses, each with an outline', async () => {
    const state = withAction(`${CHINESE} ${JAPANESE} ${KOREAN}`);
    const { pdf, bytes } = await compileSheet(rig({ state, loadFallbackFont: loadCjkFontInNode }).exporter);
    const files = embeddedFontFiles(pdf);
    expect(files).toHaveLength(1);
    const subset = fontkit.create(files[0] as Uint8Array) as unknown as { numGlyphs: number; getGlyph(id: number): { path: { commands: unknown[] } } };
    const distinct = new Set(`${CHINESE}${JAPANESE}${KOREAN}`.replace(/\s/g, '')).size;
    // .notdef, plus one glyph per distinct character (a space is set in Helvetica).
    expect(subset.numGlyphs).toBe(distinct + 1);
    for (let id = 1; id < subset.numGlyphs; id += 1) expect(subset.getGlyph(id).path.commands.length).toBeGreaterThan(0);
    // The whole font is megabytes; the file carries a few kilobytes of it.
    expect(bytes.byteLength).toBeLessThan(40_000);
  });

  it('gives characters the font draws with one glyph a CID each, so each copies back as itself', async () => {
    // ‧ U+2027 and ・ U+30FB, ① U+2460 and ➀ U+2780: each pair is one glyph in Noto Sans Mono CJK SC.
    const { pdf } = await compileSheet(rig({ state: withAction('Dots ‧ and ・, circled ① and ➀.'), loadFallbackFont: loadCjkFontInNode }).exporter);
    const entries = toUnicodeEntries(pdf);
    for (const char of ['‧', '・', '①', '➀']) expect(entries, char).toContain(char);
    // The glyph is stored once however many CIDs name it: four characters, two glyphs, and .notdef.
    const subset = fontkit.create(embeddedFontFiles(pdf)[0] as Uint8Array) as unknown as { numGlyphs: number };
    expect(subset.numGlyphs).toBe(3);
  });

  it('switches font inside a line of mixed text', async () => {
    const state = withAction('Mei 走进茶馆, orders 龙井, and waits.');
    const { pdf } = await compileSheet(rig({ state, loadFallbackFont: loadCjkFontInNode }).exporter);
    for (const char of '走进茶馆龙井') expect(toUnicodeText(pdf)).toContain(char);
    // Latin letters stay in Helvetica: the fallback subset maps none of them.
    expect(toUnicodeText(pdf)).not.toMatch(/[A-Za-z]/);
    // pdf-lib writes Helvetica text as WinAnsi hex: "Mei " and ", orders " are shown in Helvetica, between the CJK runs.
    const page = pageContent(pdf, 0);
    expect(page).toContain(`<${hexOf('Mei ')}> Tj`);
    expect(page).toContain(`<${hexOf(', orders ')}> Tj`);
  });

  it('never reads the font for a Latin-only sheet, whose bytes are those of a compile with no fallback font', async () => {
    const loader = countingLoader();
    const state = withAction('Abeßer crosses the café — slowly…');
    const withFont = await compileSheet(rig({ state, loadFallbackFont: loader.load }).exporter);
    const without = await compileSheet(rig({ state }).exporter);
    expect(loader.calls()).toBe(0);
    expect(embeddedFontFiles(withFont.pdf)).toHaveLength(0);
    expect([...withFont.bytes]).toEqual([...without.bytes]);
    expect(withFont.result.log.notes.some((note) => note.includes('Noto'))).toBe(false);
  });

  it('drops a text presentation selector after a letter or digit, so the sheet stays Latin-only and prints the letter', async () => {
    const loader = countingLoader();
    const withSelector = await compileSheet(rig({ state: withAction('cafe\uFE0E 1\uFE0E'), loadFallbackFont: loader.load }).exporter);
    const without = await compileSheet(rig({ state: withAction('cafe 1') }).exporter);
    expect(loader.calls()).toBe(0);
    expect(embeddedFontFiles(withSelector.pdf)).toHaveLength(0);
    expect(withSelector.result.log.notes.some((note) => note.includes('drawn as "?"'))).toBe(false);
    expect(pageContent(withSelector.pdf, 0)).toBe(pageContent(without.pdf, 0));
  });

  it('draws a character neither font has as "?", and names it in the log', async () => {
    const state = withAction('雨 ⲁ and க');
    const { result, pdf } = await compileSheet(rig({ state, loadFallbackFont: loadCjkFontInNode }).exporter);
    expect(result.log.notes).toContain(
      'contact sheet: 2 characters neither the PDF\'s built-in font nor Noto Sans Mono CJK SC can show were drawn as "?": ⲁ (U+2C81), க (U+0B95)',
    );
    expect(toUnicodeText(pdf)).toContain('雨');
  });

  it('draws text outside Latin script as "?", and says why, when the font cannot be read', async () => {
    const state = withAction('雨');
    const failing: FontLoader = async () => {
      throw new Error('offline');
    };
    const { result, pdf } = await compileSheet(rig({ state, loadFallbackFont: failing }).exporter);
    expect(result.log.notes).toContain(
      'contact sheet: 1 character the PDF\'s built-in font cannot show, and the fallback font could not be read (offline), was drawn as "?": 雨 (U+96E8)',
    );
    expect(embeddedFontFiles(pdf)).toHaveLength(0);
  });

  it('writes the same bytes for the same sheet and the same moment, with the fallback font', async () => {
    const state = withAction(`${CHINESE} ${KOREAN}`);
    const first = await compileSheet(rig({ state, loadFallbackFont: loadCjkFontInNode }).exporter);
    const second = await compileSheet(rig({ state, loadFallbackFont: loadCjkFontInNode }).exporter);
    expect([...first.bytes]).toEqual([...second.bytes]);
  });

  it('cuts a CJK line with an ellipsis inside the card, measured in the fallback font', async () => {
    const long = '山'.repeat(400);
    const planned = planContactSheet(withAction(long), ['manuscript'], () => ({ drawn: false, note: 'none' }));
    const drawn = await drawContactSheet({
      plan: planned.plan,
      pictures: new Map(),
      readPicture: async () => null,
      title: 'T',
      at: new Date(COMPILED_AT),
      loadFallbackFont: loadCjkFontInNode,
    });
    const card = planned.plan.pages[0]?.cards.find((placed) => placed.shotId === 'n_WORLD00001');
    const width = card?.frame.width ?? 0;
    // The plan breaks between the 山 with no space to break at, one em each at the 8 pt action size, and ends with an ellipsis.
    expect(card?.action.map((line) => line.text.replace('…', '')).join('')).toMatch(/^山+$/);
    expect(card?.action[1]?.text.endsWith('…')).toBe(true);
    // The emitter measures with the real fonts: Helvetica's ellipsis is one em too, so the last line gives up one more 山.
    const pdf = await PDFDocument.load(drawn.contents);
    const runs = [...pageContent(pdf, 0).matchAll(/<((?:0001)+)> Tj/g)].map((match) => (match[1] ?? '').length / 4);
    const perLine = Math.floor(width / 8);
    expect(runs).toEqual([perLine, perLine - 1]);
    expect(toUnicodeText(pdf)).toBe('山');
  });
});

/** Each ToUnicode entry of the file's Type 0 fonts, decoded: the text one CID gives back when it is copied. */
function toUnicodeEntries(pdf: PDFDocument): string[] {
  const entries: string[] = [];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict) || object.get(PDFName.of('Subtype')) !== PDFName.of('Type0')) continue;
    const ref = object.get(PDFName.of('ToUnicode'));
    const stream = ref === undefined ? undefined : pdf.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) continue;
    for (const match of new TextDecoder().decode(inflated(stream)).matchAll(/<[0-9a-fA-F]+>\s*<([0-9a-fA-F]+)>/g)) {
      const hex = match[1] ?? '';
      const units: number[] = [];
      for (let i = 0; i + 4 <= hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
      if (hex.toUpperCase() !== 'FFFF') entries.push(String.fromCharCode(...units));
    }
  }
  return entries;
}

/** The CID strings shown in the emoji font on a page: the hex of each `Tj` set after a `/NotoEmoji… Tf`. */
function emojiShows(pdf: PDFDocument, index: number): string[] {
  return [...pageContent(pdf, index).matchAll(/\/NotoEmoji\S* [\d.]+ Tf\s+[\d.-]+ [\d.-]+ Td\s+<([0-9A-F]*)> Tj/g)].map((match) => match[1] ?? '');
}

/**
 * Unicode's emoji list for Emoji 17.0, the version Noto Emoji 3.006 supports, kept beside the coverage tables it generates
 * (packages/pdf-fonts/test/fixtures): each line's emoji, status and name ("woman walking facing right: light skin tone").
 */
function emojiList(): { emoji: string; name: string; status: string }[] {
  return readFileSync(resolve(__dirname, '../../pdf-fonts/test/fixtures/emoji-test-17.0.txt'), 'utf8')
    .split('\n')
    .filter((line) => /^[0-9A-F]/.test(line))
    .map((line) => {
      const [codes = '', rest = ''] = line.split(';');
      const [status = '', comment = ''] = rest.split('#');
      // The comment is the emoji, its Emoji version, then its name.
      return {
        emoji: String.fromCodePoint(...codes.trim().split(/\s+/).map((hex) => parseInt(hex, 16))),
        name: comment.trim().split(' ').slice(2).join(' '),
        status: status.trim(),
      };
    });
}

const fullyQualifiedEmoji = () => emojiList().filter((row) => row.status === 'fully-qualified');

let emojiFace: EmojiFace | undefined;
async function noto(): Promise<EmojiFace> {
  emojiFace ??= new EmojiFace(fontkit.create(await sfntFromWoff(await loadEmojiFontInNode())) as unknown as FontkitFont);
  return emojiFace;
}

describe('contact-sheet-pdf — Arabic and Hebrew, in Noto Sans Arabic and Noto Sans Hebrew', () => {
  const ARABIC = 'مرحبا بالعالم، هل رأيت الفيلم؟';
  const HEBREW = 'שלום עולם, מה שלומך היום?';
  const bothLoaders = { loadArabicFont: loadArabicFontInNode, loadHebrewFont: loadHebrewFontInNode };

  /** The `/ActualText` strings of the page, in the order they are drawn. */
  function actualTexts(pdf: PDFDocument): string[] {
    return [...pageContent(pdf, 0).matchAll(/\/ActualText <FEFF([0-9A-F]*)>/g)].map((match) =>
      String.fromCharCode(...(match[1]?.match(/.{4}/g) ?? []).map((hex) => parseInt(hex, 16))),
    );
  }

  /** The x of the first glyph the `/ActualText` span of a word draws: where the run starts on the page. */
  function startOf(pdf: PDFDocument, word: string): number {
    const hex = [...word].map((char) => (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')).join('');
    const span = new RegExp(`/ActualText <FEFF${hex}>\\s*>>\\s*BDC[\\s\\S]*?1 0 0 1 (\\S+) \\S+ Tm`).exec(pageContent(pdf, 0));
    return Number(span?.[1] ?? Number.NaN);
  }

  /** The names of the fonts the file embeds as Type 0 fonts, without their subset tags. */
  function embeddedNames(pdf: PDFDocument): string[] {
    const names: string[] = [];
    for (const [, object] of pdf.context.enumerateIndirectObjects()) {
      if (object instanceof PDFDict && object.get(PDFName.of('Subtype')) === PDFName.of('Type0')) names.push(String(object.get(PDFName.of('BaseFont'))).replace(/^\/[A-Z]{6}\+/, ''));
    }
    return names.sort();
  }

  it('sets Arabic and Hebrew in their fonts, shaped, with the words as marked content and no "?"', async () => {
    const { pdf, result } = await compileSheet(rig({ state: withAction(`${ARABIC} ${HEBREW}`), ...bothLoaders }).exporter);
    const copied = actualTexts(pdf);
    for (const word of ['مرحبا', 'بالعالم', 'الفيلم', 'שלום', 'עולם', 'שלומך']) expect(copied, word).toContain(word);
    expect(embeddedNames(pdf)).toEqual(['NotoSansArabic-Regular', 'NotoSansHebrew-Regular']);
    expect(result.log.notes).toContain('contact sheet: Arabic, Persian and Urdu text is set in Noto Sans Arabic, embedded with only the glyphs it uses');
    expect(result.log.notes).toContain('contact sheet: Hebrew text is set in Noto Sans Hebrew, embedded with only the glyphs it uses');
    expect(result.log.notes.some((note) => note.includes('drawn as "?"'))).toBe(false);
    // The glyphs copy back as the letters they draw, in the fonts' ToUnicode maps.
    expect(toUnicodeText(pdf)).toContain('ب');
    expect(toUnicodeText(pdf)).toContain('ש');
  });

  it('puts the words of a right-to-left paragraph right to left and ends the line at the right edge of its box', async () => {
    const rtl = await compileSheet(rig({ state: withAction('מה שלומך היום'), ...bothLoaders }).exporter);
    const ltr = await compileSheet(rig({ state: withAction('How are you today'), ...bothLoaders }).exporter);
    // Logical order: מה, שלומך, היום. Drawn left to right: היום, שלומך, מה.
    expect(startOf(rtl.pdf, 'היום')).toBeLessThan(startOf(rtl.pdf, 'שלומך'));
    expect(startOf(rtl.pdf, 'שלומך')).toBeLessThan(startOf(rtl.pdf, 'מה'));
    // A left-to-right line starts at the left edge of the card's text box; the right-to-left line is set from the right.
    const left = Number(/1 0 0 1 (\S+) \S+ Tm\n<486F77/.exec(pageContent(ltr.pdf, 0))?.[1] ?? Number.NaN);
    expect(left).toBeGreaterThan(0);
    expect(startOf(rtl.pdf, 'היום')).toBeGreaterThan(left + 20);
  });

  it('turns the brackets of a right-to-left run: (בשקט) is drawn with its parentheses the right way round', async () => {
    const { pdf } = await compileSheet(rig({ state: withAction('(בשקט) שלום'), ...bothLoaders }).exporter);
    // The paragraph runs right to left: the bracketed word is to the right of the word that follows it.
    expect(startOf(pdf, 'שלום')).toBeLessThan(startOf(pdf, 'בשקט'));
    // The brackets are drawn "(" on the word's left and ")" on its right, the mirror images of the characters typed.
    const content = pageContent(pdf, 0);
    const open = content.indexOf(`<${hexOf(' (')}> Tj`);
    const close = content.indexOf(`<${hexOf(')')}> Tj`);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    expect(actualTexts(pdf)).toContain('בשקט');
  });

  it('cuts a line at a whole cluster, in logical order, before it puts the line in visual order', async () => {
    const long = Array.from({ length: 40 }, () => 'بِسْمِ').join(' ');
    const { pdf } = await compileSheet(rig({ state: withAction(long), ...bothLoaders }).exporter);
    const words = actualTexts(pdf);
    expect(words.length).toBeGreaterThan(1);
    expect(words.length).toBeLessThan(40);
    // Every word that was drawn is a whole one: the cut fell between words.
    for (const word of words) expect(word, word).toBe('بِسْمِ');
  });

  it('leaves the marks out of the drawn glyphs and counts them in the log, and the text of the file still holds them', async () => {
    const { pdf, result } = await compileSheet(rig({ state: withAction('بِسْمِ שָׁלוֹם'), ...bothLoaders }).exporter);
    expect(actualTexts(pdf)).toEqual(expect.arrayContaining(['بِسْمِ', 'שָׁלוֹם']));
    expect(result.log.notes.filter((note) => note.includes('left out of the print'))).toEqual([
      expect.stringMatching(/^contact sheet: 3 Hebrew points and cantillation marks are left out/),
      expect.stringMatching(/^contact sheet: 3 Arabic marks \(harakat, shadda and the like\) are left out/),
    ]);
  });

  it('leaves out a mark that a dropped bidi control character left next to a character of the other fonts, and counts it', async () => {
    for (const text of [`${ARABIC} .\u200f\u064e`, `${HEBREW} (\u202b\u064e`]) {
      const { result } = await compileSheet(rig({ state: withAction(text), ...bothLoaders }).exporter);
      expect(result.log.notes.filter((note) => note.includes('Arabic mark') && note.includes('left out'))).toEqual([expect.stringMatching(/^contact sheet: 1 Arabic mark/)]);
    }
  });

  it('reads each font once, and only for a sheet that holds its script', async () => {
    const arabic = countingLoader(loadArabicFontInNode);
    const hebrew = countingLoader(loadHebrewFontInNode);
    await compileSheet(rig({ state: withAction('Abeßer crosses the café © 2026'), loadArabicFont: arabic.load, loadHebrewFont: hebrew.load }).exporter);
    expect([arabic.calls(), hebrew.calls()]).toEqual([0, 0]);
    await compileSheet(rig({ state: withAction(`${ARABIC} ${ARABIC}`), loadArabicFont: arabic.load, loadHebrewFont: hebrew.load }).exporter);
    expect([arabic.calls(), hebrew.calls()]).toEqual([1, 0]);
  });

  it('draws both scripts as "?", and says why, when the compile has no font for them', async () => {
    const { pdf, result } = await compileSheet(rig({ state: withAction('مرحبا שלום') }).exporter);
    expect(embeddedFontFiles(pdf)).toHaveLength(0);
    const note = result.log.notes.find((line) => line.includes('drawn as "?"')) ?? '';
    expect(note).toContain('this compile has no Arabic font');
    expect(note).toContain('this compile has no Hebrew font');
  });

  it('writes a Latin-only sheet byte for byte as it was, with the Arabic and Hebrew fonts given', async () => {
    const state = withAction('Abeßer crosses the café © 2026');
    const plain = await compileSheet(rig({ state }).exporter);
    const given = await compileSheet(rig({ state, ...bothLoaders }).exporter);
    expect(given.bytes).toEqual(plain.bytes);
  });
});

describe('contact-sheet-pdf — Devanagari, in Noto Sans Devanagari', () => {
  const HINDI = 'राम हिन्दी में क्षत्रिय श्रीमान् प्रेम कार्यक्रम स्त्री की बात।';

  /** The `/ActualText` strings of the page, in the order they are drawn. */
  function actualTexts(pdf: PDFDocument): string[] {
    return [...pageContent(pdf, 0).matchAll(/\/ActualText <FEFF([0-9A-F]*)>/g)].map((match) =>
      String.fromCharCode(...(match[1]?.match(/.{4}/g) ?? []).map((hex) => parseInt(hex, 16))),
    );
  }

  it('sets Hindi in the font, shaped, with each word as marked content, the typed text in the ToUnicode map, and no "?"', async () => {
    const { pdf, result } = await compileSheet(rig({ state: withAction(HINDI), loadDevanagariFont: loadDevanagariFontInNode }).exporter);
    const copied = actualTexts(pdf);
    for (const word of ['राम', 'हिन्दी', 'में', 'क्षत्रिय', 'श्रीमान्', 'प्रेम', 'कार्यक्रम', 'स्त्री', 'की', 'बात।']) expect(copied, word).toContain(word);
    expect(copied.indexOf('हिन्दी')).toBeLessThan(copied.indexOf('क्षत्रिय'));
    expect(result.log.notes).toContain('contact sheet: Devanagari text is set in Noto Sans Devanagari, embedded with only the glyphs it uses');
    expect(result.log.notes.some((note) => note.includes('drawn as "?"'))).toBe(false);
    const entries = toUnicodeEntries(pdf);
    // The cluster is the text of the first glyph drawn of it: कि is drawn with its short i first, and copies back as typed.
    for (const cluster of ['हि', 'क्ष', 'स्त्री', 'र्य']) expect(entries.some((entry) => entry.includes(cluster)), cluster).toBe(true);
    expect(embeddedFontFiles(pdf)).toHaveLength(1);
    expect((embeddedFontFiles(pdf)[0] as Uint8Array).length).toBeLessThan(100_000);
  });

  it('cuts a line wider than its box with an ellipsis on a cluster boundary, and never inside a conjunct', async () => {
    const word = 'क्षत्रिय'.repeat(40);
    const { pdf } = await compileSheet(rig({ state: withAction(word), loadDevanagariFont: loadDevanagariFontInNode }).exporter);
    const drawn = actualTexts(pdf).filter((text) => text.startsWith('क्ष'));
    expect(drawn.length).toBeGreaterThan(0);
    for (const text of drawn) {
      expect(text.length).toBeLessThan(word.length);
      expect(text.endsWith('्'), text).toBe(false);
      // Every cluster of the kept head is a whole one.
      expect(text.replace(/क्ष|त्रि|य/gu, ''), text).toBe('');
    }
  });

  it('shapes the precomposed nukta letter and the letter with its nukta alike, as NFC does', async () => {
    const state = (text: string) => rig({ state: withAction(text), loadDevanagariFont: loadDevanagariFontInNode }).exporter;
    const composed = await compileSheet(state('क़ फ़ क़ फ़'));
    const decomposed = await compileSheet(state('क़ फ़ क़ फ़'));
    expect(pageContent(composed.pdf, 0)).toBe(pageContent(decomposed.pdf, 0));
  });

  it('reads the font once, and only for a sheet that holds Devanagari', async () => {
    const loader = countingLoader(loadDevanagariFontInNode);
    await compileSheet(rig({ state: withAction('Abeßer crosses the café © 2026'), loadDevanagariFont: loader.load }).exporter);
    expect(loader.calls()).toBe(0);
    await compileSheet(rig({ state: withAction(`${HINDI} ${HINDI}`), loadDevanagariFont: loader.load }).exporter);
    expect(loader.calls()).toBe(1);
  });

  it('draws Devanagari as "?", and says why, when the compile has no font or the font cannot be read', async () => {
    const none = await compileSheet(rig({ state: withAction('हिन्दी') }).exporter);
    expect(embeddedFontFiles(none.pdf)).toHaveLength(0);
    expect(none.result.log.notes.find((line) => line.includes('drawn as "?"'))).toContain('this compile has no Devanagari font');
    const failing: FontLoader = async () => {
      throw new Error('offline');
    };
    const failed = await compileSheet(rig({ state: withAction('हिन्दी'), loadDevanagariFont: failing }).exporter);
    expect(failed.result.log.notes.find((line) => line.includes('drawn as "?"'))).toContain('the Devanagari font could not be read (offline)');
  });

  it('names a script that has no font, and not Devanagari, when both are in the sheet', async () => {
    const { result } = await compileSheet(rig({ state: withAction('हिन्दी தமிழ்'), loadDevanagariFont: loadDevanagariFontInNode }).exporter);
    const note = result.log.notes.find((line) => line.includes('drawn as "?"')) ?? '';
    expect(note).toContain('த (U+0BA4)');
    expect(note).not.toContain('U+0939');
  });

  it('writes a Latin-only sheet byte for byte as it was, with the Devanagari font given', async () => {
    const state = withAction('Abeßer crosses the café © 2026');
    const plain = await compileSheet(rig({ state }).exporter);
    const given = await compileSheet(rig({ state, loadDevanagariFont: loadDevanagariFontInNode }).exporter);
    expect(given.bytes).toEqual(plain.bytes);
  });
});

describe('contact-sheet-pdf — emoji, in the Noto Emoji fallback font', () => {
  // A ZWJ family, a ZWJ profession with a skin tone, a skin tone, a flag, two keycaps, a tag sequence, VS16 and a VS15 pictograph.
  const SEQUENCES = ['👨‍👩‍👧‍👦', '🧑🏽‍💻', '👍🏽', '🇩🇪', '1️⃣', '#️⃣', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '❤️', '🎬', '🏳️‍🌈'];

  it('draws each emoji sequence as one glyph, and the exact sequence extracts back', async () => {
    const emojiLoader = countingLoader(loadEmojiFontInNode);
    const cjkLoader = countingLoader();
    const state = withAction(`Cut ${SEQUENCES.join(' ')} end`);
    const { pdf, result } = await compileSheet(rig({ state, files: {}, loadFallbackFont: cjkLoader.load, loadEmojiFont: emojiLoader.load }).exporter);
    expect(emojiLoader.calls()).toBe(1);
    // Emoji in emoji presentation go straight to the emoji font: the CJK font is never read.
    expect(cjkLoader.calls()).toBe(0);
    const entries = toUnicodeEntries(pdf);
    for (const sequence of SEQUENCES) expect(entries, sequence).toContain(sequence);
    // One CID (four hex digits) per sequence: the ligature, never the parts.
    const shows = emojiShows(pdf, 0);
    expect(shows.map((hex) => hex.length / 4)).toEqual(SEQUENCES.map(() => 1));
    expect(result.log.notes).toContain('contact sheet: emoji are set in Noto Emoji, in monochrome, embedded with only the glyphs they use');
    expect(result.log.notes.some((note) => note.includes('drawn as "?"'))).toBe(false);
  });

  it('gives 👍 and 👍🏽 back as they were typed, though the monochrome font draws them with one glyph', async () => {
    const { pdf } = await compileSheet(rig({ state: withAction('👍 and 👍🏽 and 👍'), loadEmojiFont: loadEmojiFontInNode }).exporter);
    const entries = toUnicodeEntries(pdf);
    expect(entries).toContain('👍');
    expect(entries).toContain('👍🏽');
    // Two CIDs, one per distinct sequence; the third thumb reuses the first.
    const files = embeddedFontFiles(pdf);
    expect(files).toHaveLength(1);
    const subset = fontkit.create(files[0] as Uint8Array) as unknown as { numGlyphs: number };
    expect(subset.numGlyphs).toBeGreaterThanOrEqual(2);
    const [first, second, third] = emojiShows(pdf, 0);
    expect(first).toBe(third);
    expect(first).not.toBe(second);
  });

  it('draws a ZWJ sequence no Emoji version has as its parts, and the whole sequence extracts back', async () => {
    const catSloth = '\u{1F408}\u200D\u{1F9A5}';
    const { pdf, result } = await compileSheet(rig({ state: withAction(catSloth), loadEmojiFont: loadEmojiFontInNode }).exporter);
    expect(emojiShows(pdf, 0).map((hex) => hex.length / 4)).toEqual([2]);
    expect(toUnicodeEntries(pdf).join('')).toBe(catSloth);
    expect(result.log.notes.some((note) => note.includes('drawn as "?"'))).toBe(false);
  });

  it('draws the woman and man walking, kneeling and running facing right as one glyph each, which extracts back as typed', async () => {
    const harfbuzz = await harfbuzzEmoji();
    const people = fullyQualifiedEmoji().filter(({ name }) => /^(woman|man) (walking|kneeling|running) facing right/.test(name));
    expect(people).toHaveLength(36);
    // The six plain ones and two toned (a card holds two lines; the every-emoji sheet below prints all 108): one CID each, one glyph each.
    const shown = people.filter(({ name }) => !name.includes('skin tone') || name.endsWith('dark skin tone')).slice(0, 8);
    const { pdf, result } = await compileSheet(rig({ state: withAction(shown.map(({ emoji }) => emoji).join(' ')), loadEmojiFont: loadEmojiFontInNode }).exporter);
    for (const hex of emojiShows(pdf, 0)) expect(hex.length / 4, hex).toBe(1);
    expect(new Set(toUnicodeEntries(pdf))).toEqual(new Set(shown.map(({ emoji }) => emoji)));
    const face = await noto();
    for (const { emoji, name } of people) expect(face.glyphsOf(emoji)?.map((glyph) => glyph.id), name).toEqual(harfbuzz(emoji));
    expect(new Set(people.map(({ emoji }) => harfbuzz(emoji)[0])).size).toBe(3);
    expect(result.log.notes.some((note) => note.includes('drawn as "?"'))).toBe(false);
  });

  it('tries the text fonts first for a pictograph whose default is text, and keeps a VS15 pictograph in a text font', async () => {
    const emojiLoader = countingLoader(loadEmojiFontInNode);
    // ✌ (U+270C) has no emoji presentation by default, and the CJK font has no glyph for it; ©︎ asks for text and Helvetica has ©.
    const { pdf, result } = await compileSheet(rig({ state: withAction('✌ ©︎'), loadFallbackFont: loadCjkFontInNode, loadEmojiFont: emojiLoader.load }).exporter);
    expect(emojiLoader.calls()).toBe(1);
    expect(toUnicodeEntries(pdf)).toContain('✌');
    expect(pageContent(pdf, 0)).toContain(`<${hexOf(' ©')}> Tj`);
    expect(result.log.notes.some((note) => note.includes('drawn as "?"'))).toBe(false);
  });

  it('never reads the emoji font for a sheet without emoji', async () => {
    const emojiLoader = countingLoader(loadEmojiFontInNode);
    const latin = await compileSheet(rig({ state: withAction('Abeßer crosses the café © 2026'), loadEmojiFont: emojiLoader.load }).exporter);
    const cjk = await compileSheet(rig({ state: withAction('草堂的早晨'), loadFallbackFont: loadCjkFontInNode, loadEmojiFont: emojiLoader.load }).exporter);
    expect(emojiLoader.calls()).toBe(0);
    expect(embeddedFontFiles(latin.pdf)).toHaveLength(0);
    expect(embeddedFontFiles(cjk.pdf)).toHaveLength(1);
    expect([...latin.result.log.notes, ...cjk.result.log.notes].some((note) => note.includes('Noto Emoji'))).toBe(false);
  });

  // U+1FFFD is in the range reserved for future pictographs: a character no font will have, which still tries the emoji font.
  it('draws a pictograph no font has as "?", and names it in the log', async () => {
    const { result, pdf } = await compileSheet(rig({ state: withAction('🎬 \u{1FFFD}'), loadFallbackFont: loadCjkFontInNode, loadEmojiFont: loadEmojiFontInNode }).exporter);
    expect(result.log.notes).toContain('contact sheet: 1 character neither the PDF\'s built-in font nor Noto Sans Mono CJK SC nor Noto Emoji can show was drawn as "?": \u{1FFFD} (U+1FFFD)');
    expect(toUnicodeEntries(pdf)).toContain('🎬');
  });

  it('embeds no emoji font when the font was read but drew nothing, as for a sheet whose only pictograph no font has', async () => {
    const emojiLoader = countingLoader(loadEmojiFontInNode);
    const { result, pdf } = await compileSheet(rig({ state: withAction('Cut \u{1FFFD} now'), loadFallbackFont: loadCjkFontInNode, loadEmojiFont: emojiLoader.load }).exporter);
    expect(emojiLoader.calls()).toBe(1);
    expect(result.log.notes).toContain('contact sheet: 1 character neither the PDF\'s built-in font nor Noto Sans Mono CJK SC nor Noto Emoji can show was drawn as "?": \u{1FFFD} (U+1FFFD)');
    expect(result.log.notes.some((note) => note.includes('emoji are set in'))).toBe(false);
    expect(embeddedFontFiles(pdf)).toHaveLength(0);
    expect(toUnicodeEntries(pdf)).toEqual([]);
  });

  it('writes no font objects from an emoji embedding that drew no glyph', async () => {
    const lib = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const embedding = new EmojiEmbedding(lib, doc, await noto());
    const before = doc.context.enumerateIndirectObjects().length;
    await embedding.finish();
    expect(embedding.used).toBe(false);
    expect(doc.context.enumerateIndirectObjects().length).toBe(before);
    expect(doc.context.lookup(embedding.ref)).toBeUndefined();
  });

  it('rejects when fontkit throws while it encodes the emoji subset, which it does on the next tick, instead of hanging', async () => {
    const lib = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const face = await noto();
    const embedding = new EmojiEmbedding(lib, doc, face);
    const page = doc.addPage();
    const glyphs = face.glyphsOf('👍');
    if (glyphs === null) throw new Error('the font draws 👍');
    embedding.draw(page, glyphs, 10, 10, 12, { r: 0, g: 0, b: 0 });
    const subset = (embedding as unknown as { subset: { encode: () => void } }).subset;
    subset.encode = () => {
      throw new Error('encode failed');
    };
    const outcome = await Promise.race([
      embedding.finish().then(() => 'resolved', (error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 2000)),
    ]);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('encode failed');
  });

  it('draws emoji as "?", and says why, when the compile has no emoji font or it cannot be read', async () => {
    const none = await compileSheet(rig({ state: withAction('🎬') }).exporter);
    expect(none.result.log.notes).toContain(
      'contact sheet: 1 character the PDF\'s built-in font cannot show, and this compile has no emoji font, was drawn as "?": 🎬 (U+1F3AC)',
    );
    const failing: FontLoader = async () => {
      throw new Error('offline');
    };
    const broken = await compileSheet(rig({ state: withAction('👨‍👩‍👧'), loadEmojiFont: failing }).exporter);
    expect(broken.result.log.notes).toContain(
      'contact sheet: 1 character the PDF\'s built-in font cannot show, and the emoji font could not be read (offline), was drawn as "?": 👨‍👩‍👧 (U+1F468 U+200D U+1F469 U+200D U+1F467)',
    );
    expect(embeddedFontFiles(broken.pdf)).toHaveLength(0);
  });

  it('writes the same bytes for the same sheet and the same moment, with emoji', async () => {
    const state = withAction(`草堂 ${SEQUENCES.join('')}`);
    const options = { state, loadFallbackFont: loadCjkFontInNode, loadEmojiFont: loadEmojiFontInNode };
    const first = await compileSheet(rig(options).exporter);
    const second = await compileSheet(rig(options).exporter);
    expect([...first.bytes]).toEqual([...second.bytes]);
  });

  it('wraps and cuts emoji as whole clusters, measured in the emoji font', async () => {
    const family = '👨‍👩‍👧';
    const planned = planContactSheet(withAction(family.repeat(80)), ['manuscript'], () => ({ drawn: false, note: 'none' }));
    const card = planned.plan.pages[0]?.cards.find((placed) => placed.shotId === 'n_WORLD00001');
    // The plan breaks between families, never inside one, and ends the second line with an ellipsis.
    for (const line of card?.action ?? []) expect(line.text.replace('…', '').replaceAll(family, '')).toBe('');
    expect(card?.action[1]?.text.endsWith('…')).toBe(true);
    const drawn = await drawContactSheet({
      plan: planned.plan,
      pictures: new Map(),
      readPicture: async () => null,
      title: 'T',
      at: new Date(COMPILED_AT),
      loadEmojiFont: loadEmojiFontInNode,
    });
    const pdf = await PDFDocument.load(drawn.contents);
    const width = card?.frame.width ?? 0;
    // Each family is one CID; each line holds as many as fit at 8 pt, 2600/2048 em each, the last giving room to the ellipsis.
    const perLine = Math.floor(width / ((8 * 2600) / 2048));
    const counts = emojiShows(pdf, 0).map((hex) => hex.length / 4);
    expect(counts[0]).toBe(perLine);
    expect(counts[1]).toBeLessThan(perLine);
    expect(toUnicodeEntries(pdf)).toEqual([family]);
    expect(drawn.notes.some((note) => note.includes('drawn as "?"'))).toBe(false);
  });
});

describe('the emoji font file covers Unicode Emoji 17.0', () => {
  const ALL = fullyQualifiedEmoji();

  it('lists every fully-qualified emoji of the version the font supports', () => {
    expect(ALL).toHaveLength(3944);
  });

  it('draws every fully-qualified emoji with no .notdef, as the one glyph HarfBuzz lays out for it, copied back as typed', async () => {
    const face = await noto();
    const harfbuzz = await harfbuzzEmoji();
    const missing: string[] = [];
    const split: string[] = [];
    for (const { emoji, name } of ALL) {
      expect(emojiStyleOf(emoji), name).toBe('emoji');
      expect(graphemesOf(emoji), name).toHaveLength(1);
      const glyphs = face.glyphsOf(emoji);
      if (glyphs === null) missing.push(name);
      else if (glyphs.length !== 1) split.push(name);
      expect(glyphs?.map((glyph) => glyph.id), name).toEqual(harfbuzz(emoji));
      // The text the glyphs give back, joined, is the sequence as it was typed.
      if (glyphs !== null) expect(glyphs.map((glyph) => glyph.text).join(''), name).toBe(emoji);
    }
    expect(missing).toEqual([]);
    // None is drawn in parts, the 108 people "facing right" included, and each is as wide as any emoji.
    expect(split).toEqual([]);
    const facingRight = ALL.filter(({ name }) => name.includes('facing right'));
    expect(facingRight).toHaveLength(108);
    for (const { emoji, name } of facingRight) expect(face.widthOf(face.glyphsOf(emoji) ?? [], 8), name).toBe((8 * 2600) / 2048);
  });

  it('draws a ZWJ sequence no Emoji version has as its parts, as Unicode recommends', async () => {
    const face = await noto();
    // A cat joined to a sloth: no ligature, so the cat, then the sloth, the joiner copied with the sloth.
    const glyphs = face.glyphsOf('\u{1F408}\u200D\u{1F9A5}');
    expect(glyphs?.map((glyph) => glyph.text)).toEqual(['\u{1F408}', '\u200D\u{1F9A5}']);
  });

  it('draws the emoji of 16.0 and 17.0 as one glyph each, copied back as typed', async () => {
    const face = await noto();
    for (const emoji of ['🫩', '🫆', '🪾', '🫜', '🪉', '🪏', '🫟', '🇨🇶', '🫪', '🛘']) {
      const glyphs = face.glyphsOf(emoji);
      expect(glyphs, emoji).toHaveLength(1);
      expect(glyphs?.[0]?.text, emoji).toBe(emoji);
    }
  });

  it('draws a minimally-qualified or unqualified emoji as the glyphs of its fully-qualified form', async () => {
    const face = await noto();
    const qualified = new Map(ALL.map(({ emoji, name }) => [name, emoji]));
    const others = emojiList().filter(({ status }) => status === 'minimally-qualified' || status === 'unqualified');
    expect(others.length).toBeGreaterThan(1000);
    for (const { emoji, name } of others) {
      const full = qualified.get(name) ?? '';
      expect(full, `${name} has a fully-qualified form`).not.toBe('');
      const glyphs = face.glyphsOf(emoji);
      expect(glyphs, name).not.toBeNull();
      expect(glyphs?.map((glyph) => glyph.id), name).toEqual(face.glyphsOf(full)?.map((glyph) => glyph.id));
    }
  });

  it('prints every fully-qualified emoji in a contact sheet without one "?"', async () => {
    const state = makeMediaProject();
    // Six emoji to a card, three to a line.
    const per = 6;
    for (let i = 0; i * per < ALL.length; i += 1) {
      const chunk = ALL.slice(i * per, (i + 1) * per).map(({ emoji }) => emoji);
      addShotNode(state, {
        parentId: MEDIA_IDS.shots,
        title: `Emoji ${i + 1}`,
        id: `n_EMOJI${String(i).padStart(5, '0')}`,
        now: OPENED,
        stored: { action: `${chunk.slice(0, per / 2).join('')} ${chunk.slice(per / 2).join('')}` },
      });
    }
    const { result, pdf } = await compileSheet(rig({ state, files: {}, loadEmojiFont: loadEmojiFontInNode }).exporter);
    expect(result.log.notes.filter((note) => note.includes('drawn as "?"'))).toEqual([]);
    const entries = new Set(toUnicodeEntries(pdf));
    for (const { emoji, name } of ALL) {
      expect(entries.has(emoji), name).toBe(true);
    }
  }, 120_000);
});

describe('the emitter draws the plan it is given', () => {
  it('draws exactly the pages the plan lists, from a plan with no project around it', async () => {
    const state = manyShots(14); // 16 shots
    const planned = planContactSheet(state, ['manuscript'], () => ({ drawn: false, note: 'none' }), { headerTemplate: CONTACT_SHEET_HEADER });
    const drawn = await drawContactSheet({ plan: planned.plan, pictures: new Map(), readPicture: async () => null, title: 'T', at: new Date(COMPILED_AT) });
    const pdf = await PDFDocument.load(drawn.contents);
    expect(pdf.getPageCount()).toBe(planned.plan.pages.length);
    expect(drawn.notes).toEqual([]);
  });

  it('writes the same bytes for the same plan and the same moment', async () => {
    const planned = planContactSheet(makeMediaProject(), ['manuscript'], () => ({ drawn: true }));
    const input = { plan: planned.plan, pictures: planned.pictures, readPicture: async () => PNG_1X1, title: 'T', at: new Date(COMPILED_AT) };
    const first = await drawContactSheet(input);
    const second = await drawContactSheet(input);
    expect([...first.contents]).toEqual([...second.contents]);
  });
});

describe('fitToWidth and containIn', () => {
  const measure = (text: string): number => [...text].length * 5;

  it('leaves text that fits, and cuts text that does not with an ellipsis inside the width', () => {
    expect(fitToWidth('short', 100, measure)).toBe('short');
    const cut = fitToWidth('a much longer line of text', 60, measure);
    expect(cut.endsWith('…')).toBe(true);
    expect(measure(cut)).toBeLessThanOrEqual(60);
    expect(fitToWidth('anything', 2, measure)).toBe('');
  });

  it('scales a picture to fit its box, centred and never stretched', () => {
    const box = { x: 10, y: 20, width: 160, height: 90 };
    expect(containIn(box, 1600, 900)).toEqual(box);
    const square = containIn(box, 100, 100);
    expect(square).toEqual({ x: 10 + (160 - 90) / 2, y: 20, width: 90, height: 90 });
    const tall = containIn(box, 90, 180);
    expect(tall.height).toBe(90);
    expect(tall.width).toBe(45);
    expect(containIn(box, 0, 0)).toEqual(box);
  });
});

describe('pdf-lib is loaded lazily', () => {
  it('is imported in the emitter with a dynamic import() and as types only, so the editor bundle never pays for it', () => {
    const source = readFileSync(resolve(__dirname, '../src/render-contact-sheet.ts'), 'utf8');
    expect(source).toMatch(/await import\('pdf-lib'\)/);
    expect(source).not.toMatch(/^import (?!type )[^\n]*from 'pdf-lib'/m);
    for (const file of ['exporter.ts', 'media.ts', 'index.ts']) {
      expect(readFileSync(resolve(__dirname, `../src/${file}`), 'utf8')).not.toMatch(/from 'pdf-lib'/);
    }
  });

  it('loads fontkit with a dynamic import() too, and keeps the Node font loader out of the package index', () => {
    const source = readFileSync(resolve(__dirname, '../src/render-contact-sheet.ts'), 'utf8');
    expect(source).not.toMatch(/^import (?!type )[^\n]*from '@pdf-lib\/fontkit'/m);
    // The shared module loads it, on first use.
    const shared = readFileSync(resolve(__dirname, '../../pdf-fonts/src/fontkit.ts'), 'utf8');
    expect(shared).toMatch(/import\('@pdf-lib\/fontkit'\)/);
    expect(shared).not.toMatch(/^import (?!type )[^\n]*from '@pdf-lib\/fontkit'/m);
    const woff = readFileSync(resolve(__dirname, '../../pdf-fonts/src/font-bytes.ts'), 'utf8');
    expect(woff).toMatch(/await import\('fflate\/browser'\)/);
    expect(woff).not.toMatch(/^import (?!type )[^;]*from 'fflate[^']*';/m);
    for (const file of ['exporter.ts', 'media.ts', 'index.ts', 'render-contact-sheet.ts', 'emoji-font.ts']) {
      const text = readFileSync(resolve(__dirname, `../src/${file}`), 'utf8');
      expect(text).not.toMatch(/from '\.\/fallback-fonts-node\.js'/);
      expect(text).not.toMatch(/^import (?!type )[^\n]*from 'pdf-lib'/m);
      expect(text).not.toMatch(/from 'node:/);
    }
  });
});
