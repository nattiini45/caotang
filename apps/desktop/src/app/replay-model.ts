/**
 * The Replay… dialog's model (agent-harness §8.1): the turns this tab can replay, the destinations a replay may be sent to, the
 * estimate shown before anything is spent, and the engine call itself.
 *
 * The engine is the harness's (`replay`), which runs on a scratch copy of the project and can only reach a profile the writer saved;
 * this module is what the app decides around it: which modes a turn can be offered in, which destination rows are real, and how the
 * comparison is said in words. Everything here is pure or takes its effects as arguments, so the panel stays a view.
 */

import { ReplayRefusal, type ReplayMode, type ReplayTarget } from '@caotang/harness';
import type { ProfileView, ThinkingLevel } from '@caotang/gateway';

/**
 * The modes a turn can be replayed in, and the ones it cannot, each with the reason said to the writer. A cassette needs no key, so it
 * is offered even with no profile saved; the other two send the writer's text to a provider and need one.
 */
export interface ModeOffer {
  readonly mode: ReplayMode;
  /** Why this mode is not offered, or `undefined` when it is. */
  readonly refused?: string;
}

/** A destination a replay can be sent to: one saved profile, at the model the writer picks for it. */
export interface ReplayDestination {
  readonly profileId: string;
  readonly label: string;
  readonly model: string;
  readonly thinking?: ThinkingLevel;
}

/** What the dialog shows while it runs. */
export type ReplayRun =
  | { readonly kind: 'idle' }
  | { readonly kind: 'estimating' }
  | { readonly kind: 'ready'; readonly line: string }
  | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly result: ReplayOutcome }
  | { readonly kind: 'refused'; readonly text: string }
  | { readonly kind: 'failed'; readonly text: string };

/** The parts of a finished replay the panel draws. */
export interface ReplayOutcome {
  readonly mode: ReplayMode;
  /** How the turn ended on the other model, or the call's answer for mode `call`. */
  readonly headline: string;
  /** One line per step that moved, in the writer's words. */
  readonly steps: readonly string[];
  /** The texts each side left, one row each. */
  readonly drafts: readonly ReplayDraftRow[];
  readonly tokens: string;
  readonly stopped?: string;
}

/** One document's text as each side left it, ready to draw. */
export interface ReplayDraftRow {
  readonly title: string;
  readonly field: string;
  readonly original: string;
  readonly replay: string;
  readonly words: string;
}

const MODE_ORDER: readonly ReplayMode[] = ['call', 'turn', 'cassette'];

/**
 * The modes this turn can be replayed in. A call replay re-sends one recorded request, so it needs a request the recording kept whole;
 * a turn replay needs the project as the turn found it, which the app keeps only while traces are on, and a destination to run on;
 * a cassette needs that same starting state and nothing else.
 */
export function modeOffers(options: {
  readonly hasCall: boolean;
  readonly hasSnapshot: boolean;
  readonly hasDestination: boolean;
}): readonly ModeOffer[] {
  return MODE_ORDER.map((mode): ModeOffer => {
    if (mode === 'call') return options.hasCall ? { mode } : { mode, refused: 'This recording holds no model call kept whole, so there is no single request to re-send.' };
    if (!options.hasSnapshot) {
      return { mode, refused: 'This turn was not recorded with the project it started on, so it cannot be re-run. Turn traces on before the turn you want to compare.' };
    }
    if (mode === 'turn' && !options.hasDestination) return { mode, refused: 'No provider is saved, so there is nowhere to send this turn. Add one in Settings, then replay.' };
    return { mode };
  });
}

/** The mode a dialog opens on: the first it can offer, or `cassette` when none can be. */
export function defaultMode(offers: readonly ModeOffer[]): ReplayMode {
  return offers.find((offer) => offer.refused === undefined)?.mode ?? 'cassette';
}

/**
 * The destinations a replay may be sent to: every saved real profile at its own default model, never the demo profile (a replay
 * compares models, and the demo answers from a script), and never a profile the writer has not saved.
 */
export function destinationsOf(profiles: readonly ProfileView[], models?: (profile: ProfileView) => string | undefined): readonly ReplayDestination[] {
  return profiles
    .filter((profile) => profile.kind !== 'mock')
    .map((profile): ReplayDestination => ({
      profileId: profile.id,
      label: profile.name,
      model: models?.(profile) ?? profile.defaultModel,
    }));
}

