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

import { DEFAULT_EDITOR_LABELS } from '../src/tiptap/index.js';
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

  it('a note removed while the question is open is gone, even when an identical note moves into its place (F24)', async () => {
    const orphans: FootnoteOrphan[] = [];
    const { host, instance } = await mountInto('A[^1] B[^2].\n\n[^1]: One.\n\n[^2]: Two.\n\n[^3]: One.\n', {
      onFootnoteOrphaned: (found) => orphans.push(...found),
    });
    const editor = tiptapOf(focusDom(host));
    caretAfter(editor, 'A');
    const marker = editor.state.selection.from;
    editor.view.dispatch(editor.state.tr.delete(marker, marker + 1));
    // The orphan is the first "One.", now note 2; a second, unreferenced "One." is note 3.
    expect(instance.getContent()).toBe('A B[^1].\n\n[^1]: Two.\n\n[^2]: One.\n\n[^3]: One.\n');
    expect(orphans).toEqual([{ id: expect.any(Number), label: '2', text: 'One.' }]);
    // While the question is open the writer removes note 2 itself. Note 3 re-flows to 2: the
    // same text, at the very position the question's note had.
    const notes: number[] = [];
    editor.state.doc.forEach((child, pos) => {
      if (child.type.name === 'footnote_definition') notes.push(pos);
    });
    const second = notes[1]!;
    editor.view.dispatch(editor.state.tr.delete(second, second + editor.state.doc.nodeAt(second)!.nodeSize));
    expect(instance.getContent()).toBe('A B[^1].\n\n[^1]: Two.\n\n[^2]: One.\n');
    let after = -1;
    editor.state.doc.forEach((child, pos) => {
      if (child.type.name === 'footnote_definition' && child.attrs.label === '2') after = pos;
    });
    expect(after).toBe(second);
    // The answer does not take the look-alike: the note it named is gone, and nothing changes.
    expect(instance.deleteFootnoteNote(orphans[0]!)).toBe('gone');
    expect(instance.getContent()).toBe('A B[^1].\n\n[^1]: Two.\n\n[^2]: One.\n');
    // Undo brings the named note back (the same note, not a copy), and the answer finds it.
    pressUndo(host);
    expect(instance.getContent()).toBe('A B[^1].\n\n[^1]: Two.\n\n[^2]: One.\n\n[^3]: One.\n');
    expect(instance.deleteFootnoteNote(orphans[0]!)).toBe('deleted');
    expect(instance.getContent()).toBe('A B[^1].\n\n[^1]: Two.\n\n[^2]: One.\n');
    // It deleted note 2, the one the question named; note 3's node is the one left.
    pressUndo(host);
    expect(instance.getContent()).toBe('A B[^1].\n\n[^1]: Two.\n\n[^2]: One.\n\n[^3]: One.\n');
  });

  it('a note an agent replaces with an identical one while the question is open is gone (F24)', async () => {
    const orphans: FootnoteOrphan[] = [];
    const { host, instance } = await mountInto('A[^1] B[^2].\n\n[^1]: One.\n\n[^2]: Two.\n', {
      onFootnoteOrphaned: (found) => orphans.push(...found),
    });
    const editor = tiptapOf(focusDom(host));
    caretAfter(editor, 'A');
    const marker = editor.state.selection.from;
    editor.view.dispatch(editor.state.tr.delete(marker, marker + 1));
    expect(instance.getContent()).toBe('A B[^1].\n\n[^1]: Two.\n\n[^2]: One.\n');
    // An agent (Lane 2) rewrites the tail: the note it writes has the same label, text and place, but it is not the note the question named.
    const body = instance.getContent();
    const from = body.indexOf('[^2]: One.');
    instance.replaceRange({ from, to: from + '[^2]: One.'.length }, '[^2]: One.', { historyExcluded: true });
    expect(instance.getContent()).toBe('A B[^1].\n\n[^1]: Two.\n\n[^2]: One.\n');
    expect(instance.deleteFootnoteNote(orphans[0]!)).toBe('gone');
    expect(instance.getContent()).toBe('A B[^1].\n\n[^1]: Two.\n\n[^2]: One.\n');
  });

  it('two markers deleted at once report both notes, and each answer deletes its own', async () => {
    const orphans: Array<readonly FootnoteOrphan[]> = [];
    const { host, instance } = await mountInto('A[^1] B[^2] C[^3].\n\n[^1]: One.\n\n[^2]: Two.\n\n[^3]: Three.\n', {
      onFootnoteOrphaned: (found) => orphans.push(found),
    });
    const editor = tiptapOf(focusDom(host));
    caretAfter(editor, 'A');
    const from = editor.state.selection.from;
    caretAfter(editor, 'B');
    const to = editor.state.selection.from + 1;
    editor.view.dispatch(editor.state.tr.delete(from, to));
    expect(instance.getContent()).toBe('A C[^1].\n\n[^1]: Three.\n\n[^2]: One.\n\n[^3]: Two.\n');
    expect(orphans).toHaveLength(1);
    const [one, two] = orphans[0]!;
    expect([one!.text, two!.text]).toEqual(['One.', 'Two.']);
    expect(instance.deleteFootnoteNote(two!)).toBe('deleted');
    expect(instance.deleteFootnoteNote(one!)).toBe('deleted');
    expect(instance.getContent()).toBe('A C[^1].\n\n[^1]: Three.\n');
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

  it('a click on a marker puts the caret in its note', async () => {
    const { host } = await mountInto('A[^1] and B[^2].\n\n[^1]: One.\n\n[^2]: Two.\n');
    const editor = tiptapOf(focusDom(host));
    let marker = -1;
    editor.state.doc.descendants((node, pos) => {
      if (marker < 0 && node.type.name === 'footnote_reference' && node.attrs.label === '2') marker = pos;
      return marker < 0;
    });
    const node = editor.state.doc.nodeAt(marker)!;
    const handled = editor.view.someProp('handleClickOn', (handle) =>
      handle(editor.view, marker, node, marker, new MouseEvent('click'), true),
    );
    expect(handled).toBe(true);
    const { $from } = editor.state.selection;
    expect(caretIn(editor)).toEqual(['paragraph', 'footnote_definition']);
    expect($from.node(1).attrs.label).toBe('2');
    expect($from.parent.textContent).toBe('Two.');
  });

  it('the words are the app’s when it passes its own through the editor labels', async () => {
    const { host } = await mountInto('A[^1] and B[^b].\n\n[^1]: One.\n\n[^b]: Two.\n', {
      labels: { footnoteReference: (label) => `Fußnote ${label}`, footnoteNote: (label) => `Anmerkung ${label}` },
    });
    const refs = [...focusDom(host).querySelectorAll('sup[role="doc-noteref"]')];
    expect(refs.map((ref) => [ref.getAttribute('aria-label'), ref.textContent])).toEqual([
      ['Fußnote 1', '1'],
      ['Fußnote b', 'b'],
    ]);
    const notes = [...focusDom(host).querySelectorAll('div.caotang-footnote')];
    expect(notes.map((note) => note.getAttribute('aria-label'))).toEqual(['Anmerkung 1', 'Anmerkung b']);
  });

  it('labels that leave the footnote words out keep the English defaults', async () => {
    const { host } = await mountInto('A[^1].\n\n[^1]: One.\n', { labels: { image: 'Bild' } });
    expect(focusDom(host).querySelector('sup')!.getAttribute('aria-label')).toBe('Footnote 1');
    expect(focusDom(host).querySelector('div.caotang-footnote')!.getAttribute('aria-label')).toBe('Footnote 1');
  });

  it('the package’s default footnote words are the English source', () => {
    expect(DEFAULT_EDITOR_LABELS.footnoteReference('2')).toBe('Footnote 2');
    expect(DEFAULT_EDITOR_LABELS.footnoteNote('2')).toBe('Footnote 2');
    expect(DEFAULT_EDITOR_LABELS.footnoteReference('note')).toBe('Footnote note');
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
