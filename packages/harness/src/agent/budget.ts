/**
 * Run limits (agent-harness §7.1): the caps a writer sets on their own key, held so that no call crosses them.
 *
 * A `BudgetMeter` is pure apart from its clock. Before a model call is sent it reserves the call's worst case (the prompt's
 * estimate plus the output cap the request carries) and refuses the call when spent plus every reservation in flight plus that
 * worst case would pass a cap. After the call it settles the reservation with the usage that came back. Two limits are time: active
 * time (work, not the minutes a card waits for the writer) and an absolute deadline. They abort `signal`, which the turn combines
 * with the writer's Stop, so a limit ends a call in flight by the path Stop uses.
 *
 * Caotang charges nothing and enforces nothing it chose: every limit is the writer's. An absent limit is not enforced, and a
 * session with no meter behaves as before. Words changed and documents touched stay `mode.ts`'s turn budgets: they are measured
 * from the activity log after a card applies, not before a call.
 */

import { err, ok, type Result } from '@caotang/bus';
import { systemClock, type Clock, type TimerId, type Usage } from '@caotang/gateway';

import type { BudgetDimension, TurnBudget } from './mode.js';

/** The limits a run may carry, named as `TurnBudget`'s fields are. Absent means unlimited; `deadline` is epoch milliseconds. */
export interface RunLimits extends Partial<Pick<TurnBudget, 'maxModelCalls' | 'maxTokens' | 'maxCostUsd' | 'maxSteps'>> {
  /** Milliseconds spent working, excluding the time a card waits for the writer. */
  readonly maxActiveMs?: number;
  readonly deadline?: number;
}

/** A superset of `BudgetUse` for the dimensions a meter owns. */
export interface BudgetSpend {
  readonly modelCalls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Tokens counted from the local estimate because the provider reported no usage for that call. */
  readonly estimatedTokens: number;
  /** Absent while no priced call has settled. */
  readonly costUsd?: number;
  readonly steps: number;
  readonly activeMs: number;
}

/** The limit a run ran into. `needed` is what a refused call would have taken, `unpriced` a cost limit with no price to count it by. */
export interface BudgetStop {
  readonly dimension: BudgetDimension;
  readonly limit: number;
  readonly spent: number;
  readonly needed?: number;
  readonly unpriced?: true;
}

/** A call's worst case, held from the moment it is allowed until it settles. */
export interface Reservation {
  readonly id: string;
  readonly promptTokens: number;
  readonly maxOutputTokens: number;
  readonly price?: { readonly prompt: number; readonly completion: number };
}

export interface BudgetMeter {
  readonly limits: RunLimits;
  spend(): BudgetSpend;
  /** Refuses when spend plus every reservation in flight plus this call's worst case would pass a cap. */
  reserve(call: Omit<Reservation, 'id'>): Result<Reservation, BudgetStop>;
  /**
   * Replaces the reservation with what the call used. With no usage the call settles at `estimate` (the prompt and the text that
   * arrived) or, with none given, at its whole reservation, and the tokens count as estimated.
   */
  settle(reservation: Reservation, usage: Usage | undefined, estimate?: Usage): void;
  /** Counts applied steps. Refused, with the step counted, when it passes `maxSteps`. */
  countStep(count?: number): Result<void, BudgetStop>;
  /** Steps the run may still apply; `Infinity` without a step limit. */
  stepsLeft(): number;
  /** Paused while a card waits for the writer, so `maxActiveMs` measures work. Calls nest. */
  pauseClock(): void;
  resumeClock(): void;
  /** Aborts when active time or the deadline passes. The turn combines it with the writer's own signal. */
  readonly signal: AbortSignal;
  /** The time limit that aborted `signal`, or `undefined`. */
  stopped(): BudgetStop | undefined;
  /** Ends the run on a limit; the writer's Stop goes through the turn's own controller. */
  stop(reason: BudgetStop): void;
  /** Cancels the timer. The meter still answers `reserve` and `stopped` from its clock afterwards. */
  dispose(): void;
  toJSON(): { readonly limits: RunLimits; readonly spend: BudgetSpend };
}

export interface BudgetMeterOptions {
  readonly clock?: Clock;
  /** The spend of an earlier session of the same run, restored after a reload. */
  readonly restored?: BudgetSpend;
}

/** Ten minutes of active time: the writer's default per turn. */
export const DEFAULT_ACTIVE_MS = 10 * 60_000;

/** Float noise in a dollar sum is not a crossing. */
const COST_EPSILON = 1e-9;

const costOf = (price: { readonly prompt: number; readonly completion: number }, promptTokens: number, completionTokens: number): number =>
  (promptTokens / 1_000) * price.prompt + (completionTokens / 1_000) * price.completion;

/** A token figure the meter can add: finite and not below zero. */
const isCount = (value: number): boolean => Number.isFinite(value) && value >= 0;

