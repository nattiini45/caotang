/**
 * The four media engines, as the views reach them.
 *
 * This is the only file in this folder that names an engine package. The desktop declares the four as workspace
 * dependencies (`apps/desktop/package.json`), so they resolve by their bare names, the way `@caotang/store` does.
 *
 * Named exports only, and only the names this folder uses. The storyboard and prompt-pack packages export
 * overlapping names (`childrenOf`, `ok`, `refuse`), so a star re-export would hide a collision until a view
 * called the wrong one.
 */

export { estimatePageCount, estimateRuntimeMinutes } from '@caotang/screenplay';
export { characterCueNames, cueSpellingGroups, type CueSpellingGroup } from '@caotang/screenplay';
export { parseFountain, type SceneSpan } from '@caotang/screenplay';
export { LINE_ELEMENT_TYPES, convertLine, lineElementAt, type LineConversion, type LineElementType } from '@caotang/screenplay';
export { printedText } from '@caotang/screenplay';
export type { LocatedElement } from '@caotang/screenplay';
export { isScreenplayKind } from '@caotang/screenplay';

export {
  ACTION_MAX_CHARS,
  CAMERA_ANGLES,
  CAMERA_MOVEMENTS,
  DERIVE_FOLDER_SUFFIX,
  SHOT_ENUMS,
  SHOT_SIZES,
  TRANSITIONS,
  cardSpecRowOf,
  enumLabelOf,
  isShotNode,
  isStoryboardFolder,
  specRowOf,
  type ShotEnumField,
  type ShotMeta,
} from '@caotang/storyboard';
export { checkShotMeta, readShotMeta, storedValueOf } from '@caotang/storyboard';
export { displayNumbers, planMoveShot, shotsIn } from '@caotang/storyboard';
export type { ShotCommand } from '@caotang/storyboard';
export { shotFieldOf } from '@caotang/storyboard';
export { listAssets, readImage } from '@caotang/storyboard';
export type { StoryboardRefusal, StoryboardResult } from '@caotang/storyboard';
export { animaticTotals, captureTextAnchor, locateQuote, type DialogueCoverage, type TextAnchor } from '@caotang/storyboard';

export {
  END_TARGET,
  LAYOUT_COLUMN_WIDTH,
  LAYOUT_ROW_HEIGHT,
  ROOT_NODE_ID,
  ensureLineIds,
  layoutGraph,
  missingLineIds,
  mintImportIds,
  nodeAtOffset,
  readDialogueMeta,
  unreachableNodes,
  validateContainer,
  type ChoiceRecord,
  type ContainerStats,
  type DialogueFinding,
  type DialogueGraph,
  type GraphLayout,
  type GraphNode,
  type ImportIdResult,
  type MintOptions,
  type UnplaceableLine,
} from '@caotang/dialogue';

export {
  REFERENCE_TYPES,
  SEED_MAX,
  SEED_MIN,
  VIDEO_ASPECT_RATIOS,
  VIDEO_MODES,
  VIDEO_RESOLUTIONS,
  VIDEO_TEMPLATES,
  mentionWords,
  preparePack,
  renderPromptPack,
  shotNumbers,
  templateById,
  vendorRefOf,
  withheldWords,
  type AssetRecord,
  type BestTake,
  type ReferenceProvenance,
  type CoveredScript,
  type PackArtifact,
  type PackRun,
  type RenderOutcome,
  type ShotNode,
  type StoryboardSnapshot,
  type ValidationIssue,
  type VideoAspectRatio,
  type VideoDurationSec,
  type VideoMode,
  type VideoReference,
  type VideoResolution,
  type VideoShotRef,
  type VideoVendorTemplate,
} from '@caotang/video-prompt-pack';
