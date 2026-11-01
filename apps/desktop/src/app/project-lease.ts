/**
 * The project lease: one tab at a time may hold a project open for writing.
 *
 * Two tabs on one project would each keep their own copy of the text, and the second to save would
 * have to win or lose. The store's revision guard stops the stale write, but the guard is the backstop:
 * the first line is that the second tab cannot open the project at all. The lease is a Web Lock named
 * for the project, held from the moment the project opens until its session closes.
 *
 * A lock that is taken by another tab is waited for, for a short time, because a tab that is closing
 * releases its lock a moment after the writer leaves it. A tab that still holds it after that is
 * another open tab, and the open is refused with the reason, not with an error from the store.
 *
 * Where the browser has no Web Locks API (a test host, an old browser) there is nothing to hold, so the
 * lease is granted and the revision guard is the only protection. That is said in the notes, not hidden.
 */

import { t } from '@lingui/core/macro';

/** How long an open waits for a lock another tab holds before it is refused. */
export const LEASE_WAIT_MS = 1_000;

export interface ProjectLease {
  /** Gives the lock back. Safe to call more than once. */
  release(): void;
}

/** The lease of a browser without Web Locks: granted, and held by nothing. */
const UNGUARDED: ProjectLease = { release: () => {} };

/** The refusal an open gets when another tab holds the project. */
export class ProjectOpenElsewhereError extends Error {
  constructor(readonly projectId: string) {
    super(t`This project is open in another tab. Switch to that tab, or close it, then open the project again.`);
    this.name = 'ProjectOpenElsewhereError';
  }
}

/** The Web Lock's name for one project. */
export function leaseName(projectId: string): string {
  return `caotang:project:${projectId}`;
}

/**
 * Takes the project's lease, or resolves `null` when another tab still holds it after the wait.
 *
 * The request is queued (not `ifAvailable`), with an abort signal for the wait. Once granted, the
 * lock is held by a promise that resolves only when `release` is called, so the lock lives exactly as
 * long as the session.
 */
export function acquireProjectLease(projectId: string): Promise<ProjectLease | null> {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  if (locks === undefined) return Promise.resolve(UNGUARDED);
  return new Promise<ProjectLease | null>((resolve) => {
    let finished = false;
    const request = locks.request(
      leaseName(projectId),
      { signal: AbortSignal.timeout(LEASE_WAIT_MS) },
      () =>
        new Promise<void>((release) => {
          finished = true;
          resolve(lease(release));
        }),
    );
    // Aborted while it waited: another tab still holds the project. Granted lets the request settle later, and
    // that settle is not a refusal.
    request.catch(() => {
      if (!finished) resolve(null);
    });
  });
}

/** One held lease: released once, however many times it is asked to be. */
function lease(release: () => void): ProjectLease {
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      release();
    },
  };
}

/** The part of the Web Locks API the lease uses, so a test can supply its own. */
interface LockManagerLike {
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<unknown>;
}
