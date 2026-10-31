/**
 * Footnotes in the live editor (#270): the two nodes, the rule that keeps their
 * numbering and order canonical while the writer edits, and the keyboard and pointer
 * affordances.
 *
 * ## What the writer can do, and how
 *
 * - **Insert** — Ctrl+Shift+6 (Cmd+Shift+6 on a Mac; `^` is Shift+6 on a US
 *   keyboard, and `[^1]` is how Markdown spells a footnote) puts a marker at the
 *   caret, adds an empty note at the end of the document and moves the caret into
 *   it. The app's editor bar has the same command as a button.
 * - **Go to a note and back** — the same chord inside a note returns to the text,
 *   just after the note's first marker. With a marker selected (Shift+Arrow over it,
 *   or a click), it goes to that marker's note. A click on a marker does the same.
 * - **Edit** — a note is ordinary text at the end of the document.
 * - **Delete** — Backspace or Delete over a marker removes it. The note is kept and
 *   the editor tells the app (`onOrphaned`), which asks the writer whether the note
 *   goes too. A note whose marker is gone round-trips as a definition nothing
 *   references, so keeping it loses nothing.
 * - **Renumber** — automatic. After every change the rule in `../footnotes.ts` puts
 *   the notes in reading order and re-flows numeric labels, in the same undo step.
 *
 * ## Why the canonical rule runs as `appendTransaction`
 *
 * The rule has to hold for every way the document changes (typing, paste, undo, an
 * agent's rewrite), and an appended transaction is ProseMirror's one hook that sees
 * all of them. It inherits the lane of the change that caused it: an appended
 * transaction joins its root's undo event in `prosemirror-history`, and one caused by
 * an agent change carries `addToHistory: false` like its root (§7). The history
 * journal records root transactions only, and its replay re-runs this plugin, so the
 * replay reaches the same document.
 *
 * ## Accessibility
 *
 * A marker is a `<sup role="doc-noteref">` with an `aria-label` ("Footnote 2"), and
 * its note's text is its `title`, so hovering shows the note and a screen reader
 * announces the marker by name. A note is a `role="note"` region labelled the same way.
 */
import { Extension, Node as TiptapNode } from '@tiptap/core';
import { isHistoryTransaction } from '@tiptap/pm/history';
import type { Node as PmNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  definedFootnoteKeys,
  footnoteKey,
  footnoteTail,
  isNumericLabel,
  planPmFootnotes,
  referencedFootnoteKeys,
} from '../footnotes.js';

/** A note whose last marker the writer deleted. */
export interface FootnoteOrphan {
  /** The note's label after renumbering, which is how the editor shows it now. */
  readonly label: string;
  /** The note's text, for the question the app asks. */
  readonly text: string;
}

/** The words the editor puts on a marker and a note for assistive technology. English by default. */
export interface FootnoteWords {
  reference(label: string): string;
  note(label: string): string;
}

export const ENGLISH_FOOTNOTE_WORDS: FootnoteWords = {
  reference: (label) => `Footnote ${label}`,
  note: (label) => `Footnote ${label}`,
};

/** How far a note's text is shown in a marker's tooltip. */
const PREVIEW_CHARS = 200;

/** A note's text as one line, for a tooltip or a question. */
export const noteText = (note: PmNode): string => {
  const text = note.textBetween(0, note.content.size, ' ', ' ').replace(/\s+/g, ' ').trim();
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
};

/**
 * Puts `tr`'s document in the canonical footnote spelling, as steps on `tr`. Returns old
 * key → new label for every note whose label changed.
 */
export const applyFootnoteFix = (tr: Transaction): Map<string, string> => {
  const fix = planPmFootnotes(tr.doc);
  if (fix === null) return new Map();
  for (const { pos, label } of fix.relabel) {
    const node = tr.doc.nodeAt(pos);
    if (node !== null) tr.setNodeMarkup(pos, undefined, { ...node.attrs, label });
  }
  if (fix.tail !== null) tr.replaceWith(fix.tailStart, tr.doc.content.size, fix.tail);
  return fix.mapping;
};

/** The note for `label`, with its position, or `null`. */
const findNote = (doc: PmNode, label: string): { node: PmNode; pos: number } | null => {
  const key = footnoteKey(label);
  let found: { node: PmNode; pos: number } | null = null;
  let pos = 0;
  doc.forEach((child) => {
    if (found === null && child.type.name === 'footnote_definition' && footnoteKey(child.attrs.label as string) === key) {
      found = { node: child, pos };
    }
    pos += child.nodeSize;
  });
  return found;
};

/** The first marker for `label` in the text, with its position, or `null`. */
const findReference = (doc: PmNode, label: string): number | null => {
  const key = footnoteKey(label);
  let found: number | null = null;
  doc.descendants((child, pos) => {
    if (found !== null) return false;
    if (child.type.name === 'footnote_reference' && footnoteKey(child.attrs.label as string) === key) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
};

/** The note the selection is in, or `null`. */
const noteAround = (state: EditorState): PmNode | null => {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'footnote_definition') return node;
  }
  return null;
};

