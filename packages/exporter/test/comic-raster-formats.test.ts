/**
 * The comic's two raster formats, the CBZ and the fixed-layout comic EPUB (comics.md §5, D12), through the compile. No canvas exists in
 * these tests, so a recording rasterizer stands in for the app's: what is pinned here is everything that is not pixels — the host gate and its
 * sentence, the refusals, the order and bound of the page loop, the cancel, the file names, the archive's entries and the EPUB's structure.
 * The canvas drawing is apps/desktop/test/comic-raster.test.tsx's.
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
import { MemoryArtifactFs, createProjectCommandRegistry, type ProjectState, type TreeNode } from '@caotang/store';
import { strFromU8, unzipSync } from 'fflate/browser';

import {
  CBZ_MIME,
  COMIC_RASTER_HEIGHT_PX,
  ComicRasterCancelledError,
  ComicRasterUnavailableError,
  EXPORT_FORMATS,
  EXPORT_MIME,
  NoPersistentIdentifierError,
  createExporter,
  type ByteArtifacts,
  type ExporterService,
  isBinaryFormat,
  isExportFormat,
  isMediaFormat,
  rasterizeComicBook,
  renderMedia,
  type ComicRasterPageRequest,
  type ComicRasterizer,
} from '../src/index.js';
import { splitRendered } from '../src/emit.js';
import { cbzComicInfo, cbzPageName, renderCbz } from '../src/render-cbz.js';
import { panelRegionsOf, renderComicEpub } from '../src/render-comic-epub.js';
import { COMPILED_AT } from './fixture.js';
import { JPEG, LTR_BOOK, RTL_BOOK, mangaPage, sixPanelPage } from './comic-pdf-fixture.js';
import { PROJECT_NAME, makeMediaProject } from './media-fixture.js';

const NOW = new Date('2026-10-02T15:00:00.000Z').getTime();
const IDENTIFIER = '3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d';
const SENTENCE = 'Comic EPUB and CBZ are made in the app. Open the project in Caotang and export there.';

let order = 1000;
function addNode(state: ProjectState, node: Partial<TreeNode> & Record<string, unknown> & Pick<TreeNode, 'id' | 'parentId' | 'type' | 'title'>): void {
  order += 10;
  state.manifest.tree.push({ order, status: null, label: null, keywords: [], synopsis: '', notes: '', ...node } as TreeNode);
}

const PAGE_ONE = {
  size: 'us-comic',
  layout: 'splash',
  panels: [{ id: 'pn_0000000001', rect: [0, 0, 1, 1], balloons: [{ id: 'bl_0000000001', kind: 'speech', text: 'Where **were** you?', rect: [0.1, 0.1, 0.5, 0.2] }] }],
};
const PAGE_TWO = { size: 'us-comic', panels: [{ id: 'pn_0000000002', rect: [0, 0, 1, 0.5], balloons: [] }] };

function comicProject(direction: 'ltr' | 'rtl' = 'ltr'): ProjectState {
  const state = makeMediaProject();
  addNode(state, { id: 'n_COMICBOOK01', parentId: 'manuscript', type: 'folder', title: 'Night Ferry', kind: 'comic', comic: { readingDirection: direction, capsTransform: true } });
  addNode(state, { id: 'n_COMICPAGE01', parentId: 'n_COMICBOOK01', type: 'comic-page', title: 'Page one', comicPage: PAGE_ONE });
  addNode(state, { id: 'n_COMICPAGE02', parentId: 'n_COMICBOOK01', type: 'comic-page', title: 'Page two', comicPage: PAGE_TWO });
  return state;
}

/** A rasterizer that draws nothing: it records what it was asked, and answers each page with the one JPEG the tests carry. */
function recordingRasterizer(): ComicRasterizer & { readonly events: string[]; readonly requests: ComicRasterPageRequest[]; maxInFlight: number } {
  const events: string[] = [];
  const requests: ComicRasterPageRequest[] = [];
  let inFlight = 0;
  const rasterizer = {
    events,
    requests,
    maxInFlight: 0,
    ready: async () => {
      events.push('ready');
    },
    drawPage: async (request: ComicRasterPageRequest) => {
      inFlight += 1;
      rasterizer.maxInFlight = Math.max(rasterizer.maxInFlight, inFlight);
      events.push(`page ${request.number}`);
      requests.push(request);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { number: request.number, width: 1288, height: request.heightPx, bytes: JPEG, notes: [] };
    },
  };
  return rasterizer;
}

