// i18n: package-refs
/**
 * The cards the agent panel shows, as data: the status card of each tool call (agent-harness §8),
 * the plan card a multi-step turn asks the user to approve (§2), and the edits a user can make to
 * that card before approving it.
 *
 * Nothing here renders. A card is a value, and a change to it is a new value, so a view can be
 * re-derived at any point and two readers of one turn cannot disagree about it.
 */

import type { CommandError, Result } from '@caotang/bus';
import { err, ok } from '@caotang/bus';
import type { MessageRef } from '@caotang/i18n';

import type { PlanPreflight, PlanStep } from '../plan.js';
import type { SubagentName } from '../tools/delegate.js';
import type { CallParams } from '../types.js';
import { isRecord } from '../util.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, type ModelLimits, type PromptPreview } from '@caotang/context';
import type { ThinkingLevel } from '@caotang/gateway';
import type { ReviewPlan } from '@caotang/coherence';
import type { PictureTranscriptionPlan } from '../tools/transcription.js';
import type { TraceEntry } from './events.js';

/* ------------------------------------------------------------------ *
 * Status cards — one per tool call, with the lifecycle.
 * ------------------------------------------------------------------ */

/** pending-approval → running → done | failed, or pending-approval → cancelled (agent-harness §8). */
export type StatusState = 'pending-approval' | 'running' | 'done' | 'cancelled' | 'failed';

/**
 * What a delegated agent's call shows beside the generic card (agent-harness §8): the agent, the model calls reserved for it, how it
 * ended, its notes once it has finished, and its own trace rows as they happen. No new card kind: it rides on the `agent.delegate` call's card.
 */
export interface DelegationView {
  readonly agent: SubagentName;
  readonly agentPath: string;
  /** The model calls the turn reserved for the agent. */
  readonly reserved: number;
  /** `running` until the agent answers; then how it ended. */
  readonly outcome: 'running' | 'done' | 'partial' | 'failed';
  /** The agent's notes, once it has finished: what the planner reads of its work. */
  readonly result?: string;
  /** How many steps the agent proposed. */
  readonly proposed?: number;
  /** The agent's own tool rows, in order (`TraceEntry.agentPath` is this card's). */
  readonly trace: readonly TraceEntry[];
}

export interface StatusCard {
  readonly id: string;
  readonly turnId: string;
  readonly callId: string;
  readonly tool: string;
  readonly risk: string;
  readonly status: StatusState;
  readonly args: CallParams;
  /** What the call did, once it is done: the tool's one-line summary. */
  readonly summary?: string;
  /** Why it failed or was refused, once it has: the model-facing message. */
  readonly error?: string;
  /** When the call started running, in epoch milliseconds. Display only: the panel's elapsed timer (agent-harness §8). */
  readonly startedAt?: number;
  /** When the call reached done, failed or cancelled, in epoch milliseconds. Display only. */
  readonly finishedAt?: number;
  /** Set on an `agent.delegate` call's card (agent-harness §8). */
  readonly delegation?: DelegationView;
}

const NEXT: Readonly<Record<StatusState, readonly StatusState[]>> = {
  'pending-approval': ['running', 'cancelled'],
  running: ['done', 'failed'],
  done: [],
  cancelled: [],
  failed: [],
};

/** Whether a card may move from one state to another. A card never moves backwards or out of a final state. */
export function canAdvance(from: StatusState, to: StatusState): boolean {
  return NEXT[from].includes(to);
}

/** A card in its next state. An illegal move is a defect in the caller, so it throws rather than returning a value. */
export function advance(
  card: StatusCard,
  to: StatusState,
  detail: { readonly summary?: string; readonly error?: string; readonly at?: number } = {},
): StatusCard {
  if (!canAdvance(card.status, to)) {
    throw new Error(`status card ${card.id} cannot move from ${card.status} to ${to}`);
  }
  const finished = to === 'done' || to === 'failed' || to === 'cancelled';
  return {
    ...card,
    status: to,
    ...(detail.summary === undefined ? {} : { summary: detail.summary }),
    ...(detail.error === undefined ? {} : { error: detail.error }),
    ...(to === 'running' && card.startedAt === undefined && detail.at !== undefined ? { startedAt: detail.at } : {}),
    ...(finished && detail.at !== undefined ? { finishedAt: detail.at } : {}),
  };
}

