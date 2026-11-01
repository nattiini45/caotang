/**
 * `@caotang/pictures` — the picture registry's pure parts ([pictures.md](../../../docs/architecture/pictures.md)).
 *
 *  - the low-level helpers every import shares: the `assets/` file names and the sniff (`files.ts`, `ids.ts`), header sizes
 *    (`dimensions.ts`), the limits (`limits.ts`), the SHA-256 dedup key (`hash.ts`), and the import pipeline over bytes and an
 *    injected decoder (`pipeline.ts`, §6.4) with its lossless GPS strip (`exif.ts`); these two load from `@caotang/pictures/prepare`;
 *  - the registry's model (`model.ts`), its readers and validators (`validate.ts`), the commands' reading of a file
 *    (`asset-files.ts`) and of its orientation (`metadata.ts`);
 *  - links and placements (`links.ts`, `placement-title.ts`), paragraph anchors (`paragraphs.ts`, `paragraph-map.ts`);
 *  - where a picture is used, the dedup and the backfill plan, derived and never stored (`uses.ts`, §2.1, §6.2);
 *  - what every picture-processing host decides the same way (`process.ts`).
 *
 * Nothing here touches a file system, a DOM or the store: the store applies the commands, and the host decodes.
 */

export * from './model.js';
export * from './ids.js';
export * from './files.js';
export * from './dimensions.js';
export * from './hash.js';
export * from './limits.js';
export { jpegHasGps, jpegOrientation } from './tiff.js';
export type { StrippedPart, StripResult } from './exif.js';
// The pipeline and the strip are values only in `@caotang/pictures/prepare`, which loads on the first import.
export type {
  LargePhotoChoice as PrepareLargePhotoChoice,
  PictureDecoder,
  PictureRefusal as PrepareRefusal,
  PictureRefusalCode as PrepareRefusalCode,
  PrepareResult,
  PreparedPicture,
} from './pipeline.js';
export {
  PICTURE_ASK_BYTES,
  PICTURE_ASK_PIXELS,
  WORKING_COPY_LONG_EDGE,
  decideImportBatch,
  decideImportSize,
  extensionOfMime,
  isSha256Hex,
  mimeOfExtension,
  readPictureHeader,
  sniffPicture,
  workingCopySize,
} from './asset-files.js';
export type { BatchDecision, HeaderResult, ImportDecision, RefusedFormat, SniffResult } from './asset-files.js';
export { PLACEMENT_SIZES, decodePlacementTitle, encodePlacementTitle, placementCaptionOf } from './placement-title.js';
export type { PlacementNote, PlacementSize, PlacementTitle, PlacementTitleInput } from './placement-title.js';
export { displaySize, displaySizeOf, isSideways, readOrientation, recordOrientation } from './metadata.js';
export type { Orientation, RecordOrientation } from './metadata.js';
export {
  LINK_ID_PATTERN,
  isLinkId,
  isRecordFileName,
  readAssetLinks,
  readAssetRecords,
  validateAssetLink,
  validateAssetRecord,
  validateLinkNotePatch,
  validateLinkSet,
  validateRecordPatch,
} from './validate.js';
export type { LinkNotePatch, LinkSetContext, PictureIssue, ReadLinks, ReadRecords, RecordPatch, Validation } from './validate.js';
export {
  LINK_ORDER_GAP,
  addLink,
  cardLinkOf,
  cascadeNodeDeletion,
  makeCard,
  mintLinkId,
  nextLinkOrder,
  nodeIdOfTarget,
  placeLink,
  removeLink,
  reorderLinks,
  setLinkNote,
  sortByOrder,
  targetKey,
} from './links.js';
export type { Cascade, LinkChange, LinkEdit, NewLink } from './links.js';
export {
  cardAssetOf,
  collectUses,
  decideDedup,
  deletionBlockers,
  inlineAssetIds,
  linkedNodeIds,
  linksOf,
  linksToAsset,
  planBackfill,
  usedAssetIds,
  usesOf,
  usesSnapshotOf,
} from './uses.js';
export type {
  AssetListing,
  BackfillPlan,
  ComicPanelRef,
  DedupDecision,
  DedupRecord,
  InlineImageRef,
  LinkQuery,
  ListedFile,
  PictureProject,
  PictureUse,
  UnrecordedFile,
  UsesCodexEntry,
  UsesNode,
  UsesSnapshot,
  VendorOwner,
  VendorRef,
} from './uses.js';
export {
  PARAGRAPH_CONTEXT,
  PARAGRAPH_EXACT_MAX,
  blockHashOf,
  captureParagraphAnchor,
  checkParagraphAnchor,
  fnv1a64Hex,
  normalizeBlockText,
  paragraphBlocks,
} from './paragraphs.js';
export type { ParagraphBlock, ParagraphIdentity } from './paragraphs.js';
export {
  DIFF_WORK_CAP,
  LOOKALIKE_MARGIN,
  SIMILARITY_FLOOR,
  mapParagraphLinks,
  paragraphAnchorPort,
  similarity,
} from './paragraph-map.js';
export type {
  AnchorMapping,
  AnchorOutcome,
  AnchorPort,
  AnchorPortOp,
  AnchorResult,
  MapParagraphLinksInput,
  ParagraphLinkRef,
} from './paragraph-map.js';
export {
  PictureRefusal,
  checkHeic,
  checkOutput,
  finishPassthrough,
  fitLongEdge,
  isPictureRefusal,
  planPicture,
  readHeicSize,
  validateProfile,
} from './process.js';
export type { PicturePlan, PictureRefusalCode } from './process.js';
