/**
 * Debounced autosave — [project-format.md §4](docs/architecture/project-format.md)
 * and [editor-engine.md §9](docs/architecture/editor-engine.md).
 *
 * §4, quoted: "Debounced autosave: flush **≥ 800 ms after last edit**, plus
 * flush on `visibilitychange`/`pagehide`/`beforeunload`."
 *
 * §9, quoted: "**Dirty pipeline:** `onChange` → debounce **800 ms** → dispatch
 * `doc.write {docId, body, expectedRevision}` (`issuedBy: 'user'`) → store write
 * (one IndexedDB transaction) → `doc.revision` bump → subscribers. Plus flush on
 * `visibilitychange`/`pagehide`/`beforeunload` ([project-format.md](project-format.md) §4).
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
 * scheduler calls the producer when the body is needed: at the flush, or earlier
 * if a caller asks for the pending body. What it produced is kept, so the write
 * that follows does not ask again.
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
 * **The budget counts the window's own retry, and nothing else.** That one
 * automatic retry is what the loop needs bounded; a flush a caller or a
 * lifecycle event asked for is not a loop, and §4's last chance to store the
 * text is exactly the moment the editor's text may have become readable again.
 * So `flush()` — which is what `visibilitychange` and `pagehide` call — asks a
 * failed producer again, exactly as a new edit does. The producer is asked
 * twice per chance and not once more: the attempt, and the retry the window
 * arms.
 *
 * **A failed producer is `pending` while its retry is armed.** `error` means
 * "the last flush failed and nothing is scheduled to retry it", and that is
 * what a failed write is *when no newer edit has answered it*. A failed
 * producer is not that: its one retry *is* scheduled, so the slot says
 * `pending` — unsaved work, a flush scheduled — and `lastError` is where the
 * failure is visible. The state is `error` once that retry is spent and the
 * failure stands.
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
import { assertNever } from '@caotang/machine';
import { autosaveSlot, stepAutosave, type AutosaveSlot, type AutosaveSlotEvent, type AutosaveEffect, type Production } from './autosave-machine.js';
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
 * `visibilitychange`, `pagehide` and `beforeunload` have no `node` equivalent, so the
 * events are a port for the same reason the IndexedDB factory is: the production
 * binding is three `addEventListener` calls, and a test can drive them exactly.
 */
export interface FlushSignalSource {
  /** Begin signalling; returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export interface FlushSignalTargets {
  /** `document` — fires `visibilitychange`. */
  readonly visibility: EventTarget;
  /** `window` — fires `pagehide` and `beforeunload`. */
  readonly page: EventTarget;
}

/**
 * The browser binding for the §4 lifecycle flush.
 *
 * The handler is **unconditional** — it flushes on a `visibilitychange` to
 * *visible* as readily as to `hidden`, and on a `pagehide` that the page will
 * resume from the back/forward cache as readily as one it will not, and on a
 * `beforeunload` that the writer then cancels. §4 says "flush on
 * `visibilitychange`/`pagehide`/`beforeunload`" without qualifying any, and the
 * qualification is unnecessary: a document with nothing pending flushes nothing,
 * so the redundant fire costs no transaction and no revision. A filtered
 * handler would need its filter to be right in every case, and getting it wrong
 * is a lost edit rather than a wasted no-op.
 *
 * Note what a `pagehide` flush can and cannot promise: it *starts* the write
 * before the page goes away, which in the ordinary case is all that is needed
 * because `visibilitychange`→hidden has already fired and had the whole tab to
 * finish in, and `beforeunload` is the earliest teardown event of a reload or a close,
 * so it gives the write the most time to start. Whether a browser completes an
 * IndexedDB transaction started during teardown is not this app's to decide — which
 * is exactly why the dirty state is observable rather than assumed away, and why the
 * app also keeps the pending text where a synchronous write reaches it (the pending
 * journal, `apps/desktop/src/app/pending-journal.ts`).
 */