export function createBudgetMeter(limits: RunLimits = {}, options: BudgetMeterOptions = {}): BudgetMeter {
  const clock = options.clock ?? systemClock;
  const restored = options.restored;
  const controller = new AbortController();
  let stoppedBy: BudgetStop | undefined;
  let modelCalls = restored?.modelCalls ?? 0;
  let promptTokens = restored?.promptTokens ?? 0;
  let completionTokens = restored?.completionTokens ?? 0;
  let estimatedTokens = restored?.estimatedTokens ?? 0;
  let costUsd = restored?.costUsd;
  let steps = restored?.steps ?? 0;
  let activeBase = restored?.activeMs ?? 0;
  let runningSince: number | undefined = clock.now();
  let pauses = 0;
  let sequence = 0;
  let timer: TimerId | undefined;
  const held = new Map<string, Reservation>();

  // A clock stepped backwards must not take time off what the run has already used.
  const activeMs = (): number => activeBase + (runningSince === undefined ? 0 : Math.max(0, clock.now() - runningSince));

  const timeHit = (): BudgetStop | undefined => {
    const now = clock.now();
    if (limits.deadline !== undefined && now >= limits.deadline) return { dimension: 'deadline', limit: limits.deadline, spent: now };
    const active = activeMs();
    if (limits.maxActiveMs !== undefined && active >= limits.maxActiveMs) return { dimension: 'active-time', limit: limits.maxActiveMs, spent: active };
    return undefined;
  };

  const disarm = (): void => {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
  };

  const stop = (reason: BudgetStop): void => {
    if (stoppedBy !== undefined) return;
    stoppedBy = reason;
    disarm();
    controller.abort();
  };

  /** Stops the run when a time limit has passed by the clock; the answer is the stop, if any. */
  const check = (): BudgetStop | undefined => {
    if (stoppedBy === undefined) {
      const hit = timeHit();
      if (hit !== undefined) stop(hit);
    }
    return stoppedBy;
  };

  /** One timer, set for the nearest limit still ahead; it checks the clock again when it fires. */
  const arm = (): void => {
    disarm();
    if (stoppedBy !== undefined) return;
    let due: number | undefined;
    if (limits.deadline !== undefined) due = limits.deadline - clock.now();
    if (limits.maxActiveMs !== undefined && runningSince !== undefined) {
      const left = limits.maxActiveMs - activeMs();
      due = due === undefined ? left : Math.min(due, left);
    }
    if (due === undefined) return;
    timer = clock.setTimeout(() => {
      timer = undefined;
      check();
      arm();
    }, Math.max(0, due));
    // A pending limit must not keep a process alive.
    (timer as { unref?: () => void } | undefined)?.unref?.();
  };

  const reservedTokens = (): number => {
    let total = 0;
    for (const reservation of held.values()) total += reservation.promptTokens + reservation.maxOutputTokens;
    return total;
  };

  const reservedCost = (): number => {
    let total = 0;
    for (const reservation of held.values()) {
      if (reservation.price !== undefined) total += costOf(reservation.price, reservation.promptTokens, reservation.maxOutputTokens);
    }
    return total;
  };

  const meter: BudgetMeter = {
    limits,
    signal: controller.signal,

    spend: () => ({
      modelCalls,
      promptTokens,
      completionTokens,
      estimatedTokens,
      ...(costUsd === undefined ? {} : { costUsd }),
      steps,
      activeMs: activeMs(),
    }),

    reserve(call) {
      const time = check();
      if (time !== undefined) return err(time);
      if (limits.maxModelCalls !== undefined && modelCalls >= limits.maxModelCalls) {
        return err({ dimension: 'model-calls', limit: limits.maxModelCalls, spent: modelCalls });
      }
      const spentTokens = promptTokens + completionTokens;
      if (limits.maxTokens !== undefined) {
        const needed = spentTokens + reservedTokens() + call.promptTokens + call.maxOutputTokens;
        if (needed > limits.maxTokens) return err({ dimension: 'tokens', limit: limits.maxTokens, spent: spentTokens, needed });
      }
      if (limits.maxCostUsd !== undefined) {
        if (call.price === undefined) return err({ dimension: 'cost', limit: limits.maxCostUsd, spent: costUsd ?? 0, unpriced: true });
        const needed = (costUsd ?? 0) + reservedCost() + costOf(call.price, call.promptTokens, call.maxOutputTokens);
        if (needed > limits.maxCostUsd + COST_EPSILON) return err({ dimension: 'cost', limit: limits.maxCostUsd, spent: costUsd ?? 0, needed });
      }
      sequence += 1;
      const reservation: Reservation = { id: `reservation-${sequence}`, ...call };
      held.set(reservation.id, reservation);
      modelCalls += 1;
      return ok(reservation);
    },

    settle(reservation, usage, estimate) {
      if (!held.delete(reservation.id)) return;
      // A figure a provider reports that cannot be a count (negative or not finite) is no usage: the call settles at the estimate.
      const reported = usage !== undefined && isCount(usage.promptTokens) && isCount(usage.completionTokens) ? usage : undefined;
      const used = reported ?? estimate ?? { promptTokens: reservation.promptTokens, completionTokens: reservation.maxOutputTokens };
      promptTokens += used.promptTokens;
      completionTokens += used.completionTokens;
      if (reported === undefined) estimatedTokens += used.promptTokens + used.completionTokens;
      if (reservation.price !== undefined) costUsd = (costUsd ?? 0) + costOf(reservation.price, used.promptTokens, used.completionTokens);
    },

    countStep(count = 1) {
      steps += count;
      if (limits.maxSteps !== undefined && steps > limits.maxSteps) return err({ dimension: 'steps', limit: limits.maxSteps, spent: steps });
      return ok(undefined);
    },

    stepsLeft: () => (limits.maxSteps === undefined ? Infinity : Math.max(0, limits.maxSteps - steps)),

    pauseClock() {
      pauses += 1;
      if (pauses > 1 || runningSince === undefined) return;
      activeBase = activeMs();
      runningSince = undefined;
      arm();
    },

    resumeClock() {
      if (pauses === 0) return;
      pauses -= 1;
      if (pauses > 0) return;
      runningSince = clock.now();
      arm();
    },

    stopped: check,
    stop,
    dispose: disarm,
    toJSON: () => ({ limits, spend: meter.spend() }),
  };

  arm();
  return meter;
}

