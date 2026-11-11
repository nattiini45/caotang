import { assertNever, defineMachine, type MachineTable } from '@caotang/machine';

export interface StoredMark {
  readonly body: string;
  readonly revision: number;
}

export function isOwnWrite(own: StoredMark | null, stored: string, revision: number): boolean {
  return own !== null && own.revision === revision && own.body === stored;
}

export type StoreRebaseState = {
  readonly kind: 'idle' | 'synced' | 'failed';
  readonly token: number;
  readonly synced: StoredMark | null;
} | {
  readonly kind: 'rebasing';
  readonly token: number;
  readonly synced: StoredMark | null;
  readonly target: StoredMark;
};

export type StoreRebaseEvent =
  | { readonly type: 'begin' | 'acknowledge'; readonly mark: StoredMark }
  | { readonly type: 'land' | 'fail'; readonly token: number }
  | { readonly type: 'invalidate' };

export const storeRebaseTable: MachineTable<StoreRebaseState, StoreRebaseEvent> = {
  id: 'editor.store-rebase', initial: 'idle', final: [],
  on: {
    idle: { begin: ['rebasing'], acknowledge: ['synced'], invalidate: ['idle'] },
    synced: { begin: ['rebasing'], acknowledge: ['synced'], invalidate: ['idle'] },
    rebasing: { begin: ['rebasing'], acknowledge: ['synced'], land: ['synced', 'rebasing'], fail: ['failed', 'rebasing'], invalidate: ['idle'] },
    failed: { begin: ['rebasing'], acknowledge: ['synced'], invalidate: ['idle'] },
  },
};

export function stepStoreRebase(state: StoreRebaseState, event: StoreRebaseEvent): StoreRebaseState {
  switch (event.type) {
    case 'begin':
      return { kind: 'rebasing', token: state.token + 1, synced: state.synced, target: event.mark };
    case 'acknowledge':
      return { kind: 'synced', token: state.token + 1, synced: event.mark };
    case 'land':
      return state.kind === 'rebasing' && state.token === event.token
        ? { kind: 'synced', token: state.token, synced: state.target }
        : state;
    case 'fail':
      return state.kind === 'rebasing' && state.token === event.token
        ? { kind: 'failed', token: state.token, synced: state.synced }
        : state;
    case 'invalidate':
      return { kind: 'idle', token: state.token + 1, synced: state.synced };
    default:
      return assertNever(event);
  }
}

export const storeRebaseMachine = defineMachine(storeRebaseTable, stepStoreRebase);
