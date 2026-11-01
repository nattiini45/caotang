/**
 * The EPUB acceptance gate — exporter.md §3a and epub-metadata.md. The gate is epubcheck, run over the fixture corpus
 * (EPUB 3.3): every book reports zero fatal errors and zero errors, and carries a navigation document and an NCX.
 *
 * The validator is `@likecoin/epubcheck-ts`, a **dev dependency of this package only**, pinned exact at 0.7.0. It is
 * BSD-3-Clause from 0.7.0; every earlier version is GPL-3.0-only, which is why nothing below 0.7.0 is pinned. It never
 * enters the app bundle: nothing under `src/` imports it, and this file is the only reader.
 *
 * The corpus is the six epub-metadata.md fixtures that a pack can carry, plus one book compiled through the exporter's
 * own `compile`, so the metadata callback's path is validated and not only the renderer's.
 */

import { describe, expect, it } from 'vitest';
import { EpubCheck } from '@likecoin/epubcheck-ts';
import { MemoryArtifactFs, type ProjectState } from '@caotang/store';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate/browser';
import { createExporter } from '../src/exporter.js';
import { renderComicEpub, type ComicEpubInput } from '../src/render-comic-epub.js';
import { renderEpub, type EpubInput } from '../src/render-epub.js';
import { JPEG, mangaPage, sixPanelPage } from './comic-pdf-fixture.js';
import { IDS, makeProject, withSceneStyle } from './fixture.js';
import { COVER_PNG, EPUB_IDENTIFIER, epubInput } from './epub-fixtures.js';

/** The six fixtures epub-metadata.md names for the metadata floor, and the compiled book. */
const CORPUS: readonly { readonly name: string; readonly build: () => Promise<Uint8Array> }[] = [
  {
    name: 'fixture 1: zero-config minimal book (no cover, no ISBN)',
    build: () => bytesOf(epubInput({ author: '' })),
  },
  {
    name: 'fixture 2: ISBN present (both identifiers and the refines meta)',
    build: () => bytesOf(epubInput({ isbn: 'urn:isbn:9780306406157' })),
  },
  {
    name: 'fixture 3: cover asset set (cover-image item and legacy cover meta)',
    build: () => bytesOf(epubInput({ cover: COVER_PNG })),
  },
  {
    name: 'fixture 4: ISBN and cover together',
    build: () => bytesOf(epubInput({ isbn: 'urn:isbn:9780306406157', cover: COVER_PNG })),
  },
  {
    name: 'fixture 5: the same manifest packed again at a later time',
    build: () => bytesOf(epubInput({ modified: '2026-10-09T18:00:00Z' })),
  },
  {
    name: 'fixture 6: a language other than English',
    build: () => bytesOf(epubInput({ language: 'de', author: 'M. Ortega' })),
  },
];

/** The bytes of one render, from the input the fixture builds. */
function bytesOf(input: EpubInput): Promise<Uint8Array> {
  return renderEpub(input);
}

/** A whole book compiled through the exporter's own compile, with its metadata supplied the way the app does. */
async function compiledBook(state: ProjectState): Promise<Uint8Array> {
  const exporter = createExporter({
    readState: () => state,
    artifacts: new MemoryArtifactFs(),
    metadata: () => ({
      identifier: EPUB_IDENTIFIER,
      language: 'en',
      author: 'M. Ortega',
      isbn: 'urn:isbn:9780306406157',
      coverAssetId: null,
    }),
  });
  const result = await exporter.compile({ includeRootIds: ['manuscript'] }, 'epub');
  return new Uint8Array(await result.blob.arrayBuffer());
}

