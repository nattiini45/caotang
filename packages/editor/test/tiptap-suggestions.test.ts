// @vitest-environment jsdom
/**
 * Apply-then-review (editor-engine §15): an approved agent edit shown as suggestion marks over the text the store already holds.
 *
 * ## What is measured, and against what
 *
 * Every expectation about text is a body string the test wrote, or the output of the headless `serialize` over a document built
 * from one. The adapter's own projection is never the oracle for itself: "the marked editor saves the accepted text" is compared
 * with the same text parsed and serialized directly. The marks are read out of the DOM the view renders (`ins`, `del`) and out of
 * the live ProseMirror document through the Tiptap editor behind the view.
 *
 * ## The controls
 *
 * - The fallback is driven by a stand-in layer that makes a wrong diff on purpose, so the projection check is seen to refuse it.
 * - The two-lane undo is read off the transaction's own flags, and Ctrl+Z is pressed on the view as a writer would press it.
 */
import type { Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { countBody, createAutosave, domFlushSignals } from '@caotang/store';
import type { Autosave, DocumentWriter } from '@caotang/store';
import { caotangSchema, parseWithDiagnostics, serialize } from '../src/index.js';
import { createReview, diffHunks, loadSuggestionLayer } from '../src/tiptap/suggestions.js';
import type { DiffEngine } from '../src/tiptap/suggestions.js';
import { focusDom, mountInto, pressUndo, tiptapOf } from './tiptap-harness.js';

const BEFORE =
  'The rain kept falling on the harbour.\n\n' +
  'The clerk counted the crates twice, and nobody believed the manifest.\n\n' +
  'The ship had already gone.\n';

/** The second paragraph is reworded; the first and third are untouched. */
const AFTER =
  'The rain kept falling on the harbour.\n\n' +
  'The clerk counted the crates slowly, and nobody trusted the manifest.\n\n' +
  'The ship had already gone.\n';

const schedulers: Autosave[] = [];
afterEach(() => {
  for (const autosave of schedulers.splice(0)) autosave.dispose();
});

const acceptingWriter = (): Mock<DocumentWriter> =>
  vi.fn<DocumentWriter>(async (request) => ({ revision: request.expectedRevision + 1, changed: true }));

const scheduler = (): { autosave: Autosave; write: Mock<DocumentWriter> } => {
  const write = acceptingWriter();
  const autosave = createAutosave({
    projectId: 'project-1',
    source: 'write',
    write,
    signals: domFlushSignals({ visibility: document, page: window }),
  });
  schedulers.push(autosave);
  return { autosave, write };
};

const mountReview = async (body: string, extra: Parameters<typeof mountInto>[1] = {}) =>
  mountInto(body, { agentEditMode: 'suggestions', ...extra });

/** A document with the review marks stripped but every character kept: the "all pending" reading of a marked document. */
const allPending = (doc: PmNode): string => {
  const strip = (json: { marks?: Array<{ type: string }>; content?: unknown[] } & Record<string, unknown>): unknown => ({
    ...json,
    ...(json.marks === undefined ? {} : { marks: json.marks.filter((mark) => !['insertion', 'deletion', 'modification'].includes(mark.type)) }),
    ...(json.content === undefined ? {} : { content: json.content.map((child) => strip(child as never)) }),
  });
  return serialize(caotangSchema.nodeFromJSON(strip(doc.toJSON() as never) as never));
};

const suggestionMarkNames = ['insertion', 'deletion', 'modification'];
const marksIn = (doc: PmNode): Array<{ name: string; id: string; text: string }> => {
  const out: Array<{ name: string; id: string; text: string }> = [];
  doc.descendants((node) => {
    for (const mark of node.marks) {
      if (suggestionMarkNames.includes(mark.type.name)) out.push({ name: mark.type.name, id: String(mark.attrs['id']), text: node.text ?? '' });
    }
    return true;
  });
  return out;
};

const liveDoc = (host: HTMLElement): PmNode => tiptapOf(focusDom(host)).state.doc;

const proseCount = (host: HTMLElement): number => focusDom(host).querySelectorAll('p').length;

const info = (toolCallId = 'call-1', revision = 2) => ({ toolCallId, revision });

describe('the marks an agent edit leaves (§15)', () => {
  it('marks only the words that changed, and leaves the unchanged paragraphs with no mark', async () => {
    const { host, instance } = await mountReview(BEFORE);
    const outcome = await instance.showAgentEdit(AFTER, info());
    expect(outcome.landed).toBe('suggestions');
    const marks = marksIn(liveDoc(host));
    const inserted = marks.filter((mark) => mark.name === 'insertion').map((mark) => mark.text).join('|');
    const deleted = marks.filter((mark) => mark.name === 'deletion').map((mark) => mark.text).join('|');
    expect(deleted).toContain('twice');
    expect(deleted).toContain('believed');
    expect(inserted).toContain('slowly');
    expect(inserted).toContain('trusted');
    // Words that did not change carry nothing.
    for (const kept of ['clerk', 'counted', 'crates', 'manifest', 'rain', 'harbour', 'ship']) {
      expect(marks.map((mark) => mark.text).join(' ')).not.toContain(kept);
    }
    // Block by block: the paragraphs around the reworded one hold no mark at all.
    const paragraphs = [...focusDom(host).querySelectorAll('p')];
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]?.querySelector('ins, del')).toBeNull();
    expect(paragraphs[1]?.querySelector('ins, del')).not.toBeNull();
    expect(paragraphs[2]?.querySelector('ins, del')).toBeNull();
  });

  it('renders the marks as ins and del with classes, and never writes an inline style (the CSP has no unsafe-inline)', async () => {
    const { host, instance } = await mountReview(BEFORE);
    await instance.showAgentEdit(`${AFTER}\nA new last paragraph.\n`, info());
    const root = focusDom(host);
    expect(root.querySelectorAll('ins.suggestion-insertion').length).toBeGreaterThan(0);
    expect(root.querySelectorAll('del.suggestion-deletion').length).toBeGreaterThan(0);
    expect(root.querySelectorAll('[style]')).toHaveLength(0);
  });

  it('shows a whole new paragraph as one insertion, and a removed one as one deletion', async () => {
    const { host, instance } = await mountReview(BEFORE);
    const added = `${BEFORE}\nA new last paragraph.\n`;
    expect((await instance.showAgentEdit(added, info())).landed).toBe('suggestions');
    expect(instance.getContent()).toBe(added);
    expect(instance.review.state().pending).toBe(1);
    await instance.review.acceptAll();
    const removed = 'The rain kept falling on the harbour.\n\nThe ship had already gone.\n';
    expect((await instance.showAgentEdit(removed, info('call-2'))).landed).toBe('suggestions');
    expect(instance.getContent()).toBe(removed);
    expect(marksIn(liveDoc(host)).some((mark) => mark.name === 'deletion')).toBe(true);
  });

  it('makes one suggestion for a run of paragraphs added together, in their order', async () => {
    const { host, instance } = await mountReview(BEFORE);
    const added = `${BEFORE}
One more.

And another.
`;
    expect((await instance.showAgentEdit(added, info())).landed).toBe('suggestions');
    expect(instance.getContent()).toBe(added);
    expect(instance.review.state().pending).toBe(1);
    expect([...focusDom(host).querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'The rain kept falling on the harbour.',
      'The clerk counted the crates twice, and nobody believed the manifest.',
      'The ship had already gone.',
      'One more.',
      'And another.',
    ]);
    expect(instance.review.rejectAll()).toBe(1);
    expect(instance.getContent()).toBe(BEFORE);
  });

  it('writes the agent’s words into an empty scene as one suggestion inside its paragraph', async () => {
    const { host, instance } = await mountReview('');
    expect((await instance.showAgentEdit('The ferry came in.\n', info())).landed).toBe('suggestions');
    expect(instance.getContent()).toBe('The ferry came in.\n');
    expect(instance.review.state().pending).toBe(1);
    expect(focusDom(host).querySelectorAll('p')).toHaveLength(1);
    expect(instance.review.rejectAll()).toBe(1);
    expect(instance.getContent()).toBe('');
  });

  it('marks a change inside a list item without touching the other items', async () => {
    const before = '- apples\n- pears and plums\n- figs\n';
    const after = '- apples\n- pears and cherries\n- figs\n';
    const { host, instance } = await mountReview(before);
    expect((await instance.showAgentEdit(after, info())).landed).toBe('suggestions');
    const items = [...focusDom(host).querySelectorAll('li')];
    expect(items).toHaveLength(3);
    expect(items[0]?.querySelector('ins, del')).toBeNull();
    expect(items[1]?.querySelector('ins, del')).not.toBeNull();
    expect(items[2]?.querySelector('ins, del')).toBeNull();
    expect(instance.getContent()).toBe(after);
  });
});

