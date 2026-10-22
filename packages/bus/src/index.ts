export {
  COMMAND_NAMES,
  FIXED_ROOT_IDS,
  SCENE_STYLES,
  VIEW_COMMAND_NAMES,
  isFixedRootId,
} from './command.js';
export type {
  ApplyContext,
  BinderCreateParams,
  BinderMoveParams,
  BinderRenameParams,
  BinderSetMetaParams,
  BinderSetSynopsisParams,
  CodexAttachParams,
  CodexSourceCitation,
  CodexUpsertOp,
  CodexUpsertParams,
  CoherenceDiscardRunParams,
  CoherenceSetFindingStatusParams,
  CoherenceSetSceneMetaParams,
  CommandProvenance,
  ValidationCoherence,
  ValidationFinding,
  Command,
  CommandApply,
  CommandDescriptor,
  CommandName,
  CommandParams,
  CommandRegistration,
  CommandRegistry,
  CommandStateFor,
  DocWriteParams,
  EditorInsertParams,
  EditorReplaceRangeParams,
  ExportCompileParams,
  ExportCompileSelectionParams,
  MetaPatch,
  SceneStyle,
  NotesAppendParams,
  NotesSetParams,
  Postcondition,
  ProjectDeleteNodeParams,
  UndoKind,
  UndoPayload,
  UndoScope,
  ValidationCodexEntry,
  ValidationDocument,
  ValidationNode,
  ValidationSnapshot,
  ViewCommandName,
  ViewSetActiveDocParams,
  ViewSetCorkboardScopeParams,
  ViewSetExpandedParams,
  ViewSetScrollParams,
  ViewSetSelectionParams,
  ViewState,
} from './command.js';
export type {
  ActivityAffected,
  ActivityDefect,
  ActivityEntry,
  ActivityLog,
  ActivityReport,
  ActivitySource,
} from './activity-log.js';
export { createActivityLog } from './activity-log.js';
export type { CommandError, CommandErrorCode, CommandErrorDetails, PerOpFailure, Result } from './result.js';
export { ok, err } from './result.js';
// The param shapes of the two injected families (the external call, and the storyboard shot commands).
export type {
  McpInvokeParams,
  ShotCreateCommandParams,
  ShotImportImageParams,
  ShotSetMetaCommandParams,
  StoryboardCreateCommandParams,
} from './command.js';
// Storyboard: the shot image import's descriptor, by name, for the store's registration.
export * as shotImageCommands from './descriptors-shot-image.js';
export * as commands from './descriptors.js';
// Project export: the project, recipe, vocabulary and cover-import descriptors, by name. The store reads them here.
export * as projectCommands from './descriptors-project.js';
// The skill commands (extensibility.md §10), by name. The store reads them here.
export * as skillCommands from './descriptors-skills.js';
export {
  AUTHOR_MAX,
  CHAR_LIMIT_MAX,
  METADATA_PATCH_KEYS,
  PROJECT_TITLE_MAX,
  RECIPE_NAME_MAX,
  SCENE_NUMBER_OPTIONS,
  VOCABULARY_NAME_MAX,
  normalizeIsbn,
} from './descriptors-project.js';
export type {
  ProjectImportAssetParams,
  SkillDeleteParams,
  SkillImportParams,
  SkillSetEnabledParams,
  SkillWriteParams,
  ValidationSkillFile,
  ProjectRenameParams,
  ProjectSetMetadataParams,
  RecipeDeleteParams,
  RecipeOptionsParams,
  RecipeSaveParams,
  SceneNumbersOption,
  VocabularyKind,
  VocabularyRemoveParams,
  VocabularyUpsertParams,
} from './command.js';
export type { AgentRisk, HardDenyClass, PermissionContext, PermissionGrant, PermissionVia } from './permission.js';
export {
  HARD_DENIED,
  HARD_DENY_CLASSES,
  checkPermission,
  hardDenyClass,
} from './permission.js';
export type { ResolvedRegistration } from './registry.js';
export {
  COMMAND_REGISTRY,
  buildRegistry,
  isCommandName,
  lookupCommand,
  lookupIn,
  registeredNames,
  resolveCommand,
  resolveIn,
} from './registry.js';
export type { BusContext, ExecutionOutcome } from './pipeline.js';
export { ApplyRefusal, execute, executeAsync } from './pipeline.js';
export type { IdempotencyCache } from './idempotency.js';
export { createIdempotencyCache } from './idempotency.js';
export type { SettledUndoScope, UndoDispatch, UndoEntry, UndoGroup, UndoGroupKind, UndoOutcome, UndoStore, UndoStoreOptions, UndoTarget } from './undo.js';
export { applyContext, createUndoScope, createUndoStore } from './undo.js';
export {
  createViewState,
  isViewState,
  viewSetActiveDocApply,
  viewSetCorkboardScopeApply,
  viewSetExpandedApply,
  viewSetScrollApply,
  viewSetSelectionApply,
} from './view.js';
export { DECLARED_PARAMS, VARIOUS_PARAM_NAMES } from './params.js';
export { HINT_READ_TREE } from './params.js';
// The saved-filter and project-goal params, named by the store and the harness's tool descriptors.
export type {
  BinderDeleteFilterParams,
  BinderSaveFilterParams,
  FurnitureRoot,
  GoalComparatorParam,
  GoalKindParam,
  GoalMetricParam,
  GoalResetDayParam,
  ProjectDeleteGoalParams,
  ProjectGoalParams,
  ProjectSaveGoalParams,
  SavedFilterParams,
} from './descriptors-furniture.js';
// The criterion-key list the furniture commands refuse a key outside of. The store's loader reads the same list to drop an
// unknown criterion key from a saved filter on load (binder-filters §4), so the two halves never keep two records of it.
// The name limit is exported for the same reason: the loader drops a saved filter whose name the bus would refuse — and the
// rule itself, `filterNameFits`, so the loader counts a name exactly as the bus counts it.
export { CRITERIA_KEYS, FILTER_NAME_MAX, filterNameFits } from './descriptors-furniture.js';
// The limits and value lists the harness's filter and goal tools declare their params from, so a tool never keeps a copy.
export {
  FILTER_LIST_MAX,
  FILTER_TAG_MAX,
  FILTER_TEXT_MAX,
  GOAL_COMPARATORS,
  GOAL_KINDS,
  GOAL_METRICS,
  MONTHLY_RESET_MAX,
  SEARCH_SURFACES,
} from './descriptors-furniture.js';
// The coherence rules the bus and the store share (coherence.ts). The coherence module re-exports them.
export type {
  CoherenceStatusName,
  DismissalReasonName,
  ScenePatch,
  ScenePatchResult,
  SceneMetaContext,
  SceneMetaRecord,
  SceneThread,
  TimelineModeName,
} from './coherence.js';
export {
  COHERENCE_NOTE_LIMIT,
  COHERENCE_STATUSES,
  DISMISSAL_REASON_IDS,
  SCENE_PATCH_KEYS,
  THREAD_ID_LIMIT,
  THREAD_NOTE_LIMIT,
  TIMELINE_MODES,
  applySceneMetaPatch,
  coherenceNoteProblem,
  findingTransition,
  findingsDiscardedWith,
  inverseScenePatch,
  isEmptySceneMeta,
  trimCoherenceNote,
} from './coherence.js';
// The run discard's descriptor (descriptors-coherence.ts). The store imports it for its registry row.
export { coherenceDiscardRun } from './descriptors-coherence.js';
// The import and container-settings params and limits (descriptors-script.ts), named by the store, the desktop and
// the dialogue package's parity test.
export type {
  DialogueImportInkParams,
  DialogueMetaPatch,
  DialogueSetMetaParams,
  InkContainerParams,
  ScreenplayImportParams,
} from './descriptors-script.js';
export {
  DIALOGUE_ENGINE_TARGETS,
  DIALOGUE_IMPORT_CONTAINERS_MAX,
  DIALOGUE_IMPORT_TEXT_MAX,
  DIALOGUE_META_KEYS,
  SCREENPLAY_IMPORT_FORMATS,
  SCREENPLAY_IMPORT_TEXT_MAX,
} from './descriptors-script.js';
/**
 * codex.md §2's limits, shared with `@caotang/store`'s manifest validator rather
 * than retyped there — see `descriptors.ts` for why this is the only direction
 * the two packages can share one constant in.
 */
