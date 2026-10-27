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
export { createHarness, type ExternalHarness, type Harness, type HarnessOptions, type RuleCheck, type ToolListing } from './runtime.js';
export {
  NO_RULES,
  evaluateRules,
  globMatches,
  ruleRefusal,
  ruleWarnings,
  scopeNodes,
  withheldAnywhere,
  withheldNodes,
  type CallFacts,
  type CallTargets,
  type PermissionRule,
  type RuleAccess,
  type RuleEffect,
  type RuleScope,
  type RuleSet,
  type RuleSource,
  type RuleVerdict,
  type RulesProvider,
  type SourcedRule,
} from './rules.js';
export { TOOL_TARGETS, type ToolTargets, type TargetsFn } from './targets.js';
export { createProductHarness, type ProductHarnessOptions } from './product.js';
// The coherence module's two ports the agent's scan and review read through, and the gateway as the review's model.
export { DIALOGUE_CONTAINER_TYPE, containersOf, dialogueFactsOf } from './coherence-facts.js';
// The Ink compiler loads on demand (dialogue ink-loader.ts); a Node host awaits this before it opens a project, so every dialogue tool and check can compile.
export { loadInkCompiler } from '@caotang/dialogue';
export { gatewayCoherenceModel, reviewContextOf } from './coherence-review-context.js';
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
// Macros (extensibility.md §10): the checks that need the registry, and the expansion into a plan.
export {
  checkMacro,
  expandMacro,
  isMacroCommand,
  macroCommandName,
  macroFieldSpec,
  macroIntent,
  macroRisk,
  registryMacroTools,
  type MacroCheck,
  type MacroRegistry,
  type MacroRisk,
  type MacroTool,
} from './macro.js';
export {
  continuityTask,
  createAgentSession,
  sceneTask,
  synopsisInstruction,
  type AgentSession,
  type AgentSessionOptions,
  type ContextPreview,
  type OfferAnswer,
  type PlanOffer,
  type StageOnlyResult,
  type SteerReceipt,
  type SubmitOptions,
  type TurnOptions,
} from './agent/loop.js';
// Slash commands (agent-harness §2): the composer's line, read and resolved without a model.
export {
  BUILTIN_COMMAND_NAMES,
  expandTemplate,
  isCommandName,
  matchCommands,
  menuQuery,
  parseSlash,
  resolveSlash,
  usageOf,
  type BuiltinCommand,
  type BuiltinCommandName,
  type DocLookup,
  type DocResolver,
  type ParsedSlash,
  type SlashArgument,
  type SlashContext,
  type SlashResolution,
  type TemplatePlaceholders,
} from './commands/slash.js';
export { BUILTIN_COMMANDS } from './commands/builtins.js';
export { docResolverFor } from './commands/resolver.js';
// Permission modes (agent-harness §4): the four modes, the policy a mode is, and the budgets a turn is held to while a mode decides its cards.
export {
  ACCEPT_EDITS_TOOLS,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_TURN_BUDGET,
  EMPTY_BUDGET_USE,
  MODE_LABELS,
  ModeError,
  PERMISSION_MODES,
  addUse,
  budgetHit,
  budgetStop,
  callDigest,
  isPermissionMode,
  modePolicy,
  type BudgetDimension,
  type BudgetHit,
  type BudgetUse,
  type CardFacts,
  type ModePolicy,
  type ModePolicyOptions,
  type PermissionMode,
  type SessionBudget,
  type TurnBudget,
} from './agent/mode.js';
// Run limits (agent-harness §7.1): the meter that reserves each model call's worst case, and the time limits that abort a turn.
export {
  DEFAULT_ACTIVE_MS,
  anySignal,
  createBudgetMeter,
  runLimitWords,
  stepLimitWords,
  type BudgetMeter,
  type BudgetMeterOptions,
  type BudgetSpend,
  type BudgetStop,
  type Reservation,
  type RunLimits,
} from './agent/budget.js';
// Goal runs (agent-harness §7.2): the acceptance checks, the runner that works until they pass, and the write scope it keeps to.
export {
  checkKey,
  checkLabel,
  checkSpecProblem,
  coherenceScopeSize,
  documentsInScope,
  evaluateCheck,
  evaluateChecks,
  largeScopes,
  type CheckFailure,
  type CheckKind,
  type CheckOptions,
  type CheckResult,
  type CheckSpec,
} from './agent/checks.js';
export {
  DEFAULT_DOCS_PER_ITERATION,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_STALL_AFTER,
  HARD_MAX_ITERATIONS,
  REGRESSION_OPTIONS,
  createGoalRunner,
  goalProblem,
  goalRules,
  iterationIntent,
  restoreGoal,
  scopeBreaches,
  writableNodes,
  writeScopeRules,
  type Goal,
  type GoalOptions,
  type GoalRun,
  type GoalRunner,
  type GoalStatus,
  type IterationRecord,
  type Regression,
  type RegressionChoice,
  type RestoredTurn,
  type WriteScope,
} from './agent/goal.js';
// Background runs (agent-harness §2): the offer's threshold, what a plan costs in model calls, and which staged steps have gone stale.
export {
  BACKGROUND_OFFER_MIN_CALLS,
  backgroundEligibility,
  estimatedModelCalls,
  estimatedStepCalls,
  proposalShapeOk,
  revisionsOf,
  staleSteps,
  type BackgroundEligibility,
  type StepRevisions,
} from './agent/background.js';
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
  type GatewayHooks,
  type Matcher,
  type RequestExpect,
  type Scenario,
  type ScenarioCategory,
  type ScenarioDecision,
  type ScenarioRun,
  type WriterAction,
  type WriterMoment,
} from './agent/eval.js';
// Delegated agents (agent-harness §2, "Delegate"): the built-in specs, the runner, and the framing a result reaches the planner in.
export {
  DELEGATE_MAX_SCOPE,
  DELEGATE_NOTICE,
  GENERAL,
  READER,
  SUBAGENT_NAMES,
  SUBAGENT_SPECS,
  SUBAGENT_SYSTEM_PREFIX,
  SUMMARY_MAX_TOKENS,
  childTools,
  createSubagentRunner,
  framedResult,
  resultLine,
  subagentSpec,
  subagentSystem,
  type DelegateParams,
  type ParentTurnHandle,
  type SubagentHost,
  type SubagentName,
  type SubagentResult,
  type SubagentRunner,
  type SubagentSpec,
} from './agent/subagent.js';
export {
  BRIEF_CAP,
  BRIEF_TTL_MS,
  briefRefusal,
  createBriefLedger,
  createBriefPorts,
  type BriefKind,
  type BriefLedger,
  type BriefRecord,
} from './tools/briefs.js';
export { createAgentPorts, draftModeRefusal, previewFor, codexReadPort, sceneDraftPort, synopsisFillPort, continuityScanPort } from './agent/ports.js';
// The reads an MCP resource serves, whole, and the node lookups the server's prompts share with the tools (extensibility §9).
export { codexInOrder, readBody, readCodexEntry, readNotes, type BodyRead, type NotesRead } from './resource-reads.js';
export { ANY_NODE, CONTAINER, DOCUMENT, childrenOf, descendantsOf, resolveNode } from './resolve.js';
export { CONTINUITY_MAX_DOCS } from './tools/ports.js';
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
export { instructionsReport, scenePromptPreview, type InstructionsReport, type ScenePreviewOptions } from './agent/step-preview.js';
// The plan card renders a step's prompt preview; the app reads its shape from here, not from @caotang/context.
export { withheldState } from '@caotang/context';
export type { ContextConfig, PreviewLayer, PromptPreview } from '@caotang/context';
export { DEFAULT_INSTRUCTIONS_BUDGET } from '@caotang/context';
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
  type DelegationView,
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
  RESUMED_CHECKPOINT_NOTE,
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

