/**
 * What changed in the project while the server runs — extensibility.md §9, subscriptions.
 *
 * A server started with `--allow-writes` is the only writer of its folder (it holds the lock), so the only changes a host can have
 * missed are the ones its own writes made. Each one is announced here after it is on disk, and a transport forwards it to the hosts
 * that asked: a `subscriptions/listen` stream (2026-07-28), or a 2025-era connection that subscribed. The feed is one per process, on
 * the session, because a 2026-07-28 request is answered by a server that lives for that request alone.
 *
 * The server does not watch the folder. Another program's change stops the server's writes (the SDK's `FolderChangedError`) and is
 * announced once, as a drift, so a host reads the project again.
 */

/** One change to the project, as the resources it touches: the URIs whose content changed, and whether the lists did. */
export interface ProjectChange {
  /** The resource URIs whose content is now different. */
  readonly updated: readonly string[];
  /** A document or codex entry was added, removed, moved or renamed: the resource lists are different. */
  readonly listChanged: boolean;
  /** Set when another program changed the folder and the server's writes stopped: a host should read the project again. */
  readonly drift?: boolean;
}

export interface ChangeFeed {
  emit(change: ProjectChange): void;
  /** Registers a listener, and returns the function that removes it. */
  on(listener: (change: ProjectChange) => void): () => void;
  /** How many listeners are registered now. */
  readonly size: number;
}

/** A feed with no listeners. A listener that throws does not stop the others, nor the write that emitted. */
export function createChangeFeed(): ChangeFeed {
  const listeners = new Set<(change: ProjectChange) => void>();
  return {
    emit(change) {
      for (const listener of [...listeners]) {
        try {
          listener(change);
        } catch {
          // A host that cannot be told is not a reason to fail a write that is on disk.
        }
      }
    },
    on(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get size() {
      return listeners.size;
    },
  };
}
