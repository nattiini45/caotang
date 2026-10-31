/**
 * The app's side of the P14 transcription review gate (pictures.md §8.4 step 3): a transient broker that holds
 * one generated proposal at a time and answers the harness's `PictureTranscriptionHost.review` with what the
 * writer approved — or `null` when they cancelled or the call's signal aborted.
 *
 * The broker is deliberately thin: it dispatches nothing, writes nothing and touches no bus command. The
 * harness port (`transcriptionPort`) runs the review through `review`, then dispatches exactly one
 * `asset.transcribe` itself; the dialog (`../media/TranscriptionReviewDialog.tsx`) only calls `answer`/`cancel`.
 * Results are transient by design (§8.4 step 6: a cancelled or aborted review dispatches nothing).
 */

import type { PictureTranscriptionHost, PictureTranscriptionProposal, PictureTranscriptionReviewResult } from '@caotang/harness';

/** What a subscriber is told on every change: the held proposal, or `null` when the gate is closed. */
export type TranscriptionReviewListener = (proposal: PictureTranscriptionProposal | null) => void;

interface HeldReview {
  readonly proposal: PictureTranscriptionProposal;
  readonly resolve: (result: PictureTranscriptionReviewResult | null) => void;
  readonly signal?: AbortSignal;
  /** Attached when the caller's signal is given; mutable only for that one assignment at creation. */
  onAbort: (() => void) | null;
  /** Set once the entry has resolved — by answer, cancel or abort — so a late abort changes nothing. */
  done: boolean;
}

/**
 * Holds at most one proposal for review. `review` matches `PictureTranscriptionHost['review']`, and ProjectSession
 * wires it straight into the harness host; a second call while one is held waits its turn and is held when the
 * current review resolves. Abort or cancellation resolves the waiting promise with `null` and clears the held
 * state, promoting the next queued review if there is one.
 */
export class TranscriptionReviewBroker implements Pick<PictureTranscriptionHost, 'review'> {
  private held: HeldReview | null = null;
  private readonly waiting: HeldReview[] = [];
  private readonly listeners = new Set<TranscriptionReviewListener>();

  /** The proposal currently held for review, or `null` when no review is open. */
  snapshot(): PictureTranscriptionProposal | null {
    return this.held?.proposal ?? null;
  }

  /**
   * Subscribes to the held proposal. The listener is called immediately with the current snapshot, and again
   * on every change. Returns the unsubscribe function.
   */
  subscribe(listener: TranscriptionReviewListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * `PictureTranscriptionHost.review`: holds `draft` and resolves with the writer's answer — the approved
   * pages, each possibly edited, or `null` when the writer cancelled or `signal` aborted. An already-aborted
   * signal resolves `null` immediately and never holds anything.
   */
  review(draft: PictureTranscriptionProposal, signal?: AbortSignal): Promise<PictureTranscriptionReviewResult | null> {
    return new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve(null);
        return;
      }
      const entry: HeldReview = { proposal: draft, resolve, signal, onAbort: null, done: false };
      if (signal !== undefined) {
        entry.onAbort = () => this.abortOf(entry);
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      if (this.held === null) this.hold(entry);
      else this.waiting.push(entry);
    });
  }

  /**
   * The UI's answer to the held review: the approved result, or `null` to cancel. A no-op when nothing is
   * held, so a stray Escape on a closed gate changes nothing.
   */
  answer(result: PictureTranscriptionReviewResult | null): void {
    if (this.held !== null) this.settle(this.held, result);
  }

  /** Cancels the held review — the same as `answer(null)`. */
  cancel(): void {
    this.answer(null);
  }

  private hold(entry: HeldReview): void {
    this.held = entry;
    this.emit();
  }

  /** An aborted entry resolves `null`, whether it is the held one or still waiting. */
  private abortOf(entry: HeldReview): void {
    if (entry.done) return;
    const at = this.waiting.indexOf(entry);
    if (at !== -1) this.waiting.splice(at, 1);
    this.settle(entry, null);
  }

  private settle(entry: HeldReview, result: PictureTranscriptionReviewResult | null): void {
    if (entry.done) return;
    entry.done = true;
    if (entry.signal !== undefined && entry.onAbort !== null) entry.signal.removeEventListener('abort', entry.onAbort);
    entry.resolve(result);
    if (this.held === entry) {
      this.held = null;
      this.emit();
      const next = this.waiting.shift();
      if (next !== undefined) this.hold(next);
    }
  }

  private emit(): void {
    const proposal = this.snapshot();
    for (const listener of [...this.listeners]) listener(proposal);
  }
}
