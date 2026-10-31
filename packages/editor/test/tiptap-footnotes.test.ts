// @vitest-environment jsdom
/**
 * §3.4 (#270) in the live editor: insert, edit, delete and renumber with the keyboard
 * only, what a screen reader is given, and how a footnote edit sits in the two undo
 * lanes.
 *
 * Every keystroke is dispatched as a `keydown` on the view's root, where a browser
 * sends it, so the chord is tested through the keymap rather than by calling the
 * command.
 */
import { describe, expect, it } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/core';

import type { FootnoteOrphan } from '../src/tiptap/index.js';
import { focusDom, mountInto, pressUndo, tiptapOf } from './tiptap-harness.js';

/** Ctrl+Shift+6, with the `key` a US layout reports (`^`) and the key code the keymap falls back to. */
const pressChord = (host: HTMLElement): void => {
  focusDom(host).dispatchEvent(
    new KeyboardEvent('keydown', { key: '^', code: 'Digit6', keyCode: 54, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
  );
};

/** Puts the caret at the end of the first text that contains `needle`. */
const caretAfter = (editor: Editor, needle: string): void => {
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text!.includes(needle)) at = pos + node.text!.indexOf(needle) + needle.length;
    return at < 0;
  });
  if (at < 0) throw new Error(`no text "${needle}"`);
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)));
};

/** The node the caret is in, by name, walking out from the innermost. */
const caretIn = (editor: Editor): string[] => {
  const { $from } = editor.state.selection;
  const names: string[] = [];
  for (let depth = $from.depth; depth > 0; depth--) names.push($from.node(depth).type.name);
  return names;
};

