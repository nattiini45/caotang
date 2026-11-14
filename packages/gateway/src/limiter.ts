import type { Clock, TimerId } from './clock.js';
import { CallerCancelled } from './timing.js';

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

export class ProfileLimiter {
  private readonly queues = new Map<string, Queue>();

  constructor(private readonly clock: Clock, private readonly limit: (profileId: string) => number) {}

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
    while (queue.waiting.length > 0 && queue.active < this.limit(profileId)) {
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
