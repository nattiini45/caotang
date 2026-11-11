// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@lingui/react';
import { i18n } from '@lingui/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDocument, createEmptyManifest, createProjectState } from '@caotang/store';
import { EditorPane, type EditorPaneProps } from '../src/components/EditorPane.js';

const seam = vi.hoisted(() => ({ mount: vi.fn(), report: vi.fn() }));
vi.mock('@caotang/editor/tiptap', async (original) => ({ ...await original<object>(), createTiptapEditorApi: () => ({ mount: seam.mount }) }));
vi.mock('../src/components/shared.js', () => ({ useSession: () => undefined, useReport: () => seam.report, wordsLabel: () => '', EmptyState: () => null }));
vi.mock('../src/components/narrow.js', () => ({ useNarrow: () => false }));
vi.mock('../src/components/TargetQuickSet.js', () => ({ TargetQuickSet: () => null }));
vi.mock('../src/media/picture-hooks.js', () => ({ usePictureImporter: () => ({}), IMPORT_SOURCE: {}, PASTE_SOURCE: {} }));
vi.mock('../src/app/history-store.js', () => ({ loadHistoryJournal: async () => null, createHistorySaver: () => ({ onChange: () => undefined, dispose: async () => undefined }) }));
vi.mock('../src/app/review-notice.js', () => ({ takePending: async () => null }));
vi.mock('../src/app/app-db.js', () => ({ activeAppDb: () => null }));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const docId = 'n_REBASE0001';
let root: Root;
let host: HTMLDivElement;
let props: EditorPaneProps;
let pending: ReturnType<typeof deferred>[];
let revision: ReturnType<typeof vi.fn>;
let body: string;
let own: { body: string; revision: number } | null;

async function move(text: string, at: number) {
  props.session.state.documents.set(docId, { id: docId, body: text, revision: at });
  await act(async () => { root.render(<I18nProvider i18n={i18n}><EditorPane {...props} /></I18nProvider>); });
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  pending = [];
  revision = vi.fn();
  own = null;
  body = 'Opened.';
  seam.report.mockClear();
  seam.mount.mockResolvedValue({
    ghost: {}, getContent: () => body, setRevision: revision,
    setContent: () => { const load = deferred(); pending.push(load); return load.promise; },
    loadResult: () => ({ groups: [], dialect: [] }), setLabels: () => undefined,
    hasUnsavedEdits: () => false, getSelection: () => null, destroy: () => undefined,
  });
  const state = createProjectState(createEmptyManifest('Rebase race', new Date(), { locale: 'en-US' }));
  addDocument(state, { id: docId, parentId: 'manuscript', title: 'Scene', body, now: new Date() });
  props = {
    session: { state, projectId: 'rebase', lastWritten: () => own, autosave: { status: () => ({ state: 'clean', dirty: false, lastError: null, revisionConflict: false }) } } as unknown as EditorPaneProps['session'],
    docId, visible: true, focusDocId: null, onFocusHandled: () => undefined,
    onNewDocument: () => undefined, agent: null, target: {} as EditorPaneProps['target'], onSetTarget: () => undefined,
  };
  await act(async () => { root.render(<I18nProvider i18n={i18n}><EditorPane {...props} /></I18nProvider>); });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('the prose editor store landing', () => {
  it('never acknowledges an older landing after the newer revision', async () => {
    await move('Undo.', 2);
    await move('Agent apply.', 3);
    expect(pending).toHaveLength(2);
    await act(async () => pending[1]!.resolve());
    await act(async () => pending[0]!.resolve());
    expect(revision.mock.calls).toEqual([[3]]);
  });

  it('does not report the failure of an obsolete replacement', async () => {
    await move('Undo.', 2);
    await move('Agent apply.', 3);
    await act(async () => pending[1]!.resolve());
    await act(async () => pending[0]!.reject(new Error('Obsolete parse')));
    expect(seam.report).not.toHaveBeenCalled();
  });

  it('invalidates a replacement when a newer own write is acknowledged', async () => {
    await move('Undo.', 2);
    own = { body: 'My words.', revision: 3 };
    body = own.body;
    await move(own.body, own.revision);
    await act(async () => pending[0]!.resolve());
    expect(revision.mock.calls).toEqual([[3]]);
  });

  it('ignores a replacement failure after teardown', async () => {
    await move('Undo.', 2);
    await act(async () => root.render(null));
    await act(async () => pending[0]!.reject(new Error('Closed editor')));
    expect(seam.report).not.toHaveBeenCalled();
  });

  it('publishes readiness only after the current replacement succeeds', async () => {
    expect(host.querySelector('article')?.dataset.editorState).toBe('ready');
    await move('Undo.', 2);
    expect(host.querySelector('article')?.dataset.editorState).toBe('loading');
    await act(async () => pending[0]!.resolve());
    expect(host.querySelector('article')?.dataset.editorState).toBe('ready');
  });

  it('reports a current failure without marking the replacement ready', async () => {
    await move('Undo.', 2);
    await act(async () => pending[0]!.reject(new Error('Current parse')));
    expect(seam.report).toHaveBeenCalledExactlyOnceWith({ text: 'The text could not be brought up to date: Current parse', tone: 'error' });
    expect(host.querySelector('article')?.dataset.editorState).toBe('failed');
    expect(revision).not.toHaveBeenCalled();
  });
});
