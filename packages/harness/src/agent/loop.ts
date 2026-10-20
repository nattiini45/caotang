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
import type { ChatMessage, Gateway, TaskRole, ThinkingLevel, ToolCall as WireToolCall, ToolDef } from '@caotang/gateway';
import { newId } from '@caotang/ids';
import { getBody, getRevision, type ProjectState, type TreeNode } from '@caotang/store';
import { dialogueDraftTool, resolveContainer } from '@caotang/dialogue';
import { stagePromptDraftTool, stagePromptVariantTool } from '@caotang/video-prompt-pack';

import { refusal } from '../errors.js';
import { askBackFor, parsePlan, type AskBack, type Plan, type PlanPreflight, type PlanStep } from '../plan.js';
import { DOCUMENT, descendantsOf, resolveNode } from '../resolve.js';
import type { Harness, ToolListing } from '../runtime.js';
import type { CallParams, ToolCall, ToolOutcome } from '../types.js';
import { isRecord } from '../util.js';
import { CONTINUITY_MAX_DOCS, SYNOPSIS_MAX_DOCS } from '../tools/ports.js';
import { LARGE_SCOPE_APPROVAL, LARGE_SCOPE_APPROVAL_KEY } from '../tools/coherence.js';
import {
  advance,
  applyEdit,
  canAdvance,
  MODEL_BACKED_TOOLS as MODEL_BACKED,
  planCardOf,
  reviewCostAt,
  stagedOf,
  type EditableSteps,
  type PlanCardView,
  type PlanEdit,
  type StatusCard,
  type StatusState,
} from './cards.js';
import {
  CHECKPOINT_LABEL,
  EXTERNAL_CHECKPOINT_NOTE,
  type AgentEvent,
  type CardRecord,
  type Decision,
  type PendingCard,
  type StepRecord,
  type TraceEntry,
  type TurnPhase,
  type TurnReport,
  type TurnStatus,
} from './events.js';
import {
  complete,
  continuityRole,
  dialogueRole,
  draftDialogue,
  draftScene,
  fillSynopses,
  GenerationStopped,
  sceneRole,
  scanContinuity,
  synopsisRole,
  type Completion,
  type FindingsProposal,
  type ModelCall,
  type SceneProposal,
  type SynopsisDoc,
  type SynopsisProposal,
} from './drafting.js';
import {
  errorSummary,
  loadedToolsMessage,
  parseReply,
  plannerSystem,
  plannerSystemNative,
  plannerToolDefs,
  refusalSentence,
  refusedStepsMessage,
  REPLY_SCHEMA_HINT,
  resultsMessage,
  retryMessage,
  stepsRefusalMessage,
  type Reply,
} from './protocol.js';
import { previewFor, sceneDraftPreflight, shotsDeriveScenePreflight } from './ports.js';
import { createContextPort, dropLinesOf, mergePreviews, type ContextPort } from './context.js';
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
  readonly profileId?: string;
  readonly model?: string;
  /**
   * The task role the session's model calls run under (provider-gateway §6): stamped on every request the turn
   * makes, so the ledger accounts it and the gateway resolves the role's profile when `profileId` pins none.
   * The prompt-pack's calls are stamped 'drafting' instead. Absent, no role is sent.
   */
  readonly role?: TaskRole;
  /**
   * The effort level every model request of the session is sent with (`ChatRequest.thinking`). Absent,
   * the provider's own default applies.
   */
  readonly thinking?: ThinkingLevel;
  /** The most model calls one turn may make, retries and drafts included. Default 8. */
  readonly maxModelCalls?: number;
  /** How many times the verify ladder may adjust and re-show a refused step (agent-harness §7). Default 2. */
  readonly maxRetries?: number;
  /**
   * Names this session's turns: a turn is `<session>.turn-<n>`, so two sessions on one gateway or one
   * harness never share a turn id. Defaults to a random name. An eval pins one, so its runs are the same bytes.
   */
  readonly sessionId?: string;
  /**
   * The clock the status cards are stamped with: when a call starts running and when it finishes, which the panel's elapsed
   * timer reads (agent-harness §8). Display only, so no check reads it. Default `Date.now`.
   */
  readonly clock?: () => number;
}

