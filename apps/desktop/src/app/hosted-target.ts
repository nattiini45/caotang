/**
 * The account as a session's save target — hosted.md §5, §7, §11. A hosted project's home is the account, so every save the
 * app makes to this browser is followed by one commit to the account; the browser copy is the working copy, and the account
 * is where the project lives.
 *
 * Three things a writer needs from that: a save that lands says nothing, a save the server did not take says so instead of
 * pretending, and a save another device got first stops and names the documents, which is the "files changed" question a
 * folder save already asks. Nothing here reaches the network on its own: the target is built when a host hands a project over
 * and disposed when the session closes.
 */
import type { EncryptedRemoteArtifactFs, HostedSaveOutcome, RemoteChange } from '@caotang/remote-store';
import type { ProjectState } from '@caotang/store';

/** What the writer is owed to know about the account's copy. */
export type HostedSaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  /** The server could not be reached, so the account is behind this browser's copy. */
  | { readonly kind: 'unsaved' }
  /** Another device committed first: these documents moved, and nothing was written over them. */
  | { readonly kind: 'conflict'; readonly paths: readonly string[] };

/**
 * What happened to a replay of the held queue: the server took every path, another device moved one of them first, or the
 * server did not answer at all.
 */
export type HostedReplay =
  | { readonly kind: 'sent'; readonly count: number }
  | { readonly kind: 'conflict'; readonly paths: readonly string[] }
  | { readonly kind: 'unavailable' };

/**
 * The queue and the marks, as the target uses them. Built by the module that holds the adapter, so this one imports the package
 * only as types and `caotang.app`'s graph never reaches it.
 */
export interface HostedQueuePort {
  /** Holds what a save could not deliver, so a reload sends it instead of losing it. */
  hold(changes: readonly RemoteChange[]): void;
  /** Sends everything held, in one commit. A refusal changes nothing and keeps the queue. */
  replay(): Promise<HostedReplay>;
  /** Forgets everything held, once the account has it or a whole save has superseded it. */
  forget(): void;
  /** The paths held now. */
  held(): readonly string[];
  /** Where the marks go after a commit or a refresh, so a replayed server state is refused on the next open. */
  marks(): void;
}

/** The session as this target uses it: the state to save, and the browser save that says when this browser's copy is current. */
export interface HostedSaveSession {
  readonly state: ProjectState;
  readonly persistence: {
    subscribe(listener: () => void): () => void;
    /** The save state's own name: `saved` is the moment this browser's copy and the state agree. */
    getStatus(): string;
  };
}

export class HostedTarget {
  #state: HostedSaveState = { kind: 'idle' };
  #conflict: readonly RemoteChange[] = [];
  #listeners = new Set<() => void>();
  #running: Promise<void> | null = null;
  #again = false;

  constructor(
    readonly projectId: string,
    readonly fs: EncryptedRemoteArtifactFs,
    /** The whole-project save, bound by the module that holds the adapter so this one imports no package at run time. */
    readonly saveState: (state: ProjectState) => Promise<HostedSaveOutcome>,
    readonly queue: HostedQueuePort | null = null,
  ) {
    // Whether this target met a queue when it was built: the writer's words from an earlier tab, waiting for the server.
    this.#heldAtBuild = queue?.held() ?? [];
  }

  /**
   * A conflict answered from here means the account's own version is what the book now shows, so the session has to read the
   * account again once the writer's text wins.
   */
  get fromHeldQueue(): boolean {
    return this.#heldAtBuild.length > 0;
  }

  readonly #heldAtBuild: readonly string[];

  state(): HostedSaveState {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Saves after every save this browser finishes, for as long as the session lives. The subscription is to the browser's own
   * save, so a save still in flight queues exactly one more pass rather than one per keystroke.
   */
  attach(session: HostedSaveSession): () => void {
    return session.persistence.subscribe(() => {
      if (session.persistence.getStatus() !== 'saved') return;
      void this.save(session.state);
    });
  }

  /** Commits this session's state to the account. A second call while one is running runs once more after it. */
  async save(state: ProjectState): Promise<void> {
    const running = this.#running;
    if (running !== null) {
      this.#again = true;
      await running;
      return;
    }
    this.#running = (async () => {
      this.#set({ kind: 'saving' });
      const outcome = await this.saveState(state);
      if (outcome.kind === 'written') {
        this.#conflict = [];
        // A whole save carries every path this device holds, so anything the queue was keeping is older than what just landed.
        this.queue?.forget();
        this.queue?.marks();
        this.#set({ kind: 'idle' });
      } else if (outcome.kind === 'unavailable') {
        this.queue?.hold(outcome.changes);
        this.#set({ kind: 'unsaved' });
      } else {
        this.queue?.hold(outcome.changes);
        this.#conflict = outcome.changes;
        this.#set({ kind: 'conflict', paths: outcome.paths });
      }
    })();
    try {
      await this.#running;
    } finally {
      this.#running = null;
    }
    if (this.#again) {
      this.#again = false;
      await this.save(state);
    }
  }

  /**
   * The writer chose this device's text: read what the other device did, then write this session's staged save on top of it.
   * Their documents are not lost — they stay as the version this device's save replaced, which is what the account's version
   * history is for.
   */
  async keepMine(): Promise<HostedSaveState> {
    await this.fs.refresh();
    this.#settle(await (this.queue?.replay() ?? this.#commitHeld()));
    return this.#state;
  }

  /**
   * Sends what an earlier tab could not, before the project is read. A replay that lands means the account now holds the
   * writer's words and the session that follows reads them; one that does not leaves the queue exactly as it was.
   */
  async replayHeld(): Promise<HostedReplay | null> {
    if (this.queue === null || this.queue.held().length === 0) return null;
    const outcome = await this.queue.replay();
    if (outcome.kind === 'sent') this.#settle(outcome);
    else if (outcome.kind === 'conflict') this.#set({ kind: 'conflict', paths: outcome.paths });
    else this.#set({ kind: 'unsaved' });
    return outcome;
  }

  /** The answer to a conflict when the target holds no queue (a session opened without the adapter's queue). */
  async #commitHeld(): Promise<HostedReplay> {
    try {
      const changes = this.#conflict;
      await this.fs.commitChanges(changes);
      return { kind: 'sent', count: changes.length };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  #settle(outcome: HostedReplay): void {
    if (outcome.kind === 'sent') {
      this.queue?.forget();
      this.queue?.marks();
      this.#conflict = [];
      this.#set({ kind: 'idle' });
    } else if (outcome.kind === 'conflict') {
      this.#set({ kind: 'conflict', paths: outcome.paths });
    } else {
      this.#set({ kind: 'unsaved' });
    }
  }

  #set(next: HostedSaveState): void {
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}

const targets = new Map<string, HostedTarget>();

/** Keeps a hosted project's target for as long as it is open, so the workspace can show what the account holds. */
export function rememberHostedTarget(target: HostedTarget): void {
  targets.set(target.projectId, target);
}

export function hostedTargetFor(projectId: string): HostedTarget | null {
  return targets.get(projectId) ?? null;
}

export function forgetHostedTarget(projectId: string): void {
  targets.delete(projectId);
}
