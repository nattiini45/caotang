/**
 * The fixed-layout comic EPUB — [comics.md](../../../docs/architecture/comics.md) §5, `comic-epub`.
 *
 * One page image per spine item. The package is `rendition:layout` `pre-paginated`, every page document names its own viewport (the pixel size
 * of its image), and the spine's `page-progression-direction` is the book's reading direction, so a right-to-left book turns the way a manga
 * does. The first page's image is the cover. The pictures are the page raster's (./comic-raster.ts), the same ones the CBZ holds; nothing here draws.
 *
 * ## Accessible text
 *
 * The lettering is in the picture, so each page document also carries it as text, in reading order: panels in the book's stored order, and
 * inside a panel its balloons in stored order. A panel is an element laid over its rectangle on the image, and its balloon text is a list
 * inside it. That list is clipped to a pixel off the page, the way a screen-reader-only text is, not hidden: it is never `display:none`,
 * `visibility:hidden` or `aria-hidden`, so a screen reader, a read-aloud voice and a search all reach it. The text is the writer's own
 * (the `**` emphasis markers removed, the lettering's capitals not applied), each item with `dir="auto"` so Hebrew or Arabic lettering in a
 * left-to-right book is read the right way round.
 *
 * ## Panel navigation
 *
 * A Data Navigation Document (`region-nav.xhtml`, manifest property `data-nav`, not in the spine) carries a `region-based` navigation of every
 * panel, in reading order, each linking to its panel element, so a reader that offers panel-by-panel reading can step through the page. A link
 * is labelled by the page and panel number (`3.2`) and not by a word, so the book needs no translation of its own.
 *
 * `fflate/browser` is imported on demand (render-epub.ts says why).
 */

import { pageGeometry, stripEmphasis, type ComicPage, type ReadingDirection } from '@caotang/comic';
import type { ZipOptions } from 'fflate/browser';

import { boilerplateFor } from './boilerplate.js';
import type { ComicRasterPage } from './comic-raster.js';
import { EPUB_MIME, escapeXml } from './render-epub.js';

const OPF_PATH = 'OEBPS/content.opf';
const NAV_FILE = 'nav.xhtml';
const REGION_NAV_FILE = 'region-nav.xhtml';
const CSS_FILE = 'comic.css';

export interface ComicEpubPage {
  /** The rasterised page: its JPEG and its size in pixels, which is the page's viewport. */
  readonly raster: ComicRasterPage;
  readonly page: ComicPage;
}

export interface ComicEpubInput {
  readonly title: string;
  readonly author: string;
  /** BCP 47 tag. */
  readonly language: string;
  /** `urn:uuid:…`, persistent across re-packs (epub-metadata.md). */
  readonly identifier: string;
  /** `YYYY-MM-DDTHH:MM:SSZ`. */
  readonly modified: string;
  readonly mtime: Date;
  readonly readingDirection: ReadingDirection | string;
  readonly pages: readonly ComicEpubPage[];
}

/** A panel's rectangle on its page image, as percentages of the image (its trim), from the panel's live-area rectangle. */
export interface PanelRegion {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const round = (value: number): number => Math.round(value * 1e4) / 1e4;
const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/** Where each panel of a page lies on the page image, in the panels' stored order. A panel with no readable rectangle gets none. */
export function panelRegionsOf(page: ComicPage): readonly (PanelRegion | undefined)[] {
  const geometry = pageGeometry(page.size);
  return page.panels.map((panel) => {
    const rect = panel.rect;
    if (rect === undefined || rect.length !== 4 || !rect.every((n) => Number.isFinite(n))) return undefined;
    const left = ((geometry.liveMarginMm + rect[0] * geometry.liveWidthMm) / geometry.trimWidthMm) * 100;
    const top = ((geometry.liveMarginMm + rect[1] * geometry.liveHeightMm) / geometry.trimHeightMm) * 100;
    const width = ((rect[2] * geometry.liveWidthMm) / geometry.trimWidthMm) * 100;
    const height = ((rect[3] * geometry.liveHeightMm) / geometry.trimHeightMm) * 100;
    return { left: round(clampPercent(left)), top: round(clampPercent(top)), width: round(Math.min(width, 100 - left)), height: round(Math.min(height, 100 - top)) };
  });
}

const pageKey = (index: number, count: number): string => String(index + 1).padStart(Math.max(4, String(count).length), '0');

const imageFile = (index: number, count: number): string => `images/${pageKey(index, count)}.jpg`;
const pageFile = (index: number, count: number): string => `page-${pageKey(index, count)}.xhtml`;
const panelId = (index: number, count: number, panel: number): string => `p${pageKey(index, count)}-panel-${panel + 1}`;

const STYLESHEET = [
  'html, body { margin: 0; padding: 0; }',
  'body { overflow: hidden; }',
  '.page { position: relative; width: 100%; height: 100%; }',
  '.page img { position: absolute; left: 0; top: 0; width: 100%; height: 100%; display: block; }',
  '.panel { position: absolute; }',
  '.lettering { position: absolute; width: 1px; height: 1px; margin: 0; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; list-style: none; }',
  '',
].join('\n');

function containerXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
    '  <rootfiles>',
    `    <rootfile full-path="${OPF_PATH}" media-type="application/oebps-package+xml"/>`,
    '  </rootfiles>',
    '</container>',
    '',
  ].join('\n');
}

