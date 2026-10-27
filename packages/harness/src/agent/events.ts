/**
 * What an agent turn emits and what it returns — agent-harness §2 (the report), §5 (the activity
 * log and the checkpoint row) and §8 (the stream the panel renders).
 *
 * These are plain values. The session emits them in order; a panel renders them, and an eval
 * asserts on them. Nothing here depends on a renderer.
 */

import type { CommandError } from '@caotang/bus';

import type { LayerReport } from '@caotang/context';

import type { AskBack, PlanStep } from '../plan.js';
import type { PlanCardView, PlanEdit, StatusCard } from './cards.js';
import type { BudgetSpend, BudgetStop, RunLimits } from './budget.js';
import type { Finding } from './drafting.js';
import type { BudgetUse, PermissionMode } from './mode.js';

/** One tool call as it ran, in order. An eval's trace matcher reads these (agent-harness §9). */
export interface TraceEntry {
  readonly tool: string;
  readonly callId: string;
  /** `ok` ran and succeeded; `refused` was refused by its gate, its validation or its apply; `not-run` a step a failure stopped before. */
  readonly outcome: 'ok' | 'refused' | 'not-run';
  readonly code?: CommandError['code'];
  readonly params: Readonly<Record<string, unknown>>;
  /** Set for a row a delegated agent made (agent-harness §2): `turn-3/reader#1`. Its `callId` is derived from the turn and this path. */
  readonly agentPath?: string;
}

/** One card decision the turn was asked for, and what the user chose. */
export interface CardRecord {
  readonly kind: 'plan' | 'confirm' | 'auto';
  readonly tools: readonly string[];
  readonly decision: 'approved' | 'cancelled' | 'auto';
  /** How many times the card was edited before the decision. */
  readonly edits: number;
  /** How many times the user asked for a draft again. */
  readonly retries: number;
}

