/**
 * `@caotang/mcp-client` — the v0.2 MCP client ([extensibility.md](../../../docs/architecture/extensibility.md)).
 *
 * What this package is: the settings slice for external servers, the client that connects to them
 * over Streamable HTTP and pins what they advertise, `tool.search` (the Tier-2 search-then-load
 * tool), `mcp.invoke` (the bus command every external call rides), the egress allowlist, and the
 * approval card's data. What it is not: the bus registration (that is done at integration, from
 * what is exported here), the settings UI, the vault that holds bearer tokens, and the harness
 * registry row for `tool.search` (the harness derives its schema at registration).
 *
 * Nothing here runs without a configured server, and nothing connects on its own: a server is an
 * explicit user action (extensibility §4 rule 1), and the agent cannot connect, install or
 * configure one (§4 rule 7).
 */

export {
  canonicalJson,
  pinHash,
  sha256Hex,
  subjectHash,
  type PinSubject,
  type PinnedPromptArgument,
} from './canonical.js';

export { CATALOG_LIMIT } from './catalog.js';

export {
  EMPTY_MCP_SETTINGS,
  MCP_KEY_PATTERN,
  MCP_NAME_MAX,
  MCP_SERVER_LIMIT,
  MCP_TOKEN_REF_MAX,
  MCP_TOOL_NAME_MAX,
  checkServerUrl,
  toolNameList,
  clampServers,
  exportServers,
  isLoopbackHost,
  loadMcpSettings,
  newServerKey,
  parseServerImport,
  type ImportRefusal,
  type ImportResult,
  type McpAuth,
  type McpServerConfig,
  type McpSettings,
  type McpSettingsLoad,
  type ToolPin,
  type UrlCheck,
} from './config.js';

export {
  McpFailure,
  PIN_MISMATCH_TEXT,
  inputRequiredText,
  notFoundText,
  readErrorText,
  schemaText,
  cancelledText,
  serverErrorText,
  timeoutText,
  toCommandError,
  totalTimeoutText,
  unreachableText,
  unsupportedSchemaText,
  type McpError,
  type McpErrorCode,
} from './errors.js';

export {
  CALL_MAX_TOTAL_MS,
  CALL_TIMEOUT_MS,
  CORS_REFUSAL,
  LIST_TIMEOUT_MS,
  REVISION_REFUSAL,
  createMcpClient,
  createMcpTransport,
  qualifiedNameOf,
  type AddServerInput,
  type CatalogStatus,
  type ExternalPromptDescriptor,
  type ExternalResourceDescriptor,
  type ExternalToolDescriptor,
  type HealthState,
  type IndexedTools,
  type McpClient,
  type McpClientOptions,
  type McpServerHealth,
  type McpToolResult,
  type McpCallOptions,
  type McpTransport,
  type ReviewCard,
  type ReviewPrompt,
  type ReviewTemplate,
  type ReviewTool,
  type UpdateServerPatch,
} from './client.js';

export {
  CLIENT_NAME,
  CLIENT_VERSION,
  MODERN_REVISION,
  WireError,
  WireLoadError,
  corsProbe,
  type WireErrorKind,
} from './wire-error.js';

export { PROGRESS_MESSAGE_CAP, cleanProgress, cleanProgressMessage, type WireProgress } from './progress.js';

// Only types come from wire.ts: it holds the MCP SDK, which `lazy-wire.ts` loads on first connect.
export type {
  McpWire,
  WireAnnotations,
  WireCallResult,
  WireCapabilities,
  WireCompletionRef,
  WireDeps,
  WireFactory,
  WireOptions,
  WirePrompt,
  WirePromptArgument,
  WirePromptResult,
  WireResource,
  WireResourceContents,
  WireResourceListing,
  WireResourceTemplate,
  WireTool,
} from './wire.js';

export { createStreamableHttpWire } from './lazy-wire.js';

export {
  EXCERPT_CHARS,
  QUERY_MAX,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  TOOL_SEARCH_ENTRY,
  TOOL_SEARCH_META,
  TOOL_SEARCH_NAME,
  TOOL_SEARCH_PARAMS,
  TOOL_SEARCH_RESULT,
  createLoadedTools,
  loadedAddendum,
  riskBadge,
  toolSearch,
  type ExtensionToolMeta,
  type LoadedTool,
  type LoadedTools,
  type NativeIndexRow,
  type SearchMatch,
  type SearchSource,
  type ToolParamSpec,
  type ToolParamsObject,
  type ToolSearchContext,
  type ToolSearchEntry,
  type ToolSearchValue,
} from './search.js';

// The excerpt clip is shared with the harness's planner protocol, so the model-facing excerpt of an
// external tool's description is one rule with one implementation.
export { clipChars } from './util.js';

export {
  EXTERNAL_RESULT_TOKEN_CAP,
  MCP_INVOKE_NAME,
  McpInvokeFailure,
  applyMcpInvoke,
  mcpInvokeRegistration,
  prepareInvoke,
  resultTokens,
  type InvokeDeps,
  type McpInvokeNormalized,
  type McpInvokeOutcome,
  type McpInvokeParams,
  type McpInvokeRegistration,
  type UntrustedCallResult,
  type ValidateDeps,
} from './invoke.js';

export {
  MCP_READ_RESOURCE_NAME,
  McpReadResourceFailure,
  applyMcpReadResource,
  mcpReadResourceRegistration,
  prepareReadResource,
  templateUnreviewedText,
  type McpReadResourceNormalized,
  type McpReadResourceOutcome,
  type McpReadResourceParams,
  type McpReadResourceRegistration,
  type ReadResourceDeps,
  type ReadResourceValidateDeps,
  type UntrustedResource,
} from './read-resource.js';

export { agentRiskOf, effectiveRiskOf, type EffectiveRisk, type RiskInputs } from './risk.js';

export {
  diffPins,
  hasDelta,
  listingFingerprint,
  pinStateOf,
  pinsAfterReview,
  type ListedPin,
  type PinDelta,
  type PinState,
} from './pins.js';

export {
  WORK_BUDGET,
  describeFailure,
  validateArguments,
  type SchemaFailure,
  type SchemaVerdict,
} from './schema.js';

export { egressAllowed, egressAllowlistFor, type EgressAllowlist } from './egress.js';

export {
  APPROVAL_NOTICE,
  approvalCardFor,
  cautionOf,
  type ApprovalCard,
  type ApprovalCaution,
  type ApprovalContext,
  type CardHit,
  type QuoteFinding,
  type TaintRef,
} from './approval.js';

export { createMockWire, createMockWireFactory, type MockCall, type MockMcpScript, type MockPhase } from './mock.js';
