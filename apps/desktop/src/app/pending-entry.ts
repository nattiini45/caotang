import { assertNever, defineMachine, type MachineTable } from '@caotang/machine';

import type { PendingEntry } from './pending-journal.js';

export type PendingEntryState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'held'; readonly entry: PendingEntry }
  | { readonly kind: 'written'; readonly entry: PendingEntry }
  | { readonly kind: 'pruned' }
  | { readonly kind: 'cleared-for-stop' };

export type PendingEntryEvent =
  | { readonly type: 'hold'; readonly entry: PendingEntry }
  | { readonly type: 'write' }
  | { readonly type: 'prune'; readonly body: string | undefined }
  | { readonly type: 'drop' }
  | { readonly type: 'stop'; readonly copyLanded: boolean };

export const pendingEntryTable: MachineTable<PendingEntryState, PendingEntryEvent> = {
  id: 'pending.entry', initial: 'empty', final: ['pruned', 'cleared-for-stop'],
  on: {
    empty: { hold: ['held'] },
    held: { hold: ['held'], write: ['written'], prune: ['held', 'pruned'], drop: ['pruned'], stop: ['held', 'cleared-for-stop'] },
    written: { hold: ['held'], write: ['written'], prune: ['written', 'pruned'], drop: ['pruned'], stop: ['written', 'cleared-for-stop'] },
    pruned: {},
    'cleared-for-stop': {},
  },
};

export function stepPendingEntry(state: PendingEntryState, event: PendingEntryEvent): PendingEntryState {
  if (state.kind === 'pruned' || state.kind === 'cleared-for-stop') return state;
  switch (event.type) {
    case 'hold':
      return { kind: 'held', entry: event.entry };
    case 'write':
      return 'entry' in state ? { kind: 'written', entry: state.entry } : state;
    case 'prune':
      return 'entry' in state && event.body === state.entry.body ? { kind: 'pruned' } : state;
    case 'drop':
      return 'entry' in state ? { kind: 'pruned' } : state;
    case 'stop':
      return 'entry' in state && event.copyLanded ? { kind: 'cleared-for-stop' } : state;
    default:
      return assertNever(event);
  }
}

export const pendingEntryMachine = defineMachine(pendingEntryTable, stepPendingEntry);
