/**
 * Debounced autosave — [project-format.md §4](docs/architecture/project-format.md)
 * and [editor-engine.md §9](docs/architecture/editor-engine.md).
 *
 * §4, quoted: "Debounced autosave: flush **≥ 800 ms after last edit**, plus
 * flush on `visibilitychange`/`pagehide`."
 *
 * §9, quoted: "**Dirty pipeline:** `onChange` → debounce **800 ms** → dispatch
 * `doc.write {docId, body, expectedRevision}` (`issuedBy: 'user'`) → store write
 * (one IndexedDB transaction) → `doc.revision` bump → subscribers. Plus flush on
 * `visibilitychange`/`pagehide` ([project-format.md](project-format.md) §4).
 * Flush failure → dirty flag + non-blocking 'unsaved changes' indicator; next
 * flush retries; IndexedDB atomicity makes partial writes impossible."
 *
 * ## What this file is, and what it deliberately is not
 *
 * `store.ts` is the store; this is the clock on top of it, and it is **not a second
 * write path**. Every flush goes through `writeDocumentBody`, so §4's "every
 * mutation is one IndexedDB transaction" is inherited rather than reimplemented.
 * A second write function here would be a third way for a body to reach storage,
 * and "exactly one way a body is written" is the whole of the argument.
 *
 * What this file owns is exactly four things: the debounce window, the pending
 * body, the revision that pending body is based on, and the state the
 * "unsaved changes" indicator reads. Everything else belongs to the store.
 *
 * ## When the body is captured
 *
 * §9's pipeline is "`onChange` → debounce **800 ms** → dispatch `doc.write {docId,
 * body, expectedRevision}`", so the body belongs to the **write**, not to the
 * keystroke that armed the window. A note may therefore carry the body itself or a
 * **producer** — a thunk that yields the text when the body is needed — and the
 * scheduler calls the producer once, when the body is needed: at the flush, or
 * earlier if a caller asks for the pending body.
 *
 * The reason is cost. An editor that renders its text on demand (the Markdown
 * projection of a whole scene) would otherwise render it on the leading edge of
 * every keystroke and throw away all but the last one — the debounce exists to
 * amortize that work, and this is where it is amortized instead.
 *
 * **The body a producer yields is the text as it is when it is called.** A producer
 * reads the document it was made for, so a document closed before the window
 * closes still writes its own text, and an editor that has been torn down hands
 * over the last text it had.
 *
 * ## The revision a flush carries
 *
 * §9 is explicit — "autosave flushes carry the revision they were based on" and
 * "Revision source of truth: the bus/store, never the editor" — so this file
 * never *computes* a revision. `open()` seeds the one the document was loaded
 * at, and every later one is whatever the store's write returned. That is worth
 * more than it sounds: a scheduler that tracked `revision + 1` itself would
 * quietly disagree with storage the first time a write was a no-op or the second
 * tab won a race, and the guard it feeds would then be comparing against a number
 * that was never real.
 *
 * ## One write in flight per document
 *
 * An edit that lands while a flush is in flight must **not** start a second one.
 * Two concurrent writes to one row get serialized by IndexedDB, and the second
 * would carry the revision the first was about to replace — so autosave would
 * conflict with itself on precisely the input it exists for, a fast typist on a
 * slow disk. So a document has at most one write running; the pending body waits
 * for it and is then written against the revision that write produced.
 *
 * ## A failure is a state, not a loop
 *
 * §9 says a failed flush sets a dirty flag and a non-blocking indicator, and
 * that the *next* flush retries. It names no interval, and inventing one would
 * be inventing a policy: a retry armed on the debounce interval is a tight loop
 * against a store that is failing for a reason a loop cannot fix (a full disk),
 * and it would keep the "unsaved changes" indicator blinking. So a failure keeps
 * the body, records the error, and arms nothing. The next edit, the next
 * lifecycle flush, or an explicit `flush()` retries it — and §8's
 * close-if-dirty surface is what tells the user it is still unsaved.
 *
 * **A producer that fails is the one exception, and it is armed once.** A failed
 * *write* is the store failing, and the store keeps failing; a failed
 * *producer* is the editor's own text failing to be read, and the next attempt
 * may well succeed — an editor that is mid-teardown answers with the last text
 * it had, and a document that was re-rendered is readable again. So the window
 * is armed again for that one attempt, at the debounce interval. **One**, and no
 * more: a producer that fails every time would otherwise be retried forever,
 * which is the loop this section refuses. After that one retry the failure
 * stands like any other — the next edit, the next lifecycle flush, or an
 * explicit `flush()` retries it — and the pending source is kept either way, so
 * the text is never the thing that is lost.
 *
 * A **conflict** is a different failure and must not be retried at all: the
 * stored revision has moved to somebody else's write, so re-sending the same
 * stale `expectedRevision` can only conflict again, forever. The body is kept
 * (losing it is the one failure this file exists to prevent) and the conflict is
 * surfaced. Resolving it is not this file's job — §9 says it "surfaces the
 * command-bus conflict envelope", and that envelope is the bus's.
 *
 * ## Which body a failure keeps
 *
 * The newest one, and that distinction is load-bearing. A write takes several hundred milliseconds, a fast
 * typist does not pause for it, and so a failed write is *routinely* followed by
 * edits the failure has nothing to do with. Restoring the body that failed over
 * the one that arrived afterwards discards those keystrokes silently — the next
 * flush succeeds, the indicator clears, and the text is gone. Bodies are whole
 * documents rather than deltas, so the rule has no exceptions to reason about,
 * and the argument is **recency, not containment**: a pending body is a whole
 * document taken *after* the one that failed, so it replaces it whatever its
 * content. Restoring the older one can only destroy and never recovers, so
 * there is no ordering of edits in which keeping it is the right answer.
 *
 * Containment is not the argument, because it is false in exactly the case that
 * matters: an undo or a select-all-delete that lands while the write is in
 * flight produces a pending body containing **none** of the failed one, and `a`
 * is not a superstring of `bbbb`. A containment rule would restore `bbbb` over
 * the user's undo; `keeps a mid-flight edit that undid the failed write` in the
 * suite is what pins this.
 *
 * The same reasoning is why a failed write needs no rebasing. §9's atomicity
 * claim means storage did not move, so a pending body is still based on the
 * revision the slot already holds — and the retry after a failure is based on the
 * same number the failed one carried, which is what makes a conflict permanent
 * rather than self-healing.
 *
 * ## A rebase is not a write
 *
 * A restore, an agent apply or an undo-all changes the stored body under an editor,
 * and the store has to learn that without a second write. {@link Autosave.reseat}
 * does it: it waits out the running write, drops the unsaved body, and sets the
 * persisted body to the one it is given and the base revision to the revision the
 * caller names, in one step. It is the one place the slot's stored state moves other
 * than a write's own settle, and it comes last, because a settle that landed after it
 * would put back the state it replaced. The base never moves backwards (see `reseat`).
 * It drops the unsaved body on purpose: the restore that calls it has decided that
 * the unsaved text is obsolete, and keeping it would store the text it removed.
 */

