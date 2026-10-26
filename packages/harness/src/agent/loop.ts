/**
 * The interaction loop — agent-harness.md §2, end to end, for one user intent.
 *
 * ```
 * intent → context (ContextPort) → model (gateway.complete) → reply (parseReply)
 *   ├─ a reply with no steps ............................ the answer, and the turn ends
 *   ├─ steps that are all reads ......................... run now, and their results go back to the model
 *   └─ steps with a write
 *        → draft what the model-backed steps need (drafting.ts), before anything is shown
 *        → preflight every step (harness.previewPlan); a refused step goes back to the model
 *        → one write-auto step runs at once; anything else is a card the user decides
 *             single write-confirm → a one-step confirm card
 *             several steps       → a plan card, editable until it is approved
 *        → approve: execute through the harness, under the approval the card carries
 *        → verify ladder (agent-harness §7): a refused step that changed nothing is adjusted by the
 *          model and shown again, twice at most; anything else is a structured ask-back, and nothing
 *          is undone automatically
 *   → the report: what changed, the undo group, and the tokens the turn spent
 * ```
 *
 * ## What the loop decides, and what it does not
 *
 * The loop owns the turn's sequence, the cards and the model conversation. It does not own a
 * permission. Every write goes through the harness, which checks the approval a card carries
 * (`approvedPlan` or `confirmed`) against the bus gate, so a write the card did not approve is
 * refused there, whatever the loop wanted. The decision comes from `decide`, which the app or an eval
 * supplies, so the loop waits only on an answer it was given a way to ask for.
 *
 * ## Steps that have run
 *
 * A step that applied is recorded in its card's `completed` set, by origin. It is shown as done, a
 * retry resumes after it and never runs it again, and no edit may drop, change or move it. So a
 * ladder retry, a conflict re-show and a cancel after an applied step all leave the applied steps
 * exactly as they were, and the turn's undo group keeps them (command-bus §5).
 *
 * ## The model-call bound
 *
 * Every model request a turn makes passes one call site (`modelCall`), which counts it against
 * `maxModelCalls`. Drafts are checked before they are asked for, so a step the turn cannot afford is
 * refused back to the model with a corrective hint, and a retry the turn cannot afford is a notice on
 * the card. The call site refuses anything past the bound as a backstop.
 *
 * ## The wire
 *
 * The planner's calls go over one of two protocols, chosen per turn by what the gateway's `modelCaps`
 * reports for the profile and model: native tool calls when it reports `tools`, the JSON-in-text
 * envelope otherwise (protocol.ts). Both produce the same plan — a native reply's calls are its steps
 * and its text is the card's rationale — and a step's risk, its card, and the ladder that follows a
 * refusal do not read which wire brought the call.
 *
 * ## Identity
 *
 * A session names its turns, so two sessions that share a gateway (and its usage ledger) or a harness
 * (and its undo groups and call cache) never reuse one another's turn ids. Within a turn, every call
 * id is counted from the turn, so a replay of the same intent in the same session gets the same ids,
 * and a replay cache (command-bus §6) never answers one step with another step's result.
 */

import { preloadAnchorLibraries } from '@caotang/editor';
import { err, ok, type CommandError, type Result, type UndoOutcome } from '@caotang/bus';
import { ContextError, type AgentTask, type PromptPreview, type RecentTurn, type SelectionSpan } from '@caotang/context';
import { estimateTokens, usageFor, type ChatChunk, type ChatMessage, type ChatRequest, type Gateway, type TaskRole, type ThinkingLevel, type ToolCall as WireToolCall, type ToolDef, type Usage } from '@caotang/gateway';
import { newId } from '@caotang/ids';
import { SKILL_CATALOG_TOKENS } from '@caotang/skills';
import { getBody, getRevision, type ProjectState, type RunStatus, type TreeNode } from '@caotang/store';
import { dialogueDraftTool, resolveContainer } from '@caotang/dialogue';
import { stagePromptDraftTool, stagePromptVariantTool } from '@caotang/video-prompt-pack';

import { limitExceeded, refusal } from '../errors.js';
import { askBackFor, parsePlan, type AskBack, type AskBackCode, type Plan, type PlanOptions, type PlanOutcome, type PlanPreflight, type PlanStep, type StepResult } from '../plan.js';
import { DOCUMENT, descendantsOf, resolveNode } from '../resolve.js';
import type { Harness, RuleCheck, ToolListing } from '../runtime.js';
import type { ToolName } from '../metadata.js';
import type { CallParams, ToolCall, ToolOutcome } from '../types.js';
import { canonicalJson, isRecord } from '../util.js';
import { CONTINUITY_MAX_DOCS, SYNOPSIS_MAX_DOCS } from '../tools/ports.js';
import type { DelegateParams } from '../tools/delegate.js';
import { fitsCap } from '../tokens.js';
import { LARGE_SCOPE_APPROVAL, LARGE_SCOPE_APPROVAL_KEY } from '../tools/coherence.js';
import {
  addUse,
  budgetHit,
  budgetStop,
  callDigest,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_TURN_BUDGET,
  EMPTY_BUDGET_USE,
  isPermissionMode,
  modePolicy,
  repeatStop,
  type BudgetHit,
  type BudgetUse,
  type ModePolicy,
  type PermissionMode,
  type SessionBudget,
  type TurnBudget,
} from './mode.js';
import { skillBlock } from '../tools/skills.js';
import {
  advance,
  applyEdit,
  canAdvance,
  MODEL_BACKED_TOOLS as MODEL_BACKED,
  planCardOf,
  reviewCostAt,
  stagedOf,
  type DelegationView,
  type EditableSteps,
  type PlanCardView,
  type PlanEdit,
  type StatusCard,
  type StatusState,
} from './cards.js';
import { anySignal, runLimitWords, stepLimitWords, type BudgetMeter, type BudgetSpend, type BudgetStop, type Reservation } from './budget.js';
import {
  CHECKPOINT_LABEL,
  DEFAULT_MAX_MODEL_CALLS,
  EXTERNAL_CHECKPOINT_NOTE,
  RESUMED_CHECKPOINT_NOTE,
  type AgentEvent,
  type CardRecord,
  type Decision,
  type PendingCard,
  type StepRecord,
  type SteeringNote,
  type TraceEntry,
  type TurnPhase,
  type TurnReport,
  type TurnStatus,
  type TurnStop,
} from './events.js';
import {
  complete,
  continuityRole,
  dialogueRole,
  draftDialogue,
  draftScene,
  fillSynopses,
  asSceneProposal,
  asSynopsisProposal,
  assistantOf,
  GenerationStopped,
  TurnStopped,
  sceneRole,
  scanContinuity,
  synopsisRole,
  wordsOf,
  type FindingsProposal,
  type ModelCall,
  type SceneProposal,
  type SynopsisDoc,
  type SynopsisProposal,
} from './drafting.js';
import {
  callArgs,
  errorSummary,
  loadedToolsMessage,
  parseReply,
  PLAN_CANCELLED_MESSAGE,
  plannerSystem,
  plannerSystemNative,
  plannerToolDefs,
  refusalSentence,
  refusedStepsMessage,
  REPLY_SCHEMA_HINT,
  resultsMessage,
  retryMessage,
  steeringMessage,
  stepsRefusalMessage,
  type Reply,
} from './protocol.js';
import { previewFor, sceneDraftPreflight, shotsDeriveScenePreflight } from './ports.js';
import { createContextPort, dropLinesOf, mergePreviews, type ContextPort } from './context.js';
import { createSubagentRunner, framedResult, resultLine, SUBAGENT_SPECS, type ParentTurnHandle } from './subagent.js';
import {
  BACKGROUND_OFFER_MIN_CALLS,
  backgroundEligibility,
  estimatedModelCalls,
  proposalShapeOk,
  revisionsOf,
  staleSteps,
  type StepRevisions,
} from './background.js';
import {
  createRunWriter,
  newRunRecord,
  planResume,
  statusOfTurn,
  structureDigest,
  RUN_LOG_VERSION,
  type Revisions,
  type RunLogOptions,
  type RunReplay,
  type RunWriter,
  type PendingStep,
} from './run-log.js';
import { DERIVE_SCHEMA_HINT, deriveRole, deriveUserText, parseDeriveReply, promptModelOf, storyboardOf } from './storyboard-model.js';

export interface AgentSessionOptions {
  readonly harness: Harness;
  /** The gateway the turn's model calls go through. Its ledger carries the per-turn usage (provider-gateway §6). */
  readonly gateway: Gateway;
  /**
   * Assembles each model call's prompt (context-assembly §2). Absent: the product's port, which assembles
   * `@caotang/context`'s layers over the harness's own project state (context.ts `createContextPort`).
   */
  readonly context?: ContextPort;
  /** Asked for a decision on every card. The loop does not act until it answers. */
  readonly decide: (pending: PendingCard) => Promise<Decision>;
  readonly emit?: (event: AgentEvent) => void;
  /** The profile and model every turn runs on unless its own `TurnOptions` pin another (the app pins per turn; a background task's session pins here). */
  readonly profileId?: string;
  readonly model?: string;
  /**
   * The task role the session's model calls run under (provider-gateway §6): stamped on every request the turn
   * makes, so the ledger accounts it and the gateway resolves the role's profile when `profileId` pins none.
   * The prompt-pack's calls are stamped 'drafting' instead. Absent, no role is sent.
   */
  readonly role?: TaskRole;
  /**
   * The effort level a model request is sent with (`ChatRequest.thinking`) unless the turn pins its own. Absent,
   * the provider's own default applies.
   */
  readonly thinking?: ThinkingLevel;
  /** The most model calls one turn may make, retries and drafts included. Default 8. Read at the start of each turn. */
  readonly maxModelCalls?: number;
  /**
   * The permission mode (agent-harness §4), read at each card, so a switch applies from the next card. Absent, `ask`: every card is
   * the writer's. The mode is the app's setting and a session override, never a project file.
   */
  readonly mode?: PermissionMode | (() => PermissionMode);
  /** `auto` is turned off: a mode that reads as `auto` is `ask`. Read at each card. */
  readonly lockAuto?: boolean | (() => boolean);
  /** The project holds text from outside the writer; while true, accept-edits and auto behave as ask (#54). Default false. */
  readonly taint?: () => boolean;
  /** Nobody is there to ask: a card the mode does not approve is cancelled, not forwarded to `decide`. */
  readonly noHuman?: boolean;
  /**
   * The limits a turn is held to while a mode decides its cards, over `DEFAULT_TURN_BUDGET`, read at the start of each turn. In `ask`
   * and `plan-only` the writer decides each card, and only the model-call bound applies.
   */
  readonly budget?: Partial<TurnBudget> | (() => Partial<TurnBudget>);
  /** The same limits across every turn of the session, read at each check. */
  readonly sessionBudget?: SessionBudget | (() => SessionBudget);
  /** The price per 1,000 tokens the cost limit reads (provider-gateway §2). Absent, a turn has no cost to hold to a limit. */
  readonly price?: () => { readonly prompt: number; readonly completion: number } | undefined;
  /**
   * Awaited before a card the mode approves is applied, so the app can save the writer's typing as an approval does. A reason it
   * answers means the card is not applied unattended: it is shown to the writer with that reason, as a stale card is, and the writer decides.
   */
  readonly beforeAutoApply?: (card: PlanCardView) => Promise<string | void>;
  /**
   * The run limits (agent-harness §7.1), or a function that reads the meter of the turn about to start. Every model call reserves its
   * worst case from the meter before it is sent, a time limit aborts the turn's signal, and a step limit refuses a plan before it is drafted.
   * Absent, nothing beyond the model-call bound is enforced. A meter shared by several turns is the caller's to dispose.
   */
  readonly meter?: BudgetMeter | (() => BudgetMeter | undefined);
  /** How many times the verify ladder may adjust and re-show a refused step (agent-harness §7). Default 2. */
  readonly maxRetries?: number;
  /**
   * Names this session's turns: a turn is `<session>.turn-<n>`, so two sessions on one gateway or one
   * harness never share a turn id. Defaults to a random name. The app pins one for the life of its panel, and an eval pins
   * one so its runs are the same bytes.
   */
  readonly sessionId?: string;
  /**
   * The clock the status cards are stamped with: when a call starts running and when it finishes, which the panel's elapsed
   * timer reads (agent-harness §8). Display only, so no check reads it. Default `Date.now`.
   */
  readonly clock?: () => number;
  /**
   * Whether every callable tool is declared on every request, as before deferral (agent-harness §3): Settings › Agent "Load every
   * tool on every request", for a model that searches poorly. Read at each request, so a change applies to the next one.
   */
  readonly loadEveryTool?: () => boolean;
  /**
   * Asked once for a planner's plan that needs many model calls, before any of them is made (agent-harness §2, "Background runs"). The
   * answer is the writer's: stage the plan now, queue it, or drop it. Absent, a plan is always staged now. A plan the app built
   * (`submitPlan`) is never offered, and neither is a plan that cannot run unattended or is small (`BACKGROUND_OFFER_MIN_CALLS`).
   */
  readonly beforeStage?: (offer: PlanOffer) => Promise<OfferAnswer>;
  /**
   * Logs each turn ahead of the work, so a turn a reload or a crash cut short can be resumed (agent-harness §5.1). Absent, nothing is logged
   * and no turn behaves differently: a logged turn runs a plan one step at a time, awaiting the log between steps.
   */
  readonly runLog?: RunLogOptions;
}

/** The plan a writer is asked about before it is staged. */
export interface PlanOffer {
  readonly turnId: string;
  readonly steps: readonly PlanStep[];
  /** The model calls staging the plan makes (`estimatedModelCalls`). A background run is capped at this many. */
  readonly estimatedCalls: number;
  /** The most model calls a turn may make here: staging now stops at this many. */
  readonly turnCap: number;
}

/** The writer's answer to a `PlanOffer`. `background` is only given once the app has queued the plan. */
export type OfferAnswer = 'now' | 'background' | 'cancel';

/** What staging steps without a card produced (`AgentSession.stageOnly`). Every array is aligned to the steps given. */
export interface StageOnlyResult {
  /** The draft of each model-backed step, and `undefined` for a step with none or one that was refused. */
  readonly proposals: readonly unknown[];
  /** The documents each step read, with their revisions as they were before the step's model calls. */
  readonly revisions: readonly StepRevisions[];
  readonly refusals: readonly { readonly index: number; readonly tool: string; readonly message: string }[];
  /** The writer's stop (the signal) ended staging before it finished: the steps from the first one without an outcome did not run. */
  readonly stopped: boolean;
  /** The model calls made, and their tokens as the gateway's ledger counted them. */
  readonly modelCalls: number;
  readonly tokens: { readonly promptTokens: number; readonly completionTokens: number; readonly requests: number };
}

/** What the caller holds for one turn (agent-harness §2, "Stop and steer"). */
export interface TurnOptions {
  /**
   * Aborts the turn: the in-flight model call, any awaited step, and every later step. Steps already applied stay in the undo group,
   * and a bus command that has started is never interrupted. The turn ends as `cancelled` with `stop.by === 'user'`.
   */
  readonly signal?: AbortSignal;
  /**
   * The profile, model and thinking level this turn's model calls run on, over the session's own. A session outlives a provider
   * change, so a writer who switches between turns keeps the conversation (context-assembly §2, L6): the pins are the turn's,
   * never the session's. Absent, the session's pin applies.
   */
  readonly profileId?: string;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
}

/** What a UI action can tell a planner turn before it starts. */
export interface SubmitOptions extends TurnOptions {
  /** Deferred native rows the turn is about, loaded before the first request as if the planner had searched for them. */
  readonly preload?: readonly ToolName[];
}

/** Where a steering note will land (agent-harness §2). */
export interface SteerReceipt {
  readonly noteId: string;
  /** The next model call, or nowhere yet because a card is waiting for a decision: the note lands after it. */
  readonly lands: 'next-model-call' | 'after-decision';
}

export interface AgentSession {
  /** Runs one turn for one intent. Resolves when the turn has ended, after any card was decided. */
  submit(intent: string, options?: SubmitOptions): Promise<TurnReport>;
  /**
   * Runs one turn whose plan the app built, rather than the model: the drafts it needs are staged, and its card is decided like
   * any other. The "Fix with agent" entry of a coherence finding is the caller (coherence.md §6.3). The plan is checked as a
   * planner's is, and a plan that does not parse is refused before anything is staged.
   */
  submitPlan(intent: string, plan: unknown, options?: TurnOptions): Promise<TurnReport>;
  /**
   * Stages `steps` and nothing else: no card, no decision, no bus command, and no turn in the session's record. A background task
   * runs this for each of its items. A step the stop cut short is not an outcome; the rest of the result is what was staged.
   */
  stageOnly(steps: readonly PlanStep[], options?: TurnOptions): Promise<StageOnlyResult>;
  /**
   * Reviews a plan that was staged earlier (`stageOnly`) as a turn: its card is decided like any other and the ghost previews and the
   * apply are the normal path, but no step is staged again, so no model call is made for a draft already held. `proposals` and
   * `revisions` are aligned to the plan's steps. Stored data is untrusted: a step whose proposal fails its shape guard, was not
   * drafted, or read a document that has changed since is marked stale, and the card cannot be approved until it is drafted again or
   * dropped.
   */
  submitStaged(
    intent: string,
    plan: unknown,
    proposals: readonly unknown[],
    revisions: readonly (StepRevisions | undefined)[],
    options?: TurnOptions,
  ): Promise<TurnReport>;
  /**
   * Adds a writer's note to a running turn. It reaches the model at the next planner request, after the previous reply's tool
   * results, as one user message of its own. Refused with `not-found` for a turn that is not running. A note the turn ends
   * without delivering is reported undelivered (`TurnReport.steering`), for the caller to send as a turn of its own.
   */
  steer(turnId: string, text: string): Result<SteerReceipt, CommandError>;
  /**
   * Resumes a run the log says was cut short (agent-harness §5.1). The writer's click is what calls it: it can re-issue a paid planner call.
   * The log is checked against the project first (`planResume`). A write that did not land, a document that moved on, or an external step that
   * may have run is a failed report that names it and leaves the run as it was. Otherwise a card the run was showing is shown again, with its
   * drafts marked out of date where their documents moved, and still needs its own Approve; a run that was between cards asks the model
   * again from the logged conversation. The rules and the mode are those in force now, not those the run began under.
   */
  resume(runId: string, options?: TurnOptions): Promise<TurnReport>;
  /** Reverses a turn's undo group: "restore to before this turn" (command-bus §5). */
  restore(turnId: string): Result<UndoOutcome, CommandError>;
  /** Every turn this session has finished, oldest first. */
  reports(): readonly TurnReport[];
}

/**
 * The refusals the ladder may adjust: a refusal that changed nothing and that the model can correct.
 * A revision conflict is not one of them. It is a race with the user, so the draft goes back to the
 * card, where the user retries it or cancels it (agent-harness §8).
 */
const ADJUSTABLE = new Set<AskBack['code']>(['needs_input']);

/**
 * How many decisions in a row may leave a card unchanged before the turn stops. A decision that changes
 * nothing (an approval the card refuses, an edit that does not apply) is asked again, so a decider that
 * keeps answering the same way is ended rather than looped on.
 */
const MAX_STALLS = 5;

/** The options a failed provider call offers: the user's own next actions, since the provider is outside the turn. */
const PROVIDER_OPTIONS = ['check the provider profile and its key in Settings, then send the request again', 'switch to another provider profile in Settings'];

/** The turn's signal, as the optional field a call or an option bag carries. */
const signalOf = (turn: Turn): { readonly signal?: AbortSignal } => (turn.signal === undefined ? {} : { signal: turn.signal });

/** The writer stopped the turn: ends it at this boundary. Nothing is started after it, and nothing already applied is undone. */
function checkStop(turn: Turn): void {
  if (turn.signal?.aborted === true) throw new TurnStopped();
}

/**
 * A bound the turn ran into: a model call refused at the bound (the staging and card paths check it first, so this is a backstop), or a
 * budget a mode that decides cards reached. It ends the turn on an ask-back that carries `stop`'s words.
 */
class BudgetExceeded extends Error {
  constructor(
    readonly stop: { readonly reason: string; readonly options: readonly string[]; readonly code?: AskBackCode },
    /** Set when a run limit refused the call (agent-harness §7.1). */
    readonly budgetStop?: BudgetStop,
  ) {
    super(stop.reason);
    this.name = 'BudgetExceeded';
  }
}

const modelCallBound = (limit: number): BudgetExceeded => new BudgetExceeded(budgetStop({ dimension: 'model-calls', used: limit, limit, scope: 'turn' }));

/**
 * A native-mode reply the model made, and the outcomes its calls got as they ran. It is held until the
 * results are flushed into tool messages, so a call's answer always lands before the next request.
 */
interface WireReply {
  readonly calls: readonly WireToolCall[];
  readonly results: Map<string, WireResult>;
}

/** The result one native call is answered with: its data, or the reason it did not run. */
interface WireResult {
  readonly ok: boolean;
  readonly body: unknown;
}

/** A steering note as the turn holds it: delivery stamps it. */
interface NoteRecord {
  readonly noteId: string;
  readonly text: string;
  deliveredAtCall?: number;
}

/** Where a turn's calls go: `TurnOptions`' pins over `AgentSessionOptions`'. */
interface Pins {
  readonly profileId: string | undefined;
  readonly model: string | undefined;
  readonly thinking: ThinkingLevel | undefined;
}

