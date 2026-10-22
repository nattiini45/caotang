/**
 * `@caotang/harness` — the agent tool registry (agent-harness.md §3), dispatched
 * through the command bus with the permission gate and the activity log applied.
 *
 * What this package is, and what it is not, in one paragraph: it is the tool
 * surface. It declares the frozen fourteen and the extension rows (`doc.import`, `codex.import`, the coherence
 * module's three tools, the Tier-2 gateway `tool.search`, and the storyboard and prompt-pack modules' tools),
 * validates every call against a closed-set schema, prepares each call's
 * commands through the bus's own `validate`, and runs them through `execute()`. A bare harness refuses its
 * four v0.1 port tools (`codex.read`, `scene.draft`, `synopsis.fill`, `continuity.scan`) as not wired.
 * `createAgentPorts()` supplies their implementations, and `createAgentSession()` is the loop on top: the
 * model, the cards, the verify ladder and the report. The coherence engine answers `coherence.scan` and
 * `coherence.setFindingStatus` by default, and `coherence.review` is its default async port (`callAsync`), wired once the
 * app gives a model source. External tools (`mcp.invoke`) are called through `callExternal`, which is asynchronous, and are
 * reachable only once an MCP client is given. README.md has the wire protocol and the module map.
 */

export {
  TOOL_METADATA,
  TOOL_NAMES,
  capOf,
  isToolName,
  metadataFor,
  type ToolLoad,
  type ToolMetadata,
  type ToolName,
  type ToolRisk,
} from './metadata.js';
export { createHarness, type ExternalHarness, type Harness, type HarnessOptions, type ToolListing } from './runtime.js';
export {
  askBackFor,
  parsePlan,
  planParams,
  preflight,
  runPlan,
  type AskBack,
  type AskBackCode,
  type Plan,
  type PlanOutcome,
  type PlanPreflight,
  type PlanStep,
  type PlanOptions,
  type PlanStepPreflight,
  type StepResult,
} from './plan.js';
export {
  createAgentSession,
  type AgentSession,
  type AgentSessionOptions,
  type SteerReceipt,
  type SubmitOptions,
  type TurnOptions,
} from './agent/loop.js';
export { PRELOAD_BY_CONTEXT, preloadContextOf, preloadFor, type PreloadContext } from './agent/preload.js';
export {
  checkRun,
  evaluate,
  matchCards,
  matchTrace,
  runScenario,
  taskListFailures,
  type CallExpect,
  type CardExpect,
  type Evaluation,
  type Expectation,
  type Matcher,
  type RequestExpect,
  type Scenario,
  type ScenarioCategory,
  type ScenarioDecision,
  type ScenarioRun,
  type WriterAction,
  type WriterMoment,
} from './agent/eval.js';
export { createAgentPorts, previewFor, codexReadPort, sceneDraftPort, synopsisFillPort, continuityScanPort } from './agent/ports.js';
export {
  createContextPort,
  dropLinesOf,
  mergePreviews,
  withRole,
  type AssembledCall,
  type ContextPort,
  type ContextPortOptions,
  type ContextRequest,
} from './agent/context.js';
// The Context section's preview: the prompt a scene draft would send, assembled as the loop assembles it (context-assembly §5).
export { scenePromptPreview, type ScenePreviewOptions } from './agent/step-preview.js';
// The plan card renders a step's prompt preview; the app reads its shape from here, not from @caotang/context.
export type { ContextConfig, PreviewLayer, PromptPreview } from '@caotang/context';
export {
  MODEL_BACKED_TOOLS,
  RESOLVE_BADGE,
  advance,
  applyEdit,
  canAdvance,
  dependencyBadges,
  groupCards,
  planCardOf,
  reviewCostAt,
  reviewCostOf,
  stagedOf,
  type CardItem,
  type EditableSteps,
  type PlanCardView,
  type PlanEdit,
  type PlanStepView,
  type ReviewLimitsSource,
  type StagedView,
  type StatusCard,
  type StatusState,
  type StepCost,
} from './agent/cards.js';
// The turn's task list (agent-harness §8): derived from the events, shown in the agent header and at the top of the turn.
export {
  TASK_PHRASES,
  budgetLevelOf,
  emptyTaskList,
  firstSentence,
  headerLineOf,
  phraseFor,
  reduceTaskList,
  type NameOf,
  type TaskItem,
  type TaskList,
  type TaskPhrase,
  type TaskPhraseFn,
  type TaskState,
} from './agent/progress.js';
export {
  CHECKPOINT_LABEL,
  DEFAULT_MAX_MODEL_CALLS,
  EXTERNAL_CHECKPOINT_NOTE,
  type AgentEvent,
  type CardRecord,
  type Decision,
  type PendingCard,
  type SteeringNote,
  type StepRecord,
  type TraceEntry,
  type TurnPhase,
  type TurnReport,
  type TurnStatus,
  type TurnStop,
} from './agent/events.js';
export {
  DRAFT_SYSTEM_PREFIX,
  PLANNER_SYSTEM_PREFIX,
  REPLY_SCHEMA_HINT,
  parseReply,
  plannerSystem,
  plannerSystemNative,
  plannerToolDefs,
  plannerTools,
  refusalSentence,
  MORE_TOOLS_LINE,
  type Reply,
} from './agent/protocol.js';
export {
  draftScene,
  fillSynopses,
  GenerationStopped,
  TurnStopped,
  scanContinuity,
  type Finding,
  type FindingsProposal,
  type ModelCall,
  type SceneProposal,
  type Spend,
  type SynopsisProposal,
} from './agent/drafting.js';
export { param, toJsonSchema, type JsonSchema, type ParamSpec } from './schema.js';
export { checkParams, checkValue } from './validate.js';
export {
  annotationsFor,
  describeForExposure,
  mcpExposure,
  type ExposureInput,
  type ExposureRisk,
  type McpAnnotations,
  type McpExposure,
} from './mcp.js';
export {
  type ActivitySource,
  type AsyncToolPort,
  type CallParams,
  type PortContext,
  type PortToolName,
  type SessionSnapshot,
  type ToolCall,
  type ToolOutcome,
  type ToolPort,
  type ToolValue,
  type TurnContext,
} from './types.js';
export { CHARS_PER_TOKEN, estimateTokens, fitsCap } from './tokens.js';
export { refusal, notWired } from './errors.js';
export { coherenceAsyncPorts, coherencePorts, stageReviewPlan, type CoherenceSource } from './tools/coherence.js';
export { codexImportParams, prepareCodexImport } from './tools/codex-import.js';