/** A destination as the engine takes it. */
export function targetOf(destination: ReplayDestination): ReplayTarget {
  return {
    profileId: destination.profileId,
    model: destination.model,
    ...(destination.thinking === undefined ? {} : { thinking: destination.thinking }),
  };
}

/** The estimate, in the words the dialog shows before it spends anything. */
export function estimateLine(estimate: { readonly modelCalls: number; readonly promptTokens: number; readonly maxCompletionTokens: number; readonly costUsd?: number }): string {
  const calls = estimate.modelCalls === 1 ? '1 model call' : `${count(estimate.modelCalls)} model calls`;
  const cost = estimate.costUsd === undefined ? 'this model has no price row, so the cost is not known here' : estimate.costUsd < 0.01 ? 'under a cent' : `about $${estimate.costUsd.toFixed(2)}`;
  return `${calls}: ${count(estimate.promptTokens)} prompt tokens, at most ${count(estimate.maxCompletionTokens)} back; ${cost}.`;
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * The refusal a replay can raise, said as the writer can act on it. A refusal is the engine's answer about this recording, not a
 * failure: it says which way to replay instead.
 */
export function refusalText(error: unknown): string | undefined {
  if (error instanceof ReplayRefusal) return error.message;
  return undefined;
}

/** Where a replay stopped, said in the writer's words. */
export function stopText(stop: { readonly reason: string; readonly detail: string }): string {
  if (stop.reason === 'decision-mismatch') return `This model proposed different steps, and nobody approved the like of them, so the replay stopped before it changed anything. ${stop.detail}`;
  if (stop.reason === 'external-tool') return `A step calls an outside tool, and a replay never re-runs one, so the replay stopped there. ${stop.detail}`;
  if (stop.reason === 'cassette-miss') return `The replay's prompt did not match the recording, so there is no recorded answer to compare. ${stop.detail}`;
  return stop.detail;
}

/** How one step reads: what the recording ran, what the replay ran, and which params moved. */
export function stepLine(step: {
  readonly index: number;
  readonly original?: { readonly tool: string };
  readonly replay?: { readonly tool: string };
  readonly changedParams: readonly string[];
}): string {
  const was = step.original === undefined ? 'nothing' : step.original.tool;
  const now = step.replay === undefined ? 'nothing' : step.replay.tool;
  const which = step.changedParams.length === 0 ? '' : ` (${step.changedParams.join(', ')} changed)`;
  return `Step ${step.index + 1}: ${was} → ${now}${which}`;
}

/** What the mode's result reads as, at the top of the comparison. */
export function headlineOf(result: { readonly mode: ReplayMode; readonly report?: { readonly status: string; readonly summary: string }; readonly reply?: { readonly content: string } }): string {
  if (result.mode !== 'call') return result.report === undefined ? 'The replay did not finish a turn.' : `${result.report.status}: ${result.report.summary}`;
  const content = result.reply?.content.trim() ?? '';
  return content === '' ? 'The model answered with no text.' : content;
}

/** Both sides' tokens and what the replay cost, in one line. */
export function tokensLine(usage: { readonly original: { readonly promptTokens: number; readonly completionTokens: number; readonly modelCalls: number }; readonly replay: { readonly promptTokens: number; readonly completionTokens: number; readonly modelCalls: number; readonly costUsd?: number } }): string {
  const cost = usage.replay.costUsd === undefined ? 'cost not known' : usage.replay.costUsd < 0.01 ? 'under a cent' : `$${usage.replay.costUsd.toFixed(2)}`;
  return `Recording: ${count(usage.original.promptTokens)} prompt + ${count(usage.original.completionTokens)} back over ${usage.original.modelCalls} ${usage.original.modelCalls === 1 ? 'call' : 'calls'}. Replay: ${count(usage.replay.promptTokens)} + ${count(usage.replay.completionTokens)} over ${usage.replay.modelCalls} (${cost}).`;
}

/** The drafts the two sides wrote, as rows the panel draws side by side. */
export function draftRows(drafts: readonly { readonly title: string; readonly field: 'body' | 'synopsis'; readonly original: string; readonly replay: string; readonly words: { readonly original: number; readonly replay: number } }[]): readonly ReplayDraftRow[] {
  return drafts.map((diff) => ({
    title: diff.title,
    field: diff.field === 'body' ? 'text' : 'synopsis',
    original: diff.original,
    replay: diff.replay,
    words: `${count(diff.words.original)} → ${count(diff.words.replay)} words`,
  }));
}