function mediaRequest(extra: Partial<Parameters<typeof renderMedia>[0]> = {}): Parameters<typeof renderMedia>[0] {
  return {
    state: comicProject(),
    format: 'cbz',
    includeRootIds: ['manuscript'],
    title: PROJECT_NAME,
    author: 'Ada Lovelace',
    date: '2026-10-02',
    titlePage: false,
    base: 'Night Ferry',
    assets: new Map(),
    identifier: IDENTIFIER,
    language: 'en',
    at: NOW,
    ...extra,
  };
}

async function filesOf(output: ReturnType<typeof renderMedia>): Promise<Record<string, Uint8Array>> {
  const file = output.files[0];
  if (file === undefined || file.bytes === undefined) throw new Error('expected one binary file');
  const { contents } = splitRendered(await file.bytes());
  if (typeof contents === 'string') throw new Error('expected bytes');
  return unzipSync(contents);
}

describe('the raster formats in the registry', () => {
  it('are binary media formats, after the comic PDF, with their types', () => {
    for (const format of ['cbz', 'comic-epub'] as const) {
      expect(isExportFormat(format)).toBe(true);
      expect(isMediaFormat(format)).toBe(true);
      expect(isBinaryFormat(format)).toBe(true);
      expect(EXPORT_FORMATS.indexOf(format)).toBeGreaterThan(EXPORT_FORMATS.indexOf('comic-pdf'));
    }
    expect(EXPORT_MIME['cbz']).toBe(CBZ_MIME);
    expect(CBZ_MIME).toBe('application/vnd.comicbook+zip');
    expect(EXPORT_MIME['comic-epub']).toBe('application/epub+zip');
  });

  it('rasterise at 1988 px tall', () => {
    expect(COMIC_RASTER_HEIGHT_PX).toBe(1988);
  });
});

describe('a host with no canvas', () => {
  it.each(['cbz', 'comic-epub'] as const)('refuses %s with the spec sentence before anything is read', (format) => {
    expect(() => renderMedia(mediaRequest({ format }))).toThrow(ComicRasterUnavailableError);
    expect(() => renderMedia(mediaRequest({ format }))).toThrow(SENTENCE);
    // Even a selection that would be refused on its own reasons says the host sentence first.
    expect(() => renderMedia(mediaRequest({ format, state: makeMediaProject() }))).toThrow(SENTENCE);
  });

  it('writes nothing and records no file when the exporter is asked, and the comic PDF gate is unchanged', async () => {
    const written = new Map<string, Uint8Array>();
    const exporter = createExporter({
      readState: () => comicProject(),
      artifacts: new MemoryArtifactFs(),
      bytes: { writeBytes: async (path, data) => void written.set(path, data), removeBytes: async (path) => void written.delete(path) },
      clock: { now: () => COMPILED_AT },
      metadata: () => ({ author: 'Ada Lovelace', identifier: IDENTIFIER, language: 'en' }),
    });
    for (const format of ['cbz', 'comic-epub'] as const) {
      await expect(exporter.compile({ includeRootIds: ['n_COMICBOOK01'] }, format)).rejects.toThrow(SENTENCE);
    }
    expect(written.size).toBe(0);
  });
});

