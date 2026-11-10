/**
 * `@caotang/gateway` — the only module that talks to a model endpoint
 * ([provider-gateway.md](docs/architecture/provider-gateway.md)).
 *
 * The mock provider is deliberately not exported from here. It is a test fixture, and
 * production code that imports it by accident would ship it. Import it from `./mock`.
 */

export type {
  ProviderProfile,
  ProfileKind,
  LegacyProfileKind,
  ProfileView,
  NewProfile,
  ProfilePatch,
  ResponseFormatProbe,
  ProviderGateway,
  ChatRequest,
  ChatMessage,
  MessageContent,
  ContentPart,
  TextPart,
  ImagePart,
  ImageMime,
  CachePart,
  CachePolicy,
  ChatChunk,
  ChatRole,
  FinishReason,
  ThinkingLevel,
  TaskRole,
  ToolDef,
  ToolCall,
  ReasoningBlock,
  ModelCaps,
  RequestParams,
  Usage,
  TokenPrice,
  ModelInfo,
  ModelLimits,
  ModelLimitsRequest,
  UsageAttribution,
} from './types.js';

export {
  IMAGE_MIMES,
  base64Of,
  checkRequestImages,
  contentSummaryOf,
  contentTokens,
  dataUrlOf,
  imageBase64Of,
  imageDimensions,
  imageLimitsFor,
  imagePartsOf,
  imageTokens,
  isContentParts,
  partsOf,
  placeholderOf,
  sniffMime,
  textOf,
  validateMessageContent,
  validatePart,
  type ContentRoute,
  type ContentSummary,
  type ImageSummary,
  type RouteImageLimits,
} from './parts.js';

export {
  ProviderError,
  providerMessages,
  EgressDeniedError,
  ProfileError,
  type ProviderErrorKind,
  type ProviderErrorInit,
  type ProfileErrorCode,
} from './errors.js';

export {
  createProfileStore,
  PROFILE_ID_PATTERN,
  MOCK_DEFAULT_MODEL,
  DEFAULT_MAX_OUTPUT_TOKENS,
  mintProfileId,
  type ProfileStore,
  type ProfileStoreOptions,
} from './profiles.js';
export { normalizeBaseUrl, normalizeLocalBaseUrl, MOCK_BASE_URL, isLoopbackBase, isLocalBase } from './base-url.js';
export { isLoopbackHost, isLoopbackLiteral } from './loopback.js';

export {
  PRESETS,
  presetFor,
  presetForProfile,
  modelRowFor,
  resolveRoute,
  withParams,
  type PresetDef,
  type PresetField,
  type ModelRow,
  type CorsStatus,
  type LocalServer,
} from './presets/index.js';

export {
  createKeyStore,
  type KeyStore,
  type KeyPayload,
  type KeyStoreOptions,
} from './keys/key-store.js';
export { createMemoryVaultPort, type KeyVaultPort, type SealedEntry } from './keys/vault.js';
export { createIndexedDbVaultPort, type IndexedDbVaultOptions } from './keys/indexeddb-vault.js';

export { createGateway, type Gateway, type GatewayOptions, type GatewayTraceEvent } from './gateway.js';
export type { FetchLike } from './transport.js';
export { adapterFor } from './adapters/index.js';
export { fnv1a64 } from './adapters/cache.js';
export { effectiveOutput, effortWireValue, levelForBudget, nominalThinkingTokens, type EffectiveOutput } from './adapters/effort.js';
export type {
  AdapterId,
  AdapterContext,
  BodyInput,
  CallSecrets,
  EffortStyle,
  ProviderAdapter,
  QuirkFlags,
  ReplayStyle,
  RouteSpec,
  StreamParser,
  StreamPiece,
} from './adapters/types.js';

export {
  UsageLedger,
  localDayKey,
  USAGE_LEDGER_VERSION,
  costOf,
  sumUsage,
  type DayUsageRow,
  type TurnUsageRow,
  type UsageTotals,
  type UsageSnapshot,
} from './ledger.js';
export {
  WIRE_TOOL_NAME,
  wireToolName,
  toolNameCodec,
  toolNamesOf,
  encodeToolNames,
  decodingParser,
  type ToolNameCodec,
} from './tool-names.js';
export { RequestLog, REQUEST_LOG_CAP, type RequestLogEntry, type RequestOutcome } from './request-log.js';

export {
  DEFAULT_RETRY,
  DEFAULT_TIMEOUTS,
  backoffMs,
  isRetryable,
  parseRetryAfter,
  type RetryPolicy,
  type TransportTimeouts,
} from './retry.js';

export { systemClock, createManualClock, type Clock, type ManualClock, type TimerId } from './clock.js';
export { redact, redactDeep } from './redact.js';
export { estimateTokens, usageFor, promptTokensOf } from './tokens.js';