describe('a block at the end of the document (the library throws on it unpadded)', () => {
  it('rejects a new last paragraph, accepts a deleted one, and projects both', async () => {
    const added = `${BEFORE}\nA new last paragraph.\n`;
    const first = await mountReview(BEFORE);
    await first.instance.showAgentEdit(added, info());
    expect(first.instance.getContent()).toBe(added);
    expect(first.instance.review.rejectAll()).toBe(1);
    expect(first.instance.getContent()).toBe(BEFORE);

    const shorter = 'The rain kept falling on the harbour.\n\nThe clerk counted the crates twice, and nobody believed the manifest.\n';
    const second = await mountReview(BEFORE);
    await second.instance.showAgentEdit(shorter, info());
    expect(second.instance.getContent()).toBe(shorter);
    expect(second.instance.review.acceptAll()).toBe(1);
    expect(second.instance.getContent()).toBe(shorter);
    expect(marksIn(liveDoc(second.host))).toEqual([]);
    expect(proseCount(second.host)).toBe(2);
  });

  it('shows an edit that empties the scene, and brings it back on reject', async () => {
    const { host, instance } = await mountReview(BEFORE);
    expect((await instance.showAgentEdit('', info())).landed).toBe('suggestions');
    expect(instance.getContent()).toBe('');
    expect(instance.review.rejectAll()).toBeGreaterThan(0);
    expect(instance.getContent()).toBe(BEFORE);
    expect(proseCount(host)).toBe(3);
  });
});

