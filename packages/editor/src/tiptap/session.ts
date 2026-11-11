import { assertNever, canMove, defineMachine, type MachineTable } from '@caotang/machine';
import type { Lane } from '../lanes.js';

type UnsavedSource = { readonly kind: 'local'; readonly dirty: boolean } | { readonly kind: 'autosave' };
export type EditorMode = 'ghost' | 'suggestions' | 'unavailable';
interface SessionContext {
  readonly mode: EditorMode;
  readonly source: UnsavedSource;
  readonly token: number;
}
export type EditorSession = SessionContext & (
  | { readonly kind: 'ready' }
  | { readonly kind: 'loading'; readonly lane: Lane }
  | { readonly kind: 'destroyed' }
);
export type EditorSessionEvent =
  | { readonly type: 'load'; readonly lane: Lane }
  | { readonly type: 'settled'; readonly token: number }
  | { readonly type: 'acknowledged' }
  | { readonly type: 'local-edit'; readonly dirty: boolean }
  | { readonly type: 'destroy' };

export const editorSessionTable: MachineTable<EditorSession, EditorSessionEvent> = {
  id: 'editor.session',
  initial: 'ready',
  final: ['destroyed'],
  on: {
    ready: { load: ['loading'], 'local-edit': ['ready'], destroy: ['destroyed'] },
    loading: { load: ['loading'], settled: ['ready', 'loading'], acknowledged: ['ready'], 'local-edit': ['loading'], destroy: ['destroyed'] },
    destroyed: {},
  },
};

export const editorSession = (mode: EditorMode, autosave: boolean): EditorSession => ({
  kind: 'ready', mode, token: 0, source: autosave ? { kind: 'autosave' } : { kind: 'local', dirty: false },
});

export function stepEditorSession(state: EditorSession, event: EditorSessionEvent): EditorSession {
  if (!canMove(editorSessionTable, state.kind, event.type)) return state;
  switch (event.type) {
    case 'load': return { ...state, kind: 'loading', lane: event.lane, token: state.token + 1 };
    case 'settled':
      if (state.kind !== 'loading' || state.token !== event.token) return state;
      return { kind: 'ready', mode: state.mode, source: state.source, token: state.token };
    case 'acknowledged':
      return { kind: 'ready', mode: state.mode, source: state.source, token: state.token + 1 };
    case 'local-edit':
      if (state.source.kind !== 'local' || state.source.dirty === event.dirty) return state;
      return { ...state, source: { kind: 'local', dirty: event.dirty } };
    case 'destroy': return { kind: 'destroyed', mode: state.mode, source: state.source, token: state.token };
    default: return assertNever(event);
  }
}

export const editorSessionMachine = defineMachine(editorSessionTable, stepEditorSession);
