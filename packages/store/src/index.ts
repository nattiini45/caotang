export {
  APP_ID,
  FORMAT_VERSION,
  FIXED_ROOT_IDS,
  type Manifest,
  type ProjectIdentity,
  type TreeNode,
  type NodeType,
  type VocabularyTerm,
  type Derived,
  type CodexEntry,
  type CodexIncludePolicy,
  type CodexSource,
  type SavedFilter,
  type ProjectGoal,
} from './manifest.js';
export {
  FIRST_FORMAT_VERSION,
  MIGRATIONS,
  MigrationError,
  PRODUCTION_FORMAT,
  asManifest,
  migrateToCurrent,
  readFormatVersion,
  runMigrations,
  type AppliedMigration,
  type FormatContext,
  type Migration,
  type MigrationRegistry,
  type MigrationResult,
} from './migrations.js';

export { validateManifest, type ValidationReport, type ValidationError, type ValidateOptions } from './validate.js';
/**
 * codex.md §2's enum membership and its three load-time coercions, exported
 * because they are the single implementation both the manifest validator and the
 * redundancy-file codec call — a caller that needs to know
 * what §2 considers a legal value reads it here rather than retyping the list.
 */
export {
  CODEX_INCLUDE_POLICIES,
  CODEX_ORIGINS,
  CODEX_TYPES,
  coerceIncludePolicy,
  coerceOrigin,
  coerceType,
  type CodexCoercion,
  type CodexOrigin,
} from './codex-fields.js';
export { createEmptyManifest, isFixedRoot, nextSiblingOrder } from './create.js';

export {
  ArtifactNotFoundError,
  MemoryArtifactFs,
  dirName,
  joinPath,
  type ArtifactFs,
} from './artifact-fs.js';

export {
  CODEX_DIR,
  DOCS_DIR,
  EXPORTS_DIR,
  FOUNTAIN_BODY_EXT,
  GITIGNORE_FILE,
  INK_BODY_EXT,
  LEGACY_SNAPSHOT_FILE,
  MANIFEST_FILE,
  PROSE_BODY_EXT,
  SESSIONS_FILE,
  SNAPSHOT_COUNT,
  bodyExtOf,
  bodyExtensionOf,
  bodyFile,
  bodyFileName,
  bodyNamesOf,
  bodyStemOf,
  corruptManifestFile,
  docFile,
  isBodyFileName,
  isBodyType,
  snapshotFile,
} from './paths.js';
export { createBinderNode, type MediaCreateParams } from './commands-media.js';

export {
  FrontMatterError,
  emitFlowSequence,
  emitScalar,
  formatFrontMatter,
  parseFrontMatter,
  parseFrontMatterFields,
  type DocumentFrontMatter,
  type FrontMatterField,
} from './frontmatter.js';

export { parseDocumentFile, serializeDocumentFile, type ParsedDocument, type SerializeDocumentOptions } from './document-file.js';
export {
  codexFile,
  formatCodexFrontMatter,
  parseCodexFile,
  serializeCodexFile,
  type CodexFrontMatter,
  type ParsedCodexFile,
  type SerializeCodexOptions,
} from './codex-file.js';
export { serializeManifest } from './manifest-json.js';

export {
  SessionsShrinkError,
  assertSessionRecord,
  createSessionTracker,
  isSessionRecord,
  parseSessionsLog,
  sameSessionLine,
  serializeSessionRecord,
  serializeSessionsLog,
  writeSessionsFile,
  type ParsedSessionsLog,
  type SerializeSessionsOptions,
  type SessionAppender,
  type SessionProgress,
  type SessionRecord,
  type SessionTracker,
  type SessionTrackerOptions,
  type SessionWrite,
  type WriteSessionsOptions,
  type WriteSessionsReport,
} from './sessions.js';

export {
  addDocument,
  addFolder,
  addNode,
  type AddNodeOptions,
  createProjectState,
  documentIds,
  getBody,
  getRevision,
  moveNode,
  nodeById,
  rebuildDerived,
  renormalizeSiblings,
  removeNode,
  type RemovedNode,
  setBody,
  siblingIndex,
  siblingOrderAt,
  RENORMALIZE_THRESHOLD,
  cloneProjectState,
  type AddDocumentOptions,
  type CreateStateOptions,
  type DocumentRecord,
  type ProjectState,
} from './state.js';

export { emptyCoherenceState, type CoherenceFindingState, type CoherenceRunState, type CoherenceState } from './coherence-state.js';
export { checkWordsOf, dismissalLabelOf } from './coherence-words.js';

export { countBody, type BodyCount } from './word-count.js';

export {
  createProjectCommandRegistry,
  systemCommandClock,
  synchronousSnapshotSink,
  type BodySnapshot,
  type CommandClock,
  type ExportCommandDigest,
  type ExportCommandOutcome,
  type ExportCommandPort,
  type McpInvokeCommandPort,
  type ShotCommandPort,
  type ShotCommandReport,
  type ExportCommandRequest,
  type ProjectCommandOptions,
  type SnapshotSink,
} from './commands.js';

export {
  FolderDriftError,
  writeProject,
  type WriteOptions,
  type WriteReport,
} from './write.js';

