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
 *   until the writer asks (`sendQueued`).
 * - `conflict`: these paths moved on the account, and this device's words are held. Nothing is written and nothing is sent until
 *   the writer answers (`keepMine` or the deferral the notice keeps itself).
 * - `stale`: the account holds words this session has not read yet, because a send the writer asked for landed. A save from here
 *   would write the older book over them, so the session is reopened first.
 */
export type HostedSaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'unsaved'; readonly paths: readonly string[] }
  | { readonly kind: 'conflict'; readonly paths: readonly string[] }
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
  /** Holds what a save could not deliver, so a reload sends it instead of losing it. */
  hold(changes: readonly RemoteChange[]): void;
  /** Sends everything held, in one commit. A refusal changes nothing and keeps the queue as it was. */
  replay(): Promise<HostedReplay>;
  /** Forgets these paths, or every path when none are named. */
  forget(paths?: readonly string[]): void;
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
    /** The save state's own name: `saved` is the moment this browser's copy and the state agree. */
    getStatus(): string;
  };
  /**
   * Every picture the project holds. They travel in the same batch as the files, because the state that names a picture and the
   * picture are one save: a cover the account never gets is a cover the next device cannot show.
   */
  assets?(): Promise<Readonly<Record<string, Uint8Array>>>;
}

/** The pictures this device changed against the account, and the ones it deleted, as one save carries them. */
interface PictureChanges {
  readonly files: Record<string, Uint8Array> | null;
  readonly digests: Map<string, string>;
  readonly removed: readonly string[];
  /** Pictures that changed here while the account moved too, and pictures deleted here that the account has since rewritten. */
  readonly moved: readonly RemoteChange[];
}