export interface AgentSession {
  /** Runs one turn for one intent. Resolves when the turn has ended, after any card was decided. */
  submit(intent: string): Promise<TurnReport>;
  /**
   * Runs one turn whose plan the app built, rather than the model: the drafts it needs are staged, and its card is decided like
   * any other. The "Fix with agent" entry of a coherence finding is the caller (coherence.md §6.3). The plan is checked as a
   * planner's is, and a plan that does not parse is refused before anything is staged.
   */
  submitPlan(intent: string, plan: unknown): Promise<TurnReport>;
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

/** A model call the turn's bound refused. The staging and card paths check the bound first, so this is a backstop. */
class BudgetExceeded extends Error {
  constructor(limit: number) {
    super(`the turn made ${limit} model calls without finishing, so it stopped`);
    this.name = 'BudgetExceeded';
  }
}

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
  /** Counts the calls a turn makes, so every call id within it is unique. */
  seq: number;
  /** The turn's undo group, recorded the moment a run applies anything, so no path loses it. */
  undoGroupId?: string;
  /** The loaded-tools addendum the model was last told, so a request after a new load is told again (context-assembly §2). */
  addendumSent?: string;
  /**
   * Whether the planner speaks native tool calls this turn: set when the first planner call is built
   * (`plannedTurn`), from the model's capabilities. On the JSON fallback it stays `false`.
   */
  native: boolean;
  /** The native replies whose calls still owe tool messages, oldest first. Empty on the JSON wire. */
  readonly wireReplies: WireReply[];
  /**
   * The wire call a plan step answers, by the step object the plan currently carries. An edit replaces
   * the object, so `reconcileWire` re-binds a step's call to the step the writer left in its place.
   */
  readonly wireSteps: Map<PlanStep, WireToolCall>;
}

/** How the turn ended, before the report is built from it. */
interface Settled {
  readonly status: TurnStatus;
  readonly text?: string;
  readonly askBack?: AskBack;
  readonly summary?: string;
}

/** What drafting produced for a call's model-backed steps. A refusal is returned to the model, not thrown. */
interface Staged {
  readonly proposals: readonly unknown[];
  readonly refusals: readonly { readonly index: number; readonly tool: string; readonly message: string }[];
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
  /**
   * The writer approved a cut card with `acceptTruncated` (agent-harness §8): the apply strips
   * `cut: true` from the proposals so the ports see a complete proposal. Without it, a cut
   * proposal reaches the port and is refused as truncated.
   */
  readonly acceptedCut?: boolean;
  readonly error?: CommandError;
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
 * A native call's arguments, parsed. A call that names no arguments is read as none; one whose JSON does
 * not parse or is not an object is a refusal the model corrects, like a JSON reply it cannot parse.
 */
function callArgs(call: WireToolCall): { readonly params?: CallParams; readonly error?: string } {
  const source = call.argumentsJson.trim();
  if (source === '') return { params: {} };
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { error: 'the call\'s arguments were not valid JSON, so it did not run: send the call again with its arguments as one JSON object' };
  }
  if (!isRecord(value)) {
    return { error: `the call's arguments must be one JSON object, and this call sent ${value === null ? 'null' : Array.isArray(value) ? 'an array' : `a ${typeof value}`}: send the call again with its arguments as one JSON object` };
  }
  return { params: value };
}

/**
 * The reply as the conversation keeps it. A native reply's calls and reasoning blocks ride on the
 * message verbatim — the adapter replays them on the next request, so they are never paraphrased.
 */
