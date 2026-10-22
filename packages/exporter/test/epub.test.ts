/**
 * The EPUB structural gate — exporter.md §3a and epub-metadata.md.
 *
 * The acceptance gate §3a names is epubcheck, which runs in `epub-epubcheck.test.ts` over the
 * fixture corpus (pinned at 0.7.0). What this file holds is the structure a unit test can
 * carry: the ZIP's ordering and storage rules, the container, the metadata floor, the manifest and
 * spine, the navigation documents, one XHTML file per chapter, and the properties epub-metadata.md
 * requires to persist across a re-pack. The ISBN, cover and language properties are in
 * `epub-metadata.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate/browser';
import { flatten } from '../src/flatten.js';
import { EPUB_MIME, renderEpub, type EpubInput } from '../src/render-epub.js';
import type { RenderInput } from '../src/render-input.js';
import { DEFAULT_TEMPLATE } from '../src/template.js';
import type { FlatBlock } from '../src/types.js';
import { IDS, makeProject, PROJECT_NAME, withSceneStyle } from './fixture.js';

const IDENTIFIER = 'urn:uuid:3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d';
const MTIME = new Date('2026-10-08T09:30:00.000Z');

function epubInput(overrides: Partial<EpubInput> = {}, blocks?: readonly FlatBlock[]): EpubInput {
  const flat = blocks ?? flatten(makeProject(), { includeRootIds: ['manuscript'] }, { titlePage: true }).blocks;
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
    identifier: IDENTIFIER,
    modified: '2026-10-08T09:30:00Z',
    mtime: MTIME,
    ...overrides,
  };
}

async function pack(input: EpubInput): Promise<{ bytes: Uint8Array; files: Record<string, Uint8Array>; text: Record<string, string> }> {
  const bytes = await renderEpub(input);
  const files = unzipSync(bytes);
  const text: Record<string, string> = {};
  for (const [name, data] of Object.entries(files)) text[name] = strFromU8(data);
  return { bytes, files, text };
}

describe('the EPUB ZIP — the ordering and storage rules', () => {
  it('puts mimetype first in the archive', async () => {
    const { files } = await pack(epubInput());
    expect(Object.keys(files)[0]).toBe('mimetype');
  });

  it('stores mimetype uncompressed, which is the one storage rule the spec sets (§3a)', async () => {
    const { bytes } = await pack(epubInput());
    // A ZIP local file header: signature, then the compression method at offset 8.
    expect(bytes.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const method = bytes[8]! | (bytes[9]! << 8);
    expect(method, 'compression method of the first entry').toBe(0);
    const nameLength = bytes[26]! | (bytes[27]! << 8);
    expect(strFromU8(bytes.slice(30, 30 + nameLength))).toBe('mimetype');
  });

  it('has the exact mimetype content, with no trailing newline', async () => {
    const { text } = await pack(epubInput());
    expect(text['mimetype']).toBe(EPUB_MIME);
    expect(EPUB_MIME).toBe('application/epub+zip');
  });

  it('carries the container at META-INF/container.xml pointing at the package document', async () => {
    const { text } = await pack(epubInput());
    expect(text['META-INF/container.xml']).toContain('full-path="OEBPS/content.opf"');
    expect(text['META-INF/container.xml']).toContain('media-type="application/oebps-package+xml"');
  });
});

describe('the package document — the metadata floor and the spine', () => {
  it('carries the four required elements: identifier, title, language and modified', async () => {
    const opf = (await pack(epubInput())).text['OEBPS/content.opf'] ?? '';
    expect(opf).toContain(`<dc:identifier id="pub-id">${IDENTIFIER}</dc:identifier>`);
    expect(opf).toContain('unique-identifier="pub-id"');
    expect(opf).toContain(`<dc:title>${PROJECT_NAME}</dc:title>`);
    expect(opf).toContain('<dc:language>en</dc:language>');
    expect(opf).toMatch(/<meta property="dcterms:modified">\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/meta>/);
  });

  it('writes the author as a creator when one is given, and omits it when none is', async () => {
    expect((await pack(epubInput())).text['OEBPS/content.opf']).toContain('<dc:creator id="creator">M. Ortega</dc:creator>');
    expect((await pack(epubInput({ author: '' }))).text['OEBPS/content.opf']).not.toContain('dc:creator');
  });

  it('declares the navigation document and the NCX, and keeps the navigation out of the spine', async () => {
    const opf = (await pack(epubInput())).text['OEBPS/content.opf'] ?? '';
    expect(opf).toContain('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
    expect(opf).toContain('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
    expect(opf).toContain('<spine toc="ncx">');
    expect(opf).not.toContain('<itemref idref="nav"');
  });

  it('spines the title page and then one file per section, in book order', async () => {
    const opf = (await pack(epubInput())).text['OEBPS/content.opf'] ?? '';
    const spine = [...opf.matchAll(/<itemref idref="([^"]+)"\/>/g)].map((match) => match[1]);
    // The fixture: a prologue (loose scene), then Chapter One and Chapter Two.
    expect(spine).toEqual(['titlepage', 'chapter-001', 'chapter-002', 'chapter-003']);
    for (const id of spine) {
      expect(opf, `manifest item for ${id}`).toContain(`<item id="${id}" href="${id}.xhtml"`);
    }
  });

  it('leaves out the title page when the recipe turns it off', async () => {
    const blocks = flatten(makeProject(), { includeRootIds: ['manuscript'] }, { titlePage: false }).blocks;
    const { text, files } = await pack(epubInput({}, blocks));
    expect(text['OEBPS/content.opf']).not.toContain('titlepage');
    expect(files['OEBPS/titlepage.xhtml']).toBeUndefined();
  });
});

describe('the navigation documents — built from the binder chapter list', () => {
  it('writes nav.xhtml as the EPUB 3 contents, with one link per section', async () => {
    const nav = (await pack(epubInput())).text['OEBPS/nav.xhtml'] ?? '';
    expect(nav).toContain('epub:type="toc"');
    expect(nav).toContain('<a href="chapter-001.xhtml">Prologue</a>');
    expect(nav).toContain('<a href="chapter-002.xhtml">1. Chapter One</a>');
    expect(nav).toContain('<a href="chapter-003.xhtml">2. Chapter Two</a>');
  });

  it('writes toc.ncx for EPUB 2 readers, with the same navigation points in order', async () => {
    const ncx = (await pack(epubInput())).text['OEBPS/toc.ncx'] ?? '';
    const points = [...ncx.matchAll(/<navPoint id="[^"]+" playOrder="(\d+)">\s*<navLabel><text>([^<]+)<\/text><\/navLabel>\s*<content src="([^"]+)"\/>/g)];
    expect(points.map((match) => [match[1], match[2], match[3]])).toEqual([
      ['1', 'Prologue', 'chapter-001.xhtml'],
      ['2', '1. Chapter One', 'chapter-002.xhtml'],
      ['3', '2. Chapter Two', 'chapter-003.xhtml'],
    ]);
    expect(ncx).toContain(`<meta name="dtb:uid" content="${IDENTIFIER}"/>`);
  });
});

describe('the chapter files — one per section, well-formed by construction', () => {
  it('writes each chapter with its heading and its scene text, with the marks as XHTML elements', async () => {
    const chapter = (await pack(epubInput())).text['OEBPS/chapter-002.xhtml'] ?? '';
    expect(chapter.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(chapter).toContain('<h1>1. Chapter One</h1>');
    expect(chapter).toContain('<em>stepped</em>');
    expect(chapter).toContain('<strong>quay</strong>');
    expect(chapter).toContain('<a href="https://example.com/wave">waved</a>');
    expect(chapter).toContain('<p class="scene-break">* * *</p>');
    expect(chapter.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('escapes the characters XML cannot carry bare, in text and in attributes', async () => {
    const blocks: FlatBlock[] = [
      { kind: 'chapter', title: 'A & B <test>', level: 1, number: 1 },
      { kind: 'scene', docId: IDS.landing, title: 'x', body: 'a < b & c > "d"', number: 1 },
    ];
    // The chapter is the first block, so it is the first section: chapter-001.
    const chapter = (await pack(epubInput({}, blocks))).text['OEBPS/chapter-001.xhtml'] ?? '';
    expect(chapter).toContain('<h1>1. A &amp; B &lt;test&gt;</h1>');
    expect(chapter).toContain('<p>a &lt; b &amp; c &gt; &quot;d&quot;</p>');
  });

  it('will not link to a javascript: target, even when the manuscript asks for one', async () => {
    const blocks: FlatBlock[] = [
      { kind: 'chapter', title: 'One', level: 1, number: 1 },
      { kind: 'scene', docId: IDS.landing, title: 'x', body: '[click](javascript:alert(1))', number: 1 },
    ];
    const chapter = (await pack(epubInput({}, blocks))).text['OEBPS/chapter-001.xhtml'] ?? '';
    expect(chapter).not.toContain('javascript:');
    expect(chapter).toContain('<p>click</p>');
  });
});

describe('a section scene — an h2 in its chapter file (exporter.md §2, Per-scene styling)', () => {
  const styled = (id: string): FlatBlock[] =>
    flatten(withSceneStyle(makeProject(), id, 'section'), { includeRootIds: ['manuscript'] }, { titlePage: true }).blocks;

  it('writes the scene title as an h2 above its prose, inside its chapter', async () => {
    const { text } = await pack(epubInput({}, styled(IDS.landing)));
    const chapter = text['OEBPS/chapter-002.xhtml'] ?? '';
    expect(chapter).toContain('<h1>1. Chapter One</h1>');
    expect(chapter).toMatch(/<h2>The Landing<\/h2>\s*<p>The ferry was late, as always\.<\/p>/);
    expect(chapter.match(/<h2>/g)).toHaveLength(1);
  });

  it('leaves the navigation documents as the chapter list', async () => {
    const { text } = await pack(epubInput({}, styled(IDS.landing)));
    expect(text['OEBPS/nav.xhtml']).not.toContain('The Landing');
    expect(text['OEBPS/toc.ncx']).not.toContain('The Landing');
  });

  it('does not repeat the title of a loose lead scene that already heads its section', async () => {
    const chapter = (await pack(epubInput({}, styled(IDS.prologue)))).text['OEBPS/chapter-001.xhtml'] ?? '';
    expect(chapter).toContain('<h1>Prologue</h1>');
    expect(chapter).not.toContain('<h2>');
  });
});

describe('the metadata that must persist across a re-pack (epub-metadata.md)', () => {
  // The renderer writes the identifier it is handed and nothing else. That the exporter
  // hands it the same stored value on every compile is pinned in exporter.test.ts.
  it('writes the identifier it is given unchanged, while dcterms:modified follows the pack time', async () => {
    const first = (await pack(epubInput({ modified: '2026-10-08T09:30:00Z', mtime: MTIME }))).text['OEBPS/content.opf'] ?? '';
    const second = (await pack(epubInput({ modified: '2026-10-09T11:00:00Z', mtime: new Date('2026-10-09T11:00:00Z') }))).text['OEBPS/content.opf'] ?? '';
    const identifier = (opf: string): string | undefined => opf.match(/<dc:identifier id="pub-id">([^<]+)<\/dc:identifier>/)?.[1];
    expect(identifier(first)).toBe(IDENTIFIER);
    expect(identifier(second)).toBe(IDENTIFIER);
    expect(first).toContain('2026-10-08T09:30:00Z');
    expect(second).toContain('2026-10-09T11:00:00Z');
  });

  it('propagates the language to dc:language and to every XHTML file', async () => {
    const { text } = await pack(epubInput({ language: 'fr' }));
    expect(text['OEBPS/content.opf']).toContain('<dc:language>fr</dc:language>');
    expect(text['OEBPS/chapter-002.xhtml']).toContain('xml:lang="fr"');
    expect(text['OEBPS/nav.xhtml']).toContain('xml:lang="fr"');
  });
});

describe('the EPUB renderer — loaded lazily, from the browser build', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/render-epub.ts', import.meta.url)), 'utf8');

  it('imports fflate only through a dynamic import() of the browser build, never statically', () => {
    expect(source).toMatch(/await import\('fflate\/browser'\)/);
    expect(source).not.toMatch(/^import (?!type )[^;]*from 'fflate[^']*';/m);
  });
});
