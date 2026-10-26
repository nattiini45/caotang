/**
 * `@caotang/sdk/folder` — the Node folder session the MCP server and the SDK share. It is not the SDK's public surface (that is
 * `openProject`, in the package root): it is the seam through which `@caotang/mcp-server` reuses the lock, the folder-drift checks and
 * the write queue, so the two hosts cannot disagree about when a folder may be written.
 */

export { ArtifactPathError, NodeArtifactFs, byteArtifactsOver, resolveWithin } from './node-fs.js';
export { LOCK_FILE, LOCK_TAKEOVER_FILE, ProjectLockedError, acquireProjectLock, type ProjectLock, type LockRefusal } from './lock.js';
export { mergeServerDelta } from './coherence-file.js';
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
export { MCP_VOICE, type FolderVoice } from './voice.js';
// The dialogue module's facts for a coherence scan, so a host that reads a folder without the agent (`caotang scan`) runs the branch checks too.
export { dialogueFactsOf } from '@caotang/harness';
