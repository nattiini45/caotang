import { assertNever, defineMachine } from '@caotang/machine';

export interface CompileFailure {
  readonly text: string;
  readonly hookRequest?: string;
}

export type CompileState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'failed'; readonly failure: CompileFailure };

export type CompileEvent =
  | { readonly type: 'start' }
  | { readonly type: 'reset' }
  | { readonly type: 'succeeded' }
  | { readonly type: 'failed'; readonly failure: CompileFailure };

export const exportCompileMachine = defineMachine<CompileState, CompileEvent>({
  id: 'ui.export.compile',
  initial: 'idle',
  final: [],
  on: {
    idle: { start: ['running'], reset: ['idle'] },
    running: { succeeded: ['idle'], failed: ['failed'] },
    failed: { start: ['running'], reset: ['idle'] },
  },
}, (state, event) => {
  switch (event.type) {
    case 'start': return state.kind === 'running' ? state : { kind: 'running' };
    case 'reset': return state.kind === 'running' ? state : { kind: 'idle' };
    case 'succeeded': return state.kind === 'running' ? { kind: 'idle' } : state;
    case 'failed': return state.kind === 'running' ? { kind: 'failed', failure: event.failure } : state;
    default: return assertNever(event);
  }
});

export type ExportReadinessState =
  | { readonly kind: 'waiting'; readonly request: number }
  | { readonly kind: 'ready'; readonly request: number }
  | { readonly kind: 'failed'; readonly request: number; readonly message: string };

export type ExportReadinessEvent =
  | { readonly type: 'check'; readonly request: number }
  | { readonly type: 'ready'; readonly request: number }
  | { readonly type: 'failed'; readonly request: number; readonly message: string };

export const exportReadinessMachine = defineMachine<ExportReadinessState, ExportReadinessEvent>({
  id: 'ui.export.readiness',
  initial: 'waiting',
  final: [],
  on: {
    waiting: { check: ['waiting'], ready: ['waiting', 'ready'], failed: ['waiting', 'failed'] },
    ready: { check: ['waiting', 'ready'] },
    failed: { check: ['waiting', 'failed'] },
  },
}, (state, event) => {
  switch (event.type) {
    case 'check': return event.request > state.request ? { kind: 'waiting', request: event.request } : state;
    case 'ready': return state.kind === 'waiting' && event.request === state.request ? { kind: 'ready', request: event.request } : state;
    case 'failed': return state.kind === 'waiting' && event.request === state.request ? { kind: 'failed', request: event.request, message: event.message } : state;
    default: return assertNever(event);
  }
});
