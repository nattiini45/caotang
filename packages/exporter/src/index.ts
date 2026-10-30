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
  TEXT_PROOF_FORMATS,
  hasTextProof,
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
  type ExportPreview,
  type ExportPreviewFacts,
  type ExportPreviewRequest,
  type ExportProof,
  type ExportRecipe,
  type ExportRecipeOptions,
  type ExportResult,
  type ExportSelection,
  type Exporter,
  type ExporterClock,
  type FilterDocument,
  type FlatBlock,
  type MediaFormat,
} from './types.js';

export { COLOUR_EMOJI_FORMATS, COLOUR_EMOJI_HINT, COLOUR_EMOJI_LABEL, colourEmojiDefault } from './colour-emoji-option.js';
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
// The coherence report's renderers (the one-source compile's Review row). The compile reaches them through `renderMedia`.
export {
  COHERENCE_JSON_MIME,
  COHERENCE_MARKDOWN_MIME,
  coherenceReportJson,
  coherenceReportMarkdown,
  type CoherenceReportInput,
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
export { parseProse, plainProse, safeHref, type ProseBlock, type Run } from './prose.js';
export {
  ExportNotReadyError,
  ExportUnavailableError,
  InvalidRecipeError,
  MediaRefusedError,
  NoPersistentIdentifierError,
  UnknownExportFormatError,
  UnknownRecipeError,
} from './errors.js';
