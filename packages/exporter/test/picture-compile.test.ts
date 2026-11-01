/**
 * A manuscript with pictures through the compile (pictures.md §4): the recipe's picture options reach each prose format, a Markdown copy
 * writes the used pictures beside the file and every destination resolves from the export folder, plain text writes the placeholder,
 * and an EPUB and a DOCX carry the picture as a figure with its caption and alt text, stripped of private metadata unless the recipe
 * keeps it. The bus is the path a click takes, so every check reads what the folder holds.
 */

import { describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate/browser';
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
import { addDocument, createProjectCommandRegistry, MemoryArtifactFs, type ProjectState } from '@caotang/store';
import { encodePlacementTitle, type ProcessPicture } from '@caotang/pictures';

import { createExporter, recipesOf, type ByteArtifacts } from '../src/index.js';
import { processPictureInNode } from '../src/picture-process-node.js';
import { COMPILED_AT, IDS, makeProject } from './fixture.js';
import { hasMarker, ID_A, ID_B, ID_C, jpgFile, pngFile, solidJpeg, solidPng, urlOf, withJpegXmp, withPngXmp } from './figure-fixtures.js';
import { webpFixture } from './webp-fixtures.js';

vi.setConfig({ testTimeout: 30_000 });

type Dispatch = Result<ExecutionOutcome, CommandError>;

const EPUB_IDENTIFIER = 'urn:uuid:3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d';
const TITLE = encodePlacementTitle({ caption: 'The lantern', size: 'half' }) ?? '';
const ID_W = 'a_DK3QZ2M7RD';
/** A recipe names its export, so the file stem is the recipe's name (with its space, which a Markdown destination must encode). */
const RECIPE = 'Beta read';
const STEM = RECIPE;
const ASSETS_FOLDER = `exports/${STEM}.assets`;

const BODY = [
  'The pier at dusk.',
  '',
  `![A lantern on the pier](${urlOf(pngFile(ID_A))} "${TITLE}")`,
  '',
  `![The ferry](${urlOf(jpgFile(ID_B))} "The ferry")`,
  '',
  'The ferry came in.',
].join('\n');

/** The files `assets/` holds: the lantern is a PNG, the ferry a JPEG, each carrying a marker a metadata strip removes. */
const FILES: Readonly<Record<string, Uint8Array>> = {
  [`assets/${pngFile(ID_A)}`]: withPngXmp(solidPng(40, 20)),
  [`assets/${jpgFile(ID_B)}`]: withJpegXmp(solidJpeg(30, 30)),
  [`assets/${pngFile(ID_C)}`]: solidPng(8, 8),
  [`assets/${ID_W}.webp`]: webpFixture('lossy'),
};

interface Compiled {
  readonly outputs: readonly string[];
  readonly notes: readonly string[];
  readonly text: (path: string) => string;
  readonly bytes: (path: string) => Uint8Array;
  readonly written: () => string[];
  readonly state: ProjectState;
}

let serial = 0;

/** Compiles the picture manuscript under a recipe holding `options`, and hands back what the exports folder holds. */
async function compile(
  format: string,
  options: Record<string, unknown>,
  setup: { readonly body?: string; readonly files?: Readonly<Record<string, Uint8Array>>; readonly process?: ProcessPicture | null } = {},
): Promise<Compiled> {
  const state = makeProject();
  addDocument(state, { parentId: IDS.chapterOne, title: 'The Pier', body: setup.body ?? BODY, now: new Date(COMPILED_AT), id: 'n_PIER000001' });
  const fs = new MemoryArtifactFs();
  const bytes = new Map<string, Uint8Array>();
  const binding: ByteArtifacts = {
    writeBytes: async (path, data) => void bytes.set(path, data),
    removeBytes: async (path) => void bytes.delete(path),
  };
  const files = setup.files ?? FILES;
  const clock = { now: () => COMPILED_AT };
  const process = setup.process === undefined ? processPictureInNode : setup.process;
  const exporter = createExporter({
    readState: () => state,
    artifacts: fs,
    bytes: binding,
    clock,
    metadata: () => ({ identifier: EPUB_IDENTIFIER, language: 'en' }),
    readAsset: async (path) => files[path] ?? null,
    ...(process === null ? {} : { processPicture: process }),
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
    return execute({ id: `cmd_PICS${String(serial).padStart(7, '0')}`, name, params, issuedBy: 'user', createdAt: COMPILED_AT } as Command, bus, registry);
  };
  await exporter.ready();
  const saved = run('recipe.save', { name: RECIPE, includeRootIds: ['manuscript'], format, options });
  if (!saved.ok) throw new Error(`recipe.save refused: ${saved.error.message}`);
  const outcome = run('export.compile', { format, recipeName: RECIPE });
  if (!outcome.ok) throw new Error(`refused: ${outcome.error.code}: ${outcome.error.message}`);
  await exporter.idle();
  const result = outcome.value.result as { output: string; outputs?: string[] };
  const rows = JSON.parse(fs.snapshot()['exports/compile-log.json'] ?? '[]') as Array<{ notes?: string[] }>;
  return {
    outputs: result.outputs ?? [result.output],
    notes: rows[0]?.notes ?? [],
    text: (path) => fs.snapshot()[path] ?? '',
    bytes: (path) => bytes.get(path) ?? new Uint8Array(),
    written: () => [...Object.keys(fs.snapshot()).filter((path) => !path.endsWith('compile-log.json')), ...bytes.keys()],
    state,
  };
}

const destinationsOf = (markdown: string): string[] => [
  ...[...markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((match) => match[1] ?? ''),
  ...[...markdown.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)].map((match) => match[1] ?? ''),
];

describe('Markdown copy (the default)', () => {
  it('writes the used pictures into <name>.assets/ beside the file and points every destination at them', async () => {
    const out = await compile('md', {});
    expect(out.outputs).toEqual([`exports/${STEM}.md`, `${ASSETS_FOLDER}/${pngFile(ID_A)}`, `${ASSETS_FOLDER}/${jpgFile(ID_B)}`]);
    const markdown = out.text(`exports/${STEM}.md`);
    expect(markdown).toContain(`![A lantern on the pier](Beta%20read.assets/${pngFile(ID_A)} "The lantern")`);
    expect(markdown).toContain(`![The ferry](Beta%20read.assets/${jpgFile(ID_B)} "The ferry")`);
    expect(markdown).not.toContain('../assets');
    expect(markdown).not.toContain('..');
    expect(markdown).toContain('The pier at dusk.\n');
  });

  it('resolves every destination to a file the export wrote, from an isolated export folder', async () => {
    const out = await compile('md', {});
    const destinations = destinationsOf(out.text(`exports/${STEM}.md`));
    expect(destinations).toHaveLength(2);
    for (const destination of destinations) {
      expect(destination.split('/')).not.toContain('..');
      const path = `exports/${decodeURIComponent(destination)}`;
      expect(out.bytes(path).length, path).toBeGreaterThan(0);
    }
  });

  it('copies a picture once however often it is placed, and copies nothing the manuscript does not place', async () => {
    const body = [`![one](${urlOf(pngFile(ID_A))})`, '', `![two](${urlOf(pngFile(ID_A))})`].join('\n');
    const out = await compile('md', {}, { body });
    expect(out.outputs).toEqual([`exports/${STEM}.md`, `${ASSETS_FOLDER}/${pngFile(ID_A)}`]);
    expect(out.written().some((path) => path.includes(ID_C))).toBe(false);
  });

  it('strips the private metadata of a copied picture, and keeps it when the recipe says so', async () => {
    const stripped = await compile('md', {});
    expect(hasMarker(FILES[`assets/${pngFile(ID_A)}`] ?? new Uint8Array())).toBe(true);
    expect(hasMarker(stripped.bytes(`${ASSETS_FOLDER}/${pngFile(ID_A)}`))).toBe(false);
    expect(hasMarker(stripped.bytes(`${ASSETS_FOLDER}/${jpgFile(ID_B)}`))).toBe(false);
    const kept = await compile('md', { keepPictureMetadata: true });
    expect(hasMarker(kept.bytes(`${ASSETS_FOLDER}/${pngFile(ID_A)}`))).toBe(true);
    expect(hasMarker(kept.bytes(`${ASSETS_FOLDER}/${jpgFile(ID_B)}`))).toBe(true);
  });

  it('runs on a host with no ProcessPicture, because a copy changes no pixels', async () => {
    const out = await compile('md', {}, { process: null });
    expect(out.outputs).toHaveLength(3);
  });

  it('exports the alt text, writes no copy and logs it for a picture whose file is not in assets/', async () => {
    const out = await compile('md', {}, { files: {} });
    expect(out.written()).toEqual([`exports/${STEM}.md`]);
    const markdown = out.text(`exports/${STEM}.md`);
    expect(markdown).toContain('A lantern on the pier\n');
    expect(markdown).not.toContain('![');
    expect(out.notes).toContain(`markdown: ${pngFile(ID_A)} is placed in the manuscript but its file is not in assets/, so no copy is written for it`);
    expect(out.notes.some((note) => note.startsWith(`${pngFile(ID_A)} is placed in the manuscript but its file is not in assets/`))).toBe(true);
  });

  it('logs the weight of the copied pictures and the heaviest', async () => {
    const out = await compile('md', {});
    expect(out.notes.find((note) => note.startsWith('pictures: 2 pictures weigh '))).toContain(`${pngFile(ID_A)} (`);
  });
});

describe('Markdown link and drop', () => {
  it('link writes the one file, keeps the project-relative destinations and logs what moving it costs', async () => {
    const out = await compile('md', { pictures: 'link' });
    expect(out.outputs).toEqual([`exports/${STEM}.md`]);
    const markdown = out.text(`exports/${STEM}.md`);
    expect(markdown).toContain(`![A lantern on the pier](${urlOf(pngFile(ID_A))} "The lantern")`);
    expect(out.notes).toContain('markdown: the pictures are linked at their project-relative paths, so moving the exported file away from the project folder breaks them');
    expect(out.written().some((path) => path.endsWith('.png'))).toBe(false);
  });

  it('drop writes the one file with the alt text in place of each picture and logs the count', async () => {
    const out = await compile('md', { pictures: 'drop' });
    expect(out.outputs).toEqual([`exports/${STEM}.md`]);
    const markdown = out.text(`exports/${STEM}.md`);
    expect(markdown).toContain('The pier at dusk.\n\nA lantern on the pier\n\nThe ferry\n\nThe ferry came in.');
    expect(markdown).not.toContain('![');
    expect(out.notes).toContain('markdown: 2 pictures were left out (the recipe’s pictures option is drop), with their alt or caption text in their place');
  });

  it('honours a plain-text mode on Markdown as drop, and says so', async () => {
    const out = await compile('md', { pictures: 'placeholder' });
    expect(out.outputs).toEqual([`exports/${STEM}.md`]);
    expect(out.notes).toContain("md: the pictures option 'placeholder' is a plain-text one, so the pictures are left out with their text in their place");
  });
});

describe('plain text', () => {
  it('writes [Picture: caption] for each picture, by default, and no other file', async () => {
    const out = await compile('txt', {});
    expect(out.outputs).toEqual([`exports/${STEM}.txt`]);
    expect(out.text(`exports/${STEM}.txt`)).toContain('The pier at dusk.\n\n[Picture: The lantern]\n\n[Picture: The ferry]\n\nThe ferry came in.');
  });

  it('omits the pictures when the recipe drops them', async () => {
    const out = await compile('txt', { pictures: 'drop' });
    const text = out.text(`exports/${STEM}.txt`);
    expect(text).toContain('The pier at dusk.\n\nThe ferry came in.');
    expect(text).not.toContain('[Picture');
  });

  it('honours a Markdown mode on plain text as the placeholder, and says so', async () => {
    const out = await compile('txt', { pictures: 'copy' });
    expect(out.text(`exports/${STEM}.txt`)).toContain('[Picture: The lantern]');
    expect(out.notes).toContain("txt: the pictures option 'copy' is a Markdown one, so a [Picture: …] line is written for each picture");
  });

  it('logs a picture whose file is not in assets/, and still writes its placeholder', async () => {
    const out = await compile('txt', {}, { files: {} });
    expect(out.text(`exports/${STEM}.txt`)).toContain('[Picture: The lantern]');
    expect(out.notes).toContain(`${pngFile(ID_A)} is placed in the manuscript but its file is not in assets/, so the caption is exported instead`);
  });
});

describe('EPUB figures', () => {
  const chapterXhtml = (files: Record<string, Uint8Array>): string =>
    Object.entries(files)
      .filter(([name]) => name.endsWith('.xhtml'))
      .map(([, data]) => strFromU8(data))
      .join('\n');

  it('packs the picture as an image part with a manifest item, and writes a figure with its alt text and caption', async () => {
    const out = await compile('epub', {});
    const files = unzipSync(out.bytes(out.outputs[0] ?? ''));
    expect(Object.keys(files)).toEqual(expect.arrayContaining([`OEBPS/images/${pngFile(ID_A)}`, `OEBPS/images/${jpgFile(ID_B)}`]));
    const opf = strFromU8(files['OEBPS/content.opf'] ?? new Uint8Array());
    expect(opf).toMatch(new RegExp(`<item [^>]*href="images/${pngFile(ID_A)}"[^>]*media-type="image/png"`));
    expect(opf).toMatch(new RegExp(`<item [^>]*href="images/${jpgFile(ID_B)}"[^>]*media-type="image/jpeg"`));
    const xhtml = chapterXhtml(files);
    expect(xhtml).toContain(`<figure><img src="../images/${pngFile(ID_A)}" alt="A lantern on the pier"/><figcaption>The lantern</figcaption></figure>`);
    expect(xhtml).toContain(`<figure><img src="../images/${jpgFile(ID_B)}" alt="The ferry"/><figcaption>The ferry</figcaption></figure>`);
    expect(out.notes.find((note) => note.startsWith('pictures: 2 pictures weigh '))).toBeDefined();
  });

  it('strips a JPEG\'s private metadata by default and keeps it when the recipe says so', async () => {
    const stripped = await compile('epub', {});
    const strippedFiles = unzipSync(stripped.bytes(stripped.outputs[0] ?? ''));
    expect(hasMarker(strippedFiles[`OEBPS/images/${jpgFile(ID_B)}`] ?? new Uint8Array())).toBe(false);
    const kept = await compile('epub', { keepPictureMetadata: true });
    const keptFiles = unzipSync(kept.bytes(kept.outputs[0] ?? ''));
    expect(hasMarker(keptFiles[`OEBPS/images/${jpgFile(ID_B)}`] ?? new Uint8Array())).toBe(true);
  });

  it('converts a WebP to JPEG unless the recipe keeps WebP for Apple Books', async () => {
    const body = `![A WebP](${urlOf(`${ID_W}.webp`)} "Kept or not")`;
    const converted = await compile('epub', {}, { body });
    const convertedFiles = unzipSync(converted.bytes(converted.outputs[0] ?? ''));
    expect(Object.keys(convertedFiles)).toContain(`OEBPS/images/${jpgFile(ID_W)}`);
    expect(Object.keys(convertedFiles).some((name) => name.endsWith('.webp'))).toBe(false);

    const kept = await compile('epub', { epubKeepWebp: true }, { body });
    const keptFiles = unzipSync(kept.bytes(kept.outputs[0] ?? ''));
    expect(Object.keys(keptFiles)).toContain(`OEBPS/images/${ID_W}.webp`);
    expect(strFromU8(keptFiles['OEBPS/content.opf'] ?? new Uint8Array())).toContain('media-type="image/webp"');
  });

  it('exports the caption in place of a picture the host cannot convert, and still makes the book', async () => {
    const out = await compile('epub', {}, { process: null });
    const files = unzipSync(out.bytes(out.outputs[0] ?? ''));
    expect(Object.keys(files).some((name) => name === `OEBPS/images/${pngFile(ID_A)}`)).toBe(false);
    expect(chapterXhtml(files)).not.toContain(`../images/${pngFile(ID_A)}`);
    expect(out.notes.some((note) => note.includes(`This host cannot convert pictures, and ${pngFile(ID_A)} needs converting for this format.`))).toBe(true);
  });

  it('does not read the pictures option, so one recipe compiles under any format', async () => {
    const out = await compile('epub', { pictures: 'drop' });
    const files = unzipSync(out.bytes(out.outputs[0] ?? ''));
    expect(Object.keys(files)).toContain(`OEBPS/images/${pngFile(ID_A)}`);
  });
});

describe('DOCX figures', () => {
  const read = async (out: Compiled): Promise<Record<string, Uint8Array>> => unzipSync(out.bytes(out.outputs[0] ?? ''));
  const mediaOf = (files: Record<string, Uint8Array>): string[] => Object.keys(files).filter((name) => name.startsWith('word/media/') && !name.endsWith('/'));

  it('embeds the picture as an ImageRun with its alt text as the description, and its caption in the Caption style', async () => {
    const files = await read(await compile('docx', {}));
    expect(mediaOf(files)).toHaveLength(2);
    const document = strFromU8(files['word/document.xml'] ?? new Uint8Array());
    expect(document).toContain('descr="A lantern on the pier"');
    expect(document).toContain('descr="The ferry"');
    expect(document).toMatch(/<w:pStyle w:val="Caption"\/>[\s\S]*?<w:t[^>]*>The lantern<\/w:t>/);
    expect(document).toContain('<w:drawing>');
    const types = strFromU8(files['[Content_Types].xml'] ?? new Uint8Array());
    expect(types).toMatch(/Extension="png"/);
    expect(types).toMatch(/Extension="jpg"/);
  });

  it('strips the private metadata from the media by default and keeps it when the recipe says so', async () => {
    const stripped = await read(await compile('docx', {}));
    expect(mediaOf(stripped).some((name) => hasMarker(stripped[name] ?? new Uint8Array()))).toBe(false);
    const kept = await read(await compile('docx', { keepPictureMetadata: true }));
    const carriers = mediaOf(kept).filter((name) => hasMarker(kept[name] ?? new Uint8Array()));
    expect(carriers).toHaveLength(2);
  });

  it('embeds a PNG and a JPEG on a host with no ProcessPicture, because Word needs no conversion for them', async () => {
    const files = await read(await compile('docx', {}, { process: null }));
    expect(mediaOf(files)).toHaveLength(2);
  });

  it('sizes the picture by its extent, never wider than the text', async () => {
    const files = await read(await compile('docx', {}, { body: `![Wide](${urlOf(pngFile(ID_C))})`, files: { [`assets/${pngFile(ID_C)}`]: solidPng(4000, 400) } }));
    const extents = [...strFromU8(files['word/document.xml'] ?? new Uint8Array()).matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)].map((match) => [Number(match[1]), Number(match[2])]);
    expect(extents).toHaveLength(1);
    const [cx = 0, cy = 0] = extents[0] ?? [];
    expect(cx).toBeLessThanOrEqual(Math.round((9026 / 1440) * 96) * 9525);
    expect(cx / cy).toBeCloseTo(10, 0);
  });
});

describe('recipe options reach the compile', () => {
  it('keeps pictures, epubKeepWebp and keepPictureMetadata on the saved recipe', async () => {
    const out = await compile('md', { pictures: 'link', keepPictureMetadata: true, epubKeepWebp: true, epubImageMaxPx: 800 });
    const recipe = recipesOf(out.state).find((candidate) => candidate.name === RECIPE);
    expect(recipe?.options).toEqual({ pictures: 'link', keepPictureMetadata: true, epubKeepWebp: true, epubImageMaxPx: 800 });
  });

  it('refuses a picture option of the wrong kind before anything is saved', async () => {
    for (const options of [{ pictures: 'sometimes' }, { epubKeepWebp: 'yes' }, { keepPictureMetadata: 1 }, { epubImageMaxPx: 10 }, { epubImageMaxPx: 1600.5 }]) {
      await expect(compile('md', options), JSON.stringify(options)).rejects.toThrow(/recipe\.save refused: params\.options\./);
    }
  });

  it('carries the recipe\'s long edge into the EPUB: the lantern is scaled to it', async () => {
    const out = await compile('epub', { epubImageMaxPx: 64 }, { body: `![Big](${urlOf(pngFile(ID_A))})`, files: { [`assets/${pngFile(ID_A)}`]: solidPng(200, 100) } });
    const files = unzipSync(out.bytes(out.outputs[0] ?? ''));
    const png = files[`OEBPS/images/${pngFile(ID_A)}`] ?? new Uint8Array();
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([64, 32]);
  });
});