export function domFlushSignals(targets: FlushSignalTargets): FlushSignalSource {
  return {
    subscribe(listener) {
      targets.visibility.addEventListener('visibilitychange', listener);
      targets.page.addEventListener('pagehide', listener);
      targets.page.addEventListener('beforeunload', listener);
      return () => {
        targets.visibility.removeEventListener('visibilitychange', listener);
        targets.page.removeEventListener('pagehide', listener);
        targets.page.removeEventListener('beforeunload', listener);
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
 * - `error` — the last flush failed; dirty, and no retry is armed.
 * - `conflict` — the stored revision moved; the newest unsaved body is kept.
 *
 * **`error` is one-way, and it is the weaker half of an implication.**
 * `state === 'error'` means the last flush failed, but the converse does not
 * hold: a failure that a newer edit answered arrives as `'pending'`, because
 * `noteEdit` armed a window. `AutosaveStatus.lastError` — not this field — is
 * where a failure is visible, and it is non-null under both states. Revision
 * conflicts instead publish `conflict`, including when a newer edit is waiting.
 *
 * **A failed producer whose one retry is armed is `pending`, not `error`.** Its
 * retry *is* a scheduled flush, so the slot says `pending` — unsaved work, a
 * flush scheduled — and `lastError` names the failure. The state is `error`
 * once that retry is spent and the failure stands; see "A failure is a state,
 * not a loop" in this file's header.
 *
 * `clean` with a non-null `lastError` is reachable too: a body edited back to
 * what is stored takes `runFlush`'s `unchanged` path, which opens no
 * transaction and so clears nothing.
 */
export type AutosaveState = AutosaveSlot['kind'];

export interface AutosaveStatus {
  readonly state: AutosaveState;
  /**
   * §9's dirty flag. True while a body is unsaved *or* mid-write, and it stays
   * true after a failed write, because the body is still only in memory.
   */
  readonly dirty: boolean;
  /** The revision the next flush will be based on. */
  readonly revision: number;
  /** The latest producer/read/write failure; revisionConflict separately retains an unresolved revision refusal. */
  readonly lastError: unknown | null;
  readonly revisionConflict: boolean;
}

export interface AutosaveEvent {
  readonly docId: string;
  readonly status: AutosaveStatus;
  /**
   * The body the scheduler now holds for the document.
   *
   * An edit that carries its text has that text here at once. An edit that
   * carries a **producer** does not: the text is read when the body is needed,
   * so until then a notice carries the last body the scheduler knows — the seed,
   * or the body of the last write — and the pending one arrives with the write
   * it belongs to.
   *
   * So this is **"the last body the scheduler knows", not "the unsaved body"**:
   * an editor that offers a producer sees the notice of its own keystroke carry
   * the *previous* body. An editor that re-renders from a store change compares
   * this with its own body to tell its own edit from a foreign one, so it must
   * read a difference as "the scheduler has not caught up" rather than as a
   * foreign change. Carried by reference, so it costs no copy.
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
  /**
   * The flush failed for a reason other than a revision conflict: the write
   * failed, or the producer that yields the body failed to yield it, so no write
   * was attempted. Both leave the body unsaved, and both carry the cause in
   * {@link FlushReport.error}.
   */
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
 *
 * A producer runs **inside** the scheduler, so it must not wait for the write it
 * is part of. A `flush()` it calls joins the flush that is running — that call
 * reports `skipped`, and no second write starts — as long as the flush that is
 * running is the one that is running the producer. A producer asked for the
 * body outside a flush (a read, through `pendingBodyOf`) is in no flush at all:
 * a `flush()` it calls there flushes for real, and a `flush()` with no document
 * flushes every dirty document for real. A `noteEdit()` it makes is a newer
 * edit: it keeps its place in the slot, and the write that follows stores the
 * text as it was read.
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
   * body is needed (see {@link BodySource}). The producer is called when the body
   * is needed — when the window flushes, or when a caller asks for the pending
   * body — so an editor that renders its text on demand renders it once per window
   * rather than once per keystroke. The body a producer yields is the text as it
   * is when it is called, so the newest edit is what the write stores.
   */
  noteEdit(docId: string, body: BodySource): void;
  /**
   * Flush now, bypassing the debounce. One document, or every dirty one.
   *
   * An explicit flush is a new chance for a producer that failed: the budget
   * bounds the window's own retry, and a flush a caller or a lifecycle event
   * asked for is not that loop. So the producer is asked again, and the text
   * it could not read is written if it can be read now.
   */
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
   * the flush that follows writes that same text without asking again. **That is
   * this read's one side effect**: producing the body caches it, so the flush
   * does not ask the producer a second time.
   *
   * `null` means "there is no body to name", and that is three things: nothing
   * is waiting, the waiting body is a producer that failed and could not be
   * read, or a producer for that document is running right now — a producer
   * that asks for the body while it runs is refused, so that it is not run
   * twice for one edit.
   * A producer that fails is **recorded**: the failure goes on `lastError` and the
   * subscribers are told, because the editor's own text is what could not be read
   * and the writer has to know that. The *state* is the flush's, and a read does
   * not touch it — a read that forced `error` would say "no retry is armed" over
   * a write that is still running.
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
  current: AutosaveSlot;
  timer: unknown;
  inFlight: Promise<WriteDocumentResult> | null;
}

export function createAutosave(options: AutosaveOptions): Autosave {
  const projectId = options.projectId;
  const sessions = options.sessions;
  const writePort: DocumentWriter = options.source === 'write'
    ? options.write
    : (options.write ?? ((request) => writeDocumentBody(options.store, request)));
  const dispatch = options.dispatch;
  const write: DocumentWriter = dispatch === undefined ? writePort : (request) =>
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
    const state = slot.current;
    return {
      state: state.kind,
      dirty: state.pending !== null || state.kind === 'saving',
      revision: state.revision,
      lastError: state.lastError,
      revisionConflict: state.revisionConflict,
    };
  }

  function emit(slot: DocumentSlot): void {
    const event: AutosaveEvent = { docId: slot.id, status: statusOf(slot), body: slot.current.latestBody };
    for (const listener of listeners) listener(event);
  }

  function cancelTimer(slot: DocumentSlot): void {
    if (slot.timer !== null) clock.clearTimeout(slot.timer);
    slot.timer = null;
  }

  function send(slot: DocumentSlot, event: AutosaveSlotEvent): readonly AutosaveEffect[] {
    const next = stepAutosave(slot.current, event);
    slot.current = next.slot;
    for (const effect of next.effects) {
      switch (effect.type) {
        case 'cancel-window': cancelTimer(slot); break;
        case 'arm-window':
          cancelTimer(slot);
          slot.timer = clock.setTimeout(() => {
            slot.timer = null;
            send(slot, { type: 'window-fired' });
            void runFlush(slot.id);
          }, debounceMs);
          break;
        case 'notify': emit(slot); break;
        case 'drain':
          if (slot.current.pending !== null && !slot.current.scheduled) void runFlush(slot.id);
          break;
        case 'write': break;
        default: assertNever(effect);
      }
    }
    return next.effects;
  }

  function materialize(slot: DocumentSlot, forWrite: boolean): Production | null {
    const pending = slot.current.pending;
    if (pending === null) return null;
    if (pending.body !== null) return { ok: true, body: pending.body };
    if (slot.current.producing) return null;
    if (pending.failure !== null && !forWrite) return { ok: false, error: pending.failure };
    if (forWrite && pending.attempts >= 2) return {
      ok: false, error: pending.failure ?? new Error('the producer failed without a reason'),
    };
    send(slot, { type: 'produce', forWrite });
    let result: Production;
    try {
      result = { ok: true, body: typeof pending.source === 'string' ? pending.source : pending.source() };
    } catch (error) {
      result = { ok: false, error: error ?? new Error('the producer failed without a reason') };
    }
    send(slot, { type: 'produced', source: pending.source, result });
    return result;
  }

  async function runFlush(docId: string): Promise<FlushReport> {
    const slot = slots.get(docId);
    if (!slot || slot.current.producing) return { docId, outcome: 'skipped' };
    send(slot, { type: 'cancel-window' });
    if (slot.current.pending === null || slot.current.reseating > 0 || slot.inFlight !== null) {
      return { docId, outcome: 'skipped' };
    }
    const source = slot.current.pending.source;
    const production = materialize(slot, true);
    if (production === null) return { docId, outcome: 'skipped' };
    if (!production.ok) {
      send(slot, { type: 'producer-failed', error: production.error });
      return { docId, outcome: 'failed', error: production.error };
    }
    if (slot.current.pending === null) return { docId, outcome: 'skipped' };
    const effects = send(slot, { type: 'take', source, body: production.body });
    const writing = effects.find((effect) => effect.type === 'write');
    if (writing === undefined) return { docId, outcome: 'unchanged', revision: slot.current.revision };
    try {
      const attempt = Promise.resolve(write({
        projectId, docId, body: writing.body, expectedRevision: writing.revision,
      }));
      slot.inFlight = attempt;
      const result = await attempt;
      slot.inFlight = null;
      if (result.changed && sessions !== undefined && sessions.isOpen()) sessions.noteWrite({
        docId, wordsBefore: countBody(writing.before).words, wordsAfter: countBody(writing.body).words,
      });
      send(slot, { type: 'written', revision: result.revision });
      return { docId, outcome: result.changed ? 'saved' : 'unchanged', revision: result.revision };
    } catch (error) {
      slot.inFlight = null;
      const conflict = error instanceof RevisionConflictError;
      send(slot, { type: 'write-failed', error, conflict });
      return { docId, outcome: conflict ? 'conflict' : 'failed', error };
    }
  }

  async function flush(docId?: string): Promise<FlushReport[]> {
    const ids = docId !== undefined ? [docId] : [...slots.keys()];
    const reports: FlushReport[] = [];
    for (const id of ids) {
      const slot = slots.get(id);
      if (!slot) { reports.push({ docId: id, outcome: 'skipped' }); continue; }
      while (slot.inFlight !== null) await slot.inFlight.catch(() => undefined);
      send(slot, { type: 'reset-budget' });
      reports.push(await runFlush(id));
    }
    return reports;
  }

  function open(docId: string, seed: { body: string; revision: number }): void {
    assertLive();
    const existing = slots.get(docId);
    if (existing) { send(existing, { type: 'open', ...seed }); return; }
    const slot: DocumentSlot = { id: docId, current: autosaveSlot(seed.body, seed.revision), timer: null, inFlight: null };
    slots.set(docId, slot);
    emit(slot);
  }

  function noteEdit(docId: string, body: BodySource): void {
    assertLive();
    const slot = slots.get(docId);
    if (!slot) throw new Error(
      `cannot autosave "${docId}": it was never opened, so there is no revision to base the write on`,
    );
    send(slot, { type: 'edit', source: body });
  }

  async function reseat(docId: string, seed: { body: string; revision: number }): Promise<void> {
    assertLive();
    const slot = slots.get(docId);
    if (!slot) throw new Error(`cannot reseat "${docId}": it was never opened, so there is no stored body to rebase`);
    send(slot, { type: 'reseat' });
    while (slot.inFlight !== null) await slot.inFlight.catch(() => undefined);
    send(slot, { type: 'reseated', ...seed });
  }

  if (options.signals) detachSignals = options.signals.subscribe(() => {
    if (!disposed) void flush();
  });

  return {
    open, noteEdit, flush,
    status(docId) {
      const slot = slots.get(docId);
      return slot ? statusOf(slot) : { state: 'clean', dirty: false, revision: 0, lastError: null, revisionConflict: false };
    },
    dirtyDocIds: () => [...slots.values()]
      .filter((slot) => slot.current.pending !== null || slot.current.kind === 'saving')
      .map((slot) => slot.id).sort(),
    pendingBodyOf(docId) {
      const slot = slots.get(docId);
      if (!slot) return null;
      const production = materialize(slot, false);
      if (production === null) return null;
      if (production.ok) return production.body;
      send(slot, { type: 'read-failed', error: production.error });
      return null;
    },
    reseat,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      for (const slot of slots.values()) send(slot, { type: 'cancel-window' });
      detachSignals?.();
      detachSignals = null;
      listeners.clear();
    },
  };
}
