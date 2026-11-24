/**
 * The account as a session's save target — hosted.md §5, §7, §11. A hosted project's home is the account, so every save the app makes
 * to this browser is followed by one commit to the account; the browser copy is the working copy, and the account is where the project
 * lives.
 *
 * What the writer is owed: a save that lands says nothing, a save the account did not take says so and offers to try again with the words
 * still in this tab, and a save another device got first stops and names the files. Nothing is ever sent without a browser save behind it.
 * The states and the events that move between them are a table in hosted.md §7.2; every transition is tested, the illegal ones included,
 * and the methods here are the transitions in that table. This is v1: there is no device queue, so a save that cannot reach the account
 * stays in the tab it was typed in and is retried only when the writer asks.
 */
import type { EncryptedRemoteArtifactFs, HostedSaveOutcome, SaveAssets } from '@caotang/remote-store';
import type { ProjectState } from '@caotang/store';

/** What a save carries besides the state: the paths this device deleted, and the pictures as it holds them. */
export interface SaveOptions {
  readonly removed?: readonly string[];
  readonly assets?: SaveAssets;
}

/**
 * What the writer is owed to know about the account's copy (hosted.md §7.2).
 *
 * - `idle`: nothing outstanding. An ordinary save commits.
 * - `saving`: a commit of this device's words is in flight.
 * - `unsaved`: the account does not have this book. The words are in this tab, and the notice offers to try again.
 * - `conflict`: these paths moved on the account. Nothing is written until the writer answers (`keepMine` or the deferral the notice
 *   keeps itself).
 */
export type HostedSaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'unsaved' }
  | { readonly kind: 'conflict'; readonly paths: readonly string[] };

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

/**
 * The registry's three calls, re-exported here so a caller that holds a target does not have to know that looking one up is a separate
 * module: the registry is separate only so `caotang.app`'s first load carries a `Map` and not this class (hosted.md §2).
 */
export { forgetHostedTarget, hostedTargetFor, installHostedTarget } from './hosted-target-registry.js';

export class HostedTarget {
  #state: HostedSaveState = { kind: 'idle' };
  #listeners = new Set<() => void>();
  #running: Promise<void> | null = null;
  #again = false;
  #detached: (() => void) | null = null;
  /** The attached session's pictures, so a save carries them with the files that name them. */
  #assets: (() => Promise<Readonly<Record<string, Uint8Array>>>) | null = null;
  /**
   * The documents and pictures the account held when this session opened it, so a path that is gone now is a deletion this device made
   * rather than one it never saw. Nothing else is remembered per file: a save carries every file at the version it read, and the
   * adapter's own version check is what tells us another device moved one.
   */
  readonly #knownDocuments = new Set<string>();
  readonly #knownAssets = new Set<string>();
  /** The paths the writer was shown for the open question: their answer covers those and no others. */
  #asked: readonly string[] = [];

  constructor(
    readonly projectId: string,
    readonly fs: EncryptedRemoteArtifactFs,
    /** The whole-project save, bound by the module that holds the adapter so this one imports no package at run time. */
    readonly saveState: (state: ProjectState, options?: SaveOptions) => Promise<HostedSaveOutcome>,
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
   * Saves after every save this browser finishes, for as long as the session lives. The subscription is to the browser's own save, so a
   * save still in flight queues exactly one more pass rather than one per keystroke.
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
   * What the session opened with: the documents and pictures the account holds. A path here that the state no longer holds is a deletion
   * this device made; a path that is not here belongs to another device, and a save that pruned it would delete work it never saw. Called
   * by a fresh open, which is also how a session catches up with the account.
   */
  rememberOpened(documents: Iterable<string>, assets: Readonly<Record<string, Uint8Array>>): void {
    this.#knownDocuments.clear();
    for (const id of documents) this.#knownDocuments.add(id);
    this.#knownAssets.clear();
    for (const path of Object.keys(assets)) this.#knownAssets.add(path);
  }

  /** Commits this session's state to the account. A second call while one is running runs once more after it. */
  async save(state: ProjectState): Promise<void> {
    // A question outranks a save: nothing is written over the other device's version while the writer is being asked. Their newer words
    // stay in this tab, and answering the question writes the book as it stands then.
    if (this.#state.kind === 'conflict') return;
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

  /**
   * The writer chose this device's text. The state it read is the answer: the adapter re-reads the other device's index and the whole
   * save runs again against it. Nothing is lost either way — their version stays as the version this device's save replaced, which is
   * what the account's version history is for.
   */
  async keepMine(state?: ProjectState): Promise<HostedSaveState> {
    if (this.#state.kind !== 'conflict') return this.#state;
    await this.fs.refresh();
    // A conflict always has the state its save read beside it; one that arrived without it keeps its question rather than writing a book
    // nobody staged.
    if (state === undefined) {
      this.#set({ kind: 'conflict', paths: this.#asked });
      return this.#state;
    }
    // The question is answered, so the state is no longer `conflict`: a save from `conflict` is refused, and this one is the writer's
    // answer, run against the version the refresh just read.
    this.#asked = [];
    this.#set({ kind: 'saving' });
    await this.save(state);
    return this.#state;
  }

  async #commit(state: ProjectState): Promise<void> {
    this.#set({ kind: 'saving' });
    const docs = new Set(state.documents.keys());
    const removed = [...this.#knownDocuments].filter((id) => !docs.has(id));
    // The pictures are files like any other: the save carries the ones this device holds, and the ones it deleted while the session was
    // open are named here the way a document's deletion is. A picture another device moved is refused by the same version check that
    // refuses a document, and asked about with the same question, so there is nothing here that knows what a picture is.
    const held = (await this.#assets?.()) ?? null;
    const removedPictures = held === null ? [] : [...this.#knownAssets].filter((path) => !(path in held));
    let outcome: HostedSaveOutcome;
    try {
      outcome = await this.saveState(state, {
        removed,
        assets: held === null ? undefined : { files: held, removed: removedPictures },
      });
    } catch {
      // The save threw before it could say anything: the account does not have this book, and saying so is all this tab owes — the words
      // are in front of the writer, and the notice offers to try again.
      this.#set({ kind: 'unsaved' });
      return;
    }
    if (outcome.kind === 'written') {
      this.#landed(docs, held);
      return;
    }
    if (outcome.kind === 'conflict') {
      this.#asked = outcome.paths;
      this.#set({ kind: 'conflict', paths: outcome.paths });
      return;
    }
    // The server did not answer, or the save failed after staging: either way nothing reached the account, and the writer is told.
    this.#set({ kind: 'unsaved' });
  }

  /** A written save: the account now holds this state, so what this device has seen of the account is what it holds. */
  #landed(docs: ReadonlySet<string>, held: Readonly<Record<string, Uint8Array>> | null): void {
    this.#asked = [];
    this.#knownDocuments.clear();
    for (const id of docs) this.#knownDocuments.add(id);
    if (held !== null) {
      this.#knownAssets.clear();
      for (const path of Object.keys(held)) this.#knownAssets.add(path);
    }
    this.#set({ kind: 'idle' });
  }

  #set(next: HostedSaveState): void {
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}
