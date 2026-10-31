/**
 * @caotang/import-core: the block model every document reader emits and the pure splitter that proposes a binder tree from it
 * (docs/architecture/import-core.md). No DOM, no dependencies: it runs on the main thread, in a `'self'` Worker and in Node.
 */
export type {
  Align,
  BreakBlock,
  HeadingBlock,
  ImageBlock,
  ImportAsset,
  ImportBlock,
  ImportComment,
  ImportDocument,
  ImportFootnote,
  ImportMetadata,
  InjectionHit,
  LossCode,
  LossWarning,
  OtherBlock,
  PageBreakBlock,
  ParaBlock,
  Signals,
} from './model.js';
export type { ChapterRule, ChunkDestination, PatternFamily, SceneRules, SplitLabels, SplitOverrides, SplitRules } from './rules.js';
export { DEFAULT_LABELS, DEFAULT_RULES, resolveRules } from './rules.js';
export type {
  Detected,
  LocatedInjectionHit,
  ProposedChunk,
  ProposedDoc,
  ProposedFolder,
  ProposedNode,
  ProposedStoryPart,
  SanityFlag,
  SplitMarker,
  SplitNotice,
  SplitOptions,
  SplitReason,
  SplitResult,
  SplitRuleInput,
} from './split.js';
export { splitImport } from './split.js';
export type { PatternMatch, SpecialKind } from './text.js';
export { breakMarkerOf, countWords, isShortLine, matchFamily, numberValue, specialOf, stripChapterNumber } from './text.js';