import type { DocWriteParams } from '@caotang/bus';
import { countBody } from '../word-count.js';
import type { SessionTracker } from '../sessions.js';
import {
  RevisionConflictError,
  writeDocumentBody,
  type RuntimeStore,
  type WriteDocumentResult,
} from './store.js';

/**
 * §4: "flush ≥ 800 ms after last edit". The spec's own number, in one place, so
 * the window is not a magic value in a test and a different one in the code.
 */
export const AUTOSAVE_DEBOUNCE_MS = 800;

// ---------------------------------------------------------------------------
// Platform bindings
// ---------------------------------------------------------------------------

/**
 * The timer seam.
 *
 * A parameter rather than a global, for the same reason `openRuntimeStore`
 * takes an `IDBFactory`: the IndexedDB binding schedules its own work on real
 * `setTimeout(…, 0)`, so a test that faked the global clock to drive the debounce
 * would also freeze the storage underneath it. A seam keeps the two independent
 * and makes "flush no earlier than 800 ms" an exact assertion rather than a
 * sleep.
 */
export interface AutosaveClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The browser's timers. */
export const systemClock: AutosaveClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Where the §4 lifecycle flush comes from.
 *
 * `visibilitychange` and `pagehide` have no `node` equivalent, so the events are
 * a port for the same reason the IndexedDB factory is: the production binding is
 * two `addEventListener` calls, and a test can drive them exactly.
 */
export interface FlushSignalSource {
  /** Begin signalling; returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export interface FlushSignalTargets {
  /** `document` — fires `visibilitychange`. */
  readonly visibility: EventTarget;
  /** `window` — fires `pagehide`. */
  readonly page: EventTarget;
}

