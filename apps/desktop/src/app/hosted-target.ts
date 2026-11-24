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
  /**
   * Each picture as this device last agreed with the account: the digest of the bytes and the account version they are. A save
   * stages only what changed here against that baseline, so a picture another device wrote after this one opened is never written
   * back from this browser's older snapshot — the adapter compares bytes with the index it holds, and an unrelated commit has
   * already advanced that index past the other device's write.
   */
  readonly #assetsAt = new Map<string, { readonly digest: string; readonly version: number }>();

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
  async rememberOpened(documents: Iterable<string>, assets: Readonly<Record<string, Uint8Array>>): Promise<void> {
    for (const id of documents) this.#knownDocuments.add(id);
    this.#knownAssets.clear();
    this.#assetsAt.clear();
    for (const [path, bytes] of Object.entries(assets)) {
      this.#knownAssets.add(path);
      this.#assetsAt.set(path, { digest: await digestOf(bytes), version: this.#versionOf(path) });
    }
  }

  /** The account's version of a path, as the adapter holds it; a filesystem without one is treated as never having moved. */
  #versionOf(path: string): number {
    const version = (this.fs as { versionOf?: (path: string) => number }).versionOf;
    return typeof version === 'function' ? version.call(this.fs, path) : 0;
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
    const held = (await this.#assets?.()) ?? null;
    const kept = held === null ? null : new Set(Object.keys(held));
    const removedAssets = kept === null ? [] : [...this.#knownAssets].filter((path) => !kept.has(path));
    // Only the pictures this device changed are staged. The rest are the account's own bytes as this device opened them, and
    // sending them again would write this browser's older snapshot over another device's newer picture.
    const files: Record<string, Uint8Array> = {};
    const digests = new Map<string, string>();
    const moved: RemoteChange[] = [];
    for (const [path, bytes] of Object.entries(held ?? {})) {
      const digest = await digestOf(bytes);
      const at = this.#assetsAt.get(path);
      // Unchanged here: nothing to say about it, whatever the account has done with it.
      if (at !== undefined && at.digest === digest) {
        digests.set(path, digest);
        continue;
      }
      // Changed here while the account moved too (or arrived from another device this one never read): that is the same question a
      // document raises, and nothing is written until the writer answers it.
      if ((at === undefined && this.#versionOf(path) !== 0) || (at !== undefined && at.version !== this.#versionOf(path))) {
        moved.push({ path, bytes });
        continue;
      }
      files[path] = bytes;
      digests.set(path, digest);
    }
    if (moved.length > 0) {
      // The staged bytes are the answer's to replay: "keep mine" sends this device's pictures on top of the other device's version.
      this.#conflict = moved;
      this.#set({ kind: 'conflict', paths: moved.map((change) => change.path) });
      return;
    }
    let outcome: HostedSaveOutcome;
    try {
      outcome = await this.saveState(state, { removed, assets: held === null ? undefined : { files, removed: removedAssets } });
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
      // The pictures this save carried are the account's at the version the commit gave them. One it left alone keeps the baseline it
      // had, so a later edit here against a picture another device has since written still asks rather than overwriting it.
      for (const path of Object.keys(files)) this.#assetsAt.set(path, { digest: digests.get(path)!, version: this.#versionOf(path) });
      for (const path of outcome.report.pruned) if (path.startsWith('assets/')) this.#assetsAt.delete(path);
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

/** A picture's bytes as one string, so a save can tell this device's change from another device's. */
async function digestOf(bytes: Uint8Array): Promise<string> {
  // A copy of its own: the bytes may come from a snapshot whose buffer the browser also holds, and `subtle.digest` wants an
  // `ArrayBuffer` it can read without sharing.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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
