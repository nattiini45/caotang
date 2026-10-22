/**
 * [editor-engine.md] §7 — **Lane 1 survives a reload**, rebuilt from a journal Caotang owns.
 *
 * `prosemirror-history` keeps its stack in a `Branch` that is not public API, and `@tiptap/extensions` wraps it, so serialising it would break on
 * any update of either. This module records the Lane 1 transactions instead, and rebuilds the history by *replaying* them through the public
 * API only: `Step.fromJSON`, `Transaction.setTime`, `undo` and `redo`. Replaying with each transaction's original `time` makes the library group
 * the events exactly as it did the first time (its 500 ms window reads `tr.time`).
 *
 * ## What is recorded
 *
 * A **ring** holds the document the ring started at (`base`) and, in order, what the writer did since:
 *
 * - `edit`: a user transaction's steps, its `time` and its IME `composition` id. Transactions a plugin appended to it are not recorded: the same
 *   plugins append them again when the edit is replayed.
 * - `undo` / `redo`: the writer's undo or redo. A replay runs the library's own commands, so the redo stack comes back as it was.
 *
 * A **Lane 2** transaction (an agent apply or a restore, `addToHistory: false`) and `resetUndoHistory` **start a new ring** at the document they
 * leave behind. That matches the rules the editor already keeps: agent edits never enter Lane 1, and a reset empties it (`undo-scope.ts`).
 *
 * ## What is checked before the history is trusted
 *
 * A journal rebuilds only when its `version` and `schema` signature are this build's, every step applies, and the document the replay ends at
 * serializes to the text the editor was opened with. Any other outcome throws the journal away and the editor starts with an empty history:
 * a wrong document is never risked for the sake of undo.
 *
 * ## Bounds
 *
 * The ring holds at most {@link HISTORY_MAX_ENTRIES} entries. Past that the oldest quarter is folded into `base` (the replay of those entries is
 * the new base), and the result is replayed and compared with the live document before it is kept; when the comparison fails the ring restarts
 * at the live document. The library keeps 100 events, so older entries only ever reach undo that the library itself would have dropped.
 */
