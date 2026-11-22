import type { Clock, TimerId } from './clock.js';
import type { PresetDef } from './presets/index.js';
import { CallerCancelled } from './timing.js';
import type { ProfileKind } from './types.js';

/** How many calls may overlap on one profile: where a session starts, and the most the limiter will ever raise it to. */
export interface ConcurrencyPolicy {
  readonly start: number;
  readonly max: number;
}

/**
 * Where a profile's limit starts and tops out, by what the provider is: the demo mock overlaps freely, a server on this computer
 * serves one request at a time unless it says otherwise, and every other endpoint, a custom one included, starts at three (H5b's
 * safe default). A 429 lowers it from there and success raises it, so none of these is a promise.
 */
export function defaultConcurrency(kind: ProfileKind, preset: PresetDef | undefined): ConcurrencyPolicy {
  if (kind === 'mock') return { start: 8, max: 8 };
  if (preset?.local !== undefined) return { start: 1, max: 2 };
  return { start: 3, max: 8 };
}

/** Consecutive successful calls that earn one more slot. Raising slowly keeps a provider that is near its limit from being pushed over it again. */
export const SUCCESSES_PER_STEP = 10;

interface Adaptive {
  limit: number;
  streak: number;
}

interface Waiting {
  readonly background: boolean;
  readonly grant: () => void;
}

interface Queue {
  active: number;
  pausedUntil: number;
  timer?: TimerId;
  readonly waiting: Waiting[];
}

/**
 * The per-profile admission queue. The number of overlapping calls is adaptive and never stored: it starts at the policy's
 * `start`, is halved (never below 1) when the provider answers 429, and grows by one after `successesPerStep` calls in a row
 * succeed, up to the policy's `max`. It lives as long as the limiter, so a new session starts safe again.
 */
export class ProfileLimiter {
  private readonly queues = new Map<string, Queue>();
  private readonly adaptive = new Map<string, Adaptive>();

  constructor(
    private readonly clock: Clock,
    private readonly policy: (profileId: string) => ConcurrencyPolicy,
    private readonly successesPerStep: number = SUCCESSES_PER_STEP,
  ) {}

  private state(profileId: string): Adaptive {
    let state = this.adaptive.get(profileId);
    if (state === undefined) {
      state = { limit: this.policy(profileId).start, streak: 0 };
      this.adaptive.set(profileId, state);
    }
    return state;
  }

  /** The number of calls that may overlap on this profile right now. */
  limitOf(profileId: string): number {
    return this.state(profileId).limit;
  }

  private queue(profileId: string): Queue {
    let queue = this.queues.get(profileId);
    if (queue === undefined) {
      queue = { active: 0, pausedUntil: 0, waiting: [] };
      this.queues.set(profileId, queue);
    }
    return queue;
  }

  private pump(profileId: string, queue: Queue): void {
    if (queue.timer !== undefined) {
      this.clock.clearTimeout(queue.timer);
      queue.timer = undefined;
    }
    const remaining = queue.pausedUntil - this.clock.now();
    if (queue.waiting.length > 0 && remaining > 0) {
      queue.timer = this.clock.setTimeout(() => {
        queue.timer = undefined;
        this.pump(profileId, queue);
      }, Math.min(remaining, 2_147_483_647));
      return;
    }
    while (queue.waiting.length > 0 && queue.active < this.limitOf(profileId)) {
      const foreground = queue.waiting.findIndex((entry) => !entry.background);
      const entry = queue.waiting.splice(foreground < 0 ? 0 : foreground, 1)[0];
      if (entry === undefined) break;
      queue.active += 1;
      entry.grant();
    }
    if (queue.active === 0 && queue.waiting.length === 0 && remaining <= 0) this.queues.delete(profileId);
  }

  acquire(profileId: string, background: boolean, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new CallerCancelled());
    const queue = this.queue(profileId);
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = queue.waiting.indexOf(entry);
        if (index < 0) return;
        queue.waiting.splice(index, 1);
        signal?.removeEventListener('abort', onAbort);
        reject(new CallerCancelled());
        this.pump(profileId, queue);
      };
      const entry: Waiting = {
        background,
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            queue.active -= 1;
            this.pump(profileId, queue);
          });
        },
      };
      queue.waiting.push(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pump(profileId, queue);
    });
  }

  /**
   * A 429 arrived. The first one of a pause window halves the limit and every one extends the pause; the 429s of calls that were
   * already in flight when it started do not halve it again, so one burst costs one step down.
   */
  rateLimited(profileId: string, delayMs: number): void {
    const state = this.state(profileId);
    const queue = this.queues.get(profileId);
    if (queue === undefined || queue.pausedUntil <= this.clock.now()) state.limit = Math.max(1, Math.floor(state.limit / 2));
    state.streak = 0;
    this.pause(profileId, delayMs);
  }

  /** A call finished without a 429. Enough in a row raise the limit by one, and a raised limit admits waiting calls at once. */
  succeeded(profileId: string): void {
    const state = this.state(profileId);
    state.streak += 1;
    if (state.streak < this.successesPerStep) return;
    state.streak = 0;
    if (state.limit >= this.policy(profileId).max) return;
    state.limit += 1;
    this.refresh(profileId);
  }

  pause(profileId: string, delayMs: number): void {
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    const queue = this.queue(profileId);
    queue.pausedUntil = Math.max(queue.pausedUntil, Math.min(Number.MAX_SAFE_INTEGER, this.clock.now() + delayMs));
    this.pump(profileId, queue);
  }

  refresh(profileId: string): void {
    const queue = this.queues.get(profileId);
    if (queue !== undefined) this.pump(profileId, queue);
  }
}
