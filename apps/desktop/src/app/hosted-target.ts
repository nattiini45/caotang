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

/** The session as this target uses it: the state to save, and the browser save that says when this browser's copy is current. */
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
      this.#set({ kind: 'idle' });
    } else if (outcome.kind === 'unavailable') {
      this.#set({ kind: 'unsaved' });
    } else {
      this.#conflict = outcome.changes;
      this.#set({ kind: 'conflict', paths: outcome.paths });
    }
  }

  /**
   * The writer chose this device's text. The state the session read is the answer: the adapter re-reads the other device's index
   * and the whole save runs again against it, so a document the other device deleted comes back with its body rather than as a
   * manifest entry with no file — a replay of only the paths this device staged would write that manifest and nothing else.
   *
   * Their documents are not lost: they stay as the version this device's save replaced, which is what the account's version
   * history is for.
   */
  async keepMine(state?: ProjectState): Promise<HostedSaveState> {
    await this.fs.refresh();
    if (state === undefined) {
      try {
        await this.fs.commitChanges(this.#conflict);
        this.#conflict = [];
        this.#set({ kind: 'idle' });
      } catch {
        this.#set({ kind: 'unsaved' });
      }
      return this.#state;
    }
    await this.save(state);
    return this.#state;
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
