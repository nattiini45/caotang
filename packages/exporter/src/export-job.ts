import { assertNever, defineMachine } from '@caotang/machine';
import type { EmitFailure } from './emit.js';

export type ExportJobState =
  | { readonly kind: 'queued' }
  | { readonly kind: 'rendering' }
  | { readonly kind: 'writing' }
  | { readonly kind: 'written'; readonly outputs: readonly string[] }
  | { readonly kind: 'failed'; readonly failures: readonly EmitFailure[] };

export interface ExportJob {
  readonly id: string;
  readonly paths: readonly string[];
  readonly state: ExportJobState;
}

export type ExportJobEvent =
  | { readonly type: 'render' }
  | { readonly type: 'write' }
  | { readonly type: 'written'; readonly outputs: readonly string[] }
  | { readonly type: 'failed'; readonly failures: readonly EmitFailure[] };

export const exportJobMachine = defineMachine<ExportJobState, ExportJobEvent>({
  id: 'export.job',
  initial: 'queued',
  final: ['written', 'failed'],
  on: {
    queued: { render: ['rendering'] },
    rendering: { write: ['writing'], failed: ['failed'] },
    writing: { written: ['written'], failed: ['failed'] },
    written: {},
    failed: {},
  },
}, (state, event) => {
  switch (event.type) {
    case 'render': return state.kind === 'queued' ? { kind: 'rendering' } : state;
    case 'write': return state.kind === 'rendering' ? { kind: 'writing' } : state;
    case 'written': return state.kind === 'writing' ? { kind: 'written', outputs: event.outputs } : state;
    case 'failed': return state.kind === 'rendering' || state.kind === 'writing' ? { kind: 'failed', failures: event.failures } : state;
    default: return assertNever(event);
  }
});