describe('§3.4 · keyboard only', () => {
  it('Ctrl+Shift+6 inserts a marker, adds its note at the end and puts the caret in it; typing writes the note', async () => {
    const { host, instance } = await mountInto('The ferry was late. She counted the boats.\n');
    const editor = tiptapOf(focusDom(host));
    caretAfter(editor, 'late');
    pressChord(host);
    expect(caretIn(editor)).toEqual(['paragraph', 'footnote_definition']);
    editor.view.dispatch(editor.state.tr.insertText('The Marta.'));
    expect(instance.getContent()).toBe('The ferry was late[^1]. She counted the boats.\n\n[^1]: The Marta.\n');
  });

  it('a footnote inserted before another takes number 1, and both renumber in one step', async () => {
    const { host, instance } = await mountInto('Early, later[^1].\n\n[^1]: The old note.\n');
    const editor = tiptapOf(focusDom(host));
    caretAfter(editor, 'Early');
    pressChord(host);
    editor.view.dispatch(editor.state.tr.insertText('The new note.'));
    expect(instance.getContent()).toBe('Early[^1], later[^2].\n\n[^1]: The new note.\n\n[^2]: The old note.\n');
  });

  it('the chord in a note goes back to the text, after the marker; with the marker selected it goes to the note', async () => {
    const { host } = await mountInto('One[^1] two.\n\n[^1]: Note.\n');
    const editor = tiptapOf(focusDom(host));
    caretAfter(editor, 'Note');
    pressChord(host);
    const back = editor.state.selection.from;
    expect(editor.state.doc.resolve(back).nodeBefore?.type.name).toBe('footnote_reference');
    // Shift+Left over the marker selects it; the chord then goes to its note.
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, back - 1, back)));
    pressChord(host);
    expect(caretIn(editor)).toEqual(['paragraph', 'footnote_definition']);
  });

  it('deleting a marker keeps the note, reports it, and the answer deletes it; numbering re-flows', async () => {
    const orphans: Array<readonly FootnoteOrphan[]> = [];
    const { host, instance } = await mountInto('A[^1] and B[^2].\n\n[^1]: One.\n\n[^2]: Two.\n', {
      onFootnoteOrphaned: (found) => orphans.push(found),
    });
    const editor = tiptapOf(focusDom(host));
    // The first marker, deleted as the writer's own edit. (A browser deletes an inline
    // atom before the caret natively on Backspace, and ProseMirror reads the DOM change
    // back as a transaction; jsdom has no native editing, so the transaction is made here.)
    caretAfter(editor, 'A');
    const marker = editor.state.selection.from;
    editor.view.dispatch(editor.state.tr.delete(marker, marker + 1));
    // B's footnote is now the first; the orphaned note is kept, after it, as the second.
    expect(instance.getContent()).toBe('A and B[^1].\n\n[^1]: Two.\n\n[^2]: One.\n');
    expect(orphans).toEqual([[{ id: expect.any(Number), label: '2', text: 'One.' }]]);
    expect(instance.deleteFootnoteNote(orphans[0]![0]!)).toBe('deleted');
    expect(instance.getContent()).toBe('A and B[^1].\n\n[^1]: Two.\n');
    // Undo brings the note back, then the marker; the renumbering undoes with each step.
    pressUndo(host);
    expect(instance.getContent()).toBe('A and B[^1].\n\n[^1]: Two.\n\n[^2]: One.\n');
    pressUndo(host);
    expect(instance.getContent()).toBe('A[^1] and B[^2].\n\n[^1]: One.\n\n[^2]: Two.\n');
  });

  it('the answer is refused once the note has a marker again', async () => {
    const orphans: FootnoteOrphan[] = [];
    const { host, instance } = await mountInto('A[^1].\n\n[^1]: One.\n', { onFootnoteOrphaned: (found) => orphans.push(...found) });
    const editor = tiptapOf(focusDom(host));
    caretAfter(editor, 'A');
    const marker = editor.state.selection.from;
    editor.view.dispatch(editor.state.tr.delete(marker, marker + 1));
    pressUndo(host);
    expect(instance.deleteFootnoteNote(orphans[0]!)).toBe('referenced');
    expect(instance.getContent()).toBe('A[^1].\n\n[^1]: One.\n');
  });

  it('an agent re-flow while the question is open does not redirect the answer to another note', async () => {
    const orphans: FootnoteOrphan[] = [];
    const { host, instance } = await mountInto('A[^1] B[^2].\n\n[^1]: One.\n\n[^2]: Two.\n\n[^3]: Spare.\n', {
      onFootnoteOrphaned: (found) => orphans.push(...found),
    });
    const editor = tiptapOf(focusDom(host));
    // The writer deletes A's marker: "One." is the orphan, labelled 2.
    caretAfter(editor, 'A');
    const marker = editor.state.selection.from;
    editor.view.dispatch(editor.state.tr.delete(marker, marker + 1));
    expect(instance.getContent()).toBe('A B[^1].\n\n[^1]: Two.\n\n[^2]: One.\n\n[^3]: Spare.\n');
    expect(orphans).toEqual([{ id: expect.any(Number), label: '2', text: 'One.' }]);
    // While the question is open, an agent (Lane 2, which asks nothing) points B at the spare
    // note: the tail re-flows, and label 2 now names "Two.", which is also unreferenced.
    const body = instance.getContent();
    const from = body.indexOf('B[^1]');
    instance.replaceRange({ from, to: from + 'B[^1]'.length }, 'B[^3]', { historyExcluded: true });
    expect(instance.getContent()).toBe('A B[^1].\n\n[^1]: Spare.\n\n[^2]: Two.\n\n[^3]: One.\n');
    expect(orphans).toHaveLength(1);
    // The answer deletes "One." — the note the question named — and keeps "Two.".
    expect(instance.deleteFootnoteNote(orphans[0]!)).toBe('deleted');
    expect(instance.getContent()).toBe('A B[^1].\n\n[^1]: Spare.\n\n[^2]: Two.\n');
  });

  it('the answer is refused when the note it named is gone or its text changed', async () => {
    const orphans: FootnoteOrphan[] = [];
    const { host, instance } = await mountInto('A[^1] B[^2].\n\n[^1]: One.\n\n[^2]: Two.\n', {
      onFootnoteOrphaned: (found) => orphans.push(...found),
    });
    const editor = tiptapOf(focusDom(host));
    caretAfter(editor, 'A');
    const marker = editor.state.selection.from;
    editor.view.dispatch(editor.state.tr.delete(marker, marker + 1));
    expect(orphans).toEqual([{ id: expect.any(Number), label: '2', text: 'One.' }]);
    // The note's text is changed before the answer: it is no longer the note the question showed.
    caretAfter(editor, 'One');
    editor.view.dispatch(editor.state.tr.insertText(' more'));
    expect(instance.deleteFootnoteNote(orphans[0]!)).toBe('gone');
    expect(instance.getContent()).toBe('A B[^1].\n\n[^1]: Two.\n\n[^2]: One more.\n');
    // An orphan the editor never reported is refused too.
    expect(instance.deleteFootnoteNote({ id: -1, label: '2', text: 'One more.' })).toBe('gone');
  });

  it('a note whose text is deleted with a selection across it comes back empty, so the marker survives the save', async () => {
    const { host, instance } = await mountInto('A[^1].\n\n[^1]: One.\n');
    const editor = tiptapOf(focusDom(host));
    const tail = editor.state.doc.content.size - editor.state.doc.lastChild!.nodeSize;
    editor.view.dispatch(editor.state.tr.delete(tail, editor.state.doc.content.size));
    expect(instance.getContent()).toBe('A[^1].\n\n[^1]:\n');
  });

  it('the editor’s own command is the button’s, and refuses inside a note', async () => {
    const { host, instance } = await mountInto('Text.\n\n[^1]: Unreferenced.\n');
    const editor = tiptapOf(focusDom(host));
    caretAfter(editor, 'Unreferenced');
    expect(instance.insertFootnote()).toBe(false);
    caretAfter(editor, 'Text');
    expect(instance.insertFootnote()).toBe(true);
    // The new footnote is referenced, so it comes first; the unreferenced note re-flows to 2.
    expect(instance.getContent()).toBe('Text[^1].\n\n[^1]:\n\n[^2]: Unreferenced.\n');
  });
});

