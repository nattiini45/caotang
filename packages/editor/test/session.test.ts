import { describe, expect, it } from 'vitest';
import { checkMachine } from '@caotang/machine/testing';
import { editorSession, editorSessionMachine, stepEditorSession, type EditorSessionEvent } from '../src/tiptap/session.js';

describe('the editor session', () => {
  const ready = editorSession('suggestions', false);
  const loading = stepEditorSession(ready, { type: 'load', lane: 'agent' });
  const destroyed = stepEditorSession(loading, { type: 'destroy' });
  const events: EditorSessionEvent[] = [
    { type: 'load', lane: 'user' }, { type: 'load', lane: 'agent' },
    { type: 'settled', token: 1 }, { type: 'settled', token: 0 },
    { type: 'local-edit', dirty: true }, { type: 'local-edit', dirty: false }, { type: 'acknowledged' }, { type: 'destroy' },
  ];
  it('covers every state and event in its transition table', () => {
    expect(checkMachine(editorSessionMachine, { states: [ready, loading, destroyed, editorSession('ghost', true)], events })).toEqual([]);
  });
  it('keeps a later load authoritative when an earlier completion arrives', () => {
    const newer = stepEditorSession(loading, { type: 'load', lane: 'user' });
    expect(newer).toMatchObject({ kind: 'loading', lane: 'user', token: 2 });
    expect(stepEditorSession(newer, { type: 'settled', token: 1 })).toBe(newer);
    expect(stepEditorSession(newer, { type: 'settled', token: 2 })).toMatchObject({ kind: 'ready', token: 2 });
  });
  it('keeps local unsaved edits across a failed load, without inventing a second autosave flag', () => {
    const dirty = stepEditorSession(loading, { type: 'local-edit', dirty: true });
    expect(stepEditorSession(dirty, { type: 'settled', token: 1 }).source).toEqual({ kind: 'local', dirty: true });
    const stored = editorSession('ghost', true);
    expect(stepEditorSession(stored, { type: 'local-edit', dirty: true })).toBe(stored);
  });
  it('never revives a destroyed session', () => {
    for (const event of events) expect(stepEditorSession(destroyed, event)).toBe(destroyed);
  });

  it('a revision-only acknowledgement supersedes a pending load without changing the unsaved source', () => {
    const next = stepEditorSession(loading, { type: 'acknowledged' });
    expect(next).toMatchObject({ kind: 'ready', token: 2, source: ready.source });
    expect(stepEditorSession(next, { type: 'settled', token: 1 })).toBe(next);
  });
});