/** One row of the panel: a single card, or a run of consecutive calls grouped in one container. */
export type CardItem =
  | { readonly kind: 'card'; readonly card: StatusCard }
  | { readonly kind: 'group'; readonly turnId: string; readonly cards: readonly StatusCard[]; readonly expanded: boolean };

/**
 * Consecutive calls of one turn share a container (agent-harness §8). It is open while any of its
 * calls is still pending or running, which is the auto-expand, and it closes when they have all
 * finished, which is the collapse. A single call is shown on its own.
 */
export function groupCards(cards: readonly StatusCard[]): readonly CardItem[] {
  const items: CardItem[] = [];
  let run: StatusCard[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length === 1) items.push({ kind: 'card', card: run[0] as StatusCard });
    else {
      const open = run.some((card) => card.status === 'running' || card.status === 'pending-approval');
      items.push({ kind: 'group', turnId: (run[0] as StatusCard).turnId, cards: [...run], expanded: open });
    }
    run = [];
  };
  for (const card of cards) {
    const last = run[run.length - 1];
    if (last !== undefined && last.turnId !== card.turnId) flush();
    run.push(card);
  }
  flush();
  return items;
}

/* ------------------------------------------------------------------ *
 * Plan cards — the steps a turn asks to run, and the edits that change them.
 * ------------------------------------------------------------------ */

export interface PlanStepView {
  /** The step's index in the plan as it now stands. */
  readonly index: number;
  /** The step's index in the plan as the model first proposed it. Badges are read against this. */
  readonly origin: number;
  readonly tool: string;
  readonly expect: string;
  readonly risk: string;
  readonly params: CallParams;
  /** `done` is a step that has run: it is never run again, and no edit can change it (agent-harness §7). */
  readonly status: 'ready' | 'deferred' | 'refused' | 'done';
  readonly preview?: unknown;
  readonly error?: CommandError;
  /** agent-harness §2: a flag on a step whose inputs an edit has moved. */
  readonly badges: readonly string[];
  /** The draft was written against a revision the document has since left. It cannot be approved until it is drafted again. */
  readonly stale: boolean;
  /** The provider stopped the draft at its output limit. It cannot be approved until it is drafted again or its cut text is accepted. */
  readonly cut: boolean;
  /** The prompt that produced this step's draft, as the card shows it (context-assembly §5). */
  readonly context?: PromptPreview;
  /** The step's estimated cost at the profile's price, when the step carries one: a coherence review's plan (coherence.md §5.3). */
  readonly cost?: StepCost;
  /** The delegated agent that proposed this step, when the step is the one it proposed as it was proposed (agent-harness §2). An edited step has none. */
  readonly proposedBy?: string;
}

export interface PlanCardView {
  readonly id: string;
  readonly turnId: string;
  /** `confirm` is the one-step card a single write-confirm call gets. Everything else is `plan`. */
  readonly kind: 'plan' | 'confirm';
  /** Bumped by every edit. A decision names the revision it was made against. */
  readonly revision: number;
  /** The revision the last preview ran against. Approval needs the two to agree (agent-harness §2). */
  readonly previewRevision: number;
  readonly from: number;
  readonly steps: readonly PlanStepView[];
  /** True when the latest preview is current, nothing is refused or stale or cut, and there is something to run. */
  readonly approvable: boolean;
  /** True when the only thing stopping approval is a cut draft: the user may approve by accepting the cut text. */
  readonly canAcceptCut: boolean;
  /** True when a step still to run is a draft the provider cut at its output limit. */
  readonly cut: boolean;
  /** Why the last edit or draft was not applied, when one was refused. The card is shown as it was before it. */
  readonly notice?: string;
}

