/**
 * Staged picture bytes — [pictures.md §6.4.2](docs/architecture/pictures.md).
 *
 * The host stages the bytes a writer chose (a drop, a paste, a file picker, an MCP client's image block) and an import command names them.
 * Two ways to use them live side by side:
 *
 * - `take` is the old, single-use hand-over: it returns the bytes and forgets them. It stays so a host that implements only `stage` and `take`
 *   keeps working, and so the unit specs that read it keep their meaning.
 * - `reserve` / `commit` / `release` / `discard` are the retryable hand-over the imports use. A reservation holds the bytes for the length of
 *   one command; `commit` forgets them once the record and the file are written, and `release` puts them back, so a retry after a full disk
 *   never asks the writer to choose the file again and nothing is dropped silently.
 *
 * Staging is scoped to the project that staged it: a token from one project is refused by another's, so a host that keeps one staging area
 * across projects cannot import a picture into the wrong one.
 */

import { newId } from '@caotang/ids';
import { assertNever, defineMachine, type MachineTable } from '@caotang/machine';

/** Image bytes the host has chosen and is holding until the command that imports them runs. */
export interface AssetStaging {
  stage(bytes: Uint8Array): string;
  /** Single-use: hands the bytes over and forgets them. */
  take(token: string): Uint8Array | undefined;
}

/** One reservation: the bytes of every staged id it names, held for one command. */
export interface AssetReservation {
  readonly id: string;
  readonly items: readonly { readonly stagingId: string; readonly bytes: Uint8Array }[];
  /** True once the writer cancelled any of its pictures. An import checks it before it writes. */
  isCancelled(): boolean;
}

export type StagingFailure = 'unknown' | 'reserved' | 'scope';

/** `reserve` refused, naming the id and why. Nothing was reserved. */
export class StagingError extends Error {
  readonly reason: StagingFailure;
  readonly stagingId: string;
  constructor(reason: StagingFailure, stagingId: string) {
    super(
      reason === 'unknown'
        ? `the staged picture ${stagingId} is not held`
        : reason === 'reserved'
          ? `the staged picture ${stagingId} is already being imported`
          : `the staged picture ${stagingId} belongs to another project`,
    );
    this.name = 'StagingError';
    this.reason = reason;
    this.stagingId = stagingId;
  }
}

export interface RetryableAssetStaging extends AssetStaging {
  /** Holds every named id for one command, or none: an unknown, already-reserved or other-project id refuses the lot. */
  reserve(ids: readonly string[], scope?: string): AssetReservation;
  /** The record and the file are written: the reservation's bytes are forgotten. */
  commit(reservationId: string): void;
  /** Back to the staged set, bytes held, as they were before `reserve`. */
  release(reservationId: string): void;
  /** The writer or a refusal drops these ids. A reserved id is dropped too. */
  discard(ids: readonly string[]): void;
  /** The writer cancelled these pictures. A reservation holding one reports it, and releases it when its command stops. */
  cancel(ids: readonly string[]): void;
}

export function isRetryable(staging: AssetStaging): staging is RetryableAssetStaging {
  return typeof (staging as Partial<RetryableAssetStaging>).reserve === 'function';
}

export type AssetStagingState =
  | { readonly kind: 'staged' }
  | { readonly kind: 'staged-cancelled' }
  | { readonly kind: 'reserved'; readonly reservationId: string }
  | { readonly kind: 'reserved-cancelled'; readonly reservationId: string }
  | { readonly kind: 'removed' }
  | { readonly kind: 'removed-cancelled' };

export type AssetStagingEvent =
  | { readonly type: 'reserve'; readonly reservationId: string }
  | { readonly type: 'commit'; readonly reservationId: string }
  | { readonly type: 'release'; readonly reservationId: string }
  | { readonly type: 'take' }
  | { readonly type: 'discard' }
  | { readonly type: 'cancel' };

export const assetStagingTable: MachineTable<AssetStagingState, AssetStagingEvent> = {
  id: 'asset.staging',
  initial: 'staged',
  final: ['removed', 'removed-cancelled'],
  on: {
    staged: { reserve: ['reserved'], take: ['removed'], discard: ['removed'], cancel: ['staged-cancelled'] },
    'staged-cancelled': { reserve: ['reserved-cancelled'], take: ['removed-cancelled'], discard: ['removed-cancelled'], cancel: ['staged-cancelled'] },
    reserved: { commit: ['reserved', 'removed'], release: ['reserved', 'staged'], discard: ['removed'], cancel: ['reserved-cancelled'] },
    'reserved-cancelled': { commit: ['reserved-cancelled', 'removed-cancelled'], release: ['reserved-cancelled', 'staged'], discard: ['removed-cancelled'], cancel: ['reserved-cancelled'] },
    removed: {},
    'removed-cancelled': {},
  },
};

