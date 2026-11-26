import type { EncryptedRemoteArtifactFs, RemoteChange } from '@caotang/remote-store';
import type { ProjectState } from '@caotang/store';
import type { PersistenceStatus } from './persistence.js';

type BasedChange = RemoteChange & { readonly base: number };
type Pictures = Readonly<Record<string, Uint8Array>>;

export type HostedSaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'unsaved'; readonly paths: readonly string[]; readonly persisted: boolean }
  | { readonly kind: 'conflict'; readonly paths: readonly string[]; readonly persisted: boolean }
  | { readonly kind: 'stale' };

export type HostedReplay =
  | { readonly kind: 'accepted'; readonly changes: readonly BasedChange[] }
  | { readonly kind: 'empty' | 'unavailable' }
  | { readonly kind: 'conflict'; readonly versions: ReadonlyMap<string, number> };

export interface HostedQueuePort {
  stage(changes: readonly BasedChange[]): void;
  held(): readonly string[];
  persisted(): boolean;
  send(refresh: boolean, answer?: ReadonlyMap<string, number>): Promise<HostedReplay>;
}

interface HostedBaseline {
  changes(state: ProjectState, pictures: Pictures): Promise<readonly BasedChange[]>;
  accepted(changes: readonly BasedChange[]): void;
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
    if (this.queue.held().length > 0) this.#unsaved();
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
        this.queue.stage(changes);
        for (const { path } of changes) this.#localPaths.add(path);
        this.#stageFailed = false;
      } catch {
        this.#stageFailed = true;
        if (previous.kind === 'conflict') this.#conflict(this.#asked);
        else this.#unsaved();
        return;
      }
      if (previous.kind === 'conflict') {
        this.#conflict(this.#asked);
      } else if (this.queue.held().length > 0) {
        if (previous.kind === 'idle') await this.#send(false);
        else this.#unsaved();
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
      const local = result.changes.filter(({ path }) => this.#localPaths.delete(path));
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
    this.#set({ kind: 'unsaved', paths: this.queue.held(), persisted: !this.#stageFailed && this.queue.persisted() });
  }

  async #inTurn<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#turn.then(work);
    this.#turn = next.then(() => undefined, () => undefined);
    return await next;
  }

  #set(next: HostedSaveState): void {
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}
