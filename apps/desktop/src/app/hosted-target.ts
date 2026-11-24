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
import type { EncryptedRemoteArtifactFs, HostedSaveOutcome, RemoteChange, SaveAssets } from '@caotang/remote-store';
import type { ProjectState } from '@caotang/store';

/** What a save carries besides the state: the paths this device deleted, and the pictures as it holds them. */
export interface SaveOptions {
  readonly removed?: readonly string[];
  readonly assets?: SaveAssets;
}

/** What the writer is owed to know about the account's copy. */
export type HostedSaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  /** The server could not be reached, so the account is behind this browser's copy. */
  | { readonly kind: 'unsaved' }
  /** Another device committed first: these documents moved, and nothing was written over them. */
  | { readonly kind: 'conflict'; readonly paths: readonly string[] };

/**
 * What happened to a replay of the held edits: the server took every path, another device moved one of them first, or the
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
  /** Sends everything held, in one commit. A refusal changes nothing and keeps the queue as it was. */
  replay(): Promise<HostedReplay>;
  /** Forgets these paths, or every path when none are named. */
  forget(paths?: readonly string[]): void;
  /** The paths held now. */
  held(): readonly string[];
  /** Where the rollback marks go after a commit or a refresh, so a replayed server state is refused on the next open. */
  marks(): void;
}

/** The session as this target uses it: the state to save, the browser save, and the pictures that travel with it. */
export interface HostedSaveSession {
  readonly state: ProjectState;
  readonly persistence: {
    subscribe(listener: () => void): () => void;
    /** The save state's own name: `saved` is the moment this browser's copy and the state agree. */
    getStatus(): string;
  };
  /**
   * Every picture the project holds. They travel in the same batch as the files, because the state that names a picture and the
   * picture are one save: a cover the account never gets is a cover the next device cannot show.
   */
  assets?(): Promise<Readonly<Record<string, Uint8Array>>>;
}

export class HostedTarget {
  #state: HostedSaveState = { kind: 'idle' };
  #conflict: readonly RemoteChange[] = [];
  #listeners = new Set<() => void>();
  #running: Promise<void> | null = null;
  #again = false;
  #detached: (() => void) | null = null;
  /** The attached session's pictures, so a save carries them with the files that name them. */
  #assets: (() => Promise<Readonly<Record<string, Uint8Array>>>) | null = null;
  /** The documents and pictures this device last saw the account hold, so a deletion is one it made rather than one it missed. */
  readonly #knownDocuments = new Set<string>();
  readonly #knownAssets = new Set<string>();
  /** The conflict the writer is answering came from the queue at open rather than from this session's own save. */
  #fromQueue = false;
  /** Set by {@link keepMine} when its answer replayed the queue instead of this session's state. */
  #reread = false;

  constructor(
    readonly projectId: string,
    readonly fs: EncryptedRemoteArtifactFs,
    /** The whole-project save, bound by the module that holds the adapter so this one imports no package at run time. */
    readonly saveState: (state: ProjectState, options?: SaveOptions) => Promise<HostedSaveOutcome>,
    readonly queue: HostedQueuePort | null = null,
  ) {}

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
    this.detach();
    this.#assets = session.assets ?? null;
    const stop = session.persistence.subscribe(() => {
      if (session.persistence.getStatus() !== 'saved') return;
      void this.save(session.state);
    });
    this.#detached = stop;
    return () => {
      stop();
      if (this.#detached === stop) this.#detached = null;
    };
  }

  /** Stops following the browser's saves: the host took the project away, or the session closed. */
  detach(): void {
    this.#detached?.();
    this.#detached = null;
  }

  /**
   * Whether the answer just given replays words the session does not hold — an earlier tab's queued edits rather than this
   * session's own state. The account now holds them and the book in front of the writer does not, so it has to be read again.
   */
  get rereadNeeded(): boolean {
    return this.#reread;
  }

