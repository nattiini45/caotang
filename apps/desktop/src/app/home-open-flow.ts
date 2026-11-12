import { assertNever, defineMachine, type MachineTable } from '@caotang/machine';

import type { FolderDiffers, FolderFileChange, OpenOutcome, PendingEncoding, PendingRecovery, RecoveryOutcome, RecoveryRefusal } from './lifecycle.js';

export type HomeOpenState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'recovery';
      readonly recovery: PendingRecovery;
      readonly refusal: { readonly reason: RecoveryRefusal; readonly files: readonly FolderFileChange[] } | null;
    }
  | { readonly kind: 'encoding'; readonly encoding: PendingEncoding }
  | { readonly kind: 'differs'; readonly differs: FolderDiffers };

export type HomeOpenEvent =
  | { readonly type: 'open-result'; readonly outcome: OpenOutcome }
  | { readonly type: 'resume' }
  | { readonly type: 'recovery-result'; readonly outcome: RecoveryOutcome }
  | { readonly type: 'recovery-failed' }
  | { readonly type: 'cancel' };

export const homeOpenTable: MachineTable<HomeOpenState, HomeOpenEvent> = {
  id: 'home.pending-open', initial: 'idle', final: [],
  on: {
    idle: { 'open-result': ['idle', 'recovery', 'encoding', 'differs'] },
    recovery: { 'recovery-result': ['idle', 'recovery', 'encoding'], 'recovery-failed': ['idle'], cancel: ['idle'] },
    encoding: { resume: ['idle'], cancel: ['idle'] },
    differs: { resume: ['idle'], cancel: ['idle'] },
  },
};

export function stepHomeOpen(state: HomeOpenState, event: HomeOpenEvent): HomeOpenState {
  switch (event.type) {
    case 'open-result': {
      if (state.kind !== 'idle') return state;
      const outcome = event.outcome;
      switch (outcome.kind) {
        case 'opened': return { kind: 'idle' };
        case 'recover': return { kind: 'recovery', recovery: outcome.recovery, refusal: null };
        case 'encoding': return { kind: 'encoding', encoding: outcome.encoding };
        case 'differs': return { kind: 'differs', differs: outcome.differs };
        default: return assertNever(outcome);
      }
    }
    case 'resume':
      return state.kind === 'encoding' || state.kind === 'differs' ? { kind: 'idle' } : state;
    case 'recovery-result': {
      if (state.kind !== 'recovery') return state;
      const outcome = event.outcome;
      switch (outcome.kind) {
        case 'opened': return { kind: 'idle' };
        case 'encoding': return { kind: 'encoding', encoding: outcome.encoding };
        case 'refused': return { ...state, refusal: { reason: outcome.reason, files: outcome.files } };
        default: return assertNever(outcome);
      }
    }
    case 'recovery-failed':
      return state.kind === 'recovery' ? { kind: 'idle' } : state;
    case 'cancel':
      return state.kind === 'idle' ? state : { kind: 'idle' };
    default:
      return assertNever(event);
  }
}

export const homeOpenMachine = defineMachine(homeOpenTable, stepHomeOpen);
