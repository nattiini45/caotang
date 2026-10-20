/**
 * Debounced autosave — [project-format.md §4](docs/architecture/project-format.md)
 * and [editor-engine.md §9](docs/architecture/editor-engine.md).
 *
 * Every test here is written against a claim one of those two sentences makes,
 * and each names the sentence it defends. A test that would still pass with the
 * feature deleted is worse than no test, so the shape of the suite is mostly
 * *negative*: it advances a clock to just before a deadline and asserts nothing
 * happened, it holds a write open and asserts a second one did not start, it
 * fails a transaction and asserts the store did not move.
 *
 * The clock is a seam rather than vitest's fake timers, for a concrete reason:
 * `MemoryIndexedDb` schedules its own request delivery on real `setTimeout(…, 0)`,
 * so a global fake clock would freeze the storage this suite is asserting about.
 * The seam keeps "flush no earlier than 800 ms" an exact claim instead of a
 * sleep.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { DocWriteParams } from '@caotang/bus';
import {
  AUTOSAVE_DEBOUNCE_MS,
  RevisionConflictError,
  addDocument,
  createAutosave,
  createEmptyManifest,
  createProjectState,
  createSessionTracker,
  domFlushSignals,
  getBody,
  getRevision,
  openRuntimeStore,
  readProjectState,
  writeProjectState,
  type Autosave,
  type AutosaveClock,
  type AutosaveState,
  type DocumentWriteRequest,
  type RuntimeStore,
  type WriteDocumentResult,
} from '../src/index.js';
import { MemoryIndexedDb } from '../src/runtime/memory-idb.js';

const OPENED = new Date('2026-09-30T03:00:00.000Z');
const DB = 'caotang-autosave-test';
const PROJECT = 'p_9XK2M4Q7RZ';
const DOC = 'n_7K2QX9M4A1';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/**
 * A clock the test moves by hand.
 *
 * `advance` fires every timer due in the interval, in deadline order, and waits
 * for the microtask and macrotask work each one starts before moving to the next
 * — so "advance 800 ms and assert" means "the debounce fired, and everything it
 * caused has finished", not "a timer callback ran".
 */
class ManualClock implements AutosaveClock {
  private now = 0;
  private nextHandle = 1;
  private readonly timers = new Map<number, { at: number; run: () => void }>();

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.set(handle, { at: this.now + delayMs, run: callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Timers still armed — a pending save with nothing scheduled is a bug. */
  get armed(): number {
    return this.timers.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      let dueId: number | undefined;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) {
          dueId = id;
          dueAt = timer.at;
        }
      }
      if (dueId === undefined) break;
      const timer = this.timers.get(dueId);
      this.timers.delete(dueId);
      this.now = timer!.at;
      timer!.run();
      await settle();
    }
    this.now = target;
    await settle();
  }
}

/**
 * Let the *real* timers run out — chiefly `MemoryIndexedDb`'s request delivery,
 * which is not on the seam. Twelve turns is comfortably more than the three a
 * write needs (open the window, deliver, commit); the surplus costs nothing and
 * a short chain would make these tests flaky rather than strict.
 */
async function settle(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

type Step =
  | { kind: 'ok'; revision?: number; changed?: boolean }
  | { kind: 'fail'; error: unknown }
  | { kind: 'hold' };

/** A `DocumentWriter` that records requests and answers from a script. */
class FakeWriter {
  readonly calls: DocumentWriteRequest[] = [];
  private readonly held: {
    resolve: (result: WriteDocumentResult) => void;
    reject: (error: unknown) => void;
  }[] = [];
  private inFlight = 0;
  private peak = 0;
  readonly write = (request: DocumentWriteRequest): Promise<WriteDocumentResult> =>
    this.dispatch(request);

  constructor(private readonly steps: Step[] = []) {}

  /** The most writes ever running at once — the one-per-document invariant. */
  get peakConcurrency(): number {
    return this.peak;
  }

  /** Settle a held write, the way a store that has finished committing would. */
  settleHeld(index: number, result: WriteDocumentResult): void {
    const held = this.held[index];
    if (!held) throw new Error(`no write is held at index ${index}`);
    held.resolve(result);
  }

  /**
   * Fail a held write, the way a store whose transaction aborted would.
   *
   * The other half of `settleHeld`, and it is the one a failure test needs: the
   * only way to have an edit land *while a write is in flight* is to hold that
   * write, and the only way to then fail it is to reject it after the fact. A
   * scripted `fail` fires before the caller gets control back, so every test
   * using it fails a write with nothing pending — which is precisely the gap a review
   * found, where 24 green tests never failed a write with an edit in the slot.
   */
  rejectHeld(index: number, error: unknown): void {
    const held = this.held[index];
    if (!held) throw new Error(`no write is held at index ${index}`);
    held.reject(error);
  }

  private dispatch(request: DocumentWriteRequest): Promise<WriteDocumentResult> {
    this.calls.push(request);
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    const done = (): void => {
      this.inFlight -= 1;
    };
    const step = this.steps[this.calls.length - 1] ?? { kind: 'ok' as const };
    if (step.kind === 'fail') return Promise.reject(step.error).finally(done);
    if (step.kind === 'hold') {
      return new Promise<WriteDocumentResult>((resolve, reject) => {
        this.held.push({
          resolve: (result) => {
            done();
            resolve(result);
          },
          reject: (error) => {
            done();
            reject(error);
          },
        });
      });
    }
    return Promise.resolve({
      revision: step.revision ?? request.expectedRevision + 1,
      changed: step.changed ?? true,
    }).finally(done);
  }
}

interface Harness {
  readonly autosave: Autosave;
  readonly clock: ManualClock;
  readonly writer: FakeWriter;
  readonly visibility: EventTarget;
  readonly page: EventTarget;
  /** Fire a §4 lifecycle signal and let the flush it starts finish. */
  hide(): Promise<void>;
  /** Open `DOC` at a known body and revision. */
  openDoc(body: string, revision: number): void;
}

function harness(steps: Step[] = []): Harness {
  const clock = new ManualClock();
  const writer = new FakeWriter(steps);
  const visibility = new EventTarget();
  const page = new EventTarget();
  const autosave = createAutosave({
    projectId: PROJECT,
    source: 'write',
    write: writer.write,
    clock,
    signals: domFlushSignals({ visibility, page }),
  });
  return {
    autosave,
    clock,
    writer,
    visibility,
    page,
    async hide() {
      visibility.dispatchEvent(new Event('visibilitychange'));
      await settle();
    },
    openDoc(body: string, revision: number) {
      autosave.open(DOC, { body, revision });
    },
  };
}

const openStores: RuntimeStore[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
});

// ---------------------------------------------------------------------------

