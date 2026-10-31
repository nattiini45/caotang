/**
 * The exporter of one open project, in a module of its own so the compile pipeline (the renderers, the PDF writer and what they pull in)
 * is downloaded when the writer first compiles, and not with the page. `ProjectSession` imports this file only through `import()`; nothing
 * that loads at start may import it statically (the first-load budget in `tools/check-bundle-size.mjs` is what notices).
 */

import { createExporter, exportMetadataOf, type ExporterService } from '@caotang/exporter';
import type { AssetRecord } from '@caotang/video-prompt-pack';
import type { ProjectState } from '@caotang/store';

import { createComicRasterizer } from '../media/comic-raster.js';
import { browserRasterHost } from '../media/comic-raster-host.js';
import { coherenceReportWords } from './coherence-report-words.js';
import { loadArabicFontOverHttp, loadCjkFontOverHttp, loadComicLetteringFontOverHttp, loadDevanagariFontOverHttp, loadEmojiFontOverHttp, loadHebrewFontOverHttp } from './fallback-fonts.js';
import { processPictureInBrowser, transcodePictureInBrowser } from './picture-transcoder.js';
import type { ExportStore } from './exports.js';
import type { ProjectAssets } from './project-assets.js';

/** The timeline's *Save image* draws with these (timeline-image.ts), so it reaches them through this module. */
export { rasterizeSvgToPng, renderTimelineSvg } from '@caotang/exporter';

/** The project's stored images as the exporter names them (the shot list and the prompt pack): the listing of `assets/`. */
export type AssetRecords = ReadonlyMap<string, AssetRecord>;

const comicRasterizer = createComicRasterizer(browserRasterHost);

/**
 * The exporter for one project. It reads the state through `read`, so it always sees the project as it is now. Its cover is
 * read from the project's asset store, where the cover import put it; its compile outputs go to the export store. Its images are
 * read through `images`, which the session holds from its last listing (`refreshAssetRecords`).
 */
export function exporterFor(
  read: () => ProjectState,
  artifacts: ExportStore,
  assets: ProjectAssets,
  images: () => AssetRecords,
): ExporterService {
  return createExporter({
    readState: read,
    artifacts: artifacts.artifacts,
    bytes: artifacts.bytes,
    metadata: (state) => exportMetadataOf(state.manifest.project),
    readAsset: (path) => assets.readBytes(path),
    assets: images,
    // The contact sheet's font for text outside Latin script, fetched from this origin only when a sheet needs it.
    loadFallbackFont: loadCjkFontOverHttp,
    // Its emoji font (Noto Emoji, monochrome), fetched from this origin only when a sheet holds an emoji.
    loadEmojiFont: loadEmojiFontOverHttp,
    // Noto Sans Arabic, Noto Sans Hebrew and Noto Sans Devanagari, fetched from this origin only when a file holds their script.
    loadArabicFont: loadArabicFontOverHttp,
    loadHebrewFont: loadHebrewFontOverHttp,
    loadDevanagariFont: loadDevanagariFontOverHttp,
    // The comic PDF's lettering faces (Comic Neue and Bangers), fetched from this origin only when a comic is compiled.
    loadComicFont: loadComicLetteringFontOverHttp,
    // The page raster of the CBZ and the fixed-layout comic EPUB: only a browser has the canvas it is drawn on (comics.md §5, D12).
    rasterizeComic: comicRasterizer,
    // A WebP picture on the contact sheet, drawn on a canvas: the PDF embeds PNG and JPEG only, and the CSP refuses WebAssembly.
    transcodePicture: transcodePictureInBrowser,
    // The prose figures' profiles (pictures.md §4): the EPUB's 1600 px flattened JPEG/PNG and the DOCX's capped extent.
    processPicture: processPictureInBrowser,
    // The coherence report's words follow the interface language at the moment of the compile.
    reportWords: coherenceReportWords,
  });
}
