/**
 * One device edits a project and the others read it — hosted.md §7. The lease is soft: this device renews it while the project is
 * open, it lapses on its own when the tab closes or the network goes, and another device may take it over only when a writer says
 * so. The server refuses a write from a device without it, so a second device is read-only in fact and not only in the interface.
 *
 * The shell watches the lease rather than the frame: a project is handed to the studio only when this device holds it, and losing
 * it takes the project away again. Nothing here trusts the frame's own claim to be the editor.
 */
import { RemoteSessionError, type LeaseState, type ProjectLease } from '@caotang/remote-store';

/** How often a held lease is renewed. The server lapses it 60 seconds after the last one, so three beats of slack. */
export const LEASE_HEARTBEAT_MS = 20_000;

export interface ShellLease {
  /** The project this lease is for, so the shell can tell whether it still holds the one it opened. */
  readonly projectId: string;
  state(): LeaseState;
  expired(): boolean;
  subscribe(listener: () => void): () => void;
  /** Takes the lease, or renews it; `takeover` is the writer's "edit here instead". */
  take(options?: { readonly takeover?: boolean }): Promise<LeaseState>;
  /** Hands it back, so the other device need not wait for it to lapse. */
  release(): Promise<void>;
  /** Stops renewing without telling the server: the tab is going away. */
  stop(): void;
}

export function createShellLease(projectId: string, lease: ProjectLease, heartbeat: number = LEASE_HEARTBEAT_MS, refreshSession?: () => void): ShellLease {
  let held: LeaseState = { leased: false, until: 0 };
  let expired = false;
  // `globalThis` so the renewal runs under the same clock the shell has, and so a test can drive it without a window.
  let timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Which lease this object is holding. Every hand-back and every stop retires it, so an answer still on its way when that happens
   * is dropped instead of being applied: a heartbeat that lands after the release would otherwise put the lease back, start a new
   * timer, and quietly re-take a project the writer has left — on a project switch, one the shell can no longer even reach.
   */
  let generation = 0;
  const listeners = new Set<() => void>();

  const stopTiming = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };
  /** Ends this generation: nothing already asked for may be applied after it. */
  const retire = (): void => {
    generation += 1;
    stopTiming();
  };
  const apply = (next: LeaseState, confirmationExpired = false): void => {
    held = next;
    expired = confirmationExpired;
    if (next.leased) {
      // One beat per lease, not one per renewal: a heartbeat that answered while this device still holds it keeps the same timer.
      if (timer === null) {
        const beat = generation;
        timer = setInterval(() => {
          void lease.take().then(
            (next) => { if (beat === generation) apply(next); },
            (error: unknown) => {
              if (beat !== generation) return;
              if (error instanceof RemoteSessionError) refreshSession?.();
              // A renewal that was not answered is not another device's answer: the server may still hold this device's lease until it
              // lapses, so a dropped connection or a 503 does not take the project away from the writer. The lease is given up on only
              // once the lapse time the server last named has passed — which is when its writes would be refused anyway.
              if (Date.now() >= held.until) apply({ leased: false, until: held.until }, true);
            },
          );
        }, heartbeat);
      }
    } else {
      stopTiming();
    }
    for (const listener of listeners) listener();
  };

  return {
    projectId,
    state: () => held,
    expired: () => expired,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    take: async (options) => {
      const asked = generation;
      const next = await lease.take(options?.takeover === true ? { takeover: true } : undefined);
      if (asked === generation) apply(next);
      return next;
    },
    release: async () => {
      retire();
      try {
        await lease.release();
      } finally {
        apply({ leased: false, until: 0 });
      }
    },
    stop: () => {
      retire();
    },
  };
}