describe('the page loop', () => {
  const pages = LTR_BOOK.pages;
  const base = (rasterizer: ComicRasterizer, extra: Partial<Parameters<typeof rasterizeComicBook>[0]> = {}): Parameters<typeof rasterizeComicBook>[0] => ({
    rasterizer,
    settings: LTR_BOOK.settings,
    pages,
    language: 'en',
    readPicture: async () => null,
    ...extra,
  });

  it('readies the fonts once, before the first page, then draws the pages one at a time in order', async () => {
    const rasterizer = recordingRasterizer();
    const done: number[] = [];
    const drawn = await rasterizeComicBook(base(rasterizer, { onPage: (count) => void done.push(count) }));
    expect(rasterizer.events).toEqual(['ready', ...pages.map((_, index) => `page ${index + 1}`)]);
    expect(rasterizer.maxInFlight).toBe(1);
    expect(drawn.pages.map((page) => page.number)).toEqual(pages.map((_, index) => index + 1));
    expect(done).toEqual(pages.map((_, index) => index + 1));
    expect(rasterizer.requests.every((request) => request.heightPx === 1988 && request.count === pages.length)).toBe(true);
  });

  it('asks for no further page once cancelled, and returns nothing', async () => {
    const controller = new AbortController();
    const rasterizer = recordingRasterizer();
    const inner = rasterizer.drawPage;
    rasterizer.drawPage = async (request) => {
      const page = await inner(request);
      if (request.number === 1) controller.abort();
      return page;
    };
    await expect(rasterizeComicBook(base(rasterizer, { signal: controller.signal }))).rejects.toThrow(ComicRasterCancelledError);
    expect(rasterizer.events).toEqual(['ready', 'page 1']);
  });

  it('draws nothing when it is cancelled before it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const rasterizer = recordingRasterizer();
    await expect(rasterizeComicBook(base(rasterizer, { signal: controller.signal }))).rejects.toThrow(ComicRasterCancelledError);
    expect(rasterizer.events).toEqual([]);
  });

  it('refuses a page that came back with no image rather than packing a gap', async () => {
    const rasterizer = recordingRasterizer();
    rasterizer.drawPage = async (request) => ({ number: request.number, width: 10, height: 10, bytes: new Uint8Array(), notes: [] });
    await expect(rasterizeComicBook(base(rasterizer))).rejects.toThrow('page 1 was drawn without an image');
  });

  it('carries each page note out, in page order', async () => {
    const rasterizer = recordingRasterizer();
    rasterizer.drawPage = async (request) => ({ number: request.number, width: 10, height: 10, bytes: JPEG, notes: [`note ${request.number}`] });
    const drawn = await rasterizeComicBook(base(rasterizer));
    expect(drawn.notes).toEqual(pages.map((_, index) => `note ${index + 1}`));
  });
});

