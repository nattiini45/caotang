/**
 * The sprint timer as a pure state machine — [goals-progress.md §10](docs/architecture/goals-progress.md)
 * (A15(d)); §9 item 4 places it in the v0.2 menu with zero architecture impact.
 *
 * A sprint is a countdown that counts the words written while it runs. The machine
 * owns no clock and no timer. Every event carries the instant it happened, as epoch
 * milliseconds, and the session's running word total, so a test drives it with fixed
 * numbers and the app drives it from a one-second tick.
 *
 * Words are counted from the session, and the sprint sees only samples of the total.
 * Words typed while the sprint is paused are not its words: a resume moves the baseline
 * past them. A sprint keeps no history of its own; a finished sprint is returned to the
 * caller as a view, and the session log already records the writing.
 */

import { defineMachine } from '@caotang/machine';
import type { MachineTable } from '@caotang/machine';

/** The defaults and bounds of the duration, which the spec does not fix (an assumption). */
export const SPRINT_DEFAULT_MINUTES = 25;
export const SPRINT_MIN_MINUTES = 1;
export const SPRINT_MAX_MINUTES = 480;

const MS_PER_MINUTE = 60_000;

export type SprintStatus = 'idle' | 'running' | 'paused' | 'finished';

export type SprintEndReason = 'time-up' | 'stopped';

export interface SprintState {
  readonly status: SprintStatus;
  /** The countdown length. Editable only while idle. */
  readonly durationMs: number;
  /** Running time accumulated before `runningSince`. Pauses are not in it. */
  readonly elapsedMs: number;
  /** Epoch ms of the last start or resume, while running. */
  readonly runningSince: number | null;
  /** The session's word total at the start, moved forward by whatever was typed during a pause. */
  readonly startWords: number;
  /** The most recent word-total sample. Words gained are `lastWords − startWords`. */
  readonly lastWords: number;
  readonly endReason: SprintEndReason | null;
}

export type SprintEvent =
  | { readonly type: 'start'; readonly at: number; readonly words: number }
  | { readonly type: 'pause'; readonly at: number; readonly words: number }
  | { readonly type: 'resume'; readonly at: number; readonly words: number }
  | { readonly type: 'tick'; readonly at: number; readonly words: number }
  | { readonly type: 'stop'; readonly at: number; readonly words: number }
  | { readonly type: 'setDuration'; readonly minutes: number }
  | { readonly type: 'reset' };

export type SprintMachineState = Omit<SprintState, 'status'> & { readonly kind: SprintStatus };

export const sprintTable: MachineTable<SprintMachineState, SprintEvent> = {
  id: 'sprint.timer',
  initial: 'idle',
  final: [],
  on: {
    idle: { start: ['running'], setDuration: ['idle'], reset: ['idle'] },
    running: { pause: ['paused', 'finished'], tick: ['running', 'finished'], stop: ['finished'], reset: ['idle'] },
    paused: { resume: ['running'], stop: ['finished'], reset: ['idle'] },
    finished: { reset: ['idle'] },
  },
};

export const sprintMachine = defineMachine<SprintMachineState, SprintEvent>(sprintTable, (state, event) => {
  const { kind, ...fields } = state;
  const sprint: SprintState = { ...fields, status: kind };
  const next = transitionSprint(sprint, event);
  if (next === sprint) return state;
  const { status, ...nextFields } = next;
  return { ...nextFields, kind: status };
});

/** What a view of the sprint shows at one instant. */
export interface SprintView {
  /** `finished` as soon as the elapsed time reaches the duration, even before the next tick. */
  readonly status: SprintStatus;
  readonly durationMs: number;
  readonly elapsedMs: number;
  readonly remainingMs: number;
  readonly wordsGained: number;
  /** Words per minute over the running time, or null before any time has run. */
  readonly wpm: number | null;
  readonly endReason: SprintEndReason | null;
}

export function createSprint(minutes: number = SPRINT_DEFAULT_MINUTES): SprintState {
  return {
    status: 'idle',
    durationMs: minutesToMs(minutes),
    elapsedMs: 0,
    runningSince: null,
    startWords: 0,
    lastWords: 0,
    endReason: null,
  };
}