interface Turn {
  readonly id: string;
  readonly messages: ChatMessage[];
  readonly trace: TraceEntry[];
  readonly cards: CardRecord[];
  readonly steps: StepRecord[];
  readonly statusCards: StatusCard[];
  readonly dropped: string[];
  /** The turns this one follows, oldest first: L6's source (context-assembly §2). Taken when the turn starts. */
  readonly priorTurns: readonly RecentTurn[];
  modelCalls: number;
  /** The writer's stop (`TurnOptions.signal`) and the meter's time limits, as one signal. */
  readonly signal: AbortSignal | undefined;
  /** The run limits this turn is held to (agent-harness §7.1). */
  readonly meter: BudgetMeter | undefined;
  /** Write steps already counted into the meter. */
  metered: number;
  /** The profile, model and thinking level this turn's calls run on: its own pins over the session's. */
  readonly pins: Pins;
  /** The phase the turn last reported: what a stop says it happened during. */
  phase: TurnPhase;
  /** The notes the writer sent, in order; one without `deliveredAtCall` has not reached the model. */
  readonly notes: NoteRecord[];
  /** A card waits for a decision, so a note sent now lands after it. */
  deciding: boolean;
  /** The turn is a planner conversation, which a cancelled card with a note can carry on. */
  converses: boolean;
  /** Counts the calls a turn makes, so every call id within it is unique. */
  seq: number;
  /** The turn's undo group, recorded the moment a run applies anything, so no path loses it. */
  undoGroupId?: string;
  /** The mode the last card (or the start) read: what the turn's report and checkpoint print. */
  mode: PermissionMode;
  /** The limits this turn is held to while a mode decides its cards. */
  readonly budget: TurnBudget;
  /** The write steps plan-only refused, deduplicated by call digest. */
  readonly held: PlanStep[];
  /** How often each call was proposed this turn, by call digest (the repeat guard). */
  readonly proposed: Map<string, number>;
  /** Words per document when the turn first had a mode decide its cards, and where the activity log stood: the words and documents a turn changed are read against these. */
  base?: { readonly words: ReadonlyMap<string, number>; readonly entries: number };
  /** The loaded-tools addendum the model was last told, so a request after a new load is told again (context-assembly §2). */
  addendumSent?: string;
  /**
   * Whether the planner speaks native tool calls this turn: set when the first planner call is built
   * (`plannedTurn`), from the model's capabilities. On the JSON fallback it stays `false`.
   */
  native: boolean;
  /** The native replies whose calls still owe tool messages, oldest first. Empty on the JSON wire. */
  readonly wireReplies: WireReply[];
  /** The delegated agents this turn has started, so each has a path of its own (`turn-3/reader#1`). */
  delegations: number;
  /** What the turn's delegated agents proposed, as `canonicalJson({ tool, params })` keys with the agent that did: a plan step equal to one carries its badge. */
  readonly proposals: { readonly agent: string; readonly key: string }[];
  /**
   * The wire call a plan step answers, by the step object the plan currently carries. An edit replaces
   * the object, so `reconcileWire` re-binds a step's call to the step the writer left in its place.
   */
  readonly wireSteps: Map<PlanStep, WireToolCall>;
  /** The run log's writer for this turn, when the session logs. */
  run?: RunWriter;
  /** How many of `messages` the log already holds. */
  logged: number;
  /** The documents a step's draft read, with their revisions, taken before the draft was asked for: what a restored card checks. */
  readonly reads: Map<PlanStep, StepRevisions>;
  /** The turn was rebuilt from a log (`resume`): its undo reaches only what it applies, and its ladder does not ask the model. */
  restored: boolean;
  /** Steps a resumed turn's run had applied before the reload: its undo group does not reach them. */
  carried: number;
}

/** How the turn ended, before the report is built from it. */
interface Settled {
  readonly status: TurnStatus;
  readonly stop?: TurnStop;
  readonly text?: string;
  readonly askBack?: AskBack;
  readonly summary?: string;
  /** The run limit the turn ended on. */
  readonly budgetStop?: BudgetStop;
}

/** What drafting produced for a call's model-backed steps. A refusal is returned to the model, not thrown. */
interface Staged {
  readonly proposals: readonly unknown[];
  readonly refusals: readonly { readonly index: number; readonly tool: string; readonly message: string }[];
  /** Steps whose drafts are out of date as the card first shows them (a plan staged earlier, `submitStaged`). */
  readonly stale?: readonly boolean[];
  /** The card's first notice. */
  readonly notice?: string;
}

/** What one step's drafting produced: its proposal, or the reason it was refused. */
type Drafted = { readonly ok: true; readonly proposal: unknown } | { readonly ok: false; readonly message: string };

/** What running a card's steps produced. */
interface Executed {
  readonly ok: boolean;
  /** The writer declined a one-step confirm card of an external write, in the middle of the run. The steps before it stay applied. */
  readonly cancelled?: boolean;
  readonly undoGroupId?: string;
  readonly askBack?: AskBack;
  /** The step that refused, when one did. */
  readonly failedAt?: number;
  /** Whether the refused step had changed the project before it refused. Only a refusal that had not may be adjusted. */
  readonly effect: boolean;
  /** The indices, in the plan as it was run, of the steps that applied in this run. */
  readonly completed: readonly number[];
}

/** The result of the decision loop for one card. `refused` means the steps could not be checked at all. */
interface Decided {
  readonly settled: 'approved' | 'cancelled' | 'refused';
  readonly editable: EditableSteps;
  readonly edits: number;
  readonly retries: number;
  /** The mode's policy approved the card as shown, and the writer was not asked. */
  readonly auto?: boolean;
  /**
   * The writer approved a cut card with `acceptTruncated` (agent-harness §8): the apply strips
   * `cut: true` from the proposals so the ports see a complete proposal. Without it, a cut
   * proposal reaches the port and is refused as truncated.
   */
  readonly acceptedCut?: boolean;
  readonly error?: CommandError;
}

/** What a card is shown from. */
interface CardStart {
  readonly editable: EditableSteps;
  readonly from: number;
  readonly revision: number;
  readonly notice?: string;
  /** The card is the writer's in every mode: a scan over the document guard asks for the writer's own leave. */
  readonly humanOnly?: boolean;
  /** The card is a sub-card of a plan the writer approved (an external write inside it): the plan's own record covers it. */
  readonly nested?: true;
}

/** The id a step's call carries. A one-step confirm is one call, and a plan names each step by its index. */
function callIdFor(kind: 'plan' | 'confirm', prefix: string, index: number): string {
  return kind === 'confirm' ? prefix : `${prefix}.${index}`;
}

/** Whether a refusal is a scope over the document guard, which the writer approves on a one-step card (coherence.md §7 tool 15). */
function needsWriterApproval(error: CommandError): boolean {
  return error.details?.[LARGE_SCOPE_APPROVAL_KEY] === LARGE_SCOPE_APPROVAL;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The reason a native call's tool message reports when the call never ran (the step was cancelled or edited away). */
const NOT_RUN = 'the call did not run: its step was cancelled or changed before it ran';

/** The reason a step reports when the writer's stop ended its wait. */
const STOPPED_STEP = 'the writer stopped the turn before this step finished';

/**
 * A native reply's step expectation. The wire carries no `expect`, so the step takes the reply's own
 * text — what the model said the calls were for — as the expectation the card shows. A reply that
 * asked for calls and said nothing else gets the placeholder.
 */
function expectOf(text: string): string {
  const trimmed = text.trim();
  return trimmed === '' ? 'the step the call asks for' : trimmed;
}

/**
 * A selection the editor captured, read from a step's params: its body offsets and the text found there.
 * `undefined` for anything that is not one, so a rewrite with no usable selection is assembled without one.
 */
function spanOf(value: unknown): SelectionSpan | undefined {
  if (!isRecord(value)) return undefined;
  const { from, to, exact } = value;
  if (typeof from !== 'number' || typeof to !== 'number' || typeof exact !== 'string') return undefined;
  return { from, to, exact };
}

/**
 * scene.draft's task (context-assembly §2): the brief and the document it is for. For a rewrite, the
 * selection is what the focus layer quotes, so the model reads the text it is asked to replace.
 */
export function sceneTask(
  title: string,
  docId: string,
  mode: 'draft' | 'continue' | 'rewrite_selection',
  instruction: string,
  selection: SelectionSpan | undefined,
  targetWords: number | undefined,
  forwardOutline: boolean,
): AgentTask {
  return {
    tool: 'scene.draft',
    instruction: `Document "${title}":\nMode: ${mode}\nBrief: ${instruction}`,
    params: { mode, ...(targetWords === undefined ? {} : { target_words: targetWords }) },
    focus: docId,
    mode,
    // The per-call opt-in (context-assembly §4): off unless the step asked for it, so a later scene's synopsis is withheld by default.
    includeForwardOutline: forwardOutline,
    ...(mode === 'rewrite_selection' && selection !== undefined ? { selection } : {}),
  };
}

/** continuity.scan's task (context-assembly §2): the documents to check, and the aspects asked for, if any. */
export function continuityTask(scope: readonly string[], aspects: readonly string[]): AgentTask {
  return {
    tool: 'continuity.scan',
    instruction:
      aspects.length === 0
        ? 'Check these documents for continuity problems.'
        : `Check these documents for continuity problems in these aspects: ${aspects.join(', ')}.`,
    params: { aspects },
    scope,
  };
}

/**
 * synopsis.fill's task text for one document (L7). The notes are in it for `notes` and `both`. For `notes` the
 * text is not sent, and the task says so: the focus layer lists an empty body as empty, and it has no stand-in
 * for a full document, so the model is told in words that the synopsis is drafted from the notes alone.
 */
export function synopsisInstruction(node: TreeNode, source: 'text' | 'notes' | 'both'): string {
  const notes = source !== 'text' && node.notes.trim() !== '' ? `\nNotes:\n${node.notes.trim()}` : '';
  const withheld = source === 'notes' ? '\nThe text of this document is not sent: write the synopsis from the notes alone.' : '';
  return `Document "${node.title}":${notes}${withheld}\nBrief: write the synopsis of this document.`;
}

/**
 * The view of one document a synopsis is drafted from (`source`, agent-harness §3 row 7). `notes` leaves the
 * text out of the focus layer, and `synopsisInstruction` says it was left out. Everything else is the document
 * as it is. A view, not a change: the project itself is not touched.
 */
function sourceView(state: ProjectState, docId: string, source: 'text' | 'notes' | 'both'): ProjectState {
  if (source !== 'notes') return state;
  const record = state.documents.get(docId);
  if (record === undefined) return state;
  return { ...state, documents: new Map(state.documents).set(docId, { ...record, body: '' }) };
}

/** Whether a step has applied in this turn. Its origin is the key, so a reorder does not change what has run. */
function ranAt(editable: EditableSteps, index: number): boolean {
  return editable.completed.includes(editable.origins[index] ?? index);
}

const refusedDraft = (message: string): Drafted => ({ ok: false, message });

/**
 * The refusal for a rewrite with no text to rewrite, worded so the model can correct the step in one reply. The
 * selection is captured in the editor or named in the step (agent-harness §3, row 8); a new text needs no selection.
 */
const NO_SELECTION =
  'rewrite_selection needs a selection with text, and this step has none: select text in the editor first, or pass a selection anchor (from, to, exact) that holds it. To write new text instead, use mode "draft" or "continue".';

/** The refusal for a draft in a mode the schema does not name, with the modes it may be. */
const unknownMode = (asked: unknown): string =>
  `mode must be draft, continue or rewrite_selection, and this step has ${JSON.stringify(asked)}: use draft for an empty document, continue to add to the end, or rewrite_selection to replace a selected passage.`;

/** The refusal for a step the turn cannot afford, worded so the model can correct it in one reply. */
function tooCostly(tool: string, needed: number, left: number, limit: number): string {
  if (tool === 'synopsis.fill' && left > 0) {
    return `synopsis.fill drafts one synopsis per document, so ${needed} documents need ${needed} model calls, and this turn has ${left} left. Send at most ${left} documents in this call, and split the rest into another turn.`;
  }
  return `${tool} needs ${needed} model ${needed === 1 ? 'call' : 'calls'}, and this turn has ${left} left of ${limit}. Ask for a smaller change.`;
}

/** What plan-only tells the model about a write it refused. The writer sees it on the step's failed status card. */
const PLAN_ONLY =
  'Plan-only mode is on, so this write was not run and nothing was changed. Reads still run. Describe the change as a plan in your reply: the writer can switch to Ask to run it.';

const isWrite = (risk: string): boolean => risk === 'write-auto' || risk === 'write-confirm';

/** The refusal for a delegation sent in the same reply as a write. */
const DELEGATE_ALONE =
  'agent.delegate runs before anything is written, and its result comes back to you first. Nothing was run. Call it in a reply without write steps (reads may go with it), then plan the writes, including any step the agent proposed.';

/** The ask-back for a turn that used its model-call bound. The user decides what to do with the rest. */
function budgetAskBack(limit: number): AskBack {
  return askBackOf(modelCallBound(limit).stop);
}

function askBackOf(stop: { readonly reason: string; readonly options: readonly string[]; readonly code?: AskBackCode }): AskBack {
  return { code: stop.code ?? 'needs_input', reason: stop.reason, options: stop.options };
}

/**
 * How a card that cannot be approved says why, in the words the user needs to act on (agent-harness §2). A stale step names its
 * own remedy: a draft is drafted again, and a step with no draft is dropped or the card is cancelled, since a retry does not
 * draft it.
 */
function noticeFor(card: PlanCardView): string {
  const stale = card.steps.find((step) => step.stale && step.status !== 'done');
  if (stale !== undefined) {
    const named = `step ${stale.index + 1} (${stale.tool})`;
    return MODEL_BACKED.has(stale.tool)
      ? `${named} was drafted against an earlier version of the document, so it was not applied: retry the draft, or cancel the card`
      : `${named} changed after it was last checked, so the card cannot be approved as it stands: drop the step, or cancel the card`;
  }
  if (card.cut) return 'this draft was cut off at the model’s output limit: retry the draft, or approve with acceptTruncated to keep the cut text';
  return 'this card cannot be approved while a step is refused: edit the step or cancel the card';
}

/** The decision loop gave up: the card was decided too often without a change that could apply. */
function stuck(editable: EditableSteps, edits: number, retries: number): Decided {
  return {
    settled: 'refused',
    editable,
    edits,
    retries,
    error: refusal('permission-denied', `the card was decided ${MAX_STALLS} times without a change that could be applied, so the turn stopped`, {
      correctiveHint: 'fix the step the card names, or cancel the card',
    }),
  };
}

/**
 * The writer approved a cut card with `acceptTruncated` (agent-harness §8). The proposal the port sees must not carry
 * `cut: true`, or the port refuses it as truncated. Return the proposals with `cut` stripped on every cut entry.
 */
function stripCut(proposals: readonly unknown[]): readonly unknown[] {
  return proposals.map((proposal) => {
    if (!isRecord(proposal) || proposal['cut'] !== true) return proposal;
    const { cut: _omit, ...rest } = proposal as { cut?: unknown } & Record<string, unknown>;
    return rest;
  });
}

/** The settled outcome for a turn that stopped on a failure outside its steps: a model call, a stream, or the bound. */
function stoppedBy(error: unknown): Settled {
  // The writer's Stop is a stop, not a provider failure (agent-harness §2): no ask-back, and the report says who stopped it.
  if (error instanceof TurnStopped) return { status: 'cancelled' };
  if (error instanceof BudgetExceeded) return { status: 'failed', askBack: askBackOf(error.stop), ...(error.budgetStop === undefined ? {} : { budgetStop: error.budgetStop }) };
  if (error instanceof GenerationStopped) {
    return {
      status: 'failed',
      askBack: {
        code: 'needs_input',
        reason: `the model stopped before its answer was finished, so nothing was written from it: ${error.message}`,
        options: ['send the request again', 'ask for a shorter change'],
      },
    };
  }
  return { status: 'failed', askBack: { code: 'needs_input', reason: `the model call failed: ${messageOf(error)}`, options: PROVIDER_OPTIONS } };
}

/** The longest outcome a turn keeps for L6 (context-assembly §2): the layer clips its own line, this bounds what the session holds. */
const OUTCOME_KEPT_CHARS = 240;

/** A turn's summary as one line of at most `OUTCOME_KEPT_CHARS`, cut with an ellipsis and never inside a surrogate pair. */
function clipOutcome(text: string): string {
  const flat = text.split(/\s+/).filter((word) => word !== '').join(' ');
  if (flat.length <= OUTCOME_KEPT_CHARS) return flat;
  let end = OUTCOME_KEPT_CHARS - 1;
  const last = flat.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${flat.slice(0, end)}…`;
}

/** The intent a report for a resume that never found its run carries. */
const RESUME_INTENT = 'Resume an agent run';

/** Said to the model for each call of a reply the tab closed on: it never ran. */
const INTERRUPTED_CALL = 'the tab closed before this call ran, so it did not run';

/** Said to the model when a run is resumed between cards, so it plans from the request again rather than from a reply that was never acted on. */
const INTERRUPTED_REPLY = 'The tab closed before your last reply was acted on, and nothing in it ran. Plan again from the request.';

/** What a resume the log does not allow says to the writer. The run is left as it was; the writer can discard it. */
function resumeAskBack(reason: 'write-lost' | 'revision-drift' | 'ask-back' | 'schema', detail: string): AskBack {
  switch (reason) {
    case 'write-lost':
      return {
        code: 'conflict',
        reason: `The run was not resumed: ${detail}.`,
        options: ['check the document, then discard the run and send the request again', 'keep what is there and discard the run'],
      };
    case 'revision-drift':
      return {
        code: 'conflict',
        reason: `The run was not resumed: ${detail}. Your text outranks the agent's, so nothing was applied.`,
        options: ['discard the run and send the request again against the current text', 'keep what is there and discard the run'],
      };
    case 'ask-back':
      return { code: 'needs_input', reason: `The run was not resumed: ${detail}.`, options: ['check the external server yourself, then discard the run and send the request again', 'discard the run'] };
    case 'schema':
      return { code: 'needs_input', reason: `The run was not resumed: ${detail}.`, options: ['discard the log and send the request again'] };
  }
}