/** What one step of a turn did, for the report. */
export interface StepRecord {
  readonly index: number;
  readonly tool: string;
  readonly expect: string;
  readonly status: 'done' | 'failed' | 'cancelled';
  readonly summary?: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export type TurnStatus = 'replied' | 'applied' | 'failed' | 'cancelled';

export type TurnPhase = 'started' | 'planning' | 'awaiting-approval' | 'running' | 'retrying' | 'done' | 'failed' | 'cancelled';

/** The writer stopped the turn (agent-harness §2, "Stop and steer"): the phase it was in when the stop took effect. */
export interface TurnStop {
  readonly by: 'user';
  readonly during: TurnPhase;
}

/** A note the writer sent to a running turn. It reaches the model at the next planner request, one user message per note. */
export interface SteeringNote {
  readonly noteId: string;
  readonly text: string;
  /** The model call it was sent with. Absent when the turn ended before the note could be delivered. */
  readonly deliveredAtCall?: number;
}

/** The compact turn summary (agent-harness §2 step 5): what changed, the undo group, and what it cost. */
export interface TurnReport {
  readonly turnId: string;
  readonly status: TurnStatus;
  /** The reply's text, when the turn ended with an answer. */
  readonly text?: string;
  readonly summary: string;
  readonly steps: readonly StepRecord[];
  readonly cards: readonly CardRecord[];
  readonly trace: readonly TraceEntry[];
  /** The bus undo group the turn's writes sit in. Reversing it is "restore to before this turn". */
  readonly undoGroupId?: string;
  /** Present when the turn stopped on something the user has to act on (agent-harness §2 step 4). */
  readonly askBack?: AskBack;
  /** Tokens this turn spent, read from the gateway's per-turn ledger rows (provider-gateway §6). */
  readonly tokens: { readonly promptTokens: number; readonly completionTokens: number; readonly requests: number };
  /** What the context assembly left out of the prompt, and why (context-assembly §5). */
  readonly dropped: readonly string[];
  /** The model calls the turn made, in order, including retries. */
  readonly modelCalls: number;
  /** Present when the writer stopped the turn. `status` is then `cancelled`, and whatever was applied before the stop stays in the undo group. */
  readonly stop?: TurnStop;
  /** Present when the turn ended on a run limit (agent-harness §7.1): the limit, and for a refused call what it would have needed. `status` is `failed`, never `cancelled`. */
  readonly budgetStop?: BudgetStop;
  /** The run's spend after this turn, when the session has a meter. */
  readonly spend?: BudgetSpend;
  /** The notes the writer sent during the turn, in order. A note without `deliveredAtCall` was not delivered: the turn ended first. */
  readonly steering?: readonly SteeringNote[];
  /** The permission mode the turn ended in (agent-harness §4). A switch in the middle of a turn applies from the next card. */
  readonly mode: PermissionMode;
  /** What the turn used of each budget dimension (agent-harness §4). */
  readonly budgetUse: BudgetUse;
  /** The write steps plan-only refused, in order, for the writer to run later: `submitPlan` takes them as they are. Absent when none was refused. */
  readonly heldSteps?: readonly PlanStep[];
  /** The slash command that started the turn (`draft`, without the slash), so the panel and an eval can tell `/draft` from a request typed in words. Absent for any other turn. */
  readonly command?: string;
}

/**
 * A decision the user makes on a card. A plan can be edited, and the edited card is shown again before it runs.
 * `acceptTruncated` is the explicit consent a cut draft needs: the provider stopped it at its output
 * limit, and approval keeps the cut text (context-assembly §5). Without it, a cut draft is not approvable.
 */
export type Decision =
  | { readonly action: 'approve'; readonly acceptTruncated?: boolean }
  | { readonly action: 'cancel' }
  | { readonly action: 'retry' }
  | { readonly action: 'edit'; readonly edits: readonly PlanEdit[] };

/** A card that is waiting for a decision. The session asks `decide` with it and does not run anything until it answers. */
export interface PendingCard {
  readonly kind: 'plan' | 'confirm';
  readonly turnId: string;
  readonly card: PlanCardView;
}

/** How many model requests a turn may make unless the session says otherwise (agent-harness §2). */
export const DEFAULT_MAX_MODEL_CALLS = 8;

export type AgentEvent =
  /** A phase change. `started` carries the mode the turn begins in. */
  | { readonly type: 'turn'; readonly turnId: string; readonly phase: TurnPhase; readonly mode?: PermissionMode }
  | { readonly type: 'model.delta'; readonly turnId: string; readonly delta: string }
  /** A model request is about to be sent: how many the turn has made, this one included, and its bound. The task list's footer reads it (§8). */
  | { readonly type: 'model.call'; readonly turnId: string; readonly used: number; readonly limit: number }
  /**
   * Reasoning text as the model streams it (the provider's thinking channel). The panel folds it into a collapsed
   * "Thinking" block (ui-modules §1); the replayable blocks a reply carries on its terminal chunk are context for the
   * next request, not panel text, and are never emitted here.
   */
  | { readonly type: 'model.reasoning'; readonly turnId: string; readonly delta: string }
  /**
   * A scene draft's text as the model writes it (agent-harness §8): the ghost region of the scene streams it, and the completed
   * draft replaces it. `start` marks the first delta of a draft (or a redraft), so the region is emptied before the text arrives.
   */
  | { readonly type: 'draft.delta'; readonly turnId: string; readonly docTitle: string; readonly delta: string; readonly start?: boolean }
  | { readonly type: 'context'; readonly turnId: string; readonly layers: readonly Pick<LayerReport, 'id' | 'tokens'>[]; readonly dropped: readonly string[] }
  | { readonly type: 'card'; readonly turnId: string; readonly card: StatusCard }
  /** `auto` marks a card the mode's policy approved instead of the writer (agent-harness §4): it is shown collapsed, with an auto-approved badge. */
  | { readonly type: 'plan'; readonly turnId: string; readonly card: PlanCardView; readonly auto?: true }
  /** The ghost-preview handoff (agent-harness §8): a generated draft, waiting for apply, retry or discard. */
  | { readonly type: 'ghost'; readonly turnId: string; readonly callId: string; readonly docTitle: string; readonly text: string; readonly words: number; readonly cut?: boolean }
  | { readonly type: 'findings'; readonly turnId: string; readonly callId: string; readonly findings: readonly Finding[] }
  | { readonly type: 'ladder'; readonly turnId: string; readonly callId: string; readonly attempt: number; readonly askBack: AskBack }
  /** The checkpoint row (command-bus §5): the turn's undo group, and the label that says what one click does. */
  | { readonly type: 'checkpoint'; readonly turnId: string; readonly undoGroupId: string; readonly label: string; readonly note?: string; readonly mode: PermissionMode }
  /** The run's spend, after a model call was allowed and after it settled (agent-harness §7.1). Only a session with a meter emits it. */
  | { readonly type: 'budget'; readonly turnId: string; readonly spend: BudgetSpend; readonly limits: RunLimits }
  /** A steering note reached the model: delivered with the request named in `note.deliveredAtCall`. */
  | { readonly type: 'steer'; readonly turnId: string; readonly note: SteeringNote }
  | { readonly type: 'report'; readonly turnId: string; readonly report: TurnReport };

/** The label every checkpoint row carries (agent-harness §5). */
export const CHECKPOINT_LABEL = 'restore to before this turn';

/**
 * The note a checkpoint row carries when the turn called an external tool (extensibility §6, "Undo semantics for mixed turns"):
 * restoring the turn reverses Caotang's own changes, and cannot reverse what the external server did.
 */
export const EXTERNAL_CHECKPOINT_NOTE = 'External side effects are not reversible. Restoring this turn puts back Caotang’s own changes only.';

/** The same note for a step's own menu, where the restore it offers starts at that step and not at the turn. */
export const STEP_EXTERNAL_CHECKPOINT_NOTE = 'External side effects are not reversible. Restoring from this step puts back Caotang’s own changes only.';

/** The note a checkpoint row carries when the turn was resumed after a reload: the undo of a turn reaches what it applied since. */
export const RESUMED_CHECKPOINT_NOTE =
  'This turn was resumed after a reload. Restoring it puts back only what it applied since; the steps applied before the reload are kept.';
