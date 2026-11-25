/**
 * The account as a session's save target — hosted.md §5, §7, §11. A hosted project's home is the account, so every save the
 * app makes to this browser is followed by one commit to the account; the browser copy is the working copy, and the account
 * is where the project lives.
 *
 * What the writer is owed: a save that lands says nothing, a save the server did not take says so, a save another device got
 * first stops and names the files, and nothing at all is sent to the account without the writer choosing it. The states and the
 * events that move between them are a table in hosted.md §7.2; every transition is tested, the illegal ones included, and the
 * methods here are the transitions in that table. Nothing in this module holds a queue or a clock of its own: the queue is the
 * device's (`HostedQueuePort`), and nothing is replayed unless a writer's action asks for it.
 */
import type { EncryptedRemoteArtifactFs, HostedSaveOutcome, RemoteChange, SaveAssets } from '@caotang/remote-store';
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
 * - `unsaved`: these paths are on this device and not on the account, because the server could not be reached. Nothing is sent
 *   until the writer asks (`sendQueued`). `persisted` is whether they reached this device's storage: false means they are in this
 *   tab only, which is the one warning a writer can act on.
 * - `conflict`: these paths moved on the account, and this device's words are held. Nothing is written and nothing is sent until
 *   the writer answers (`keepMine` or the deferral the notice keeps itself). `persisted` says the same about the held words.
 * - `stale`: the account holds words this session has not read yet, because a send the writer asked for landed. A save from here
 *   would write the older book over them, so the session is reopened first.
 */
export type HostedSaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'unsaved'; readonly paths: readonly string[]; readonly persisted: boolean }
  | { readonly kind: 'conflict'; readonly paths: readonly string[]; readonly persisted: boolean }
  | { readonly kind: 'stale' };

