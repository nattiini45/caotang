/**
 * One opening at a time, whichever surface asked for it (#774). The change offer's reopen and the projects list both put a project
 * in front of the writer, and neither knows about the other's token, so a reopen could clear a session the writer had just chosen
 * while that choice was in flight. They take their turn from here instead: the work runs in the order it was asked for, and only
 * one of them runs at a time.
 */

let tail: Promise<unknown> = Promise.resolve();

/**
 * Runs one opening after every opening asked for before it, and returns its own result. A failure does not jam the queue: the
 * openings behind it still run.
 */
export function openInTurn<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  tail = next.catch(() => undefined);
  return next;
}