/** The text a dependent step carries after an edit moved something it reads (agent-harness §2). */
export const RESOLVE_BADGE = 'will re-resolve at execution';

/**
 * Tools whose content the model does not write directly: the loop drafts (or stages) it before the card is shown, so a
 * change to their params means the draft is stale until it is drafted again (agent-harness §8). Every other tool is checked
 * again by its preflight when the card is shown, and has no draft to go stale.
 */
export const MODEL_BACKED_TOOLS: ReadonlySet<string> = new Set([
  'scene.draft',
  'synopsis.fill',
  'continuity.scan',
  'shots.derive',
  'prompt.draft',
  'prompt.variant',
  // The review's plan is staged before its card (no model call, coherence.md §7 tool 16): an edit to its params re-plans it.
  'coherence.review',
  // The transcription's schedule and route costs are staged before its card; generation and page review follow approval (pictures.md §8.4).
  'pictures.transcribe',
  // The container's Ink is drafted before its card, and checked by the dialogue module (dialogue-narrative.md §7).
  'dialogue.draft',
  // The batch's ops and the values they are checked against are staged before its card, with no model call (timeline.md §5.1): an edit to its params
  // stages it again, and the approval holds the batch to the staged values, so a scene that changed since refuses it whole.
  'timeline.edit',
]);

/** The step's params as one list of lowercased strings, at any depth. A reference is a string, so this finds every name a step names. */
function referencesOf(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') out.add(value.trim().toLowerCase());
  else if (Array.isArray(value)) for (const item of value) referencesOf(item, out);
  else if (isRecord(value)) for (const item of Object.values(value)) referencesOf(item, out);
  return out;
}

/**
 * The names a step writes or creates: the things a later step may name. A title a step creates
 * is a name, and so is a document a step writes into.
 */
export function namesOf(step: PlanStep): Set<string> {
  const names = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim() !== '') names.add(value.trim().toLowerCase());
  };
  const params = step.params;
  switch (step.tool) {
    case 'doc.import':
      add(params['title']);
      break;
    case 'binder.restructure':
      if (Array.isArray(params['ops'])) {
        for (const op of params['ops']) if (isRecord(op) && op['action'] === 'create') add(op['title']);
      }
      break;
    case 'scene.draft':
    case 'notes.append':
    case 'meta.set':
      add(params['doc']);
      if (Array.isArray(params['targets'])) for (const target of params['targets']) add(target);
      break;
    case 'synopsis.fill':
      if (Array.isArray(params['docs'])) for (const doc of params['docs']) add(doc);
      break;
    case 'codex.write':
      if (Array.isArray(params['entries'])) {
        for (const entry of params['entries']) if (isRecord(entry)) add(entry['name']);
      }
      break;
    default:
      break;
  }
  return names;
}

/** A superseded step: one an edit dropped or changed, with the position it held when the model proposed it. */
export interface Superseded {
  readonly origin: number;
  readonly step: PlanStep;
}

/**
 * The check, as a pure pass over plan data. A later step that names something a superseded
 * step created or wrote carries the "will re-resolve at execution" badge: anchors and names are
 * re-resolved when the step runs (edit-anchors §3), so the badge is a warning, not a refusal.
 */
export function dependencyBadges(steps: readonly PlanStep[], origins: readonly number[], superseded: readonly Superseded[]): string[][] {
  return steps.map((step, index) => {
    const reads = referencesOf(step.params);
    const origin = origins[index] ?? index;
    const dependent = superseded.some((gone) => gone.origin < origin && [...namesOf(gone.step)].some((name) => reads.has(name)));
    return dependent ? [RESOLVE_BADGE] : [];
  });
}

