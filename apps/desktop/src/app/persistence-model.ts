import { assertNever, defineMachine, type MachineTable } from '@caotang/machine';

export type PersistenceState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'writing' }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'conflict'; readonly error: unknown };

export type PersistenceEvent =
  | { readonly type: 'write' }
  | { readonly type: 'saved' }
  | { readonly type: 'fail'; readonly error: unknown }
  | { readonly type: 'stop'; readonly error: unknown };

export const persistenceTable: MachineTable<PersistenceState, PersistenceEvent> = {
  id: 'persistence.status', initial: 'idle', final: ['conflict'],
  on: {
    idle: { write: ['writing'], saved: ['idle'] },
    writing: { saved: ['idle'], fail: ['failed'], stop: ['conflict'] },
    failed: { write: ['writing'], saved: ['idle'] },
    conflict: {},
  },
};

export function stepPersistence(state: PersistenceState, event: PersistenceEvent): PersistenceState {
  if (state.kind === 'conflict') return state;
  switch (event.type) {
    case 'write':
      return state.kind === 'writing' ? state : { kind: 'writing' };
    case 'saved':
      return { kind: 'idle' };
    case 'fail':
      return state.kind === 'writing' ? { kind: 'failed', error: event.error } : state;
    case 'stop':
      return state.kind === 'writing' ? { kind: 'conflict', error: event.error } : state;
    default:
      return assertNever(event);
  }
}

export const persistenceMachine = defineMachine(persistenceTable, stepPersistence);