export class HostedTarget {
  #state: HostedSaveState = { kind: 'idle' };
  #listeners = new Set<() => void>();
  #running: Promise<void> | null = null;
  #again = false;
  #detached: (() => void) | null = null;
  /** The attached session's pictures, so a save carries them with the files that name them. */
  #assets: (() => Promise<Readonly<Record<string, Uint8Array>>>) | null = null;
  /** The documents and pictures this device last saw the account hold, so a deletion is one it made rather than one it missed. */
  readonly #knownDocuments = new Set<string>();
  readonly #knownAssets = new Set<string>();
  /**
   * Each picture as this device last agreed with the account: the digest of the bytes and the account version they are. A save stages
   * only what changed here against that baseline, so a picture another device wrote after this one opened is never written back from
   * this browser's older snapshot.
   */
  readonly #assetsAt = new Map<string, { readonly digest: string; readonly version: number }>();
  /** The changes the current question is about, and the paths the writer was shown: their answer covers those and no others. */
  #question: readonly RemoteChange[] = [];
  #asked: readonly string[] = [];
  /** Whether the open question came from this session's own save, which is answered by saving the state again, or from the queue. */
  #fromSave = false;
  /** Pictures the writer has just answered for, so the answer's bytes or deletion go through once instead of asking again. */
  readonly #answered = new Set<string>();

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
   * What the session opened with: the documents and pictures this device held when the account's project reached it. A path here that
   * the state no longer holds is a deletion this device made; a path that is not here belongs to another device, and a save that pruned
   * it would delete work it never saw. Called by a fresh open, which is also how a session catches up with the account.
   */
  async rememberOpened(documents: Iterable<string>, assets: Readonly<Record<string, Uint8Array>>): Promise<void> {
    for (const id of documents) this.#knownDocuments.add(id);
    this.#knownAssets.clear();
    this.#assetsAt.clear();
    for (const [path, bytes] of Object.entries(assets)) {
      this.#knownAssets.add(path);
      this.#assetsAt.set(path, { digest: await digestOf(bytes), version: this.#versionOf(path) });
    }
    // A fresh open is the session catching up: the account's words are in front of the writer now.
    if (this.#state.kind === 'stale') this.#set({ kind: 'idle' });
  }

  /**
   * The queue as the open found it: this device's words that never reached the account. They are not sent here — the writer is told
   * and chooses — so the state says they are here and nothing else happens until they do.
   */
  heldAtOpen(): void {
    const paths = this.queue?.held() ?? [];
    if (paths.length > 0 && this.#state.kind === 'idle') this.#set({ kind: 'unsaved', paths });
  }

  /** Commits this session's state to the account. A second call while one is running runs once more after it. */
  async save(state: ProjectState): Promise<void> {
    // Only a target with nothing outstanding saves: a question, a send that landed before the session caught up, and a commit already
    // in flight are all states where writing this state would say something the writer has not settled.
    if (this.#state.kind === 'conflict' || this.#state.kind === 'stale') return;
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
   * The writer's "send them to my account", for words a save could not deliver because the server was unreachable. The only path from
   * `unsaved` back to `idle`, and the only place a queue is sent without a question being answered.
   */
  async sendQueued(): Promise<HostedSaveState> {
    if (this.#state.kind !== 'unsaved' || this.queue === null) return this.#state;
    this.#set({ kind: 'saving' });
    await this.fs.refresh();
    this.queue.marks();
    const outcome = await this.queue.replay();
    this.#settleSend(outcome);
    return this.#state;
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
    if (this.#state.kind !== 'conflict') return this.#state;
    await this.fs.refresh();
    this.queue?.marks();
    // A picture the writer has answered for goes through once: its bytes, or its deletion, on top of the version just read. Without
    // this the same question would come back for the same reason it was first asked.
    for (const change of this.#question) if (change.path.startsWith('assets/')) this.#answered.add(change.path);
    // The answer to this session's own save is the state it read, saved again on top of the other device's version. A question about
    // the queue has no state to save — those words are the held paths — so the queue is sent instead.
    const queueOnly = !this.#fromSave;
    this.#set({ kind: 'saving' });
    if (queueOnly) {
      if (this.queue !== null) this.queue.rebase(this.#asked);
      this.#settleSend(await (this.queue?.replay() ?? this.#commitChanges()));
      return this.#state;
    }
    this.#question = [];
    this.#asked = [];
    this.#fromSave = false;
    // A question from this session's own save always has the state it read beside it; a conflict that arrived without one (a caller that
    // asked for this answer with nothing to save) falls back to sending the staged changes.
    if (state === undefined) this.#settleSend(await (this.queue?.replay() ?? this.#commitChanges()));
    else await this.save(state);
    return this.#state;
  }

  /**
   * Asks the writer which text the account should keep, for paths whose words this device holds and the account does not. The words are
   * in the queue by the time this is called, so "keep mine" sends them and leaving them keeps the account's version.
   */
  raiseConflict(paths: readonly string[]): void {
    if (this.#state.kind === 'stale' || this.#state.kind === 'saving') return;
    this.#asked = paths;
    this.#fromSave = false;
    this.#set({ kind: 'conflict', paths });
  }

  /** The account's version of a path, as the adapter last read it. */
  #versionOf(path: string): number {
    return this.fs.versionOf(path);
  }

  async #commit(state: ProjectState): Promise<void> {
    this.#set({ kind: 'saving' });
    const docs = new Set(state.documents.keys());
    const removed = [...this.#knownDocuments].filter((id) => !docs.has(id));
    const pictures = await this.#pictureChanges();
    if (pictures.moved.length > 0) {
      // A picture that changed on both sides is the same question a document raises, and nothing is written until it is answered.
      this.#hold(pictures.moved, pictures.moved.map((change) => change.path), true);
      return;
    }
    let outcome: HostedSaveOutcome;
    try {
      outcome = await this.saveState(state, {
        removed,
        assets: pictures.files === null ? undefined : { files: pictures.files, removed: pictures.removed },
      });
    } catch {
      // A refusal this target has no answer of its own for — a full account, a lease taken in between, a blob that failed to
      // authenticate — is still the account being behind this browser, and saying nothing would leave the writer believing it saved.
      this.#set({ kind: 'unsaved', paths: [] });
      return;
    }
    if (outcome.kind === 'written') {
      this.#landed(docs, pictures);
      return;
    }
    this.#hold(outcome.changes, outcome.kind === 'conflict' ? outcome.paths : undefined, true);
  }

  /** The pictures this save carries: the ones this device changed, the deletions it made, and the ones another device moved too. */
  async #pictureChanges(): Promise<PictureChanges> {
    const held: Readonly<Record<string, Uint8Array>> | null = (await this.#assets?.()) ?? null;
    if (held === null) return { files: null, digests: new Map(), removed: [], moved: [] };
    const kept = new Set(Object.keys(held));
    const files: Record<string, Uint8Array> = {};
    const digests = new Map<string, string>();
    const moved: RemoteChange[] = [];
    for (const [path, bytes] of Object.entries(held)) {
      const digest = await digestOf(bytes);
      const at = this.#assetsAt.get(path);
      if (at !== undefined && at.digest === digest) {
        digests.set(path, digest);
        continue;
      }
      if (this.#answered.delete(path)) {
        files[path] = bytes;
        digests.set(path, digest);
        continue;
      }
      if ((at === undefined && this.#versionOf(path) !== 0) || (at !== undefined && at.version !== this.#versionOf(path))) {
        moved.push({ path, bytes });
        continue;
      }
      files[path] = bytes;
      digests.set(path, digest);
    }
    // A picture this device deleted is only its to delete if the account has not moved it since: another device's newer version is not
    // what the writer removed.
    const removed: string[] = [];
    for (const path of [...this.#knownAssets].filter((candidate) => !kept.has(candidate))) {
      if (this.#answered.delete(path)) {
        removed.push(path);
        continue;
      }
      const at = this.#assetsAt.get(path);
      if (at !== undefined && at.version !== this.#versionOf(path)) moved.push({ path, bytes: null });
      else removed.push(path);
    }
    return { files, digests, removed, moved };
  }

  /** A written save: the account now holds this state, so the baselines and the queue are measured against it. */
  #landed(docs: ReadonlySet<string>, pictures: PictureChanges): void {
    this.#question = [];
    this.#asked = [];
    this.#knownDocuments.clear();
    for (const id of docs) this.#knownDocuments.add(id);
    this.#knownAssets.clear();
    for (const path of [...this.#assetsAt.keys(), ...Object.keys(pictures.files ?? {})]) this.#knownAssets.add(path);
    for (const path of Object.keys(pictures.files ?? {})) {
      this.#knownAssets.add(path);
      this.#assetsAt.set(path, { digest: pictures.digests.get(path)!, version: this.#versionOf(path) });
    }
    for (const path of pictures.removed) {
      this.#knownAssets.delete(path);
      this.#assetsAt.delete(path);
    }
    // This save carried these paths at the state they hold now, so a queued edit of any of them is older than what landed. The pictures
    // are staged outside the report, so the paths they were sent at are named here too.
    this.queue?.forget([...Object.keys(pictures.files ?? {}), ...pictures.removed]);
    this.queue?.marks();
    this.#set({ kind: 'idle' });
  }

  /** A save or a send the account did not take: the queue keeps the words and the state says which question is open. */
  #hold(changes: readonly RemoteChange[], paths?: readonly string[], fromSave = false): void {
    this.queue?.hold(changes);
    if (paths === undefined) {
      this.#question = [];
      this.#asked = [];
      this.#fromSave = false;
      this.#set({ kind: 'unsaved', paths: changes.map((change) => change.path) });
      return;
    }
    this.#question = changes;
    this.#asked = paths;
    this.#fromSave = fromSave;
    this.#set({ kind: 'conflict', paths });
  }

  /** What a send of the held words settled: the account holds them (and the session is behind), a question is up, or nothing moved. */
  #settleSend(outcome: HostedReplay): void {
    if (outcome.kind === 'sent') {
      this.#question = [];
      this.#asked = [];
      this.queue?.marks();
      this.#set({ kind: 'stale' });
      return;
    }
    if (outcome.kind === 'conflict') {
      this.#question = [];
      this.#asked = outcome.paths;
      this.#fromSave = false;
      this.#set({ kind: 'conflict', paths: outcome.paths });
      return;
    }
    this.#set({ kind: 'unsaved', paths: this.queue?.held() ?? [] });
  }

  /** The answer when the target holds no queue (a session opened without the adapter's queue). */
  async #commitChanges(): Promise<HostedReplay> {
    try {
      const changes = this.#question;
      await this.fs.commitChanges(changes);
      return { kind: 'sent', count: changes.length };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  #set(next: HostedSaveState): void {
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}

/** A picture's bytes as one string, so a save can tell this device's change from another device's. */
async function digestOf(bytes: Uint8Array): Promise<string> {
  // A copy of its own: the bytes may come from a snapshot whose buffer the browser also holds, and `subtle.digest` wants an
  // `ArrayBuffer` it can read without sharing.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export { forgetHostedTarget, hostedTargetFor, installHostedTarget } from './hosted-target-registry.js';
