/**
 * [editor-engine.md] §8 and [edit-anchors.md] §5 — the ghost preview.
 *
 * ## What the ghost is, and why it is a second editor
 *
 * §8 puts the streamed agent text in a **separate read-only `EditorInstance`**,
 * rendered as a region below the focus document, and rejects decorations in the
 * main editor. The reasons are the spec's own: streamed insertions as decorations
 * churn the focus document's decoration set on every delta and couple the preview
 * to live selection, whereas a second instance is trivially discardable. So this
 * module owns a Tiptap editor of its own, built from the same §3 schema
 * ({@link caotangExtensions}, role `ghost`) and never wired to the focus document's
 * change, selection or autosave events.
 *
 * ## Lanes: the ghost is in neither
 *
 * Every ghost transaction goes through {@link markLane} with `historyExcluded`, so it
 * carries `addToHistory: false` **and** `closeHistory` — the same pair §7 rule 1
 * measured as necessary for an agent turn. The instance also has no history plugin,
 * so there is no undo stack for a ghost transaction to enter in the first place; the
 * meta is what keeps that true if the extension set ever gains one. §8 states the
 * same rule: "ghost text is never in Lane 1, and the ghost turn is a boundary in it".
 *
 * ## Apply, Retry and Discard are callbacks, not writes
 *
 * §8 makes the buttons render-only and the write the harness's: Apply issues a bus
 * command, and the ghost is cleared only after the store notification lands. So
 * {@link GhostPreview.apply} hands the streamed body to the caller and does **not**
 * clear the ghost, because clearing before the write would show the user a gap
 * between "applied" and "present". Retry and Discard clear the ghost first, as §8
 * says, and then notify, because the doc is untouched by either.
 *
 * ## A failed stream keeps its text and cannot be applied
 *
 * §8's abort path is {@link GhostPreview.fail}: the partial text stays, an error note says why,
 * Apply is unavailable, and a later append is ignored. The harness calls it when the gateway
 * aborts or errors, so the ghost never shows a stream that has stopped as if it were complete.
 */
import { Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import type { GhostController } from '../seam.js';
import { markLane } from '../lanes.js';
import { caotangExtensions } from './extensions.js';
import { DEFAULT_EDITOR_LABELS, type EditorLabels } from './labels.js';

/** §8's three buttons, as the caller's handlers. Each is optional. */
export interface GhostCallbacks {
  /**
   * Apply: the streamed body so far, for the harness to write through the bus. The
   * ghost is **not** cleared here; the caller clears it when the store notification
   * arrives (§8: "store notification → … → ghost cleared").
   */
  onApply?: (body: string) => void;
  /** Retry: the ghost has been cleared; the harness re-streams with the same context. */
  onRetry?: () => void;
  /** Discard: the ghost has been cleared (§8: "`ghost.clear()` only"). */
  onDiscard?: () => void;
}

/**
 * §8's `GhostController`, widened by the three buttons. `append` and `clear` are the
 * seam's two methods unchanged; `text` reads what has been streamed, so Apply can
 * hand it over and a caller can tell an empty ghost from a cleared one.
 */
export interface GhostPreview extends GhostController {
  /** The streamed text so far, as the harness appended it. */
  text(): string;
  /** Whether Apply is available: there is streamed text, and the stream has not failed (§8). */
  canApply(): boolean;
  /**
   * §8's stream failure, for an abort or an error. Keeps the partial text, shows `reason` in an
   * error note, makes Apply unavailable, and ignores every later append (no zombie stream). Retry
   * and Discard stay live.
   */
  fail(reason: string): void;
  /** The reason the stream failed, or `null`. Cleared by `clear`, Retry and Discard. */
  failure(): string | null;
  /** Hands {@link text} to `onApply`. A no-op while the ghost is empty or the stream has failed. */
  apply(): void;
  /** Clears the ghost, then calls `onRetry`. */
  retry(): void;
  /** Clears the ghost, then calls `onDiscard`. */
  discard(): void;
  /** Destroys the preview's editor. The ghost is unusable afterwards. */
  destroy(): void;
}

/**
 * Builds the preview inside `element`, which the caller has already placed in the
 * editor pane. The element is hidden until the first append, so an empty ghost
 * takes no room below the focus document.
 */
export const createGhostPreview = (
  element: HTMLElement,
  callbacks: GhostCallbacks = {},
  labels: EditorLabels = DEFAULT_EDITOR_LABELS,
): GhostPreview => {
  const editor = new Editor({
    element,
    extensions: caotangExtensions({ role: 'ghost', labels }),
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    editable: false,
    injectCSS: false,
    editorProps: {
      attributes: { 'aria-readonly': 'true', 'aria-label': labels.ghostRegion },
    },
  });
  let streamed = '';
  /** §8's stream failure, or `null` while the stream is healthy. */
  let stopped: string | null = null;
  let destroyed = false;
  // The failure note sits beside the view and not inside it, so no ghost transaction can change it.
  const note = element.ownerDocument.createElement('p');
  note.className = 'caotang-ghost-error';
  note.setAttribute('role', 'alert');
  element.append(note);

  /** Apply is available only for a healthy stream that has text. */
  const canApply = (): boolean => !destroyed && stopped === null && streamed.length > 0;

  /**
   * Brings the region's visibility, its Apply state and its note into line with the stream. The
   * region is shown while it has text or a failure to report, so an aborted stream with no text
   * still says so.
   */
  const sync = (): void => {
    element.hidden = streamed.length === 0 && stopped === null;
    element.dataset['apply'] = canApply() ? 'enabled' : 'disabled';
    element.dataset['failed'] = stopped === null ? 'false' : 'true';
    note.hidden = stopped === null;
    note.textContent =
      stopped === null
        ? ''
        : labels.ghostStopped(stopped);
  };
  sync();

  /** A ghost transaction is never in either lane, so it always carries the pair. */
  const dispatch = (build: (tr: Transaction) => Transaction): void => {
    if (destroyed) return;
    editor.view.dispatch(markLane(build(editor.state.tr), { historyExcluded: true }));
    sync();
  };

  /**
   * The position at the end of the last paragraph. The ghost is always a sequence of
   * paragraphs, so this is the one place a streamed delta can go.
   */
  const endOf = (doc: PmNode): number => doc.content.size - 1;

  const clearGhost = (): void => {
    streamed = '';
    stopped = null;
    dispatch((tr) =>
      tr.replaceWith(0, editor.state.doc.content.size, editor.schema.nodes['paragraph']!.create()),
    );
  };

  return {
    append(delta: string): void {
      // After a failure nothing more arrives: the partial text is what the stream produced.
      if (destroyed || stopped !== null || delta.length === 0) return;
      streamed += delta;
      // A newline starts a new paragraph, so a streamed Markdown block reads as blocks
      // in the preview; a bare text run is inserted at the end of the last paragraph.
      dispatch((tr) => {
        const parts = delta.split('\n');
        parts.forEach((part, index) => {
          if (index > 0) tr.split(endOf(tr.doc));
          if (part.length > 0) tr.insertText(part, endOf(tr.doc));
        });
        return tr;
      });
    },

    clear(): void {
      if (destroyed) return;
      clearGhost();
    },

    text: () => streamed,

    canApply,

    fail(reason: string): void {
      if (destroyed) return;
      stopped = reason;
      sync();
    },

    failure: () => stopped,

    apply(): void {
      if (!canApply()) return;
      callbacks.onApply?.(streamed);
    },

    retry(): void {
      if (destroyed) return;
      clearGhost();
      callbacks.onRetry?.();
    },

    discard(): void {
      if (destroyed) return;
      clearGhost();
      callbacks.onDiscard?.();
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      editor.destroy();
    },
  };
};