export {
  changesInWords,
  isTransientFileError,
  joinWords,
  digestOfBytes,
  digestOfFile,
  digestsAfterWrite,
  driftOf,
  hasDrift,
  isProjectFile,
  projectFileChanges,
  projectFileDigests,
  projectFileLabel,
  projectFilePaths,
  projectFileTitles,
  type DigestReader,
  type FolderDrift,
  type ProjectFileChange,
} from './folder-digests.js';

export {
  KNOWN_NODE_KEYS,
  ManifestUnreadableError,
  ProjectRefusedError,
  ProjectValidationError,
  RECOVERED_TITLE,
  importOrphanCodex,
  importOrphanDocuments,
  readProject,
  recoveredFolder,
  type LoadNotice,
  type LoadResult,
  type ReadOptions,
} from './read.js';

export {
  decodeAs,
  decodeForPreview,
  decodeStrict,
  detectEncoding,
  ENCODING_CANDIDATES,
  encodingName,
  guessEncoding,
  type CandidateEncoding,
  type DecodableEncoding,
  type DecodedEncoding,
  type DecodedPreview,
  type EncodingDetection,
  type EncodingGuess,
  type EncodingIssue,
  type EncodingIssueKind,
  type ScoredEncodingCandidate,
} from './encoding.js';

export {
  commitRecovery,
  recoverProject,
  type RecoverOptions,
  type RecoveryCommit,
  type RecoveryOffer,
  type RecoveryResult,
  type RecoverySource,
} from './recovery.js';

export { MemoryIndexedDb } from './runtime/memory-idb.js';

export {
  BUNDLE_EXTENSION,
  MissingManifestError,
  NestedManifestError,
  UnsafeZipEntryError,
  ZIP_ENGINE,
  buildToc,
  bundleFilename,
  bundleStem,
  exportProjectZip,
  importProjectZip,
  isRecoverySnapshot,
  type ExportZipOptions,
  type ExportZipResult,
  type ImportZipResult,
} from './zip.js';

export {
  AUTOSAVE_DEBOUNCE_MS,
  createAutosave,
  domFlushSignals,
  systemClock,
  type Autosave,
  type AutosaveClock,
  type AutosaveEvent,
  type AutosaveOptions,
  type AutosaveState,
  type AutosaveStatus,
  type DocumentWriteRequest,
  type DocumentWriter,
  type FlushOutcome,
  type FlushReport,
  type FlushSignalSource,
  type FlushSignalTargets,
} from './runtime/autosave.js';

export {
  DOCUMENT_PROJECT_INDEX,
  DOCUMENT_STORE,
  PROJECT_STORE,
  RUNTIME_DB_NAME,
  RUNTIME_DB_VERSION,
  SESSION_PROJECT_INDEX,
  SESSION_STORE,
  SNAPSHOT_PROJECT_INDEX,
  SNAPSHOT_STORE,
  DocumentExistsError,
  ProjectNotFoundError,
  RevisionConflictError,
  RuntimeStoreNewerError,
  RuntimeStoreStaleError,
  SnapshotExistsError,
  appendSession,
  requireLiveConnection,
  commitProject,
  deleteProject,
  listProjectIds,
  openRuntimeStore,
  readBodySnapshots,
  readCoherenceFiles,
  readProjectState,
  readSessions,
  writeBodySnapshot,
  writeCoherenceFiles,
  writeDocumentBody,
  writeProjectState,
  type DocumentRow,
  type ProjectCommit,
  type ProjectRow,
  type RuntimeStore,
  type SessionRow,
  type SnapshotRow,
  type WriteDocumentOptions,
  type WriteDocumentResult,
  type WriteProjectStateResult,
} from './runtime/store.js';

export {
  DEFAULT_RETENTION,
  InvalidRetentionConfigError,
  evictSnapshots,
  planSnapshotEviction,
  resolveRetentionConfig,
  snapshotBudget,
  snapshotKey,
  type EvictionPlan,
  type RetentionConfig,
  type SnapshotBudget,
} from './runtime/retention.js';

// Project export: the project block's identity (epub-metadata.md), the cover import and its staging, the recipe
// options, and the zip engine loader the desktop uses to bundle a multi-file export.
export {
  BACKFILLABLE_FIELDS,
  IDENTIFIER_PREFIX,
  appLocale,
  backfillProjectIdentity,
  defaultLanguage,
  identifierUrn,
  languageSubtag,
  mintIdentifier,
  type BackfillOptions,
  type UuidSource,
} from './project-identity.js';
export { DEFAULT_RECIPE_NAME } from './create.js';
export {
  COVER_MAX_BYTES,
  createAssetStaging,
  projectCommandRegistrations,
  sniffCoverImage,
  type ApplyClock,
  type AssetStaging,
  type CoverImageKind,
  type ProjectAssetPort,
} from './commands-project.js';
export { loadZipEngine } from './zip.js';
export type { ExportRecipe, ExportRecipeOptions } from './manifest.js';

// Storyboard: the browser's copy of the project's images, in its own IndexedDB database (storyboard.md §2.2).
export {
  ASSET_DB_NAME,
  ASSET_DB_VERSION,
  ASSET_PROJECT_INDEX,
  ASSET_STORE,
  deleteProjectAssets,
  getAssetBytes,
  listAssetPaths,
  openAssetStore,
  putAssetBytes,
  type AssetRow,
  type AssetStore,
} from './runtime/asset-store.js';
export { shotImageCommandRegistrations } from './commands-shot-image.js';