describe('what the editor saves while marks are on screen (§15 save path)', () => {
  it('serializing the marked document gives the all-pending text, with no mark syntax', async () => {
    const { host, instance } = await mountReview(BEFORE);
    await instance.showAgentEdit(AFTER, info());
    const pending = allPending(liveDoc(host));
    expect(pending).toContain('twice');
    expect(pending).toContain('slowly');
    expect(pending).toContain('believed');
    expect(pending).toContain('trusted');
    expect(pending).not.toMatch(/<\/?(ins|del)\b|\{\+|\{-|\[\+|\[-/);
  });

  it('serializing the projection gives the all-accepted text, which is what the store holds', async () => {
    const { instance } = await mountReview(BEFORE);
    await instance.showAgentEdit(AFTER, info());
    expect(instance.getContent()).toBe(AFTER);
    expect(instance.getContent()).not.toMatch(/<\/?(ins|del)\b/);
    expect(instance.getContent()).not.toContain('twice');
  });

  it('body() never returns the all-pending text, and counts words over the accepted text', async () => {
    const { host, instance } = await mountReview(BEFORE);
    await instance.showAgentEdit(AFTER, info());
    expect(instance.getContent()).not.toBe(allPending(liveDoc(host)));
    expect(instance.wordCount()).toEqual(countBody(AFTER));
    expect(instance.wordCount().chars).not.toBe(countBody(allPending(liveDoc(host))).chars);
    const accepted = await parseWithDiagnostics(AFTER);
    expect(instance.getContent()).toBe(serialize(accepted.doc));
  });

  it('accept all, then save, stores the same bytes as a mark-free edit', async () => {
    const { autosave, write } = scheduler();
    const { instance } = await mountReview(BEFORE, { autosave, revision: 1 });
    await instance.showAgentEdit(AFTER, info('call-1', 2));
    expect(instance.review.acceptAll()).toBe(2);
    await instance.flush();
    // Accepting changes nothing the store holds, so nothing is written.
    expect(write).not.toHaveBeenCalled();
    expect(instance.getContent()).toBe(serialize((await parseWithDiagnostics(AFTER)).doc));
    expect(instance.review.state().pending).toBe(0);
  });

  it('reject all, then save, stores the bytes of the text before the edit', async () => {
    const { autosave, write } = scheduler();
    const { instance } = await mountReview(BEFORE, { autosave, revision: 1 });
    await instance.showAgentEdit(AFTER, info('call-1', 2));
    expect(instance.review.rejectAll()).toBe(2);
    await instance.flush();
    expect(write).toHaveBeenCalledTimes(1);
    const sent = write.mock.calls[0]?.[0];
    expect(sent?.body).toBe(serialize((await parseWithDiagnostics(BEFORE)).doc));
    expect(sent?.expectedRevision).toBe(2);
  });

  it('a reload with unresolved marks opens on the accepted text, with no marks', async () => {
    const first = await mountReview(BEFORE);
    await first.instance.showAgentEdit(AFTER, info());
    const stored = first.instance.getContent();
    const second = await mountReview(stored);
    expect(second.instance.getContent()).toBe(AFTER);
    expect(marksIn(liveDoc(second.host))).toEqual([]);
    expect(second.instance.review.state().pending).toBe(0);
  });

  it('a review that is open does not change the selection offsets the agent reads, which are the accepted text’s', async () => {
    const { host, instance } = await mountReview(BEFORE);
    await instance.showAgentEdit(AFTER, info());
    const editor: Editor = tiptapOf(focusDom(host));
    let from = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && (node.text ?? '').includes('manifest')) from = pos + (node.text ?? '').indexOf('manifest');
      return true;
    });
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, from + 'manifest'.length)));
    const selection = instance.getSelection();
    expect(selection).not.toBeNull();
    const body = instance.getContent();
    expect(body.slice(selection?.from, selection?.to)).toBe('manifest');
    expect(selection?.from).toBe(body.indexOf('manifest'));
  });

  it('replaceRange names the accepted text’s offsets, whatever the marks in front of it', async () => {
    const { instance } = await mountReview(BEFORE);
    await instance.showAgentEdit(AFTER, info());
    const body = instance.getContent();
    const at = body.indexOf('gone');
    instance.replaceRange({ from: at, to: at + 4 }, 'sailed');
    expect(instance.getContent()).toBe(body.replace('gone', 'sailed'));
  });

  it('revealRange and insertAtSelection name the accepted text’s offsets for text that follows the marks', async () => {
    const { instance } = await mountReview(BEFORE);
    await instance.showAgentEdit(AFTER, info());
    const body = instance.getContent();
    const at = body.indexOf('manifest');
    instance.revealRange({ from: at, to: at + 'manifest'.length });
    expect(instance.getSelection()).toEqual({ from: at, to: at + 'manifest'.length });
    instance.insertAtSelection('!');
    expect(instance.getContent()).toBe(`${body.slice(0, at + 'manifest'.length)}!${body.slice(at + 'manifest'.length)}`);
  });

  it('the undo journal keeps the accepted text as its base and never a mark', async () => {
    const { host, instance } = await mountReview(BEFORE);
    await instance.showAgentEdit(AFTER, info());
    const editor = tiptapOf(focusDom(host));
    editor.view.dispatch(editor.state.tr.insertText('!', editor.state.doc.content.size - 1));
    const journal = instance.historyJournal();
    expect(journal).not.toBeNull();
    expect(journal?.baseBody).toBe(AFTER);
    // The schema signature names the marks, so a journal made without them is never replayed on this schema; its text holds none.
    expect(journal?.schema).toContain('insertion');
    expect(JSON.stringify([journal?.baseBody, journal?.entries])).not.toMatch(/insertion|deletion/);
  });

  it('text the writer types inside a struck-through word is kept, not deleted with it', async () => {
    const { host, instance } = await mountReview(BEFORE);
    await instance.showAgentEdit(AFTER, info());
    const editor = tiptapOf(focusDom(host));
    let inside = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === 'deletion') && (node.text ?? '').includes('twice')) inside = pos + 2;
      return true;
    });
    expect(inside).toBeGreaterThan(0);
    editor.view.dispatch(editor.state.tr.insertText('X', inside));
    expect(instance.getContent()).toContain('X');
  });
});

