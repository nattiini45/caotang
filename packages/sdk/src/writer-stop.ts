import { assertNever, defineMachine, type MachineTable } from '@caotang/machine';

export type StopReason =
  | { readonly kind: 'drift'; readonly cause: string; readonly recovery?: string }
  | { readonly kind: 'saved-drift'; readonly cause: string; readonly recovery?: string }
  | { readonly kind: 'partial'; readonly recovery: string };

export type WriterState = { readonly kind: 'open' } | StopReason;
export type WriterEvent =
  | { readonly type: 'drift'; readonly cause: string; readonly saved: boolean }
  | { readonly type: 'partial'; readonly recovery: string };

export const writerStopTable: MachineTable<WriterState, WriterEvent> = {
  id: 'sdk.writer', initial: 'open', final: [],
  on: {
    open: { drift: ['drift', 'saved-drift'], partial: ['partial'] },
    drift: { partial: ['drift'] },
    'saved-drift': { partial: ['saved-drift'] },
    partial: { partial: ['partial'] },
  },
};

export const writerStopMachine = defineMachine(writerStopTable, (state, event): WriterState => {
  switch (event.type) {
    case 'drift':
      return state.kind === 'open' ? { kind: event.saved ? 'saved-drift' : 'drift', cause: event.cause } : state;
    case 'partial':
      return state.kind === 'open' ? { kind: 'partial', recovery: event.recovery } : { ...state, recovery: event.recovery };
    default: return assertNever(event);
  }
});