import { redo, undo, undoDepth, isHistoryTransaction } from '@tiptap/pm/history';
import type { Node as PmNode, Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import type { Plugin, Transaction } from '@tiptap/pm/state';
import { Step } from '@tiptap/pm/transform';

/** The journal's format. A journal of another version is thrown away, never read. */
export const HISTORY_JOURNAL_VERSION = 1;

/** The most entries one ring holds before its oldest are folded into the base. */
export const HISTORY_MAX_ENTRIES = 3000;

/** One thing the writer did, in a form that survives `JSON.stringify` and the structured clone IndexedDB applies. */
export type JournalEntry =
  | {
      readonly kind: 'edit';
      /** `Step.toJSON()` of each step of the transaction. */
      readonly steps: readonly object[];
      /** `Transaction.time`, which the library's 500 ms grouping reads. */
      readonly time: number;
      readonly composition?: number;
    }
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' };

/** The persisted form of one document's Lane 1 history. */
export interface HistoryJournal {
  readonly version: number;
  /** {@link schemaSignature} of the schema the steps were made on. */
  readonly schema: string;
  /** The body Markdown of the document the ring started at. */
  readonly baseBody: string;
  readonly entries: readonly JournalEntry[];
}

/**
 * What the app hands the editor at mount, and what the editor tells it back.
 *
 * `journal` is what the app kept from an earlier page. `onChange` is told after the ring changes and does no work itself: `read` builds the
 * persisted form (it serializes the base), so the app calls it when it writes, which is once per debounce window and not per keystroke. `read`
 * answers `null` for an empty ring, and keeps working after the editor is destroyed.
 */
export interface HistoryPort {
  readonly journal?: HistoryJournal | undefined;
  readonly onChange: (read: () => HistoryJournal | null) => void;
}

/**
 * A signature of the schema: its node and mark names with their attribute names. A journal made on another one has steps this build cannot
 * read (for example once the schema gains marks), so it is discarded.
 */
export const schemaSignature = (schema: Schema): string => {
  const nodes = Object.entries(schema.nodes).map(([name, type]) => `${name}(${Object.keys(type.spec.attrs ?? {}).join('+')})`);
  const marks = Object.entries(schema.marks).map(([name, type]) => `${name}(${Object.keys(type.spec.attrs ?? {}).join('+')})`);
  return `${nodes.join(',')}|${marks.join(',')}`;
};

/** What a replay tells the caller about each transaction it applied, so the caller can follow along (the undo scope does). */
export type ReplayObserver = (transaction: Transaction, appended: readonly Transaction[]) => void;

/**
 * Applies journal entries to `state` through the public history API. Returns the state they lead to, or `null` when any step fails to apply or
 * an undo or redo has nothing to act on: a journal that does not replay is not one to trust.
 */
export const replayEntries = (
  state: EditorState,
  entries: readonly JournalEntry[],
  observe?: ReplayObserver,
): EditorState | null => {
  let current = state;
  try {
    for (const entry of entries) {
      if (entry.kind === 'edit') {
        const tr = current.tr;
        for (const json of entry.steps) {
          if (tr.maybeStep(Step.fromJSON(current.schema, json)).failed) return null;
        }
        tr.setTime(entry.time);
        if (entry.composition !== undefined) tr.setMeta('composition', entry.composition);
        const applied = current.applyTransaction(tr);
        observe?.(tr, applied.transactions.slice(1));
        current = applied.state;
        continue;
      }
      const held: { applied: ReturnType<EditorState['applyTransaction']> | null } = { applied: null };
      const from = current;
      const ran = (entry.kind === 'undo' ? undo : redo)(from, (tr) => {
        held.applied = from.applyTransaction(tr);
      });
      if (!ran || held.applied === null) return null;
      const first = held.applied.transactions[0];
      if (first !== undefined) observe?.(first, held.applied.transactions.slice(1));
      current = held.applied.state;
    }
  } catch {
    // A step or a document this schema cannot read (`Step.fromJSON` throws on one).
    return null;
  }
  return current;
};

/** A state over `doc` with the editor's own plugins and an empty history, to replay into. */
export const freshState = (doc: PmNode, plugins: readonly Plugin[]): EditorState => EditorState.create({ doc, plugins: [...plugins] });

/**
 * The per-document ring. It holds the base as a document (immutable, so free to keep) and serializes it only when a journal is asked for.
 */
export interface HistoryRing {
  /** Starts a new ring at `doc`, dropping everything recorded. */
  reset(doc: PmNode): void;
  /** Continues a rebuilt history: the ring that was replayed, so what the writer does next is added to it. */
  restore(base: PmNode, entries: readonly JournalEntry[]): void;
  /** Records a Lane 1 edit. */
  recordEdit(transaction: Transaction): void;
  /** Records the writer's undo or redo. */
  recordHistory(kind: 'undo' | 'redo'): void;
  /** How many entries the ring holds. */
  size(): number;
  /**
   * Folds the oldest quarter of the entries into the base when the ring is over its bound. `makeState` gives a fresh state to replay into.
   * The result is replayed and compared with `live`; on a mismatch the ring restarts at `live`.
   */
  compact(makeState: (doc: PmNode) => EditorState, live: PmNode): void;
  /** The persisted form, or `null` when nothing has been recorded since the ring started. */
  snapshot(serializeDoc: (doc: PmNode) => string, schema: Schema): HistoryJournal | null;
}

export const createHistoryRing = (): HistoryRing => {
  let base: PmNode | null = null;
  let entries: JournalEntry[] = [];
  // The serialized base is cached by the document it was made from, because a ring serializes its base once however often it is persisted.
  let cached: { readonly doc: PmNode; readonly body: string } | null = null;

  return {
    reset(doc) {
      base = doc;
      entries = [];
    },
    restore(doc, kept) {
      base = doc;
      entries = [...kept];
    },
    recordEdit(transaction) {
      const composition = transaction.getMeta('composition');
      entries.push({
        kind: 'edit',
        steps: transaction.steps.map((step) => step.toJSON() as object),
        time: transaction.time,
        ...(typeof composition === 'number' ? { composition } : {}),
      });
    },
    recordHistory(kind) {
      entries.push({ kind });
    },
    size: () => entries.length,
    compact(makeState, live) {
      if (base === null || entries.length <= HISTORY_MAX_ENTRIES) return;
      const drop = Math.floor(entries.length / 4);
      const folded = replayEntries(makeState(base), entries.slice(0, drop));
      if (folded !== null) {
        const rest = entries.slice(drop);
        const check = replayEntries(makeState(folded.doc), rest);
        if (check !== null && check.doc.eq(live)) {
          base = folded.doc;
          entries = rest;
          return;
        }
      }
      base = live;
      entries = [];
    },
    snapshot(serializeDoc, schema) {
      if (base === null || entries.length === 0) return null;
      if (cached === null || cached.doc !== base) cached = { doc: base, body: serializeDoc(base) };
      return { version: HISTORY_JOURNAL_VERSION, schema: schemaSignature(schema), baseBody: cached.body, entries: [...entries] };
    },
  };
};

/**
 * Which command a history transaction was: the library's undo takes an event off the done stack, its redo puts one back, so the depth of the
 * done stack falls on an undo only. (A redo onto a full stack leaves the depth where it was, which is still "not less".)
 */
export const historyKindOf = (before: EditorState, after: EditorState, transaction: Transaction): 'undo' | 'redo' | null => {
  if (!isHistoryTransaction(transaction)) return null;
  return undoDepth(after) < undoDepth(before) ? 'undo' : 'redo';
};
