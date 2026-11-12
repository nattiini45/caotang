import { defineMachine, type MachineTable } from '@caotang/machine';

export type SessionSelection = { readonly kind: 'unloaded' | 'ready' }
  | { readonly kind: 'loading'; readonly request: number }
  | { readonly kind: 'failed'; readonly message: string };
export type SessionSelectionEvent = { readonly type: 'load'; readonly request: number }
  | { readonly type: 'loaded'; readonly request: number }
  | { readonly type: 'failed'; readonly request: number; readonly message: string };

export const sessionSelectionTable: MachineTable<SessionSelection, SessionSelectionEvent> = {
  id: 'agent.session-selection', initial: 'unloaded', final: [],
  on: {
    unloaded: { load: ['loading'] },
    ready: { load: ['loading'] },
    loading: { loaded: ['ready', 'loading'], failed: ['failed', 'loading'] },
    failed: { load: ['loading'] },
  },
};

export const sessionSelectionMachine = defineMachine(sessionSelectionTable, (state, event): SessionSelection => {
  if (event.type === 'load') return state.kind === 'loading' ? state : { kind: 'loading', request: event.request };
  if (state.kind !== 'loading' || state.request !== event.request) return state;
  return event.type === 'loaded' ? { kind: 'ready' } : { kind: 'failed', message: event.message };
});