describe('the CBZ', () => {
  it('holds one JPEG per page in page order, then ComicInfo.xml, named for the book', async () => {
    const rasterizer = recordingRasterizer();
    const output = renderMedia(mediaRequest({ rasterizeComic: rasterizer }));
    expect(output.files[0]?.name).toBe('Night Ferry (comic).cbz');
    expect(output.files[0]?.mimeType).toBe(CBZ_MIME);
    expect(output.blockCount).toBe(2);
    const files = await filesOf(output);
    expect(Object.keys(files)).toEqual(['0001.jpg', '0002.jpg', 'ComicInfo.xml']);
    expect(files['0001.jpg']).toEqual(JPEG);
    expect(rasterizer.events).toEqual(['ready', 'page 1', 'page 2']);
  });

  it('rasterises the book in the project language, with the book settings the comic folder carries', async () => {
    const rasterizer = recordingRasterizer();
    await filesOf(renderMedia(mediaRequest({ rasterizeComic: rasterizer, language: 'de', state: comicProject('rtl') })));
    expect(rasterizer.requests[0]?.language).toBe('de');
    expect(rasterizer.requests[0]?.settings.readingDirection).toBe('rtl');
  });

  it('writes ComicInfo.xml with the title, the writer, the language and the cover, and marks a right-to-left book as manga', async () => {
    const ltr = strFromU8((await filesOf(renderMedia(mediaRequest({ rasterizeComic: recordingRasterizer() }))))['ComicInfo.xml'] as Uint8Array);
    expect(ltr).toContain('<Title>Night Ferry</Title>');
    expect(ltr).toContain('<Series>The Lighthouse Keeper</Series>');
    expect(ltr).toContain('<Writer>Ada Lovelace</Writer>');
    expect(ltr).toContain('<LanguageISO>en</LanguageISO>');
    expect(ltr).toContain('Type="FrontCover"');
    expect(ltr).toContain('Type="Story"');
    expect(ltr).toContain('<PageCount>2</PageCount>');
    expect(ltr).not.toContain('YesAndRightToLeft');
    const rtl = strFromU8((await filesOf(renderMedia(mediaRequest({ rasterizeComic: recordingRasterizer(), state: comicProject('rtl') }))))['ComicInfo.xml'] as Uint8Array);
    expect(rtl).toContain('<Manga>YesAndRightToLeft</Manga>');
  });

  it('overrides the book direction from the compile, as the comic PDF does', async () => {
    const rasterizer = recordingRasterizer();
    await filesOf(renderMedia(mediaRequest({ rasterizeComic: rasterizer, readingDirection: 'rtl' })));
    expect(rasterizer.requests[0]?.settings.readingDirection).toBe('rtl');
  });

  it('escapes every field of ComicInfo.xml', () => {
    const xml = cbzComicInfo({
      title: 'Cats & <Dogs> "quoted"',
      series: 'Pets & Co',
      author: "O'Neil <ed>",
      language: 'en',
      readingDirection: 'ltr',
      pages: [{ number: 1, width: 10, height: 20, bytes: JPEG, notes: [] }],
      mtime: new Date(NOW),
    });
    expect(xml).toContain('Cats &amp; &lt;Dogs&gt;');
    expect(xml).toContain('Pets &amp; Co');
    expect(xml).toContain('&lt;ed&gt;');
    expect(xml).not.toContain('<Dogs>');
  });

  it('leaves the series out when the book is the project', () => {
    const xml = cbzComicInfo({ title: 'Night Ferry', series: 'Night Ferry', readingDirection: 'ltr', pages: [{ number: 1, width: 1, height: 1, bytes: JPEG, notes: [] }], mtime: new Date(NOW) });
    expect(xml).not.toContain('<Series>');
  });

  it('names pages to four digits, and to as many as a longer book needs', () => {
    expect(cbzPageName(1, 12)).toBe('0001.jpg');
    expect(cbzPageName(12, 12)).toBe('0012.jpg');
    expect(cbzPageName(7, 10_000)).toBe('00007.jpg');
  });

  it('stores the pictures and refuses an empty book', async () => {
    const page = { number: 1, width: 8, height: 8, bytes: JPEG, notes: [] };
    const bytes = await renderCbz({ title: 'T', readingDirection: 'ltr', pages: [page], mtime: new Date(NOW) });
    // A stored entry has the same compressed and uncompressed size: method 0 in the local header, at byte 8.
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint16(8, true)).toBe(0);
    await expect(renderCbz({ title: 'T', readingDirection: 'ltr', pages: [], mtime: new Date(NOW) })).rejects.toThrow('no page');
  });

  it('is the same bytes on every compile of the same book at the same time', async () => {
    const one = await filesOf(renderMedia(mediaRequest({ rasterizeComic: recordingRasterizer() })));
    const two = await filesOf(renderMedia(mediaRequest({ rasterizeComic: recordingRasterizer() })));
    expect(strFromU8(one['ComicInfo.xml'] as Uint8Array)).toBe(strFromU8(two['ComicInfo.xml'] as Uint8Array));
  });

  it('is refused for a selection with no comic page, saying so for the CBZ', () => {
    expect(() => renderMedia(mediaRequest({ rasterizeComic: recordingRasterizer(), state: makeMediaProject() }))).toThrow('the selection holds no comic page');
    expect(() => renderMedia(mediaRequest({ rasterizeComic: recordingRasterizer(), state: makeMediaProject() }))).toThrow('comic CBZ');
  });

  it('is offered by the exporter as a file with the archive type', async () => {
    const exporter = createExporter({
      readState: () => comicProject(),
      artifacts: new MemoryArtifactFs(),
      clock: { now: () => COMPILED_AT },
      metadata: () => ({ author: 'Ada Lovelace', language: 'en' }),
      rasterizeComic: recordingRasterizer(),
    });
    const result = await exporter.compile({ includeRootIds: ['n_COMICBOOK01'] }, 'cbz');
    expect(result.files[0]?.fileName).toBe('Night Ferry (comic).cbz');
    expect(result.files[0]?.blob.type).toContain('application/vnd.comicbook+zip');
    const entries = Object.keys(unzipSync(new Uint8Array(await (result.files[0] as NonNullable<(typeof result.files)[0]>).blob.arrayBuffer())));
    expect(entries).toEqual(['0001.jpg', '0002.jpg', 'ComicInfo.xml']);
  });

  it('is cancelled through the signal the host gives, and then there is no file', async () => {
    const controller = new AbortController();
    const rasterizer = recordingRasterizer();
    const inner = rasterizer.drawPage;
    rasterizer.drawPage = async (request) => {
      const page = await inner(request);
      controller.abort();
      return page;
    };
    const written = new Map<string, Uint8Array>();
    const exporter = createExporter({
      readState: () => comicProject(),
      artifacts: new MemoryArtifactFs(),
      bytes: { writeBytes: async (path, data) => void written.set(path, data), removeBytes: async (path) => void written.delete(path) },
      clock: { now: () => COMPILED_AT },
      metadata: () => ({ author: 'Ada Lovelace', language: 'en' }),
      rasterizeComic: rasterizer,
      comicRasterSignal: () => controller.signal,
    });
    await expect(exporter.compile({ includeRootIds: ['n_COMICBOOK01'] }, 'cbz')).rejects.toThrow();
    expect(written.size).toBe(0);
    expect(rasterizer.events).toEqual(['ready', 'page 1']);
  });
});