/** A meter's signal and the writer's, as one: either aborts it. */
export function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([...signals]);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/** Milliseconds as the writer reads a time limit: whole minutes where they are, else seconds. */
function durationOf(ms: number): string {
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  const seconds = Math.max(1, Math.round(ms / 1_000));
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

const dollars = (amount: number): string => `$${amount.toFixed(4)}`;

const RAISE: Readonly<Partial<Record<BudgetDimension, string>>> = {
  'model-calls': 'model calls',
  tokens: 'tokens',
  cost: 'cost',
  steps: 'steps',
  'active-time': 'time',
};

/**
 * What a turn that ran into a run limit says, and the options it offers. A call that was refused names what it would have needed,
 * so a limit the writer reads is never a surprise. `profile` names the profile an unpriced cost limit cannot be counted on.
 */
export function runLimitWords(stop: BudgetStop, profile?: string): { readonly reason: string; readonly options: readonly string[] } {
  const keep = 'stop here and keep what was applied';
  if (stop.unpriced === true) {
    return {
      reason: `This run has a cost limit, and the profile “${profile ?? 'in use'}” has no prices, so its cost cannot be counted. Add its prices in Settings › Providers, or use a token limit.`,
      options: ['add the profile’s prices in Settings › Providers, then send the request again', 'use a token limit instead of a cost limit in Settings › Agent'],
    };
  }
  const raise = RAISE[stop.dimension];
  const options = [raise === undefined ? 'send the request again after the deadline is moved' : `raise the ${raise} limit in Settings › Agent, then send the request again`, keep];
  switch (stop.dimension) {
    case 'model-calls':
      return { reason: `the run made ${stop.limit} model calls, which is its limit, so it stopped before another`, options };
    case 'tokens':
      return {
        reason:
          stop.needed === undefined
            ? `the run used ${stop.spent} of its ${stop.limit} tokens, so it stopped`
            : `the next model call could use up to ${stop.needed} tokens in all, past the run’s limit of ${stop.limit} (${stop.spent} used), so it was not sent`,
        options,
      };
    case 'cost':
      return {
        reason:
          stop.needed === undefined
            ? `the run spent ${dollars(stop.spent)} of its ${dollars(stop.limit)}, so it stopped`
            : `the next model call could cost up to ${dollars(stop.needed)} in all, past the run’s limit of ${dollars(stop.limit)} (${dollars(stop.spent)} spent), so it was not sent`,
        options,
      };
    case 'steps':
      return { reason: `the run applied ${stop.spent} of its ${stop.limit} steps, so it stopped before another`, options };
    case 'active-time':
      return { reason: `the run worked for ${durationOf(stop.limit)}, which is its time limit, so it stopped`, options };
    case 'deadline':
      return { reason: 'the run’s deadline passed, so it stopped', options };
    default:
      return { reason: `the run reached its ${stop.dimension} limit of ${stop.limit}, so it stopped`, options };
  }
}

/** What the planner is told when a plan has more write steps than the run may still apply. */
export function stepLimitWords(limit: number, used: number, left: number): string {
  return `the run’s limit is ${limit} applied steps and ${used} ${used === 1 ? 'is' : 'are'} used, so a plan may have ${left} more write ${left === 1 ? 'step' : 'steps'}: send a plan within that, or tell the writer the run needs a larger step limit`;
}