describe('§4 — flush ≥ 800 ms after the last edit', () => {
  it('writes nothing at 799 ms and the body at 800 ms', async () => {
    const { autosave, clock, writer } = harness();
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');

    await clock.advance(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(writer.calls).toHaveLength(0);

    await clock.advance(1);
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]?.body).toBe('b');
  });

  it('re-arms on every edit, so the window runs from the last keystroke', async () => {
    // The alternative implementation — keeping the first keystroke's deadline —
    // writes a half-typed paragraph 800 ms after typing began. This is the test
    // that tells the two apart.
    const { autosave, clock, writer } = harness();
    autosave.open(DOC, { body: 'a', revision: 0 });

    autosave.noteEdit(DOC, 'b');
    await clock.advance(300);
    autosave.noteEdit(DOC, 'c');
    await clock.advance(300);
    autosave.noteEdit(DOC, 'd');

    // The last edit landed at t=600, so the window closes at t=1400.
    await clock.advance(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(writer.calls).toHaveLength(0);

    await clock.advance(1);
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]?.body).toBe('d');
  });

  it('coalesces a burst of keystrokes into exactly one write of the newest body', async () => {
    const { autosave, clock, writer } = harness();
    autosave.open(DOC, { body: 'a', revision: 0 });

    for (let i = 0; i < 12; i += 1) {
      autosave.noteEdit(DOC, `keystroke ${i}`);
      await clock.advance(50);
    }
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]?.body).toBe('keystroke 11');
  });

  it('opens no transaction at all for an edit that changes nothing', async () => {
    // §4 scopes the one-transaction guarantee to *mutations*. A body identical
    // to what is stored is not one, so it must not cost a write or a revision —
    // which is also what makes the unconditional `pagehide` flush free.
    const { autosave, clock, writer } = harness();
    autosave.open(DOC, { body: 'unchanged', revision: 3 });

    autosave.noteEdit(DOC, 'unchanged');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(writer.calls).toHaveLength(0);
    expect(autosave.status(DOC).state).toBe('clean');
  });
});

