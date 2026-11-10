import { assertNever, defineMachine, type MachineTable } from '@caotang/machine';

export type ImportPreviewPhase =
  | { readonly kind: 'loading'; readonly progress: string }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready' }
  | { readonly kind: 'committing' }
  | { readonly kind: 'commit-failed'; readonly message: string }
  | { readonly kind: 'closed'; readonly committed: boolean };

export type ImportPreviewEvent =
  | { readonly type: 'progress'; readonly progress: string }
  | { readonly type: 'loaded' }
  | { readonly type: 'load-failed'; readonly message: string }
  | { readonly type: 'commit' }
  | { readonly type: 'commit-failed'; readonly message: string }
  | { readonly type: 'committed' }
  | { readonly type: 'cancel' };

export const importPreviewTable: MachineTable<ImportPreviewPhase, ImportPreviewEvent> = {
  id: 'import.preview',
  initial: 'loading',
  final: ['closed'],
  on: {
    loading: { progress: ['loading'], loaded: ['ready'], 'load-failed': ['failed'], cancel: ['closed'] },
    failed: { cancel: ['closed'] },
    ready: { commit: ['committing'], cancel: ['closed'] },
    committing: { 'commit-failed': ['commit-failed'], committed: ['closed'] },
    'commit-failed': { commit: ['committing'], cancel: ['closed'] },
    closed: {},
  },
};

export function stepImportPreview(state: ImportPreviewPhase, event: ImportPreviewEvent): ImportPreviewPhase {
  switch (event.type) {
    case 'progress': return state.kind === 'loading' ? { kind: 'loading', progress: event.progress } : state;
    case 'loaded': return state.kind === 'loading' ? { kind: 'ready' } : state;
    case 'load-failed': return state.kind === 'loading' ? { kind: 'failed', message: event.message } : state;
    case 'commit': return state.kind === 'ready' || state.kind === 'commit-failed' ? { kind: 'committing' } : state;
    case 'commit-failed': return state.kind === 'committing' ? { kind: 'commit-failed', message: event.message } : state;
    case 'committed': return state.kind === 'committing' ? { kind: 'closed', committed: true } : state;
    case 'cancel': return state.kind === 'loading' || state.kind === 'failed' || state.kind === 'ready' || state.kind === 'commit-failed' ? { kind: 'closed', committed: false } : state;
    default: return assertNever(event);
  }
}

export const importPreviewMachine = defineMachine(importPreviewTable, stepImportPreview);
