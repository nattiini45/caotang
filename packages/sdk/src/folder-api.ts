/**
 * `@caotang/sdk/folder` — the Node folder session the MCP server and the SDK share. It is not the SDK's public surface (that is
 * `openProject`, in the package root): it is the seam through which `@caotang/mcp-server` reuses the lock, the folder-drift checks and
 * the write queue, so the two hosts cannot disagree about when a folder may be written.
 */

export { ArtifactPathError, NodeArtifactFs, byteArtifactsOver, resolveWithin } from './node-fs.js';
export { LOCK_FILE, LOCK_TAKEOVER_FILE, ProjectLockedError, acquireProjectLock, type ProjectLock, type LockRefusal } from './lock.js';
export { mergeServerDelta } from './coherence-file.js';
export {
  coherenceFileOf,
  scopeNodeOf,
  timelineCsvOf,
  timelineModelOf,
  type TimelineReadOptions,
} from './timeline.js';
export {
  FolderChangedError,
  NoProjectError,
  isCodexFileName,
  isDocumentFileName,
  manifestOnDisk,
  manifestTextAt,
  openFolder,
  type OpenFolder,
  type OpenFolderOptions,
} from './folder.js';
export {
  FIELD_WORDS,
  SCENE_FIELDS,
  declarationChanges,
  declarationClashes,
  declarationsWritten,
  entryNamesOf,
  movedSince,
  placesOf,
  readbackOf,
  titlesOf,
  type MoveReadback,
  type SceneClash,
  type SceneField,
  type SceneReadback,
  type TimelineApplied,
  type TimelineConflict,
  type TimelineFile,
  type TimelineReadback,
  type TimelineWriteResult,
  type TreePlace,
} from './timeline-persistence.js';
export {
  PictureReadError,
  linkSummaryOf,
  pictureListOf,
  pictureRegistryOf,
  pictureSummaryOf,
  readPictureFile,
  tooLargeMessage,
  type LinkPlacement,
  type LinkSummary,
  type ListedPicture,
  type PictureFile,
  type PictureListQuery,
  type PictureReadCode,
  type PictureRegistry,
  type PictureSummary,
  type PictureUseSummary,
  type ReadPictureOptions,
} from './pictures.js';
export { MCP_VOICE, type FolderVoice } from './voice.js';