// The run log (agent-harness §5.1): events written ahead of the work, the resume check, and an in-memory port.
export {
  NOT_LOGGED_NOTICE,
  RUN_LOG_VERSION,
  createMemoryRunLog,
  createRunWriter,
  newRunRecord,
  parseRunEvents,
  planResume,
  statusOfTurn,
  structureDigest,
  summarizeRun,
  type AppliedStep,
  type MemoryRunLog,
  type PendingStep,
  type ReplayCard,
  type ResumeVerdict,
  type ResumeView,
  type Revisions,
  type RunEvent,
  type RunEventDraft,
  type RunLogOptions,
  type RunLogPort,
  type RunRecord,
  type RunReplay,
  type RunSummary,
  type RunWriter,
} from './agent/run-log.js';

// The agent trace (agent-harness §5.2): the `caotang.trace/1` records, the in-tab store, the gateway's observer and the reader.
export {
  REQUIRED_FIELDS,
  TRACE_FORMAT,
  TRACE_MAX_BYTES,
  TRACE_MAX_TURNS,
  TRACE_RECORD_CAP,
  TRACE_REVIEWS,
  TRACE_VERSION,
  createTraceStore,
  omitMessage,
  omitRecord,
  parseTrace,
  traceGateway,
  type CardTraceRecord,
  type ContextRecord,
  type HeaderRecord,
  type LadderRecord,
  type MessageRecord,
  type ModelRequestRecord,
  type ModelResponseRecord,
  type Omitted,
  type Text as TraceText,
  type ToolCallRecord,
  type ToolResultRecord,
  type TraceExportOptions,
  type TraceInput,
  type TraceKind,
  type TraceMessage,
  type TraceRecord,
  type TraceSink,
  type TraceStore,
  type TraceStoreOptions,
  type TraceTurn,
  type TurnEndRecord,
  type TurnStartRecord,
} from './agent/trace.js';
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
  IDEMPOTENCY_KEY_META,
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
export { coherenceAsyncPorts, coherencePorts, excludedBy, stageReviewPlan, type CoherenceSource } from './tools/coherence.js';
export { codexImportParams, prepareCodexImport } from './tools/codex-import.js';
export { parsedSkillsOf, skillBlock, skillLabel, skillStatesOf, type LoadedSkill, type SkillsOption } from './tools/skills.js';