function assistantOf(reply: Completion): ChatMessage {
  return {
    role: 'assistant',
    content: reply.text,
    ...(reply.toolCalls === undefined || reply.toolCalls.length === 0 ? {} : { toolCalls: reply.toolCalls }),
    ...(reply.reasoning === undefined || reply.reasoning.length === 0 ? {} : { reasoning: reply.reasoning }),
  };
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

/**
 * synopsis.fill's task text for one document (L7). The notes are in it for `notes` and `both`. For `notes` the
 * text is not sent, and the task says so: the focus layer lists an empty body as empty, and it has no stand-in
 * for a full document, so the model is told in words that the synopsis is drafted from the notes alone.
 */
function synopsisInstruction(node: TreeNode, source: 'text' | 'notes' | 'both'): string {
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

/** The ask-back for a turn that used its model-call bound. The user decides what to do with the rest. */
function budgetAskBack(limit: number): AskBack {
  return {
    code: 'needs_input',
    reason: `the turn made ${limit} model calls without finishing, so it stopped`,
    options: ['ask for a smaller change, and send it again', 'split the work across two turns'],
  };
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
function stoppedBy(error: unknown, limit: number): Settled {
  if (error instanceof BudgetExceeded) return { status: 'failed', askBack: budgetAskBack(limit) };
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

export function createAgentSession(options: AgentSessionOptions): AgentSession {
  const { harness, gateway } = options;
  // The project is read at each call, so a session follows the project as the writer changes it. The model's
  // limits are read at each call too, so they follow the profile and model the session is calling (context-assembly §5).
  const context =
    options.context ??
    createContextPort({
      state: () => harness.state,
      config: () => ({ model: gateway.modelLimits(options.profileId, options.model) }),
    });
  const emit = (event: AgentEvent): void => options.emit?.(event);
  const now = options.clock ?? Date.now;
  const maxModelCalls = options.maxModelCalls ?? 8;
  const maxRetries = options.maxRetries ?? 2;
  const sessionName = options.sessionId ?? newId('cmd').slice('cmd_'.length);
  const finished: TurnReport[] = [];
  /** Every turn this session has started, oldest first, with its intent: what L6 is built from (context-assembly §2). */
  const started: RecentTurn[] = [];
  let turnCounter = 0;

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

  /** The writes a turn has applied so far, in order, as the report names them. Reads are not writes. */
  const writesOf = (turn: Turn): string[] =>
    turn.steps.filter((step) => step.status === 'done' && riskOf(step.tool) !== 'read').map((step) => step.summary ?? step.tool);

  /**
   * The one budgeted call site. Every model request a turn makes passes through here, drafts and retries
   * included, and is counted against the turn's bound before it is sent. The session's role is stamped on the
   * request here too (provider-gateway §6); the prompt-pack's calls pass 'drafting' for it instead.
   */
  const modelCall = (turn: Turn, onDelta?: (delta: string) => void, role: TaskRole | undefined = options.role): ModelCall => ({
    gateway: {
      complete: (request, signal) => {
        if (turn.modelCalls >= maxModelCalls) throw new BudgetExceeded(maxModelCalls);
        turn.modelCalls += 1;
        return gateway.complete(role === undefined ? request : { ...request, role }, signal);
      },
    },
    turnId: turn.id,
    // The session's pins apply to its own role only: a call under another role resolves that role's
    // profile, model and thinking at the gateway instead of borrowing the session's.
    ...(options.profileId === undefined || role !== options.role ? {} : { profileId: options.profileId }),
    ...(options.model === undefined || role !== options.role ? {} : { model: options.model }),
    ...(options.thinking === undefined || role !== options.role ? {} : { thinking: options.thinking }),
    // A draft's deltas go to its scene's ghost region (`draft.delta`), and every other call's to the panel's stream tail.
    onDelta: onDelta ?? ((delta) => emit({ type: 'model.delta', turnId: turn.id, delta })),
    // Reasoning has one sink on every call — the panel's collapsed "Thinking" block. A draft's reasoning is the
    // turn's reasoning too: the ghost region gets `draft.delta` prose only, so nothing here lands in the editor.
    onReasoning: (delta) => emit({ type: 'model.reasoning', turnId: turn.id, delta }),
  });

  /**
   * The tool declarations a native planner call may send, or `undefined` on the JSON wire: the model
   * behind this session's profile and model must report `tools` in its capabilities, and there must be
   * tools to declare. A gateway with no `modelCaps` reports nothing, which is the fallback either way.
   */
  const nativeTools = (): ToolDef[] | undefined => {
    if (gateway.modelCaps?.(options.profileId, options.model)?.tools !== true) return undefined;
    const tools = plannerToolDefs(harness.tools(), harness.loadedExternalTools());
    return tools.length === 0 ? undefined : tools;
  };

  /**
   * The planner's own calls: the one budgeted call site, with the turn's declarations added on the
   * native wire. The list is rebuilt here, on the call itself, so a tool a mid-turn `tool.search`
   * loaded is declared on the very next request.
   */
  const plannerCall = (turn: Turn): ModelCall => {
    const call = modelCall(turn);
    if (!turn.native) return call;
    const tools = plannerToolDefs(harness.tools(), harness.loadedExternalTools());
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

  /**
   * The model the prompt-pack engine calls through: each of its requests is one generation of the turn, so it
   * counts against the bound — and each runs under the 'drafting' role, whatever role the session itself carries.
   */
  const promptModel = (turn: Turn) =>
    promptModelOf(
      async (messages, jsonSchemaHint) => (await complete(modelCall(turn, undefined, 'drafting'), messages, { jsonSchemaHint })).text,
      options.model ?? '',
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
    for (const [index, step] of steps.entries()) {
      // An external step the turn has not loaded is refused here, before any draft is made, so nothing runs for it.
      const external = externalRefusal(step.tool);
      if (external !== undefined) {
        refusals.push({ index, tool: step.tool, message: external });
        refusedBeforeCard(turn, step, external);
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
    try {
      return await draftStep(turn, step);
    } catch (error) {
      if (error instanceof ContextError) return refusedDraft(error.message);
      throw error;
    }
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
        task: sceneTask(node.value.title, node.value.id, mode, instruction, selection, targetWords, step.params['include_forward_outline'] === true),
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
          task: { tool: 'synopsis.fill', instruction: synopsisInstruction(node, source), focus: node.id },
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
      const cost = reviewCostAt(planned.value, gateway, options.profileId, options.model);
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
        task: { tool: 'dialogue.draft', instruction: `Brief: ${instruction}`, focus: container.node.id },
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
      scope.push(...descendantsOf(state, 'manuscript').filter(DOCUMENT));
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
      task: {
        tool: 'continuity.scan',
        instruction:
          aspects.length === 0
            ? 'Check these documents for continuity problems.'
            : `Check these documents for continuity problems in these aspects: ${aspects.join(', ')}.`,
        params: { aspects },
        scope: scope.map((node) => node.id),
      },
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
    if (loadedExternal(call.name) !== undefined) return harness.callExternal(call, { turnId: turn.id });
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
    const reason = errorSummary(outcome.error);
    turn.trace.push({ tool: step.tool, callId, outcome: 'refused', code: outcome.error.code, params: step.params });
    turn.steps.push({ index, tool: step.tool, expect: step.expect, status: 'failed', error: reason });
    moveCard(turn, callId, 'failed', { error: reason });
    return { tool: step.tool, ok: false, body: reason };
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
      const id = nextCallPrefix(turn, 'r');
      const proposal = proposals[index];
      const first = await invokeRead(turn, { name: step.tool, callId: id, params: step.params, ...(proposal === undefined ? {} : { proposal }) });
      let callId = id;
      let outcome: ToolOutcome = first;
      if (!first.ok && needsWriterApproval(first.error)) {
        // The refusal came before the scan ran, so nothing has run. The writer decides on a card of its own.
        callId = `${id}.confirm`;
        const decided = await decideCard(turn, 'confirm', callId, { editable: oneStep(step, index, proposal), from: 0, revision: 0 });
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
          outcome = await invokeRead(turn, { name: approved.tool, callId, params: approved.params, ...(proposal === undefined ? {} : { proposal }) }, { confirmed: true });
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
    if (turn.native) {
      // On the native wire each call is answered by its own tool message, keyed by its id; a search that
      // surfaced tools still puts their descriptors in a user note after the results, as the JSON wire does.
      flushWire(turn);
      if (loadedNow.length > 0) turn.messages.push({ role: 'user', content: loadedToolsMessage(loadedNow) });
    } else {
      const sections = [resultsMessage(results), ...(loadedNow.length === 0 ? [] : [loadedToolsMessage(loadedNow)])];
      turn.messages.push({ role: 'user', content: sections.join('\n\n') });
    }
    // The descriptors just sent name every tool the search loaded, so the planner's one-line addendum for the same set is not
    // sent again in the next request: the same names would reach the model twice (context-assembly §2).
    if (loadedNow.length > 0) turn.addendumSent = harness.loadedAddendum();
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
      steps: [...checked.value.steps.map((entry) => ({ ...entry, index: nativeAt[entry.index] ?? entry.index })), ...external].sort(
        (a, b) => a.index - b.index,
      ),
    };
    const previews = editable.steps.map((step, index) => previewFor(harness.state, step.tool, step.params, editable.proposals[index]));
    const staged = editable.proposals.map((proposal) => stagedOf(proposal));
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
   * Shows a card and asks for decisions until the user approves or cancels. An edit or a retry is
   * checked and the card is shown again, so an approval always covers the card as it now stands
   * (agent-harness §2). An edit that cannot be applied is refused by name, and the last good card stays.
   */
  async function decideCard(
    turn: Turn,
    kind: 'plan' | 'confirm',
    prefix: string,
    start: { readonly editable: EditableSteps; readonly from: number; readonly revision: number; readonly notice?: string },
  ): Promise<Decided> {
    let editable = start.editable;
    let revision = start.revision;
    let notice = start.notice;
    let edits = 0;
    let retries = 0;
    let stalls = 0;
    for (;;) {
      const shown = cardOf(turn, editable, start.from, revision, kind, notice);
      notice = undefined;
      if ('refused' in shown) return { settled: 'refused', editable, edits, retries, error: shown.refused };
      // Each step that has not run is pending from the moment its card is shown (agent-harness §8).
      for (const [index, step] of editable.steps.entries()) {
        if (ranAt(editable, index)) continue;
        cardFor(turn, callIdFor(kind, prefix, index), step.tool, step.params, 'pending-approval');
      }
      emit({ type: 'plan', turnId: turn.id, card: shown.card });
      showGhosts(turn, editable, kind, prefix);
      phase(turn, 'awaiting-approval');
      const decision = await options.decide({ kind, turnId: turn.id, card: shown.card } satisfies PendingCard);

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
    // A native async tool (coherence.review) runs under the approval its card gave: the plan's, or the one-step confirmation.
    // An external tool is called through its own entry, under the confirmation its card gave (extensibility §4 rule 2).
    const outcome =
      loadedExternal(step.tool) === undefined
        ? await harness.callAsync(call, grant === 'plan' ? { turnId: turn.id, permission: { approvedPlan: true } } : { turnId: turn.id, permission: { confirmed: true } })
        : await harness.callExternal(call, grant === 'confirmed' ? { turnId: turn.id, permission: { confirmed: true } } : { turnId: turn.id });
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
        const decided = await decideCard(turn, 'confirm', id, { editable: oneStep(step, index, editable.proposals[index]), from: 0, revision: 0 });
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
      const result = harness.executePlan(
        { steps: editable.steps.slice(0, end) },
        { turnId: turn.id, callId: `${prefix}.s${index}` },
        { from: index, proposals: acceptedCut ? stripCut(editable.proposals.slice(0, end)) : editable.proposals.slice(0, end) },
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
      const outcome: ToolOutcome = harness.call(
        { name: step.tool, callId: id, params: step.params, ...(proposal === undefined ? {} : { proposal }) },
        grant === 'auto' ? { turnId: turn.id } : { turnId: turn.id, permission: { confirmed: true } },
      );
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

    const result = harness.executePlan(
      { steps: editable.steps },
      { turnId: turn.id, callId: prefix },
      { from, proposals: acceptedCut ? stripCut(editable.proposals) : editable.proposals },
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
  async function runWrites(turn: Turn, plan: Plan, staged: Staged): Promise<Settled | 'continue'> {
    const single = plan.steps.length === 1 ? (plan.steps[0] as PlanStep) : undefined;
    const kind: 'plan' | 'confirm' = single !== undefined && riskOf(single.tool) === 'write-confirm' ? 'confirm' : 'plan';
    // A single write-auto call runs at once: a reversible op skips the plan (agent-harness §2).
    const auto = single !== undefined && riskOf(single.tool) !== 'write-confirm';
    if (plan.steps.some((step) => step.params['selection'] !== undefined)) await preloadAnchorLibraries();

    let editable: EditableSteps = {
      steps: plan.steps,
      origins: plan.steps.map((_, index) => index),
      proposals: staged.proposals,
      stale: plan.steps.map(() => false),
      superseded: [],
      completed: [],
    };
    const prefix = nextCallPrefix(turn, auto ? 'a' : 'p');
    const checked = cardOf(turn, editable, 0, 0, kind, undefined);
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
      const executed = await execute(turn, editable, 0, 'confirm', prefix, 'auto');
      turn.cards.push({ kind: 'auto', tools: [single.tool], decision: 'auto', edits: 0, retries: 0 });
      return settle(turn, executed);
    }

    let from = 0;
    let ladder = 0;
    let retries = 0;
    let edits = 0;
    let attempt = 0;
    let attemptPrefix = prefix;
    let notice: string | undefined;
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
        return { status: 'cancelled' };
      }
      turn.cards.push({ kind, tools, decision: 'approved', edits, retries });
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

      if (!ADJUSTABLE.has(askBack.code) || executed.effect || ladder >= maxRetries) return settle(turn, executed);

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
    emit({ type: 'turn', turnId: turn.id, phase: to });
  }

  /** The model conversation of one turn: a reply, parsed, with a bad one answered by the words it needs. */
  async function converse(turn: Turn): Promise<Settled> {
    for (;;) {
      if (callsLeft(turn) < 1) return { status: 'failed', askBack: budgetAskBack(maxModelCalls) };
      phase(turn, 'planning');
      // The loaded-tools addendum is read for each request, not once per turn: a search earlier in this turn may have loaded
      // a tool the model has not been told about yet. It is sent again only when the set has changed (context-assembly §2).
      const addendum = harness.loadedAddendum();
      if (addendum !== undefined && addendum !== turn.addendumSent) {
        turn.messages.push({ role: 'user', content: addendum });
        turn.addendumSent = addendum;
      }
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
            ? writes.length === 0
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
    };
  }

  /** The planner's turn: the request goes to the model, which answers or proposes steps (agent-harness §2). */
  async function plannedTurn(turn: Turn, intent: string): Promise<Settled> {
    // The wire is picked here, once per turn, from the model's capabilities: native tool calls when the
    // model can take them, the JSON envelope otherwise. The system message states the protocol the call
    // speaks (protocol.ts `plannerSystem`/`plannerSystemNative` — same rules, different wording).
    turn.native = nativeTools() !== undefined;
    // The planner's call is a `meta` call (context-assembly §3): the protocol and tool list as L0, the project
    // summary as L1, and the request as L7.
    const planner = context.assemble({
      task: { tool: 'meta', instruction: `Request: ${intent}` },
      role: turn.native ? plannerSystemNative(harness.tools(), harness.loadedAddendum()) : plannerSystem(harness.tools(), harness.loadedAddendum()),
      turns: turn.priorTurns,
      activity: harness.log.entries(),
    });
    const dropped = dropLinesOf(planner.prompt);
    turn.dropped.push(...dropped);
    emit({ type: 'context', turnId: turn.id, layers: planner.prompt.layers.map((layer) => ({ id: layer.id, tokens: layer.tokens })), dropped });
    turn.messages.push(...planner.messages);
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
   * One turn, from its record to its report. `first` runs the turn's steps. A failure it cannot recover from is reported in words
   * the user can act on: the turn is never left half-finished, and whatever it applied stays in its undo group.
   */
  async function runTurn(intent: string, first: (turn: Turn) => Promise<Settled>): Promise<TurnReport> {
    turnCounter += 1;
    const turn: Turn = {
      id: `${sessionName}.turn-${turnCounter}`,
      messages: [],
      trace: [],
      cards: [],
      steps: [],
      statusCards: [],
      dropped: [],
      // The turns before this one are what L6 may show; this turn's intent is recorded for the ones after it.
      priorTurns: [...started],
      modelCalls: 0,
      seq: 0,
      native: false,
      wireReplies: [],
      wireSteps: new Map(),
    };
    started.push({ turnId: turn.id, intent });
    phase(turn, 'started');

    let settled: Settled;
    try {
      settled = await first(turn);
    } catch (error) {
      settled = stoppedBy(error, maxModelCalls);
    }

    harness.endTurn(turn.id);
    const totals = gateway.ledger.turnTotals(turn.id);
    const report = reportOf(turn, settled, { promptTokens: totals.promptTokens, completionTokens: totals.completionTokens, requests: totals.requests });
    finished.push(report);
    // A turn that called an external tool carries the scope note on its checkpoint: the undo can reverse Caotang's changes only.
    const mixed = turn.trace.some((row) => row.tool.startsWith('mcp__'));
    if (report.undoGroupId !== undefined) {
      emit({
        type: 'checkpoint',
        turnId: turn.id,
        undoGroupId: report.undoGroupId,
        label: CHECKPOINT_LABEL,
        ...(mixed ? { note: EXTERNAL_CHECKPOINT_NOTE } : {}),
      });
    }
    phase(turn, settled.status === 'replied' || settled.status === 'applied' ? 'done' : settled.status === 'cancelled' ? 'cancelled' : 'failed');
    emit({ type: 'report', turnId: turn.id, report });
    return report;
  }

  return {
    submit(intent: string): Promise<TurnReport> {
      return runTurn(intent, (turn) => plannedTurn(turn, intent));
    },

    submitPlan(intent: string, plan: unknown): Promise<TurnReport> {
      const parsed = parsePlan(plan);
      return runTurn(intent, (turn) =>
        parsed.ok ? givenPlanTurn(turn, parsed.value) : Promise.resolve<Settled>({ status: 'failed', askBack: askBackFor(parsed.error) }),
      );
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