describe('the fixed-layout comic EPUB', () => {
  const epubFiles = async (extra: Partial<Parameters<typeof renderMedia>[0]> = {}): Promise<Record<string, string>> => {
    const raw = await filesOf(renderMedia(mediaRequest({ format: 'comic-epub', rasterizeComic: recordingRasterizer(), ...extra })));
    return Object.fromEntries(Object.entries(raw).map(([name, bytes]) => [name, name.endsWith('.jpg') ? `<${bytes.length} bytes>` : strFromU8(bytes)]));
  };

  it('is named for the book and holds mimetype first, with one image and one document per page', async () => {
    const output = renderMedia(mediaRequest({ format: 'comic-epub', rasterizeComic: recordingRasterizer() }));
    expect(output.files[0]?.name).toBe('Night Ferry (comic).epub');
    expect(output.files[0]?.mimeType).toBe('application/epub+zip');
    const files = await epubFiles();
    const names = Object.keys(files);
    expect(names[0]).toBe('mimetype');
    expect(files['mimetype']).toBe('application/epub+zip');
    expect(names).toEqual(
      expect.arrayContaining(['META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml', 'OEBPS/comic.css', 'OEBPS/images/0001.jpg', 'OEBPS/images/0002.jpg', 'OEBPS/page-0001.xhtml', 'OEBPS/page-0002.xhtml']),
    );
  });

  it('is pre-paginated, spines the pages in order, marks the first picture as the cover, and keeps the persistent identifier', async () => {
    const opf = (await epubFiles())['OEBPS/content.opf'] as string;
    expect(opf).toContain('<meta property="rendition:layout">pre-paginated</meta>');
    expect(opf).toContain('<dc:identifier id="pub-id">urn:uuid:3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d</dc:identifier>');
    expect(opf.indexOf('idref="page-0001"')).toBeLessThan(opf.indexOf('idref="page-0002"'));
    expect(opf).toContain('href="images/0001.jpg" media-type="image/jpeg" properties="cover-image"');
    expect(opf).not.toMatch(/href="images\/0002\.jpg"[^>]*cover-image/);
    expect(opf).toContain('page-progression-direction="ltr"');
    expect(opf).toContain('<meta property="dcterms:modified">2026-10-02T15:00:00Z</meta>');
  });

  it('turns right to left for a manga book', async () => {
    const opf = (await epubFiles({ state: comicProject('rtl') }))['OEBPS/content.opf'] as string;
    expect(opf).toContain('page-progression-direction="rtl"');
  });

  it('gives every page a viewport the size of its picture, and the picture at that size', async () => {
    const page = (await epubFiles())['OEBPS/page-0001.xhtml'] as string;
    expect(page).toContain(`<meta name="viewport" content="width=1288, height=${COMIC_RASTER_HEIGHT_PX}"/>`);
    expect(page).toContain(`<img src="images/0001.jpg" alt="Night Ferry 1" width="1288" height="${COMIC_RASTER_HEIGHT_PX}"/>`);
  });

  it('keeps the balloon text as real text in reading order, without the emphasis markers and without hiding it', async () => {
    const files = await epubFiles();
    const page = files['OEBPS/page-0001.xhtml'] as string;
    expect(page).toContain('<li dir="auto">Where were you?</li>');
    expect(page).not.toContain('**');
    for (const hidden of ['display: none', 'display:none', 'visibility: hidden', 'visibility:hidden', 'aria-hidden']) {
      expect(page).not.toContain(hidden);
      expect(files['OEBPS/comic.css']).not.toContain(hidden);
    }
    expect(files['OEBPS/comic.css']).toContain('.lettering');
  });

  it('lists every panel in a region-based data navigation document outside the spine, labelled page.panel', async () => {
    const files = await epubFiles();
    expect(files['OEBPS/nav.xhtml']).toContain('epub:type="toc"');
    expect(files['OEBPS/nav.xhtml']).not.toContain('region-based');
    const region = files['OEBPS/region-nav.xhtml'] as string;
    expect(region).toContain('epub:type="region-based"');
    expect(region).toContain('<a href="page-0001.xhtml#p0001-panel-1">1.1</a>');
    expect(region).toContain('<a href="page-0002.xhtml#p0002-panel-1">2.1</a>');
    const opf = files['OEBPS/content.opf'] as string;
    expect(opf).toContain('href="region-nav.xhtml" media-type="application/xhtml+xml" properties="data-nav"');
    expect(opf).not.toContain('idref="region-nav"');
  });

  it('refuses a project with no persistent identifier, as the prose EPUB does, before anything is drawn', () => {
    const rasterizer = recordingRasterizer();
    expect(() => renderMedia(mediaRequest({ format: 'comic-epub', rasterizeComic: rasterizer, identifier: '' }))).toThrow(NoPersistentIdentifierError);
    expect(() => renderMedia(mediaRequest({ format: 'comic-epub', rasterizeComic: rasterizer, identifier: undefined as never }))).toThrow(NoPersistentIdentifierError);
    expect(rasterizer.events).toEqual([]);
  });

  it('says in a note when the project has no language, and writes en', async () => {
    const request = mediaRequest({ format: 'comic-epub', rasterizeComic: recordingRasterizer(), language: '' });
    const output = renderMedia(request);
    expect(output.notes.join('\n')).toContain('dc:language is "en"');
    const files = await filesOf(output);
    expect(strFromU8(files['OEBPS/content.opf'] as Uint8Array)).toContain('<dc:language>en</dc:language>');
  });

  it('places a panel on the page image as percentages of the trim, and gives no region to a panel with no rectangle', () => {
    const [full] = panelRegionsOf({ size: 'us-comic', panels: [{ id: 'pn_full', rect: [0, 0, 1, 1], balloons: [] }] });
    expect(full?.left).toBeGreaterThan(0);
    expect(full?.left).toBeLessThan(10);
    expect((full?.left ?? 0) * 2 + (full?.width ?? 0)).toBeCloseTo(100, 1);
    const found = panelRegionsOf({ size: 'us-comic', panels: [{ id: 'pn_bad', rect: undefined as never, balloons: [] }] });
    expect(found).toEqual([undefined]);
  });

  it('reads Hebrew and Arabic lettering with dir="auto" and escapes markup in the text', async () => {
    const [manga] = RTL_BOOK.pages.length > 0 ? [mangaPage()] : [];
    const page = manga?.page ?? sixPanelPage().page;
    const bytes = await renderComicEpub({
      title: 'Cats & <Dogs>',
      author: 'A & B',
      language: 'he',
      identifier: `urn:uuid:${IDENTIFIER}`,
      modified: '2026-10-02T15:00:00Z',
      mtime: new Date(NOW),
      readingDirection: 'rtl',
      pages: [{ raster: { number: 1, width: 1288, height: 1988, bytes: JPEG, notes: [] }, page }],
    });
    const files = unzipSync(bytes);
    const xhtml = strFromU8(files['OEBPS/page-0001.xhtml'] as Uint8Array);
    expect(xhtml).toContain('dir="auto"');
    expect(xhtml).toContain('alt="Cats &amp; &lt;Dogs&gt; 1"');
    expect(strFromU8(files['OEBPS/content.opf'] as Uint8Array)).toContain('<dc:title>Cats &amp; &lt;Dogs&gt;</dc:title>');
  });

  it('refuses an empty book', async () => {
    await expect(
      renderComicEpub({ title: 'T', author: '', language: 'en', identifier: 'urn:uuid:x', modified: '2026-10-02T15:00:00Z', mtime: new Date(NOW), readingDirection: 'ltr', pages: [] }),
    ).rejects.toThrow('no page');
  });
});