/** The state an edit works on: the steps and, for each, its origin, its staged proposal and whether that proposal is stale. */
export interface EditableSteps {
  readonly steps: readonly PlanStep[];
  readonly origins: readonly number[];
  readonly proposals: readonly unknown[];
  readonly stale: readonly boolean[];
  readonly superseded: readonly Superseded[];
  /**
   * The origins of the steps this turn has already applied. Such a step has run: it is shown as done,
   * it is never run again, and no edit may drop, change or move it. A pending step may not be moved
   * across one, so the steps that have run stay at the front of the plan.
   */
  readonly completed: readonly number[];
}

/** The edits a user can make in place (agent-harness §2): reorder, drop, and set a param, including a range anchor's fields. */
export type PlanEdit =
  | { readonly op: 'reorder'; readonly from: number; readonly to: number }
  | { readonly op: 'drop'; readonly index: number }
  | { readonly op: 'set'; readonly index: number; readonly path: readonly string[]; readonly value: unknown };

function cloneAt(value: unknown, path: readonly string[], replacement: unknown): unknown {
  if (path.length === 0) return replacement;
  const [head, ...rest] = path as [string, ...string[]];
  if (Array.isArray(value)) {
    const copy = [...value];
    const index = Number(head);
    copy[index] = cloneAt(copy[index], rest, replacement);
    return copy;
  }
  const base: Record<string, unknown> = isRecord(value) ? value : {};
  return { ...base, [head]: cloneAt(base[head], rest, replacement) };
}

/**
 * One edit, applied to the state. A change of a step's tool, expectation or params supersedes the
 * step it changes. A change to a model-backed step's params marks its proposal stale, so the loop
 * drafts it again before the card is shown. A step that is not model-backed has no draft to go stale:
 * its preflight is run again when the card is shown, so its edit leaves the flag clear, and a changed
 * tool drops the proposal the old tool staged. Refused edits name what was wrong, and change nothing.
 * An edit may not touch a step that has run, and a reorder may not move anything across one.
 */
export function applyEdit(state: EditableSteps, edit: PlanEdit): Result<EditableSteps, string> {
  const count = state.steps.length;
  const inRange = (index: number): boolean => Number.isInteger(index) && index >= 0 && index < count;
  const ran = (index: number): boolean => state.completed.includes(state.origins[index] ?? index);
  if (edit.op === 'reorder') {
    if (!inRange(edit.from) || !inRange(edit.to)) return err(`reorder names steps ${edit.from + 1} and ${edit.to + 1}, and the plan has ${count}`);
    for (let index = Math.min(edit.from, edit.to); index <= Math.max(edit.from, edit.to); index += 1) {
      if (ran(index)) return err(`step ${index + 1} has already run, so the steps around it cannot move past it: a reorder can only move steps that have not run yet`);
    }
    const move = <T>(items: readonly T[]): T[] => {
      const copy = [...items];
      const [moved] = copy.splice(edit.from, 1);
      copy.splice(edit.to, 0, moved as T);
      return copy;
    };
    return ok({ ...state, steps: move(state.steps), origins: move(state.origins), proposals: move(state.proposals), stale: move(state.stale) });
  }
  if (!inRange(edit.index)) return err(`step ${edit.index + 1} is not in the plan, which has ${count}`);
  if (ran(edit.index)) return err(`step ${edit.index + 1} has already run, so it cannot be ${edit.op === 'drop' ? 'dropped' : 'changed'}`);
  if (edit.op === 'drop') {
    if (count === 1) return err('a plan needs at least one step, so the last step cannot be dropped: reject the card instead');
    const removed = state.steps[edit.index] as PlanStep;
    const without = <T>(items: readonly T[]): T[] => items.filter((_, index) => index !== edit.index);
    return ok({
      ...state,
      steps: without(state.steps),
      origins: without(state.origins),
      proposals: without(state.proposals),
      stale: without(state.stale),
      superseded: [...state.superseded, { origin: state.origins[edit.index] ?? edit.index, step: removed }],
    });
  }
  // set
  if (edit.path.length === 0 || !['tool', 'expect', 'params'].includes(edit.path[0] as string)) {
    return err('a step can be edited at tool, expect or params, and the path must start with one of them');
  }
  const current = state.steps[edit.index] as PlanStep;
  const next = cloneAt(current, edit.path, edit.value) as PlanStep;
  if (typeof next.tool !== 'string' || typeof next.expect !== 'string' || !isRecord(next.params)) {
    return err('an edit must leave the step with a tool name, an expectation and an object of params');
  }
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  if (!changed) return ok(state);
  const steps = state.steps.map((step, index) => (index === edit.index ? next : step));
  // Only a model-backed step's draft can go stale (see MODEL_BACKED_TOOLS). Its draft was staged for the tool it had, so a
  // change of tool also drops that proposal: the draft for the new tool is made again, or none is needed.
  // An expectation is a label the card shows; no draft reads it, so editing it leaves the draft and its flag as they are.
  const drafted = edit.path[0] !== 'expect';
  const toolChanged = next.tool !== current.tool;
  const stale = state.stale.map((flag, index) => (index !== edit.index ? flag : drafted ? MODEL_BACKED_TOOLS.has(next.tool) : flag));
  const proposals = toolChanged ? state.proposals.map((proposal, index) => (index === edit.index ? undefined : proposal)) : state.proposals;
  return ok({
    ...state,
    steps,
    proposals,
    stale,
    superseded: [...state.superseded, { origin: state.origins[edit.index] ?? edit.index, step: current }],
  });
}

