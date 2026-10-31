/**
 * The comic PDF through the compile (`comic-pdf`, comics.md §5): a selection of the manifest's comic folders and pages becomes one
 * book, the gate refuses what has no page or more than one comic, and the registered format writes a PDF the exporter names.
 * The page drawing itself is tested in render-comic-pdf.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { loadComicLetteringFontInNode } from '@caotang/pdf-fonts/node-loader';
import { MemoryArtifactFs, type ProjectState, type TreeNode } from '@caotang/store';
import { EXPORT_FORMATS, EXPORT_MIME, MediaRefusedError, createExporter, isBinaryFormat, isExportFormat, isMediaFormat, renderMedia, selectComic } from '../src/index.js';
import { splitRendered } from '../src/emit.js';
import { COMPILED_AT } from './fixture.js';
import { ASSET_FILE, ASSET_ID, ASSETS, PROJECT_NAME, makeMediaProject } from './media-fixture.js';
import { PNG_1X1 } from './epub-fixtures.js';

vi.setConfig({ testTimeout: 30_000 });

const NOW = new Date('2026-10-02T15:00:00.000Z').getTime();

let order = 1000;
function addNode(state: ProjectState, node: Partial<TreeNode> & Record<string, unknown> & Pick<TreeNode, 'id' | 'parentId' | 'type' | 'title'>): void {
  order += 10;
  state.manifest.tree.push({ order, status: null, label: null, keywords: [], synopsis: '', notes: '', ...node } as TreeNode);
}

const PAGE_ONE = {
  size: 'us-comic',
  layout: 'splash',
  panels: [
    {
      id: 'pn_0000000001',
      rect: [0, 0, 1, 1],
      assetId: ASSET_ID,
      balloons: [{ id: 'bl_0000000001', kind: 'speech', text: 'Where were you?', rect: [0.1, 0.1, 0.5, 0.2] }],
    },
  ],
};
const PAGE_TWO = { size: 'us-comic', panels: [{ id: 'pn_0000000002', rect: [0, 0, 1, 0.5], balloons: [] }] };

function comicProject(): ProjectState {
  const state = makeMediaProject();
  addNode(state, { id: 'n_COMICBOOK01', parentId: 'manuscript', type: 'folder', title: 'Night Ferry', kind: 'comic', comic: { readingDirection: 'ltr', capsTransform: true } });
  addNode(state, { id: 'n_COMICPAGE01', parentId: 'n_COMICBOOK01', type: 'comic-page', title: 'Page one', comicPage: PAGE_ONE });
  addNode(state, { id: 'n_COMICPAGE02', parentId: 'n_COMICBOOK01', type: 'comic-page', title: 'Page two', comicPage: PAGE_TWO });
  return state;
}

function request(state: ProjectState, extra: Partial<Parameters<typeof renderMedia>[0]> = {}, includeRootIds: readonly string[] = ['manuscript']): Parameters<typeof renderMedia>[0] {
  return {
    state,
    format: 'comic-pdf',
    includeRootIds,
    title: PROJECT_NAME,
    author: 'Ada Lovelace',
    date: '2026-10-02',
    titlePage: false,
    base: 'Night Ferry',
    assets: ASSETS,
    readAsset: async (path) => (path === `assets/${ASSET_FILE}` ? PNG_1X1 : null),
    loadComicFont: loadComicLetteringFontInNode,
    at: NOW,
    ...extra,
  };
}

async function render(output: ReturnType<typeof renderMedia>): Promise<{ name: string; pdf: PDFDocument; bytes: Uint8Array }> {
  const file = output.files[0];
  if (file === undefined || file.bytes === undefined) throw new Error('expected one binary file');
  const { contents } = splitRendered(await file.bytes());
  const bytes = typeof contents === 'string' ? new TextEncoder().encode(contents) : contents;
  return { name: file.name, pdf: await PDFDocument.load(bytes), bytes };
}

describe('the comic PDF format', () => {
  it('is in the format lists as a binary media format with a PDF type', () => {
    expect(isExportFormat('comic-pdf')).toBe(true);
    expect(EXPORT_FORMATS.indexOf('comic-pdf')).toBeGreaterThan(EXPORT_FORMATS.indexOf('contact-sheet-pdf'));
    expect(isMediaFormat('comic-pdf')).toBe(true);
    expect(isBinaryFormat('comic-pdf')).toBe(true);
    expect(EXPORT_MIME['comic-pdf']).toBe('application/pdf');
  });
});

describe('the comic PDF compile', () => {
  it('reads the comic folder and its pages in binder order into one PDF page each, named for the book', async () => {
    const output = renderMedia(request(comicProject()));
    expect(output.blockCount).toBe(2);
    const { name, pdf } = await render(output);
    expect(name).toBe('Night Ferry (comic).pdf');
    expect(pdf.getPageCount()).toBe(2);
    expect(pdf.getTitle()).toBe('Night Ferry');
  });

  it('draws the pictures from the project store through the asset records', async () => {
    const { pdf } = await render(renderMedia(request(comicProject())));
    const images = pdf.context.enumerateIndirectObjects().filter(([, object]) => String((object as { dict?: PDFDict }).dict?.get(PDFName.of('Subtype'))) === '/Image');
    expect(images.length).toBeGreaterThanOrEqual(1);
  });

  it('takes a single page of a comic when only that page is selected', async () => {
    const { pdf } = await render(renderMedia(request(comicProject(), {}, ['n_COMICPAGE02'])));
    expect(pdf.getPageCount()).toBe(1);
  });

  it('lets the compile override the book direction, and draws paper frames without a picture', async () => {
    const state = comicProject();
    const rtl = await render(renderMedia(request(state, { readingDirection: 'rtl', paperFrames: true })));
    expect(rtl.name).toBe('Night Ferry (comic paper frames).pdf');
    const prefs = rtl.pdf.catalog.lookup(PDFName.of('ViewerPreferences'), PDFDict);
    expect(prefs.get(PDFName.of('Direction'))).toBe(PDFName.of('R2L'));
    const plain = await render(renderMedia(request(state)));
    expect(plain.pdf.catalog.get(PDFName.of('ViewerPreferences'))).toBeUndefined();
  });

  it('turns the bleed off and the crop marks on', async () => {
    const state = comicProject();
    const [bleed, marked, bare] = await Promise.all([
      render(renderMedia(request(state))),
      render(renderMedia(request(state, { cropMarks: true }))),
      render(renderMedia(request(state, { bleed: false }))),
    ]);
    const width = (doc: PDFDocument): number => doc.getPage(0).getMediaBox().width;
    expect(width(marked.pdf)).toBeGreaterThan(width(bleed.pdf));
    expect(width(bare.pdf)).toBeLessThan(width(bleed.pdf));
  });

  it('names a stored value the model cannot read, and still draws the page', () => {
    const state = comicProject();
    const node = state.manifest.tree.find((entry) => entry.id === 'n_COMICPAGE02') as unknown as Record<string, unknown>;
    node['comicPage'] = { size: 'us-comic', panels: 'not a list' };
    const output = renderMedia(request(state));
    expect(output.notes.join('\n')).toContain('page 2 ("Page two") has 1 value the model could not read');
  });

  it('refuses a selection with no comic page, saying what to select', () => {
    expect(selectComic(makeMediaProject(), ['manuscript'], PROJECT_NAME).ok).toBe(false);
    expect(() => renderMedia(request(makeMediaProject()))).toThrow(MediaRefusedError);
    expect(() => renderMedia(request(makeMediaProject()))).toThrow('the selection holds no comic page, so there is no comic to draw. Select a comic or some of its pages');
    expect(() => renderMedia(request(makeMediaProject()))).toThrow('as the comic PDF is refused');
  });

  it('refuses pages of two comics in one file, naming both', () => {
    const state = comicProject();
    addNode(state, { id: 'n_COMICBOOK02', parentId: 'manuscript', type: 'folder', title: 'Day Ferry', kind: 'comic', comic: {} });
    addNode(state, { id: 'n_COMICPAGE03', parentId: 'n_COMICBOOK02', type: 'comic-page', title: 'Page one', comicPage: PAGE_TWO });
    expect(() => renderMedia(request(state))).toThrow('"Night Ferry", "Day Ferry"');
  });

  it('writes the file through the exporter, in the exports folder, with the PDF type', async () => {
    const state = comicProject();
    const exporter = createExporter({
      readState: () => state,
      artifacts: new MemoryArtifactFs(),
      clock: { now: () => COMPILED_AT },
      metadata: () => ({ author: 'Ada Lovelace' }),
      assets: () => ASSETS,
      readAsset: async (path) => (path === `assets/${ASSET_FILE}` ? PNG_1X1 : null),
      loadComicFont: loadComicLetteringFontInNode,
    });
    const result = await exporter.compile({ includeRootIds: ['n_COMICBOOK01'] }, 'comic-pdf');
    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    expect(file?.fileName).toBe('Night Ferry (comic).pdf');
    expect(file?.blob.type).toContain('application/pdf');
    const pdf = await PDFDocument.load(new Uint8Array(await (file as NonNullable<typeof file>).blob.arrayBuffer()));
    expect(pdf.getPageCount()).toBe(2);
  });
});
