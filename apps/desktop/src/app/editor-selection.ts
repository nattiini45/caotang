/**
 * The editor's current selection, published for the rest of the shell.
 *
 * The Inspector's picture strip attaches a picture to "this paragraph", and only the live editor knows which paragraph the
 * caret is in. The editor pane owns the instance, so it publishes the selection here on every change and the strip reads it.
 * A module rather than a prop chain because the Inspector sits in a different tab of the same workspace, and threading a
 * selection through every intermediate panel would put the editor's state in cards that do not read it.
 *
 * The selection is a **view fact**: it says where the caret is in the document on screen, never where a stored link points.
 * It is `null` when no editor is mounted, when the editor is hidden behind another centre view, or when the selection is
 * collapsed — a picture attaches to a paragraph, so a bare caret does not make one.
 */

import { useSyncExternalStore } from 'react';

export interface EditorCaret {
  /** The document the editor is showing. */
  readonly docId: string;
  /** Body-projection offsets, which are the anchor's coordinates (pictures.md §2.3). */
  readonly from: number;
  readonly to: number;
  /**
   * Whether the editor holds text the store has not written yet. An attach captures its anchor against the **store's** body,
   * because that is the body the next write diffs against, so the offsets only mean something while the two agree.
   */
  readonly dirty: boolean;
}

let current: EditorCaret | null = null;
const listeners = new Set<(next: EditorCaret | null) => void>();

/** Publishes the selection; the editor pane calls this on every change and on teardown with `null`. */
export function publishEditorCaret(next: EditorCaret | null): void {
  if (
    next === null
      ? current === null
      : current !== null && current.docId === next.docId && current.from === next.from && current.to === next.to && current.dirty === next.dirty
  ) {
    return;
  }
  current = next;
  for (const listener of listeners) listener(next);
}

/** The selection as it stands, for a caller that only needs it at the moment the writer clicks. */
export function currentEditorCaret(): EditorCaret | null {
  return current;
}

/** Subscribes to the selection. Returns the unsubscribe function. */
export function subscribeEditorCaret(listener: (next: EditorCaret | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The selection, re-rendered on change. */
export function useEditorCaret(): EditorCaret | null {
  return useSyncExternalStore(subscribeEditorCaret, currentEditorCaret, currentEditorCaret);
}