/**
 * What a send of the held words did: the server took them, another device moved one of them first, or the server did not answer.
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
  /**
   * Holds what a save could not deliver, so a reload sends it instead of losing it. Answers whether it reached this device's storage: a
   * blocked or full store leaves the words in this tab only, and the writer is told which of the two it is.
   */
  hold(changes: readonly RemoteChange[]): boolean;
  /** Sends everything held, in one commit. A refusal changes nothing and keeps the queue as it was. */
  replay(): Promise<HostedReplay>;
  /** Forgets these paths, or every path when none are named. */
  forget(paths?: readonly string[]): void;
  /**
   * Forgets the held words a save that landed accounted for: the ones whose bytes are exactly what the account now holds, and the ones
   * this save deleted. Everything else stays queued, because a save writes this session's state and a queued edit is its own text — one the
   * session may never have seen, since an open takes the account's version and adopts nothing. A removal answers whether the queue still
   * holds anything.
   */
  settle(removed: readonly string[]): Promise<boolean>;
  /**
   * Takes the account's current version of these paths as the one this device's held words were written against. Called only on the
   * writer's own answer — "keep this device's text" — and only for the paths they were shown.
   */
  rebase(paths: readonly string[]): void;
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
    /**
     * The browser save's own state (`persistence-model.ts`): `writing` while a save is on its way, `idle` when this browser's copy and
     * the state agree again, and `failed` or `conflict` when they do not. There is no `saved` — that is the name of the event, not of a
     * status — so the moment a save landed is the one where `writing` becomes `idle`.
     */
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
  /**
   * One write to the account at a time, whoever asked for it. A send the writer chose and an ordinary save that lands while it is in
   * flight would otherwise commit two versions, and the older one could be the last to reach the account; chained, the second runs
   * after the first and sees what it did.
   */
  #turn: Promise<unknown> = Promise.resolve();
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
  /** Whether the open question came from this session's own save, which is answered by saving the state again, or from the queue. */
  #fromSave = false;
  /**
   * Whether the words this state holds reached this device's storage. Carried across `saving`, because a send that fails must not claim a
   * copy that was never written: the answer belongs to the queue, not to the attempt.
   */
  #persisted = false;

  constructor(
    readonly projectId: string,
    readonly fs: EncryptedRemoteArtifactFs,
    /** The whole-project save, bound by the module that holds the adapter so this one imports no package at run time. */
    readonly saveState: (state: ProjectState, options?: SaveOptions) => Promise<HostedSaveOutcome>,
    readonly queue: HostedQueuePort | null = null,
    /**
     * The same save, staged and thrown away: what the state would put on the account. A question about the account does not stop the
     * writer working, and their words have to be held before the next open takes the account's version over this browser's copy.
     */
    readonly stageState: ((state: ProjectState, options?: SaveOptions) => Promise<readonly RemoteChange[]>) | null = null,
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
   * Whether the book in front of the writer has to be read from the account again: a send they asked for landed, and this session
   * still holds the version read before it.
   */
  get rereadNeeded(): boolean {
    return this.#state.kind === 'stale';
  }

  /**
   * Saves after every save this browser finishes, for as long as the session lives. The subscription is to the browser's own save, so a
   * save still in flight queues exactly one more pass rather than one per keystroke.
   */
  attach(session: HostedSaveSession): () => void {
    this.detach();
    this.#assets = session.assets ?? null;
    // A save has landed at the moment the browser's own save leaves `writing` and is `idle` again: that transition is the only one that
    // says this browser's copy and the state agree, and it is what the account is committed from.
    let writing = session.persistence.getStatus() === 'writing';
    const stop = session.persistence.subscribe(() => {
      const status = session.persistence.getStatus();
      const landed = writing && status === 'idle';
      writing = status === 'writing';
      if (landed) void this.save(session.state);
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
    // A fresh open is the session catching up: the account's words are in front of the writer now.
    if (this.#state.kind === 'stale') this.#set({ kind: 'idle' });
  }

  /**
   * The queue as the open found it: this device's words that never reached the account. They are not sent here — the writer is told
   * and chooses — so the state says they are here and nothing else happens until they do.
   */
  heldAtOpen(): void {
    const paths = this.queue?.held() ?? [];
    // Read back from this device's storage, so these words are on it: a queue a reload could not have read is not one this open sees.
    if (paths.length > 0 && this.#state.kind === 'idle') this.#set({ kind: 'unsaved', paths, persisted: true });
  }

  /** Commits this session's state to the account. A call made while one is running runs once more after it. */
  async save(state: ProjectState): Promise<void> {
    // The state says a commit is on its way from the moment the browser's save is in hand, so a question raised in between is refused
    // rather than landing in the middle of a commit.
    if (this.#state.kind === 'idle' || this.#state.kind === 'unsaved') this.#set({ kind: 'saving' });
    await this.#inTurn(async () => {
      // A send that landed before the session caught up writes nothing: the older book would go over what the send just put there.
      if (this.#state.kind === 'stale') return;
      if (this.#state.kind === 'conflict') {
        // The question is not the writer's only business: they can keep writing while it stands, and those words are held in the queue so
        // the next open does not take the account's version over them. The held words are built without reading the account — a copy in
        // memory — because the account is exactly what cannot be reached while a question is waiting to be answered.
        const staged = await this.#stage(state);
        this.#set({ kind: 'conflict', paths: this.#asked, persisted: staged.persisted });
        return;
      }
      await this.#commit(state);
    });
  }

  /**
   * The writer's "send them to my account", for words a save could not deliver because the server was unreachable. The only path from
   * `unsaved` back to `idle`, and the only place a queue is sent without a question being answered. It takes the same turn a save does:
   * a browser save that lands while the send is on its way waits for it, and finds the session stale rather than committing an older
   * book over what the send just put there.
   */
  async sendQueued(): Promise<HostedSaveState> {
    return await this.#inTurn(async () => {
      if (this.#state.kind !== 'unsaved' || this.queue === null) return this.#state;
      // Nothing held is nothing to send: a send that went ahead would report a landing and reopen the session for words that never left.
      if (this.queue.held().length === 0) {
        // Nothing is held, so there is nothing to send and nothing to claim: the words are in this book and the account does not have
        // them, which is the one thing the writer can still act on.
        this.#set({ kind: 'unsaved', paths: [], persisted: false });
        return this.#state;
      }
      this.#set({ kind: 'saving' });
      try {
        await this.fs.refresh();
      } catch {
        // The account is still out of reach. A send that cannot read it has sent nothing, so the words stay held and the writer keeps the
        // action: a state left at `saving` would hide itself from the notice and refuse every later send.
        this.#set({ kind: 'unsaved', paths: this.queue.held(), persisted: this.#persisted });
        return this.#state;
      }
      this.queue.marks();
      this.#settleSend(await this.queue.replay());
      return this.#state;
    });
  }

  /**
   * The writer chose this device's text. For a conflict this session's own save raised, the state it read is the answer: the adapter
   * re-reads the other device's index and the whole save runs again against it. For a conflict about the queue there is no state to
   * save — those words are the held paths — so the queue is sent instead, with the shown paths rebased onto the version just read.
   *
   * Their documents are not lost either way: they stay as the version this device's save replaced, which is what the account's version
   * history is for.
   */
  async keepMine(state?: ProjectState): Promise<HostedSaveState> {
    return await this.#inTurn(async () => {
      if (this.#state.kind !== 'conflict') return this.#state;
      try {
        await this.fs.refresh();
      } catch {
        // Nothing was answered and nothing was written: the question stands as it was, and the writer can ask again when the account
        // answers. Turning it into a different state would lose the paths they were shown.
        return this.#state;
      }
      this.queue?.marks();
      // The answer to this session's own save is the state it read, saved again on top of the other device's version. A question about
      // the queue has no state to save — those words are the held paths — so the queue is sent instead.
      const queueOnly = !this.#fromSave;
      if (queueOnly) {
        if (this.queue === null) {
          // Nothing to send and no state it read: the question stands, because nothing was written over either copy.
          this.#set({ kind: 'conflict', paths: this.#asked, persisted: false });
          return this.#state;
        }
        this.queue.rebase(this.#asked);
        this.#set({ kind: 'saving' });
        // The queue was read at open and every commit since kept it, so a refusal it raises still leaves the words on this device.
        this.#settleSend(await this.queue.replay());
        return this.#state;
      }
      this.#asked = [];
      this.#fromSave = false;
      // A question from this session's own save always has the state it read beside it, and saving it again on top of the version the
      // refresh just read is the answer. A conflict that arrived without one (a caller that asked for this answer with nothing to save)
      // keeps its question rather than sending words nobody staged.
      if (state === undefined) {
        this.#set({ kind: 'conflict', paths: this.#asked, persisted: this.#persisted });
        return this.#state;
      }
      this.#set({ kind: 'saving' });
      await this.#commit(state);
      return this.#state;
    });
  }

  /**
   * Asks the writer which text the account should keep, for paths whose words this device holds and the account does not. The words are
   * in the queue by the time this is called, so "keep mine" sends them and leaving them keeps the account's version.
   */
  raiseConflict(paths: readonly string[]): void {
    if (this.#state.kind === 'stale' || this.#state.kind === 'saving') return;
    this.#asked = paths;
    this.#fromSave = false;
    // Raised about words the queue is holding: the open found them, so they are on this device.
    this.#set({ kind: 'conflict', paths, persisted: true });
  }

  /** Runs `work` after every write already on its way, so two of them never reach the account out of order. */
  async #inTurn<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#turn.then(work, work);
    this.#turn = next.then(
      () => undefined,
      () => undefined,
    );
    return await next;
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
    const options: SaveOptions = { removed, assets: held === null ? undefined : { files: held, removed: removedPictures } };
    let outcome: HostedSaveOutcome;
    try {
      outcome = await this.saveState(state, options);
    } catch {
      // The save never got far enough to stage anything, so there is nothing to hold: the state still says the account is behind this
      // browser, because saying nothing would leave the writer believing it saved.
      this.#set({ kind: 'unsaved', paths: [], persisted: false });
      return;
    }
    if (outcome.kind === 'written') {
      await this.#landed(removed, docs, held);
      return;
    }
    const staged = await this.#stage(state);
    if (outcome.kind === 'failed') {
      // A save that failed rather than being refused: nothing reached the account, so the words it would have written are held instead of
      // dropped, and the writer is told they are here with the one action that would send them.
      this.#hold(staged);
      return;
    }
    // A refusal names the paths that moved; a server that did not answer names none, and the words are held as this device's.
    if (outcome.kind === 'conflict') this.#hold(staged, { paths: outcome.paths, fromSave: true });
    else this.#hold(staged);
  }

  /**
   * The words a save of `state` would put on the account, built here rather than taken from the attempt that failed.
   *
   * The failed attempt's own staged changes are not trusted: a save stops where it could not read or write, so its overlay can be half a
   * save — the documents of a manifest that never landed, a deletion the write path never reached — and queueing that would tell the writer
   * their work is safe while the account keeps a project the queue can only partly restore. This staging reads nothing from the account, so
   * it is complete exactly when the words are.
   */
  async #stage(state: ProjectState): Promise<{ readonly changes: readonly RemoteChange[]; readonly persisted: boolean }> {
    const held = (await this.#assets?.()) ?? null;
    if (this.queue === null || this.stageState === null) return { changes: [], persisted: false };
    let changes: readonly RemoteChange[];
    try {
      changes = await this.stageState(state, {
        removed: [...this.#knownDocuments].filter((id) => !state.documents.has(id)),
        assets: held === null ? undefined : { files: held, removed: [...this.#knownAssets].filter((path) => !(path in held)) },
      });
    } catch {
      // A staging that fails leaves nothing to hold, and the writer has to hear that: `persisted` false is the tab-only warning.
      return { changes: [], persisted: false };
    }
    return { changes, persisted: this.queue.hold(changes) };
  }

  /** A written save: the account now holds this state, so what this device has seen and what the queue still owes are measured on it. */
  async #landed(removed: readonly string[], docs: ReadonlySet<string>, held: Readonly<Record<string, Uint8Array>> | null): Promise<void> {
    this.#asked = [];
    this.#knownDocuments.clear();
    for (const id of docs) this.#knownDocuments.add(id);
    if (held !== null) {
      this.#knownAssets.clear();
      for (const path of Object.keys(held)) this.#knownAssets.add(path);
    }
    // What the queue owes is settled against what the account now holds, not against what this save happened to write: a queued edit is its
    // own text, and an open adopts nothing, so a path the save never wrote can still be holding words the writer has not sent. The queue
    // compares each held payload with the account and forgets the ones that are already there, plus the documents this save deleted.
    await this.queue?.settle(removed);
    this.queue?.marks();
    this.#set({ kind: 'idle' });
  }

  /** A save or a send the account did not take: the queue keeps the words and the state says which question is open. */
  #hold(
    staged: { readonly changes: readonly RemoteChange[]; readonly persisted: boolean },
    options: { readonly paths?: readonly string[]; readonly fromSave?: boolean } = {},
  ): void {
    if (options.paths === undefined) {
      this.#asked = [];
      this.#fromSave = false;
      this.#set({ kind: 'unsaved', paths: staged.changes.map((change) => change.path), persisted: staged.persisted });
      return;
    }
    this.#asked = options.paths;
    this.#fromSave = options.fromSave === true;
    this.#set({ kind: 'conflict', paths: options.paths, persisted: staged.persisted });
  }

  /** What a send of the held words settled: the account holds them (and the session is behind), a question is up, or nothing moved. */
  #settleSend(outcome: HostedReplay): void {
    if (outcome.kind === 'sent') {
      this.#asked = [];
      this.queue?.marks();
      this.#set({ kind: 'stale' });
      return;
    }
    if (outcome.kind === 'conflict') {
      this.#asked = outcome.paths;
      this.#fromSave = false;
      // A refused replay keeps the queue exactly as it was, so the words this question names are as durable as they were.
      this.#set({ kind: 'conflict', paths: outcome.paths, persisted: this.#persisted });
      return;
    }
    this.#set({ kind: 'unsaved', paths: this.queue?.held() ?? [], persisted: this.#persisted });
  }

  #set(next: HostedSaveState): void {
    // The durability of the words outlives the state that said it: a send in flight is `saving`, and what it reports when it fails is the
    // answer the queue gave before it started, never a fresh guess.
    if (next.kind === 'unsaved' || next.kind === 'conflict') this.#persisted = next.persisted;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}