describe('§3.4 · what assistive technology and a pointer are given', () => {
  it('a marker is a named note reference with its note as the tooltip; a note is a named region', async () => {
    const { host } = await mountInto('A[^1] and B[^note].\n\n[^1]: One.\n\n[^note]: A named one.\n');
    const refs = [...focusDom(host).querySelectorAll('sup.caotang-footnote-ref')];
    expect(refs.map((ref) => [ref.getAttribute('role'), ref.getAttribute('aria-label'), ref.getAttribute('title'), ref.textContent])).toEqual([
      ['doc-noteref', 'Footnote 1', 'One.', '1'],
      ['doc-noteref', 'Footnote note', 'A named one.', 'note'],
    ]);
    const notes = [...focusDom(host).querySelectorAll('div.caotang-footnote')];
    expect(notes.map((note) => [note.getAttribute('role'), note.getAttribute('aria-label')])).toEqual([
      ['note', 'Footnote 1'],
      ['note', 'Footnote note'],
    ]);
  });

  it('the words are the app’s when it passes its own', async () => {
    const { host } = await mountInto('A[^1].\n\n[^1]: One.\n', {
      footnoteWords: { reference: (label) => `Fußnote ${label}`, note: (label) => `Anmerkung ${label}` },
    });
    expect(focusDom(host).querySelector('sup')!.getAttribute('aria-label')).toBe('Fußnote 1');
    expect(focusDom(host).querySelector('div.caotang-footnote')!.getAttribute('aria-label')).toBe('Anmerkung 1');
  });
});

describe('§3.4 · the two lanes (§7)', () => {
  it('an agent replacement that keeps `[^1]` keeps the marker, and its re-flow stays out of the user’s undo', async () => {
    const { host, instance } = await mountInto('The ferry was late[^1]. Then calm.\n\n[^1]: The Marta.\n');
    const body = instance.getContent();
    const exact = 'The ferry was late[^1].';
    const from = body.indexOf(exact);
    instance.replaceRange({ from, to: from + exact.length }, 'The ferry came in late[^1].', { historyExcluded: true });
    expect(instance.getContent()).toBe('The ferry came in late[^1]. Then calm.\n\n[^1]: The Marta.\n');
    // Nothing for the user to undo: the agent's change and anything it caused are Lane 2.
    pressUndo(host);
    expect(instance.getContent()).toBe('The ferry came in late[^1]. Then calm.\n\n[^1]: The Marta.\n');
  });

  it('an agent replacement that removes a marker re-flows the numbering without asking the writer', async () => {
    const orphans: Array<readonly FootnoteOrphan[]> = [];
    const { instance } = await mountInto('A[^1] and B[^2].\n\n[^1]: One.\n\n[^2]: Two.\n', {
      onFootnoteOrphaned: (found) => orphans.push(found),
    });
    const body = instance.getContent();
    const from = body.indexOf('A[^1]');
    instance.replaceRange({ from, to: from + 'A[^1]'.length }, 'A', { historyExcluded: true });
    expect(instance.getContent()).toBe('A and B[^1].\n\n[^1]: Two.\n\n[^2]: One.\n');
    expect(orphans).toEqual([]);
  });
});