export function createAgentSession(options: AgentSessionOptions): AgentSession {
  const { harness, gateway } = options;
  // The project is read at each call, so a session follows the project as the writer changes it. The model's
  // limits are read at each call too, so they follow the profile and model the session is calling (context-assembly §5).
  // The pins of the turn that started last: the default port has no turn to read them from.
  let latestPins: Pins = { profileId: options.profileId, model: options.model, thinking: options.thinking };
  const context =
    options.context ??
    createContextPort({
      state: () => harness.state,
      config: () => ({ model: gateway.modelLimits(latestPins.profileId, latestPins.model, latestPins.thinking) }),
      withheld: (tool) => harness.withheld(tool),
    });
  const emit = (event: AgentEvent): void => options.emit?.(event);
  const now = options.clock ?? Date.now;
  const configured = (): Partial<TurnBudget> | undefined => (typeof options.budget === 'function' ? options.budget() : options.budget);
  const boundNow = (): number => options.maxModelCalls ?? configured()?.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS;
  /** The model-call bound of the turn that started last, as `latestPins` is: read at each turn, so a change in Settings applies to the next one. */
  let maxModelCalls = boundNow();
  const maxRetries = options.maxRetries ?? 2;
  const sessionName = options.sessionId ?? newId('cmd').slice('cmd_'.length);
  const finished: TurnReport[] = [];
  /** Every turn this session has started, oldest first, with its intent: what L6 is built from (context-assembly §2). */
  const started: RecentTurn[] = [];
  let turnCounter = 0;
  /** The turns that are running, by id: what `steer` reaches. */
  const running = new Map<string, Turn>();

  const loadEvery = (): boolean => options.loadEveryTool?.() === true;
  const subagents = createSubagentRunner({ tools: () => harness.tools(), previewPlan: (plan) => harness.previewPlan(plan), context });

  const autoLocked = (): boolean => (typeof options.lockAuto === 'function' ? options.lockAuto() : options.lockAuto === true);

  /** The mode in force now. A mode that reads as `auto` while `auto` is locked is `ask`, so a stored value cannot reach it. */
  const modeNow = (): PermissionMode => {
    const raw = typeof options.mode === 'function' ? options.mode() : options.mode;
    const mode = isPermissionMode(raw) ? raw : DEFAULT_PERMISSION_MODE;
    return mode === 'auto' && autoLocked() ? DEFAULT_PERMISSION_MODE : mode;
  };

  /** The policy of the mode in force, read at each card. The turn keeps the mode it last read for its report. */
  const policyOf = (turn: Turn): ModePolicy => {
    const policy = modePolicy(modeNow(), {
      ...(autoLocked() ? { lockAuto: true } : {}),
      ...(options.taint === undefined ? {} : { taint: options.taint }),
      ...(options.noHuman === true ? { noHuman: true } : {}),
    });
    turn.mode = policy.mode;
    return policy;
  };

  /** What the finished turns of this session used, for the session's limits. */
  let sessionUse: BudgetUse = EMPTY_BUDGET_USE;
  const sessionLimits = (): SessionBudget => (typeof options.sessionBudget === 'function' ? options.sessionBudget() : options.sessionBudget) ?? {};

  /** The first limit a use has reached (`reached`) or passed, the turn's before the session's. */
  const hitOf = (turn: Turn, use: BudgetUse, reached: boolean): BudgetHit | undefined =>
    budgetHit(use, turn.budget, reached) ?? budgetHit(addUse(sessionUse, use), sessionLimits(), reached, 'session');

  /** Notes the words in every document and where the activity log stands, so what the turn changes from here is measured. */
  const takeBase = (turn: Turn): void => {
    turn.base ??= {
      words: new Map([...harness.state.documents].map(([id, record]) => [id, wordsOf(record.body)] as const)),
      entries: harness.log.entries().length,
    };
  };

  /** The nodes the turn's commands changed since its base, and the words they now differ by from the base. */
  const touchedOf = (turn: Turn): { readonly ids: Set<string>; readonly words: number } => {
    const ids = new Set<string>();
    const base = turn.base;
    if (base === undefined) return { ids, words: 0 };
    for (const entry of harness.log.entries().slice(base.entries)) {
      if (entry.turnId === turn.id) for (const affected of entry.affected) ids.add(affected.nodeId);
    }
    let words = 0;
    for (const id of ids) {
      const record = harness.state.documents.get(id);
      if (record !== undefined) words += Math.abs(wordsOf(record.body) - (base.words.get(id) ?? 0));
    }
    return { ids, words };
  };

  /** What the turn has used of each budget dimension. The cost is absent while the session has no price to read. */
  const usageOf = (turn: Turn): BudgetUse => {
    const totals = gateway.ledger.turnTotals(turn.id);
    const price = options.price?.();
    const touched = touchedOf(turn);
    return {
      modelCalls: turn.modelCalls,
      tokens: totals.promptTokens + totals.completionTokens,
      ...(price === undefined ? {} : { costUsd: (totals.promptTokens * price.prompt + totals.completionTokens * price.completion) / 1000 }),
      wordsChanged: touched.words,
      documents: touched.ids.size,
      steps: writesOf(turn).length,
    };
  };

  /**
   * The documents and words a draft step will change, read from its draft before it applies. Only the two tools that draft text for
   * named documents say so up front; any other step is counted after it has run, from the activity log (`touchedOf`).
   */
  const reachOf = (step: PlanStep, proposal: unknown): { readonly docs: readonly string[]; readonly words: number } => {
    if (step.tool === 'scene.draft') {
      const node = resolveNode(harness.state, String(step.params['doc']), DOCUMENT, 'document', 'params.doc');
      return { docs: node.ok ? [node.value.id] : [], words: asSceneProposal(proposal)?.words ?? 0 };
    }
    if (step.tool === 'synopsis.fill') {
      const items = asSynopsisProposal(proposal)?.items ?? [];
      return { docs: items.map((item) => item.docId), words: items.reduce((sum, item) => sum + wordsOf(item.synopsis), 0) };
    }
    return { docs: [], words: 0 };
  };

  /**
   * Holds a card the mode is about to approve to the turn's and the session's budgets: what it would add to what the turn has used
   * must not pass a limit, so a turn may end exactly on one. A card that would pass one is not applied, and the turn stops on a question.
   */
  const holdToBudget = (turn: Turn, editable: EditableSteps, writes: readonly PlanStep[]): void => {
    takeBase(turn);
    const use = usageOf(turn);
    const ids = touchedOf(turn).ids;
    let words = use.wordsChanged;
    for (const step of writes) {
      const reach = reachOf(step, editable.proposals[editable.steps.indexOf(step)]);
      for (const id of reach.docs) ids.add(id);
      words += reach.words;
    }
    const hit = hitOf(turn, { ...use, steps: use.steps + writes.length, documents: ids.size, wordsChanged: words }, false);
    if (hit !== undefined) throw new BudgetExceeded(budgetStop(hit));
  };

  /** A write step plan-only refused. The same call proposed again is held once. */
  const hold = (turn: Turn, step: PlanStep): void => {
    if (!turn.held.some((held) => callDigest(held.tool, held.params) === callDigest(step.tool, step.params))) turn.held.push(step);
  };

  /** Counts a reply's calls against the repeat guard: the same tool with the same parameters, proposed too often in one turn, stops the turn. */
  const guardRepeats = (turn: Turn, steps: readonly PlanStep[]): void => {
    if (!policyOf(turn).decides) return;
    for (const step of steps) {
      const key = callDigest(step.tool, step.params);
      const count = (turn.proposed.get(key) ?? 0) + 1;
      turn.proposed.set(key, count);
      if (count >= turn.budget.doomLoopRepeats) throw new BudgetExceeded(repeatStop(step.tool, count));
    }
  };

  /**
   * A refusal's hint for a deferred native row the turn has not loaded: its params failed against a schema the model has not
   * seen, so the hint names the search that loads them. Deferral is context, not trust — the step was preflighted, not refused
   * for being unloaded (agent-harness §3).
   */
  const withLoadHint = (tool: string, error: CommandError): CommandError => {
    if (error.code !== 'invalid-params' || loadEvery()) return error;
    const deferred = harness.tools().some((listing) => listing.name === tool && listing.load === 'deferred');
    if (!deferred || harness.loadedNativeTools().some((listing) => listing.name === tool)) return error;
    const earlier = error.correctiveHint?.trim() ?? '';
    const ended = earlier === '' || earlier.endsWith('.') ? earlier : `${earlier}.`;
    return { ...error, correctiveHint: `${ended}${ended === '' ? '' : ' '}Call tool.search with '${tool}' to load its parameters.` };
  };

  /** The external tool a name is, when the turn has loaded it (extensibility §5). Undefined for a native name. */
  const loadedExternal = (tool: string) => harness.loadedExternalTools().find((candidate) => candidate.qualifiedName === tool);

  /**
   * A step the loop awaits instead of running inside an approved plan: a loaded external tool (extensibility §6), or a native
   * tool that awaits a model (coherence.md §7 tool 16, `ToolListing.async`). Both run after their card is approved.
   */
  const awaited = (tool: string): boolean => loadedExternal(tool) !== undefined || harness.tools().some((listing) => listing.name === tool && listing.async);

  /**
   * A tool's risk, as the gate and the card read it: a native tool's registry row, or for a loaded external tool its
   * effective risk, where a read the writer trusts runs without asking and anything else asks first (extensibility §4).
   */
  const riskOf = (tool: string): string => {
    const native = harness.tools().find((listing: ToolListing) => listing.name === tool);
    if (native !== undefined) return native.risk;
    const external = loadedExternal(tool);
    if (external !== undefined) return external.effectiveRisk === 'read-auto' ? 'read' : 'write-confirm';
    return 'unknown';
  };

  /**
   * The refusal the model gets for an external step the turn has not loaded: a qualified name needs tool.search first (§5),
   * and nothing runs for it. A loaded external tool is staged like any other step. A read runs in the reply's order, and a
   * write asks the writer on a one-step confirm card of its own (extensibility §4 rule 2), so a reply may mix native and
   * external steps. Undefined for a step the agent may stage.
   */
  const externalRefusal = (tool: string): string | undefined => {
    if (loadedExternal(tool) !== undefined) return undefined;
    if (tool.startsWith('mcp__')) return `"${tool}" is not an external tool loaded this turn. Nothing was run. Call tool.search first, then call the tool by the qualified name it returns.`;
    return undefined;
  };

  /** What the writer's agent rules say about a step (agent-harness §4, "Rules"): a refusal, or a rule that asks for the writer's card. */
  const ruleOf = (step: PlanStep): RuleCheck => {
    const external = loadedExternal(step.tool);
    return harness.ruleCheck(step.tool, step.params, external === undefined ? undefined : { writes: external.effectiveRisk !== 'read-auto' });
  };

  /** A rule makes this step the writer's call: it is never approved by a mode, and a single write-auto step shows a card. */
  const asksWriter = (step: PlanStep): boolean => ruleOf(step).ask !== undefined;

  /** The writes a turn has applied so far, in order, as the report names them. Reads are not writes. */
  const writesOf = (turn: Turn): string[] =>
    turn.steps.filter((step) => step.status === 'done' && riskOf(step.tool) !== 'read').map((step) => step.summary ?? step.tool);

  /** Counts the write steps the turn has applied since the last count into the run's meter, and answers how many the run may still apply. */
  const syncSteps = (turn: Turn): number => {
    const { meter } = turn;
    if (meter === undefined) return Infinity;
    const done = writesOf(turn).length;
    if (done > turn.metered) {
      meter.countStep(done - turn.metered);
      turn.metered = done;
    }
    return meter.stepsLeft();
  };

  /**
   * Reserves a request's worst case from the turn's meter before it is sent (agent-harness §7.1): the prompt's estimate plus the output
   * cap the request goes with, thinking included. A refusal ends the turn on a question, and the request is never sent. A time limit
   * that has passed is the turn's stop, ended the way the signal ends it. No meter, no reservation.
   */
  const reserveCall = (turn: Turn, request: ChatRequest): Reservation | undefined => {
    const { meter } = turn;
    if (meter === undefined) return undefined;
    const limits = gateway.modelLimits(request.profileId ?? turn.pins.profileId, request.model ?? turn.pins.model, request.thinking);
    const price = options.price?.() ?? limits.pricePer1k;
    const reserved = meter.reserve({
      promptTokens: usageFor(request.messages, '').promptTokens,
      maxOutputTokens: (request.maxOutputTokens ?? limits.maxOutputTokens) + (limits.thinkingTokens ?? 0),
      ...(price === undefined ? {} : { price }),
    });
    if (reserved.ok) {
      emit({ type: 'budget', turnId: turn.id, spend: meter.spend(), limits: meter.limits });
      return reserved.value;
    }
    const stop = reserved.error;
    if (stop.dimension === 'active-time' || stop.dimension === 'deadline') throw new TurnStopped();
    const profile = gateway.profiles.get(request.profileId ?? turn.pins.profileId ?? '') ?? gateway.profiles.active();
    throw new BudgetExceeded({ ...runLimitWords(stop, profile?.name), code: 'budget_exhausted' }, stop);
  };

  /** A stream whose reservation is settled with the usage it ended with, or the estimate when the provider reported none, however it ends. */
  async function* settling(turn: Turn, reservation: Reservation | undefined, stream: AsyncIterable<ChatChunk>): AsyncGenerator<ChatChunk, void, undefined> {
    if (reservation === undefined || turn.meter === undefined) {
      yield* stream;
      return;
    }
    let usage: Usage | undefined;
    let delivered = '';
    try {
      for await (const chunk of stream) {
        if (chunk.usage !== undefined) usage = chunk.usage;
        delivered += `${chunk.delta ?? ''}${chunk.reasoningDelta ?? ''}`;
        yield chunk;
      }
    } finally {
      turn.meter.settle(reservation, usage, { promptTokens: reservation.promptTokens, completionTokens: estimateTokens(delivered) });
      emit({ type: 'budget', turnId: turn.id, spend: turn.meter.spend(), limits: turn.meter.limits });
    }
  }

  /**
   * The one budgeted call site. Every model request a turn makes passes through here, drafts and retries
   * included, and is counted against the turn's bound before it is sent. The session's role is stamped on the
   * request here too (provider-gateway §6); the prompt-pack's calls pass 'drafting' for it instead.
   */
  const modelCall = (turn: Turn, onDelta?: (delta: string) => void, role: TaskRole | undefined = options.role): ModelCall => ({
    gateway: {
      complete: (request, signal) => {
        if (turn.modelCalls >= maxModelCalls) throw modelCallBound(maxModelCalls);
        // While a mode decides the cards, the other budgets hold a turn to what it was allowed to spend without asking.
        if (policyOf(turn).decides) {
          const hit = hitOf(turn, usageOf(turn), true);
          if (hit !== undefined) throw new BudgetExceeded(budgetStop(hit));
        }
        const sent = role === undefined ? request : { ...request, role };
        const reservation = reserveCall(turn, sent);
        turn.modelCalls += 1;
        emit({ type: 'model.call', turnId: turn.id, used: turn.modelCalls, limit: maxModelCalls });
        return settling(turn, reservation, gateway.complete(sent, signal));
      },
    },
    turnId: turn.id,
    ...signalOf(turn),
    // The turn's pins apply to the session's own role only: a call under another role resolves that role's
    // profile, model and thinking at the gateway instead of borrowing the session's.
    ...(turn.pins.profileId === undefined || role !== options.role ? {} : { profileId: turn.pins.profileId }),
    ...(turn.pins.model === undefined || role !== options.role ? {} : { model: turn.pins.model }),
    ...(turn.pins.thinking === undefined || role !== options.role ? {} : { thinking: turn.pins.thinking }),
    // A draft's deltas go to its scene's ghost region (`draft.delta`), and every other call's to the panel's stream tail.
    onDelta: onDelta ?? ((delta) => emit({ type: 'model.delta', turnId: turn.id, delta })),
    // Reasoning has one sink on every call — the panel's collapsed "Thinking" block. A draft's reasoning is the
    // turn's reasoning too: the ghost region gets `draft.delta` prose only, so nothing here lands in the editor.
    onReasoning: (delta) => emit({ type: 'model.reasoning', turnId: turn.id, delta }),
  });

  /**
   * A delegated agent's call site (agent-harness §2, "Delegate"). The turn reserved the agent's calls up front, so these are bound by that
   * reservation and not counted again against the turn's bound. Each request carries the agent path for the ledger, the turn's id so the
   * turn's totals sum its children, and the session's own pins. The agent's text and reasoning never stream to the panel.
   */
  const agentCall = (turn: Turn, agentPath: string, limit: number): ModelCall => {
    let used = 0;
    return {
      gateway: {
        complete: (request, signal) => {
          if (used >= limit) throw modelCallBound(limit);
          const sent = options.role === undefined ? request : { ...request, role: options.role };
          const reservation = reserveCall(turn, sent);
          used += 1;
          return settling(turn, reservation, gateway.complete(sent, signal));
        },
      },
      turnId: turn.id,
      agentPath,
      ...signalOf(turn),
      ...(turn.pins.profileId === undefined ? {} : { profileId: turn.pins.profileId }),
      ...(turn.pins.model === undefined ? {} : { model: turn.pins.model }),
      ...(turn.pins.thinking === undefined ? {} : { thinking: turn.pins.thinking }),
    };
  };

  /**
   * The tool declarations a native planner call may send, or `undefined` on the JSON wire: the model
   * behind this turn's profile and model must report `tools` in its capabilities, and there must be
   * tools to declare. A gateway with no `modelCaps` reports nothing, which is the fallback either way.
   */
  const nativeToolsFor = (pins: Pins): ToolDef[] | undefined => {
    if (gateway.modelCaps?.(pins.profileId, pins.model)?.tools !== true) return undefined;
    const tools = plannerToolDefs(harness.tools(), harness.loadedNativeTools(), harness.loadedExternalTools(), loadEvery());
    return tools.length === 0 ? undefined : tools;
  };
  const nativeTools = (turn: Turn): ToolDef[] | undefined => nativeToolsFor(turn.pins);

  /**
   * The planner's own calls: the one budgeted call site, with the turn's declarations added on the
   * native wire. The list is rebuilt here, on the call itself, so a tool a mid-turn `tool.search`
   * loaded is declared on the very next request.
   */
  const plannerCall = (turn: Turn): ModelCall => {
    const call = modelCall(turn);
    if (!turn.native) return call;
    const tools = plannerToolDefs(harness.tools(), harness.loadedNativeTools(), harness.loadedExternalTools(), loadEvery());
    return tools.length === 0 ? call : { ...call, tools };
  };

  /**
   * Records a step's outcome as the result its native call is answered with. The step is found by its
   * own object — an edited step is a new object, so `reconcileWire` re-binds edits before they run.
   * A step with no call (an app-built plan, or the JSON wire) records nothing.
   */
  const wireResult = (turn: Turn, step: PlanStep, result: WireResult): void => {
    const call = turn.wireSteps.get(step);
    if (call === undefined) return;
    const pending = turn.wireReplies.find((reply) => reply.calls.some((candidate) => candidate.id === call.id));
    pending?.results.set(call.id, result);
  };

  /**
   * The tool messages the next request carries, one per call the model made and has not yet heard back
   * for — every call is answered, so the model is never left guessing whether one ran. A call with no
   * recorded outcome is reported not run: its step was cancelled, declined or edited away.
   */
  const flushWire = (turn: Turn): void => {
    for (const reply of turn.wireReplies) {
      for (const call of reply.calls) {
        const result = reply.results.get(call.id) ?? { ok: false, body: NOT_RUN };
        turn.messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify(result.ok ? { ok: true, data: result.body } : { ok: false, error: result.body }),
          ...(result.ok ? {} : { isError: true }),
        });
      }
    }
    turn.wireReplies.length = 0;
  };

  /** Gives a step the wire call of the one it replaced, when an edit or a retry made it a new object. */
  const transferWire = (turn: Turn, from: PlanStep, to: PlanStep): void => {
    if (turn.wireSteps.has(to)) return;
    const call = turn.wireSteps.get(from);
    if (call !== undefined) turn.wireSteps.set(to, call);
  };

  /**
   * Re-binds the wire calls of an editable plan after the writer decided its card: an edited step is a
   * new object, so its call follows it by its origin — the reply step it stands for — or its result
   * would be reported not run. Steps that kept their objects (moves, and steps no edit touched) are
   * already bound, and a dropped step keeps no binding: its call is reported not run.
   */
  const reconcileWire = (turn: Turn, before: EditableSteps, after: EditableSteps): void => {
    if (turn.wireSteps.size === 0) return;
    for (const [index, step] of after.steps.entries()) {
      if (turn.wireSteps.has(step)) continue;
      const prior = before.steps[before.origins.indexOf(after.origins[index] ?? index)];
      if (prior !== undefined) transferWire(turn, prior, step);
    }
  };

  /** How many model calls the turn may still make. */
  const callsLeft = (turn: Turn): number => maxModelCalls - turn.modelCalls;

  /* ------------------------------------------------------------------ *
   * The run log (agent-harness §5.1)
   * ------------------------------------------------------------------ */

  /** The revision of every document the project holds now. */
  const revisionsNow = (): Record<string, number> => {
    const revisions: Record<string, number> = {};
    for (const [id, record] of harness.state.documents) revisions[id] = record.revision;
    return revisions;
  };

  /** The documents whose revision is not what `before` says, with the revision they hold now: what a step changed. */
  const changedSince = (before: Revisions): Record<string, number> => {
    const changed: Record<string, number> = {};
    for (const [id, revision] of Object.entries(revisionsNow())) if (before[id] !== revision) changed[id] = revision;
    return changed;
  };

  /** What the turn has spent, from its meter when it has one and from the gateway's ledger otherwise. */
  const spendOf = (turn: Turn): BudgetSpend => {
    if (turn.meter !== undefined) return loggable(turn.meter.spend());
    const totals = gateway.ledger.turnTotals(turn.id);
    return loggable({ modelCalls: turn.modelCalls, promptTokens: totals.promptTokens, completionTokens: totals.completionTokens, estimatedTokens: 0, steps: writesOf(turn).length, activeMs: 0 });
  };

  /** The spend as the log keeps it: every figure finite and not below zero, whatever a clock or a provider reported, so the log reads back. */
  const loggable = (spend: BudgetSpend): BudgetSpend => {
    const amount = (value: number): number => (Number.isFinite(value) && value >= 0 ? value : 0);
    return {
      modelCalls: amount(spend.modelCalls),
      promptTokens: amount(spend.promptTokens),
      completionTokens: amount(spend.completionTokens),
      estimatedTokens: amount(spend.estimatedTokens),
      ...(spend.costUsd === undefined ? {} : { costUsd: amount(spend.costUsd) }),
      steps: amount(spend.steps),
      activeMs: amount(spend.activeMs),
    };
  };

  /**
   * Writes the messages added since the last write, then the spend. `reserved` is the model calls about to be started and not settled:
   * a crash loses them, and a resume counts them as spent so the run's limits stay honest.
   */
  async function syncRun(turn: Turn, reserved: number, status?: RunStatus): Promise<void> {
    const run = turn.run;
    if (run === undefined) return;
    if (turn.messages.length > turn.logged) {
      const appended = turn.messages.slice(turn.logged);
      turn.logged = turn.messages.length;
      await run.append({ t: 'messages', turnId: turn.id, appended });
    }
    await run.append({ t: 'spend', turnId: turn.id, spend: spendOf(turn), reservedCalls: reserved }, status === undefined ? undefined : { status });
  }

  /** The card the writer is about to be shown (or the mode approved), with its drafts and what they were drafted against. */
  async function logCard(turn: Turn, kind: 'plan' | 'confirm', editable: EditableSteps, status: RunStatus): Promise<void> {
    const run = turn.run;
    if (run === undefined) return;
    await syncRun(turn, 0);
    await run.append(
      {
        t: 'card.pending',
        turnId: turn.id,
        kind,
        steps: editable.steps,
        proposals: editable.proposals.map((proposal) => (proposal === undefined ? null : proposal)),
        revisions: editable.steps.map((step) => turn.reads.get(step) ?? null),
        done: editable.steps.flatMap((_, index) => (ranAt(editable, index) ? [index] : [])),
      },
      { status },
    );
  }

  async function logDecision(turn: Turn, decided: Decided): Promise<void> {
    await turn.run?.append({ t: 'card.decided', turnId: turn.id, decision: decided.settled === 'approved' && decided.auto === true ? 'auto' : decided.settled }, { status: 'running' });
  }

  /** Written before a step runs. Awaited, so the record exists before the step can change anything. */
  async function logIntent(turn: Turn, callId: string, index: number, tool: string): Promise<void> {
    await turn.run?.append({ t: 'step.intent', turnId: turn.id, callId, index, tool, expect: revisionsNow(), structure: structureDigest(harness.state.manifest) });
  }

  /**
   * Written after a step applied and the project's save has landed. `before` is the revisions just before the step ran, so `after` names
   * only the documents the step changed, taken before the save is awaited: the writer's own typing during the wait is not the step's.
   */
  async function logApplied(turn: Turn, callId: string, index: number, tool: string, summary: string | undefined, before: Revisions | undefined): Promise<void> {
    const run = turn.run;
    if (run === undefined) return;
    const after = before === undefined ? {} : changedSince(before);
    try {
      await options.runLog?.flush?.();
    } catch (error) {
      run.fail(error);
      return;
    }
    await run.append({ t: 'step.applied', turnId: turn.id, callId, index, tool, ...(summary === undefined ? {} : { summary }), after });
  }

  async function logFailed(turn: Turn, callId: string, index: number, tool: string, error: string): Promise<void> {
    await turn.run?.append({ t: 'step.failed', turnId: turn.id, callId, index, tool, error });
  }

  /**
   * Runs a plan's steps from `planOptions.from` through the harness. A turn with a run log runs them one at a time, writing each step's intent
   * before it runs and its applied record after the project is saved; the outcome is the one the whole plan would have given. A turn without
   * one is a single `executePlan`, as it always was.
   */
  async function planRun(
    turn: Turn,
    plan: { readonly steps: readonly PlanStep[] },
    context: { readonly turnId: string; readonly callId: string },
    planOptions: PlanOptions,
  ): Promise<Result<PlanOutcome, CommandError>> {
    if (turn.run === undefined) return harness.executePlan(plan, context, planOptions);
    const completed: StepResult[] = [];
    let undoGroupId: string | undefined;
    const group = (): { undoGroupId?: string } => (undoGroupId === undefined ? {} : { undoGroupId });
    for (let index = planOptions.from ?? 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index] as PlanStep;
      const callId = `${context.callId}.${index}`;
      if (planOptions.signal?.aborted === true) return ok({ status: 'stopped', completed, stoppedAt: index, ...group() });
      await logIntent(turn, callId, index, step.tool);
      const before = revisionsNow();
      const result = harness.executePlan(plan, context, { ...planOptions, from: index, until: index + 1 });
      if (!result.ok) {
        await logFailed(turn, callId, index, step.tool, result.error.message);
        return result;
      }
      const outcome = result.value;
      if (outcome.status === 'applied') {
        completed.push(...outcome.steps);
        undoGroupId ??= outcome.undoGroupId;
        await logApplied(turn, callId, index, step.tool, outcome.steps[0]?.value.summary, before);
        continue;
      }
      if (outcome.status === 'failed') {
        await logFailed(turn, callId, index, step.tool, outcome.error.message);
        undoGroupId ??= outcome.undoGroupId;
        return ok({ ...outcome, completed, ...group() });
      }
      if (outcome.status === 'refused') {
        // Refused at the first step it is the whole plan's refusal; after earlier steps ran, the project moved under the plan, and it failed here.
        const entry = outcome.preflight.steps.find((checked) => checked.status === 'refused');
        const error = entry?.error ?? refusal('invalid-params', 'the step was refused before it ran', { correctiveHint: 'correct the step and send it again' });
        await logFailed(turn, callId, index, step.tool, error.message);
        if (completed.length === 0) return result;
        return ok({ status: 'failed', completed, failedAt: index, error, askBack: askBackFor(error), ...group() });
      }
      return ok({ status: 'stopped', completed, stoppedAt: outcome.stoppedAt, ...group() });
    }
    return ok({ status: 'applied', steps: completed, ...group() });
  }

  /**
   * The model the prompt-pack engine calls through: each of its requests is one generation of the turn, so it
   * counts against the bound — and each runs under the 'drafting' role, whatever role the session itself carries.
   */
  const promptModel = (turn: Turn) =>
    promptModelOf(
      async (messages, jsonSchemaHint) => (await complete(modelCall(turn, undefined, 'drafting'), messages, { jsonSchemaHint })).text,
      turn.pins.model ?? '',
    );

  const nextCallPrefix = (turn: Turn, letter: string): string => {
    turn.seq += 1;
    return `${turn.id}:${letter}${turn.seq}`;
  };

  /**
   * The status card of one call, created or updated. A card keeps its id from the moment it is shown
   * as pending until it finishes, so the panel and the trace see one card per call.
   */
  const cardFor = (turn: Turn, id: string, tool: string, params: CallParams, state: StatusState): StatusCard => {
    const existing = turn.statusCards.find((card) => card.id === id);
    const status = existing?.status ?? state;
    // A call that is running from the start is stamped here, as a call that moves to running is stamped in `moveCard`.
    const startedAt = existing?.startedAt ?? (status === 'running' ? now() : undefined);
    const card: StatusCard = {
      id,
      turnId: turn.id,
      callId: id,
      tool,
      risk: riskOf(tool),
      status,
      args: params,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(existing?.finishedAt === undefined ? {} : { finishedAt: existing.finishedAt }),
      ...(existing?.delegation === undefined ? {} : { delegation: existing.delegation }),
    };
    if (existing === undefined) {
      turn.statusCards.push(card);
      emit({ type: 'card', turnId: turn.id, card });
      return card;
    }
    const index = turn.statusCards.indexOf(existing);
    turn.statusCards[index] = card;
    return card;
  };

  /** Moves a card to its next state and reports it. The transition is checked, so a card cannot skip one. */
  const moveCard = (turn: Turn, id: string, to: StatusState, detail: { summary?: string; error?: string } = {}): void => {
    const card = turn.statusCards.find((entry) => entry.id === id);
    if (card === undefined || !canAdvance(card.status, to)) return;
    const next = advance(card, to, { ...detail, at: now() });
    turn.statusCards[turn.statusCards.indexOf(card)] = next;
    emit({ type: 'card', turnId: turn.id, card: next });
  };

  /**
   * A step refused before any card was shown for it (agent-harness §8): a draft the loop refused, an external tool the turn has not
   * loaded, or a single write-auto step the preflight refused. Its status card is shown in the turn and failed, with the refusal in
   * the words the planner reads, so the refusal is a card as well as the planner's next request.
   */
  const refusedBeforeCard = (turn: Turn, step: PlanStep, message: string): void => {
    const id = nextCallPrefix(turn, 'x');
    cardFor(turn, id, step.tool, step.params, 'running');
    moveCard(turn, id, 'failed', { error: message });
    wireResult(turn, step, { ok: false, body: message });
  };

  /**
   * Drafts what a turn's model-backed steps need. Each generation is a model call. A refusal (no such
   * document, an empty draft, a call the turn cannot afford) is returned to the model, and nothing is written.
   */
  async function stage(turn: Turn, steps: readonly PlanStep[]): Promise<Staged> {
    const proposals: unknown[] = steps.map(() => undefined);
    const refusals: { index: number; tool: string; message: string }[] = [];
    const writes = steps.some((step) => riskOf(step.tool) !== 'read');
    const readOnly = policyOf(turn).readOnly;
    const stepsAllowed = syncSteps(turn);
    let stepsLeft = stepsAllowed;
    for (const [index, step] of steps.entries()) {
      checkStop(turn);
      // Plan-only runs reads and refuses every write before it is drafted, so no model call is spent on it (agent-harness §4).
      if (readOnly && isWrite(riskOf(step.tool))) {
        hold(turn, step);
        refusals.push({ index, tool: step.tool, message: PLAN_ONLY });
        refusedBeforeCard(turn, step, PLAN_ONLY);
        continue;
      }
      // A write past the run's step limit is refused before it is drafted, so no model call is spent on it (agent-harness §7.1).
      if (turn.meter !== undefined && riskOf(step.tool) !== 'read') {
        if (stepsLeft < 1) {
          const message = stepLimitWords(turn.meter.limits.maxSteps ?? 0, turn.meter.spend().steps, stepsAllowed);
          refusals.push({ index, tool: step.tool, message });
          refusedBeforeCard(turn, step, message);
          continue;
        }
        stepsLeft -= 1;
      }
      // A delegation's result comes back to the planner before it plans a write, so the writes wait for it: a reply that mixes the two runs neither.
      if (step.tool === 'agent.delegate' && writes) {
        refusals.push({ index, tool: step.tool, message: DELEGATE_ALONE });
        refusedBeforeCard(turn, step, DELEGATE_ALONE);
        continue;
      }
      // An external step the turn has not loaded is refused here, before any draft is made, so nothing runs for it.
      const external = externalRefusal(step.tool);
      if (external !== undefined) {
        refusals.push({ index, tool: step.tool, message: external });
        refusedBeforeCard(turn, step, external);
        continue;
      }
      // A step a deny rule covers is refused here too, before any draft is made, so no model call is spent on it. The harness refuses it
      // again when it runs: this is the card the writer sees, and that is the backstop.
      const denied = ruleOf(step).denied;
      if (denied !== undefined) {
        const message = refusalSentence(denied.message, denied.correctiveHint);
        refusals.push({ index, tool: step.tool, message });
        refusedBeforeCard(turn, step, message);
        turn.trace.push({ tool: step.tool, callId: `${turn.id}:rule${index}`, outcome: 'refused', code: denied.code, params: step.params });
        continue;
      }
      if (!MODEL_BACKED.has(step.tool)) continue;
      const drafted = await draftFor(turn, step);
      if (drafted.ok) {
        proposals[index] = drafted.proposal;
      } else {
        refusals.push({ index, tool: step.tool, message: drafted.message });
        refusedBeforeCard(turn, step, drafted.message);
      }
    }
    return { proposals, refusals };
  }

  /**
   * One step's draft. A step the assembly refuses (`ContextError`) is a refusal to the model, like every other
   * refusal here: the assembly's own checks are the backstop behind the ones this file makes first.
   */
  async function draftFor(turn: Turn, step: PlanStep): Promise<Drafted> {
    // The documents the draft reads, as they are before the model is asked: a restored card checks its draft against them.
    turn.reads.set(step, revisionsOf(harness.state, step));
    try {
      return await draftStep(turn, step);
    } catch (error) {
      if (error instanceof ContextError) return refusedDraft(error.message);
      throw error;
    }
  }

  /**
   * A drafting task with the skills this turn has loaded ahead of its request. The writer's own instructions go in the task (L7, which
   * is never cut), under their label, and never in the system role (extensibility §10). A turn that loaded none is unchanged.
   */
  function withSkills(turn: Turn, task: AgentTask): AgentTask {
    const loaded = harness.loadedSkills(turn.id);
    return loaded.length === 0 ? task : { ...task, instruction: [skillBlock(loaded), '---', task.instruction].join('\n\n') };
  }

  /**
   * One step's draft. The revision is read before the model is asked, so the draft is staged against the
   * text the model was given, and a document the user changes while it is being written is a conflict.
   */
  async function draftStep(turn: Turn, step: PlanStep): Promise<Drafted> {
    const { state } = harness;
    // The history every call of this turn may draw on: the turns before it (L6), and their activity rows for the outcomes.
    const history = { turns: turn.priorTurns, activity: harness.log.entries() };
    if (step.tool === 'scene.draft') {
      const node = resolveNode(state, String(step.params['doc']), DOCUMENT, 'document', 'params.doc');
      if (!node.ok) return refusedDraft(node.error.message);
      // A mode the schema does not name is refused before the model is asked, by the modes it may be, so no call is spent on a
      // step the plan's preflight would refuse, and the planner is not told about a mode it never sent.
      const asked = step.params['mode'] ?? 'draft';
      if (asked !== 'draft' && asked !== 'continue' && asked !== 'rewrite_selection') return refusedDraft(unknownMode(asked));
      const mode = asked;
      // The placement rule is checked before the model is asked, so no call is spent on a draft the apply would refuse (ports.ts).
      const placed = sceneDraftPreflight({ ...step.params, mode }, state);
      if (placed !== undefined) return refusedDraft(refusalSentence(placed.message, placed.correctiveHint));
      const selection = spanOf(step.params['selection']);
      // A rewrite replaces the text it names. With none there is nothing to rewrite, and no call is spent to find that out.
      if (mode === 'rewrite_selection' && (selection === undefined || selection.exact === '')) return refusedDraft(NO_SELECTION);
      if (callsLeft(turn) < 1) return refusedDraft(tooCostly(step.tool, 1, 0, maxModelCalls));
      const revision = getRevision(state, node.value.id);
      const instruction = String(step.params['instruction'] ?? '');
      const targetWords = typeof step.params['target_words'] === 'number' ? step.params['target_words'] : undefined;
      const call = context.assemble({
        ...history,
        task: withSkills(turn, sceneTask(node.value.title, node.value.id, mode, instruction, selection, targetWords, step.params['include_forward_outline'] === true)),
        role: sceneRole(targetWords, node.value.kind, mode),
      });
      turn.dropped.push(...dropLinesOf(call.prompt));
      // The draft streams into its scene's ghost region as the model writes it, and the first delta empties the region (§8).
      const docTitle = String(step.params['doc'] ?? '');
      emit({ type: 'draft.delta', turnId: turn.id, docTitle, delta: '', start: true });
      const draft = await draftScene(modelCall(turn, (delta) => emit({ type: 'draft.delta', turnId: turn.id, docTitle, delta })), call.messages);
      if (draft.text.trim() === '') return refusedDraft('the model returned an empty draft for this scene');
      const proposal: SceneProposal = { text: draft.text, words: draft.words, revision, cut: draft.cut, context: call.preview };
      return { ok: true, proposal };
    }
    if (step.tool === 'shots.derive') {
      // The scene is read here and the model proposes its shots. The planner checks the proposal when the port runs
      // (storyboard.md §4), so this only reads the reply's shape and names what it lacks.
      const node = resolveNode(state, String(step.params['doc']), DOCUMENT, 'document', 'params.doc');
      if (!node.ok) return refusedDraft(node.error.message);
      // A prose scene, or an empty one, is refused before the model is asked, in the storyboard's words: those checks need no
      // proposal, so no call is spent on shots the card's preflight would refuse (storyboard.md §4).
      const scene = shotsDeriveScenePreflight(step.params, state);
      if (scene !== undefined) return refusedDraft(refusalSentence(scene.message, scene.correctiveHint));
      if (callsLeft(turn) < 1) return refusedDraft(tooCostly(step.tool, 1, 0, maxModelCalls));
      const granularity = step.params['granularity'] === 'full-coverage' ? 'full-coverage' : 'key-shots';
      const styleNote = typeof step.params['styleNote'] === 'string' ? step.params['styleNote'] : undefined;
      const reply = await complete(
        modelCall(turn),
        [
          { role: 'system', content: deriveRole(granularity) },
          { role: 'user', content: deriveUserText(node.value.title, getBody(state, node.value.id), styleNote) },
        ],
        { jsonSchemaHint: DERIVE_SCHEMA_HINT },
      );
      const shots = parseDeriveReply(reply.text);
      return shots.ok ? { ok: true, proposal: shots.value } : refusedDraft(shots.message);
    }
    if (step.tool === 'prompt.draft') {
      // One model call per shot, as the engine stages them (video-prompt-pack.md §6). The budget is checked before any is asked for.
      const shotCount = Array.isArray(step.params['shots']) ? step.params['shots'].length : 0;
      const left = callsLeft(turn);
      if (shotCount > left) return refusedDraft(tooCostly(step.tool, shotCount, left, maxModelCalls));
      const drafted = await stagePromptDraftTool(step.params, { storyboard: storyboardOf(state), model: promptModel(turn) });
      return drafted.ok ? { ok: true, proposal: drafted.data } : refusedDraft(drafted.message);
    }
    if (step.tool === 'prompt.variant') {
      if (callsLeft(turn) < 1) return refusedDraft(tooCostly(step.tool, 1, 0, maxModelCalls));
      const drafted = await stagePromptVariantTool(step.params, { storyboard: storyboardOf(state), model: promptModel(turn) });
      return drafted.ok ? { ok: true, proposal: drafted.data } : refusedDraft(drafted.message);
    }
    if (step.tool === 'synopsis.fill') {
      const refs = Array.isArray(step.params['docs']) ? (step.params['docs'] as readonly string[]) : [];
      const nodes: TreeNode[] = [];
      for (const [index, ref] of refs.entries()) {
        const node = resolveNode(state, ref, DOCUMENT, 'document', `docs[${index}]`);
        if (!node.ok) return refusedDraft(node.error.message);
        nodes.push(node.value);
      }
      if (nodes.length > SYNOPSIS_MAX_DOCS) {
        return refusedDraft(`synopsis.fill takes at most ${SYNOPSIS_MAX_DOCS} documents per call, and this one names ${nodes.length}: split them across calls`);
      }
      const left = callsLeft(turn);
      if (nodes.length > left) return refusedDraft(tooCostly(step.tool, nodes.length, left, maxModelCalls));
      const source = step.params['source'] === 'text' || step.params['source'] === 'notes' ? step.params['source'] : 'both';
      // A synopsis drafted from the notes alone has nothing to draft from when a document has none, and the model would
      // invent one from the title. The refusal says so, and names the sources that still have text.
      const bare = source === 'notes' ? nodes.find((node) => node.notes.trim() === '') : undefined;
      if (bare !== undefined) {
        return refusedDraft(`${bare.title} has no notes, and source "notes" drafts from the notes alone: use source "text" or "both" for it.`);
      }
      const maxWords = typeof step.params['max_words'] === 'number' ? step.params['max_words'] : 50;
      // One call per document, each assembled from the document as `source` names it. The batch's card shows them as one.
      const docs: SynopsisDoc[] = [];
      const previews: PromptPreview[] = [];
      for (const node of nodes) {
        const call = context.assemble({
          ...history,
          state: sourceView(state, node.id, source),
          task: withSkills(turn, { tool: 'synopsis.fill', instruction: synopsisInstruction(node, source), focus: node.id }),
          role: synopsisRole(maxWords),
        });
        turn.dropped.push(...dropLinesOf(call.prompt));
        docs.push({ id: node.id, messages: call.messages });
        previews.push(call.preview);
      }
      const batch = await fillSynopses(modelCall(turn), { docs, maxWords });
      const merged = mergePreviews(previews);
      const proposal: SynopsisProposal = { items: batch.items, cut: batch.cut, ...(merged === undefined ? {} : { context: merged }) };
      return { ok: true, proposal };
    }
    if (step.tool === 'coherence.review') {
      // The review's plan, staged with no model call (coherence.md §7 tool 16): the card shows its documents, its cost estimate
      // and its first prompt, and the review runs only after the writer approves that card (`runAwaited`). The cost is the
      // active model's price applied to the plan (cards.ts `reviewCostAt`, which the Findings tab reads too); an unpriced model adds nothing to the proposal.
      const planned = harness.reviewPlan(step.params);
      if (!planned.ok) return refusedDraft(planned.error.message);
      const cost = reviewCostAt(planned.value, gateway, turn.pins.profileId, turn.pins.model, turn.pins.thinking);
      return { ok: true, proposal: cost === undefined ? planned.value : { ...planned.value, cost } };
    }
    if (step.tool === 'dialogue.draft') {
      // The container's Ink, drafted by the model and checked by the dialogue module before its card is shown (dialogue-narrative.md
      // §7): Ink with a compile error is refused back to the model, and warnings ride on the card for the writer to approve.
      const container = resolveContainer(state, String(step.params['doc'] ?? ''));
      if (!container.ok) return refusedDraft(container.error.message);
      if (callsLeft(turn) < 1) return refusedDraft(tooCostly(step.tool, 1, 0, maxModelCalls));
      const instruction = String(step.params['instruction'] ?? '');
      const targetLines = typeof step.params['target_lines'] === 'number' ? step.params['target_lines'] : undefined;
      const revision = getRevision(state, container.node.id);
      // The container is the focus (dialogue-narrative §7): its Ink is L5, its prior beats are L4 and the codex of its speakers is L2,
      // so the prompt is the standard stack. The task carries the brief only, because the Ink is already in the focus.
      const call = context.assemble({
        ...history,
        task: withSkills(turn, { tool: 'dialogue.draft', instruction: `Brief: ${instruction}`, focus: container.node.id }),
        role: dialogueRole(targetLines),
      });
      turn.dropped.push(...dropLinesOf(call.prompt));
      const draft = await draftDialogue(modelCall(turn), call.messages);
      if (draft.text === '') return refusedDraft('the model returned an empty draft for this container');
      const checked = dialogueDraftTool(step.params, { state, proposal: { ink: draft.text } });
      if (!checked.ok) return refusedDraft(checked.error.message);
      return { ok: true, proposal: { ink: draft.text, revision, cut: draft.cut, context: call.preview } };
    }
    // continuity.scan
    const scopeRefs = Array.isArray(step.params['scope']) ? (step.params['scope'] as readonly string[]) : undefined;
    const scope: TreeNode[] = [];
    if (scopeRefs === undefined) {
      const hidden = harness.withheld('continuity.scan');
      scope.push(...descendantsOf(state, 'manuscript').filter((node) => DOCUMENT(node) && !hidden.has(node.id)));
    } else {
      for (const [index, ref] of scopeRefs.entries()) {
        const node = resolveNode(state, ref, DOCUMENT, 'document', `scope[${index}]`);
        if (!node.ok) return refusedDraft(node.error.message);
        scope.push(node.value);
      }
    }
    if (scope.length > CONTINUITY_MAX_DOCS) {
      return refusedDraft(
        `continuity.scan checks at most ${CONTINUITY_MAX_DOCS} documents per call, and this scope holds ${scope.length}: split it into runs of at most ${CONTINUITY_MAX_DOCS} documents, one call each, and name each run in scope`,
      );
    }
    if (callsLeft(turn) < 1) return refusedDraft(tooCostly(step.tool, 1, 0, maxModelCalls));
    const aspects = Array.isArray(step.params['aspects']) ? (step.params['aspects'] as readonly string[]) : [];
    const call = context.assemble({
      ...history,
      task: continuityTask(scope.map((node) => node.id), aspects),
      role: continuityRole(aspects),
    });
    turn.dropped.push(...dropLinesOf(call.prompt));
    const found = await scanContinuity(modelCall(turn), call.messages);
    if (!found.ok) return refusedDraft(found.error);
    const proposal: FindingsProposal = { ...found.value, context: call.preview };
    return { ok: true, proposal };
  }

  /** One step as the plan a single-step card shows: the step, its index and the draft it carries. */
  const oneStep = (step: PlanStep, index: number, proposal: unknown): EditableSteps => ({
    steps: [step],
    origins: [index],
    proposals: [proposal],
    stale: [false],
    superseded: [],
    completed: [],
  });

  /**
   * Runs one read: a loaded external tool through the bus (`callExternal`, extensibility §6), anything else through the
   * harness. Only a native read takes the writer's one-step confirmation.
   */
  async function invokeRead(turn: Turn, call: ToolCall, permission?: { readonly confirmed: true }): Promise<ToolOutcome> {
    if (loadedExternal(call.name) !== undefined) return harness.callExternal(call, { turnId: turn.id, ...signalOf(turn) });
    return harness.call(call, permission === undefined ? { turnId: turn.id } : { turnId: turn.id, permission });
  }

  /** Records one read's outcome: its trace row, its step, its card's last move, and any findings it made. */
  function settleRead(turn: Turn, index: number, step: PlanStep, callId: string, outcome: ToolOutcome): { tool: string; ok: boolean; body: unknown } {
    if (outcome.ok) {
      turn.trace.push({ tool: step.tool, callId, outcome: 'ok', params: step.params });
      turn.steps.push({ index, tool: step.tool, expect: step.expect, status: 'done', summary: outcome.value.summary, data: outcome.value.data });
      moveCard(turn, callId, 'done', { summary: outcome.value.summary });
      if (Array.isArray(outcome.value.data['findings'])) {
        emit({ type: 'findings', turnId: turn.id, callId, findings: outcome.value.data['findings'] as FindingsProposal['findings'] });
      }
      return { tool: step.tool, ok: true, body: outcome.value.data };
    }
    const reason = errorSummary(withLoadHint(step.tool, outcome.error));
    turn.trace.push({ tool: step.tool, callId, outcome: 'refused', code: outcome.error.code, params: step.params });
    turn.steps.push({ index, tool: step.tool, expect: step.expect, status: 'failed', error: reason });
    moveCard(turn, callId, 'failed', { error: reason });
    return { tool: step.tool, ok: false, body: reason };
  }

  /** Shows a delegated agent's view on its call's card, and reports the card. */
  const showDelegation = (turn: Turn, id: string, delegation: DelegationView): void => {
    const index = turn.statusCards.findIndex((card) => card.id === id);
    const card = turn.statusCards[index];
    if (card === undefined) return;
    const next: StatusCard = { ...card, delegation };
    turn.statusCards[index] = next;
    emit({ type: 'card', turnId: turn.id, card: next });
  };

  /**
   * An `agent.delegate` call (agent-harness §2, "Delegate"): a read the loop answers itself. The call is checked as any step is, its scope is
   * resolved, and the turn must be able to spare the agent's model calls and keep one for the planner to read the result (refused up front,
   * before any child call, in `tooCostly`'s words). Then the agent runs, alone, in a context of its own, and what comes back is framed as
   * data that carries no approval. A write it proposes is only remembered here, so the plan card can say who proposed a step; nothing is
   * run or added to a plan.
   */
  async function runDelegate(turn: Turn, step: PlanStep, id: string): Promise<ToolOutcome> {
    const checked = harness.previewPlan({ steps: [step] });
    const refused = checked.ok ? checked.value.steps.find((entry) => entry.status === 'refused')?.error : checked.error;
    if (refused !== undefined) return err(refused);
    const params = step.params as unknown as DelegateParams;
    const spec = SUBAGENT_SPECS[params.agent];
    const scope: string[] = [];
    for (const [at, ref] of (params.scope ?? []).entries()) {
      const node = resolveNode(harness.state, ref, DOCUMENT, 'document', `scope[${at}]`);
      if (!node.ok) return err(node.error);
      if (!scope.includes(node.value.id)) scope.push(node.value.id);
    }
    // The planner keeps at least one call to read the result with, so a delegate can never starve it.
    if (callsLeft(turn) < spec.maxModelCalls + 1) {
      return err(
        refusal('limit-exceeded', tooCostly(step.tool, spec.maxModelCalls + 1, callsLeft(turn), maxModelCalls), {
          target: 'agent.delegate',
          correctiveHint: `the agent needs ${spec.maxModelCalls} calls and you need one more to read its result: delegate a narrower scope, read the documents yourself with doc.read, or tell the writer the turn needs a larger model-call budget`,
        }),
      );
    }
    turn.delegations += 1;
    const agentPath = `${turn.id}/${spec.name}#${turn.delegations}`;
    let view: DelegationView = { agent: spec.name, agentPath, reserved: spec.maxModelCalls, outcome: 'running', trace: [] };
    cardFor(turn, id, step.tool, step.params, 'running');
    showDelegation(turn, id, view);
    const handle: ParentTurnHandle = {
      turnId: turn.id,
      agentPath,
      native: turn.native,
      reserve: (calls) => {
        if (callsLeft(turn) < calls + 1) return false;
        turn.modelCalls += calls;
        emit({ type: 'model.call', turnId: turn.id, used: turn.modelCalls, limit: maxModelCalls });
        return true;
      },
      release: (unused) => {
        if (unused <= 0) return;
        turn.modelCalls -= unused;
        emit({ type: 'model.call', turnId: turn.id, used: turn.modelCalls, limit: maxModelCalls });
      },
      model: () => agentCall(turn, agentPath, spec.maxModelCalls),
      read: (call) => Promise.resolve(harness.call(call, { turnId: turn.id, agentPath, ...signalOf(turn) })),
      trace: (entry) => {
        const row: TraceEntry = { ...entry, agentPath };
        turn.trace.push(row);
        view = { ...view, trace: [...view.trace, row] };
        showDelegation(turn, id, view);
      },
    };
    const result = await subagents.run(spec, { agent: spec.name, brief: params.brief, ...(scope.length === 0 ? {} : { scope }) }, handle, turn.signal);
    turn.dropped.push(...result.dropped);
    for (const proposed of result.proposedSteps) turn.proposals.push({ agent: spec.name, key: canonicalJson({ tool: proposed.tool, params: proposed.params }) });
    view = { ...view, outcome: result.status, result: result.summary, proposed: result.proposedSteps.length };
    showDelegation(turn, id, view);
    // The writer's Stop ends the turn here, after the agent's unused calls were released and its card shows how far it got.
    if (turn.signal?.aborted === true) {
      moveCard(turn, id, 'failed', { error: STOPPED_STEP });
      throw new TurnStopped();
    }
    if (result.status === 'failed') {
      return err(refusal('internal', `the ${spec.name} agent failed: ${result.summary} Nothing was changed.`, { target: 'agent.delegate', correctiveHint: 'read the documents yourself with doc.read, or tell the writer what failed' }));
    }
    const data = framedResult(result);
    const cap = harness.tools().find((listing) => listing.name === 'agent.delegate')?.response_token_cap ?? 0;
    if (!fitsCap(data, cap)) {
      return err(limitExceeded(`the ${spec.name} agent's result is over the ${cap}-token cap, so it was not returned.`, 'delegate a narrower brief or scope, and ask for fewer proposed steps', 'agent.delegate'));
    }
    return ok({ data, summary: resultLine(result), affected: [] });
  }

  /**
   * Runs a reply's reads now, and returns their results to the model. A loaded external read runs through the bus
   * (`callExternal`, extensibility §6), and a search that loaded external tools puts their descriptors in front of the
   * model after the results (§5). A read whose scope is over the document guard is refused until the writer approves it:
   * the scope goes to the writer on a one-step card, and an approved scan runs under that one confirmation, as a call of
   * its own (coherence.md §7 tool 15). Returns the turn's end when the writer cancels that card, and nothing otherwise.
   */
  async function runReads(turn: Turn, steps: readonly PlanStep[], proposals: readonly unknown[]): Promise<Settled | undefined> {
    const results: { tool: string; ok: boolean; body: unknown }[] = [];
    const surfaced = new Set<string>();
    for (const [index, step] of steps.entries()) {
      checkStop(turn);
      const id = nextCallPrefix(turn, 'r');
      const proposal = proposals[index];
      // A read a rule asks about goes to the writer's card first, as a scan over the document guard does.
      const asked = asksWriter(step);
      const first: ToolOutcome = asked
        ? err(refusal('permission-denied', `a rule asks for the writer’s confirmation of ${step.tool}`, { target: step.tool }))
        : step.tool === 'agent.delegate'
          ? await runDelegate(turn, step, id)
          : await invokeRead(turn, { name: step.tool, callId: id, params: step.params, ...(proposal === undefined ? {} : { proposal }) });
      // A read the stop cut short is not a refusal the model should hear about.
      if (!first.ok && turn.signal?.aborted === true) throw new TurnStopped();
      let callId = id;
      let outcome: ToolOutcome = first;
      if (!first.ok && (asked || needsWriterApproval(first.error))) {
        // The refusal came before the scan ran, so nothing has run. The writer decides on a card of its own.
        callId = `${id}.confirm`;
        const decided = await decideCard(turn, 'confirm', callId, { editable: oneStep(step, index, proposal), from: 0, revision: 0, humanOnly: true });
        if (decided.settled === 'cancelled') {
          turn.cards.push({ kind: 'confirm', tools: [step.tool], decision: 'cancelled', edits: decided.edits, retries: decided.retries });
          moveCard(turn, callId, 'cancelled');
          turn.steps.push({ index, tool: step.tool, expect: step.expect, status: 'cancelled' });
          return { status: 'cancelled' };
        }
        if (decided.settled === 'refused') {
          moveCard(turn, callId, 'cancelled');
          outcome = { ok: false, error: decided.error ?? refusal('internal', 'the card could not be checked', { correctiveHint: 'send the request again' }) };
        } else {
          // The card may have edited the step, so the run takes the step as the writer left it.
          const approved = decided.editable.steps[0] ?? step;
          turn.cards.push({ kind: 'confirm', tools: [step.tool], decision: 'approved', edits: decided.edits, retries: decided.retries });
          phase(turn, 'running');
          moveCard(turn, callId, 'running');
          // agent.delegate is answered by the loop, not by the harness, so an approved one starts its agent the way an unasked one does.
          outcome =
            approved.tool === 'agent.delegate'
              ? await runDelegate(turn, approved, callId)
              : await invokeRead(turn, { name: approved.tool, callId, params: approved.params, ...(proposal === undefined ? {} : { proposal }) }, { confirmed: true });
          if (!outcome.ok && turn.signal?.aborted === true) throw new TurnStopped();
        }
      } else {
        cardFor(turn, id, step.tool, step.params, 'running');
      }
      const result = settleRead(turn, index, step, callId, outcome);
      wireResult(turn, step, { ok: result.ok, body: result.body });
      results.push(result);
      if (step.tool === 'tool.search' && outcome.ok && Array.isArray(outcome.value.data['surfaced'])) {
        for (const name of outcome.value.data['surfaced'] as string[]) surfaced.add(name);
      }
    }
    const loadedNow = harness.loadedExternalTools().filter((tool) => surfaced.has(tool.qualifiedName));
    // With every tool declared, a native row a search loads is already in front of the model, so only external descriptors follow.
    const nativeNow = loadEvery() ? [] : harness.loadedNativeTools().filter((tool) => surfaced.has(tool.name));
    const loadedAny = loadedNow.length > 0 || nativeNow.length > 0;
    if (turn.native) {
      // On the native wire each call is answered by its own tool message, keyed by its id; a search that
      // surfaced tools still puts their descriptors in a user note after the results, as the JSON wire does.
      flushWire(turn);
      if (loadedAny) turn.messages.push({ role: 'user', content: loadedToolsMessage(nativeNow, loadedNow) });
    } else {
      const sections = [resultsMessage(results), ...(loadedAny ? [loadedToolsMessage(nativeNow, loadedNow)] : [])];
      turn.messages.push({ role: 'user', content: sections.join('\n\n') });
    }
    // The descriptors just sent name every tool the search loaded, so the planner's one-line addendum for the same set is not
    // sent again in the next request: the same names would reach the model twice (context-assembly §2).
    if (loadedAny) turn.addendumSent = harness.loadedAddendum();
    return undefined;
  }

  /**
   * The preflight and the card of an editable plan from `from` on. A card whose preflight refuses a
   * step is still returned, not approvable, so the user can edit it or cancel it. `refused` means the
   * plan could not be checked at all, which is a defect in the steps the loop built (the harness's
   * own plan schema refused them), and the turn fails by naming it.
   */
  function cardOf(
    turn: Turn,
    editable: EditableSteps,
    from: number,
    revision: number,
    kind: 'plan' | 'confirm',
    notice: string | undefined,
  ): { readonly card: PlanCardView; readonly preflight: PlanPreflight } | { readonly refused: CommandError } {
    // The native steps are checked as one plan, so a step may name what an earlier native step creates. An external step is
    // not a native tool, so the harness cannot check it; its call checks it against the server's pinned schema (mcp.invoke),
    // and its row here is ready. Both are read from the same `from`, so a resumed card checks only what has not run.
    const nativeAt = editable.steps.flatMap((step, index) => (loadedExternal(step.tool) === undefined ? [index] : []));
    const nativeFrom = nativeAt.filter((index) => index < from).length;
    const checked: Result<PlanPreflight, CommandError> =
      nativeAt.length === 0
        ? ok({ ok: true, steps: [] })
        : harness.previewPlan({ steps: nativeAt.map((index) => editable.steps[index] as PlanStep) }, {
            from: nativeFrom,
            proposals: nativeAt.map((index) => editable.proposals[index]),
          });
    if (!checked.ok) return { refused: checked.error };
    const external = editable.steps.flatMap((step, index) =>
      index < from || loadedExternal(step.tool) === undefined ? [] : [{ index, tool: step.tool, expect: step.expect, status: 'ready' as const }],
    );
    const preflight: PlanPreflight = {
      ok: checked.value.ok,
      steps: [
        ...checked.value.steps.map((entry) => ({
          ...entry,
          index: nativeAt[entry.index] ?? entry.index,
          ...(entry.error === undefined ? {} : { error: withLoadHint(entry.tool, entry.error) }),
        })),
        ...external,
      ].sort(
        (a, b) => a.index - b.index,
      ),
    };
    const previews = editable.steps.map((step, index) => previewFor(harness.state, step.tool, step.params, editable.proposals[index]));
    const staged = editable.proposals.map((proposal) => stagedOf(proposal));
    // A step equal to one a delegated agent proposed carries its badge; an edited step is a different step and has none.
    const proposedBy = editable.steps.map((step) => {
      const key = canonicalJson({ tool: step.tool, params: step.params });
      return turn.proposals.find((entry) => entry.key === key)?.agent;
    });
    const card = planCardOf({
      id: `${turn.id}:card`,
      turnId: turn.id,
      kind,
      revision,
      previewRevision: revision,
      from,
      state: editable,
      preflight,
      previews,
      risks: editable.steps.map((step) => riskOf(step.tool)),
      staged,
      ...(proposedBy.some((agent) => agent !== undefined) ? { proposedBy } : {}),
      ...(notice === undefined ? {} : { notice }),
    });
    return { card, preflight };
  }

  /**
   * Brings the drafts a card needs up to date. A draft that fails is named and the card kept as it was.
   * `which` picks the steps to draft again, and only a model-backed step is ever drafted.
   */
  async function redraft(turn: Turn, editable: EditableSteps, which: (index: number) => boolean): Promise<{ readonly editable: EditableSteps; readonly refusal?: string }> {
    const proposals = [...editable.proposals];
    const stale = [...editable.stale];
    for (const [index, step] of editable.steps.entries()) {
      if (!which(index)) continue;
      // A step with no draft has nothing to make again: its preflight runs when the card is shown, so its flag is cleared here.
      if (!MODEL_BACKED.has(step.tool)) {
        stale[index] = false;
        continue;
      }
      const drafted = await draftFor(turn, step);
      if (!drafted.ok) return { editable, refusal: drafted.message };
      proposals[index] = drafted.proposal;
      stale[index] = false;
    }
    return { editable: { ...editable, proposals, stale } };
  }

  /** The ghost-preview handoff (agent-harness §8), for each drafted scene a card shows that has not run. */
  function showGhosts(turn: Turn, editable: EditableSteps, kind: 'plan' | 'confirm', prefix: string): void {
    for (const [index, step] of editable.steps.entries()) {
      const proposal = editable.proposals[index] as SceneProposal | undefined;
      if (step.tool !== 'scene.draft' || ranAt(editable, index) || proposal === undefined) continue;
      const title = typeof step.params['doc'] === 'string' ? step.params['doc'] : '';
      emit({
        type: 'ghost',
        turnId: turn.id,
        callId: callIdFor(kind, prefix, index),
        docTitle: title,
        text: proposal.text,
        words: proposal.words,
        ...(proposal.cut === true ? { cut: true } : {}),
      });
    }
  }

  /**
   * Asks for the card's decision, and answers it with a cancel when the writer stops the turn first, whether or not the decider
   * ever answers. An approval that arrives with the signal already fired is a cancel too: Stop wins the race, and nothing runs.
   */
  async function decideOrStop(turn: Turn, pending: PendingCard): Promise<Decision> {
    const { signal } = turn;
    turn.deciding = true;
    // The time a card waits for the writer is not work (agent-harness §7.1).
    turn.meter?.pauseClock();
    try {
      if (signal === undefined) return await options.decide(pending);
      let release = (): void => {};
      const stopped = new Promise<Decision>((resolve) => {
        const onAbort = (): void => resolve({ action: 'cancel' });
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        release = () => signal.removeEventListener('abort', onAbort);
      });
      try {
        const decided = await Promise.race([options.decide(pending), stopped]);
        return signal.aborted ? { action: 'cancel' } : decided;
      } finally {
        release();
      }
    } finally {
      turn.meter?.resumeClock();
      turn.deciding = false;
    }
  }

  /**
   * Shows a card and asks for decisions until the user approves or cancels. An edit or a retry is
   * checked and the card is shown again, so an approval always covers the card as it now stands
   * (agent-harness §2). An edit that cannot be applied is refused by name, and the last good card stays.
   */
  async function decideCard(turn: Turn, kind: 'plan' | 'confirm', prefix: string, start: CardStart): Promise<Decided> {
    const decided = await decideLoop(turn, kind, prefix, start);
    if (start.nested !== true) await logDecision(turn, decided);
    return decided;
  }

  async function decideLoop(turn: Turn, kind: 'plan' | 'confirm', prefix: string, start: CardStart): Promise<Decided> {
    let editable = start.editable;
    let revision = start.revision;
    let notice = start.notice;
    let edits = 0;
    let retries = 0;
    let stalls = 0;
    // Why the app would not let the mode apply this card: once it holds the card, the card is the writer's.
    let held: string | undefined;
    for (;;) {
      // Before the card is shown, so a stop leaves no pending card behind.
      checkStop(turn);
      const shown = cardOf(turn, editable, start.from, revision, kind, notice);
      notice = undefined;
      if ('refused' in shown) return { settled: 'refused', editable, edits, retries, error: shown.refused };
      // The mode answers a card it approves, as shown, without asking. Everything else is the writer's: an external write, a card
      // with a refused, stale or cut step, a card that needs the writer's leave. A budget the card would pass stops the turn first.
      const policy = policyOf(turn);
      const remaining = editable.steps.filter((_, index) => index >= start.from && !ranAt(editable, index));
      const writes = remaining.filter((step) => riskOf(step.tool) !== 'read');
      // A rule that asks makes the card the writer's in every mode.
      const auto =
        start.humanOnly !== true &&
        held === undefined &&
        shown.card.approvable &&
        !remaining.some(asksWriter) &&
        policy.approves({ tools: writes.map((step) => step.tool), external: remaining.some((step) => loadedExternal(step.tool) !== undefined) });
      if (auto) holdToBudget(turn, editable, writes);
      // Each step that has not run is pending from the moment its card is shown (agent-harness §8).
      for (const [index, step] of editable.steps.entries()) {
        if (ranAt(editable, index)) continue;
        cardFor(turn, callIdFor(kind, prefix, index), step.tool, step.params, 'pending-approval');
      }
      emit({ type: 'plan', turnId: turn.id, card: shown.card, ...(auto ? { auto: true as const } : {}) });
      showGhosts(turn, editable, kind, prefix);
      if (start.nested !== true) await logCard(turn, kind, editable, auto ? 'running' : 'awaiting-approval');
      if (auto) {
        const hold = await options.beforeAutoApply?.(shown.card);
        checkStop(turn);
        if (typeof hold === 'string') {
          held = hold;
          notice = hold;
          continue;
        }
        return { settled: 'approved', editable, edits, retries, auto: true };
      }
      phase(turn, 'awaiting-approval');
      // With nobody to ask, a card the mode did not approve is cancelled.
      const decision: Decision = policy.noHuman ? { action: 'cancel' } : await decideOrStop(turn, { kind, turnId: turn.id, card: shown.card } satisfies PendingCard);

      if (decision.action === 'cancel') return { settled: 'cancelled', editable, edits, retries };
      if (decision.action === 'approve') {
        if (shown.card.approvable || (decision.acceptTruncated === true && shown.card.canAcceptCut)) {
          return {
            settled: 'approved',
            editable,
            edits,
            retries,
            ...(decision.acceptTruncated === true && shown.card.canAcceptCut ? { acceptedCut: true } : {}),
          };
        }
        notice = noticeFor(shown.card);
        stalls += 1;
        if (stalls >= MAX_STALLS) return stuck(editable, edits, retries);
        continue;
      }
      if (decision.action === 'retry') {
        const current = editable;
        const redrafted = await redraft(turn, current, (index) => !ranAt(current, index));
        retries += 1;
        revision += 1;
        if (redrafted.refusal !== undefined) {
          notice = redrafted.refusal;
          stalls += 1;
          if (stalls >= MAX_STALLS) return stuck(editable, edits, retries);
        } else {
          editable = redrafted.editable;
          stalls = 0;
        }
        continue;
      }
      // edit: applied in order; the first edit that cannot apply stops the batch and says why.
      let next = editable;
      let applied = 0;
      for (const edit of decision.edits as readonly PlanEdit[]) {
        const result = applyEdit(next, edit);
        if (!result.ok) {
          notice = result.error;
          break;
        }
        next = result.value;
        applied += 1;
      }
      if (applied === 0) {
        stalls += 1;
        if (stalls >= MAX_STALLS) return stuck(editable, edits, retries);
        continue;
      }
      const redrafted = await redraft(turn, next, (index) => next.stale[index] === true);
      if (redrafted.refusal !== undefined) {
        notice = redrafted.refusal;
        stalls += 1;
        if (stalls >= MAX_STALLS) return stuck(editable, edits, retries);
        continue;
      }
      edits += applied;
      editable = redrafted.editable;
      revision += 1;
      stalls = 0;
    }
  }

  /**
   * A card's run: the steps under the approval it carries, with each step's status card moved along.
   * The undo group a run produces is recorded on the turn here, whatever the outcome, so an applied
   * step is never left out of the turn's checkpoint.
   */
  async function execute(
    turn: Turn,
    editable: EditableSteps,
    from: number,
    kind: 'plan' | 'confirm',
    prefix: string,
    grant: 'auto' | 'confirmed',
    acceptedCut: boolean = false,
  ): Promise<Executed> {
    const executed = await runCard(turn, editable, from, kind, prefix, grant, acceptedCut);
    if (executed.undoGroupId !== undefined) turn.undoGroupId ??= executed.undoGroupId;
    return executed;
  }

  /**
   * One external call of a card's step, through `mcp.invoke` (extensibility §6). A write runs under the one-step confirmation
   * its card gave, and a read runs as a read does. The step's status card moves along, and its trace row and step record are
   * written as a native call's are. An external write that fails may have reached the server, so it is never adjusted (`effect`).
   */
  async function runAwaited(
    turn: Turn,
    index: number,
    step: PlanStep,
    id: string,
    grant: 'read' | 'confirmed' | 'plan',
    proposal: unknown,
  ): Promise<Executed> {
    const write = grant !== 'read';
    cardFor(turn, id, step.tool, step.params, write ? 'pending-approval' : 'running');
    moveCard(turn, id, 'running');
    const call: ToolCall = { name: step.tool, callId: id, params: step.params, ...(proposal === undefined ? {} : { proposal }) };
    // An external server may act on its own the moment it is called, so its intent is on record first (resume never calls it again unasked).
    if (write) await logIntent(turn, id, index, step.tool);
    // A native async tool (coherence.review) runs under the approval its card gave: the plan's, or the one-step confirmation.
    // An external tool is called through its own entry, under the confirmation its card gave (extensibility §4 rule 2).
    const outcome =
      loadedExternal(step.tool) === undefined
        ? await harness.callAsync(call, grant === 'plan' ? { turnId: turn.id, permission: { approvedPlan: true }, ...signalOf(turn) } : { turnId: turn.id, permission: { confirmed: true }, ...signalOf(turn) })
        : await harness.callExternal(call, grant === 'confirmed' ? { turnId: turn.id, permission: { confirmed: true }, ...signalOf(turn) } : { turnId: turn.id, ...signalOf(turn) });
    // These tools write findings or call a server, not documents, and the wait is long: no document is claimed for the step.
    if (write) {
      if (outcome.ok) await logApplied(turn, id, index, step.tool, outcome.value.summary, undefined);
      else await logFailed(turn, id, index, step.tool, outcome.error.message);
    }
    if (!outcome.ok && turn.signal?.aborted === true) {
      // The wait ended because the writer stopped the turn: the step did not finish, and that is not a refusal to adjust.
      moveCard(turn, id, 'failed', { error: STOPPED_STEP });
      turn.trace.push({ tool: step.tool, callId: id, outcome: 'not-run', params: step.params });
      turn.steps.push({ index, tool: step.tool, expect: step.expect, status: 'cancelled' });
      wireResult(turn, step, { ok: false, body: STOPPED_STEP });
      return { ok: false, cancelled: true, effect: write, completed: [] };
    }
    if (outcome.ok) {
      turn.trace.push({ tool: step.tool, callId: id, outcome: 'ok', params: step.params });
      turn.steps.push({ index, tool: step.tool, expect: step.expect, status: 'done', summary: outcome.value.summary, data: outcome.value.data });
      moveCard(turn, id, 'done', { summary: outcome.value.summary });
      wireResult(turn, step, { ok: true, body: outcome.value.data });
      return { ok: true, effect: true, completed: [index] };
    }
    const reason = errorSummary(outcome.error);
    turn.trace.push({ tool: step.tool, callId: id, outcome: 'refused', code: outcome.error.code, params: step.params });
    turn.steps.push({ index, tool: step.tool, expect: step.expect, status: 'failed', error: reason });
    moveCard(turn, id, 'failed', { error: reason });
    wireResult(turn, step, { ok: false, body: reason });
    // A write that failed may have reached the server or the findings file, so it is never adjusted (`effect`).
    return { ok: false, failedAt: index, effect: write, askBack: askBackFor(outcome.error), completed: [] };
  }

  /**
   * The steps after a failed or declined one, which did not run, are shown as cancelled and are never run (agent-harness §7).
   */
  function cancelAfter(turn: Turn, editable: EditableSteps, after: number, kind: 'plan' | 'confirm', prefix: string): void {
    for (let index = after + 1; index < editable.steps.length; index += 1) {
      if (ranAt(editable, index)) continue;
      const later = editable.steps[index] as PlanStep;
      const id = callIdFor(kind, prefix, index);
      cardFor(turn, id, later.tool, later.params, 'pending-approval');
      moveCard(turn, id, 'cancelled');
      turn.trace.push({ tool: later.tool, callId: id, outcome: 'not-run', params: later.params });
      turn.steps.push({ index, tool: later.tool, expect: later.expect, status: 'cancelled' });
    }
  }

  /**
   * A plan that holds an external step (extensibility §4, §6), run in the order the reply gave. Each run of native steps is one
   * sub-plan under the turn, approved by the plan card the writer approved. An external read runs without a card, as a read
   * does. An external write asks first, on a one-step confirm card of its own, because an external call is confirmed per call
   * (§4 rule 2). A writer who declines that card stops the run: the steps before it stay applied, and the turn says so.
   */
  async function runMixed(turn: Turn, editable: EditableSteps, from: number, prefix: string, acceptedCut: boolean = false): Promise<Executed> {
    const completed: number[] = [];
    let undoGroupId: string | undefined;
    let index = from;
    while (index < editable.steps.length) {
      const step = editable.steps[index] as PlanStep;
      if (ranAt(editable, index)) {
        index += 1;
        continue;
      }
      // The writer's stop is read before each step, never inside one: the steps that ran stay applied, and the rest are not run.
      if (turn.signal?.aborted === true) {
        cancelAfter(turn, editable, index - 1, 'plan', prefix);
        return { ok: false, cancelled: true, effect: completed.length > 0, completed, ...(undoGroupId === undefined ? {} : { undoGroupId }) };
      }
      const id = callIdFor('plan', prefix, index);
      if (awaited(step.tool)) {
        if (loadedExternal(step.tool) === undefined) {
          // A native async step (coherence.review) of an approved plan: the plan's approval covers it, so it runs at once.
          const proposal = acceptedCut ? stripCut([editable.proposals[index]])[0] : editable.proposals[index];
          const native = await runAwaited(turn, index, step, id, 'plan', proposal);
          if (!native.ok) {
            cancelAfter(turn, editable, index, 'plan', prefix);
            return { ...native, completed, ...(undoGroupId === undefined ? {} : { undoGroupId }) };
          }
          completed.push(index);
          index += 1;
          continue;
        }
        if (riskOf(step.tool) === 'read') {
          const read = await runAwaited(turn, index, step, id, 'read', undefined);
          if (!read.ok) {
            cancelAfter(turn, editable, index, 'plan', prefix);
            return { ...read, completed };
          }
          completed.push(index);
          index += 1;
          continue;
        }
        // An external write: its own one-step card, shown with the step as the writer approved it in the plan (or as it stands).
        const decided = await decideCard(turn, 'confirm', id, { editable: oneStep(step, index, editable.proposals[index]), from: 0, revision: 0, nested: true });
        if (decided.settled === 'cancelled') {
          turn.cards.push({ kind: 'confirm', tools: [step.tool], decision: 'cancelled', edits: decided.edits, retries: decided.retries });
          moveCard(turn, id, 'cancelled');
          turn.steps.push({ index, tool: step.tool, expect: step.expect, status: 'cancelled' });
          cancelAfter(turn, editable, index, 'plan', prefix);
          return { ok: false, cancelled: true, effect: completed.length > 0, completed, ...(undoGroupId === undefined ? {} : { undoGroupId }) };
        }
        if (decided.settled === 'refused') {
          moveCard(turn, id, 'cancelled');
          cancelAfter(turn, editable, index, 'plan', prefix);
          return {
            ok: false,
            failedAt: index,
            effect: completed.length > 0,
            askBack: askBackFor(decided.error ?? refusal('internal', 'the card could not be checked', { correctiveHint: 'send the request again' })),
            completed,
            ...(undoGroupId === undefined ? {} : { undoGroupId }),
          };
        }
        turn.cards.push({ kind: 'confirm', tools: [step.tool], decision: 'approved', edits: decided.edits, retries: decided.retries });
        phase(turn, 'running');
        const approved = decided.editable.steps[0] ?? step;
        // The step the writer left in the card is the call's answer, even when an edit made it a new object.
        transferWire(turn, step, approved);
        const write = await runAwaited(turn, index, approved, id, 'confirmed', undefined);
        if (!write.ok) {
          cancelAfter(turn, editable, index, 'plan', prefix);
          return { ...write, completed, ...(undoGroupId === undefined ? {} : { undoGroupId }) };
        }
        completed.push(index);
        index += 1;
        continue;
      }
      // A run of native steps, up to the next external one. The sub-plan carries the steps before the run as well, so a step in
      // it may name what an earlier native step created; `from` makes the harness run the run alone.
      let end = index;
      while (end < editable.steps.length && !awaited((editable.steps[end] as PlanStep).tool)) end += 1;
      const result = await planRun(
        turn,
        { steps: editable.steps.slice(0, end) },
        { turnId: turn.id, callId: `${prefix}.s${index}` },
        { from: index, proposals: acceptedCut ? stripCut(editable.proposals.slice(0, end)) : editable.proposals.slice(0, end), ...signalOf(turn) },
      );
      if (!result.ok) {
        cancelAfter(turn, editable, index - 1, 'plan', prefix);
        return { ok: false, failedAt: index, effect: false, askBack: askBackFor(result.error), completed };
      }
      const outcome = result.value;
      if (outcome.status === 'refused') {
        cancelAfter(turn, editable, index - 1, 'plan', prefix);
        return {
          ok: false,
          failedAt: index,
          effect: false,
          completed,
          askBack: askBackFor(refusal('invalid-params', 'the plan was refused before anything ran', { correctiveHint: 'correct the refused steps and resend the plan' })),
        };
      }
      const finished = outcome.status === 'applied' ? outcome.steps : outcome.completed;
      for (const done of finished) {
        const ran = editable.steps[done.index] as PlanStep;
        const doneId = callIdFor('plan', prefix, done.index);
        cardFor(turn, doneId, ran.tool, ran.params, 'pending-approval');
        moveCard(turn, doneId, 'running');
        turn.trace.push({ tool: ran.tool, callId: doneId, outcome: 'ok', params: ran.params });
        turn.steps.push({ index: done.index, tool: ran.tool, expect: ran.expect, status: 'done', summary: done.value.summary, data: done.value.data });
        moveCard(turn, doneId, 'done', { summary: done.value.summary });
        wireResult(turn, ran, { ok: true, body: done.value.data });
        completed.push(done.index);
      }
      if (outcome.undoGroupId !== undefined) undoGroupId ??= outcome.undoGroupId;
      if (outcome.status === 'applied') {
        index = end;
        continue;
      }
      if (outcome.status === 'stopped') {
        cancelAfter(turn, editable, outcome.stoppedAt - 1, 'plan', prefix);
        return { ok: false, cancelled: true, effect: completed.length > 0, completed, ...(undoGroupId === undefined ? {} : { undoGroupId }) };
      }
      const failedIndex = outcome.failedAt;
      const failed = editable.steps[failedIndex] as PlanStep;
      const failedId = callIdFor('plan', prefix, failedIndex);
      const reason = errorSummary(outcome.error);
      cardFor(turn, failedId, failed.tool, failed.params, 'pending-approval');
      moveCard(turn, failedId, 'running');
      turn.trace.push({ tool: failed.tool, callId: failedId, outcome: 'refused', code: outcome.error.code, params: failed.params });
      turn.steps.push({ index: failedIndex, tool: failed.tool, expect: failed.expect, status: 'failed', error: reason });
      moveCard(turn, failedId, 'failed', { error: reason });
      wireResult(turn, failed, { ok: false, body: reason });
      cancelAfter(turn, editable, failedIndex, 'plan', prefix);
      return {
        ok: false,
        failedAt: failedIndex,
        effect: outcome.error.details?.['completedCommands'] !== undefined,
        askBack: outcome.askBack,
        completed,
        ...(undoGroupId === undefined ? {} : { undoGroupId }),
      };
    }
    return { ok: true, effect: true, completed, ...(undoGroupId === undefined ? {} : { undoGroupId }) };
  }

  /**
   * `grant` is how the run is authorised, and the bus records it: `auto` for a write-auto call (no
   * approval needed, and none is passed), `confirmed` for a one-step confirm card, and a plan's steps
   * run under the approval the plan card carries (the harness passes that itself). An external step is
   * called through `mcp.invoke`, under the confirmation its own card gave.
   */
  async function runCard(
    turn: Turn,
    editable: EditableSteps,
    from: number,
    kind: 'plan' | 'confirm',
    prefix: string,
    grant: 'auto' | 'confirmed',
    acceptedCut: boolean = false,
  ): Promise<Executed> {
    if (kind === 'plan' && editable.steps.some((step) => awaited(step.tool))) {
      return runMixed(turn, editable, from, prefix, acceptedCut);
    }
    if (kind === 'confirm' && awaited((editable.steps[from] as PlanStep).tool)) {
      return runAwaited(turn, from, editable.steps[from] as PlanStep, callIdFor(kind, prefix, from), 'confirmed', acceptedCut ? stripCut([editable.proposals[from]])[0] : editable.proposals[from]);
    }
    if (kind === 'confirm') {
      const step = editable.steps[from] as PlanStep;
      const id = callIdFor(kind, prefix, from);
      const proposal = acceptedCut ? stripCut([editable.proposals[from]])[0] : editable.proposals[from];
      cardFor(turn, id, step.tool, step.params, grant === 'auto' ? 'running' : 'pending-approval');
      moveCard(turn, id, 'running');
      await logIntent(turn, id, from, step.tool);
      const before = revisionsNow();
      const outcome: ToolOutcome = harness.call(
        { name: step.tool, callId: id, params: step.params, ...(proposal === undefined ? {} : { proposal }) },
        grant === 'auto' ? { turnId: turn.id } : { turnId: turn.id, permission: { confirmed: true } },
      );
      if (outcome.ok) await logApplied(turn, id, from, step.tool, outcome.value.summary, before);
      else await logFailed(turn, id, from, step.tool, outcome.error.message);
      if (outcome.ok) {
        turn.trace.push({ tool: step.tool, callId: id, outcome: 'ok', params: step.params });
        turn.steps.push({ index: from, tool: step.tool, expect: step.expect, status: 'done', summary: outcome.value.summary, data: outcome.value.data });
        moveCard(turn, id, 'done', { summary: outcome.value.summary });
        wireResult(turn, step, { ok: true, body: outcome.value.data });
        return { ok: true, ...(outcome.value.undoGroupId === undefined ? {} : { undoGroupId: outcome.value.undoGroupId }), effect: true, completed: [from] };
      }
      const reason = errorSummary(outcome.error);
      turn.trace.push({ tool: step.tool, callId: id, outcome: 'refused', code: outcome.error.code, params: step.params });
      turn.steps.push({ index: from, tool: step.tool, expect: step.expect, status: 'failed', error: reason });
      moveCard(turn, id, 'failed', { error: reason });
      wireResult(turn, step, { ok: false, body: reason });
      const group = outcome.error.details?.['undoGroupId'];
      return {
        ok: false,
        failedAt: from,
        effect: outcome.error.details?.['completedCommands'] !== undefined,
        askBack: askBackFor(outcome.error),
        completed: [],
        ...(typeof group === 'string' ? { undoGroupId: group } : {}),
      };
    }

    const result = await planRun(
      turn,
      { steps: editable.steps },
      { turnId: turn.id, callId: prefix },
      { from, proposals: acceptedCut ? stripCut(editable.proposals) : editable.proposals, ...signalOf(turn) },
    );
    if (!result.ok) return { ok: false, failedAt: from, effect: false, completed: [], askBack: askBackFor(result.error) };
    const outcome = result.value;
    if (outcome.status === 'refused') {
      return {
        ok: false,
        failedAt: from,
        effect: false,
        completed: [],
        askBack: askBackFor(refusal('invalid-params', 'the plan was refused before anything ran', { correctiveHint: 'correct the refused steps and resend the plan' })),
      };
    }
    const finished = outcome.status === 'applied' ? outcome.steps : outcome.completed;
    for (const done of finished) {
      const step = editable.steps[done.index] as PlanStep;
      const id = callIdFor(kind, prefix, done.index);
      cardFor(turn, id, step.tool, step.params, 'pending-approval');
      moveCard(turn, id, 'running');
      turn.trace.push({ tool: step.tool, callId: id, outcome: 'ok', params: step.params });
      turn.steps.push({ index: done.index, tool: step.tool, expect: step.expect, status: 'done', summary: done.value.summary, data: done.value.data });
      moveCard(turn, id, 'done', { summary: done.value.summary });
      wireResult(turn, step, { ok: true, body: done.value.data });
    }
    const completed = finished.map((done) => done.index);
    if (outcome.status === 'applied') {
      return { ok: true, ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }), effect: true, completed };
    }
    if (outcome.status === 'stopped') {
      // The steps before the stop are applied and kept; the stopped step and the rest are not run (agent-harness §2).
      cancelAfter(turn, editable, outcome.stoppedAt - 1, kind, prefix);
      return { ok: false, cancelled: true, effect: completed.length > 0, completed, ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }) };
    }
    const failedIndex = outcome.failedAt;
    const failed = editable.steps[failedIndex] as PlanStep;
    const failedId = callIdFor(kind, prefix, failedIndex);
    const reason = errorSummary(outcome.error);
    cardFor(turn, failedId, failed.tool, failed.params, 'pending-approval');
    moveCard(turn, failedId, 'running');
    turn.trace.push({ tool: failed.tool, callId: failedId, outcome: 'refused', code: outcome.error.code, params: failed.params });
    turn.steps.push({ index: failedIndex, tool: failed.tool, expect: failed.expect, status: 'failed', error: reason });
    moveCard(turn, failedId, 'failed', { error: reason });
    wireResult(turn, failed, { ok: false, body: reason });
    for (let index = failedIndex + 1; index < editable.steps.length; index += 1) {
      if (ranAt(editable, index)) continue;
      const later = editable.steps[index] as PlanStep;
      const id = callIdFor(kind, prefix, index);
      cardFor(turn, id, later.tool, later.params, 'pending-approval');
      moveCard(turn, id, 'cancelled');
      turn.trace.push({ tool: later.tool, callId: id, outcome: 'not-run', params: later.params });
      turn.steps.push({ index, tool: later.tool, expect: later.expect, status: 'cancelled' });
    }
    const group = outcome.undoGroupId;
    return {
      ok: false,
      failedAt: failedIndex,
      effect: outcome.error.details?.['completedCommands'] !== undefined,
      askBack: outcome.askBack,
      completed,
      ...(group === undefined ? {} : { undoGroupId: group }),
    };
  }

  /** The adjusted step the model sends for a refused one. Anything other than one step of the same tool is not an adjustment. */
  async function adjustStep(turn: Turn, tool: string): Promise<PlanStep | undefined> {
    await syncRun(turn, 1, 'running');
    const reply = await complete(plannerCall(turn), turn.messages, turn.native ? undefined : { jsonSchemaHint: REPLY_SCHEMA_HINT });
    turn.messages.push(assistantOf(reply));
    if (turn.native) {
      const calls = reply.toolCalls ?? [];
      const only = calls.length === 1 ? calls[0] : undefined;
      if (only === undefined || only.name !== tool) return undefined;
      const args = callArgs(only);
      if (args.error !== undefined) return undefined;
      // The adjustment's call is registered like a plan's: its result is flushed at the next request.
      turn.wireReplies.push({ calls, results: new Map() });
      const step: PlanStep = { tool, params: args.params ?? {}, expect: expectOf(reply.text) };
      turn.wireSteps.set(step, only);
      return step;
    }
    const parsed = parseReply(reply.text);
    if (!parsed.ok || parsed.value.kind !== 'steps') return undefined;
    const steps = parsed.value.plan.steps;
    const only = steps[0];
    if (steps.length !== 1 || only === undefined || only.tool !== tool) return undefined;
    return only;
  }

  /**
   * The write path of a reply: a card per decision, the run, and the verify ladder on a refusal that
   * changed nothing. Returns the turn's end, or `continue` when a refused preflight went back to the model.
   */
  async function runWrites(turn: Turn, plan: Plan, staged: Staged, restore?: { readonly kind: 'plan' | 'confirm'; readonly completed: readonly number[] }): Promise<Settled | 'continue'> {
    const single = plan.steps.length === 1 ? (plan.steps[0] as PlanStep) : undefined;
    // A rule that asks gives a single write-auto call the one-step card a write-confirm call has (agent-harness §4, "Rules").
    const asked = single !== undefined && asksWriter(single);
    const kind: 'plan' | 'confirm' = restore?.kind ?? (single !== undefined && (riskOf(single.tool) === 'write-confirm' || asked) ? 'confirm' : 'plan');
    // A single write-auto call runs at once: a reversible op skips the plan (agent-harness §2). A card restored from a log is shown, not run.
    const auto = restore === undefined && single !== undefined && !asked && riskOf(single.tool) !== 'write-confirm' && staged.stale?.some(Boolean) !== true;
    if (plan.steps.some((step) => step.params['selection'] !== undefined)) await preloadAnchorLibraries();

    let editable: EditableSteps = {
      steps: plan.steps,
      origins: plan.steps.map((_, index) => index),
      proposals: staged.proposals,
      stale: plan.steps.map((_, index) => staged.stale?.[index] === true),
      superseded: [],
      completed: [...(restore?.completed ?? [])],
    };
    // Steps run in order, so what a restored card has run is its first steps and the card is checked from the first that has not.
    let from = 0;
    while (ranAt(editable, from)) from += 1;
    const prefix = nextCallPrefix(turn, auto ? 'a' : 'p');
    const checked = cardOf(turn, editable, from, 0, kind, undefined);
    if ('refused' in checked) return { status: 'failed', askBack: askBackFor(checked.refused) };

    if (single !== undefined && auto) {
      // A single write-auto call has no card to refuse on, so its refusal goes back to the model to correct.
      if (!checked.preflight.ok) {
        const refusedEntry = checked.preflight.steps.find((entry) => entry.status === 'refused');
        refusedBeforeCard(turn, single, refusalSentence(refusedEntry?.error?.message ?? 'refused', refusedEntry?.error?.correctiveHint));
        // The call's own tool message goes first, so the refusal text that follows reads as its explanation.
        flushWire(turn);
        turn.messages.push({ role: 'user', content: refusedStepsMessage(checked.preflight) });
        return 'continue';
      }
      // A mode that decides cards holds this write to the budgets as it holds a card (agent-harness §4).
      if (policyOf(turn).decides) holdToBudget(turn, editable, plan.steps);
      await logCard(turn, 'confirm', editable, 'running');
      await turn.run?.append({ t: 'card.decided', turnId: turn.id, decision: 'auto' });
      const executed = await execute(turn, editable, 0, 'confirm', prefix, 'auto');
      turn.cards.push({ kind: 'auto', tools: [single.tool], decision: 'auto', edits: 0, retries: 0 });
      return settle(turn, executed);
    }

    let ladder = 0;
    let retries = 0;
    let edits = 0;
    let attempt = 0;
    let attemptPrefix = prefix;
    let notice: string | undefined = staged.notice;
    for (;;) {
      const decided = await decideCard(turn, kind, attemptPrefix, { editable, from, revision: edits + retries, ...(notice === undefined ? {} : { notice }) });
      notice = undefined;
      // The card may have replaced a step's object: its wire call follows the step the writer approved.
      reconcileWire(turn, editable, decided.editable);
      editable = decided.editable;
      edits += decided.edits;
      retries += decided.retries;
      if (decided.settled === 'refused') {
        return { status: 'failed', askBack: askBackFor(decided.error ?? refusal('internal', 'the card could not be checked', { correctiveHint: 'send the request again' })) };
      }
      const tools = editable.steps.slice(from).map((step) => step.tool);
      if (decided.settled === 'cancelled') {
        turn.cards.push({ kind, tools, decision: 'cancelled', edits, retries });
        for (const [index, step] of editable.steps.entries()) {
          if (index < from || ranAt(editable, index)) continue;
          const id = callIdFor(kind, attemptPrefix, index);
          moveCard(turn, id, 'cancelled');
          turn.steps.push({ index, tool: step.tool, expect: step.expect, status: 'cancelled' });
        }
        // A note sent with the Cancel (agent-harness §2): the plan is cancelled as any is, and the turn goes back to the model with
        // the note instead of ending. A stopped turn ends.
        if (turn.converses && turn.signal?.aborted !== true && turn.notes.some((note) => note.deliveredAtCall === undefined)) {
          flushWire(turn);
          turn.messages.push({ role: 'user', content: PLAN_CANCELLED_MESSAGE });
          return 'continue';
        }
        return { status: 'cancelled' };
      }
      turn.cards.push(decided.auto === true ? { kind: 'auto', tools, decision: 'auto', edits, retries } : { kind, tools, decision: 'approved', edits, retries });
      phase(turn, 'running');
      const acceptedCut = decided.acceptedCut === true;
      const executed = await execute(turn, editable, from, kind, attemptPrefix, 'confirmed', acceptedCut);
      editable = { ...editable, completed: [...editable.completed, ...executed.completed.map((index) => editable.origins[index] ?? index)] };
      if (executed.ok) return settle(turn, executed);
      // A writer declined an external write's card mid-run: the steps before it are applied and kept, and the turn ends as cancelled.
      if (executed.cancelled === true) return { status: 'cancelled' };

      const failedAt = executed.failedAt ?? from;
      const askBack = executed.askBack as AskBack;
      const failed = editable.steps[failedAt] as PlanStep;
      attempt += 1;

      // A draft the document has moved on from: it is kept, marked stale, and the card is shown again so the
      // user retries it or cancels. The model is not asked to rewrite it (agent-harness §8).
      if (askBack.code === 'conflict' && !executed.effect && MODEL_BACKED.has(failed.tool)) {
        const stale = editable.stale.map((flag, index) => (index === failedAt ? true : flag));
        editable = { ...editable, stale };
        from = failedAt;
        attemptPrefix = `${prefix}.retry${attempt}`;
        notice = `${askBack.reason} The draft was kept: retry it against the current text, or cancel the card.`;
        continue;
      }

      if (!ADJUSTABLE.has(askBack.code) || executed.effect || ladder >= maxRetries || turn.restored) return settle(turn, executed);

      // Verify ladder, rung one: the model adjusts the refused step, and the card is shown again for approval.
      if (callsLeft(turn) < 1) return settle(turn, executed);
      ladder += 1;
      phase(turn, 'retrying');
      emit({ type: 'ladder', turnId: turn.id, callId: callIdFor(kind, attemptPrefix, failedAt), attempt: ladder, askBack });
      // The run's calls are answered first: the failed step's tool message carries its refusal, and the
      // corrective text that follows names what to correct, as the JSON wire's retry does.
      flushWire(turn);
      turn.messages.push({ role: 'user', content: retryMessage(failedAt, failed.tool, askBack, turn.native) });
      const adjusted = await adjustStep(turn, failed.tool);
      if (adjusted === undefined) return settle(turn, executed);

      const steps = editable.steps.map((step, index) => (index === failedAt ? adjusted : step));
      const proposals = editable.proposals.map((value, index) => (index === failedAt ? undefined : value));
      // The adjusted step has no draft yet: a model-backed one is drafted just below, which clears the flag; any other one is
      // checked again by its preflight when the card is shown, so its flag stays clear.
      const stale = editable.stale.map((flag, index) => (index === failedAt ? false : flag));
      const superseded = [...editable.superseded, { origin: editable.origins[failedAt] ?? failedAt, step: failed }];
      editable = { ...editable, steps, proposals, stale, superseded };
      if (MODEL_BACKED.has(adjusted.tool)) {
        const redrafted = await redraft(turn, editable, (index) => index === failedAt);
        if (redrafted.refusal !== undefined) return { status: 'failed', askBack: askBackFor(refusal('invalid-params', redrafted.refusal, { correctiveHint: 'draft the step again' })) };
        editable = redrafted.editable;
      }
      from = failedAt;
      attemptPrefix = `${prefix}.retry${attempt}`;
      retries += 1;
    }
  }

  /** The settled outcome of a run. The summary names the writes, not the reads. */
  function settle(turn: Turn, executed: Executed): Settled {
    if (executed.ok) {
      const writes = writesOf(turn);
      return { status: 'applied', summary: writes.length > 0 ? writes.join('; ') : 'nothing changed' };
    }
    return { status: 'failed', askBack: executed.askBack ?? askBackFor(refusal('internal', 'the step failed without a reason', { correctiveHint: 'send the request again' })) };
  }

  function phase(turn: Turn, to: TurnPhase): void {
    turn.phase = to;
    emit({ type: 'turn', turnId: turn.id, phase: to, ...(to === 'started' ? { mode: turn.mode } : {}) });
  }

  /**
   * Hands the model the notes the writer sent since its last request (agent-harness §2): one user message per note, after the
   * previous reply's tool messages so the conversation stays valid on the native wire. A note a card is still waiting on is
   * not here yet; it lands after the decision.
   */
  function deliverNotes(turn: Turn): void {
    const waiting = turn.notes.filter((note) => note.deliveredAtCall === undefined);
    if (waiting.length === 0) return;
    if (turn.native) flushWire(turn);
    for (const note of waiting) {
      note.deliveredAtCall = turn.modelCalls + 1;
      turn.messages.push({ role: 'user', content: steeringMessage(note.text) });
      emit({ type: 'steer', turnId: turn.id, note: { noteId: note.noteId, text: note.text, deliveredAtCall: note.deliveredAtCall } });
    }
  }

  /**
   * The writer's choice for a plan that needs many model calls, asked before any of them is made (`AgentSessionOptions.beforeStage`).
   * Undefined means stage the plan now. The wait ends at once with a cancel when the writer stops the turn.
   */
  async function offerBackground(turn: Turn, plan: Plan): Promise<Settled | undefined> {
    const ask = options.beforeStage;
    const calls = estimatedModelCalls(plan.steps);
    if (ask === undefined || calls < BACKGROUND_OFFER_MIN_CALLS || !backgroundEligibility(plan.steps).eligible) return undefined;
    checkStop(turn);
    phase(turn, 'awaiting-approval');
    const { signal } = turn;
    turn.deciding = true;
    turn.meter?.pauseClock();
    let release = (): void => {};
    try {
      const asked = ask({ turnId: turn.id, steps: plan.steps, estimatedCalls: calls, turnCap: maxModelCalls });
      const stopped = new Promise<OfferAnswer>((resolve) => {
        if (signal === undefined) return;
        const onAbort = (): void => resolve('cancel');
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        release = () => signal.removeEventListener('abort', onAbort);
      });
      const answer = await Promise.race([asked, stopped]);
      if (signal?.aborted === true || answer === 'cancel') return { status: 'cancelled' };
      if (answer === 'now') return undefined;
      return { status: 'replied', text: `Queued in the background: ${calls} model ${calls === 1 ? 'call' : 'calls'}. Results appear in Tasks when ready.` };
    } finally {
      release();
      turn.meter?.resumeClock();
      turn.deciding = false;
    }
  }

  /** The model conversation of one turn: a reply, parsed, with a bad one answered by the words it needs. */
  async function converse(turn: Turn): Promise<Settled> {
    for (;;) {
      checkStop(turn);
      if (callsLeft(turn) < 1) return { status: 'failed', askBack: budgetAskBack(maxModelCalls) };
      phase(turn, 'planning');
      // The loaded-tools addendum is read for each request, not once per turn: a search earlier in this turn may have loaded
      // a tool the model has not been told about yet. It is sent again only when the set has changed (context-assembly §2).
      const addendum = harness.loadedAddendum();
      if (addendum !== undefined && addendum !== turn.addendumSent) {
        turn.messages.push({ role: 'user', content: addendum });
        turn.addendumSent = addendum;
      }
      deliverNotes(turn);
      await syncRun(turn, 1, 'running');
      const reply = await complete(plannerCall(turn), turn.messages, turn.native ? undefined : { jsonSchemaHint: REPLY_SCHEMA_HINT });
      turn.messages.push(assistantOf(reply));

      let plan: Plan;
      if (turn.native) {
        // A reply's calls are the plan's steps, in the order they were made; its text is the card's
        // rationale. A call whose arguments do not parse is refused back by its id, like a JSON reply
        // that could not be parsed, and nothing of the reply is staged.
        const calls = reply.toolCalls ?? [];
        if (calls.length === 0) return { status: 'replied', text: reply.text };
        const pending: WireReply = { calls, results: new Map() };
        turn.wireReplies.push(pending);
        const steps: PlanStep[] = [];
        const malformed: { index: number; tool: string; message: string }[] = [];
        for (const [index, call] of calls.entries()) {
          const args = callArgs(call);
          const step: PlanStep = { tool: call.name, params: args.params ?? {}, expect: expectOf(reply.text) };
          steps.push(step);
          turn.wireSteps.set(step, call);
          if (args.error !== undefined) {
            malformed.push({ index, tool: call.name, message: args.error });
            pending.results.set(call.id, { ok: false, body: args.error });
          }
        }
        if (malformed.length > 0) {
          flushWire(turn);
          turn.messages.push({
            role: 'user',
            content: malformed.map((refused) => `Step ${refused.index + 1} (${refused.tool}) was refused: ${refused.message}`).join('\n'),
          });
          continue;
        }
        // The native reply is bound by the same plan schema as the JSON reply (plan.ts `PLAN_STEPS_MAX`):
        // an over-bound reply is refused back to the model, answered by every call's id, and none of it
        // runs — the JSON wire's own feedback, instead of a turn that fails at the card or runs unbounded
        // reads. The validated copy is only the check; the steps below stay the objects `wireSteps` keys on.
        const bounded = parsePlan({ steps });
        if (!bounded.ok) {
          const words = stepsRefusalMessage(bounded.error);
          for (const call of calls) pending.results.set(call.id, { ok: false, body: words });
          flushWire(turn);
          turn.messages.push({ role: 'user', content: words });
          continue;
        }
        plan = { steps };
      } else {
        const parsed: Result<Reply, string> = parseReply(reply.text);
        if (!parsed.ok) {
          turn.messages.push({ role: 'user', content: parsed.error });
          continue;
        }
        if (parsed.value.kind === 'reply') return { status: 'replied', text: parsed.value.text };
        plan = parsed.value.plan;
      }

      guardRepeats(turn, plan.steps);
      const offered = policyOf(turn).readOnly ? undefined : await offerBackground(turn, plan);
      if (offered !== undefined) return offered;
      const staged = await stage(turn, plan.steps);
      if (staged.refusals.length > 0) {
        flushWire(turn);
        turn.messages.push({
          role: 'user',
          content: staged.refusals.map((refused) => `Step ${refused.index + 1} (${refused.tool}) was refused: ${refused.message}`).join('\n'),
        });
        continue;
      }
      if (plan.steps.every((step) => riskOf(step.tool) === 'read')) {
        const ended = await runReads(turn, plan.steps, staged.proposals);
        if (ended !== undefined) return ended;
        continue;
      }
      const written = await runWrites(turn, plan, staged);
      if (written === 'continue') continue;
      return written;
    }
  }

  /**
   * The writer-facing summary of a finished turn. It names what was written and never the undo group's id: the id is an
   * internal handle, and the checkpoint row (`CHECKPOINT_LABEL`) is where the writer restores the turn.
   */
  function reportOf(turn: Turn, settled: Settled, tokens: { promptTokens: number; completionTokens: number; requests: number }): TurnReport {
    const writes = writesOf(turn);
    const summary =
      settled.status === 'replied'
        ? (settled.text ?? '')
        : settled.status === 'applied'
          ? `Applied: ${settled.summary ?? 'the turn'}.`
          : settled.status === 'cancelled'
            ? settled.stop !== undefined
              ? writes.length === 0
                ? 'Stopped by you. Nothing was written.'
                : `Stopped by you. Written before the stop: ${writes.join('; ')}.`
              : writes.length === 0
                ? 'Cancelled. Nothing was written.'
                : `Cancelled. Written before the cancel: ${writes.join('; ')}.`
            : `Stopped: ${settled.askBack?.reason ?? 'the turn did not finish'}${writes.length === 0 ? '' : ` Written before the stop: ${writes.join('; ')}.`}`;
    return {
      turnId: turn.id,
      status: settled.status,
      ...(settled.status === 'replied' ? { text: settled.text ?? '' } : {}),
      summary,
      steps: turn.steps,
      cards: turn.cards,
      trace: turn.trace,
      ...(turn.undoGroupId === undefined ? {} : { undoGroupId: turn.undoGroupId }),
      ...(settled.askBack === undefined ? {} : { askBack: settled.askBack }),
      tokens,
      dropped: turn.dropped,
      modelCalls: turn.modelCalls,
      ...(settled.stop === undefined ? {} : { stop: settled.stop }),
      ...(settled.budgetStop === undefined ? {} : { budgetStop: settled.budgetStop }),
      ...(turn.meter === undefined ? {} : { spend: turn.meter.spend() }),
      ...(turn.notes.length === 0 ? {} : { steering: turn.notes.map((note): SteeringNote => ({ ...note })) }),
      mode: turn.mode,
      budgetUse: usageOf(turn),
      ...(turn.held.length === 0 ? {} : { heldSteps: turn.held }),
    };
  }

  /** The planner's turn: the request goes to the model, which answers or proposes steps (agent-harness §2). */
  async function plannedTurn(turn: Turn, intent: string, preload: readonly ToolName[]): Promise<Settled> {
    // The wire is picked here, once per turn, from the model's capabilities: native tool calls when the
    // model can take them, the JSON envelope otherwise. The system message states the protocol the call
    // speaks (protocol.ts `plannerSystem`/`plannerSystemNative` — same rules, different wording).
    turn.native = nativeTools(turn) !== undefined;
    turn.converses = true;
    // The planner's call is a `meta` call (context-assembly §3): the protocol and tool list as L0, the project
    // summary as L1, and the request as L7.
    const planner = context.assemble({
      task: { tool: 'meta', instruction: `Request: ${intent}` },
      // L0 is the core rows and nothing the turn loads, so it is the same bytes before and after a load (context-assembly §2).
      role: turn.native ? plannerSystemNative(harness.tools(), loadEvery()) : plannerSystem(harness.tools(), loadEvery()),
      turns: turn.priorTurns,
      activity: harness.log.entries(),
    });
    // The skills list (context-assembly §2): a second planner addendum beside the loaded-tools line, in a user message after the
    // system prompt and so never part of L0. A project with no skill on offer has none, and its requests are as they were.
    const skills = harness.skillCatalog();
    const dropped = [
      ...dropLinesOf(planner.prompt),
      ...(skills?.dropped ?? []).map((name) => `Skills: “${name}” is left out of the skills list (over its ${SKILL_CATALOG_TOKENS}-token budget)`),
    ];
    turn.dropped.push(...dropped);
    emit({ type: 'context', turnId: turn.id, layers: planner.prompt.layers.map((layer) => ({ id: layer.id, tokens: layer.tokens })), dropped });
    turn.messages.push(...planner.messages);
    // A preload loads the rows as a search would have, and their descriptors follow the request in the same slot a search's do
    // (`loadedToolsMessage`), so the cached prefix is untouched. Nothing is preloaded when every tool is declared already.
    // `skill.load` is preloaded whenever there is a list to load from, so the model never has to search for it.
    const wanted: readonly ToolName[] = skills === undefined ? preload : [...preload, 'skill.load'];
    if (wanted.length > 0 && !loadEvery()) {
      harness.preload(turn.id, wanted);
      const rows = harness.loadedNativeTools();
      if (rows.length > 0) {
        turn.messages.push({ role: 'user', content: loadedToolsMessage(rows) });
        turn.addendumSent = harness.loadedAddendum();
      }
    }
    if (skills !== undefined) turn.messages.push({ role: 'user', content: skills.text });
    return converse(turn);
  }

  /** A turn whose plan the app built (`submitPlan`): its drafts are staged and its cards decided, with no planner call. */
  async function givenPlanTurn(turn: Turn, plan: Plan): Promise<Settled> {
    const staged = await stage(turn, plan.steps);
    if (staged.refusals.length > 0) {
      const named = staged.refusals.map((refused) => `Step ${refused.index + 1} (${refused.tool}) was refused: ${refused.message}`).join(' ');
      return { status: 'failed', askBack: askBackFor(refusal('invalid-params', named, { correctiveHint: 'change the step before its draft can be made' })) };
    }
    const written = await runWrites(turn, plan, staged);
    if (written === 'continue') {
      return { status: 'failed', askBack: askBackFor(refusal('invalid-params', 'the plan was refused before anything ran', { correctiveHint: 'correct the step and send it again' })) };
    }
    return written;
  }

  /**
   * A turn that reviews a plan staged in the background (`submitStaged`): the stored drafts go to the card as they are, and nothing is
   * staged again. A stored plan is checked as a planner's is, and it must still be one that may run unattended.
   */
  async function stagedTurn(
    turn: Turn,
    plan: Plan,
    stored: readonly unknown[],
    revisions: readonly (StepRevisions | undefined)[],
  ): Promise<Settled> {
    const eligible = backgroundEligibility(plan.steps);
    if (!eligible.eligible) return { status: 'failed', askBack: askBackFor(refusal('invalid-params', eligible.reason, { correctiveHint: 'send the request again' })) };
    const stale = staleSteps(harness.state, plan.steps, stored, revisions);
    // A proposal that fails its shape guard never reaches the card: it is treated as a step that was not drafted.
    const proposals = plan.steps.map((step, index) => (MODEL_BACKED.has(step.tool) && proposalShapeOk(step.tool, stored[index]) ? stored[index] : undefined));
    const outdated = stale.filter(Boolean).length;
    if (plan.steps.every((step) => riskOf(step.tool) === 'read')) {
      if (outdated > 0) {
        return { status: 'failed', askBack: askBackFor(refusal('revision-conflict', 'the background result is out of date, so nothing was run', { correctiveHint: 'send the request again' })) };
      }
      const ended = await runReads(turn, plan.steps, proposals);
      if (ended !== undefined) return ended;
      return { status: 'replied', text: turn.steps.map((step) => step.summary ?? step.tool).join('; ') };
    }
    const notice =
      outdated === 0
        ? undefined
        : `${outdated} of ${plan.steps.length} ${plan.steps.length === 1 ? 'step is' : 'steps are'} out of date or could not be drafted in the background. Retry ${outdated === 1 ? 'it' : 'them'} against the current text, or drop ${outdated === 1 ? 'it' : 'them'}.`;
    const written = await runWrites(turn, plan, { proposals, refusals: [], stale, ...(notice === undefined ? {} : { notice }) });
    if (written === 'continue') {
      return { status: 'failed', askBack: askBackFor(refusal('invalid-params', 'the plan was refused before anything ran', { correctiveHint: 'correct the step and send it again' })) };
    }
    return written;
  }

  /**
   * Stages steps with no card (`stageOnly`). Each step is staged on its own, so one refused or failed step costs the others nothing.
   * Its turn is not recorded as a conversation turn: the session's record and the planner's history stay as they were.
   */
  async function stageSteps(stepsIn: readonly PlanStep[], turnOptions: TurnOptions): Promise<StageOnlyResult> {
    const parsed = parsePlan({ steps: stepsIn });
    const turn = newTurn(turnOptions, []);
    const steps = parsed.ok ? parsed.value.steps : [];
    const proposals: unknown[] = stepsIn.map(() => undefined);
    const revisions: StepRevisions[] = stepsIn.map(() => ({}));
    const refusals: { index: number; tool: string; message: string }[] = [];
    let stopped = false;
    if (!parsed.ok) {
      for (const [index, step] of stepsIn.entries()) refusals.push({ index, tool: step.tool, message: parsed.error.message });
    }
    try {
      for (const [index, step] of steps.entries()) {
        checkStop(turn);
        revisions[index] = revisionsOf(harness.state, step);
        try {
          const one = await stage(turn, [step]);
          proposals[index] = one.proposals[0];
          for (const refused of one.refusals) refusals.push({ index, tool: refused.tool, message: refused.message });
        } catch (error) {
          if (error instanceof TurnStopped || turn.signal?.aborted === true) throw new TurnStopped();
          const settled = stoppedBy(error);
          refusals.push({ index, tool: step.tool, message: settled.askBack?.reason ?? messageOf(error) });
        }
      }
    } catch (error) {
      if (!(error instanceof TurnStopped)) throw error;
      stopped = true;
    } finally {
      harness.endTurn(turn.id);
    }
    const totals = gateway.ledger.turnTotals(turn.id);
    return {
      proposals,
      revisions,
      refusals,
      stopped,
      modelCalls: turn.modelCalls,
      tokens: { promptTokens: totals.promptTokens, completionTokens: totals.completionTokens, requests: totals.requests },
    };
  }

  /**
   * One turn, from its record to its report. `first` runs the turn's steps. A failure it cannot recover from is reported in words
   * the user can act on: the turn is never left half-finished, and whatever it applied stays in its undo group.
   */
  function newTurn(turnOptions: TurnOptions, priorTurns: readonly RecentTurn[]): Turn {
    turnCounter += 1;
    const pins: Pins = {
      profileId: turnOptions.profileId ?? options.profileId,
      model: turnOptions.model ?? options.model,
      thinking: turnOptions.thinking ?? options.thinking,
    };
    latestPins = pins;
    maxModelCalls = boundNow();
    const meter = typeof options.meter === 'function' ? options.meter() : options.meter;
    const signals = [turnOptions.signal, meter?.signal].filter((signal): signal is AbortSignal => signal !== undefined);
    return {
      id: `${sessionName}.turn-${turnCounter}`,
      messages: [],
      trace: [],
      cards: [],
      steps: [],
      statusCards: [],
      dropped: [],
      priorTurns,
      modelCalls: 0,
      signal: signals.length > 1 ? anySignal(signals) : signals[0],
      meter,
      metered: 0,
      pins,
      phase: 'started',
      notes: [],
      deciding: false,
      converses: false,
      seq: 0,
      mode: modeNow(),
      budget: { ...DEFAULT_TURN_BUDGET, ...configured(), maxModelCalls },
      held: [],
      proposed: new Map(),
      native: false,
      wireReplies: [],
      delegations: 0,
      proposals: [],
      wireSteps: new Map(),
      logged: 0,
      reads: new Map(),
      restored: false,
      carried: 0,
    };
  }

  /** How a turn is logged: a new run, the run a resume continues, or not at all. */
  type LogPlan =
    | { readonly mode: 'new'; readonly wire: 'planner' | 'plan' }
    | { readonly mode: 'resume'; readonly runId: string; readonly replay: RunReplay; readonly rerun?: PendingStep }
    | { readonly mode: 'none' };

  /** Starts the turn's run in the log, or continues the one a resume names. A log that cannot be written is a turn that cannot be resumed, and no more. */
  async function openRun(turn: Turn, intent: string, plan: LogPlan): Promise<RunWriter | undefined> {
    const log = options.runLog;
    if (log === undefined || plan.mode === 'none') return undefined;
    const runId = plan.mode === 'resume' ? plan.runId : (log.newRunId?.() ?? `run_${newId('cmd').slice('cmd_'.length)}`);
    const writer = createRunWriter({ port: log.port, runId, nextSeq: plan.mode === 'resume' ? plan.replay.nextSeq : 0, clock: now, ...(log.onNotice === undefined ? {} : { onNotice: log.onNotice }) });
    if (plan.mode === 'new') {
      try {
        await log.port.create(
          newRunRecord(runId, {
            projectId: log.projectId,
            intent,
            now: now(),
            ...(turn.pins.profileId === undefined ? {} : { profileId: turn.pins.profileId }),
            ...(turn.pins.model === undefined ? {} : { model: turn.pins.model }),
          }),
        );
      } catch (error) {
        writer.fail(error);
        return writer;
      }
    }
    await writer.append(
      {
        t: 'turn.start',
        v: RUN_LOG_VERSION,
        turnId: turn.id,
        intent,
        wire: plan.mode === 'new' ? plan.wire : plan.replay.wire,
        native: plan.mode === 'new' ? nativeTools(turn) !== undefined : plan.replay.native,
        ...(plan.mode === 'resume' ? { resumedFrom: plan.replay.turnId } : {}),
        // A restored card builds no new prompt, so the conversation behind it keeps the filter it was built with.
        withheld: plan.mode === 'resume' && plan.replay.card !== undefined ? plan.replay.withheld : [...harness.withheldAnywhere()].sort(),
      },
      { status: 'running' },
    );
    // The step the earlier run ended inside never finished and runs again under a call id of this turn's, so the old record is closed.
    if (plan.mode === 'resume' && plan.rerun !== undefined) {
      await writer.append({ t: 'step.failed', turnId: turn.id, callId: plan.rerun.callId, index: plan.rerun.index, tool: plan.rerun.tool, error: 'the run was interrupted before this step was recorded as applied' });
    }
    return writer;
  }

  /** Ends the run's log with the turn: what it wrote last, its spend, and how it ended. */
  async function closeRun(turn: Turn, report: TurnReport): Promise<void> {
    if (turn.run === undefined) return;
    await syncRun(turn, 0);
    await turn.run.append({ t: 'turn.end', turnId: turn.id, status: report.status, summary: report.summary }, { status: statusOfTurn(report.status) });
  }

  async function runTurn(
    intent: string,
    turnOptions: TurnOptions,
    first: (turn: Turn) => Promise<Settled>,
    logPlan: LogPlan = { mode: 'new', wire: 'planner' },
  ): Promise<TurnReport> {
    // The turns before this one are what L6 may show; this turn's intent is recorded for the ones after it.
    const turn = newTurn(turnOptions, [...started]);
    if (logPlan.mode === 'resume') turn.modelCalls = (logPlan.replay.spend?.modelCalls ?? 0) + logPlan.replay.reservedCalls;
    turn.run = await openRun(turn, intent, logPlan);
    const slot = started.push({ turnId: turn.id, intent }) - 1;
    running.set(turn.id, turn);
    if (policyOf(turn).decides) takeBase(turn);
    phase(turn, 'started');

    let settled: Settled;
    try {
      settled = await first(turn);
    } catch (error) {
      settled = stoppedBy(error);
    }
    running.delete(turn.id);
    // A turn the writer stopped says so, and in the phase the stop took effect in. A card still waiting is cancelled with it.
    // A turn the meter's time limit aborted is not the writer's stop: it failed on a limit, and says which (agent-harness §7.1).
    const limitStop = turn.meter?.stopped();
    if (settled.status === 'cancelled' && turn.signal?.aborted === true) {
      if (turnOptions.signal?.aborted !== true && limitStop !== undefined) {
        settled = { status: 'failed', askBack: askBackOf({ ...runLimitWords(limitStop), code: 'budget_exhausted' }), budgetStop: limitStop };
      } else {
        settled = { ...settled, stop: { by: 'user', during: turn.phase } };
      }
      for (const card of [...turn.statusCards]) moveCard(turn, card.id, 'cancelled');
    }
    // A call a limit cut short that its tool absorbs (a review reports what it had, with a note) leaves the turn's status as the tool reported it.
    if (limitStop !== undefined && settled.budgetStop === undefined && turnOptions.signal?.aborted !== true) settled = { ...settled, budgetStop: limitStop };
    syncSteps(turn);

    harness.endTurn(turn.id);
    const totals = gateway.ledger.turnTotals(turn.id);
    const report = reportOf(turn, settled, { promptTokens: totals.promptTokens, completionTokens: totals.completionTokens, requests: totals.requests });
    finished.push(report);
    sessionUse = addUse(sessionUse, report.budgetUse);
    await closeRun(turn, report);
    // What L6 reads for this turn once its activity rows are gone, or when it wrote none: a reply's own answer is its outcome.
    started[slot] = {
      turnId: turn.id,
      intent,
      outcome: clipOutcome(report.summary),
      ...(report.undoGroupId === undefined ? {} : { undoGroupId: report.undoGroupId }),
    };
    // A turn that called an external tool carries the scope note on its checkpoint: the undo can reverse Caotang's changes only.
    const mixed = turn.trace.some((row) => row.tool.startsWith('mcp__'));
    if (report.undoGroupId !== undefined) {
      emit({
        type: 'checkpoint',
        turnId: turn.id,
        undoGroupId: report.undoGroupId,
        label: CHECKPOINT_LABEL,
        ...(mixed ? { note: EXTERNAL_CHECKPOINT_NOTE } : turn.carried > 0 ? { note: RESUMED_CHECKPOINT_NOTE } : {}),
        mode: report.mode,
      });
    }
    phase(turn, settled.status === 'replied' || settled.status === 'applied' ? 'done' : settled.status === 'cancelled' ? 'cancelled' : 'failed');
    emit({ type: 'report', turnId: turn.id, report });
    return report;
  }

  /**
   * The turn a log describes, rebuilt (`resume`). A card the run was showing is shown again with its applied steps done and its drafts marked
   * out of date where their documents moved, and it ends the turn when it is decided: the conversation behind a restored card is not
   * continued, because its tool results were never written down. A run between cards asks the model again from the logged conversation, after
   * a note that the last reply was never acted on.
   */
  async function resumedTurn(turn: Turn, replay: RunReplay): Promise<Settled> {
    turn.restored = true;
    turn.carried = replay.applied.length;
    turn.messages.push(...replay.messages);
    turn.logged = turn.messages.length;
    turn.native = replay.native;
    const card = replay.card;
    for (const applied of replay.applied) {
      const step = card?.completed.includes(applied.index) === true ? card.steps[applied.index] : undefined;
      turn.steps.push({ index: applied.index, tool: applied.tool, expect: step?.expect ?? '', status: 'done', ...(applied.summary === undefined ? {} : { summary: applied.summary }) });
      turn.trace.push({ tool: applied.tool, callId: applied.callId, outcome: 'ok', params: step?.params ?? {} });
    }

    if (card !== undefined) {
      if (card.decision === 'cancelled' || card.decision === 'refused') return { status: 'cancelled' };
      const parsed = parsePlan({ steps: card.steps });
      if (!parsed.ok) return { status: 'failed', askBack: askBackFor(parsed.error) };
      const plan = parsed.value;
      const done = card.completed;
      if (plan.steps.every((_, index) => done.includes(index))) {
        const writes = writesOf(turn);
        return { status: 'applied', summary: writes.length > 0 ? writes.join('; ') : 'nothing changed' };
      }
      // A step already applied is not stale: its document moved because it ran.
      const stale = staleSteps(harness.state, plan.steps, card.proposals, card.revisions).map((flag, index) => flag && !done.includes(index));
      const proposals = plan.steps.map((step, index) => (MODEL_BACKED.has(step.tool) && proposalShapeOk(step.tool, card.proposals[index]) ? card.proposals[index] : undefined));
      for (const [index, step] of plan.steps.entries()) {
        const read = card.revisions[index];
        if (read !== undefined) turn.reads.set(step, read);
      }
      const outdated = stale.filter(Boolean).length;
      const notice =
        outdated === 0
          ? undefined
          : `${outdated} of ${plan.steps.length} ${plan.steps.length === 1 ? 'step is' : 'steps are'} out of date: the text changed after ${outdated === 1 ? 'its draft was' : 'their drafts were'} made. Retry ${outdated === 1 ? 'it' : 'them'} against the current text, or drop ${outdated === 1 ? 'it' : 'them'}.`;
      const written = await runWrites(turn, plan, { proposals, refusals: [], stale, ...(notice === undefined ? {} : { notice }) }, { kind: card.kind, completed: done });
      if (written === 'continue') {
        return { status: 'failed', askBack: askBackFor(refusal('invalid-params', 'the plan was refused before anything ran', { correctiveHint: 'correct the step and send it again' })) };
      }
      return written;
    }

    turn.converses = true;
    const last = turn.messages.at(-1);
    if (last?.role === 'assistant') {
      for (const call of last.toolCalls ?? []) {
        turn.messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify({ ok: false, error: INTERRUPTED_CALL }), isError: true });
      }
      turn.messages.push({ role: 'user', content: INTERRUPTED_REPLY });
    }
    return converse(turn);
  }

  async function resumeRun(runId: string, resumeOptions: TurnOptions): Promise<TurnReport> {
    /** A resume that cannot start: reported as a failed turn that names why, with the run left as it was for the writer to discard or try again. */
    const refuse = (intent: string, askBack: AskBack): Promise<TurnReport> =>
      runTurn(intent, resumeOptions, () => Promise.resolve<Settled>({ status: 'failed', askBack }), { mode: 'none' });
    const log = options.runLog;
    if (log === undefined) return refuse(RESUME_INTENT, { code: 'needs_input', reason: 'this session keeps no run log, so there is nothing to resume', options: ['send the request again'] });
    let rows: readonly unknown[];
    try {
      rows = await log.port.events(runId);
    } catch (error) {
      return refuse(RESUME_INTENT, { code: 'needs_input', reason: `the run log could not be read: ${messageOf(error)}`, options: ['try again', 'discard the log and send the request again'] });
    }
    const nameOf = (id: string): string => harness.state.manifest.tree.find((node) => node.id === id)?.title ?? id;
    const verdict = planResume(rows, (id) => harness.state.documents.get(id)?.revision, { nameOf, structure: () => structureDigest(harness.state.manifest) });
    const intent = verdict.replay?.intent ?? RESUME_INTENT;
    if (!verdict.ok) return refuse(intent, resumeAskBack(verdict.reason, verdict.detail));
    const { replay } = verdict;
    if (replay.ended !== undefined) return refuse(intent, { code: 'needs_input', reason: 'this run already finished, so there is nothing to resume', options: ['discard the log'] });
    // A conversation is continued on the wire it began on; a restored card makes no further model call, so it can be shown on any provider.
    const wireNow = nativeToolsFor({ profileId: resumeOptions.profileId ?? options.profileId, model: resumeOptions.model ?? options.model, thinking: undefined }) !== undefined;
    if (replay.card === undefined && wireNow !== replay.native) {
      return refuse(intent, {
        code: 'needs_input',
        reason: 'the provider and model now selected do not speak the way the run began, so its conversation cannot be continued on them',
        options: ['switch back to the provider the run used, then resume', 'discard the log and send the request again'],
      });
    }
    // The logged conversation holds what the rules then allowed the agent to read. A rule since added over more than that is held to now, which
    // the logged text cannot be: the run is not continued rather than sent to the provider again. Naming no title, since the part is withheld.
    if (replay.card === undefined) {
      const before = new Set(replay.withheld);
      if ([...harness.withheldAnywhere()].some((id) => !before.has(id))) {
        return refuse(intent, {
          code: 'needs_input',
          reason: 'a rule now keeps part of the project from the agent that it could read when the run began, and the run’s conversation still holds what it read',
          options: ['discard the log and send the request again', 'remove the rule, then resume'],
        });
      }
    }
    return runTurn(intent, resumeOptions, (turn) => resumedTurn(turn, replay), { mode: 'resume', runId, replay, ...(verdict.rerun === undefined ? {} : { rerun: verdict.rerun }) });
  }

  return {
    submit(intent: string, submitOptions: SubmitOptions = {}): Promise<TurnReport> {
      return runTurn(intent, submitOptions, (turn) => plannedTurn(turn, intent, submitOptions.preload ?? []));
    },

    submitPlan(intent: string, plan: unknown, turnOptions: TurnOptions = {}): Promise<TurnReport> {
      const parsed = parsePlan(plan);
      return runTurn(
        intent,
        turnOptions,
        (turn) => (parsed.ok ? givenPlanTurn(turn, parsed.value) : Promise.resolve<Settled>({ status: 'failed', askBack: askBackFor(parsed.error) })),
        { mode: 'new', wire: 'plan' },
      );
    },

    stageOnly: (steps: readonly PlanStep[], turnOptions: TurnOptions = {}): Promise<StageOnlyResult> => stageSteps(steps, turnOptions),

    submitStaged(
      intent: string,
      plan: unknown,
      proposals: readonly unknown[],
      revisions: readonly (StepRevisions | undefined)[],
      turnOptions: TurnOptions = {},
    ): Promise<TurnReport> {
      const parsed = parsePlan(plan);
      return runTurn(
        intent,
        turnOptions,
        (turn) => (parsed.ok ? stagedTurn(turn, parsed.value, proposals, revisions) : Promise.resolve<Settled>({ status: 'failed', askBack: askBackFor(parsed.error) })),
        { mode: 'new', wire: 'plan' },
      );
    },

    resume: (runId: string, resumeOptions: TurnOptions = {}): Promise<TurnReport> => resumeRun(runId, resumeOptions),

    steer(turnId: string, text: string): Result<SteerReceipt, CommandError> {
      const turn = running.get(turnId);
      if (turn === undefined) {
        return err(refusal('not-found', `turn ${turnId} is not running, so a note cannot reach it`, { correctiveHint: 'send the note as a message of its own' }));
      }
      const trimmed = text.trim();
      if (trimmed === '') return err(refusal('invalid-params', 'a steering note needs some text', { correctiveHint: 'write the note, or leave it unsent' }));
      const note: NoteRecord = { noteId: `${turn.id}.note-${turn.notes.length + 1}`, text: trimmed };
      turn.notes.push(note);
      return ok({ noteId: note.noteId, lands: turn.deciding ? 'after-decision' : 'next-model-call' });
    },

    restore(turnId: string): Result<UndoOutcome, CommandError> {
      const report = finished.find((entry) => entry.turnId === turnId);
      if (report === undefined || report.undoGroupId === undefined) {
        return err(refusal('not-found', `turn ${turnId} has no checkpoint: it wrote nothing, or it has not finished`, { correctiveHint: 'restore a turn that wrote something, by its id' }));
      }
      return harness.undo.undo(report.undoGroupId);
    },

    reports: () => [...finished],
  };
}