describe('local ids, and the tool call behind them', () => {
  it('names a mark by editor turn and counter, and groups by the tool call it keeps in its own map', async () => {
    const { host, instance } = await mountReview(BEFORE);
    await instance.showAgentEdit(AFTER, info('call-77'));
    const ids = new Set(marksIn(liveDoc(host)).map((mark) => mark.id));
    expect(ids.size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^1\.\d+$/);
    expect(instance.review.state().byToolCall).toEqual([{ toolCallId: 'call-77', pending: 2 }]);
  });

  it('a tool call id a model chose cannot reach a mark or collide with another call', async () => {
    const { host, instance } = await mountReview(BEFORE);
    const hostile = '1.1:2';
    await instance.showAgentEdit(AFTER, info(hostile));
    for (const mark of marksIn(liveDoc(host))) {
      expect(mark.id).not.toContain(':');
      expect(mark.id).not.toContain(hostile);
    }
    // A call whose id is a prefix of the hostile one, or shaped like a local id, resolves nothing of this turn.
    expect(instance.review.acceptToolCall('1.1')).toBe(0);
    expect(instance.review.acceptToolCall('1')).toBe(0);
    expect(instance.review.acceptToolCall('__proto__')).toBe(0);
    expect(instance.review.state().pending).toBe(2);
    expect(instance.review.rejectToolCall(hostile)).toBe(2);
    expect(instance.review.state().pending).toBe(0);
    expect(instance.getContent()).toBe(BEFORE);
  });

  it('accepts the earlier marks before it tracks a new edit, and the pending count is the new turn’s alone', async () => {
    const { host, instance } = await mountReview(BEFORE);
    await instance.showAgentEdit(AFTER, info('call-1'));
    expect(instance.review.state().pending).toBe(2);
    const later = AFTER.replace('The ship had already gone.', 'The ship had already sailed.');
    await instance.showAgentEdit(later, info('call-2'));
    const state = instance.review.state();
    expect(state.byToolCall).toEqual([{ toolCallId: 'call-2', pending: 1 }]);
    expect(instance.getContent()).toBe(later);
    const turns = new Set(marksIn(liveDoc(host)).map((mark) => mark.id.split('.')[0]));
    expect([...turns]).toEqual(['2']);
    // The earlier paragraph reads as plain accepted text now.
    expect(focusDom(host).querySelectorAll('p')[1]?.querySelector('ins, del')).toBeNull();
  });
});

