// @vitest-environment jsdom
/**
 * The live Tiptap adapter (`src/tiptap/adapter.ts`) against a real DOM: the view it
 * mounts, the two lanes of undo, the selection it reports, the anchor it captures and
 * the autosave contract it keeps.
 *
 * ## What these tests are measured against
 *
 * Every expectation about what a body *is* — its diagnostics, its offsets, its bytes
 * — is taken from the headless modules (`parseWithDiagnostics`, `serialize`,
 * `groupLossWarnings`) or from the body string the test wrote, never from a second
 * copy of the adapter's own logic. The adapter's job is to put those same answers on
 * a live view, so that is what is asserted.
 *
 * ## The controls, and the direction each one can fail
 *
 * - **Lanes.** The closeHistory half of §7 rule 1 is asserted by running the same
 *   sequence twice, once through the adapter's agent path and once through a raw
 *   `addToHistory: false` transaction with no `closeHistory`. The raw run must take
 *   the user's keystroke *and* the one before it in a single undo, and the adapter's
 *   run must not. A test that only checked the adapter's run could pass with the
 *   closeHistory line deleted, if the library grouped differently in that build.
 * - **Autosave.** The scheduler is the store's own `createAutosave`, driven by a spy
 *   writer on fake timers, so every write is counted rather than inferred: a flush that
 *   is not sent is a count of zero, and a second write while one is in flight is a count
 *   of two.
 * - **Selection.** Every case reads its expected offset out of the body string with
 *   `indexOf`, so a wrong projection cannot be explained away by a wrong expectation
 *   computed from the same projection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createAutosave, domFlushSignals, RevisionConflictError } from '@caotang/store';
import type { Autosave, DocumentWriter } from '@caotang/store';
import type { EditorApi, EditorInstance } from '../src/index.js';
import { groupLossWarnings, parseWithDiagnostics, resolveAnchor } from '../src/index.js';
import { createTiptapEditorApi, StaleMountError, UnsavedEditsError } from '../src/tiptap/index.js';
import {
  focusDom,
  ghostDom,
  mountInto,
  pressUndo,
  selectDom,
  textNodeWith,
  tiptapOf,
} from './tiptap-harness.js';

/** Exact-class: every construct is spelled the way §5's dialect writes it, so it round-trips. */
const PLAIN = '# Title\n\nSome _emphasis_ and **strong** text.\n';

/** Foreign spelling and a degrade construct: a `*` bullet (a dialect notice) and a table (a loss). */
const FOREIGN_AND_LOSS = '* a star bullet\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';

/** A realistic scene: about three thousand words in forty paragraphs, the size §10's per-scene documents reach. */
const SCENE =
  Array.from(
    { length: 40 },
    (_, i) =>
      `Paragraph ${i}. The rain kept falling on the harbour while the clerk counted the crates twice, ` +
      'and nobody in the office believed the manifest until the ship had already gone. ' +
      'Each crate carried a name, a weight and a date, and the names did not match the weights. '.repeat(2),
  ).join('\n\n') + '\n';

/** The store's autosave is a real scheduler; a test disposes every one it made. */
const schedulers: Autosave[] = [];
afterEach(() => {
  for (const autosave of schedulers.splice(0)) autosave.dispose();
});

/**
 * A store scheduler over a spy writer that accepts every write, moving the revision on by
 * one as the store does. Its lifecycle signals are the browser's, as the app wires them.
 */
const scheduler = (write: Mock<DocumentWriter> = acceptingWriter()): { autosave: Autosave; write: Mock<DocumentWriter> } => {
  const autosave = createAutosave({
    projectId: 'project-1',
    source: 'write',
    write,
    signals: domFlushSignals({ visibility: document, page: window }),
  });
  schedulers.push(autosave);
  return { autosave, write };
};

const acceptingWriter = (): Mock<DocumentWriter> =>
  vi.fn<DocumentWriter>(async (request) => ({ revision: request.expectedRevision + 1, changed: true }));