/** The marker the selection holds and nothing else, or `null`. */
const selectedReference = (state: EditorState): PmNode | null => {
  const { selection } = state;
  if (selection instanceof NodeSelection) {
    return selection.node.type.name === 'footnote_reference' ? selection.node : null;
  }
  if (selection.empty) return null;
  let found: PmNode | null = null;
  let other = false;
  state.doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.type.name === 'footnote_reference') {
      if (found !== null) other = true;
      found = node;
    } else if (node.isText && node.text !== undefined && node.text.trim().length > 0) {
      other = true;
    }
    return true;
  });
  return other ? null : found;
};

type Dispatch = ((tr: Transaction) => void) | undefined;

/** Moves the caret to the start of `label`'s note. */
const goToNote = (state: EditorState, dispatch: Dispatch, label: string): boolean => {
  const note = findNote(state.doc, label);
  if (note === null) return false;
  if (dispatch) {
    const tr = state.tr.setSelection(TextSelection.near(state.doc.resolve(note.pos + 1))).scrollIntoView();
    dispatch(tr);
  }
  return true;
};

/**
 * Inserts a footnote at the caret (the end of a selection; the selection is kept as
 * text), adds its empty note, renumbers, and moves the caret into the note. Refused
 * inside a note: a footnote in a footnote is GFM, but it is not one keystroke away.
 */