describe('the review calls', () => {
  it('moves from one suggestion to the next and wraps, and accept and reject act on the one the caret is in', async () => {
    const { instance } = await mountReview(BEFORE);
    await instance.showAgentEdit(AFTER, info());
    expect(instance.review.state().current).toBeNull();
    expect(instance.review.accept()).toBe(0);
    expect(instance.review.next()).toBe(true);
    const first = instance.review.state();
    expect(first.position).toBe(1);
    expect(instance.review.next()).toBe(true);
    expect(instance.review.state().position).toBe(2);
    expect(instance.review.next()).toBe(true);
    expect(instance.review.state().position).toBe(1);
    expect(instance.review.previous()).toBe(true);
    expect(instance.review.state().position).toBe(2);
    // Reject the second suggestion only: its words go back, the first stays marked.
    expect(instance.review.reject()).toBe(1);
    expect(instance.review.state().pending).toBe(1);
    expect(instance.getContent()).toContain('believed');
    expect(instance.getContent()).toContain('slowly');
  });

  it('tells a subscriber when the count changes, and stops when it unsubscribes', async () => {
    const { instance } = await mountReview(BEFORE);
    const heard = vi.fn();
    const stop = instance.review.subscribe(heard);
    await instance.showAgentEdit(AFTER, info());
    expect(heard).toHaveBeenCalled();
    expect(instance.review.state().pending).toBe(2);
    instance.review.acceptAll();
    expect(instance.review.state().pending).toBe(0);
    stop();
    heard.mockClear();
    await instance.showAgentEdit(BEFORE, info('call-2'));
    expect(heard).not.toHaveBeenCalled();
  });
});

describe('the two-lane undo (§7) with marks', () => {
  it('keeps the agent transaction out of the history through the transform', async () => {
    const { host, instance } = await mountReview(BEFORE);
    const editor = tiptapOf(focusDom(host));
    const seen: Array<{ addToHistory: unknown; docChanged: boolean }> = [];
    editor.on('transaction', ({ transaction }) => seen.push({ addToHistory: transaction.getMeta('addToHistory'), docChanged: transaction.docChanged }));
    await instance.showAgentEdit(AFTER, info());
    expect(seen.some((entry) => entry.docChanged && entry.addToHistory === false)).toBe(true);
  });

  it('Ctrl+Z after the apply does not remove the agent text or its marks', async () => {
    const { host, instance } = await mountReview(BEFORE);
    await instance.showAgentEdit(AFTER, info());
    pressUndo(host);
    expect(instance.getContent()).toBe(AFTER);
    expect(instance.review.state().pending).toBe(2);
  });

  it('Ctrl+Z after a reject brings the marks back, and never the agent text without them', async () => {
    const { host, instance } = await mountReview(BEFORE);
    await instance.showAgentEdit(AFTER, info());
    instance.review.next();
    expect(instance.review.reject()).toBe(1);
    expect(instance.review.state().pending).toBe(1);
    pressUndo(host);
    expect(instance.review.state().pending).toBe(2);
    expect(instance.getContent()).toBe(AFTER);
    expect(allPending(liveDoc(host))).toContain('twice');
  });
});

