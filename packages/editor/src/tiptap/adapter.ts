/**
 * [editor-engine.md] §4 — the Tiptap adapter: `EditorApi.mount` on a DOM element,
 * and the live half of §6, §7, §8 and §9 that the headless seam could not exercise.
 *
 * ## Where this sits
 *
 * `src/index.ts` is the headless surface and must stay importable without an engine,
 * a DOM or a store. This module is the one that needs all three, so it is exported
 * from its own entry point (`@caotang/editor/tiptap`) and not from the barrel. Nothing
 * in the headless modules imports it.
 *
 * ## What the adapter is built on, and what it is not allowed to decide
 *
 * The document is a `@tiptap/core` editor whose schema is §3's
 * ({@link caotangExtensions} is the proof). Every rule that decides what a Markdown
 * body *is* — parsing, serializing, the projection map, the lanes, the dialect
 * notices — runs on the headless modules, on a `caotangSchema` copy of the live
 * document. The adapter adds only what needs a view: the DOM, the selection the view
 * reports, and the transactions the view receives.
 *
 * ## The decisions that are not obvious from the spec
 *
 * 1. **Serialization runs on a `caotangSchema` copy, transactions run on the live
 *    schema.** `remark-prosemirror` compares node types by identity against the
 *    node's own schema, and the live schema is a different instance. The copy is
 *    made from the document's JSON, which has §3's names by construction, so the
 *    headless code sees exactly what the headless tests see.
 * 2. **The body is derived on demand; the offset map only when an offset is asked
 *    for.** A flush or a keystroke needs the body string and nothing else, so `body()`
 *    serializes and stops. The projection map is built only by the members that take or
 *    return offsets (`getSelection`, `captureAnchor`, `revealRange`, and the primitives).
 *    Both are cached per document state. Before this split a flush built the map, which
 *    is the quadratic step.
 * 3. **Lane 1 and Lane 2 are told apart by the transaction's own meta, not by which
 *    method was called.** {@link markLane} is the only writer of `addToHistory: false`,
 *    and every lane decision in this file reads that meta back from the transaction. So
 *    a transaction carrying it is an agent apply or a restore, and anything else is the
 *    user's. That is what makes the autosave pipeline's "user edits only" rule hold for
 *    undo as well: an undo is the user's.
 * 4. **Autosave is the store's clock, not a second one.** The caller creates the
 *    store's `createAutosave` and passes it in. The store owns the 800 ms debounce, the
 *    one write in flight, the failure and conflict states, the dirty flag and the
 *    revision a write is based on. This file forwards every user edit to `noteEdit`,
 *    reads `status`, and has no timer, no flush and no constant of its own. Without a
 *    store there is no acknowledgement, so the editor keeps its own dirty flag.
 * 5. **An agent apply never replaces unsaved user edits.** §8 and §9 say an apply over
 *    the user's mid-keystroke body is a conflict with the ghost preserved, and that a
 *    conflict is not data loss. So {@link TiptapEditorInstance.setContent} refuses with
 *    {@link UnsavedEditsError} while edits are unsaved, and leaves the document and the
 *    ghost as they were. A restore is the one replacement that may discard them, and it
 *    says so with `discardUnsaved`, which is §7 rule 3's explicit confirmation.
 * 6. **The primitives read their text as body Markdown, and an agent edit cannot reach
 *    the user's undo.** `replaceRange` and `insertAtSelection` parse their text with
 *    `insertionOf`, so `*x*` saves as `_x_`. An agent edit that overlaps
 *    the span the user's undo can reach empties that undo (`undo-scope.ts`, §7 rule 1),
 *    because `prosemirror-history` would otherwise rebase the user's inverse steps over
 *    the agent's text.
 */
import { Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { EditorState, Selection, TextSelection } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import type { Autosave, AutosaveState, AutosaveStatus, FlushReport } from '@caotang/store';
import { countBody } from '@caotang/store';
import { CONTEXT_CHARS, MAX_EXACT_CHARS } from '../edit-anchors.js';
import { laneOf, markLane } from '../lanes.js';
import type { LaneOptions } from '../lanes.js';
import { insertionOf, parseWithDiagnostics, serialize } from '../pipeline.js';
import type { ParseResult } from '../pipeline.js';
import { caotangSchema } from '../schema.js';
import {
  bodyOffsetFromPmPos,
  buildProjectionMap,
  groupLossWarnings,
  textPositionFor,
} from '../seam.js';
import type {
  EditorApi,
  EditorInstance,
  EditorMountOptions,
  EditorSelection,
  LoadDiagnostics,
  LossWarningGroup,
  ProjectionMap,
  TextAnchor,
} from '../seam.js';
import { caotangExtensions } from './extensions.js';
import { createGhostPreview } from './ghost.js';
import type { GhostCallbacks, GhostPreview } from './ghost.js';
import {
  HISTORY_JOURNAL_VERSION,
  HISTORY_MAX_ENTRIES,
  createHistoryRing,
  freshState,
  historyKindOf,
  replayEntries,
  schemaSignature,
} from './history-journal.js';
import type { HistoryJournal, HistoryPort } from './history-journal.js';
import { insertedSpans, reachesScope, replacedSpans, shrinkSpan, unionSpan } from './undo-scope.js';
import type { Span } from './undo-scope.js';

/**
 * The seam's mount options, plus what only the live editor needs. Every addition is
 * optional, so a caller that passes an `EditorMountOptions` gets the seam's behaviour.
 */
export interface TiptapMountOptions extends EditorMountOptions {
  /**
   * The document's revision as the store last reported it. **Required with `autosave`**:
   * the store's scheduler will not write a body it has no revision for (§9's guard), and
   * a mount without one is a programmer error. Without a store it is the number
   * `captureAnchor` reports, and {@link TiptapEditorInstance.setRevision} moves it.
   */
  revision?: number;
  /**
   * The store's autosave scheduler (`createAutosave` from `@caotang/store`), created and
   * owned by the caller. The editor opens the document on it at mount, forwards each user
   * edit to it, and asks it to flush on teardown. Its lifecycle signals (`pagehide`,
   * `visibilitychange`) are the caller's to wire when it creates the scheduler.
   */
  autosave?: Autosave;
  /** §8's Apply, Retry and Discard handlers. */
  ghost?: GhostCallbacks;
  /**
   * §7: Lane 1's history across a reload. The app hands in the journal it kept for the document and is told when the history changes. The
   * journal rebuilds the user's undo only if it replays to the body the editor opened with (`history-journal.ts`).
   */
  history?: HistoryPort;
  /** §10's empty-document hint. */
  placeholder?: string;
  /** Default `true`, which is Tiptap's own default. Pass `false` if the app owns the stylesheet. */
  injectCSS?: boolean;
  /**
   * Whether the browser's spellchecker runs over the focus document. Default `false`, which is
   * editor-engine.md D9: Chromium's spellcheck is a documented severe slowdown at manuscript scale,
   * so turning it on is the app's decision, per document.
   */
  spellcheck?: boolean;
  /**
   * The save state changed for this document: an edit, a write, a failure or a conflict (§9). It is
   * driven by the store's own notifications, so a failed flush reaches the app without polling.
   * Without a store it reports the editor's own edits.
   */
  onSaveStatusChange?: (status: EditorSaveStatus) => void;
}

/**
 * What the unsaved state is, as the store reports it (§9). A failed flush and a pending edit are not
 * the same state, so an indicator needs this and not `hasUnsavedEdits()` alone.
 */
export interface EditorSaveStatus {
  /** The store's state for the document. Without a store, `pending` while an edit is unsaved and `clean` otherwise. */
  readonly state: AutosaveState;
  /** The same answer as `hasUnsavedEdits()`: true while a body is unsaved or mid-write. */
  readonly dirty: boolean;
  /**
   * The last failure, with its cause. A `RevisionConflictError` from `@caotang/store` means the store moved on
   * and the edits are kept for the writer. `null` after a successful write, or when none has failed.
   */
  readonly lastError: unknown;
}

/**
 * The mount was refused because the store has moved the document past the body it was given, and holds
 * no unsaved body the editor could show instead: a write was still in flight, or a write
 * landed that this caller does not have. Taking the body would show a state the store has moved past,
 * and the next keystroke would replace the store's work with it. Nothing is mounted, and the store keeps
 * its work. Reload the document from the store, then mount again with that body and revision.
 *
 * An unsaved keystroke is not a reason to refuse: the mount shows it (see `settleStoreWork`).
 */
export class StaleMountError extends Error {
  constructor(readonly docId: string) {
    super(
      `"${docId}" has work in the store that the body given to mount does not have, so the editor ` +
        'will not mount over it; reload the document from the store and mount again',
    );
    this.name = 'StaleMountError';
  }
}

/**
 * The mount was refused because the store holds unsaved text it could not read:
 * the producer that yields the editor's own text failed.
 *
 * This is not the refusal {@link StaleMountError} names. The store has not moved
 * on, and it does hold unsaved work — the editor's text — but the editor cannot
 * show a body it could not read, and mounting over it would replace the store's
 * work with a body that does not have it. Nothing is mounted, and the store keeps
 * its text.
 *
 * The remedy is a mount again, because the flush a mount makes asks a failed
 * producer once more: a text that can be read now is stored, and the document is
 * then at a new revision — so reload it from the store and mount again, as
 * {@link StaleMountError} says. A text that still cannot be read is still the
 * store's to keep, and the failure is named here so the writer is told why.
 */
export class UnreadablePendingBodyError extends Error {
  constructor(
    readonly docId: string,
    readonly error: unknown,
  ) {
    super(
      `"${docId}" holds unsaved text the editor could not read (${describeFailure(error)}), so the editor ` +
        'will not mount over it; the store keeps the text, and mounting again reads it again',
    );
    this.name = 'UnreadablePendingBodyError';
  }
}

/** A failure in words, for a message that names it. */
const describeFailure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The seam's load diagnostics, grouped for the banner (grouping is a separate call). */
export interface LoadResult extends LoadDiagnostics {
  groups: LossWarningGroup[];
}

/** Options for `setContent`. The lane is `historyExcluded`, as on the seam. */
export interface SetContentOptions extends LaneOptions {
  /**
   * §7 rule 3's explicit restore: replace the document although it holds unsaved user
   * edits. The restore confirmation has already told the writer those edits go, so this
   * is the one replacement allowed to discard them. Without it an agent apply over
   * unsaved edits is refused. Only meaningful with `historyExcluded`.
   */
  discardUnsaved?: boolean;
  /**
   * With a store, on the agent lane: the revision the store holds for `body`, which is the
   * number the write that produced it settled on. The rebase sets the store's base to it in
   * the same step as the body (§9), so the next edit is written against the store's own
   * number. Absent, the base is the one the store reported when the replacement was made,
   * and the caller follows with {@link TiptapEditorInstance.setRevision}, as the desktop
   * app does today. Without a store it has no effect: the revision is {@link setRevision}'s.
   */
  revision?: number;
}

/**
 * An agent apply was refused because the user has unsaved edits in the document. The
 * document is unchanged, so the edits and the ghost survive (§8, §9).
 */
export class UnsavedEditsError extends Error {
  constructor(readonly docId: string) {
    super(
      `"${docId}" has unsaved edits, so an agent apply cannot replace the document; the edits are kept`,
    );
    this.name = 'UnsavedEditsError';
  }
}

/**
 * The seam's instance, widened by what the app needs from a live editor. The seam's
 * members are unchanged, so a function that takes an `EditorInstance` takes this too.
 */
export interface TiptapEditorInstance extends EditorInstance {
  readonly ghost: GhostPreview;
  /** The load's diagnostics, grouped. Updated by every `setContent`. */
  loadResult(): LoadResult;
  /**
   * The store moved this document to `revision`, and the editor's body is the store's
   * body. A caller whose body changed re-syncs with `setContent` first. With a store, a
   * pending user edit keeps the revision it was typed against, so its write conflicts and
   * does not overwrite the store's newer revision (§9). A call never schedules a write of
   * a body the store has not been told about.
   */
  setRevision(revision: number): void;
  /** Whether user edits are not yet stored. `captureAnchor` and an agent apply both read it. */
  hasUnsavedEdits(): boolean;
  /**
   * Sends the pending user edits now, if any, and reports what the store did with them. The
   * store keeps one write in flight, so a call during a write waits for it rather than
   * sending a second one. A failed write keeps its body, and calling this again retries it. A
   * `conflict` outcome means the store moved on, and the edits are kept for the writer to
   * resolve, not dropped (§9).
   */
  flush(): Promise<FlushReport[]>;
  /**
   * The document's save state (§9): the store's state, `dirty`, and the last failure with its cause.
   * The indicator reads this, so a failed flush shows as an error and a pending edit does not.
   */
  saveStatus(): EditorSaveStatus;
  /**
   * The persisted form of Lane 1's history (`history-journal.ts`), or `null` when there is none to keep. It serializes the ring's base, so a
   * caller asks once per write. It answers after teardown with what the editor held.
   */
  historyJournal(): HistoryJournal | null;
  /** Lane 1: the user's own undo. Never reverts an agent apply. */
  undo(): boolean;
  /** Lane 1: the user's own redo. */
  redo(): boolean;
  /**
   * Parses and replaces the document. Rejects with {@link UnsavedEditsError} for an agent
   * apply over unsaved user edits, unless `discardUnsaved` is set.
   *
   * With a store, an agent-lane replacement also rebases the store onto the body it puts in the
   * editor (`reseat`): the store's unsaved edits are dropped, and its persisted body becomes this one.
   * With `revision` given, the store's base moves to it in the same step; without it the base stays
   * the store's own until the app reports the new one with {@link setRevision}.
   *
   * **The app re-syncs the editor after a store-side body change.** The store's notices
   * now carry the body (`AutosaveEvent.body`), but the editor does not re-render from them yet. So an
   * agent apply, a restore or an undo-all that changes the stored body reaches the editor only when the
   * app calls this with `historyExcluded`, and then {@link setRevision}.
   */
  setContent(body: string, opts?: SetContentOptions): Promise<void>;
}

export interface TiptapEditorApi extends EditorApi {
  mount(host: HTMLElement, opts: TiptapMountOptions): Promise<TiptapEditorInstance>;
}

const assertElement = (host: unknown): HTMLElement => {
  if (host === null || typeof host !== 'object' || (host as { nodeType?: unknown }).nodeType !== 1) {
    throw new TypeError('EditorApi.mount: host must be an element (programmer error)');
  }
  return host as HTMLElement;
};

/**
 * A position text can be inserted at or selected from: `pos` itself when it sits in a
 * textblock, and otherwise the nearest such position. The seam's offsets are clamped
 * to text positions already, so this is the guard for a document whose only blocks hold
 * no text at all (an empty list item), where the seam's answer is a container position.
 */
const textPosition = (doc: PmNode, pos: number): number => {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  if ($pos.parent.inlineContent) return $pos.pos;
  return Selection.near($pos).from;
};

/** The store's status, in the shape the editor reports. */
const toSaveStatus = (status: AutosaveStatus): EditorSaveStatus => ({
  state: status.state,
  dirty: status.dirty,
  lastError: status.lastError,
});

/** The editor's own flag, for a document with no store to report on. Nothing fails without a store. */
const localSaveStatus = (dirty: boolean): EditorSaveStatus => ({
  state: dirty ? 'pending' : 'clean',
  dirty,
  lastError: null,
});

/** The body a mount shows, and the revision that body is based on. Without a store the revision is the caller's to report. */
interface MountSeed {
  readonly body: string;
  readonly revision: number | undefined;
}

/**
 * Before a mount takes its body, the store's outstanding work for the
 * document is settled, and the mount shows the body the store holds rather than the one it was given.
 *
 * A mount that took the body it was given would show a stored body while the store held a keystroke
 * that was not in it, and the next keystroke would replace the store's work with the stored body. So
 * the work is settled first. `flush` waits out a write in flight and sends a pending body, which leaves
 * the store clean, failed, or holding a body the flush could not send. Then:
 *
 * - **Unsaved keystrokes the store still holds** (a failed flush, or an edit that arrived while flushing)
 *   are what the editor shows, at the store's revision. The mount is not refused: the store keeps the
 *   keystrokes, so none is lost, and the editor shows them rather than an older body.
 * - **Unsaved text the store could not read** (a producer that failed) is refused with
 *   {@link UnreadablePendingBodyError}: the editor cannot show a body it could not read, and mounting
 *   over it would replace the store's work with a body that does not have it.
 * - **A flush that stored the unsaved body** leaves that body as the one the store holds, so the editor
 *   shows it at the revision the flush produced.
 * - **A write still running** has a body this caller cannot know yet, so the mount is refused.
 * - **A revision that moved without an unsaved body** was stored by a write the caller does not have,
 *   so the mount is refused rather than guessed at. The app reloads the document and mounts again.
 */
const settleStoreWork = async (
  autosave: Autosave,
  docId: string,
  loaded: { readonly body: string; readonly revision: number },
): Promise<{ readonly body: string; readonly revision: number }> => {
  // Read before the flush can store it: if the flush stores this body, it is the one the store holds after.
  const unsaved = autosave.pendingBodyOf(docId);
  const before = autosave.status(docId);
  if (!before.dirty) return loaded;
  await autosave.flush(docId);
  const after = autosave.status(docId);
  const pending = autosave.pendingBodyOf(docId);
  if (pending !== null) return { body: pending, revision: after.revision };
  if (after.dirty) {
    // The store still holds a body, and it is not one it can show: the producer
    // that yields the editor's text failed, and the failure is what the store
    // recorded. That is not the refusal `StaleMountError` names — the store has
    // not moved on, and it does hold unsaved work — so the cause is named
    // instead, and the store keeps the text.
    if (after.lastError !== null) throw new UnreadablePendingBodyError(docId, after.lastError);
    throw new StaleMountError(docId);
  }
  if (after.revision === before.revision) return loaded;
  if (unsaved !== null) return { body: unsaved, revision: after.revision };
  throw new StaleMountError(docId);
};

/**
 * The Tiptap implementation of §4's `EditorApi`. Parsing is async, as §5 says, so
 * `mount` is too; everything after it is synchronous except `setContent`.
 */
export const createTiptapEditorApi = (): TiptapEditorApi => ({
  async mount(host: HTMLElement, opts: TiptapMountOptions): Promise<TiptapEditorInstance> {
    const element = assertElement(host);
    if (opts.autosave !== undefined && opts.revision === undefined) {
      throw new TypeError(
        'EditorApi.mount: autosave needs the revision the body was loaded at (programmer error, §9)',
      );
    }
    const seed: MountSeed =
      opts.autosave !== undefined && opts.revision !== undefined
        ? await settleStoreWork(opts.autosave, opts.docId, { body: opts.initialBody, revision: opts.revision })
        : { body: opts.initialBody, revision: opts.revision };
    const loaded = await parseWithDiagnostics(seed.body);
    // The document the kept history started at, parsed here because the parse is asynchronous (§5) and the instance is built synchronously.
    const journal = opts.history?.journal;
    const historyBase =
      journal !== undefined && journal.version === HISTORY_JOURNAL_VERSION && journal.entries.length > 0
        ? await parseWithDiagnostics(journal.baseBody).catch(() => null)
        : null;
    return createInstance(element, opts, loaded, seed, historyBase);
  },
});

const createInstance = (
  host: HTMLElement,
  opts: TiptapMountOptions,
  loaded: ParseResult,
  seed: MountSeed,
  historyBase: ParseResult | null,
): TiptapEditorInstance => {
  const doc = host.ownerDocument;
  const docId = opts.docId;
  const autosave = opts.autosave;

  // The store is opened on the body the editor shows, at the revision that body is based on. With a
  // store, `settleStoreWork` has already chosen that body, which may be newer than the one given. `open`
  // keeps any work the store holds for this document, so a remount does not re-base it.
  if (autosave !== undefined && seed.revision !== undefined) {
    autosave.open(docId, { body: seed.body, revision: seed.revision });
  }

  // The DOM this instance owns. Two children: the focus document, and the ghost
  // region §8 renders below it. `destroy` removes the root and nothing else.
  const root = doc.createElement('div');
  root.className = 'caotang-editor';
  root.setAttribute('data-doc-id', docId);
  const focusEl = doc.createElement('div');
  focusEl.className = 'caotang-editor-focus';
  const ghostEl = doc.createElement('div');
  ghostEl.className = 'caotang-editor-ghost';
  root.append(focusEl, ghostEl);
  host.append(root);

  let destroyed = false;
  let load: LoadDiagnostics = { warnings: loaded.warnings, dialect: loaded.dialect };
  let lastBody = '';
  // The revision without a store. With one, the store's own `status().revision` is the number.
  let revision: number | undefined = seed.revision;
  // Without a store there is no record of what was saved, so the editor keeps its own
  // flag: a user edit sets it, and only a replacement of the document clears it.
  let editedLocally = false;
  // §7 rule 1's scope: the smallest span holding every text the user's undo can still
  // reach. `undo-scope.ts` explains why an agent apply is checked against it.
  let scope: Span | null = null;

  const editor = new Editor({
    element: focusEl,
    extensions: caotangExtensions({ role: 'focus', placeholder: opts.placeholder }),
    content: loaded.doc.toJSON(),
    editable: opts.readOnly !== true,
    injectCSS: opts.injectCSS ?? true,
    enableContentCheck: false,
    // D9: off unless the app turns it on, and set explicitly so the attribute says what the editor does.
    editorProps: { attributes: { spellcheck: opts.spellcheck === true ? 'true' : 'false' } },
  });

  // --- Lane 1's history journal (history-journal.ts) ---------------------------------
  const liveSchema = editor.schema;
  const ring = createHistoryRing();
  ring.reset(editor.state.doc);
  /** The state before the transaction being handled, which tells an undo from a redo. */
  let lastState = editor.state;
  const serializeDoc = (node: PmNode): string => serialize(caotangSchema.nodeFromJSON(node.toJSON()));
  const readJournal = (): HistoryJournal | null => ring.snapshot(serializeDoc, liveSchema);
  /** Tells the app the ring changed. Cheap by contract: the app reads the journal when it writes. */
  const announceHistory = (): void => opts.history?.onChange(readJournal);

  // --- Derived state, per document state (decisions 1 and 2) ---------------------
  interface Snapshot {
    readonly doc: PmNode;
    /** The document on `caotangSchema`, which is what serialization and the map read. */
    readonly copy: PmNode;
    text: string | null;
    map: ProjectionMap | null;
  }
  let snapshot: Snapshot | null = null;
  const current = (): Snapshot => {
    const live = editor.state.doc;
    if (snapshot === null || snapshot.doc !== live) {
      snapshot = { doc: live, copy: caotangSchema.nodeFromJSON(live.toJSON()), text: null, map: null };
    }
    return snapshot;
  };

  /** The body projection. Serializes only: no offset map is built to answer it. */
  const body = (): string => {
    if (destroyed) return lastBody;
    const shot = current();
    if (shot.text === null) shot.text = serialize(shot.copy);
    return shot.text;
  };

  /** The projection map, for the members that take or return offsets. Built at most once per document state. */
  const projection = (): ProjectionMap => {
    const shot = current();
    if (shot.map === null) shot.map = buildProjectionMap(shot.copy);
    return shot.map;
  };

  // --- Unsaved state and the revision the editor is based on ----------------------
  const unsaved = (): boolean => (autosave !== undefined ? autosave.status(docId).dirty : editedLocally);
  const currentRevision = (): number | undefined =>
    autosave !== undefined ? autosave.status(docId).revision : revision;
  const saveStatus = (): EditorSaveStatus =>
    autosave !== undefined ? toSaveStatus(autosave.status(docId)) : localSaveStatus(editedLocally);
  /** Tells the app the editor's own flag changed. The store reports its own changes, so this is for no store. */
  const publishLocal = (): void => {
    if (autosave === undefined && !destroyed) opts.onSaveStatusChange?.(localSaveStatus(editedLocally));
  };
  const setLocallyEdited = (value: boolean): void => {
    if (editedLocally === value) return;
    editedLocally = value;
    publishLocal();
  };

  /** §4's `getSelection`: body offsets, `null` when collapsed or when the range maps to nothing. */
  const getSelection = (): EditorSelection | null => {
    if (destroyed) return null;
    const selection = editor.state.selection;
    if (selection.empty) return null;
    const map = projection();
    // The end takes the earlier run at a markup boundary, so the range stops before the markup
    // that closes the run it selected (seam.ts, PmAssoc).
    const from = bodyOffsetFromPmPos(map, selection.from, 'start');
    const to = bodyOffsetFromPmPos(map, selection.to, 'end');
    return from === to ? null : { from, to };
  };

  const announce = (): void => {
    if (destroyed) return;
    opts.onSelectionChange?.(getSelection());
  };

  /**
   * The user's unsaved text, taken now, while the document still holds it.
   *
   * §9's window holds the body of the user's last edit, and the body belongs to the
   * **write**, not to the keystroke that armed the window: the editor offers a
   * producer, and the scheduler reads the text when the body is needed. So a change
   * that is not the user's — an agent apply, a restore, a body that arrived from
   * elsewhere — must not be read by that producer as if the user had typed it, and
   * must not be written under the user's revision.
   *
   * Asking the store for the pending body takes the text as it is now and keeps it:
   * the write that follows sends what the user typed, and the agent's change is the
   * agent's own write to make. This is asked for *before* the change lands, which is
   * the only moment the user's text is still the document's text.
   *
   * The store's `pendingBodyOf` is the ask: it produces a producer's body once and
   * keeps it, so the flush that follows writes that same text without asking again.
   *
   * **What the ask cannot do is freeze a text it could not read.** The producer
   * yields the editor's own text, so a read that fails is that text failing to be
   * read: the capture leaves the store's pending source a producer still, and the
   * change lands on top of it. The next attempt reads the text again, and what it
   * reads then is the text the change left behind — so a producer that failed once
   * and then succeeded stores the change's text under the user's revision. That is
   * the hazard this capture closes, and a failed read is the one case where it
   * stays open; the store records the failure, so the "unsaved changes" indicator
   * is what the writer has.
   *
   * **A text the store could not read also refuses the next mount.** The mount
   * shows the store's unsaved body, and a body it could not read is not a body it
   * can show: mounting over it would replace the store's work with a body that
   * does not have it. So the mount is refused with
   * {@link UnreadablePendingBodyError}, which names the failure rather than
   * blaming a store that has not moved. The store keeps the text, and the mount
   * reads it again — the flush a mount makes asks a failed producer once more, so
   * a text that can be read now is stored, and one that cannot is still the
   * store's to keep.
   *
   * **The lane is the one this file reads everywhere.** A change that is not the
   * user's is a transaction carrying `addToHistory: false`, and `markLane` is the
   * only writer of that meta — so a change that arrives without it is a user
   * change by §7's own definition, and it is counted as one.
   */
  const capturePending = (): void => {
    if (autosave === undefined) return;
    autosave.pendingBodyOf(docId);
  };

  /**
   * Every transaction the adapter makes goes through here, after its lane is marked. An
   * agent apply that reaches the user's undo scope empties that undo after it lands, so
   * the user's Ctrl+Z cannot rebase its inverse over the agent's text (§7 rule 1).
   */
  const commit = (tr: Transaction): void => {
    if (destroyed) return;
    const agent = tr.getMeta('addToHistory') === false;
    // A change that is not the user's, landing on a document with an unsaved edit of
    // the user's, must not become part of that edit's body. The body is taken first,
    // while the document still holds the user's text (§9).
    if (agent && tr.docChanged) capturePending();
    const collide = agent && tr.docChanged && reachesScope(replacedSpans(tr), scope);
    editor.view.dispatch(tr);
    if (collide) resetUndoHistory();
  };

  const dispatch = (tr: Transaction, laneOpts?: LaneOptions): void => {
    commit(markLane(tr, laneOpts));
  };

  /**
   * A fresh undo history over the same document and selection. This is the reset §7
   * rule 1 needs, and it is a view-level state swap: no transaction is emitted, so the
   * document is not saved or counted as an edit, and the redo stack goes with the undo.
   */
  const resetUndoHistory = (): void => {
    const state = editor.state;
    editor.view.updateState(
      EditorState.create({
        doc: state.doc,
        selection: state.selection,
        storedMarks: state.storedMarks,
        plugins: state.plugins,
      }),
    );
    scope = null;
    // The journal restarts with the history it records: a reload must not rebuild undo across the text that emptied it.
    lastState = editor.state;
    ring.reset(editor.state.doc);
    announceHistory();
  };

  /**
   * Shared by `replaceRange` and `insertAtSelection`: §4's primitive on the real view. The
   * text is body Markdown (`insertionOf`), so the offsets it is given and the offsets the
   * next projection reports are measured in the same spelling.
   */
  const replaceAt = (sel: EditorSelection, text: string, laneOpts?: LaneOptions): void => {
    if (destroyed) return;
    const map = projection();
    const from = textPositionFor(map, sel.from);
    const to = textPositionFor(map, sel.to);
    if (from === null || to === null) return;
    const live = editor.state.doc;
    const [start, end] = from <= to ? [from, to] : [to, from];
    const at = textPosition(live, start);
    const until = textPosition(live, end);
    const tr = editor.state.tr;
    if (text.length === 0) {
      dispatch(tr.delete(at, until), laneOpts);
      return;
    }
    // ProseMirror's fitting joins the blocks around a range that crosses a block boundary,
    // which is what replacing a selection across two paragraphs does in any editor.
    dispatch(tr.replace(at, until, insertionOf(text, editor.schema)), laneOpts);
  };

  // --- §9: the dirty pipeline is the store's (decision 4) -----------------------
  /**
   * A user edit: forwarded to the store's clock, or counted locally when there is no store.
   *
   * The body is offered as a **producer** (§9): the body belongs to the write, not to
   * the keystroke, so the text is read when the write needs it — once per window —
   * rather than rendered on the leading edge of every keystroke and thrown away.
   */
  const noteUserEdit = (): void => {
    if (autosave === undefined) {
      setLocallyEdited(true);
      return;
    }
    autosave.noteEdit(docId, () => body());
  };

  // --- The view's events -------------------------------------------------------
  /**
   * The scope after a transaction. Every transaction moves it with the text it covers, so the scope never points at text that has moved. A
   * user transaction, undo and redo included, grows it to cover what it changed. An agent transaction does not, because agent text is not
   * the user's.
   */
  const followScope = (from: Span | null, transaction: Transaction, appended: readonly Transaction[]): Span | null => {
    if (!transaction.docChanged) return from;
    let next = from;
    if (next !== null) {
      for (const tr of [transaction, ...appended]) next = shrinkSpan(next, tr.mapping);
    }
    if (transaction.getMeta('addToHistory') === false) return next;
    for (const span of insertedSpans(transaction, appended)) next = unionSpan(next, span);
    return next;
  };
  editor.on('transaction', ({ transaction, appendedTransactions }) => {
    const before = lastState;
    lastState = editor.state;
    if (destroyed || !transaction.docChanged) return;
    scope = followScope(scope, transaction, appendedTransactions);
    // §7: a Lane 2 change starts a new ring at the document it leaves, and a Lane 1 change is added to the ring.
    if (transaction.getMeta('addToHistory') === false) {
      ring.reset(editor.state.doc);
    } else {
      const kind = historyKindOf(before, editor.state, transaction);
      if (kind === null) ring.recordEdit(transaction);
      else ring.recordHistory(kind);
      if (ring.size() > HISTORY_MAX_ENTRIES) ring.compact((doc) => freshState(doc, editor.state.plugins), editor.state.doc);
    }
    announceHistory();
  });
  editor.on('update', ({ transaction }) => {
    if (destroyed) return;
    // Lane 2 is an agent apply or a restore. The store already holds it, so it is not
    // a user edit and schedules nothing. Everything else is the user's, undo included.
    if (transaction.getMeta('addToHistory') !== false) noteUserEdit();
    opts.onChange?.();
  });
  editor.on('selectionUpdate', announce);

  // A kept history is rebuilt only if it replays to the body this editor opened with. Anything else leaves the empty history it started with.
  if (opts.history?.journal !== undefined) {
    const journal = opts.history.journal;
    if (historyBase !== null && journal.schema === schemaSignature(liveSchema)) {
      try {
        const start = freshState(liveSchema.nodeFromJSON(historyBase.doc.toJSON()), editor.state.plugins);
        let followed: Span | null = null;
        const rebuilt = replayEntries(start, journal.entries, (tr, appended) => {
          followed = followScope(followed, tr, appended);
        });
        if (rebuilt !== null && serializeDoc(rebuilt.doc) === serializeDoc(editor.state.doc)) {
          editor.view.updateState(rebuilt);
          lastState = editor.state;
          scope = followed;
          ring.restore(start.doc, journal.entries);
        }
      } catch {
        // A journal that cannot be read is dropped like one that does not replay.
      }
    }
    // Told either way: a journal that did not rebuild is for the app to drop, or it would be tried again at every open.
    announceHistory();
  }

  const ghost = createGhostPreview(ghostEl, opts.ghost);

  // §9's indicator: the store announces each change to a document's save state. Another
  // document's change is not this editor's to report, so it is filtered here, and the
  // subscription ends with the editor.
  const unsubscribeSaves = autosave?.subscribe((event) => {
    if (destroyed || event.docId !== docId) return;
    opts.onSaveStatusChange?.(toSaveStatus(event.status));
  });

  // §4's carrier: the diagnostics of the load, by reference, once the editor exists.
  opts.onLoadDiagnostics?.(load);

  let loadSeq = 0;

  const instance: TiptapEditorInstance = {
    getContent: () => body(),

    setContent: async (text: string, setOpts?: SetContentOptions): Promise<void> => {
      const seq = (loadSeq += 1);
      const next = await parseWithDiagnostics(text);
      // A later call has superseded this one, or the editor is gone: the newer load wins.
      if (destroyed || seq !== loadSeq) return;
      // The lane is read from the options by the one reader there is (`laneOf`), the same one `markLane` uses.
      const agent = laneOf(setOpts) === 'agent';
      if (agent && unsaved() && setOpts?.discardUnsaved !== true) {
        // §8 and §9: an apply over the user's mid-keystroke body is a conflict. Nothing is
        // replaced, so the keystrokes and the ghost both survive, and the apply can be made
        // again once the edits are stored or the writer confirms the restore.
        throw new UnsavedEditsError(docId);
      }
      if (agent && autosave !== undefined) {
        // The store is rebased onto the body this apply puts in the editor, so the two agree. The
        // rebase drops unsaved edits. A plain apply has none left to drop (the check above refused
        // them), so only a restore with `discardUnsaved` changes anything here. It is awaited before
        // the replacement, so an edit typed during the wait is replaced along with the rest. The base
        // moves with the body when the caller names its revision. Without one, the base read here is
        // the one the store reported when the replacement was made; a write in flight that settles during
        // the wait has a newer revision, and `reseat` keeps that one, since it never moves the base back.
        await autosave.reseat(docId, {
          body: serialize(next.doc),
          revision: setOpts?.revision ?? autosave.status(docId).revision,
        });
        // A later load, or a teardown, that began during the wait supersedes this one.
        if (destroyed || seq !== loadSeq) return;
      }
      const replacement = editor.schema.nodeFromJSON(next.doc.toJSON());
      const tr = markLane(
        editor.state.tr.replaceWith(0, editor.state.doc.content.size, replacement.content),
        setOpts,
      );
      // The replacement puts the store's body in the editor, so the user's unsaved edits, if
      // any were discarded, are no longer unsaved. Cleared before the commit, because a user
      // replacement is itself an edit and the update event must be the one that sets the flag.
      if (agent) setLocallyEdited(false);
      commit(tr);
      load = { warnings: next.warnings, dialect: next.dialect };
      opts.onLoadDiagnostics?.(load);
      announce();
    },

    getSelection,

    captureAnchor: (): TextAnchor | null => {
      const selection = getSelection();
      // A target longer than the bound is not captured, because edit-anchors §2 bounds `exact` and
      // the resolver refuses a longer one, so the anchor could never resolve. The caller splits the
      // target into anchored steps.
      if (selection === null || selection.to - selection.from > MAX_EXACT_CHARS) return null;
      // `exact` is read from the body, so the anchor must describe the body its revision
      // names. While the user's keystrokes are unsaved the body is not that body, and an
      // anchor would quote text the stored document does not contain. The capture waits for
      // the write (edit-anchors §2).
      if (unsaved()) return null;
      const captured = currentRevision();
      if (captured === undefined) return null;
      const text = body();
      return {
        from: selection.from,
        to: selection.to,
        exact: text.slice(selection.from, selection.to),
        prefix: text.slice(Math.max(0, selection.from - CONTEXT_CHARS), selection.from),
        suffix: text.slice(selection.to, Math.min(text.length, selection.to + CONTEXT_CHARS)),
        capturedRevision: captured,
      };
    },

    revealRange: (sel: EditorSelection): void => {
      if (destroyed) return;
      const map = projection();
      const from = textPositionFor(map, sel.from);
      const to = textPositionFor(map, sel.to);
      if (from === null || to === null) return;
      const live = editor.state.doc;
      const [anchor, head] = from <= to ? [from, to] : [to, from];
      dispatch(
        editor.state.tr
          .setSelection(TextSelection.create(live, textPosition(live, anchor), textPosition(live, head)))
          .scrollIntoView(),
      );
    },

    insertAtSelection: (text: string, laneOpts?: LaneOptions): void => {
      if (destroyed) return;
      // The caret, or the end of a selection: a primitive inserts, it does not replace.
      const at = bodyOffsetFromPmPos(projection(), editor.state.selection.to);
      replaceAt({ from: at, to: at }, text, laneOpts);
    },

    replaceRange: (sel: EditorSelection, text: string, laneOpts?: LaneOptions): void => {
      replaceAt(sel, text, laneOpts);
    },

    ghost,

    wordCount: () => countBody(body()),

    focus: (): void => {
      if (!destroyed) editor.view.focus();
    },

    setRevision: (next: number): void => {
      if (destroyed) return;
      if (autosave !== undefined) {
        // The store owns the number. `open` on a document with outstanding work keeps that
        // work and its base, so a stale body is never re-labelled with the new revision (§9).
        autosave.open(docId, { body: body(), revision: next });
        return;
      }
      revision = next;
    },

    hasUnsavedEdits: (): boolean => !destroyed && unsaved(),

    // After teardown the store still owns the state, because `destroy` has handed it the last write.
    saveStatus,

    flush: async (): Promise<FlushReport[]> => {
      if (destroyed || autosave === undefined) return [];
      return autosave.flush(docId);
    },

    historyJournal: readJournal,

    undo: (): boolean => (destroyed ? false : editor.commands.undo()),

    redo: (): boolean => (destroyed ? false : editor.commands.redo()),

    destroy: (): void => {
      if (destroyed) return;
      // The teardown's own store writes are not this editor's to report, so the listener goes first.
      unsubscribeSaves?.();
      // §9: a pending edit is not lost by teardown. The store starts the write now, and keeps
      // the body if the write fails, so the edit is still the store's to retry.
      if (autosave !== undefined) void autosave.flush(docId);
      // The body is read while the view still exists, so `getContent` can answer after
      // teardown with what the document held, and not with whatever was read before.
      lastBody = body();
      destroyed = true;
      ghost.destroy();
      editor.destroy();
      root.remove();
    },

    loadResult: (): LoadResult => ({
      // Copies, so a caller that sorts or trims its banner cannot reorder §3.3's array.
      warnings: [...load.warnings],
      dialect: [...load.dialect],
      groups: groupLossWarnings(load.warnings),
    }),
  };

  return instance;
};
