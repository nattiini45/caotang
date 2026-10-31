/**
 * `@caotang/screenplay` — the screenwriting engine, headless ([screenplay.md](../../../docs/architecture/screenplay.md),
 * the media track's screenplay format).
 *
 * Fountain is parsed into a located element model and serialised back. A whole script
 * imports as sections and scenes, and the scenes are paginated under the spec's constants.
 * The result renders as Fountain (identity), FDX (typed paragraphs) and PDF (paginated).
 *
 * No agent tools are exported. screenplay.md §6 adds none for the screenplay: the screenplay workflow
 * rides the existing `scene.draft`, `doc.read`, `synopsis.fill` and `export.compile` tools.
 * The `export.compile` format enum carries the screenplay formats, which
 * belongs to the exporter and the harness, not to this package.
 *
 * Nothing here touches the editor, the store or the network. The flattened block shape is
 * the exporter's `FlatBlock`, declared structurally in `flat-block.ts` (the exporter depends on
 * this package, so importing it back would be a workspace cycle; a parity test pins the two).
 */

export type { FlatBlock } from './flat-block.js';

export {
  FOUNTAIN_EXTENSION,
  SCREENPLAY_KIND,
  isScreenplayKind,
  screenplayBodyPath,
  type ScreenplayKind,
} from './kind.js';

export type { LocatedElement, ScreenplayElement, ScreenplayElementType, TextRange } from './types.js';

export { printedText } from './classify.js';

export { normaliseSource, parseFountain, type ParsedScreenplay, type SceneSpan } from './parse.js';

export { serialiseFountain } from './serialise.js';

export { LINE_ELEMENT_TYPES, convertLine, lineElementAt, type LineConversion, type LineElementType } from './convert.js';

export {
  importFountainScript,
  type ImportedNode,
  type ImportedScene,
  type ImportedScript,
  type ImportedSection,
} from './import.js';

export { characterCueNames, cueKey, cueSpellingGroups, type CueSpellingGroup } from './cues.js';

export {
  FOUNTAIN_MIME,
  createFountainRenderer,
  renderFountain,
  type FountainRenderOptions,
  type FountainRenderResult,
  type FountainRenderer,
} from './render-fountain.js';

export {
  LAYOUT,
  MINUTES_PER_PAGE,
  PAGE_GEOMETRY,
  PAGE_SIZES,
  SCENE_NUMBER_PLACEMENTS,
  estimatePageCount,
  estimateRuntimeMinutes,
  paginate,
  sceneLengths,
  type LayoutLine,
  type LayoutPage,
  type LineKind,
  type PageGeometry,
  type PageSize,
  type PaginateOptions,
  type SceneNumberPlacement,
  type SceneLength,
} from './paginate.js';

export {
  isPrintable,
  pdfString,
  writePdf,
  type PdfCidFont,
  type PdfCidGlyph,
  type PdfColourEmojiFont,
  type PdfColourGlyph,
  type PdfEmojiFont,
  type PdfEmojiGlyph,
  type PdfFont,
  type PdfFontMetrics,
  type PdfInfo,
  type PdfPlainRun,
  type PdfRtlFonts,
  type PdfRtlItem,
  type PdfShapedGlyph,
  type PdfShapedRun,
  type PdfText,
} from './pdf.js';

export { breakBetween, charColumns, textColumns, textUnits, unitColumns, withMeasure, type MeasureRun } from './width.js';

export type { RtlFontLoaders, RtlSupport } from './rtl-font.js';

export { COURIER_PRIME_METRICS } from './fonts/courier-prime-metrics.js';
export { COUSINE_METRICS } from './fonts/cousine-metrics.js';

export {
  PDF_MIME,
  createPdfRenderer,
  drawPdf,
  layoutPdf,
  loadCjkFallback,
  loadColourEmojiFallback,
  loadEmojiFallback,
  loadCourierPrime,
  loadCousine,
  loadRtlFallback,
  loadScriptFont,
  preparePdf,
  renderPdf,
  SCRIPT_FONTS,
  type PdfFontLoaders,
  type PdfLayout,
  type PdfRenderOptions,
  type PdfRenderResult,
  type PdfRenderer,
  type PreparedPdf,
  type ScriptFont,
} from './render-pdf.js';

export {
  FDX_MIME,
  createFdxRenderer,
  describeFdxImport,
  importFdx,
  lengthInEighths,
  parseFdxParagraphs,
  parseFdxTitlePage,
  renderFdx,
  type FdxImportReport,
  type FdxImportedScript,
  type FdxParagraph,
  type FdxSegment,
  type FdxRenderResult,
  type FdxRenderer,
} from './fdx.js';
export {
  FDX_SEEDS_MAX,
  FDX_SEED_NAME_MAX,
  LABEL_COLOUR_TOLERANCE,
  castListLine,
  colourName,
  fdxColour,
  namingScene,
  nearestLabel,
  type FdxCodexSeed,
  type FdxProductionData,
  type FdxSeedSource,
} from './fdx-extras.js';
