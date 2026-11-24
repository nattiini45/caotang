import { assertNever, defineMachine, type MachineTable } from '@caotang/machine';

export type StopReason =
  | { readonly kind: 'drift'; readonly cause: string; readonly recovery?: string }
  | { readonly kind: 'saved-drift'; readonly cause: string; readonly recovery?: string }
  | { readonly kind: 'partial'; readonly recovery: string };

export type WriterState = { readonly kind: 'open' } | StopReason;
export type WriterEvent =
  | { readonly type: 'drift'; readonly cause: string; readonly saved: boolean }
  | { readonly type: 'partial'; readonly recovery: string }
  /** The folder was read again and taken as this copy's, after a save the host coordinated with (folder.ts `reload`). */
  | { readonly type: 'reload' };

export const writerStopTable: MachineTable<WriterState, WriterEvent> = {
  id: 'sdk.writer', initial: 'open', final: [],
  on: {
    open: { drift: ['drift', 'saved-drift'], partial: ['partial'], reload: ['open'] },
    drift: { partial: ['drift'], reload: ['open'] },
    'saved-drift': { partial: ['saved-drift'], reload: ['open'] },
    partial: { partial: ['partial'], reload: ['open'] },
  },
};

export const writerStopMachine = defineMachine(writerStopTable, (state, event): WriterState => {
  switch (event.type) {
    case 'drift':
      return state.kind === 'open' ? { kind: event.saved ? 'saved-drift' : 'drift', cause: event.cause } : state;
    case 'partial':
      return state.kind === 'open' ? { kind: 'partial', recovery: event.recovery } : { ...state, recovery: event.recovery };
    case 'reload':
      return { kind: 'open' };
    default: return assertNever(event);
  }
});
