/**
 * `@caotang/exporter` — the compile pipeline ([exporter.md](../../../docs/architecture/exporter.md)):
 * select → flatten → render → emit, with the Markdown, plain-text, DOCX and EPUB renderers, and the
 * media-track formats of the one-source compile (`media.ts`): screenplay Fountain, FDX and PDF, the dialogue table and
 * compiled Ink, the storyboard shot list and contact sheet, and the video prompt pack. The dialogue table and the shot list are also written
 * as spreadsheets (`render-xlsx.ts`).
 *
 * The store never imports this package. The app builds one exporter over the
 * project's artifact folder and hands its `commandPort()` to the store's registry:
 *
 * ```ts
 * const exporter = createExporter({ readState: () => state, artifacts: fs });
 * await exporter.ready();
 * const registry = createProjectCommandRegistry({ clock, exporter: exporter.commandPort() });
 * ```
 */

export {
  BINARY_FORMATS,
  EXPORT_FORMATS,
  MEDIA_FORMATS,
  isBinaryFormat,
  isExportFormat,
  isMediaFormat,
  type CompileLogEntry,
  type ExportCommandDigest,
  type ExportCommandOutcome,
  type ExportCommandPortShape,
  type ExportCommandRequest,
  type ExportCommandSelection,
  type ExportFile,
  type ExportFormat,
  type ExportMetadataInput,
  type ExportRecipe,
  type ExportRecipeOptions,
  type ExportResult,
  type ExportSelection,
  type Exporter,
  type ExporterClock,
  type FilterDocument,
  type FlatBlock,
  type MediaFormat,
  type PictureExportMode,
} from './types.js';
// The figure model of the prose pipeline and its resolution against the project (pictures.md §4, §2.2.1).
export {
  assetRefOfUrl,
  figureSourcesOf,
  formatBytes,
  placementTextOf,
  resolveFigures,
  usedAssetFilesOf,
  type FigureHost,
  type FigurePack,
  type FigureRecord,
  type PackedImage,
  type ResolvedFigure,
} from './figures.js';
// The per-target picture profiles (pictures.md §4): EPUB ≤ 1600 px flattened JPEG/PNG, DOCX extent-capped, Markdown copy.
export {
  copySpec,
  DOCX_IMAGE_MAX_EDGE,
  DOCX_TEXT_WIDTH_TWIPS,
  docxSpec,
  EPUB_IMAGE_MAX_PX,
  epubSpec,
  PICTURE_JPEG_QUALITY,
  profileForSource,
  webpKindOf,
  type FigureTargetSpec,
  type WebpKind,
} from './picture-profile.js';
// The Markdown export's byte-preserving image rewriting (pictures.md §4, the Markdown row).
export { rewriteMarkdownImages, type MarkdownPicturesMode } from './markdown-pictures.js';

export { createExporter, EXPORT_MIME, recipesOf, type ExportDispatch, type ExporterOptions, type ExporterService } from './exporter.js';
// The metadata and the stored images an export reads, the same for every host that compiles (epub-metadata.md).
export { assetRecordsOf, exportMetadataOf } from './export-metadata.js';
export { SCENE_STYLE_ROWS, type SceneStyleRow } from './scene-style.js';
export { flatten, documentLabel, type FlattenOptions, type FlattenResult } from './flatten.js';
export { CONTACT_SHEET_HEADER, renderMedia, type MediaFile, type MediaOutput, type MediaRequest } from './media.js';
// The storyboard contact sheet's PDF emitter (storyboard.md §6), over pdf-lib, loaded lazily.
export {
  PDF_MIME,
  containIn,
  drawContactSheet,
  fitToWidth,
  type ContactSheetPdf,
  type ContactSheetPdfInput,
  type PictureTranscoder,
} from './render-contact-sheet.js';
// The comic PDF's emitter (comics.md §5). It is reached through `renderMedia` only, which loads it on demand, so only
// its input types are exported here: a runtime re-export would pull the renderer into the app's first download.
export type { ComicPdf, ComicPdfBook, ComicPdfInput, ComicPdfPageInput } from './render-comic-pdf.js';
export { selectComic, type ComicSelection, type SelectedComic } from './comic-book.js';
// The page raster the CBZ and the comic EPUB share (comics.md §5, D12): the port the app draws through and the rules it is drawn under. The writers
// are reached through `renderMedia` only, which loads them on demand, so only their input types are exported here.
export {
  CBZ_MIME,
  COMIC_RASTER_HEIGHT_PX,
  COMIC_RASTER_MIME,
  COMIC_RASTER_QUALITY,
  ComicRasterCancelledError,
  rasterizeComicBook,
  type ComicRasterizer,
  type ComicRasterPage,
  type ComicRasterPageRequest,
  type RasterizeBookOptions,
  type RasterizedBook,
} from './comic-raster.js';
export type { CbzInput } from './render-cbz.js';
export type { ComicEpubInput, ComicEpubPage } from './render-comic-epub.js';
// The timeline's exports (timeline.md §8): the table as CSV and XLSX, the drawn axis as SVG and as a paginated PDF,
// and the browser's PNG rasterizer for the view's Save image. The compile reaches the first four through renderMedia.
export { TIMELINE_COLUMNS, buildExportModel, timelineCsv, timelineRowCells, timelineTable, type TimelineExportRow, type TimelineTable, type TimelineTableInput } from './render-timeline-csv.js';
export { timelineSheet } from './render-timeline-xlsx.js';
export { renderTimelineSvg, SVG_AGGREGATE_ABOVE, SVG_MIME, svgEscape, type TimelineSvgInput, type TimelineSvgOutput } from './render-timeline-svg.js';
export type { TimelinePdf, TimelinePdfInput } from './render-timeline-pdf.js';
export { PNG_MAX_SIDE, PNG_MIME, rasterizeSvgToPng, svgIntrinsicSize, type RasterizeSvgOptions } from './render-timeline-png.js';
// The coherence report's renderers (the one-source compile's Review row). The compile reaches them through `renderMedia`.
export {
  COHERENCE_JSON_MIME,
  COHERENCE_MARKDOWN_MIME,
  coherenceReportJson,
  coherenceReportMarkdown,
  ENGLISH_REPORT_WORDS,
  type CoherenceReportInput,
  type CoherenceReportWords,
} from './coherence-report.js';
export {
  COMPILE_LOG_FILE,
  COMPILE_LOG_PATH,
  createEmitter,
  type ByteArtifacts,
  type EmitFailure,
  type Emitter,
  type PublishedFile,
  type PublishFilesJob,
} from './emit.js';
export { DEFAULT_TEMPLATE, DEFAULT_TEMPLATE_ID, anchorOf, fileStem, resolveTemplate, suffixName, type ExportTemplate } from './template.js';
export { DOCX_MIME, renderDocx } from './render-docx.js';
export { EPUB_MIME, escapeXml, renderEpub, type EpubCover, type EpubInput } from './render-epub.js';
export { renderMarkdown, renderText } from './render-text.js';
export { XLSX_CELL_MAX, XLSX_MIME, prepareSheet, renderXlsx, sheetName, xlsxParts, xlsxText, type XlsxCell, type XlsxSheet } from './render-xlsx.js';
export { parseProse, plainProse, safeHref, type ImageRef, type ProseBlock, type Run } from './prose.js';
export {
  ComicRasterUnavailableError,
  ExportNotReadyError,
  ExportUnavailableError,
  InvalidRecipeError,
  MediaRefusedError,
  NoPersistentIdentifierError,
  UnknownExportFormatError,
  UnknownRecipeError,
} from './errors.js';