function isCancelled(state: AssetStagingState): boolean {
  return state.kind === 'staged-cancelled' || state.kind === 'reserved-cancelled' || state.kind === 'removed-cancelled';
}

export function stepAssetStaging(state: AssetStagingState, event: AssetStagingEvent): AssetStagingState {
  switch (state.kind) {
    case 'staged':
    case 'staged-cancelled':
      switch (event.type) {
        case 'reserve': return { kind: isCancelled(state) ? 'reserved-cancelled' : 'reserved', reservationId: event.reservationId };
        case 'cancel': return { kind: 'staged-cancelled' };
        case 'take':
        case 'discard': return { kind: isCancelled(state) ? 'removed-cancelled' : 'removed' };
        case 'commit':
        case 'release': return state;
        default: return assertNever(event);
      }
    case 'reserved':
    case 'reserved-cancelled':
      switch (event.type) {
        case 'commit':
          return event.reservationId === state.reservationId ? { kind: isCancelled(state) ? 'removed-cancelled' : 'removed' } : state;
        case 'release': return event.reservationId === state.reservationId ? { kind: 'staged' } : state;
        case 'cancel': return { kind: 'reserved-cancelled', reservationId: state.reservationId };
        case 'discard': return { kind: isCancelled(state) ? 'removed-cancelled' : 'removed' };
        case 'reserve':
        case 'take': return state;
        default: return assertNever(event);
      }
    case 'removed':
    case 'removed-cancelled':
      switch (event.type) {
        case 'reserve':
        case 'commit':
        case 'release':
        case 'take':
        case 'discard':
        case 'cancel': return state;
        default: return assertNever(event);
      }
    default: return assertNever(state);
  }
}

export const assetStagingMachine = defineMachine(assetStagingTable, stepAssetStaging);

interface Held {
  readonly bytes: Uint8Array;
  readonly scope: string | undefined;
  state: AssetStagingState;
}

/** An in-memory staging area. The host keeps one for the life of the project it has open, naming the project so its tokens stay its own. */
export function createAssetStaging(scope?: string): RetryableAssetStaging {
  const held = new Map<string, Held>();
  const reservations = new Map<string, readonly string[]>();

  return {
    stage(bytes) {
      const token = `stg_${newId('c').slice(2)}`;
      held.set(token, { bytes: bytes.slice(), scope, state: { kind: 'staged' } });
      return token;
    },
    take(token) {
      const entry = held.get(token);
      if (entry === undefined || (entry.state.kind !== 'staged' && entry.state.kind !== 'staged-cancelled')) return undefined;
      entry.state = assetStagingMachine.step(entry.state, { type: 'take' });
      held.delete(token);
      return entry.bytes;
    },
    reserve(ids, asking = scope) {
      const entries: { id: string; entry: Held }[] = [];
      for (const id of ids) {
        const entry = held.get(id);
        if (entry === undefined) throw new StagingError('unknown', id);
        if ((entry.state.kind !== 'staged' && entry.state.kind !== 'staged-cancelled') || entries.some((other) => other.id === id)) throw new StagingError('reserved', id);
        if (asking !== undefined && entry.scope !== undefined && entry.scope !== asking) throw new StagingError('scope', id);
        entries.push({ id, entry });
      }
      const reservationId = `rsv_${newId('c').slice(2)}`;
      for (const { entry } of entries) entry.state = assetStagingMachine.step(entry.state, { type: 'reserve', reservationId });
      reservations.set(reservationId, [...ids]);
      return {
        id: reservationId,
        items: entries.map(({ id, entry }) => ({ stagingId: id, bytes: entry.bytes })),
        isCancelled: () => entries.some(({ entry }) => isCancelled(entry.state)),
      };
    },
    commit(reservationId) {
      for (const id of reservations.get(reservationId) ?? []) {
        const entry = held.get(id);
        if (entry === undefined) continue;
        entry.state = assetStagingMachine.step(entry.state, { type: 'commit', reservationId });
        if (entry.state.kind === 'removed' || entry.state.kind === 'removed-cancelled') held.delete(id);
      }
      reservations.delete(reservationId);
    },
    release(reservationId) {
      for (const id of reservations.get(reservationId) ?? []) {
        const entry = held.get(id);
        if (entry !== undefined) entry.state = assetStagingMachine.step(entry.state, { type: 'release', reservationId });
      }
      reservations.delete(reservationId);
    },
    discard(ids) {
      for (const id of ids) {
        const entry = held.get(id);
        if (entry !== undefined) entry.state = assetStagingMachine.step(entry.state, { type: 'discard' });
        held.delete(id);
      }
    },
    cancel(ids) {
      for (const id of ids) {
        const entry = held.get(id);
        if (entry !== undefined) entry.state = assetStagingMachine.step(entry.state, { type: 'cancel' });
      }
    },
  };
}