describe('§4 — a mid-flight edit waits out its own window', () => {
  // The bug: when the write in flight settled, `runFlush` was called straight away
  // for the edit that arrived during it. That call cancels the debounce timer the
  // edit had just armed, so an edit made mid-write went out the moment the write
  // settled rather than 800 ms after it was typed — §4's "flush ≥ 800 ms after
  // last edit", broken only on the path a slow write takes.
  it('writes an edit made during a write 800 ms after that edit, not when the write settles', async () => {
    const { autosave, clock, writer } = harness([{ kind: 'hold' }, { kind: 'ok' }]);
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(writer.calls).toHaveLength(1);

    await clock.advance(200);
    autosave.noteEdit(DOC, 'c');
    writer.settleHeld(0, { revision: 1, changed: true });
    await clock.advance(0);

    // The first write has settled, and the edit has not been written.
    expect(writer.calls).toHaveLength(1);

    await clock.advance(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(writer.calls).toHaveLength(1);
    await clock.advance(1);
    expect(writer.calls).toHaveLength(2);
    expect(writer.calls[1]?.body).toBe('c');
    expect(writer.calls[1]?.expectedRevision).toBe(1);
  });

  it('writes an edit whose window ran out while the write was in flight as soon as it settles', async () => {
    // The other half, which must not regress: when the 800 ms have already passed
    // during the write, there is nothing left to wait for.
    const { autosave, clock, writer } = harness([{ kind: 'hold' }, { kind: 'ok' }]);
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    autosave.noteEdit(DOC, 'c');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(writer.calls).toHaveLength(1);

    writer.settleHeld(0, { revision: 1, changed: true });
    await clock.advance(0);
    expect(writer.calls).toHaveLength(2);
    expect(writer.calls[1]?.body).toBe('c');
  });
});

describe('§4 — a saved write is a document write for the session tracker', () => {
  // `sessions.jsonl` was produced by tests only: nothing in the write path fed the
  // tracker. A flush that changed a body is now counted into the open session, so
  // the log is what the writes say rather than what a caller remembered to report.
  it('counts each saved write into the open session, and counts nothing outside one', async () => {
    const clock = new ManualClock();
    const writer = new FakeWriter();
    const sessions = createSessionTracker({ projectId: PROJECT, append: () => Promise.resolve() });
    const autosave = createAutosave({
      projectId: PROJECT,
      source: 'write',
      write: writer.write,
      clock,
      sessions,
    });
    autosave.open(DOC, { body: 'one two three four', revision: 0 });

    autosave.noteEdit(DOC, 'one two three four five');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(writer.calls).toHaveLength(1);
    expect(sessions.pending()).toBeNull();

    sessions.beginSession();
    autosave.noteEdit(DOC, 'one two three four five six');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    // The session's own net: 6 words now against 5 when it began.
    expect(sessions.pending()?.wordsWritten).toBe(1);
    expect(sessions.pending()?.docIds).toEqual([DOC]);
  });

  it('does not count a flush that stored nothing new', async () => {
    const clock = new ManualClock();
    const writer = new FakeWriter();
    const sessions = createSessionTracker({ projectId: PROJECT, append: () => Promise.resolve() });
    const autosave = createAutosave({ projectId: PROJECT, source: 'write', write: writer.write, clock, sessions });
    autosave.open(DOC, { body: 'steady', revision: 0 });
    sessions.beginSession();

    autosave.noteEdit(DOC, 'steady');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(writer.calls).toHaveLength(0);
    expect(sessions.pending()?.docIds).toEqual([]);
  });
});

describe('§4 — the dispatch option routes a flush through doc.write', () => {
  // command-bus.md §9: `doc.write {docId, body, expectedRevision?}` is the command
  // the user path is meant to be. The option hands each flush to the caller as
  // exactly those params, with the revision it is based on — the guard is the
  // point, so it is never left out here.
  it('hands each flush to the dispatcher as doc.write params, carrying expectedRevision', async () => {
    const clock = new ManualClock();
    const writer = new FakeWriter();
    const dispatched: DocWriteParams[] = [];
    const autosave = createAutosave({
      projectId: PROJECT,
      source: 'write',
      write: writer.write,
      clock,
      dispatch: (params) => {
        dispatched.push(params);
        return Promise.resolve({ revision: (params.expectedRevision ?? 0) + 1, changed: true });
      },
    });
    autosave.open(DOC, { body: 'a', revision: 4 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(dispatched).toEqual([{ docId: DOC, body: 'b', expectedRevision: 4 }]);
    expect(writer.calls).toHaveLength(0);
    expect(autosave.status(DOC).revision).toBe(5);
  });

  it('keeps the write port unchanged when the option is absent', async () => {
    const { autosave, clock, writer } = harness();
    autosave.open(DOC, { body: 'a', revision: 2 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(writer.calls).toEqual([{ projectId: PROJECT, docId: DOC, body: 'b', expectedRevision: 2 }]);
  });
});

describe('§4 — flush on visibilitychange / pagehide', () => {
  it('flushes on visibilitychange without waiting out the debounce', async () => {
    const { autosave, writer, hide } = harness();
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');

    await hide();
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]?.body).toBe('b');
  });

  it('flushes on pagehide too', async () => {
    const { autosave, writer, page } = harness();
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');

    page.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(writer.calls).toHaveLength(1);
  });

  it('a lifecycle signal with nothing pending opens no transaction', async () => {
    const { autosave, writer, hide } = harness();
    autosave.open(DOC, { body: 'a', revision: 0 });

    await hide();
    expect(writer.calls).toHaveLength(0);
    expect(autosave.dirtyDocIds()).toEqual([]);
  });

  it('the DOM binding listens on document and window, and detaches on unsubscribe', () => {
    // The handler is deliberately unqualified in *both* directions — a
    // `visibilitychange` to visible flushes, a bfcache `pagehide` flushes —
    // because a document with nothing pending flushes nothing either way, while
    // a filter that is wrong in one case is a lost edit.
    const visibility = new EventTarget();
    const page = new EventTarget();
    const seen: string[] = [];
    visibility.addEventListener('visibilitychange', () => seen.push('visibility'));
    page.addEventListener('pagehide', () => seen.push('pagehide'));

    const stop = domFlushSignals({ visibility, page }).subscribe(() => seen.push('flush'));
    visibility.dispatchEvent(new Event('visibilitychange'));
    page.dispatchEvent(new Event('pagehide'));
    expect(seen).toEqual(['visibility', 'flush', 'pagehide', 'flush']);

    stop();
    visibility.dispatchEvent(new Event('visibilitychange'));
    expect(seen.filter((entry) => entry === 'flush')).toHaveLength(2);
  });
});

describe('§9 — the dirty flag and the non-blocking indicator', () => {
  it('walks clean → pending → saving → clean', async () => {
    const { autosave, clock } = harness();
    const seen: AutosaveState[] = [];
    autosave.subscribe((event) => {
      if (event.docId === DOC) seen.push(event.status.state);
    });

    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(seen).toEqual(['clean', 'pending', 'saving', 'clean']);
    expect(autosave.status(DOC).dirty).toBe(false);
  });

  it('a failed flush stays dirty and surfaces the error', async () => {
    const boom = new Error('quota exceeded');
    const { autosave, clock } = harness([{ kind: 'fail', error: boom }]);
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');

    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    const status = autosave.status(DOC);
    expect(status.state).toBe('error');
    expect(status.dirty).toBe(true);
    expect(status.lastError).toBe(boom);
    expect(autosave.dirtyDocIds()).toEqual([DOC]);
  });

  it('a failed flush is written by the next flush and the indicator clears', async () => {
    const { autosave, clock, writer } = harness([{ kind: 'fail', error: new Error('nope') }]);
    autosave.open(DOC, { body: 'a', revision: 2 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(writer.calls).toHaveLength(1);

    const reports = await autosave.flush(DOC);

    expect(reports[0]?.outcome).toBe('saved');
    expect(writer.calls).toHaveLength(2);
    expect(writer.calls[1]?.body).toBe('b');
    // The failed write never moved the revision, so the retry is based on the
    // same one — not on a number the scheduler invented to make progress.
    expect(writer.calls[1]?.expectedRevision).toBe(2);
    expect(autosave.status(DOC).dirty).toBe(false);
    expect(autosave.status(DOC).lastError).toBeNull();
  });

  it('a failed flush arms no retry of its own', async () => {
    // §9 says the *next* flush retries and names no interval. Arming one here
    // would be inventing a policy, and on a store that is full it is a loop.
    const { autosave, clock, writer } = harness([{ kind: 'fail', error: new Error('nope') }]);
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(writer.calls).toHaveLength(1);

    await clock.advance(60_000);

    expect(writer.calls).toHaveLength(1);
    expect(clock.armed).toBe(0);
    expect(autosave.status(DOC).dirty).toBe(true);
  });
});

describe('§4 — a failed write keeps the newest body, not the one that failed', () => {
  // Every failure test above fails a write with nothing in the
  // slot, because a scripted `fail` fires before the caller gets control back —
  // so the defect reproduced in the catch was invisible to all of them. These
  // two hold the write open instead, edit under it, and only then fail it.

  it('does not discard a body typed while the write was in flight', async () => {
    // The reproduction, verbatim: type `b`, its write fails, type `c`, and the
    // next flush sends `b` — bodies `['b', 'b']`, with `c` gone and no error
    // anywhere. The second call's body is the whole assertion; a suite that only
    // checked `dirty` or `lastError` would watch this defect happen and pass.
    const boom = new Error('quota exceeded');
    const { autosave, clock, writer } = harness([{ kind: 'hold' }]);
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(writer.calls.map((call) => call.body)).toEqual(['b']);

    autosave.noteEdit(DOC, 'c');
    writer.rejectHeld(0, boom);
    await settle();

    // Not 'error': that state means "no retry is armed", and one is — the
    // mid-flight edit armed its own window. The failure is still reported.
    expect(autosave.status(DOC)).toMatchObject({ state: 'pending', dirty: true });
    expect(autosave.status(DOC).lastError).toBe(boom);
    expect(clock.armed).toBe(1);

    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(writer.calls.map((call) => call.body)).toEqual(['b', 'c']);
    // Revision 0, the one the failed write carried too: atomicity means storage
    // did not move, so there is nothing to rebase onto.
    expect(writer.calls[1]?.expectedRevision).toBe(0);
    expect(autosave.status(DOC).dirty).toBe(false);
  });

  it('does not discard it on the conflict path either', async () => {
    // Same line, so the same rule — but a conflict is the case where it is
    // hardest to see, because the retry cannot succeed: both writes below
    // conflict, and the one that carries `c` is what tells the two apart.
    const conflict = new RevisionConflictError(DOC, 0, 9);
    const { autosave, writer } = harness([
      { kind: 'hold' },
      { kind: 'fail', error: conflict },
      { kind: 'fail', error: conflict },
    ]);
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');

    const first = autosave.flush(DOC);
    await settle();
    expect(writer.calls.map((call) => call.body)).toEqual(['b']);

    autosave.noteEdit(DOC, 'c');
    writer.rejectHeld(0, conflict);
    const [failed] = await first;

    expect(failed?.outcome).toBe('conflict');
    expect(autosave.status(DOC).lastError).toBe(conflict);
    // The mid-flight `c` is still there, and a flush is scheduled for it.
    expect(autosave.status(DOC)).toMatchObject({ state: 'pending', dirty: true });

    const [again] = await autosave.flush(DOC);
    expect(again?.outcome).toBe('conflict');
    expect(writer.calls.map((call) => call.body)).toEqual(['b', 'c']);
    expect(writer.calls.map((call) => call.expectedRevision)).toEqual([0, 0]);
    // Unretried by the conflict, unsaved by the refusal to lose it. And 'error'
    // again, because nothing was typed under *this* write either.
    expect(autosave.status(DOC).dirty).toBe(true);
    expect(autosave.status(DOC).state).toBe('error');
  });

  it('restores the failed body when nothing newer arrived, and arms nothing', async () => {
    // The other arm, and it is the one that must not move: the defect was an
    // unconditional restore, so the fix has to be a *conditional* one. A
    // keystroke-free failure still puts its own body back, still says 'error',
    // and still leaves the recovery surface to §8's close-if-dirty.
    const boom = new Error('quota exceeded');
    const { autosave, clock, writer } = harness([{ kind: 'fail', error: boom }]);
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');

    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    await settle();

    expect(autosave.status(DOC)).toMatchObject({ state: 'error', dirty: true });
    expect(clock.armed).toBe(0);

    await autosave.flush(DOC);

    expect(writer.calls.map((call) => call.body)).toEqual(['b', 'b']);
  });

  it('keeps a mid-flight edit that undid the failed write, which contains none of it', async () => {
    // The case that says the rule is *recency*, not containment. An undo or a
    // select-all-delete while a slow write is in flight is an ordinary thing to
    // do, and it produces a pending body containing **none** of the body that
    // failed — `a` is not a superstring of `bbbb`.
    //
    // The code refuses to restore `bbbb` over the undo. What this pins is the
    // *justification*: the rule is not "the newest pending body already contains
    // the failed one", because taken seriously that argument requires restoring
    // `bbbb`, which is the defect. The other three tests here only ever make
    // the pending body *longer*, so every one of them is consistent with a
    // containment rule; only a shrinking edit separates the two.
    const boom = new Error('quota exceeded');
    const { autosave, clock, writer } = harness([{ kind: 'hold' }]);
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'bbbb');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(writer.calls.map((call) => call.body)).toEqual(['bbbb']);

    // The undo: back to exactly what storage holds.
    autosave.noteEdit(DOC, 'a');
    writer.rejectHeld(0, boom);
    await settle();

    expect(autosave.status(DOC).lastError).toBe(boom);
    expect(autosave.status(DOC)).toMatchObject({ state: 'pending', dirty: true });

    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    // No second transaction at all: the document is back to what is stored, so
    // the failure has nothing left to retry and `bbbb` is never sent.
    expect(writer.calls.map((call) => call.body)).toEqual(['bbbb']);
    // And `clean` beside a live `lastError` — the second half of the state
    // finding, measured rather than asserted in a comment.
    expect(autosave.status(DOC)).toMatchObject({ state: 'clean', dirty: false });
    expect(autosave.status(DOC).lastError).toBe(boom);
  });
});

describe('§9 — the revision the flush carries', () => {
  it('sends the revision the document was opened at', async () => {
    const { autosave, clock, writer } = harness();
    autosave.open(DOC, { body: 'a', revision: 4 });
    autosave.noteEdit(DOC, 'b');

    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(writer.calls[0]?.expectedRevision).toBe(4);
  });

  it('takes the next revision from the store and never counts for itself', async () => {
    // A scheduler tracking `revision + 1` would disagree with storage the first
    // time a write was a no-op or another tab moved the row — and the guard it
    // feeds would then compare against a revision that never existed.
    const { autosave, clock, writer } = harness([{ kind: 'ok', revision: 41 }]);
    autosave.open(DOC, { body: 'a', revision: 4 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(autosave.status(DOC).revision).toBe(41);

    autosave.noteEdit(DOC, 'c');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(writer.calls[1]?.expectedRevision).toBe(41);
  });

  it('refuses to save a document that was never opened', () => {
    // §9's guard is unconditional, so there is no way to reach a write that has
    // no revision to be based on.
    const { autosave } = harness();
    expect(() => autosave.noteEdit('n_not_open', 'x')).toThrow(/never opened/);
  });

  it('reports a conflict as a conflict, keeps the body, and retries nothing', async () => {
    // A conflict cannot be retried into success: the stored revision has moved
    // to somebody else's write, so re-sending the same expectedRevision can only
    // conflict again. Both attempts below carry the same number, which is that
    // arithmetic made visible.
    const conflict = new RevisionConflictError(DOC, 3, 9);
    const { autosave, clock, writer } = harness([
      { kind: 'fail', error: conflict },
      { kind: 'fail', error: conflict },
    ]);
    autosave.open(DOC, { body: 'a', revision: 3 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    const first = await autosave.flush(DOC);
    expect(first[0]?.outcome).toBe('conflict');
    expect(writer.calls[0]?.expectedRevision).toBe(3);
    expect(writer.calls[1]?.expectedRevision).toBe(3);
    // The text is still only in memory, and nothing is scheduled to lose it.
    expect(autosave.status(DOC).dirty).toBe(true);
    expect(autosave.dirtyDocIds()).toEqual([DOC]);
    expect(clock.armed).toBe(0);
  });
});

describe('§4 — re-opening a document is an editor remount, not a re-seed', () => {
  it('keeps a pending body, and the revision it is based on, across a remount', async () => {
    // An editor can remount mid-debounce (a route change, a pane split, a
    // collapsed binder). Re-seeding the revision underneath a pending body would
    // make the next flush guard against a number nothing was written at, so the
    // whole re-open is skipped while a body is outstanding.
    //
    // This is the test that says *where* the guard is: delete
    // `if (existing.pendingBody !== null) return;` and the flush below carries
    // revision 7 instead of 0 — a write guarding against a revision the
    // document was never loaded at, which in a real store is a conflict against
    // the writer that did produce 7.
    const { autosave, clock, writer } = harness();
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');

    autosave.open(DOC, { body: 'someone else got here first', revision: 7 });

    expect(autosave.status(DOC).dirty).toBe(true);
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(writer.calls.map((call) => [call.body, call.expectedRevision])).toEqual([['b', 0]]);
    expect(autosave.status(DOC).revision).toBe(1);
  });

  it('ignores a re-open while a write is in flight', async () => {
    // The guard's other arm. `runFlush` clears `pendingBody` *before* it awaits
    // the write, so a re-open in that window passed a guard testing only
    // `pendingBody` even though a write was running — and the settle then
    // overwrote the seed, so a caller told the document was at revision 7 found
    // the slot back at the write's own 1.
    //
    // Delete `|| existing.inFlight !== null` and the two `toMatchObject`s below
    // are the assertions that fail: the seed takes (revision 7, state 'clean')
    // while the document is still mid-write.
    const { autosave, clock, writer } = harness([{ kind: 'hold' }]);
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(autosave.status(DOC).state).toBe('saving');

    autosave.open(DOC, { body: 'someone else got here first', revision: 7 });

    expect(autosave.status(DOC)).toMatchObject({ state: 'saving', revision: 0, dirty: true });

    writer.settleHeld(0, { revision: 1, changed: true });
    await settle();

    expect(autosave.status(DOC)).toMatchObject({ state: 'clean', revision: 1, dirty: false });
  });

  it('a write that fails after a refused re-open cannot write its body over the new revision', async () => {
    // The corruption the missing guard made reachable, and the reason this is
    // one behaviour fix rather than two tidy-ups: the re-seed took the slot to
    // revision 7, the in-flight write failed, and the catch put `b` into a slot
    // the caller had just said was at 7 — so the next flush wrote the *old* text
    // against somebody else's write. `expectedRevision` is the assertion; the
    // body is `b` either way, because losing it is not an option.
    const { autosave, clock, writer } = harness([{ kind: 'hold' }]);
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    autosave.open(DOC, { body: 'someone else got here first', revision: 7 });
    writer.rejectHeld(0, new Error('quota exceeded'));
    await settle();

    expect(autosave.status(DOC)).toMatchObject({ revision: 0, state: 'error', dirty: true });

    const [report] = await autosave.flush(DOC);

    // The retry *succeeds* here only because the fake store is happy; what it
    // must not do is claim revision 7. In a real store this is the conflict
    // that surfaces to the user instead.
    expect(report?.outcome).toBe('saved');
    expect(writer.calls.map((call) => [call.body, call.expectedRevision])).toEqual([
      ['b', 0],
      ['b', 0],
    ]);
  });

  it('re-seeds a document that has nothing outstanding, body included', async () => {
    // The other arm. Nothing is pending, so there is nothing to protect, and the
    // re-open *is* a fresh load: the slot's idea of what is stored has to move
    // with it. The no-transaction shortcut reads `persistedBody`, so a
    // re-seed that moved the revision but not the body would open a write for an
    // edit that changed nothing.
    const { autosave, clock, writer } = harness();
    autosave.open(DOC, { body: 'a', revision: 0 });
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(autosave.status(DOC).revision).toBe(0);

    autosave.open(DOC, { body: 'restored from a snapshot', revision: 5 });
    expect(autosave.status(DOC)).toMatchObject({
      state: 'clean',
      dirty: false,
      revision: 5,
      lastError: null,
    });

    // Typing back exactly what the re-open says is stored is not a mutation.
    autosave.noteEdit(DOC, 'restored from a snapshot');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(writer.calls).toHaveLength(0);
  });
});

describe('§9 — one write in flight per document', () => {
  it('never starts a second write while one is running', async () => {
    // Without this the second write would carry the revision the first is about
    // to replace, so autosave would conflict with itself on a fast typist and a
    // slow disk — the one input it exists to handle.
    const { autosave, clock, writer } = harness([{ kind: 'hold' }]);
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(writer.calls).toHaveLength(1);

    autosave.noteEdit(DOC, 'c');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(writer.calls).toHaveLength(1);
    expect(writer.peakConcurrency).toBe(1);
  });

  it('writes a mid-flight edit against the revision the running write produced', async () => {
    const { autosave, clock, writer } = harness([{ kind: 'hold' }]);
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    autosave.noteEdit(DOC, 'c');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    writer.settleHeld(0, { revision: 1, changed: true });
    await settle();

    expect(writer.calls).toHaveLength(2);
    expect(writer.calls[1]?.body).toBe('c');
    // Revision 1, not 0: the pending body was typed on top of a write that has
    // now committed, so it is based on what that write produced.
    expect(writer.calls[1]?.expectedRevision).toBe(1);
    expect(autosave.status(DOC).dirty).toBe(false);
  });

  it('still writes a body whose debounce expired during a slow write', async () => {
    // The lost-write case: the window closed while the store was busy, so the
    // timer that would have written it has already fired and been skipped. The
    // body has to go out when the running write settles, or it is only ever in
    // memory.
    const { autosave, clock, writer } = harness([{ kind: 'hold' }]);
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    autosave.noteEdit(DOC, 'c');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(writer.calls).toHaveLength(1);

    writer.settleHeld(0, { revision: 1, changed: true });
    await settle();

    expect(writer.calls.map((call) => call.body)).toEqual(['b', 'c']);
    expect(autosave.dirtyDocIds()).toEqual([]);
  });

  it('a pagehide during a slow write neither starts a second one nor drops the edit', async () => {
    // The tab is going away mid-write. Starting another write would conflict with
    // the running one; dropping the pending body would lose the last edit of the
    // session. The honest answer is to wait for the one in flight and then write
    // against the revision it produced.
    const { autosave, clock, writer, page } = harness([
      { kind: 'hold' },
      { kind: 'hold' },
    ]);
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(writer.calls).toHaveLength(1);

    autosave.noteEdit(DOC, 'c');
    page.dispatchEvent(new Event('pagehide'));
    await settle();

    // The lifecycle flush *waits* for the running write instead of starting a
    // competing one, so nothing new has been attempted and nothing is lost.
    expect(writer.peakConcurrency).toBe(1);
    expect(writer.calls.map((call) => call.body)).toEqual(['b']);
    expect(autosave.status(DOC).dirty).toBe(true);

    // Once it commits, the pending body goes out rebased onto its revision
    // rather than resent against the one it replaced.
    writer.settleHeld(0, { revision: 1, changed: true });
    await settle();
    expect(writer.calls.map((call) => call.body)).toEqual(['b', 'c']);
    expect(writer.calls[1]?.expectedRevision).toBe(1);
    expect(autosave.status(DOC).dirty).toBe(true);

    writer.settleHeld(1, { revision: 2, changed: true });
    await settle();

    expect(autosave.status(DOC).revision).toBe(2);
    expect(autosave.status(DOC).dirty).toBe(false);
    expect(autosave.dirtyDocIds()).toEqual([]);
  });

  it('a lifecycle flush waits for the write already in flight', async () => {
    // `flush()` is the promise a close-if-dirty check awaits, so it must not
    // resolve while an edit is still only in memory.
    const { autosave, clock, writer } = harness([{ kind: 'hold' }]);
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(writer.calls).toHaveLength(1);

    let settled = false;
    const flushing = autosave.flush().then(() => {
      settled = true;
    });
    await settle();
    expect(settled).toBe(false);
    expect(autosave.status(DOC).dirty).toBe(true);

    writer.settleHeld(0, { revision: 1, changed: true });
    await flushing;

    expect(settled).toBe(true);
    expect(autosave.status(DOC).revision).toBe(1);
    expect(autosave.status(DOC).dirty).toBe(false);
  });
});

describe('§4 — the debounce over the real runtime store', () => {
  /** A project in the runtime store, with one scene to edit. */
  async function storedProject(): Promise<{ store: RuntimeStore; factory: MemoryIndexedDb }> {
    const factory = new MemoryIndexedDb();
    const store = await openRuntimeStore(factory, DB);
    openStores.push(store);
    const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', OPENED));
    state.manifest.project.id = PROJECT;
    addDocument(state, {
      parentId: 'manuscript',
      title: 'The Landing',
      body: 'The ferry was late, as always.',
      now: OPENED,
      id: DOC,
    });
    await writeProjectState(store, state, { now: OPENED });
    return { store, factory };
  }

  it('a debounced edit lands in the store with a bumped revision', async () => {
    // The whole slice end to end: an edit, a clock, the one IndexedDB
    // transaction §4 specifies, and the body and revision on the other side of
    // it — read through the store's own path *and* off the raw rows, so a
    // read-path bug cannot hide a write that did not land.
    const { store, factory } = await storedProject();
    const clock = new ManualClock();
    const autosave = createAutosave({ projectId: PROJECT, source: 'store', store, clock });

    autosave.open(DOC, { body: 'The ferry was late, as always.', revision: 0 });
    autosave.noteEdit(DOC, 'The ferry was three hours early.');

    await clock.advance(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(getBody(await readProjectState(store, PROJECT), DOC)).toBe(
      'The ferry was late, as always.',
    );

    await clock.advance(1);
    await settle();

    const reloaded = await readProjectState(store, PROJECT);
    expect(getBody(reloaded, DOC)).toBe('The ferry was three hours early.');
    expect(getRevision(reloaded, DOC)).toBe(1);
    expect(autosave.status(DOC).revision).toBe(1);
    expect(factory.rawRecords(DB, 'documents')).toHaveLength(1);
  });

  it('a flush that fails part-way leaves the stored body and revision untouched', async () => {
    // §9: "IndexedDB atomicity makes partial writes impossible." The claim is
    // about a failure, so this fails the transaction rather than exercising the
    // happy path — and the body must still be in memory afterwards, because
    // nothing was written to be atomic about.
    const { store, factory } = await storedProject();
    const clock = new ManualClock();
    const autosave = createAutosave({ projectId: PROJECT, source: 'store', store, clock });
    const before = factory.rawRecords(DB, 'documents');

    autosave.open(DOC, { body: 'The ferry was late, as always.', revision: 0 });
    autosave.noteEdit(DOC, 'The ferry was three hours early.');
    factory.abortAfterWrites(0);
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    await settle();

    const reloaded = await readProjectState(store, PROJECT);
    expect(getBody(reloaded, DOC)).toBe('The ferry was late, as always.');
    expect(getRevision(reloaded, DOC)).toBe(0);
    expect(factory.rawRecords(DB, 'documents')).toEqual(before);
    expect(autosave.status(DOC).dirty).toBe(true);
    expect(autosave.dirtyDocIds()).toEqual([DOC]);
  });

  it('dispose cancels the pending window and detaches the lifecycle listeners', async () => {
    const { store } = await storedProject();
    const clock = new ManualClock();
    const visibility = new EventTarget();
    const page = new EventTarget();
    const autosave = createAutosave({
      projectId: PROJECT,
      source: 'store',
      store,
      clock,
      signals: domFlushSignals({ visibility, page }),
    });

    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');
    autosave.dispose();

    await clock.advance(60_000);
    visibility.dispatchEvent(new Event('visibilitychange'));
    page.dispatchEvent(new Event('pagehide'));
    await settle();

    expect(getBody(await readProjectState(store, PROJECT), DOC)).toBe(
      'The ferry was late, as always.',
    );
    expect(clock.armed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reseat, the unsaved body, the body a notice carries, and a writer that throws
// ---------------------------------------------------------------------------

describe('§9 — a rebase onto the stored body is not a write (reseat)', () => {
  it('drops the unsaved body, and writes nothing for it even after its window would have run out', async () => {
    const { autosave, clock, writer } = harness();
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');

    await autosave.reseat(DOC, { body: 'c', revision: 0 });
    await clock.advance(AUTOSAVE_DEBOUNCE_MS * 2);

    expect(writer.calls).toHaveLength(0);
    expect(autosave.pendingBodyOf(DOC)).toBeNull();
    expect(autosave.status(DOC)).toMatchObject({ state: 'clean', dirty: false, revision: 0 });
    expect(clock.armed).toBe(0);
  });

  it('rebases to the revision it is given, so the next edit is written against that revision', async () => {
    const { autosave, clock, writer } = harness();
    autosave.open(DOC, { body: 'a', revision: 4 });
    autosave.noteEdit(DOC, 'b');

    await autosave.reseat(DOC, { body: 'c', revision: 9 });
    autosave.noteEdit(DOC, 'd');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(writer.calls).toEqual([expect.objectContaining({ body: 'd', expectedRevision: 9 })]);
  });

  it('a revision older than the one the wait settled on does not move the base back, and the rebased body is the stored one', async () => {
    // Held, so the rebase has a write to wait out. The caller's 4 is stale: the held write settles at 5, and that
    // settle is the store's number, so the base stays at 5. Afterwards the store holds `c`, so typing `c` again is
    // no change and must open no transaction.
    const { autosave, clock, writer } = harness([{ kind: 'hold' }]);
    autosave.open(DOC, { body: 'a', revision: 4 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(writer.calls).toHaveLength(1);

    const rebase = autosave.reseat(DOC, { body: 'c', revision: 4 });
    writer.settleHeld(0, { revision: 5, changed: true });
    await rebase;

    expect(autosave.status(DOC)).toMatchObject({ dirty: false, revision: 5 });
    autosave.noteEdit(DOC, 'c');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(writer.calls).toHaveLength(1);
  });

  it('names the revision in its type, so a rebase cannot leave the base behind the store', () => {
    const { autosave } = harness();
    // The compile-time half of the contract: `tsc` fails here if `revision` ever becomes optional again.
    const withoutRevision = (): Promise<void> =>
      // @ts-expect-error a rebase names the revision the store holds for the body it is given
      autosave.reseat(DOC, { body: 'c' });
    expect(typeof withoutRevision).toBe('function');
  });

  it('waits out a write in flight, and the settle of that write does not undo the rebase', async () => {
    // The settle writes revision 5 into the slot. A rebase that landed before it would be undone,
    // and the next edit would then be written against 5 rather than the rebased 7.
    const { autosave, clock, writer } = harness([{ kind: 'hold' }]);
    autosave.open(DOC, { body: 'a', revision: 4 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    const rebase = autosave.reseat(DOC, { body: 'c', revision: 7 });
    writer.settleHeld(0, { revision: 5, changed: true });
    await rebase;

    expect(autosave.status(DOC)).toMatchObject({ dirty: false, revision: 7 });
    autosave.noteEdit(DOC, 'e');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(writer.calls.at(-1)).toEqual(expect.objectContaining({ body: 'e', expectedRevision: 7 }));
  });

  it('discards an edit typed during the wait, even when its window ran out before the write settled', async () => {
    // The race the flush guard exists for: the window of an edit typed during the wait fires
    // while the write is still in flight, and the write then settles. Without the guard the
    // settle would start a write of the very body the rebase is discarding.
    const { autosave, clock, writer } = harness([{ kind: 'hold' }]);
    autosave.open(DOC, { body: 'a', revision: 4 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    const rebase = autosave.reseat(DOC, { body: 'c', revision: 7 });
    autosave.noteEdit(DOC, 'x');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    writer.settleHeld(0, { revision: 5, changed: true });
    await rebase;

    expect(writer.calls).toHaveLength(1);
    expect(autosave.pendingBodyOf(DOC)).toBeNull();
    expect(autosave.status(DOC)).toMatchObject({ dirty: false, revision: 7 });
  });

  it('clears the failure of a write whose body the rebase replaces, since nothing is left to retry', async () => {
    const boom = new Error('quota exceeded');
    const { autosave, clock } = harness([{ kind: 'fail', error: boom }]);
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(autosave.status(DOC)).toMatchObject({ state: 'error', dirty: true, lastError: boom });

    await autosave.reseat(DOC, { body: 'c', revision: 0 });

    expect(autosave.status(DOC)).toMatchObject({ state: 'clean', dirty: false, lastError: null });
  });

  it('refuses a document it was never told about, because it has no stored state to rebase', async () => {
    const { autosave } = harness();
    await expect(autosave.reseat(DOC, { body: 'c', revision: 1 })).rejects.toThrow(/never opened/);
  });
});

describe('§9 — the unsaved body, and the body a notice carries', () => {
  it('pendingBodyOf names the body waiting for a write, and nothing once that body is being stored', async () => {
    const { autosave, clock, writer } = harness([{ kind: 'hold' }]);
    autosave.open(DOC, { body: 'a', revision: 0 });
    expect(autosave.pendingBodyOf(DOC)).toBeNull();

    autosave.noteEdit(DOC, 'b');
    expect(autosave.pendingBodyOf(DOC)).toBe('b');

    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    // Taken by the write in flight: it is being stored, so it is no longer waiting.
    expect(writer.calls).toHaveLength(1);
    expect(autosave.pendingBodyOf(DOC)).toBeNull();

    writer.settleHeld(0, { revision: 1, changed: true });
    await settle();
    expect(autosave.pendingBodyOf(DOC)).toBeNull();
  });

  it('names the body back after a failed write, which kept it', async () => {
    const { autosave, clock } = harness([{ kind: 'fail', error: new Error('nope') }]);
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(autosave.pendingBodyOf(DOC)).toBe('b');
  });

  it('carries the body on every notice: the seed, the edit, the write, and the rebase', async () => {
    const { autosave, clock } = harness();
    const bodies: string[] = [];
    autosave.subscribe((event) => bodies.push(event.body));

    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    await autosave.reseat(DOC, { body: 'c', revision: 1 });

    // seed, edit, saving, saved, rebase: the body each notice reports is the one the scheduler holds then.
    expect(bodies).toEqual(['a', 'b', 'b', 'b', 'c']);
  });

  it('a notice during a write carries the newer edit, not the body being written', async () => {
    const { autosave, clock, writer } = harness([{ kind: 'hold' }]);
    const bodies: string[] = [];
    autosave.subscribe((event) => bodies.push(event.body));
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    autosave.noteEdit(DOC, 'c');
    expect(bodies.at(-1)).toBe('c');

    writer.settleHeld(0, { revision: 1, changed: true });
    await settle();
    expect(bodies.at(-1)).toBe('c');
  });
});

describe('§9 — the body is produced when the write needs it, not when the keystroke arrives', () => {
  // §9's pipeline is "`onChange` → debounce 800 ms → dispatch `doc.write {docId,
  // body, expectedRevision}`": the body belongs to the *write*, not to the
  // keystroke that armed the window. A note may therefore carry a **producer** —
  // a thunk that yields the text when the body is needed — and the scheduler
  // calls it once, when the body is needed.
  //
  // Why it matters: an editor that renders its text on demand (the Markdown
  // projection of a whole scene) would otherwise render it on the leading edge of
  // every keystroke and throw away all but the last one. The debounce is supposed
  // to amortize that work; a producer is where it is amortized instead.

  it('calls the producer once for a window of edits, and writes the newest text', async () => {
    const { autosave, clock, writer } = harness();
    autosave.open(DOC, { body: 'a', revision: 0 });

    let renders = 0;
    let text = 'a';
    for (let i = 0; i < 12; i += 1) {
      text = `keystroke ${i}`;
      autosave.noteEdit(DOC, () => {
        renders += 1;
        return text;
      });
      await clock.advance(50);
    }
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    // Twelve keystrokes, one rendering: the window is where the work is amortized.
    expect(renders).toBe(1);
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]?.body).toBe('keystroke 11');
  });

  it('writes the text as it is when the window closes, not the text of the first keystroke', async () => {
    const { autosave, clock, writer } = harness();
    autosave.open(DOC, { body: 'a', revision: 0 });

    let text = 'a';
    autosave.noteEdit(DOC, () => text);
    text = 'typed after the edit';

    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(writer.calls[0]?.body).toBe('typed after the edit');
  });

  it('gives each document the body of its own editor, so switching documents does not cross them', async () => {
    const { autosave, clock, writer } = harness();
    const second = 'n_2KD4RP8X1W6';
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.open(second, { body: 'x', revision: 0 });

    // Two editors, one of them on screen at a time. A producer that read "the
    // editor on screen" would write the same text for both documents; each
    // producer reads its own.
    const scene = { text: 'scene text' };
    const chapter = { text: 'chapter text' };
    autosave.noteEdit(DOC, () => scene.text);
    autosave.noteEdit(second, () => chapter.text);

    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    const written = new Map(writer.calls.map((call) => [call.docId, call.body]));
    expect(written.get(DOC)).toBe('scene text');
    expect(written.get(second)).toBe('chapter text');
  });

  it('writes the last text the editor had, when the editor is gone before the window closes', async () => {
    const { autosave, clock, writer } = harness();
    autosave.open(DOC, { body: 'a', revision: 0 });

    // An editor torn down before the window closes hands over the last text it
    // had, and the producer says that from then on.
    let live = 'first';
    let captured = 'first';
    let alive = true;
    autosave.noteEdit(DOC, () => (alive ? live : captured));

    live = 'second';
    captured = live;
    alive = false;

    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(writer.calls[0]?.body).toBe('second');
  });

  it('flushes a producer on a lifecycle signal, without waiting out the debounce', async () => {
    const { autosave, hide, writer } = harness();
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, () => 'typed text');

    await hide();

    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]?.body).toBe('typed text');
  });

  it('names the pending body back, and the flush writes that same text', async () => {
    const { autosave, clock, writer } = harness();
    autosave.open(DOC, { body: 'a', revision: 0 });

    let renders = 0;
    autosave.noteEdit(DOC, () => {
      renders += 1;
      return 'produced body';
    });

    expect(autosave.pendingBodyOf(DOC)).toBe('produced body');
    expect(renders).toBe(1);

    await clock.advance(AUTOSAVE_DEBOUNCE_MS);
    expect(writer.calls[0]?.body).toBe('produced body');
    // Not asked again: the flush writes what was already produced.
    expect(renders).toBe(1);
  });

  it('a producer that fails is a failed write, and the edit stays where it is', async () => {
    const { autosave, clock, writer } = harness();
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, () => {
      throw new Error('the editor is gone');
    });

    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(writer.calls).toHaveLength(0);
    expect(autosave.status(DOC).state).toBe('error');
    expect(autosave.status(DOC).dirty).toBe(true);
  });

  it('a body asked for before the document moves is the body the write sends', async () => {
    // The editor's text, as the producer the scheduler asks when the body is needed.
    // A change that is not the user's lands on the document while the user's edit is
    // still waiting for its window, so the editor asks for the pending body *before*
    // that change lands: what the user typed is what the write sends, and the
    // change is the agent's own write to make.
    const { autosave, clock, writer } = harness();
    autosave.open(DOC, { body: 'a', revision: 0 });

    const editor = { text: 'the user’s text' };
    autosave.noteEdit(DOC, () => editor.text);

    expect(autosave.pendingBodyOf(DOC)).toBe('the user’s text');
    // The change lands: the editor now reads as the agent's text.
    editor.text = 'the agent’s text';

    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]?.body).toBe('the user’s text');
    expect(writer.calls[0]?.expectedRevision).toBe(0);
  });

  it('a producer that fails is retried once, and the retry sends the text', async () => {
    // A failed write is the store failing, and the store keeps failing; a failed
    // producer is the editor's text failing to be read, and the next attempt may
    // well succeed. So the window is armed again, once.
    const { autosave, clock, writer } = harness();
    autosave.open(DOC, { body: 'a', revision: 0 });

    let attempts = 0;
    autosave.noteEdit(DOC, () => {
      attempts += 1;
      if (attempts === 1) throw new Error('the editor is mid-teardown');
      return 'typed text';
    });

    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(writer.calls).toHaveLength(0);
    expect(autosave.status(DOC)).toMatchObject({ state: 'error', dirty: true });

    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]?.body).toBe('typed text');
    expect(autosave.status(DOC)).toMatchObject({ state: 'clean', dirty: false, lastError: null });
  });

  it('a producer that keeps failing is not retried forever', async () => {
    // One retry, and no more: a loop against a producer that fails every time is
    // what this file's header refuses. The failure then stands, and the edit is
    // still the store's to retry.
    const { autosave, clock, writer } = harness();
    autosave.open(DOC, { body: 'a', revision: 0 });

    let attempts = 0;
    autosave.noteEdit(DOC, () => {
      attempts += 1;
      throw new Error('the editor is gone');
    });

    await clock.advance(AUTOSAVE_DEBOUNCE_MS * 10);

    expect(attempts).toBe(2);
    expect(writer.calls).toHaveLength(0);
    expect(clock.armed).toBe(0);
    expect(autosave.status(DOC)).toMatchObject({ state: 'error', dirty: true });
  });

  it('a new edit gives a failed producer its one retry again', async () => {
    const { autosave, clock, writer } = harness();
    autosave.open(DOC, { body: 'a', revision: 0 });

    let attempts = 0;
    autosave.noteEdit(DOC, () => {
      attempts += 1;
      throw new Error('the editor is gone');
    });
    await clock.advance(AUTOSAVE_DEBOUNCE_MS * 2);
    expect(attempts).toBe(2);

    // The writer types again: a new edit is a new chance, and the retry is armed
    // once more for it.
    autosave.noteEdit(DOC, () => {
      attempts += 1;
      return 'typed text';
    });
    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]?.body).toBe('typed text');
  });

  it('a string body still works exactly as it did', async () => {
    // The union is backward compatible: a caller that already has the text keeps
    // handing it over, and nothing about the window changes.
    const { autosave, clock, writer } = harness();
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');

    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0]?.body).toBe('b');
  });
});

describe('§9 — a writer that throws is a failed write, not a save that never ends', () => {
  function throwingOnce(error: unknown): {
    write: (request: DocumentWriteRequest) => Promise<WriteDocumentResult>;
    calls: () => number;
  } {
    let calls = 0;
    return {
      calls: () => calls,
      write: (request) => {
        calls += 1;
        if (calls === 1) throw error;
        return Promise.resolve({ revision: request.expectedRevision + 1, changed: true });
      },
    };
  }

  it('leaves the document failed with its body kept, rather than saving forever', async () => {
    const boom = new Error('connection closed');
    const writer = throwingOnce(boom);
    const clock = new ManualClock();
    const autosave = createAutosave({ projectId: PROJECT, source: 'write', write: writer.write, clock });
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');

    await clock.advance(AUTOSAVE_DEBOUNCE_MS);

    expect(autosave.status(DOC)).toMatchObject({ state: 'error', dirty: true, lastError: boom });
    expect(autosave.pendingBodyOf(DOC)).toBe('b');
    // The next flush stores the body the throw kept, against the revision that was never moved.
    const reports = await autosave.flush(DOC);
    expect(reports[0]).toMatchObject({ outcome: 'saved', revision: 1 });
    expect(autosave.status(DOC)).toMatchObject({ state: 'clean', dirty: false, lastError: null });
  });

  it('reports the throw as the failure of the flush that made it', async () => {
    const boom = new Error('connection closed');
    const writer = throwingOnce(boom);
    const clock = new ManualClock();
    const autosave = createAutosave({ projectId: PROJECT, source: 'write', write: writer.write, clock });
    autosave.open(DOC, { body: 'a', revision: 0 });
    autosave.noteEdit(DOC, 'b');

    const reports = await autosave.flush(DOC);

    expect(reports[0]).toMatchObject({ outcome: 'failed', error: boom });
    expect(writer.calls()).toBe(1);
  });
});
