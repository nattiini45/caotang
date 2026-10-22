/**
 * `@caotang/mcp-server` — Caotang as an MCP server (extensibility.md §9): the harness
 * registry over Streamable HTTP on 127.0.0.1 or over stdio, read-only unless the
 * project is opened for external writes, with write-confirm across the boundary.
 *
 * The bundle `dist/caotang-mcp.mjs` is built from `bin.ts`. The exports here are the
 * pieces a test or a host embedding the server needs.
 */

export { VERSION, MCP_PATH } from './version.js';
// The Node folder session moved to the SDK (`@caotang/sdk/folder`); these re-exports keep the names a host embedding the server imports.
export {
  ArtifactPathError,
  FolderChangedError,
  LOCK_FILE,
  LOCK_TAKEOVER_FILE,
  NoProjectError,
  NodeArtifactFs,
  ProjectLockedError,
  acquireProjectLock,
  byteArtifactsOver,
  resolveWithin,
  type ProjectLock,
} from '@caotang/sdk/folder';
export {
  ProjectContentError,
  externalTurn,
  openProject,
  type OpenProjectOptions,
  type ProjectSession,
} from './session.js';
export { sourceWindow, type CallerSource, type SourceWindow } from './attribution.js';
export {
  CONFIRMATION_SCHEMA,
  CONFIRM_KEY,
  ROUND_TTL_SECONDS,
  argsDigest,
  codexEntryNameOf,
  confirmationMessage,
  confirmationSummary,
  createConfirmLedger,
  createRoundCodec,
  stableJson,
  type ConfirmLedger,
  type RoundState,
} from './confirm.js';
export { guardBatch, guardMessage, hardDeniedError, refusalResponse, type GuardPolicy, type RefusalResponse } from './guard.js';
export { advertisedSchema, registerCaotangTools, toCallResult, type ToolRuntime } from './tools.js';
export {
  LEGACY_ROUND_TIMEOUT_MS,
  MAX_BODY_BYTES,
  buildMcpServer,
  createToolRuntime,
  startHttpServer,
  startStdioServer,
  type HttpServerOptions,
  type McpServerOptions,
  type RunningHttpServer,
} from './server.js';
export { LEGACY_SESSION_IDLE_MS, LEGACY_SESSION_LIMIT, LegacySessions, type LegacySessionOptions } from './legacy-sessions.js';
export { DEFAULT_TOKEN_ENV, TOKEN_MIN_LENGTH, bearerAccepted, mintToken, resolveToken, type ResolvedToken } from './auth.js';
export {
  DEFAULT_PORT,
  UsageError,
  USAGE,
  parseServeArgs,
  runCli,
  startupLines,
  type RunIo,
  type ServeOptions,
} from './cli.js';