/**
 * A step's estimated cost at the profile's price (provider-gateway §6, display only): the shape a prompt preview's `cost` has,
 * so a card totals a step's cost the same way whether the step drafted a prompt or staged a review.
 */
export type StepCost = NonNullable<PromptPreview['cost']> & {
  /** The reply side counts the thinking the level asked for as well as the output cap; the card says "including thinking". */
  readonly includesThinking?: true;
};

/**
 * A dollar amount for a plan card: four decimals under a dollar, where a single step's cost sits, two above it, and a floor
 * word for an amount too small to show. Kept beside the reference below so the English and the id cannot drift.
 */
export function formatUsd(value: number): string {
  if (value < 0.0001) return 'under $0.0001';
  return value < 1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/**
 * The plan-card cost estimate as a message reference (I7): the same sentence {@link formatUsd} and the
 * card already render, with each amount as a value so a translation may reorder them. Undefined when
 * the profile has no price, as the English line is.
 */
export function costLineRef(cost: StepCost | undefined): MessageRef | undefined {
  if (cost === undefined) return undefined;
  const total = formatUsd(cost.totalUsd);
  const prompt = formatUsd(cost.promptUsd);
  const reply = formatUsd(cost.completionUsd);
  return cost.includesThinking === true
    ? {
        id: 'harness.plan.costThinking',
        message: 'About {total} (prompt {prompt}, reply {reply} including thinking).',
        values: { total, prompt, reply },
      }
    : { id: 'harness.plan.cost', message: 'About {total} (prompt {prompt}, reply {reply}).', values: { total, prompt, reply } };
}

/**
 * What a coherence review's plan is estimated to cost at the active model's price (coherence.md §5.3: the card shows the cost
 * "before running"; context-assembly §5 gives the same rule for a prompt). The prompt side is the plan's own token estimate. The
 * reply side is the output cap of each call the plan makes, which the plan does not estimate, so the card shows the bound the
 * spec names: `maxOutputTokens` (the model's, or the default) per call, extraction and verification alike. When the limits carry
 * `thinkingTokens` (a thinking level is set), each call's bound adds them and the cost says it includes thinking. Undefined when
 * the model has no price, so an unpriced profile shows no cost.
 */
export function reviewCostOf(plan: ReviewPlan, model: ModelLimits | undefined): StepCost | undefined {
  const price = model?.pricePer1k;
  if (price === undefined) return undefined;
  const calls = plan.estimate.extractCalls + plan.estimate.verifyCallsAtMost;
  const thinking = model?.thinkingTokens ?? 0;
  const replyTokens = calls * ((model?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) + thinking);
  const promptUsd = (plan.estimate.totalTokensAtMost / 1000) * price.prompt;
  const completionUsd = (replyTokens / 1000) * price.completion;
  return { promptUsd, completionUsd, totalUsd: promptUsd + completionUsd, ...(thinking > 0 ? { includesThinking: true as const } : {}) };
}

/** Where a review's cost reads its limits: the gateway's `modelLimits`, which carries the model's price and output cap. */
export interface ReviewLimitsSource {
  modelLimits(profileId?: string, model?: string, thinking?: ThinkingLevel): ModelLimits;
}

/**
 * A review plan's cost at the gateway's limits for a profile and model: the one place the agent's plan card and the Findings tab
 * read the limits from, so the two surfaces show one figure for one plan. `model` undefined is the profile's default model, which
 * is the model an agent session runs on when it names none. `thinking` is the level the review's calls run at, when one is set.
 */
export function reviewCostAt(
  plan: ReviewPlan,
  gateway: ReviewLimitsSource,
  profileId?: string,
  model?: string,
  thinking?: ThinkingLevel,
): StepCost | undefined {
  return reviewCostOf(plan, gateway.modelLimits(profileId, model, thinking));
}

export interface TranscriptionCosts {
  readonly primary?: StepCost;
  readonly second?: StepCost;
  /** The whole figure only when every selected route has a price; an unpriced second route never disappears into a partial total. */
  readonly total?: StepCost;
}

function transcriptionRouteCost(plan: PictureTranscriptionPlan, model: ModelLimits): StepCost | undefined {
  const price = model.pricePer1k;
  if (price === undefined) return undefined;
  const reads = plan.secondRead === undefined ? 1 : 2;
  const requests = plan.estimate.requests / reads;
  const promptTokens = plan.estimate.promptTokens / reads;
  const replyTokens = plan.estimate.outputTokens / reads + requests * (model.thinkingTokens ?? 0);
  const promptUsd = (promptTokens / 1000) * price.prompt;
  const completionUsd = (replyTokens / 1000) * price.completion;
  return {
    promptUsd,
    completionUsd,
    totalUsd: promptUsd + completionUsd,
    ...((model.thinkingTokens ?? 0) > 0 ? { includesThinking: true as const } : {}),
  };
}

/** Both explicitly selected transcription routes priced separately, before generation (pictures.md §8.4 step 1). */
export function transcriptionCostAt(
  plan: PictureTranscriptionPlan,
  gateway: ReviewLimitsSource,
  profileId?: string,
  model?: string,
  thinking?: ThinkingLevel,
): TranscriptionCosts {
  const primary = transcriptionRouteCost(plan, gateway.modelLimits(profileId, model, thinking));
  const second = plan.secondRead === undefined
    ? undefined
    : transcriptionRouteCost(plan, gateway.modelLimits(plan.secondRead.profileId, plan.secondRead.model));
  if (primary === undefined || (plan.secondRead !== undefined && second === undefined)) return { ...(primary === undefined ? {} : { primary }), ...(second === undefined ? {} : { second }) };
  const promptUsd = primary.promptUsd + (second?.promptUsd ?? 0);
  const completionUsd = primary.completionUsd + (second?.completionUsd ?? 0);
  return {
    primary,
    ...(second === undefined ? {} : { second }),
    total: {
      promptUsd,
      completionUsd,
      totalUsd: promptUsd + completionUsd,
      ...(primary.includesThinking === true || second?.includesThinking === true ? { includesThinking: true as const } : {}),
    },
  };
}

/** What a staged proposal shows a card: whether the provider cut it, the prompt behind it, and the step's cost when it has one. */
export interface StagedView {
  readonly cut: boolean;
  readonly context?: PromptPreview;
  readonly cost?: StepCost;
}

/** A staged proposal's cost, as the card reads it: three numbers, or nothing. A proposal that carries no cost has none. */
function costOf(value: unknown): StepCost | undefined {
  if (!isRecord(value)) return undefined;
  const { promptUsd, completionUsd, totalUsd } = value;
  if (typeof promptUsd !== 'number' || typeof completionUsd !== 'number' || typeof totalUsd !== 'number') return undefined;
  return { promptUsd, completionUsd, totalUsd, ...(value['includesThinking'] === true ? { includesThinking: true as const } : {}) };
}

/** The card's view of one staged proposal. A step with nothing staged shows neither a cut nor a prompt. */
export function stagedOf(proposal: unknown): StagedView {
  if (!isRecord(proposal)) return { cut: false };
  const context = isRecord(proposal['context']) ? (proposal['context'] as unknown as PromptPreview) : undefined;
  const cost = costOf(proposal['cost']);
  return {
    cut: proposal['cut'] === true,
    ...(context === undefined ? {} : { context }),
    ...(cost === undefined ? {} : { cost }),
  };
}

/** The card a state renders to, with the preflight and the previews that were run for it. */
export function planCardOf(args: {
  readonly id: string;
  readonly turnId: string;
  readonly kind: 'plan' | 'confirm';
  readonly revision: number;
  readonly previewRevision: number;
  readonly from: number;
  readonly state: EditableSteps;
  readonly preflight: PlanPreflight;
  readonly previews: readonly (unknown | undefined)[];
  readonly risks: readonly string[];
  readonly staged?: readonly StagedView[];
  /** The delegated agent each step was proposed by, aligned to the steps. */
  readonly proposedBy?: readonly (string | undefined)[];
  readonly notice?: string;
}): PlanCardView {
  const badges = dependencyBadges(args.state.steps, args.state.origins, args.state.superseded);
  const staged = args.staged ?? [];
  const steps: PlanStepView[] = args.state.steps.map((step, index): PlanStepView => {
    const origin = args.state.origins[index] ?? index;
    const context = staged[index]?.context;
    const cost = staged[index]?.cost;
    const proposer = args.proposedBy?.[index];
    const shared = {
      index,
      origin,
      tool: step.tool,
      expect: step.expect,
      risk: args.risks[index] ?? 'read',
      params: step.params,
      badges: badges[index] ?? [],
      stale: args.state.stale[index] === true,
      cut: staged[index]?.cut === true,
      ...(context === undefined ? {} : { context }),
      ...(cost === undefined ? {} : { cost }),
      ...(proposer === undefined ? {} : { proposedBy: proposer }),
    };
    if (args.state.completed.includes(origin)) return { ...shared, status: 'done' };
    const checked = args.preflight.steps.find((entry) => entry.index === index);
    const status: PlanStepView['status'] = checked?.status === 'refused' ? 'refused' : checked?.status === 'deferred' ? 'deferred' : 'ready';
    // The step's own preview comes from its drafted proposal when it has one (scene, synopsis and findings drafts), and
    // otherwise from its prepare, which the preflight carries (a codex diff, a restructure's tree). Both are what the card shows.
    const preview = args.previews[index] ?? checked?.preview;
    return {
      ...shared,
      status,
      ...(preview === undefined ? {} : { preview }),
      ...(checked?.error === undefined ? {} : { error: checked.error }),
    };
  });
  const pending = steps.filter((step) => step.status !== 'done');
  const current = args.previewRevision === args.revision;
  const staleAny = pending.some((step) => step.stale);
  const cutAny = pending.some((step) => step.cut);
  const usable = current && args.preflight.ok && pending.length > 0 && !staleAny;
  return {
    id: args.id,
    turnId: args.turnId,
    kind: args.kind,
    revision: args.revision,
    previewRevision: args.previewRevision,
    from: args.from,
    steps,
    approvable: usable && !cutAny,
    canAcceptCut: usable && cutAny,
    cut: cutAny,
    ...(args.notice === undefined ? {} : { notice: args.notice }),
  };
}