/**
 * The transition function. An event that does not apply to the current status returns
 * the same state, so a stale click or a late tick is harmless. The table:
 *
 * - idle: start → running · setDuration
 * - running: pause → paused · stop → finished · tick
 * - paused: resume → running · stop → finished
 * - any status: reset → idle, keeping the duration (a cancel is always available)
 *
 * A countdown that has run out ends as a time-up on whichever event arrives first (pause,
 * tick or stop). Words typed after the instant it ran out are not the sprint's, so those
 * events keep the last sample rather than take the one they carry. A stop from paused takes
 * no new sample either, for the same reason: the pause's words are not the sprint's.
 */
export function transitionSprint(state: SprintState, event: SprintEvent): SprintState {
  switch (event.type) {
    case 'start':
      if (state.status !== 'idle') return state;
      return {
        ...state,
        status: 'running',
        elapsedMs: 0,
        runningSince: event.at,
        startWords: sample(event.words, 0),
        lastWords: sample(event.words, 0),
        endReason: null,
      };
    case 'pause': {
      if (state.status !== 'running') return state;
      const elapsed = elapsedAt(state, event.at);
      if (elapsed >= state.durationMs) return finish(state, event.at, state.lastWords, 'time-up');
      return { ...state, status: 'paused', elapsedMs: elapsed, runningSince: null, lastWords: sample(event.words, state.lastWords) };
    }
    case 'resume': {
      if (state.status !== 'paused') return state;
      const words = sample(event.words, state.lastWords);
      return {
        ...state,
        status: 'running',
        runningSince: event.at,
        startWords: state.startWords + (words - state.lastWords),
        lastWords: words,
      };
    }
    case 'tick': {
      if (state.status !== 'running') return state;
      if (elapsedAt(state, event.at) >= state.durationMs) return finish(state, event.at, state.lastWords, 'time-up');
      return { ...state, lastWords: sample(event.words, state.lastWords) };
    }
    case 'stop': {
      if (state.status !== 'running' && state.status !== 'paused') return state;
      if (state.status === 'paused') return finish(state, event.at, state.lastWords, 'stopped');
      if (elapsedAt(state, event.at) >= state.durationMs) return finish(state, event.at, state.lastWords, 'time-up');
      return finish(state, event.at, event.words, 'stopped');
    }
    case 'setDuration':
      if (state.status !== 'idle') return state;
      return { ...state, durationMs: minutesToMs(event.minutes) };
    case 'reset':
      return {
        status: 'idle',
        durationMs: state.durationMs,
        elapsedMs: 0,
        runningSince: null,
        startWords: 0,
        lastWords: 0,
        endReason: null,
      };
  }
}

/** The sprint as it reads at `now`. Pure, so a view can be taken between ticks. */
export function sprintView(state: SprintState, now: number): SprintView {
  const elapsed = Math.min(state.durationMs, elapsedAt(state, now));
  const expired = state.status === 'running' && elapsed >= state.durationMs;
  const wordsGained = Math.max(0, state.lastWords - state.startWords);
  return {
    status: expired ? 'finished' : state.status,
    durationMs: state.durationMs,
    elapsedMs: elapsed,
    remainingMs: state.durationMs - elapsed,
    wordsGained,
    wpm: elapsed > 0 ? wordsGained / (elapsed / MS_PER_MINUTE) : null,
    endReason: expired ? 'time-up' : state.endReason,
  };
}

function finish(state: SprintState, at: number, words: number, reason: SprintEndReason): SprintState {
  return {
    ...state,
    status: 'finished',
    elapsedMs: Math.min(state.durationMs, elapsedAt(state, at)),
    runningSince: null,
    lastWords: sample(words, state.lastWords),
    endReason: reason,
  };
}

function elapsedAt(state: SprintState, now: number): number {
  if (state.status === 'running' && state.runningSince !== null) {
    return state.elapsedMs + Math.max(0, now - state.runningSince);
  }
  return state.elapsedMs;
}

/** A word-total sample. A non-finite count keeps the previous one rather than poisoning the sum. */
function sample(words: number, fallback: number): number {
  return Number.isFinite(words) ? Math.max(0, Math.trunc(words)) : fallback;
}

/** Minutes to milliseconds, clamped to the duration bounds and rounded to whole minutes. */
function minutesToMs(minutes: number): number {
  const whole = Number.isFinite(minutes) ? Math.round(minutes) : SPRINT_DEFAULT_MINUTES;
  return Math.min(SPRINT_MAX_MINUTES, Math.max(SPRINT_MIN_MINUTES, whole)) * MS_PER_MINUTE;
}
