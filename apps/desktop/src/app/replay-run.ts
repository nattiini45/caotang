/**
 * Running one replay for the dialog (agent-harness §8.1): the engine call, with the app's own gateway, the project's rules, and the
 * writer's answer for a card nobody has seen the like of.
 *
 * The engine does the work on a scratch copy and can only reach a profile the writer saved. This module supplies what only the app has:
 * the live gateway (so the writer's own key and role routing apply), the project's read-deny (so a replay never sends text the writer
 * withheld), the starting state kept for the turn, and the dialog's answer when a new card names tools the recording did not run.
 */

import { estimateReplay, indexTrace, replay, ReplayRefusal, type Decision, type PendingCard, type ReplayEstimate, type ReplayMode, type ReplayResult, type ReplaySource, type ReplayTarget, type TraceStore } from '@caotang/harness';
import type { Gateway } from '@caotang/gateway';
import type { ProjectState } from '@caotang/store';

import type { SourcedRule } from '@caotang/harness';

/** Everything one replay needs, as the app holds it. */
export interface RunReplayOptions {
  readonly store: TraceStore;
  readonly turnId: string;
  readonly mode: ReplayMode;
  /** The destination, for `turn`. Absent for `cassette`, which answers from the recording. */
  readonly target?: ReplayTarget;
  /** The project as the turn found it, kept by the tab while traces are on. */
  readonly snapshot?: ProjectState;
  readonly gateway: Gateway;
  /** The agent's rules, read now, so the replay is assembled under the same read-deny as the turn. */
  readonly rules: () => { readonly rules: readonly SourcedRule[] };
  /** The most model calls the replay may make, so the estimate's bound and the run's are one number. */
  readonly maxModelCalls?: number;
  readonly clock?: () => number;
  readonly signal?: AbortSignal;
  /** Asked when the replay reaches a card the recording does not cover. Absent, such a card cancels the replay. */
  readonly decide?: (pending: PendingCard) => Promise<Decision>;
}

/** What a replay would cost, before any of it is sent. */
export function estimate(options: {
  readonly store: TraceStore;
  readonly turnId: string;
  readonly mode: ReplayMode;
  readonly target?: ReplayTarget;
  readonly gateway: Pick<Gateway, 'modelLimits'>;
  readonly callIndex?: number;
  readonly maxModelCalls?: number;
}): ReplayEstimate {
  return estimateReplay(
    {
      mode: options.mode,
      source: indexTrace(options.store.records()),
      turnId: options.turnId,
      ...(options.callIndex === undefined ? {} : { callIndex: options.callIndex }),
      ...(options.target === undefined ? {} : { target: options.target }),
      ...(options.maxModelCalls === undefined ? {} : { maxModelCalls: options.maxModelCalls }),
    },
    (profileId, model, thinking) => options.gateway.modelLimits(profileId, model, thinking),
  );
}

/** Runs one replay and hands back the comparison. A refusal is the engine's answer, and the caller says it in the writer's words. */
export async function runReplay(options: RunReplayOptions): Promise<ReplayResult> {
  const source: ReplaySource = indexTrace(options.store.records());
  if (options.mode === 'cassette' && options.snapshot === undefined) {
    throw new ReplayRefusal('no-snapshot', 'This turn was not recorded with the project it started on, so it cannot be re-run. Turn traces on before the turn you want to compare.');
  }
  return replay({
    mode: options.mode,
    source,
    turnId: options.turnId,
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
    gateway: options.gateway,
    rules: options.rules,
    ...(options.maxModelCalls === undefined ? {} : { maxModelCalls: options.maxModelCalls }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    // A cassette answers from the mock's own store, so the caller's gateway is not what sends; the engine ignores the target there.
    decide: options.decide ?? (async () => ({ action: 'cancel' })),
  });
}
