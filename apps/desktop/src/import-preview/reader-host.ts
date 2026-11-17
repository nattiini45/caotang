/**
 * The import preview's reader host (issues #283 / #274 / #390): owns one `'self'` module Worker (reader.worker.ts) and runs the
 * readers in it, so a large file never blocks typing or scrolling on the main thread. The Worker is created on the first request
 * and bundled as its own lazy chunk, so the first load carries none of it.
 *
 * Every request has a hard timeout: a reader that hangs is terminated, not left running, and the next request starts a fresh
 * Worker. The dialog's Cancel (an `AbortSignal`) terminates it too. The input bytes are transferred once on `open`; `read` re-reads
 * the Worker's cached copy, so an option toggle copies nothing. **A fresh Worker holds no input**, so after a timeout, a cancel or a
 * Worker failure the host sends its cached `open` again before the read (#597 F4): without that, every later option change would fail
 * with "the import reader was not opened" and the preview could never read again.
 *
 * The Worker is same-origin (`new URL(..., import.meta.url)`, `type: 'module'`), never a `blob:` URL: the app's CSP is
 * `worker-src 'self'` with no `blob:` (the pattern e2e/import-rtf-worker.spec.ts proves).
 */

import { t } from '@lingui/core/macro';

import type { ReaderOpen, ReaderRead, ReaderReply, ReaderResult } from './reader-protocol.js';

export type ReaderHostErrorCode = 'timeout' | 'cancelled' | 'worker-error';

/** Why the host could not answer: a hung reader, the writer's Cancel, or a Worker that failed to start or run. */
export class ReaderHostError extends Error {
  override readonly name = 'ReaderHostError';
  constructor(
    readonly code: ReaderHostErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A backstop beyond the readers' own deadlines (RTF reads under a 60 s limit of its own); a read past this is terminated. */
const DEFAULT_TIMEOUT_MS = 120_000;

interface Pending {
  readonly resolve: (result: ReaderResult) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class ReaderHost {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** The last `open`, kept so a Worker started after a failure can be given the same input again. The bytes were cloned, so they are still here. */
  private input: ReaderOpen | null = null;
  /** Whether the live Worker holds that input. False until an `open` lands, and false again whenever the Worker goes. */
  private held = false;
  /** One re-open shared by reads that arrive together, so a retry does not send the file twice. */
  private reopening: Promise<void> | null = null;

  /** `timeoutMs` is the hard per-request backstop; tests pass a short one. */
  constructor(private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  private ensure(): Worker {
    if (this.worker !== null) return this.worker;
    const worker = new Worker(new URL('./reader.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<ReaderReply>) => {
      const reply = event.data;
      const entry = this.pending.get(reply.id);
      if (entry === undefined) return;
      this.pending.delete(reply.id);
      clearTimeout(entry.timer);
      if (reply.ok && reply.result !== undefined) entry.resolve(reply.result);
      else entry.reject(new ReaderHostError('worker-error', reply.error ?? t`The import reader failed.`));
    };
    worker.onerror = (event: ErrorEvent) => {
      this.failAll(new ReaderHostError('worker-error', event.message || t`The import reader failed to start.`));
    };
    this.worker = worker;
    return worker;
  }

  /** Rejects every waiting request and terminates the Worker, so a hung or cancelled read keeps nothing alive. */
  private failAll(error: ReaderHostError): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    this.held = false;
  }

  private request(message: { readonly id: number } & (ReaderOpen | ReaderRead), transfer: Transferable[], signal?: AbortSignal): Promise<ReaderResult> {
    const worker = this.ensure();
    const id = (message as { id: number }).id;
    return new Promise<ReaderResult>((resolve, reject) => {
      const settle = (error: ReaderHostError): void => {
        const entry = this.pending.get(id);
        if (entry === undefined) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(error);
        // A hung or cancelled read keeps nothing alive: the Worker goes, and any other waiting read is refused too.
        this.failAll(error);
      };
      const timer = setTimeout(() => settle(new ReaderHostError('timeout', t`Reading the file took too long.`)), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (signal !== undefined) {
        if (signal.aborted) {
          settle(new ReaderHostError('cancelled', t`The import was cancelled.`));
          return;
        }
        signal.addEventListener('abort', () => settle(new ReaderHostError('cancelled', t`The import was cancelled.`)), { once: true });
      }
      worker.postMessage(message, transfer);
    });
  }

  /** Hands the input to the Worker once (cloned, so the source keeps its copy for a remount); the Worker caches it for every read. */
  open(req: ReaderOpen, signal?: AbortSignal): Promise<void> {
    this.input = req;
    this.held = false;
    const id = this.nextId++;
    return this.request({ ...req, id }, [], signal).then(() => {
      this.held = true;
    });
  }

  /**
   * Re-reads the Worker's cached input with these options. When the Worker was terminated since the input was handed over (a timeout,
   * a cancel, a Worker failure or a disposal), the cached `open` goes first, so the read reaches a Worker that holds the file (#597 F4).
   */
  async read(req: ReaderRead, signal?: AbortSignal): Promise<ReaderResult> {
    const input = this.input;
    if (input !== null && !this.held) {
      this.reopening ??= this.open(input, signal).finally(() => {
        this.reopening = null;
      });
      await this.reopening;
    }
    const id = this.nextId++;
    return this.request({ ...req, id }, [], signal);
  }

  /**
   * Terminates the Worker and rejects anything waiting. The preview calls this when it closes (and React's StrictMode calls it on a
   * dev remount); a later request starts a fresh Worker, so a remounted preview reads again rather than staying cancelled.
   */
  dispose(): void {
    this.failAll(new ReaderHostError('cancelled', t`The import was cancelled.`));
  }
}