describe('when the marks are not trusted', () => {
  it('replaces the text, and says why, when the editor was not mounted in review mode', async () => {
    const { host, instance } = await mountInto(BEFORE);
    const outcome = await instance.showAgentEdit(AFTER, info());
    expect(outcome).toEqual({ landed: 'replaced', reason: 'off' });
    expect(instance.getContent()).toBe(AFTER);
    expect(marksIn(liveDoc(host))).toEqual([]);
    expect(instance.review.state().pending).toBe(0);
  });

  it('replaces the text when the writer has unsaved edits, as the ghost path does', async () => {
    const { autosave } = scheduler();
    const { host, instance } = await mountReview(BEFORE, { autosave, revision: 1 });
    const editor = tiptapOf(focusDom(host));
    editor.view.dispatch(editor.state.tr.insertText('Typed. ', 1));
    expect(instance.hasUnsavedEdits()).toBe(true);
    const outcome = await instance.showAgentEdit(AFTER, info('call-1', 2));
    expect(outcome).toEqual({ landed: 'replaced', reason: 'unsaved' });
    expect(instance.getContent()).toBe(AFTER);
  });

  it('replaces the text when the marks would not project back to the stored body, and the screen never shows a wrong text', async () => {
    // A diff engine that calls two different texts equal: the marks it makes cannot add up to the agent's text.
    const blind: DiffEngine = { diff_main: (text) => [[0, text]], diff_cleanupSemantic: () => {} };
    const { host, instance } = await mountReview(BEFORE, { loadReviewLayer: () => loadSuggestionLayer(blind) });
    const outcome = await instance.showAgentEdit(AFTER, info());
    expect(outcome).toEqual({ landed: 'replaced', reason: 'mismatch' });
    expect(instance.getContent()).toBe(AFTER);
    expect(marksIn(liveDoc(host))).toEqual([]);
  });

  it('reports how many suggestions a resolution settled: none when the layer cannot apply it, and the smaller number when only some are in the document', async () => {
    const real = await loadSuggestionLayer();
    // A layer whose library commands all fail.
    const stuck = { ...real, resolve: () => null, resolveAll: () => null };
    const first = await mountReview(BEFORE, { loadReviewLayer: async () => ({ ...stuck, createReview: (host) => createReview(stuck, host) }) });
    await first.instance.showAgentEdit(AFTER, info());
    expect(first.instance.review.acceptAll()).toBe(0);
    expect(first.instance.review.rejectToolCall('call-1')).toBe(0);
    expect(first.instance.review.state().pending).toBe(2);
    // A layer that reports one suggestion more than the document holds, so one of the ids asked about cannot be settled.
    const phantom = { id: '1.99', turn: 1, kind: 'insert' as const, from: 1, to: 1, added: '', removed: '' };
    const extra = { ...real, spans: (doc: PmNode) => [...real.spans(doc), phantom] };
    const second = await mountReview(BEFORE, { loadReviewLayer: async () => ({ ...extra, createReview: (host) => createReview(extra, host) }) });
    await second.instance.showAgentEdit(AFTER, info());
    expect(second.instance.review.state().pending).toBe(3);
    expect(second.instance.review.acceptToolCall('call-1')).toBe(2);
    expect(second.instance.review.state().pending).toBe(1);
  });

  it('runs on the ghost path when the review layer cannot be loaded', async () => {
    const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { instance } = await mountReview(BEFORE, {
      loadReviewLayer: async () => {
        throw new Error('chunk failed');
      },
    });
    expect(await instance.showAgentEdit(AFTER, info())).toEqual({ landed: 'replaced', reason: 'no-layer' });
    expect(instance.getContent()).toBe(AFTER);
    expect(failure).toHaveBeenCalled();
    failure.mockRestore();
  });

  it('reports unsaved typing as lost when the review layer cannot be loaded either', async () => {
    const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { autosave } = scheduler();
    const { host, instance } = await mountReview(BEFORE, {
      autosave,
      revision: 1,
      loadReviewLayer: async () => {
        throw new Error('chunk failed');
      },
    });
    const editor = tiptapOf(focusDom(host));
    editor.view.dispatch(editor.state.tr.insertText('Typed. ', 1));
    expect(instance.hasUnsavedEdits()).toBe(true);
    expect(await instance.showAgentEdit(AFTER, info('call-1', 2))).toEqual({ landed: 'replaced', reason: 'unsaved' });
    expect(instance.getContent()).toBe(AFTER);
    failure.mockRestore();
  });

  it('re-seats the store onto the stored body before the marks go in, so no write follows an apply', async () => {
    const { autosave, write } = scheduler();
    const { instance } = await mountReview(BEFORE, { autosave, revision: 1 });
    await instance.showAgentEdit(AFTER, info('call-1', 2));
    await instance.flush();
    expect(write).not.toHaveBeenCalled();
    expect(autosave.status('doc-under-test').revision).toBe(2);
    expect(instance.hasUnsavedEdits()).toBe(false);
  });
});