export const insertFootnote = (state: EditorState, dispatch: Dispatch): boolean => {
  const type = state.schema.nodes.footnote_reference;
  const noteType = state.schema.nodes.footnote_definition;
  if (type === undefined || noteType === undefined) return false;
  if (noteAround(state) !== null) return false;
  const at = state.selection.to;
  const $at = state.doc.resolve(at);
  if (!$at.parent.inlineContent || !$at.parent.type.contentMatch.matchType(type)) return false;
  if (dispatch) {
    // A label no note has yet. It is numeric, so the re-flow below gives it its place.
    const taken = definedFootnoteKeys(state.doc);
    let n = footnoteTail(state.doc).defs.length + 1;
    while (taken.has(footnoteKey(String(n)))) n += 1;
    const label = String(n);
    const tr = state.tr.insert(at, type.create({ label }));
    tr.insert(tr.doc.content.size, noteType.createAndFill({ label }) as PmNode);
    const mapping = applyFootnoteFix(tr);
    const final = mapping.get(footnoteKey(label)) ?? label;
    const note = findNote(tr.doc, final);
    if (note !== null) tr.setSelection(TextSelection.near(tr.doc.resolve(note.pos + 1)));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * Ctrl+Shift+6 when it does not insert: from a note back to its first marker, or from
 * a selected marker to its note. `false` when neither applies.
 */
export const jumpFootnote = (state: EditorState, dispatch: Dispatch): boolean => {
  const note = noteAround(state);
  if (note !== null) {
    const ref = findReference(state.doc, note.attrs.label as string);
    if (ref === null) return false;
    if (dispatch) {
      dispatch(state.tr.setSelection(TextSelection.create(state.doc, ref + 1)).scrollIntoView());
    }
    return true;
  }
  const marker = selectedReference(state);
  if (marker !== null) return goToNote(state, dispatch, marker.attrs.label as string);
  return false;
};

/** The chord's whole behaviour: jump when there is somewhere to jump, insert otherwise. */
export const footnoteChord = (state: EditorState, dispatch: Dispatch): boolean =>
  jumpFootnote(state, dispatch) || insertFootnote(state, dispatch);

/**
 * Deletes `label`'s note if no marker refers to it any more — the answer to the
 * question the app asks after a marker is deleted. `false` (and nothing changes) when
 * the note is gone or has a marker again, for example after an undo.
 */
export const deleteOrphanNote = (state: EditorState, dispatch: Dispatch, label: string): boolean => {
  const note = findNote(state.doc, label);
  if (note === null) return false;
  if (referencedFootnoteKeys(state.doc).has(footnoteKey(label))) return false;
  if (dispatch) dispatch(state.tr.delete(note.pos, note.pos + note.node.nodeSize));
  return true;
};

const footnoteKeyPlugin = new PluginKey<readonly FootnoteOrphan[] | null>('caotangFootnotes');

export interface FootnoteBehaviourOptions {
  onOrphaned?: ((orphans: readonly FootnoteOrphan[]) => void) | undefined;
  words?: FootnoteWords | undefined;
}

/** The marker's DOM. Its text is the label; the tooltip is added by the behaviour plugin. */
const referenceDom = (words: FootnoteWords) =>
  (label: string): [string, Record<string, string>, string] => [
    'sup',
    {
      'data-footnote-ref': label,
      class: 'caotang-footnote-ref',
      role: 'doc-noteref',
      'aria-label': words.reference(label),
    },
    label,
  ];

/** The two nodes, aligned to §3.1. `blockMarks` is the review layer's, as for the other containers. */
export const footnoteNodes = (blockMarks: { marks?: string }, words: FootnoteWords = ENGLISH_FOOTNOTE_WORDS) => {
  const dom = referenceDom(words);
  return [
    TiptapNode.create({
      name: 'footnote_reference',
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      addAttributes() {
        return { label: { isRequired: true } };
      },
      parseHTML() {
        return [{ tag: 'sup[data-footnote-ref]', getAttrs: (el) => ({ label: (el as HTMLElement).getAttribute('data-footnote-ref') }) }];
      },
      renderHTML({ node }) {
        return dom(node.attrs.label as string);
      },
      renderText({ node }) {
        return `[^${node.attrs.label as string}]`;
      },
    }),
    TiptapNode.create({
      name: 'footnote_definition',
      content: 'block+',
      defining: true,
      isolating: true,
      ...blockMarks,
      addAttributes() {
        return { label: { isRequired: true } };
      },
      parseHTML() {
        return [{ tag: 'div[data-footnote]', getAttrs: (el) => ({ label: (el as HTMLElement).getAttribute('data-footnote') }) }];
      },
      renderHTML({ node }) {
        const label = node.attrs.label as string;
        return [
          'div',
          { 'data-footnote': label, class: 'caotang-footnote', role: 'note', 'aria-label': words.note(label) },
          0,
        ];
      },
    }),
  ];
};

/** Whether `trs` hold a change the writer made by hand: not an agent's, not an undo. */
const byWriter = (trs: readonly Transaction[]): boolean =>
  trs.some((tr) => tr.docChanged && tr.getMeta('addToHistory') !== false && !isHistoryTransaction(tr));

/**
 * The behaviour: the canonical rule, the tooltips, the click and the chord. Focus
 * editor only — the ghost preview is read-only and shows a parsed (already canonical)
 * draft.
 */
export const FootnoteBehaviour = Extension.create<FootnoteBehaviourOptions>({
  name: 'caotangFootnotes',
  addOptions() {
    return { onOrphaned: undefined, words: undefined };
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-6': () => footnoteChord(this.editor.state, this.editor.view.dispatch),
    };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<readonly FootnoteOrphan[] | null>({
        key: footnoteKeyPlugin,
        state: {
          init: () => null,
          apply: (tr) => tr.getMeta(footnoteKeyPlugin) ?? null,
        },
        appendTransaction(trs, oldState, newState) {
          if (!trs.some((tr) => tr.docChanged)) return null;
          const tr = newState.tr;
          const lostKeys = byWriter(trs)
            ? [...referencedFootnoteKeys(oldState.doc)].filter(
                (key) => !referencedFootnoteKeys(newState.doc).has(key) && definedFootnoteKeys(newState.doc).has(key),
              )
            : [];
          const mapping = applyFootnoteFix(tr);
          if (lostKeys.length > 0) {
            const orphans: FootnoteOrphan[] = [];
            const labelOf = new Map<string, string>();
            for (const def of footnoteTail(newState.doc).defs) labelOf.set(footnoteKey(def.attrs.label as string), def.attrs.label as string);
            for (const key of lostKeys) {
              const label = mapping.get(key) ?? labelOf.get(key);
              const note = label === undefined ? null : findNote(tr.doc, label);
              if (label !== undefined && note !== null) orphans.push({ label, text: noteText(note.node) });
            }
            if (orphans.length > 0) tr.setMeta(footnoteKeyPlugin, orphans);
          }
          if (!tr.docChanged && tr.getMeta(footnoteKeyPlugin) === undefined) return null;
          if (trs.some((root) => root.getMeta('addToHistory') === false)) tr.setMeta('addToHistory', false);
          return tr;
        },
        view: () => ({
          update: (view, prev) => {
            const now = footnoteKeyPlugin.getState(view.state);
            if (now !== null && now !== undefined && now !== footnoteKeyPlugin.getState(prev)) options.onOrphaned?.(now);
          },
        }),
        props: {
          // A marker's tooltip is its note's text: hovering shows the note.
          decorations(state) {
            const notes = new Map<string, string>();
            for (const def of footnoteTail(state.doc).defs) notes.set(footnoteKey(def.attrs.label as string), noteText(def));
            if (notes.size === 0) return null;
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name === 'footnote_reference') {
                const text = notes.get(footnoteKey(node.attrs.label as string));
                if (text !== undefined && text.length > 0) {
                  decorations.push(Decoration.node(pos, pos + node.nodeSize, { title: text }));
                }
              }
              return true;
            });
            return DecorationSet.create(state.doc, decorations);
          },
          // A click on a marker goes to its note.
          handleClickOn(view, _pos, node) {
            if (node.type.name !== 'footnote_reference') return false;
            return goToNote(view.state, view.dispatch, node.attrs.label as string);
          },
        },
      }),
    ];
  },
});

export { isNumericLabel };