  /**
   * What the session opened with: the documents and pictures this device held when the account's project reached it. A path here
   * that the state no longer holds is a deletion this device made; a path that is not here belongs to another device, and a save
   * that pruned it would delete work it never saw.
   */
  rememberOpened(documents: Iterable<string>, assets: Iterable<string>): void {
    for (const id of documents) this.#knownDocuments.add(id);
    for (const path of assets) this.#knownAssets.add(path);
  }

  /** Commits this session's state to the account. A second call while one is running runs once more after it. */
  async save(state: ProjectState): Promise<void> {
    const running = this.#running;
    if (running !== null) {
      this.#again = true;
      await running;
      return;
    }
    this.#running = this.#commit(state);
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

  async #commit(state: ProjectState): Promise<void> {
    this.#fromQueue = false;
    this.#reread = false;
    this.#set({ kind: 'saving' });
    const docs = new Set(state.documents.keys());
    const removed = [...this.#knownDocuments].filter((id) => !docs.has(id));
    const files = (await this.#assets?.()) ?? null;
    const kept = files === null ? null : new Set(Object.keys(files));
    const removedAssets = kept === null ? [] : [...this.#knownAssets].filter((path) => !kept.has(path));
    let outcome: HostedSaveOutcome;
    try {
      outcome = await this.saveState(state, { removed, assets: files === null ? undefined : { files, removed: removedAssets } });
    } catch {
      // A refusal this target has no answer of its own for — a full account, a lease taken in between, a blob that failed to
      // authenticate — is still the account being behind this browser, and saying nothing would leave the writer believing it
      // saved. The retry is the writer's, so it is offered rather than retried here.
      this.#set({ kind: 'unsaved' });
      return;
    }
    if (outcome.kind === 'written') {
      this.#conflict = [];
      // The account now holds this state: what it holds is the record the next deletion is measured against.
      this.#knownDocuments.clear();
      for (const id of docs) this.#knownDocuments.add(id);
      this.#knownAssets.clear();
      for (const path of kept ?? []) this.#knownAssets.add(path);
      // This save carried these paths at the state they hold now, so a queued edit of any of them is older than what landed. One
      // it did not carry stays queued: the queue is a record of what the account has not taken, and a save that happened to skip a
      // path says nothing about it.
      this.queue?.forget([...outcome.report.written, ...outcome.report.pruned]);
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
  }

  /**
   * The writer chose this device's text. For a conflict this session's own save raised, the state it read is the answer: the
   * adapter re-reads the other device's index and the whole save runs again against it, so a document the other device deleted
   * comes back with its body rather than as a manifest entry with no file. For a conflict an earlier tab's queue raised there is no
   * state to save — those words are the queued paths — so the queue is replayed instead.
   *
   * Their documents are not lost either way: they stay as the version this device's save replaced, which is what the account's
   * version history is for.
   */
  async keepMine(state?: ProjectState): Promise<HostedSaveState> {
    await this.fs.refresh();
    this.queue?.marks();
    this.#reread = this.#fromQueue || state === undefined;
    if (this.#reread || state === undefined) {
      this.#settle(await (this.queue?.replay() ?? this.#commitHeld()));
      return this.#state;
    }
    await this.save(state);
    return this.#state;
  }

  /**
   * Sends what an earlier tab could not, before the project is read. A replay that lands means the account now holds the
   * writer's words and the session that follows reads them; one that does not leaves the queue exactly as it was.
   *
   * A refusal re-reads the account before returning, because the read that follows is what the writer will see: without it a
   * conflict would open the project on an index this device already knows is behind. A re-read that fails throws instead, since
   * the alternative is opening a stale book.
   */
  async replayHeld(): Promise<HostedReplay | null> {
    if (this.queue === null || this.queue.held().length === 0) return null;
    const outcome = await this.queue.replay();
    if (outcome.kind === 'sent') {
      this.#settle(outcome);
      return outcome;
    }
    await this.fs.refresh();
    this.queue.marks();
    if (outcome.kind === 'conflict') {
      this.#fromQueue = true;
      this.#set({ kind: 'conflict', paths: outcome.paths });
    } else this.#set({ kind: 'unsaved' });
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