function packageOpf(input: ComicEpubInput): string {
  const count = input.pages.length;
  const lang = escapeXml(input.language);
  const manifest: string[] = [
    `    <item id="nav" href="${NAV_FILE}" media-type="application/xhtml+xml" properties="nav"/>`,
    `    <item id="css" href="${CSS_FILE}" media-type="text/css"/>`,
    ...(hasRegions(input) ? [`    <item id="region-nav" href="${REGION_NAV_FILE}" media-type="application/xhtml+xml" properties="data-nav"/>`] : []),
  ];
  const spine: string[] = [];
  input.pages.forEach((_, index) => {
    const key = pageKey(index, count);
    manifest.push(`    <item id="image-${key}" href="${imageFile(index, count)}" media-type="image/jpeg"${index === 0 ? ' properties="cover-image"' : ''}/>`);
    manifest.push(`    <item id="page-${key}" href="${pageFile(index, count)}" media-type="application/xhtml+xml"/>`);
    spine.push(`    <itemref idref="page-${key}"/>`);
  });
  const direction = input.readingDirection === 'rtl' ? 'rtl' : 'ltr';
  const creator = input.author.trim() === '' ? [] : [`    <dc:creator id="creator">${escapeXml(input.author.trim())}</dc:creator>`];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${lang}">`,
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `    <dc:identifier id="pub-id">${escapeXml(input.identifier)}</dc:identifier>`,
    `    <dc:title>${escapeXml(input.title)}</dc:title>`,
    `    <dc:language>${lang}</dc:language>`,
    ...creator,
    `    <meta property="dcterms:modified">${escapeXml(input.modified)}</meta>`,
    '    <meta property="rendition:layout">pre-paginated</meta>',
    '    <meta property="schema:accessMode">visual</meta>',
    '    <meta property="schema:accessMode">textual</meta>',
    '    <meta property="schema:accessModeSufficient">visual,textual</meta>',
    '    <meta property="schema:accessibilityFeature">readingOrder</meta>',
    '    <meta property="schema:accessibilityFeature">tableOfContents</meta>',
    '    <meta property="schema:accessibilityHazard">none</meta>',
    '  </metadata>',
    '  <manifest>',
    ...manifest,
    '  </manifest>',
    `  <spine page-progression-direction="${direction}">`,
    ...spine,
    '  </spine>',
    '</package>',
    '',
  ].join('\n');
}