export {
  CODEX_ALIAS_CHARS_MAX,
  CODEX_ALIASES_MAX,
  CODEX_DESCRIPTION_MAX,
  CODEX_EXCLUDE_CHARS_MAX,
  CODEX_EXCLUDE_MAX,
  CODEX_NAME_MAX,
  CODEX_SOURCES_MAX,
  CODEX_SOURCE_QUOTE_MAX,
  // video-prompt-pack.md §3: an entry's visual references, the most one entry carries. The harness's schema and the picker read it here.
  CODEX_VISUAL_REFS_MAX,
  KEYWORDS_MAX,
  KEYWORD_CHARS_MAX,
  NOTES_MAX,
  SYNOPSIS_MAX,
  EXPORT_FORMATS,
  // The chapter rule's sentence: the binder's drop refusal and the bus's create refusal say the same words.
  CHAPTERLESS_DOCUMENT_REFUSAL,
} from './descriptors.js';

// The shapes a tool package declares its tools with, so a media module needs no import of the harness
// (which imports it). The harness re-exports each of them (schema.ts, errors.ts, types.ts).
export { param, toJsonSchema } from './tool-schema.js';
export type {
  ArraySpec,
  BooleanSpec,
  EnumSpec,
  FreeObjectSpec,
  IntegerSpec,
  JsonSchema,
  ObjectSpec,
  ParamSpec,
  StringSpec,
  TaggedSpec,
  UnionSpec,
} from './tool-schema.js';
export { refusal, type RefusalOptions } from './refusal.js';
export type { ToolValue } from './tool-value.js';
// The name a project with no recipes key holds (exporter.md §4). The exporter names its default recipe with it.
export { DEFAULT_RECIPE_NAME } from './recipe-names.js';