describe('the epubcheck gate — EPUB 3.3, zero errors on the corpus', () => {
  for (const book of CORPUS) {
    it(`reports no fatal error and no error for ${book.name}`, async () => {
      const bytes = await book.build();
      const result = await EpubCheck.validate(bytes, { version: '3.3' });
      const errors = result.messages.filter((m) => m.severity === 'error' || m.severity === 'fatal');
      expect(errors.map((m) => `${m.id}: ${m.message}`)).toEqual([]);
      expect(result.fatalCount).toBe(0);
      expect(result.errorCount).toBe(0);
    });
  }

  it('carries a navigation document and an NCX, and one XHTML file per chapter, in every corpus book', async () => {
    for (const book of CORPUS) {
      const files = unzipSync(await book.build());
      const names = Object.keys(files);
      expect(names, book.name).toContain('OEBPS/nav.xhtml');
      expect(names, book.name).toContain('OEBPS/toc.ncx');
      const chapters = names.filter((name) => /OEBPS\/chapter-\d+\.xhtml$/.test(name));
      expect(chapters.length, book.name).toBeGreaterThan(0);
      expect(strFromU8(files['mimetype'] ?? new Uint8Array()), book.name).toBe('application/epub+zip');
    }
  });

  it('fails a broken archive, so a pass above means the validator ran (the control)', async () => {
    // A mimetype that is compressed and a package with no container: both are errors in the spec, and epubcheck must say so.
    const broken = zipSync({ mimetype: strToU8('application/epub+zip') });
    const result = await EpubCheck.validate(broken, { version: '3.3' });
    expect(result.errorCount + result.fatalCount).toBeGreaterThan(0);
  });

  it('validates a whole book compiled through the exporter, with its metadata from the callback', async () => {
    const bytes = await compiledBook(makeProject());
    const result = await EpubCheck.validate(bytes, { version: '3.3' });
    expect(result.messages.filter((m) => m.severity === 'error' || m.severity === 'fatal').map((m) => m.id)).toEqual([]);
    expect(result.errorCount).toBe(0);
    expect(result.fatalCount).toBe(0);
  });

  it('validates a book with section scenes, an h2 in a chapter and under a loose lead scene', async () => {
    const state = withSceneStyle(withSceneStyle(makeProject(), IDS.landing, 'section'), IDS.prologue, 'section');
    const result = await EpubCheck.validate(await compiledBook(state), { version: '3.3' });
    expect(result.messages.filter((m) => m.severity === 'error' || m.severity === 'fatal').map((m) => m.id)).toEqual([]);
    expect(result.errorCount + result.fatalCount).toBe(0);
  });
});


describe('the epubcheck gate — the fixed-layout comic EPUB', () => {
  const raster = (number: number) => ({ number, width: 1288, height: 1988, bytes: JPEG, notes: [] });
  const comicBook = (readingDirection: 'ltr' | 'rtl', language: string, pages: ComicEpubInput['pages']): Promise<Uint8Array> =>
    renderComicEpub({
      title: 'Night Ferry',
      author: 'Ada Lovelace',
      language,
      identifier: EPUB_IDENTIFIER,
      modified: '2026-10-02T15:00:00Z',
      mtime: new Date('2026-10-02T15:00:00Z'),
      readingDirection,
      pages,
    });
  const CASES: readonly { readonly name: string; readonly build: () => Promise<Uint8Array> }[] = [
    {
      name: 'a left-to-right book of six-panel pages with every balloon kind',
      build: () => comicBook('ltr', 'en', [{ raster: raster(1), page: sixPanelPage().page }, { raster: raster(2), page: sixPanelPage().page }]),
    },
    {
      name: 'a right-to-left manga page with Han, Hebrew and Arabic lettering',
      build: () => comicBook('rtl', 'ja', [{ raster: raster(1), page: mangaPage().page }]),
    },
    {
      name: 'a single page with no balloon text',
      build: () => comicBook('ltr', 'en', [{ raster: raster(1), page: { size: 'us-comic', panels: [{ id: 'pn_quiet0001', rect: [0, 0, 1, 1], balloons: [] }] } }]),
    },
  ];

  for (const book of CASES) {
    it(`reports no fatal error and no error for ${book.name}`, async () => {
      const result = await EpubCheck.validate(await book.build(), { version: '3.3' });
      const errors = result.messages.filter((m) => m.severity === 'error' || m.severity === 'fatal');
      expect(errors.map((m) => `${m.id}: ${m.message}`)).toEqual([]);
      expect(result.fatalCount + result.errorCount).toBe(0);
    });
  }
});
