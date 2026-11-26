import type { EncryptedRemoteArtifactFs, RemoteChange } from '@caotang/remote-store';
import type { ProjectState } from '@caotang/store';
import type { PersistenceStatus } from './persistence.js';

export type BasedChange = RemoteChange & { readonly base: number };
type AcceptedChange = BasedChange & { readonly version: number };
type Pictures = Readonly<Record<string, Uint8Array>>;

export type HostedSaveState = (
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'unsaved'; readonly paths: readonly string[]; readonly persisted: boolean }
  | { readonly kind: 'conflict'; readonly paths: readonly string[]; readonly persisted: boolean }
  | { readonly kind: 'stale' }
) & { readonly waiting?: { readonly paths: readonly string[]; readonly persisted: boolean } };

export type HostedReplay =
  | { readonly kind: 'accepted'; readonly changes: readonly AcceptedChange[] }
  | { readonly kind: 'empty' | 'unavailable' }
  | { readonly kind: 'conflict'; readonly versions: ReadonlyMap<string, number> };

export interface HostedQueuePort {
  stage(changes: readonly BasedChange[], unread?: ReadonlyMap<string, number>): void;
  held(): readonly string[];
  deferred(): readonly string[];
  opened(): void;
  persisted(): boolean;
  send(refresh: boolean, answer?: ReadonlyMap<string, number>): Promise<HostedReplay>;
}

interface HostedBaseline {
  changes(state: ProjectState, pictures: Pictures): Promise<readonly BasedChange[]>;
  accepted(changes: readonly AcceptedChange[]): void;
}

export interface HostedSaveSession {
  readonly state: ProjectState;
  readonly persistence: {
    subscribe(listener: () => void): () => void;
    getStatus(): PersistenceStatus;
  };
  assets(): Promise<Pictures>;
}

export { forgetHostedTarget, hostedTargetFor, installHostedTarget } from './hosted-target-registry.js';

export class HostedTarget {
  #state: HostedSaveState = { kind: 'idle' };
  #listeners = new Set<() => void>();
  #turn: Promise<unknown> = Promise.resolve();
  #detached: (() => void) | null = null;
  #assets: (() => Promise<Pictures>) | null = null;
  #baseline: HostedBaseline | null = null;
  #asked: ReadonlyMap<string, number> = new Map();
  #stageFailed = false;
  #localPaths = new Set<string>();
  #unread = new Map<string, number>();

  constructor(
    readonly projectId: string,
    readonly fs: EncryptedRemoteArtifactFs,
    readonly queue: HostedQueuePort,
    readonly baseline: (state: ProjectState, pictures: Pictures) => Promise<HostedBaseline>,
  ) {}

  state(): HostedSaveState {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async rememberOpened(state: ProjectState, pictures: Pictures): Promise<void> {
    this.#baseline = await this.baseline(state, pictures);
    this.queue.opened();
    if (this.queue.held().length > 0) this.#unsaved();
  }

  canReread(): boolean {
    return !this.#stageFailed &&
      (this.#state.kind === 'stale' || this.#state.waiting !== undefined) &&
      (this.queue.persisted() || (this.queue.held().length === 0 && this.queue.deferred().length === 0));
  }

  attach(session: HostedSaveSession): () => void {
    this.detach();
    this.#assets = session.assets;
    let writing = session.persistence.getStatus() === 'writing';
    const stop = session.persistence.subscribe(() => {
      const status = session.persistence.getStatus();
      const landed = writing && status === 'idle';
      writing = status === 'writing';
      if (landed) void this.save(session.state);
    });
    this.#detached = stop;
    return () => { if (this.#detached === stop) this.detach(); };
  }

  detach(): void {
    this.#detached?.();
    this.#detached = null;
  }

  async settled(): Promise<void> {
    let turn: Promise<unknown>;
    do {
      turn = this.#turn;
      await turn;
    } while (turn !== this.#turn);
  }

  async save(state: ProjectState): Promise<void> {
    await this.#inTurn(async () => {
      if (this.#baseline === null) return;
      const previous = this.#state;
      let changes: readonly BasedChange[];
      try {
        changes = await this.#baseline.changes(state, (await this.#assets?.()) ?? {});
        this.queue.stage(changes, this.#unread);
        for (const { path } of changes) this.#localPaths.add(path);
        this.#stageFailed = false;
      } catch {
        this.#stageFailed = true;
        if (previous.kind === 'conflict') this.#conflict(this.#asked);
        else this.#unsaved();
        return;
      }
      if (previous.kind === 'conflict') {
        const remaining = new Map([...this.#asked].filter(([path]) => this.queue.held().includes(path)));
        if (remaining.size > 0) this.#conflict(remaining);
        else this.#unsaved();
      } else if (this.queue.held().length > 0) {
        if (previous.kind === 'idle') await this.#send(false);
        else this.#unsaved();
      } else if (this.queue.deferred().length > 0) {
        this.#set({ kind: 'stale' });
      } else if (previous.kind === 'unsaved') {
        this.#set({ kind: 'idle' });
      }
    });
  }

  async sendQueued(): Promise<HostedSaveState> {
    return await this.#inTurn(async () => {
      if (this.#state.kind === 'unsaved' && !this.#stageFailed && this.queue.held().length > 0) await this.#send(true);
      return this.#state;
    });
  }

  async keepMine(): Promise<HostedSaveState> {
    const answer = this.#asked;
    return await this.#inTurn(async () => {
      if (this.#state.kind === 'conflict' && !this.#stageFailed && answer === this.#asked) await this.#send(true, answer);
      return this.#state;
    });
  }

  async #send(refresh: boolean, answer?: ReadonlyMap<string, number>): Promise<void> {
    this.#set({ kind: 'saving' });
    const result = await this.queue.send(refresh, answer);
    if (result.kind === 'accepted') {
      this.#asked = new Map();
      const local = result.changes.filter(({ path, version }) => {
        if (this.#localPaths.delete(path)) return true;
        this.#unread.set(path, version);
        return false;
      });
      if (local.length > 0) this.#baseline?.accepted(local);
      this.#set({ kind: refresh ? 'stale' : 'idle' });
    } else if (result.kind === 'conflict') {
      this.#conflict(result.versions);
    } else if (answer !== undefined) {
      this.#conflict(answer);
    } else {
      this.#unsaved();
    }
  }

  #conflict(versions: ReadonlyMap<string, number>): void {
    this.#asked = versions;
    this.#set({ kind: 'conflict', paths: [...versions.keys()], persisted: !this.#stageFailed && this.queue.persisted() });
  }

  #unsaved(): void {
    const paths = this.queue.held();
    if (paths.length === 0 && !this.#stageFailed) {
      this.#set({ kind: this.queue.deferred().length > 0 ? 'stale' : 'idle' });
    } else {
      this.#set({ kind: 'unsaved', paths, persisted: !this.#stageFailed && this.queue.persisted() });
    }
  }

  async #inTurn<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#turn.then(work);
    this.#turn = next.then(() => undefined, () => undefined);
    return await next;
  }

  #set(next: HostedSaveState): void {
    const paths = this.queue.deferred();
    this.#state = paths.length === 0 ? next : {
      ...next, waiting: { paths, persisted: !this.#stageFailed && this.queue.persisted() },
    };
    for (const listener of this.#listeners) listener();
  }
}