/** Lets the store's promise continuations run, which fake timers do not do on their own. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('mounting', () => {
  it('mounts a ProseMirror view in the host, and the document reads back exactly as it was given', async () => {
    const { host, instance } = await mountInto(PLAIN);
    expect(focusDom(host).getAttribute('role')).toBe('textbox');
    expect(instance.getContent()).toBe(PLAIN);
  });

  it('an empty body mounts as an empty document and reads back as the empty body', async () => {
    const { instance } = await mountInto('');
    expect(instance.getContent()).toBe('');
  });

  it('the focus document ships with spellcheck off, at the size of a realistic scene (D9)', async () => {
    const { host } = await mountInto(SCENE);
    expect(focusDom(host).getAttribute('spellcheck')).toBe('false');
  });

  it('spellcheck is the app’s to turn on, and turning it on reaches the view', async () => {
    const { host } = await mountInto(SCENE, { spellcheck: true });
    expect(focusDom(host).getAttribute('spellcheck')).toBe('true');
  });

  it('rejects a host that is not an element, as a programmer error', async () => {
    await expect(
      createTiptapEditorApi().mount(null as unknown as HTMLElement, { docId: 'd', initialBody: '' }),
    ).rejects.toThrow(TypeError);
  });

  it('refuses an autosave without the revision the body was loaded at, because the store cannot base a write on nothing', async () => {
    const { autosave } = scheduler();
    await expect(
      createTiptapEditorApi().mount(document.createElement('div'), {
        docId: 'doc-under-test',
        initialBody: 'Hello.\n',
        autosave,
      }),
    ).rejects.toThrow(/revision/);
  });

  it('readOnly mounts a view the user cannot edit, and the agent path can still change it', async () => {
    const { host, instance } = await mountInto(PLAIN, { readOnly: true });
    expect(focusDom(host).getAttribute('contenteditable')).toBe('false');
    await instance.setContent('Changed.\n', { historyExcluded: true });
    expect(instance.getContent()).toBe('Changed.\n');
  });

  it('focus() moves focus into the focus document, and never into the ghost', async () => {
    const { host, instance } = await mountInto(PLAIN);
    instance.ghost.append('Streamed.');
    instance.focus();
    expect(document.activeElement).toBe(focusDom(host));
  });

  it('the adapter satisfies the seam’s EditorApi and EditorInstance by assignment', async () => {
    const seamApi: EditorApi = createTiptapEditorApi();
    const { instance } = await mountInto(PLAIN);
    const seamInstance: EditorInstance = instance;
    expect(typeof seamApi.mount).toBe('function');
    expect(seamInstance.getContent()).toBe(PLAIN);
  });
});

describe('load diagnostics', () => {
  it('reports what the headless parse reports, grouped as the banner needs it', async () => {
    const headless = await parseWithDiagnostics(FOREIGN_AND_LOSS);
    // Control: the fixture must actually carry both kinds, or the equalities below are vacuous.
    expect(headless.warnings.length).toBeGreaterThan(0);
    expect(headless.dialect.length).toBeGreaterThan(0);
    const onLoadDiagnostics = vi.fn();
    const { instance } = await mountInto(FOREIGN_AND_LOSS, { onLoadDiagnostics });
    const result = instance.loadResult();
    expect(result.warnings).toEqual(headless.warnings);
    expect(result.dialect).toEqual(headless.dialect);
    expect(result.groups).toEqual(groupLossWarnings(headless.warnings));
    expect(onLoadDiagnostics).toHaveBeenCalledWith({ warnings: headless.warnings, dialect: headless.dialect });
  });

  it('a clean body reports nothing, so the banner has nothing to draw', async () => {
    const { instance } = await mountInto(PLAIN);
    expect(instance.loadResult()).toEqual({ warnings: [], dialect: [], groups: [] });
  });

  it('setContent refreshes the diagnostics, and an older load that finishes late does not overwrite a newer one', async () => {
    const { instance } = await mountInto(PLAIN);
    const older = instance.setContent(FOREIGN_AND_LOSS, { historyExcluded: true });
    const newer = instance.setContent(PLAIN, { historyExcluded: true });
    await Promise.all([older, newer]);
    expect(instance.getContent()).toBe(PLAIN);
    expect(instance.loadResult().warnings).toEqual([]);
  });

  it('a load that carries a loss refreshes the diagnostics it hands the banner', async () => {
    const onLoadDiagnostics = vi.fn();
    const { instance } = await mountInto(PLAIN, { onLoadDiagnostics });
    await instance.setContent(FOREIGN_AND_LOSS, { historyExcluded: true });
    expect(instance.loadResult().warnings.length).toBeGreaterThan(0);
    expect(onLoadDiagnostics).toHaveBeenLastCalledWith(
      expect.objectContaining({ warnings: instance.loadResult().warnings }),
    );
  });
});

describe('the two lanes of undo (§7)', () => {
  beforeEach(() => {
    // PM history groups edits by `Date.now()`, so a frozen clock makes the grouping
    // the same on every machine. Nothing in these tests advances time.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a user edit is reverted by the user’s undo', async () => {
    const { instance } = await mountInto('Hello.\n');
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    expect(instance.getContent()).toBe('Mine Hello.\n');
    expect(instance.undo()).toBe(true);
    expect(instance.getContent()).toBe('Hello.\n');
  });

  it('an agent apply is not reverted by the user’s undo, and the user’s edit after it is reverted alone', async () => {
    const { instance } = await mountInto('Hello.\n');
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('A ');
    instance.replaceRange({ from: 7, to: 8 }, '!', { historyExcluded: true });
    expect(instance.getContent()).toBe('A Hello!\n');
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('B ');
    expect(instance.getContent()).toBe('B A Hello!\n');

    expect(instance.undo()).toBe(true);
    expect(instance.getContent()).toBe('A Hello!\n');
    expect(instance.undo()).toBe(true);
    expect(instance.getContent()).toBe('Hello!\n');
    // The agent’s `!` never entered the user’s stack, so there is nothing left to undo.
    expect(instance.undo()).toBe(false);
    expect(instance.getContent()).toBe('Hello!\n');
  });

  it('an agent edit next to the user’s text does not empty the user’s undo, and the agent’s text survives it', async () => {
    // Body offset 5 is the insertion point just after the user's `Mine `: an agent edit that
    // only touches that point cannot reach the user's inverse, so the history stays.
    const { instance } = await mountInto('Hello.\n');
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    instance.replaceRange({ from: 5, to: 5 }, '!', { historyExcluded: true });
    expect(instance.getContent()).toBe('Mine !Hello.\n');
    expect(instance.undo()).toBe(true);
    expect(instance.getContent()).toBe('!Hello.\n');
  });

  it('an agent apply over text the user typed empties the user’s undo, so Ctrl+Z cannot remove the agent’s text (§7 rule 1)', async () => {
    // The measured failure: prosemirror-history rebases the user's inverse over the agent's
    // replacement, so the undo deleted `Ours `, and that deletion is a user edit to autosave.
    const { instance } = await mountInto('Hello.\n');
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    instance.replaceRange({ from: 0, to: 5 }, 'Ours ', { historyExcluded: true });
    expect(instance.getContent()).toBe('Ours Hello.\n');
    expect(instance.undo()).toBe(false);
    expect(instance.getContent()).toBe('Ours Hello.\n');
  });

  it('an agent edit inside the user’s typed text empties the undo as well, and the typing it removes is not restored', async () => {
    const { instance } = await mountInto('Hello.\n');
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    // Body offset 2 is between `Mi` and `ne`, inside the typed text.
    instance.replaceRange({ from: 2, to: 2 }, 'X', { historyExcluded: true });
    expect(instance.getContent()).toBe('MiXne Hello.\n');
    expect(instance.undo()).toBe(false);
    expect(instance.getContent()).toBe('MiXne Hello.\n');
  });

  it('Ctrl+Z reaches the same undo through the keymap, and leaves an agent apply in place', async () => {
    const { host, instance } = await mountInto('Hello.\n');
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('A ');
    instance.replaceRange({ from: 7, to: 8 }, '!', { historyExcluded: true });
    pressUndo(host);
    expect(instance.getContent()).toBe('Hello!\n');
  });

  it('a restore is not reverted by the user’s undo', async () => {
    // A restore is the one replacement that discards unsaved edits, and it says so (§7 rule 3).
    const { instance } = await mountInto('Before.\n');
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    await instance.setContent('Restored.\n', { historyExcluded: true, discardUnsaved: true });
    instance.undo();
    expect(instance.getContent()).toBe('Restored.\n');
  });

  it('control: a raw addToHistory:false transaction, with no closeHistory, lets one undo take the user’s next keystroke too', async () => {
    // The measured failure §7 rule 1 names: without `closeHistory` the excluded step
    // leaves the user's event open, so the keystroke after it is appended to the same
    // event and one undo reverts both. The adapter must not behave this way (above).
    const { host, instance } = await mountInto('Hello.\n');
    const editor = tiptapOf(focusDom(host));
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('A ');
    const dot = editor.state.doc.textContent.indexOf('.') + 1;
    editor.view.dispatch(editor.state.tr.insertText('!', dot, dot + 1).setMeta('addToHistory', false));
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('B ');
    expect(instance.getContent()).toBe('B A Hello!\n');
    instance.undo();
    expect(instance.getContent()).toBe('Hello!\n');
  });
});

describe('an agent apply does not replace the user’s unsaved keystrokes (§8, §9)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses the replacement with a typed conflict, and the keystroke and the ghost both survive', async () => {
    const { autosave, write } = scheduler();
    const { host, instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    instance.ghost.append('Streamed.');

    await expect(instance.setContent('Agent.\n', { historyExcluded: true })).rejects.toBeInstanceOf(UnsavedEditsError);
    expect(instance.getContent()).toBe('Mine Hello.\n');
    expect(instance.ghost.text()).toBe('Streamed.');
    expect(ghostDom(host).textContent).toBe('Streamed.');
    expect(instance.hasUnsavedEdits()).toBe(true);

    // The keystroke is not lost: the store is told of it and writes it on the debounce.
    vi.advanceTimersByTime(800);
    expect(write).toHaveBeenCalledWith({
      projectId: 'project-1',
      docId: 'doc-under-test',
      body: 'Mine Hello.\n',
      expectedRevision: 4,
    });
  });

  it('accepts the apply once the keystrokes are stored, because nothing is left to replace', async () => {
    const { autosave } = scheduler();
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    vi.advanceTimersByTime(800);
    await settle();
    expect(instance.hasUnsavedEdits()).toBe(false);
    await instance.setContent('Agent.\n', { historyExcluded: true });
    expect(instance.getContent()).toBe('Agent.\n');
  });

  it('a restore that discards unsaved edits through a store also discards them in the store', async () => {
    // The restore rebases the store onto the body it puts in the editor (`reseat`), so the keystroke
    // it replaced is not written after the debounce, and nothing is left unsaved.
    const { autosave, write } = scheduler();
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    await instance.setContent('Restored.\n', { historyExcluded: true, discardUnsaved: true });
    vi.advanceTimersByTime(800);
    await settle();
    expect(write.mock.calls.some(([request]) => request.body === 'Mine Hello.\n')).toBe(false);
    expect(instance.hasUnsavedEdits()).toBe(false);
    await expect(instance.setContent('Agent.\n', { historyExcluded: true })).resolves.toBeUndefined();
  });

  it('an agent apply that names the revision the store holds moves the store’s base with the body, so the next edit is written against it (§9)', async () => {
    // The agent’s write has put the store on revision 5. The store below conflicts on any other revision, as the
    // real one does, so a base left at the mount’s 4 would conflict here rather than being written.
    let stored = 4;
    const write = vi.fn<DocumentWriter>(async (request) => {
      if (request.expectedRevision !== stored) throw new RevisionConflictError(request.docId, request.expectedRevision, stored);
      stored += 1;
      return { revision: stored, changed: true };
    });
    const { autosave } = scheduler(write);
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    stored = 5;

    await instance.setContent('Agent.\n', { historyExcluded: true, revision: 5 });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    vi.advanceTimersByTime(800);
    await settle();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ body: 'Mine Agent.\n', expectedRevision: 5 }));
    expect(stored).toBe(6);
    expect(instance.hasUnsavedEdits()).toBe(false);
  });

  it('an agent apply that names no revision keeps the store’s base until setRevision reports it, as the desktop app does', async () => {
    let stored = 4;
    const write = vi.fn<DocumentWriter>(async (request) => {
      if (request.expectedRevision !== stored) throw new RevisionConflictError(request.docId, request.expectedRevision, stored);
      stored += 1;
      return { revision: stored, changed: true };
    });
    const { autosave } = scheduler(write);
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    stored = 5;

    await instance.setContent('Agent.\n', { historyExcluded: true });
    instance.setRevision(5);
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    vi.advanceTimersByTime(800);
    await settle();

    expect(write).toHaveBeenCalledWith(expect.objectContaining({ body: 'Mine Agent.\n', expectedRevision: 5 }));
    expect(stored).toBe(6);
  });

  it('a restore that lands while a write is in flight waits for it, and the store settles at that write’s revision', async () => {
    // The write in flight carries the keystroke, so the store moves to revision 5 with it in. The restore
    // replaces the keystroke in the editor, and the store is rebased onto the restored body at the revision
    // that write settled on: nothing is written again, and the next edit is based on 5.
    let release!: (result: { revision: number; changed: boolean }) => void;
    const write = vi.fn<DocumentWriter>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { autosave } = scheduler(write);
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    vi.advanceTimersByTime(800);
    expect(write).toHaveBeenCalledTimes(1);
    // A keystroke typed while that write runs is unsaved, and the restore discards it too.
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Y ');
    expect(instance.hasUnsavedEdits()).toBe(true);

    const restore = instance.setContent('Restored.\n', { historyExcluded: true, discardUnsaved: true });
    await settle();
    expect(write).toHaveBeenCalledTimes(1);
    release({ revision: 5, changed: true });
    await restore;

    expect(instance.getContent()).toBe('Restored.\n');
    expect(instance.hasUnsavedEdits()).toBe(false);
    // The keystroke's window runs out after the restore, and writes nothing: the restore discarded it.
    vi.advanceTimersByTime(800);
    await settle();
    expect(write).toHaveBeenCalledTimes(1);

    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Z ');
    vi.advanceTimersByTime(800);
    await settle();
    expect(write).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'Z Restored.\n', expectedRevision: 5 }));
  });

  it('a plain agent apply rebases the store onto the body it shows, so keystrokes that return to that body write nothing', async () => {
    const { autosave, write } = scheduler();
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    await instance.setContent('Agent.\n', { historyExcluded: true });

    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('X ');
    instance.undo();
    vi.advanceTimersByTime(800);
    await settle();

    // The store already holds `Agent.`, so the body the user returns to is not a change to store.
    expect(instance.getContent()).toBe('Agent.\n');
    expect(write).not.toHaveBeenCalled();
  });

  it('without a store the editor keeps its own flag, and a replacement with discardUnsaved clears it', async () => {
    const { instance } = await mountInto('Hello.\n');
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    await expect(instance.setContent('Agent.\n', { historyExcluded: true })).rejects.toBeInstanceOf(UnsavedEditsError);
    await instance.setContent('Restored.\n', { historyExcluded: true, discardUnsaved: true });
    expect(instance.getContent()).toBe('Restored.\n');
    expect(instance.hasUnsavedEdits()).toBe(false);
  });
});

describe('the unsaved state is a status, not one flag (§9)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a keystroke the store has not written yet is pending, with no error, and is clean once written', async () => {
    const { autosave } = scheduler();
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    expect(instance.saveStatus()).toEqual({ state: 'pending', dirty: true, lastError: null });
    vi.advanceTimersByTime(800);
    await settle();
    expect(instance.saveStatus()).toEqual({ state: 'clean', dirty: false, lastError: null });
  });

  it('a failed write is an error with its cause, and the edit stays unsaved (the indicator’s case)', async () => {
    const cause = new Error('disk full');
    const write = vi.fn<DocumentWriter>().mockRejectedValue(cause);
    const { autosave } = scheduler(write);
    const onSaveStatusChange = vi.fn();
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave, onSaveStatusChange });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    vi.advanceTimersByTime(800);
    await settle();
    expect(instance.saveStatus()).toEqual({ state: 'error', dirty: true, lastError: cause });
    expect(onSaveStatusChange).toHaveBeenLastCalledWith({ state: 'error', dirty: true, lastError: cause });
    expect(instance.hasUnsavedEdits()).toBe(true);
  });

  it('a revision conflict is reported as a conflict, and the keystrokes are kept for the writer', async () => {
    const conflict = new RevisionConflictError('doc-under-test', 4, 5);
    const write = vi.fn<DocumentWriter>().mockRejectedValue(conflict);
    const { autosave } = scheduler(write);
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    vi.advanceTimersByTime(800);
    await settle();
    const status = instance.saveStatus();
    expect(status.state).toBe('error');
    expect(status.lastError).toBeInstanceOf(RevisionConflictError);
    expect(instance.getContent()).toBe('Mine Hello.\n');
    expect(instance.hasUnsavedEdits()).toBe(true);
  });

  it('reports this document’s status through onSaveStatusChange, and not another document’s, until the editor is destroyed', async () => {
    const { autosave } = scheduler();
    const onSaveStatusChange = vi.fn();
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave, onSaveStatusChange });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    expect(onSaveStatusChange).toHaveBeenLastCalledWith({ state: 'pending', dirty: true, lastError: null });

    const seen = onSaveStatusChange.mock.calls.length;
    autosave.open('other-doc', { body: 'Other.\n', revision: 1 });
    autosave.noteEdit('other-doc', 'Other, edited.\n');
    expect(onSaveStatusChange.mock.calls.length).toBe(seen);

    // The pending edit is flushed by the teardown, and that write's own status changes are not reported
    // to a torn-down editor either: the listener is removed before the flush starts.
    const beforeDestroy = onSaveStatusChange.mock.calls.length;
    instance.destroy();
    expect(onSaveStatusChange.mock.calls.length).toBe(beforeDestroy);
    autosave.noteEdit('doc-under-test', 'Later.\n');
    expect(onSaveStatusChange.mock.calls.length).toBe(beforeDestroy);
  });

  it('without a store the status is the editor’s own flag, and a replacement that discards the edit clears it', async () => {
    const onSaveStatusChange = vi.fn();
    const { instance } = await mountInto('Hello.\n', { onSaveStatusChange });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    expect(instance.saveStatus()).toEqual({ state: 'pending', dirty: true, lastError: null });
    expect(onSaveStatusChange).toHaveBeenLastCalledWith({ state: 'pending', dirty: true, lastError: null });
    await instance.setContent('Restored.\n', { historyExcluded: true, discardUnsaved: true });
    expect(instance.saveStatus()).toEqual({ state: 'clean', dirty: false, lastError: null });
  });
});

describe('a mount does not show a body the store has moved past', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('after a failed write, a remount shows the keystroke its flush stores, at the revision that flush produced', async () => {
    // The measured failure: the remount took the stored body, and the next keystroke replaced the
    // store's pending body with the stored one, so `Mine ` was lost with no error. Now the remount's
    // own flush stores `Mine ` and the editor shows that body, rather than refusing the mount.
    const write = vi
      .fn<DocumentWriter>()
      .mockRejectedValueOnce(new Error('disk full')) // the debounce's write
      .mockRejectedValueOnce(new Error('disk full')) // the destroy's flush
      .mockImplementation(async (request) => ({ revision: request.expectedRevision + 1, changed: true }));
    const { autosave } = scheduler(write);
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    vi.advanceTimersByTime(800);
    await settle();
    instance.destroy();
    await settle();

    const remount = await createTiptapEditorApi().mount(document.createElement('div'), {
      docId: 'doc-under-test',
      initialBody: 'Hello.\n',
      revision: 4,
      autosave,
    });
    // The remount's flush stored the keystroke, so the store holds it at the next revision, and the editor shows it.
    expect(write).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'Mine Hello.\n', expectedRevision: 4 }));
    expect(autosave.status('doc-under-test')).toMatchObject({ dirty: false, revision: 5 });
    expect(remount.getContent()).toBe('Mine Hello.\n');
    remount.destroy();
  });

  it('a remount over an unsaved keystroke that still cannot be written shows it, and keeps the failure visible', async () => {
    // Every write fails, so the keystroke stays pending. Refusing the mount here would hide the one
    // thing the writer still has to save; the mount shows it, and the indicator still reports the error.
    const cause = new Error('disk full');
    const write = vi.fn<DocumentWriter>().mockRejectedValue(cause);
    const { autosave } = scheduler(write);
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    vi.advanceTimersByTime(800);
    await settle();
    instance.destroy();
    await settle();

    const remount = await createTiptapEditorApi().mount(document.createElement('div'), {
      docId: 'doc-under-test',
      initialBody: 'Hello.\n',
      revision: 4,
      autosave,
    });

    expect(remount.getContent()).toBe('Mine Hello.\n');
    expect(autosave.pendingBodyOf('doc-under-test')).toBe('Mine Hello.\n');
    expect(remount.saveStatus()).toEqual({ state: 'error', dirty: true, lastError: cause });
    remount.destroy();
  });

  it('a remount over the store’s own state keeps both keystrokes, and the next write carries both', async () => {
    const write = vi
      .fn<DocumentWriter>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementation(async (request) => ({ revision: request.expectedRevision + 1, changed: true }));
    const { autosave } = scheduler(write);
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    vi.advanceTimersByTime(800);
    await settle();
    instance.destroy();
    await settle();

    // The remount mounts over the keystroke the store now holds at revision 5, and types onto it.
    const { instance: remounted } = await mountInto('Hello.\n', { revision: 4, autosave });
    expect(remounted.getContent()).toBe('Mine Hello.\n');
    remounted.revealRange({ from: 0, to: 0 });
    remounted.insertAtSelection('X ');
    vi.advanceTimersByTime(800);
    expect(write).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'X Mine Hello.\n', expectedRevision: 5 }));
  });

  it('a remount during an unacknowledged write waits for it, and is refused when that write moved the store on', async () => {
    let release!: (result: { revision: number; changed: boolean }) => void;
    const write = vi.fn<DocumentWriter>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { autosave } = scheduler(write);
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    vi.advanceTimersByTime(800);
    expect(write).toHaveBeenCalledTimes(1);

    const remount = createTiptapEditorApi().mount(document.createElement('div'), {
      docId: 'doc-under-test',
      initialBody: 'Hello.\n',
      revision: 4,
      autosave,
    });
    release({ revision: 5, changed: true });
    await expect(remount).rejects.toBeInstanceOf(StaleMountError);
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('the view is the source of the selection (§6)', () => {
  it('a DOM selection reports body offsets to onSelectionChange and to getSelection', async () => {
    const onSelectionChange = vi.fn();
    const { host, instance } = await mountInto(PLAIN, { onSelectionChange });
    selectDom(host, textNodeWith(focusDom(host), 'strong'), 0, 6);
    const from = PLAIN.indexOf('strong');
    expect(instance.getSelection()).toEqual({ from, to: from + 6 });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ from, to: from + 6 });
  });

  it('a collapsed DOM selection reports null', async () => {
    const onSelectionChange = vi.fn();
    const { host, instance } = await mountInto(PLAIN, { onSelectionChange });
    selectDom(host, textNodeWith(focusDom(host), 'strong'), 2, 2);
    expect(instance.getSelection()).toBeNull();
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);
  });

  it.each([
    ['emphasis', 'Plain **bold** and _emphasis_ and `code` end.\n'],
    ['bold', 'Plain **bold** and _emphasis_ and `code` end.\n'],
    ['code', 'Plain **bold** and _emphasis_ and `code` end.\n'],
    ['link', 'Plain [link](https://example.test/) end.\n'],
  ])('the run “%s” reports the offsets of its own spelling in the body', async (needle, body) => {
    expect(body.split(needle).length - 1).toBe(1);
    const { host, instance } = await mountInto(body);
    const text = textNodeWith(focusDom(host), needle);
    const at = text.data.indexOf(needle);
    selectDom(host, text, at, at + needle.length);
    const from = body.indexOf(needle);
    expect(instance.getSelection()).toEqual({ from, to: from + needle.length });
    expect(instance.getSelection() && body.slice(from, from + needle.length)).toBe(needle);
  });

  it('a selection after an escape reports the offset the body actually has there', async () => {
    // §5 writes a literal `*` as `\*`, so the body is longer than the text by one character.
    const body = 'Star \\* here and **bold**.\n';
    const { host, instance } = await mountInto(body);
    expect(instance.getContent()).toBe(body);
    const text = textNodeWith(focusDom(host), 'here');
    const at = text.data.indexOf('here');
    selectDom(host, text, at, at + 4);
    const from = body.indexOf('here');
    expect(instance.getSelection()).toEqual({ from, to: from + 4 });
  });
});

describe('captureAnchor (edit-anchors §2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('captures the selection as a TextAnchor, with the exact text, 32 characters of context each side, and the revision', async () => {
    const { host, instance } = await mountInto(PLAIN, { revision: 7 });
    selectDom(host, textNodeWith(focusDom(host), 'strong'), 0, 6);
    const from = PLAIN.indexOf('strong');
    const to = from + 6;
    expect(instance.captureAnchor()).toEqual({
      from,
      to,
      exact: 'strong',
      prefix: PLAIN.slice(Math.max(0, from - 32), from),
      suffix: PLAIN.slice(to, Math.min(PLAIN.length, to + 32)),
      capturedRevision: 7,
    });
  });

  it('captures the longest exact text an anchor may carry, and the anchor it captures resolves (edit-anchors §2)', async () => {
    const body = `${'x'.repeat(2100)}\n`;
    const { instance } = await mountInto(body, { revision: 7 });
    instance.revealRange({ from: 0, to: 2000 });
    const anchor = instance.captureAnchor();
    expect(anchor?.exact.length).toBe(2000);
    expect(anchor && resolveAnchor(anchor, body, 7)).toMatchObject({ status: 'ok', method: 'exact' });
  });

  it('returns null for a selection longer than the anchor bound, because such an anchor could never resolve', async () => {
    const body = `${'x'.repeat(2100)}\n`;
    const { instance } = await mountInto(body, { revision: 7 });
    instance.revealRange({ from: 0, to: 2001 });
    expect(instance.getSelection()).toEqual({ from: 0, to: 2001 });
    expect(instance.captureAnchor()).toBeNull();
  });

  it('returns null with no selection', async () => {
    const { host, instance } = await mountInto(PLAIN, { revision: 7 });
    selectDom(host, textNodeWith(focusDom(host), 'strong'), 1, 1);
    expect(instance.captureAnchor()).toBeNull();
  });

  it('returns null without a revision, since it could not say what the anchor was captured from', async () => {
    const { host, instance } = await mountInto(PLAIN);
    selectDom(host, textNodeWith(focusDom(host), 'strong'), 0, 6);
    expect(instance.getSelection()).not.toBeNull();
    expect(instance.captureAnchor()).toBeNull();
  });

  it('carries the revision the editor was last synced to, not the one it was mounted with', async () => {
    const { host, instance } = await mountInto(PLAIN, { revision: 7 });
    instance.setRevision(9);
    selectDom(host, textNodeWith(focusDom(host), 'strong'), 0, 6);
    expect(instance.captureAnchor()?.capturedRevision).toBe(9);
  });

  it('captures nothing while a keystroke is unsaved, because its body is not the body the revision names', async () => {
    // The measured failure: `exact` read the live body, including the keystroke, and was
    // stamped with the revision before it, so the anchor quoted text the store did not hold.
    const { autosave } = scheduler();
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    instance.revealRange({ from: 0, to: 4 });
    expect(instance.getSelection()).toEqual({ from: 0, to: 4 });
    expect(instance.captureAnchor()).toBeNull();

    // Once the write is acknowledged the same selection captures, at the new revision.
    vi.advanceTimersByTime(800);
    await settle();
    expect(instance.captureAnchor()).toEqual(expect.objectContaining({ exact: 'Mine', capturedRevision: 5 }));
  });
});

describe('revealRange', () => {
  it('selects the range, reports it, and asks the view to scroll it into view', async () => {
    const onSelectionChange = vi.fn();
    const { host, instance } = await mountInto(PLAIN, { onSelectionChange });
    const from = PLAIN.indexOf('emphasis');
    const to = from + 'emphasis'.length;
    const flags: boolean[] = [];
    tiptapOf(focusDom(host)).on('transaction', ({ transaction }) => {
      flags.push(transaction.scrolledIntoView);
    });
    instance.revealRange({ from, to });
    expect(instance.getSelection()).toEqual({ from, to });
    expect(onSelectionChange).toHaveBeenLastCalledWith({ from, to });
    expect(flags.at(-1)).toBe(true);
  });
});

describe('autosave (§9): the store’s clock, and the editor forwards to it', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes a user edit once, after the 800 ms debounce, with the body and the revision it was based on', async () => {
    const { autosave, write } = scheduler();
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Hi ');
    vi.advanceTimersByTime(799);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({
      projectId: 'project-1',
      docId: 'doc-under-test',
      body: 'Hi Hello.\n',
      expectedRevision: 4,
    });
    // No new edit, so nothing is re-sent on a later tick, and the store moved to the revision it returned.
    await settle();
    vi.advanceTimersByTime(10_000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(autosave.status('doc-under-test')).toMatchObject({ state: 'clean', dirty: false, revision: 5 });
  });

  it('restarts the debounce on every keystroke, so one write follows the last of a burst', async () => {
    const { autosave, write } = scheduler();
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('A ');
    vi.advanceTimersByTime(500);
    instance.insertAtSelection('B ');
    vi.advanceTimersByTime(500);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('an agent apply schedules no write, because the store already holds it', async () => {
    const { write, autosave } = scheduler();
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.replaceRange({ from: 0, to: 5 }, 'Howdy', { historyExcluded: true });
    vi.advanceTimersByTime(10_000);
    expect(instance.getContent()).toBe('Howdy.\n');
    expect(write).not.toHaveBeenCalled();
  });

  it('an agent apply inside the window does not become the user’s write', async () => {
    // The measured failure: the body belongs to the *write*, so the editor's text is
    // read when the window flushes — and an agent apply that landed inside that window
    // was read as if the user had typed it, and written under the user's revision.
    // The user's text is taken before the agent's change lands, so the write carries
    // the user's text and the revision it was typed against.
    const { autosave, write } = scheduler();
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    // The agent's text lands in the editor while the user's keystroke is still waiting
    // for its window.
    instance.insertAtSelection('Agent ', { historyExcluded: true });
    expect(instance.getContent()).toBe('Mine Agent Hello.\n');

    vi.advanceTimersByTime(800);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({
      projectId: 'project-1',
      docId: 'doc-under-test',
      body: 'Mine Hello.\n',
      expectedRevision: 4,
    });
  });

  it('an undo inside the window is the user’s edit, and it is what the write sends', async () => {
    // The body taken for the agent's apply is the body of *that* edit: an undo is a
    // new edit, and it is what the write sends. The agent's text is not in the user's
    // undo stack (§7 rule 1), so it stays in the document.
    const { autosave, write } = scheduler();
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    instance.insertAtSelection('Agent ', { historyExcluded: true });
    instance.undo();
    expect(instance.getContent()).toBe('Agent Hello.\n');

    vi.advanceTimersByTime(800);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({
      projectId: 'project-1',
      docId: 'doc-under-test',
      body: 'Agent Hello.\n',
      expectedRevision: 4,
    });
  });

  it('a burst of keystrokes is one body, produced once', async () => {
    // The body belongs to the write, so the editor's text is rendered when the write
    // needs it: twelve keystrokes, one rendering. The window is where the work is
    // amortized.
    const { autosave, write } = scheduler();
    let produced = 0;
    const counted: Autosave = {
      ...autosave,
      noteEdit: (docId, body) =>
        autosave.noteEdit(
          docId,
          typeof body === 'function'
            ? () => {
                produced += 1;
                return body();
              }
            : body,
        ),
    };
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave: counted });
    instance.revealRange({ from: 0, to: 0 });
    for (let i = 0; i < 12; i += 1) {
      instance.insertAtSelection('x');
      vi.advanceTimersByTime(50);
    }

    vi.advanceTimersByTime(800);

    expect(produced).toBe(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: 'xxxxxxxxxxxxHello.\n', expectedRevision: 4 }),
    );
  });

  it('a user undo is the user’s edit, and is written as one', async () => {
    const { write, autosave } = scheduler();
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Hi ');
    vi.advanceTimersByTime(800);
    await settle();
    instance.undo();
    vi.advanceTimersByTime(800);
    expect(write).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'Hello.\n', expectedRevision: 5 }));
  });

  it('an edit typed while a write is in flight waits for it, and is written against the revision that write returned', async () => {
    let release!: (result: { revision: number; changed: boolean }) => void;
    const write = vi.fn<DocumentWriter>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { autosave } = scheduler(write);
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Hi ');
    vi.advanceTimersByTime(800);
    expect(write).toHaveBeenCalledTimes(1);

    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Yo ');
    vi.advanceTimersByTime(800);
    expect(write).toHaveBeenCalledTimes(1);

    release({ revision: 5, changed: true });
    await settle();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith({
      projectId: 'project-1',
      docId: 'doc-under-test',
      body: 'Yo Hi Hello.\n',
      expectedRevision: 5,
    });
  });

  it('never sends a second write while one is unacknowledged, even on a page hide or an explicit flush', async () => {
    let release!: (result: { revision: number; changed: boolean }) => void;
    const write = vi.fn<DocumentWriter>(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { autosave } = scheduler(write);
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    vi.advanceTimersByTime(850);
    expect(write).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('pagehide'));
    void instance.flush();
    await settle();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 4 }));

    release({ revision: 5, changed: true });
    await settle();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('a failed write keeps the body, and the next flush sends it again against the same revision', async () => {
    const write = vi
      .fn<DocumentWriter>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementation(async (request) => ({ revision: request.expectedRevision + 1, changed: true }));
    const { autosave } = scheduler(write);
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Hi ');
    vi.advanceTimersByTime(800);
    await settle();
    expect(autosave.status('doc-under-test')).toMatchObject({ state: 'error', dirty: true });
    expect(instance.hasUnsavedEdits()).toBe(true);

    await instance.flush();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: 'Hi Hello.\n', expectedRevision: 4 }),
    );
    expect(instance.hasUnsavedEdits()).toBe(false);
  });

  it('setRevision never re-bases a pending edit: its write stays on the revision it was typed against, so it conflicts rather than overwrites (§9)', async () => {
    // The measured failure: the agent wrote revision 5, setRevision(5) re-labelled the stale
    // `Mine Hello.`, and the flush went out as expectedRevision 5, overwriting the agent.
    const { autosave, write } = scheduler();
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Mine ');
    instance.setRevision(5);
    vi.advanceTimersByTime(800);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls.every(([request]) => request.expectedRevision === 4)).toBe(true);
  });

  it('a page hide sends a pending edit at once, without waiting for the debounce', async () => {
    const { write, autosave } = scheduler();
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Hi ');
    window.dispatchEvent(new Event('pagehide'));
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ body: 'Hi Hello.\n', expectedRevision: 4 }));
  });

  it('a visibility change sends a pending edit through the store’s own lifecycle signal, and a clean document writes nothing', async () => {
    // The store's signal is unconditional (runtime/autosave.ts): it flushes on a change to
    // either state, and a document with nothing pending costs no write. The editor's part is
    // only that the pending body it forwarded is the one the store holds.
    const { write, autosave } = scheduler();
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(write).not.toHaveBeenCalled();
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Hi ');
    const state = vi.spyOn(document, 'visibilityState', 'get');
    state.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ body: 'Hi Hello.\n', expectedRevision: 4 }));
    state.mockRestore();
  });

  it('destroy sends a pending edit rather than dropping it', async () => {
    const { write, autosave } = scheduler();
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Hi ');
    instance.destroy();
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ body: 'Hi Hello.\n', expectedRevision: 4 }));
  });

  it('the editor adds no page listener of its own: the lifecycle flush is the store’s, wired where the store is made', async () => {
    const { autosave } = scheduler();
    const add = vi.spyOn(document, 'addEventListener');
    const { instance } = await mountInto('Hello.\n', { revision: 4, autosave });
    expect(add.mock.calls.map((call) => call[0])).not.toContain('visibilitychange');
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Hi ');
    vi.advanceTimersByTime(10_000);
    expect(instance.getContent()).toBe('Hi Hello.\n');
    add.mockRestore();
  });

  it('without an autosave nothing is written, and the editor still tracks that its edits are unsaved', async () => {
    const { instance } = await mountInto('Hello.\n', { revision: 4 });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Hi ');
    vi.advanceTimersByTime(10_000);
    expect(instance.getContent()).toBe('Hi Hello.\n');
    expect(instance.hasUnsavedEdits()).toBe(true);
    await instance.flush();
    expect(instance.hasUnsavedEdits()).toBe(true);
  });
});

describe('the primitives read their text as body Markdown (§4)', () => {
  it('emphasis inserts as emphasis, and saves in the body dialect rather than as escaped asterisks', async () => {
    const { instance } = await mountInto('Hello.\n');
    instance.replaceRange({ from: 0, to: 5 }, '*Howdy*', { historyExcluded: true });
    expect(instance.getContent()).toBe('_Howdy_.\n');
  });

  it('a space at the end of the text survives the parse, because it separates the text from what follows', async () => {
    // `Hello` (offsets 0..5) becomes `Ours `, and the `.` after it is untouched: `Ours .`.
    // CommonMark would strip the trailing space of a paragraph, which would give `Ours.`.
    const { instance } = await mountInto('Hello.\n');
    instance.replaceRange({ from: 0, to: 5 }, 'Ours ', { historyExcluded: true });
    expect(instance.getContent()).toBe('Ours .\n');
  });

  it('a space at the start of the text survives the parse too', async () => {
    const { instance } = await mountInto('Hello.\n');
    instance.replaceRange({ from: 5, to: 5 }, ' there', { historyExcluded: true });
    expect(instance.getContent()).toBe('Hello there.\n');
  });

  it('a paragraph break in the text inserts a paragraph, and the text after the range joins the last one', async () => {
    const { instance } = await mountInto('Hello.\n');
    instance.replaceRange({ from: 0, to: 0 }, 'Lead.\n\nNew ', { historyExcluded: true });
    expect(instance.getContent()).toBe('Lead.\n\nNew Hello.\n');
  });

  it('a heading inserted into a paragraph joins its text, and the body keeps the paragraph’s place', async () => {
    // One heading is one open block, so its text fills the range and the heading style goes:
    // an inline insertion, not a new block.
    const { instance } = await mountInto('Hello.\n');
    instance.replaceRange({ from: 0, to: 5 }, '## Howdy', { historyExcluded: true });
    expect(instance.getContent()).toBe('Howdy.\n');
  });

  it('a trailing newline in the text ends a paragraph, and is not a character of one', async () => {
    // The measured failure: the newline was kept as text and saved as `&#xA;`.
    const { instance } = await mountInto('');
    instance.replaceRange({ from: 0, to: 0 }, 'Hi\n', { historyExcluded: true });
    expect(instance.getContent()).toBe('Hi\n');
  });

  it('a trailing newline in a replacement over existing text does not reach the saved body as a character', async () => {
    const { instance } = await mountInto('Hello.\n');
    instance.replaceRange({ from: 0, to: 6 }, 'Agent says hi.\n', { historyExcluded: true });
    expect(instance.getContent()).toBe('Agent says hi.\n');
  });

  it('a trailing newline inserted mid-paragraph joins the text around the caret into one paragraph', async () => {
    const { instance } = await mountInto('Hello.\n');
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Yo.\n');
    expect(instance.getContent()).toBe('Yo.Hello.\n');
  });

  it('an empty replacement deletes the range', async () => {
    const { instance } = await mountInto('Hello world.\n');
    instance.replaceRange({ from: 5, to: 11 }, '', { historyExcluded: true });
    expect(instance.getContent()).toBe('Hello.\n');
  });

  it('a replacement at offset 0 neither throws nor adds a block, in every block-first shape', async () => {
    for (const body of ['# Title\n\nSome text.\n', '- one\n- two\n', '> quoted\n\nAfter.\n', '***\n\nSome text.\n']) {
      const { host, instance } = await mountInto(body);
      const editor = tiptapOf(focusDom(host));
      const blocks = editor.state.doc.childCount;
      expect(() => instance.replaceRange({ from: 0, to: 1 }, 'X', { historyExcluded: true })).not.toThrow();
      expect(editor.state.doc.childCount).toBe(blocks);
      expect(instance.getContent()).toContain('X');
      // revealRange at offset 0 selects a text range, not a container or a gap, so getSelection
      // reports it rather than dropping it to null.
      expect(() => instance.revealRange({ from: 0, to: 0 })).not.toThrow();
      expect(editor.state.selection.$from.parent.inlineContent).toBe(true);
    }
  });
});

describe('teardown', () => {
  it('destroy removes the editor from the host, and later calls are harmless', async () => {
    const { host, instance } = await mountInto(PLAIN);
    instance.destroy();
    expect(host.querySelector('.caotang-editor')).toBeNull();
    expect(() => instance.insertAtSelection('x')).not.toThrow();
    expect(() => instance.focus()).not.toThrow();
    expect(instance.undo()).toBe(false);
    expect(instance.getContent()).toBe(PLAIN);
  });

  it('after destroy, getContent answers with the document as it stood, even an edit nothing had read', async () => {
    const { instance } = await mountInto('Hello.\n');
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('Unread ');
    instance.destroy();
    expect(instance.getContent()).toBe('Unread Hello.\n');
  });

  it('onChange fires for every document change, from either lane', async () => {
    const onChange = vi.fn();
    const { instance } = await mountInto('Hello.\n', { onChange });
    instance.revealRange({ from: 0, to: 0 });
    instance.insertAtSelection('A ');
    instance.replaceRange({ from: 0, to: 1 }, 'a', { historyExcluded: true });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('a replace that crosses a paragraph boundary fits the text into the document, and the result is a valid body', async () => {
    // The body is 'One.' / blank / 'Two.', with offsets O0 n1 e2 .3 \n4 \n5 T6 w7 o8 .9. Offsets
    // 2..7 cover 'e.', both newlines and 'T', leaving 'wo.'. ProseMirror's own fitting joins
    // the two paragraphs around the inserted text, which is what replacing a selection
    // across two paragraphs does in any editor.
    const { instance } = await mountInto('One.\n\nTwo.\n');
    instance.replaceRange({ from: 2, to: 7 }, 'X', { historyExcluded: true });
    expect(instance.getContent()).toBe('OnXwo.\n');
  });

  it('wordCount is the store’s count of the body, not a second copy of its rule', async () => {
    const { instance } = await mountInto('Two words.\n\nThree more words here.\n');
    expect(instance.wordCount()).toEqual({ words: 6, chars: instance.getContent().length });
  });
});
