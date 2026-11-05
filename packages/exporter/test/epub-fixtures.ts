/**
 * The EPUB test fixtures, shared by the structural metadata test and the epubcheck gate. Not a test file: it holds the
 * inputs and the packing helper, so importing it registers no suites.
 */

import { addDocument, type ProjectState } from '@caotang/store';
import { strFromU8, unzipSync } from 'fflate/browser';
import { figureSourcesOf, resolveFigures } from '../src/figures.js';
import { flatten } from '../src/flatten.js';
import { epubSpec } from '../src/picture-profile.js';
import { processPictureInNode } from '../src/picture-process-node.js';
import { renderEpub, type EpubCover, type EpubInput } from '../src/render-epub.js';
import type { RenderInput } from '../src/render-input.js';
import { DEFAULT_TEMPLATE } from '../src/template.js';
import type { FlatBlock } from '../src/types.js';
import { IDS, makeProject, OPENED, PROJECT_NAME } from './fixture.js';

/** A `urn:uuid:` identifier, as the store mints one. */
export const EPUB_IDENTIFIER = 'urn:uuid:3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d';

const MTIME = new Date('2026-10-08T09:30:00.000Z');

/** A 1×1 PNG: a real image, small enough to live in a test. */
export const PNG_1X1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

/** A cover built from {@link PNG_1X1}. */
export const COVER_PNG: EpubCover = { extension: 'png', mime: 'image/png', bytes: PNG_1X1 };

/**
 * The first bytes of a PNG of the given size: the signature and the IHDR chunk, where the size is. The cover note reads the size
 * from the header and the EPUB copies the bytes, so nothing past the header is needed to test either.
 */
export function pngHeaderOf(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** The EPUB input the exporter builds, from a project fixture, with the test's overrides on top. */
export function epubInput(overrides: Partial<EpubInput> = {}, state: ProjectState = makeProject()): EpubInput {
  const flat: readonly FlatBlock[] = flatten(state, { includeRootIds: ['manuscript'] }, { titlePage: true }).blocks;
  const base: RenderInput = {
    blocks: flat,
    title: PROJECT_NAME,
    author: 'M. Ortega',
    date: '2026-10-08',
    template: DEFAULT_TEMPLATE,
    toc: true,
  };
  return {
    ...base,
    language: 'en',
    identifier: EPUB_IDENTIFIER,
    modified: '2026-10-08T09:30:00Z',
    mtime: MTIME,
    ...overrides,
  };
}

/** Renders a pack and reads every entry back: its bytes by name, and the text of each as a string. */
export async function pack(input: EpubInput): Promise<{ files: Record<string, Uint8Array>; text: Record<string, string> }> {
  const files = unzipSync(await renderEpub(input));
  const text: Record<string, string> = {};
  for (const [name, data] of Object.entries(files)) text[name] = strFromU8(data);
  return { files, text };
}

/** A scene body that places one picture from `assets/`, the way the editor writes an inline picture (pictures.md §3). */
export function figureBody(file: string, alt: string, caption: string): string {
  return `The pier at dusk.\n\n![${alt}](../assets/${file} "${caption}")\n\nThe ferry came in.`;
}

/** The shared fixture with one more pictured scene in Chapter One. */
export function figureProject(body: string): ProjectState {
  const state = makeProject();
  addDocument(state, { parentId: IDS.chapterOne, title: 'The Pier', body, now: OPENED, id: 'n_PIERC00001' });
  return state;
}

/**
 * The input with its figures resolved the way a compile resolves them: the EPUB picture profile against the files an `assets/`
 * folder holds, through Node's own codecs. `keepWebp` is the recipe's "Apple Books only" opt-in.
 */
export async function withFigures(
  input: EpubInput,
  files: Readonly<Record<string, Uint8Array>>,
  options: { readonly keepWebp?: boolean } = {},
): Promise<EpubInput> {
  const figures = await resolveFigures(
    figureSourcesOf(input.blocks),
    { readAsset: async (path) => files[path] ?? null, process: processPictureInNode, records: new Map() },
    { ...epubSpec(options), embed: true },
  );
  return { ...input, figures };
}