describe('the raster formats through the command bus', () => {
  interface Rig {
    readonly state: ProjectState;
    readonly exporter: ExporterService;
    readonly bytes: Map<string, Uint8Array>;
    readonly run: (name: Command['name'], params: Record<string, unknown>) => Result<ExecutionOutcome, CommandError>;
  }

  let serial = 0;
  function rig(rasterizer: ComicRasterizer | undefined): Rig {
    const state = comicProject();
    const clock = { now: () => COMPILED_AT };
    const bytes = new Map<string, Uint8Array>();
    const binding: ByteArtifacts = { writeBytes: async (path, data) => void bytes.set(path, data), removeBytes: async (path) => void bytes.delete(path) };
    const exporter = createExporter({
      readState: () => state,
      artifacts: new MemoryArtifactFs(),
      bytes: binding,
      clock,
      metadata: () => ({ author: 'Ada Lovelace', identifier: IDENTIFIER, language: 'en' }),
      ...(rasterizer === undefined ? {} : { rasterizeComic: rasterizer }),
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
    const run: Rig['run'] = (name, params) => {
      serial += 1;
      return execute({ id: `cmd_RASTER${String(serial).padStart(6, '0')}`, name, params, issuedBy: 'user', createdAt: COMPILED_AT } as Command, bus, registry);
    };
    return { state, exporter, bytes, run };
  }

  it.each([
    ['cbz', 'exports/Night Ferry (comic).cbz', 'ComicInfo.xml'],
    ['comic-epub', 'exports/Night Ferry (comic).epub', 'OEBPS/content.opf'],
  ] as const)('writes a %s to the byte store and says its page count in the log', async (format, path, entry) => {
    const r = rig(recordingRasterizer());
    await r.exporter.ready();
    const outcome = r.run('export.compileSelection', { includeRootIds: ['n_COMICBOOK01'], format });
    expect(outcome.ok).toBe(true);
    await r.exporter.idle();
    expect(r.exporter.failures()).toEqual([]);
    const written = r.bytes.get(path);
    expect(written, [...r.bytes.keys()].join(', ')).toBeDefined();
    expect(Object.keys(unzipSync(written as Uint8Array))).toContain(entry);
  });

  it.each(['cbz', 'comic-epub'] as const)('refuses a %s on a host with no canvas with the spec sentence, and writes nothing', async (format) => {
    const r = rig(undefined);
    await r.exporter.ready();
    const outcome = r.run('export.compileSelection', { includeRootIds: ['n_COMICBOOK01'], format });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toContain(SENTENCE);
    await r.exporter.idle();
    expect(r.bytes.size).toBe(0);
    expect(r.exporter.failures()).toEqual([]);
  });
});