/**
 * The browser binding for the §4 lifecycle flush.
 *
 * The handler is **unconditional** — it flushes on a `visibilitychange` to
 * *visible* as readily as to `hidden`, and on a `pagehide` that the page will
 * resume from the back/forward cache as readily as one it will not. §4 says
 * "flush on `visibilitychange`/`pagehide`" without qualifying either, and the
 * qualification is unnecessary: a document with nothing pending flushes nothing,
 * so the redundant fire costs no transaction and no revision. A filtered
 * handler would need its filter to be right in every case, and getting it wrong
 * is a lost edit rather than a wasted no-op.
 *
 * Note what a `pagehide` flush can and cannot promise: it *starts* the write
 * before the page goes away, which in the ordinary case is all that is needed
 * because `visibilitychange`→hidden has already fired and had the whole tab to
 * finish in. Whether a browser completes an IndexedDB transaction started during
 * teardown is not this app's to decide — which is exactly why the dirty state is
 * observable rather than assumed away.
 */
export function domFlushSignals(targets: FlushSignalTargets): FlushSignalSource {
  return {
    subscribe(listener) {
      targets.visibility.addEventListener('visibilitychange', listener);
      targets.page.addEventListener('pagehide', listener);
      return () => {
        targets.visibility.removeEventListener('visibilitychange', listener);
        targets.page.removeEventListener('pagehide', listener);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The write port
// ---------------------------------------------------------------------------

export interface DocumentWriteRequest {
  readonly projectId: string;
  readonly docId: string;
  readonly body: string;
  /**
   * §9: "autosave flushes carry the revision they were based on". Non-optional
   * here even though the bus's `doc.write` makes it optional — the user path
   * always has one, because `open()` is what supplies it.
   */
  readonly expectedRevision: number;
}

/**
 * The one seam between this scheduler and storage.
 *
 * It can be bound straight to the runtime store's `writeDocumentBody`, or to a
 * `doc.write` dispatch (`issuedBy: 'user'`, one undo group
 * per debounce window — [command-bus.md §9](docs/architecture/command-bus.md)),
 * and the request shape above is deliberately the command's params.
 */
export type DocumentWriter = (request: DocumentWriteRequest) => Promise<WriteDocumentResult>;

// ---------------------------------------------------------------------------
// Observable state — what the "unsaved changes" indicator renders from
// ---------------------------------------------------------------------------

/**
 * - `clean` — nothing outstanding.
 * - `pending` — unsaved work, a flush is scheduled.
 * - `saving` — a write is in flight; still dirty, because it is not stored yet.
 * - `error` — the last flush failed; dirty, and no retry is armed. A failed
 *   *producer* is the one case that arms one: see "A failure is a state, not a
 *   loop" in this file's header.
 *
 * **`error` is one-way, and it is the weaker half of an implication.**
 * `state === 'error'` means the last flush failed, but the converse does not
 * hold: a failure that a newer edit answered arrives as `'pending'`, because
 * `noteEdit` armed a window. `AutosaveStatus.lastError` — not this field — is
 * where a failure is visible, and it is non-null under both states.
 *
 * `clean` with a non-null `lastError` is reachable too: a body edited back to
 * what is stored takes `runFlush`'s `unchanged` path, which opens no
 * transaction and so clears nothing.
 */
export type AutosaveState = 'clean' | 'pending' | 'saving' | 'error';

export interface AutosaveStatus {
  readonly state: AutosaveState;
  /**
   * §9's dirty flag. True while a body is unsaved *or* mid-write, and it stays
   * true after a failed write, because the body is still only in memory.
   */
  readonly dirty: boolean;
  /** The revision the next flush will be based on. */
  readonly revision: number;
  /** The last flush failure, cleared by the next success. */
  readonly lastError: unknown | null;
}

export interface AutosaveEvent {
  readonly docId: string;
  readonly status: AutosaveStatus;
  /**
   * The body the scheduler now holds for the document: the unsaved one while an
   * edit waits, otherwise the newest body it has taken for a write or been
   * reseated to. An editor that re-renders from a store change compares this with
   * its own body, so a notice about its own keystroke carries the body it already
   * shows and changes nothing. Carried by reference, so it costs no copy.
   *
   * A body that was offered as a producer is not in here until it has been
   * produced: the notice carries the last body the scheduler knows, and the
   * pending one arrives with the write it belongs to.
   */
  readonly body: string;
}

export type FlushOutcome =
  /** A write committed and changed the body. */
  | 'saved'
  /** Nothing to do, or the body was already exactly what is stored. */
  | 'unchanged'
  /** A write for this document is already in flight; the caller joined it. */
  | 'skipped'
  /** The write failed for a reason other than a revision conflict. */
  | 'failed'
  /** [command-bus.md §6](docs/architecture/command-bus.md)'s optimistic-concurrency mismatch. */
  | 'conflict';

export interface FlushReport {
  readonly docId: string;
  readonly outcome: FlushOutcome;
  /** The revision after a successful write. */
  readonly revision?: number;
  readonly error?: unknown;
}

/**
 * The bus route for a flush: [command-bus.md §9](docs/architecture/command-bus.md)'s
 * `doc.write`, handed over as its params.
 *
 * Optional, and absent by default, in which case the write port is used exactly
 * as before. When given, each flush goes here instead of to the write port, and
 * the params are the command's own — `expectedRevision` is always set, because a
 * flush without its guard is the one write §9 forbids. The dispatcher answers with
 * the same result a store write does, so the scheduler is indifferent to the
 * route it was given. Issuing the command (and the undo group it lands in) is the
 * caller's, since only the caller holds the bus context.
 */
export type DocumentDispatch = (params: DocWriteParams) => Promise<WriteDocumentResult>;

interface AutosaveCommonOptions {
  readonly projectId: string;
  readonly clock?: AutosaveClock;
  /** Omit for no lifecycle flush; the app passes {@link domFlushSignals}. */
  readonly signals?: FlushSignalSource;
  readonly debounceMs?: number;
  /** Route flushes through the bus as `doc.write`; see {@link DocumentDispatch}. */
  readonly dispatch?: DocumentDispatch;
  /**
   * The writing-session tracker this autosave feeds (sessions.ts). Each flush that
   * stores a change is counted into the session that is open at that moment, so
   * `sessions.jsonl` is produced by the writes themselves. Begin and end stay the
   * caller's: only the app knows where a sitting starts and stops.
   */
  readonly sessions?: SessionTracker;
}

/**
 * Exactly one way to write, named explicitly.
 *
 * `source: 'store'` writes the runtime store directly. `source: 'write'` is for a
 * flush that dispatches `doc.write` through the bus — and it is how this file's own
 * tests run, because a scheduler test has no reason to open a database. Making
 * it a tagged union rather than two optional fields means "both were passed" and
 * "neither was passed" are type errors instead of a silent preference order.
 */
export type AutosaveOptions = AutosaveCommonOptions &
  (
    | {
        readonly source: 'store';
        readonly store: RuntimeStore;
        /** Overrides the store binding — the seam for a test or a spy. */
        readonly write?: DocumentWriter;
      }
    | {
        readonly source: 'write';
        readonly write: DocumentWriter;
        readonly store?: never;
      }
  );

/**
 * The body an edit offers: the text itself, or a producer that yields it when the
 * body is needed.
 *
 * A string is a body the caller already has. A producer is a body the caller can
 * produce on demand — the editor's own text, rendered when the write needs it —
 * and the scheduler calls it once per pending edit, when the body is needed. See
 * "When the body is captured" in this file's header.
 */
export type BodySource = string | (() => string);

export interface Autosave {
  /**
   * Begin autosaving a document, at a known revision.
   *
   * Mirrors [editor-engine.md §4](docs/architecture/editor-engine.md)'s
   * `EditorMountOptions` (`docId`, `initialBody`): the editor is mounted with a
   * body, and that body is what the first flush is compared against, so an edit
   * that changes nothing opens no transaction at all.
   */
  open(docId: string, seed: { body: string; revision: number }): void;
  /**
   * The editor's `onChange`: record the newest body and re-arm the window.
   *
   * The body may be the text itself or a **producer** that yields it when the
   * body is needed (see {@link BodySource}). A producer is called once, when the
   * window flushes — or when a caller asks for the pending body — so an editor
   * that renders its text on demand renders it once per window rather than once
   * per keystroke. The body a producer yields is the text as it is when it is
   * called, so the newest edit is what the write stores.
   */
  noteEdit(docId: string, body: BodySource): void;
  /** Flush now, bypassing the debounce. One document, or every dirty one. */
  flush(docId?: string): Promise<FlushReport[]>;
  status(docId: string): AutosaveStatus;
  /** Documents with unsaved work — what §8's close-if-dirty asks. */
  dirtyDocIds(): string[];
  /**
   * The unsaved body waiting for a write, or `null` when nothing is waiting. A body
   * already taken by a write in flight is not pending: it is being stored, and
   * {@link AutosaveEvent.body} is where its text is reported.
   *
   * A body that was offered as a producer is produced when it is asked for, and
   * the flush that follows writes that same text without asking again.
   */
  pendingBodyOf(docId: string): string | null;
  /**
   * Rebase a document onto a body the store now holds (editor-engine §9): a restore,
   * an agent apply, or an undo-all that changed the stored body under the editor.
   *
   * It waits out a write already in flight, so the rebase is the last word on the
   * slot, and then drops the pending body and sets the persisted body to `body` and
   * the base revision to `revision`, in one step. `revision` is required because it is
   * the number the next flush is written against: the caller names the revision the
   * store holds for `body`, and a base left behind it would conflict on every flush.
   * The base never moves backwards, because the store's revisions only increase, so a
   * `revision` older than the one the wait settled on does not undo that settle. An
   * edit made during the wait is part of what is discarded, because the rebase replaces
   * the body it was typed on. Nothing is written: the store already holds `body`.
   */
  reseat(docId: string, seed: { body: string; revision: number }): Promise<void>;
  subscribe(listener: (event: AutosaveEvent) => void): () => void;
  dispose(): void;
}

interface DocumentSlot {
  readonly id: string;
  /** The revision the next flush is based on. Only the store ever sets it. */
  baseRevision: number;
  /** What we believe is stored, so a no-op edit opens no transaction. */
  persistedBody: string;
  /**
   * What the newest edit offered: the body itself, or a producer that yields it
   * when the body is needed. Null when nothing is waiting.
   */
  pendingSource: BodySource | null;
  /**
   * The body the pending source produced, once it was asked for. A producer runs
   * once per pending edit, and its result is kept until the next edit replaces it.
   */
  pendingBody: string | null;
  /**
   * The newest body the scheduler holds: the pending body while one waits, else the
   * body last taken for a write or reseated to. It is what {@link AutosaveEvent.body}
   * reports, so an editor can tell its own edit from a store change.
   *
   * A pending body that has not been produced yet is not in here: a notice carries
   * the last body the scheduler knows, and the pending one is produced when the
   * body is needed.
   */
  latestBody: string;
  timer: unknown;
  /** The in-flight store write, or null. One per document, always. */
  inFlight: Promise<WriteDocumentResult> | null;
  /**
   * Reseats still waiting on a write. While one is, no flush starts: a flush would
   * write the body the reseat is about to discard. Counted, not flagged, because two
   * restores can overlap.
   */
  reseating: number;
  /**
   * Whether this pending edit has already had its one retry after a producer failed.
   * The retry is armed once per edit, so a producer that fails every time is not
   * retried forever; a new edit starts the count over.
   */
  producerRetried: boolean;
  state: AutosaveState;
  lastError: unknown | null;
}

export function createAutosave(options: AutosaveOptions): Autosave {
  const projectId = options.projectId;
  const dispatch = options.dispatch;
  const sessions = options.sessions;
  const writePort: DocumentWriter =
    options.source === 'write'
      ? options.write
      : (options.write ?? ((request) => writeDocumentBody(options.store, request)));
  const write: DocumentWriter =
    dispatch === undefined
      ? writePort
      : (request) =>
          dispatch({ docId: request.docId, body: request.body, expectedRevision: request.expectedRevision });
  const clock = options.clock ?? systemClock;
  const debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;

  const slots = new Map<string, DocumentSlot>();
  const listeners = new Set<(event: AutosaveEvent) => void>();
  let detachSignals: (() => void) | null = null;
  let disposed = false;

  function assertLive(): void {
    if (disposed) throw new Error('this autosave has been disposed');
  }

  function statusOf(slot: DocumentSlot): AutosaveStatus {
    return {
      state: slot.state,
      dirty: slot.pendingSource !== null || slot.inFlight !== null,
      revision: slot.baseRevision,
      lastError: slot.lastError,
    };
  }

  function emit(slot: DocumentSlot): void {
    const event: AutosaveEvent = { docId: slot.id, status: statusOf(slot), body: slot.latestBody };
    for (const listener of listeners) listener(event);
  }

  /** Forgets the unsaved body and its window. The stored body and revision are the caller's to say. */
  function dropPending(slot: DocumentSlot): void {
    cancelTimer(slot);
    slot.pendingSource = null;
    slot.pendingBody = null;
    slot.producerRetried = false;
  }

  /**
   * The body the pending source produces, produced once and kept.
   *
   * A producer runs when the body is needed — at the flush, or when a caller asks
   * for the pending body — and never twice for the same edit: what it produced is
   * kept, and the next edit replaces it. So an editor that renders its text on
   * demand renders it once per window, not once per keystroke.
   *
   * A producer that throws is a failure like any other: the body stays where it
   * is, the error is recorded, and the state says so.
   */
  function materialize(slot: DocumentSlot): string | null {
    if (slot.pendingSource === null) return null;
    if (slot.pendingBody !== null) return slot.pendingBody;
    let produced: string;
    try {
      produced =
        typeof slot.pendingSource === 'string' ? slot.pendingSource : slot.pendingSource();
    } catch (error) {
      slot.lastError = error;
      slot.state = 'error';
      emit(slot);
      return null;
    }
    slot.pendingBody = produced;
    slot.latestBody = produced;
    return produced;
  }

  function cancelTimer(slot: DocumentSlot): void {
    if (slot.timer !== null) {
      clock.clearTimeout(slot.timer);
      slot.timer = null;
    }
  }

  function armTimer(slot: DocumentSlot): void {
    cancelTimer(slot);
    // Re-armed from scratch on every edit, which is what "≥ 800 ms after the
    // *last* edit" means. A trailing-edge debounce that kept the original
    // deadline would instead flush 800 ms after the *first* keystroke of a
    // paragraph and write a half-typed body.
    slot.timer = clock.setTimeout(() => {
      slot.timer = null;
      // `runFlush` reports every write failure as a `FlushReport`, so this
      // cannot reject — and a rejection escaping a timer callback would be an
      // unhandled rejection rather than a lost edit.
      void runFlush(slot.id);
    }, debounceMs);
  }

  /**
   * Write one document's pending body, if there is one to write.
   *
   * Never rejects: every failure becomes a `FlushReport` and a state, because
   * the two callers are a timer callback (where a rejection is lost) and
   * `pagehide` (where nobody is left to catch it).
   */
  async function runFlush(docId: string): Promise<FlushReport> {
    const slot = slots.get(docId);
    if (!slot) return { docId, outcome: 'skipped' };
    cancelTimer(slot);
    if (slot.pendingSource === null) return { docId, outcome: 'skipped' };
    if (slot.reseating > 0) {
      // A reseat is waiting out a write, and the body waiting here is the one it discards.
      // Writing it now would store text the restore is about to replace; the reseat drops it
      // when the wait ends, so nothing is lost that the caller did not ask to discard.
      return { docId, outcome: 'skipped' };
    }
    if (slot.inFlight !== null) {
      // One write in flight per document. The running write picks the pending
      // body up when it settles; starting a second here is the self-conflict
      // this file's header describes.
      return { docId, outcome: 'skipped' };
    }
    const body = materialize(slot);
    if (body === null) {
      // The producer failed: the body could not be read, so nothing is written and
      // the edit stays where it is. `materialize` recorded the error and the state.
      //
      // **One retry is armed.** A failed write is the store failing, and it keeps
      // failing; a failed producer is the editor's text failing to be read, and the
      // next attempt may well succeed. So the window is armed again, once — a
      // producer that fails every time would otherwise be retried forever, and a
      // loop is what this file's header refuses. After that one retry the failure
      // stands like any other, and the next edit, the next lifecycle flush or an
      // explicit `flush()` retries it.
      if (!slot.producerRetried) {
        slot.producerRetried = true;
        armTimer(slot);
      }
      return { docId, outcome: 'failed', error: slot.lastError ?? undefined };
    }
    if (body === slot.persistedBody) {
      // Not a mutation, so not a transaction: §4 scopes the one-transaction
      // guarantee to mutations, and the store's own no-op path agrees.
      slot.pendingSource = null;
      slot.pendingBody = null;
      slot.state = 'clean';
      emit(slot);
      return { docId, outcome: 'unchanged', revision: slot.baseRevision };
    }

    slot.pendingSource = null;
    slot.pendingBody = null;
    slot.state = 'saving';
    emit(slot);

    const before = slot.persistedBody;

    try {
      // The write starts inside the try, and that placement is load-bearing. A writer that
      // throws instead of rejecting (a closed connection, a port that refuses the request) must
      // take the failure path below: outside the try, the throw left the state at 'saving' and
      // the body unsaved with nothing scheduled to retry it. `Promise.resolve` wraps a writer
      // that returns a plain value, and returns a native promise unchanged.
      const attempt = Promise.resolve(
        write({
          projectId,
          docId,
          body,
          expectedRevision: slot.baseRevision,
        }),
      );
      slot.inFlight = attempt;
      const result = await attempt;
      slot.inFlight = null;
      slot.baseRevision = result.revision;
      slot.persistedBody = body;
      slot.lastError = null;
      // A write that stored a change is a document write for the open session
      // (sessions.ts). Counted from the two bodies this write took the document
      // between, so the session's net is what the writes say. Outside a session
      // there is nothing to count into, and the tracker would refuse the write.
      if (result.changed && sessions !== undefined && sessions.isOpen()) {
        sessions.noteWrite({
          docId,
          wordsBefore: countBody(before).words,
          wordsAfter: countBody(body).words,
        });
      }
      slot.state = slot.pendingSource === null ? 'clean' : 'pending';
      emit(slot);
      // Work that arrived during the write is based on the revision this write
      // just produced. Whether it goes now depends on its window, and the window
      // is the timer `noteEdit` armed for it: if that timer is still pending the
      // edit has not yet waited out its 800 ms, and the timer will write it. Only
      // when the timer has already fired (it was skipped, because this write was
      // running) does the edit go now. Calling `runFlush` unconditionally here
      // cancelled the timer and wrote the edit the moment this write settled —
      // not 800 ms after it was typed. After a *success* only: a failure must not
      // arm its own retry.
      if (slot.pendingSource !== null && slot.timer === null) void runFlush(docId);
      return {
        docId,
        outcome: result.changed ? 'saved' : 'unchanged',
        revision: result.revision,
      };
    } catch (error) {
      slot.inFlight = null;
      slot.lastError = error;
      // The body is kept. A `pagehide` in the next second, the next keystroke,
      // or close-if-dirty is the recovery surface; silently dropping the body
      // would be the one outcome §4's atomicity note cannot rescue, because
      // nothing was written to be atomic about.
      //
      // **The body kept is the newest one, never the one that failed.** Restoring `body`
      // unconditionally loses every keystroke typed while this write was in
      // flight: type `b`, the write of `b` fails, type `c`, and the next flush
      // sends `b` (reproduced: bodies `["b","b"]`). See the header for why there
      // is no ordering in which the older body is the right one to keep.
      //
      // **Nothing is rebased, because nothing moved.** §9's *"IndexedDB
      // atomicity makes partial writes impossible"* means a failed write left
      // storage on the revision `baseRevision` already names, so the pending body
      // is still based on it and goes out against it unchanged. That is also why
      // the conflict path needs no different handling on this line: what makes a
      // conflict special is that the *next* flush cannot succeed, not that this
      // one was stored differently.
      if (slot.pendingSource === null) {
        // The body that failed is kept as it is: a producer has already said what
        // it says, and the retry writes the same text.
        slot.pendingSource = body;
        slot.pendingBody = body;
        // 'error' is the state that means "no retry is armed", and nothing is:
        // this failure arms none, and a conflict may never succeed at all.
        slot.state = 'error';
      } else {
        // A newer edit arrived mid-write, and `noteEdit` armed its own window —
        // so a flush *is* scheduled and 'error' would be a lie about that. The
        // failure is still reported, on `lastError`, which the indicator reads.
        slot.state = 'pending';
      }
      emit(slot);
      return {
        docId,
        outcome: error instanceof RevisionConflictError ? 'conflict' : 'failed',
        error,
      };
    }
  }

  async function flush(docId?: string): Promise<FlushReport[]> {
    const ids = docId !== undefined ? [docId] : [...slots.values()].map((slot) => slot.id);
    const reports: FlushReport[] = [];
    for (const id of ids) {
      const slot = slots.get(id);
      if (!slot) {
        reports.push({ docId: id, outcome: 'skipped' });
        continue;
      }
      // Wait out a write that is already running. A lifecycle flush that
      // resolved while an edit was still in memory would be a lie about the one
      // moment it exists for — the tab is going away and this is the last
      // chance to store the text. Each turn awaits a real store write, so this
      // settles when the document does.
      while (slot.inFlight !== null) {
        await slot.inFlight.catch(() => undefined);
      }
      reports.push(await runFlush(id));
    }
    return reports;
  }

  function open(docId: string, seed: { body: string; revision: number }): void {
    assertLive();
    const existing = slots.get(docId);
    if (existing) {
      // Re-opening while work is outstanding keeps it. An editor remounting
      // mid-debounce is not a reason to lose a pending body, and re-seeding the
      // revision underneath one would make the next flush guard against the
      // wrong number.
      //
      // **A write in flight is outstanding work too.** Testing the pending body alone is the bug, and it
      // is worse than it looks: `runFlush` clears the pending body *before* it
      // awaits the write, so a re-open inside that window passed this guard even
      // though a write was running. Two consequences, both silent. A *successful*
      // write settles straight over the seed, so a caller told the document was
      // at revision 7 finds the slot back at the write's own 1; a *failed* one
      // took the other branch, restoring the stale body into a slot the caller
      // had just re-seeded — so the next flush wrote `b` against revision 7, the
      // old text over whatever produced 7.
      //
      // The cost of refusing is that the caller's seed is dropped, which is the
      // trade the pending-body arm has always made: outstanding work wins. A
      // caller that must win has `flush()` — it waits the write out — and can
      // re-open once the slot is quiet and the re-seed is correct.
      if (existing.pendingSource !== null || existing.inFlight !== null) return;
      cancelTimer(existing);
      existing.baseRevision = seed.revision;
      existing.persistedBody = seed.body;
      existing.latestBody = seed.body;
      existing.lastError = null;
      existing.producerRetried = false;
      existing.state = 'clean';
      emit(existing);
      return;
    }
    const slot: DocumentSlot = {
      id: docId,
      baseRevision: seed.revision,
      persistedBody: seed.body,
      pendingSource: null,
      pendingBody: null,
      latestBody: seed.body,
      timer: null,
      inFlight: null,
      reseating: 0,
      producerRetried: false,
      state: 'clean',
      lastError: null,
    };
    slots.set(docId, slot);
    emit(slot);
  }

  function noteEdit(docId: string, body: BodySource): void {
    assertLive();
    const slot = slots.get(docId);
    if (!slot) {
      // §9's guard is unconditional, so the scheduler cannot start saving a
      // document whose revision it was never told — that would mean writing
      // without a guard, which is the one thing the guard exists to stop.
      throw new Error(
        `cannot autosave "${docId}": it was never opened, so there is no revision to base the write on`,
      );
    }
    // The body is kept as it was offered. A string is the body itself; a producer
    // is asked for it when the body is needed — the flush, or a caller that wants
    // to see what is pending. Nothing is rendered here, so an editor that renders
    // its text on demand pays once per window rather than once per keystroke.
    slot.pendingSource = body;
    slot.pendingBody = typeof body === 'string' ? body : null;
    if (typeof body === 'string') slot.latestBody = body;
    // A new edit is a new chance: the one retry a failed producer was given belongs
    // to the edit that failed, not to this one.
    slot.producerRetried = false;
    if (slot.state !== 'saving') slot.state = 'pending';
    // Always re-armed, including for a body identical to the pending one. A
    // "same body, skip" optimisation here would silently disable §9's "next
    // flush retries": type a character after a failed flush, delete it, and
    // the document would be dirty with no timer to ever retry it.
    armTimer(slot);
    emit(slot);
  }

  async function reseat(docId: string, seed: { body: string; revision: number }): Promise<void> {
    assertLive();
    const slot = slots.get(docId);
    if (!slot) {
      // The refusal noteEdit makes, for the same reason: a rebase is a claim about the stored
      // body and revision, and the scheduler has been told neither for a document it never opened.
      throw new Error(`cannot reseat "${docId}": it was never opened, so there is no stored body to rebase`);
    }
    slot.reseating += 1;
    try {
      // Dropped now, so a window that fires during the wait has nothing to write (and the flush
      // guard above keeps it from starting one anyway).
      dropPending(slot);
      // Wait out the running write, as `flush` does. Its settle writes its own revision and body
      // into the slot, so the rebase has to land after it or that settle would undo it.
      while (slot.inFlight !== null) await slot.inFlight.catch(() => undefined);
      // Dropped again, because an edit typed during the wait sits on the body being discarded.
      dropPending(slot);
      slot.persistedBody = seed.body;
      // The store's revisions only increase, so the base only does too: a revision older than the one the wait
      // settled on is a stale claim, and the settle stands. A newer one (a write the slot never saw) is the base.
      slot.baseRevision = Math.max(slot.baseRevision, seed.revision);
      slot.latestBody = seed.body;
      // A failure is moot once the body it failed to store has been replaced, so it is cleared
      // with the rebase rather than left to mark a document the store now agrees with.
      slot.lastError = null;
      slot.state = 'clean';
    } finally {
      slot.reseating -= 1;
    }
    emit(slot);
  }

  if (options.signals) {
    detachSignals = options.signals.subscribe(() => {
      if (disposed) return;
      void flush();
    });
  }

  return {
    open,
    noteEdit,
    flush,
    status(docId: string): AutosaveStatus {
      const slot = slots.get(docId);
      if (!slot) {
        return { state: 'clean', dirty: false, revision: 0, lastError: null };
      }
      return statusOf(slot);
    },
    dirtyDocIds(): string[] {
      return [...slots.values()]
        .filter((slot) => slot.pendingSource !== null || slot.inFlight !== null)
        .map((slot) => slot.id)
        .sort();
    },
    pendingBodyOf(docId: string): string | null {
      const slot = slots.get(docId);
      if (slot === undefined) return null;
      // The pending body is produced here if it has not been produced yet: a
      // caller that asks what is waiting gets the text, and the flush that follows
      // writes the same text without asking the producer again.
      return materialize(slot);
    },
    reseat,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      for (const slot of slots.values()) cancelTimer(slot);
      if (detachSignals) {
        detachSignals();
        detachSignals = null;
      }
      listeners.clear();
    },
  };
}