describe('the diff', () => {
  it('turns a reworded paragraph into word-sized hunks and an unchanged document into none', async () => {
    const real = await import('diff-match-patch');
    const module = real as unknown as { diff_match_patch?: new () => DiffEngine; default?: { diff_match_patch?: new () => DiffEngine } & (new () => DiffEngine) };
    const Engine = (module.diff_match_patch ?? module.default?.diff_match_patch ?? module.default) as new () => DiffEngine;
    const engine = new Engine();
    const old = (await parseWithDiagnostics(BEFORE)).doc;
    const next = (await parseWithDiagnostics(AFTER)).doc;
    expect(diffHunks(engine, old, old)).toEqual([]);
    const hunks = diffHunks(engine, old, next) ?? [];
    expect(hunks.length).toBe(2);
    for (const hunk of hunks) expect(hunk.to - hunk.from).toBeLessThan(12);
  });
});

describe('a deletion that crosses differently marked text (the library leaves part of it marked after one pass)', () => {
  const cases: Array<[string, string, string]> = [
    ['plain, italic, plain', 'a b _it_ c d\n', 'a d\n'],
    ['plain, bold, plain', 'a b **it** c d\n', 'a d\n'],
    ['two marked runs in a longer line', 'The old _quiet_ harbour and the _slow_ ship\n', 'The ferry\n'],
  ];

  it.each(cases)('lands %s as marks over the stored text, and every way of resolving them settles', async (_name, before, after) => {
    const { host, instance } = await mountReview(before);
    const outcome = await instance.showAgentEdit(after, info());
    expect(outcome.landed).toBe('suggestions');
    expect(instance.getContent()).toBe(after);
    expect(marksIn(liveDoc(host)).length).toBeGreaterThan(0);
    expect(instance.review.acceptAll()).toBeGreaterThan(0);
    expect(instance.getContent()).toBe(after);
    expect(marksIn(liveDoc(host))).toEqual([]);

    const again = await mountReview(before);
    await again.instance.showAgentEdit(after, info());
    expect(again.instance.review.rejectAll()).toBeGreaterThan(0);
    expect(again.instance.getContent()).toBe(before);
    expect(marksIn(liveDoc(again.host))).toEqual([]);
  });

  it('accepts and rejects the suggestions one at a time', async () => {
    const before = 'a b _it_ c d\n';
    const one = await mountReview(before);
    await one.instance.showAgentEdit('a d\n', info());
    while (one.instance.review.state().pending > 0) {
      one.instance.review.next();
      expect(one.instance.review.accept()).toBe(1);
    }
    expect(one.instance.getContent()).toBe('a d\n');
    expect(marksIn(liveDoc(one.host))).toEqual([]);

    const two = await mountReview(before);
    await two.instance.showAgentEdit('a d\n', info());
    while (two.instance.review.state().pending > 0) {
      two.instance.review.next();
      expect(two.instance.review.reject()).toBe(1);
    }
    expect(two.instance.getContent()).toBe(before);
    expect(marksIn(liveDoc(two.host))).toEqual([]);
  });
});