function xhtmlPage(input: ComicEpubInput, title: string, head: readonly string[], body: readonly string[], bodyAttributes = ''): string {
  const lang = escapeXml(input.language);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE html>',
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">`,
    '<head>',
    '  <meta charset="utf-8"/>',
    `  <title>${escapeXml(title)}</title>`,
    ...head.map((line) => `  ${line}`),
    '</head>',
    `<body${bodyAttributes}>`,
    ...body.map((line) => `  ${line}`),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** A balloon's text for reading: the writer's own words with the emphasis markers removed, a line break kept as one. */
function readableLines(text: string): string[] {
  return stripEmphasis(text)
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function pageXhtml(input: ComicEpubInput, index: number): string {
  const count = input.pages.length;
  const { raster, page } = input.pages[index] as ComicEpubPage;
  const alt = `${input.title} ${index + 1}`;
  const regions = panelRegionsOf(page);
  const panels: string[] = [];
  page.panels.forEach((panel, panelIndex) => {
    const region = regions[panelIndex];
    if (region === undefined) return;
    const style = `left: ${region.left}%; top: ${region.top}%; width: ${region.width}%; height: ${region.height}%`;
    const items: string[] = [];
    for (const balloon of panel.balloons) {
      const lines = readableLines(balloon.text);
      if (lines.length === 0) continue;
      items.push(`      <li dir="auto">${lines.map((line) => escapeXml(line)).join('<br/>')}</li>`);
    }
    panels.push(
      items.length === 0
        ? `  <div class="panel" id="${panelId(index, count, panelIndex)}" style="${style}"></div>`
        : [`  <div class="panel" id="${panelId(index, count, panelIndex)}" style="${style}">`, '    <ul class="lettering">', ...items, '    </ul>', '  </div>'].join('\n'),
    );
  });
  return xhtmlPage(
    input,
    alt,
    [`<meta name="viewport" content="width=${raster.width}, height=${raster.height}"/>`, `<link rel="stylesheet" type="text/css" href="${CSS_FILE}"/>`],
    ['<div class="page">', `  <img src="${imageFile(index, count)}" alt="${escapeXml(alt)}" width="${raster.width}" height="${raster.height}"/>`, ...panels, '</div>'],
    ` style="width: ${raster.width}px; height: ${raster.height}px"`,
  );
}

function navXhtml(input: ComicEpubInput): string {
  const count = input.pages.length;
  const heading = boilerplateFor(input.language).contents;
  const pages = input.pages.map((_, index) => `      <li><a href="${pageFile(index, count)}">${index + 1}</a></li>`);
  return xhtmlPage(input, heading, [], ['<nav epub:type="toc" id="toc">', `  <h1>${escapeXml(heading)}</h1>`, '  <ol>', ...pages, '  </ol>', '</nav>']);
}

const hasRegions = (input: ComicEpubInput): boolean => input.pages.some(({ page }) => panelRegionsOf(page).some((region) => region !== undefined));

/**
 * The region-based navigation lives in a Data Navigation Document of its own (EPUB Region-Based Navigation: `epub:type="region-based"` is valid
 * only there), listed in the manifest as `data-nav` and kept out of the spine. Its heading is the book's title, so it needs no translation.
 */
function regionNavXhtml(input: ComicEpubInput): string {
  const count = input.pages.length;
  const regions: string[] = [];
  input.pages.forEach(({ page }, index) => {
    const found = panelRegionsOf(page);
    page.panels.forEach((_, panelIndex) => {
      if (found[panelIndex] === undefined) return;
      regions.push(`      <li><a href="${pageFile(index, count)}#${panelId(index, count, panelIndex)}">${index + 1}.${panelIndex + 1}</a></li>`);
    });
  });
  return xhtmlPage(input, input.title, [], ['<nav epub:type="region-based">', `  <h1>${escapeXml(input.title)}</h1>`, '  <ol>', ...regions, '  </ol>', '</nav>']);
}

/** The EPUB's bytes. */
export async function renderComicEpub(input: ComicEpubInput): Promise<Uint8Array> {
  if (input.pages.length === 0) throw new Error('the book has no page to put in the EPUB');
  const { zipSync, strToU8 } = await import('fflate/browser');
  const mtime = input.mtime;
  const count = input.pages.length;
  const files: Record<string, [Uint8Array, ZipOptions]> = {};
  // `mimetype` is the first entry and is stored, not deflated: the one ordering rule of the container.
  files['mimetype'] = [strToU8(EPUB_MIME), { level: 0, mtime }];
  files['META-INF/container.xml'] = [strToU8(containerXml()), { level: 9, mtime }];
  files[OPF_PATH] = [strToU8(packageOpf(input)), { level: 9, mtime }];
  files[`OEBPS/${NAV_FILE}`] = [strToU8(navXhtml(input)), { level: 9, mtime }];
  if (hasRegions(input)) files[`OEBPS/${REGION_NAV_FILE}`] = [strToU8(regionNavXhtml(input)), { level: 9, mtime }];
  files[`OEBPS/${CSS_FILE}`] = [strToU8(STYLESHEET), { level: 9, mtime }];
  input.pages.forEach(({ raster }, index) => {
    files[`OEBPS/${imageFile(index, count)}`] = [raster.bytes, { level: 0, mtime }];
    files[`OEBPS/${pageFile(index, count)}`] = [strToU8(pageXhtml(input, index)), { level: 9, mtime }];
  });
  return zipSync(files, { level: 9, mtime });
}
