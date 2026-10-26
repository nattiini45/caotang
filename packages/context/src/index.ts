/**
 * `@caotang/context` — context assembly for one model call: the eight layers in their fixed
 * order, their budgets and flow-up, the drop-reason taxonomy, the prompt preview, and the
 * execution payload. [context-assembly.md](../../../docs/architecture/context-assembly.md)
 * is the contract; this package is its implementation.
 *
 * What is not here: the agent loop (it calls `toChatMessages` and sends the result), the
 * tool registry (its one-line signatures arrive as `AppSnapshot.tools`), and the rendering
 * of the preview card (it reads `buildPreview`).
 */

export { assemble } from './assemble.js';
export { toChatMessages } from './messages.js';
export { buildPreview } from './preview.js';
export { describeDrop } from './drops.js';
export { SYSTEM_PROMPT_VERSION } from './layers/system.js';
export { FOCUS_MARKER } from './layers/focus.js';

export { entryWithheld, withhold, withheldState, type WithheldView } from './withheld.js';
export { ContextError, type ContextErrorCode } from './errors.js';

export {
  ANTECEDENT_CHARS,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_CONTINUATION_CHARS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  PREVIEW_CHARS,
  RESERVED_TOKENS,
  SCOPE_DOCUMENT_LIMIT,
  SCOPE_OVERHEAD_TOKENS,
  SCOPE_TAIL_CHARS,
  TURN_LIMIT,
  profileFor,
  type ToolProfile,
} from './profiles.js';

export { CHARS_PER_TOKEN, charsFor, estimateTokens, tokensForChars } from './tokens.js';
export { stableStringify } from './canonical.js';

export {
  LAYER_IDS,
  LAYER_NAMES,
  type AgentTask,
  type AppSnapshot,
  type AssembledPrompt,
  type AssemblyTool,
  type ContextConfig,
  type DraftMode,
  type DropReason,
  type DropRecord,
  type FocusReport,
  type LayerId,
  type LayerItemReport,
  type LayerReport,
  type ModelLimits,
  type PreviewDrop,
  type PreviewLayer,
  type PromptPreview,
  type RecentTurn,
  type SelectionSpan,
  type ToolSignature,
} from './types.js';
