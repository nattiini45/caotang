/**
 * The import preview's reader host (issues #283 / #274 / #390): its hard timeout, its Cancel, and its disposal, with a fake Worker so
 * the lifecycle is tested without a browser. The real Worker is proven in e2e/import-worker-host.spec.ts and the reader Worker specs.
 * The protocol's transfer helpers are pure and checked here too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReaderHost, ReaderHostError } from '../src/import-preview/reader-host.js';
import { dedicatedBuffer, resultTransferList, type ReaderResult } from '../src/import-preview/reader-protocol.js';

class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  readonly posted: unknown[] = [];
  terminated = false;
  constructor(readonly url: unknown, readonly options?: unknown) {
    FakeWorker.last = this;
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const readRtf = { kind: 'read', reader: 'rtf' } as const;

/** Drains the promise queue, so a re-open's chain (request → open → shared promise → read) has run without a sleep or a retry. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  FakeWorker.last = null;
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ReaderHost lifecycle', () => {
  it('rejects a read that never answers with a timeout, and terminates the hung Worker', async () => {
    const host = new ReaderHost(20);
    const pending = host.read(readRtf);
    await expect(pending).rejects.toMatchObject({ name: 'ReaderHostError', code: 'timeout' });
    expect(FakeWorker.last?.terminated).toBe(true);
  });

  it('rejects with cancelled when the signal aborts mid-read', async () => {
    const host = new ReaderHost(5_000);
    const controller = new AbortController();
    const pending = host.read(readRtf, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(FakeWorker.last?.terminated).toBe(true);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const host = new ReaderHost(5_000);
    await expect(host.read(readRtf, AbortSignal.abort())).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('rejects waiting reads when disposed', async () => {
    const host = new ReaderHost(5_000);
    const pending = host.read(readRtf);
    host.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('starts a fresh Worker after disposal, so a remounted preview reads again', async () => {
    const host = new ReaderHost(5_000);
    const first = host.read(readRtf);
    const firstWorker = FakeWorker.last;
    host.dispose();
    await expect(first).rejects.toMatchObject({ code: 'cancelled' });
    const second = host.read(readRtf);
    expect(FakeWorker.last).not.toBe(firstWorker);
    FakeWorker.last?.reply({ id: 2, ok: true, result: { kind: 'opened' } });
    await expect(second).resolves.toEqual({ kind: 'opened' });
  });

  it('gives a fresh Worker its input again after a timeout, so the next option change reads (#597 F4)', async () => {
    const host = new ReaderHost(20);
    const bytes = new Uint8Array([1, 2, 3]);
    const opened = host.open({ kind: 'open', reader: 'rtf', bytes });
    FakeWorker.last?.reply({ id: 1, ok: true, result: { kind: 'opened' } });
    await opened;
    const hung = host.read(readRtf);
    await expect(hung).rejects.toMatchObject({ code: 'timeout' });
    const dead = FakeWorker.last;
    expect(dead?.terminated).toBe(true);

    // The writer changes an option: the read must reach a Worker that holds the file, not one that was never opened.
    const retry = host.read(readRtf);
    await flush();
    const fresh = FakeWorker.last;
    expect(fresh).not.toBe(dead);
    expect(fresh?.posted).toEqual([{ kind: 'open', reader: 'rtf', bytes, id: 3 }]);
    fresh?.reply({ id: 3, ok: true, result: { kind: 'opened' } });
    await flush();
    expect(fresh?.posted[1]).toEqual({ ...readRtf, id: 4 });
    fresh?.reply({ id: 4, ok: true, result: { kind: 'rtf', result: { ok: true, value: {} } } });
    await expect(retry).resolves.toMatchObject({ kind: 'rtf' });
  });

  it('shares one re-open between reads that arrive together, so the file is not sent twice', async () => {
    const host = new ReaderHost(5_000);
    const bytes = new Uint8Array([9]);
    const opened = host.open({ kind: 'open', reader: 'text', bytes });
    FakeWorker.last?.reply({ id: 1, ok: true, result: { kind: 'opened' } });
    await opened;
    host.dispose();
    const one = host.read({ kind: 'read', reader: 'text' });
    const two = host.read({ kind: 'read', reader: 'text' });
    await flush();
    const fresh = FakeWorker.last;
    expect(fresh?.posted.length).toBe(1);
    fresh?.reply({ id: 2, ok: true, result: { kind: 'opened' } });
    await flush();
    expect(fresh?.posted.length).toBe(3);
    fresh?.reply({ id: 3, ok: true, result: { kind: 'opened' } });
    fresh?.reply({ id: 4, ok: true, result: { kind: 'opened' } });
    await expect(one).resolves.toMatchObject({ kind: 'opened' });
    await expect(two).resolves.toMatchObject({ kind: 'opened' });
  });

  it('a re-open that fails leaves the next read free to try again', async () => {
    const host = new ReaderHost(5_000);
    const bytes = new Uint8Array([7]);
    const opened = host.open({ kind: 'open', reader: 'rtf', bytes });
    FakeWorker.last?.reply({ id: 1, ok: true, result: { kind: 'opened' } });
    await opened;
    host.dispose();
    const failing = host.read(readRtf);
    await flush();
    FakeWorker.last?.reply({ id: 2, ok: false, error: 'the package is not readable' });
    await expect(failing).rejects.toMatchObject({ code: 'worker-error', message: 'the package is not readable' });
    const again = host.read(readRtf);
    await flush();
    expect(FakeWorker.last?.posted[0]).toMatchObject({ kind: 'open', reader: 'rtf' });
    FakeWorker.last?.reply({ id: 3, ok: true, result: { kind: 'opened' } });
    await flush();
    FakeWorker.last?.reply({ id: 4, ok: true, result: { kind: 'opened' } });
    await expect(again).resolves.toMatchObject({ kind: 'opened' });
  });

  it('resolves a read with the Worker’s reply', async () => {
    const host = new ReaderHost(5_000);
    const pending = host.read(readRtf);
    FakeWorker.last?.reply({ id: 1, ok: true, result: { kind: 'opened' } });
    await expect(pending).resolves.toEqual({ kind: 'opened' });
    expect(FakeWorker.last?.terminated).toBe(false);
  });

  it('reads again through the real reader session after a cancel, which needs the input handed over again (#597 F4)', async () => {
    // The session is the real one the Worker runs, so this is the failure the writer met: a fresh Worker holds no input and
    // refuses the read with "the import reader was not opened" until the host sends the open again.
    const { createReaderSession } = await import('../src/import-preview/reader-session.js');
    const sessions = new Map<FakeWorker, ReturnType<typeof createReaderSession>>();
    const answer = (worker: FakeWorker, index: number): void => {
      const message = worker.posted[index] as Parameters<ReturnType<typeof createReaderSession>>[0] & { id: number };
      const session = sessions.get(worker) ?? createReaderSession();
      sessions.set(worker, session);
      void session(message).then(
        (result) => worker.reply({ id: message.id, ok: true, result }),
        (failure: unknown) => worker.reply({ id: message.id, ok: false, error: failure instanceof Error ? failure.message : String(failure) }),
      );
    };
    const host = new ReaderHost(5_000);
    const bytes = new TextEncoder().encode('One paragraph.\n\nAnother.\n');
    const opened = host.open({ kind: 'open', reader: 'text', bytes });
    await flush();
    answer(FakeWorker.last as FakeWorker, 0);
    await opened;
    const first = host.read({ kind: 'read', reader: 'text' });
    await flush();
    answer(FakeWorker.last as FakeWorker, 1);
    await expect(first).resolves.toMatchObject({ kind: 'text', result: { status: 'read' } });

    host.dispose();
    const retry = host.read({ kind: 'read', reader: 'text', paragraphs: 'line' });
    await flush();
    const fresh = FakeWorker.last as FakeWorker;
    answer(fresh, 0);
    await flush();
    answer(fresh, 1);
    const result = await retry;
    expect(result).toMatchObject({ kind: 'text', result: { status: 'read', paragraphs: 'line' } });
  });

  it('rejects with worker-error when the Worker reports a failure', async () => {
    const host = new ReaderHost(5_000);
    const pending = host.read(readRtf);
    FakeWorker.last?.reply({ id: 1, ok: false, error: 'the reader failed' });
    await expect(pending).rejects.toMatchObject({ code: 'worker-error', message: 'the reader failed' });
  });

  it('rejects with worker-error when the Worker fails to start', async () => {
    const host = new ReaderHost(5_000);
    const pending = host.read(readRtf);
    FakeWorker.last?.onerror?.({ message: 'boom' });
    await expect(pending).rejects.toBeInstanceOf(ReaderHostError);
  });
});

describe('transfer helpers', () => {
  it('dedicatedBuffer returns a buffer the view owns whole, and null for a partial view', () => {
    const whole = new Uint8Array(4);
    expect(dedicatedBuffer(whole)).toBe(whole.buffer);
    const partial = new Uint8Array(whole.buffer, 1, 2);
    expect(dedicatedBuffer(partial)).toBeNull();
  });

  it('resultTransferList lists an RTF read’s picture buffers, and nothing for a refusal or a text read', () => {
    const picture = new Uint8Array(3);
    const rtf = { kind: 'rtf', result: { ok: true, value: { assetData: new Map([['import:rtf-image-1.png', picture]]) } } } as unknown as ReaderResult;
    expect(resultTransferList(rtf)).toEqual([picture.buffer]);
    const refused = { kind: 'rtf', result: { ok: false, error: { code: 'not-rtf', message: '' } } } as unknown as ReaderResult;
    expect(resultTransferList(refused)).toEqual([]);
    const text = { kind: 'text', result: { status: 'read' } } as unknown as ReaderResult;
    expect(resultTransferList(text)).toEqual([]);
  });

  it('resultTransferList lists a shared picture buffer once, so a repeated attachment does not fail the reply (#597 F1)', () => {
    const picture = new Uint8Array(3);
    const twin = new Uint8Array(picture.buffer);
    const rtf = {
      kind: 'rtf',
      result: { ok: true, value: { assetData: new Map([['import:rtf-image-1.png', picture], ['import:rtf-image-2.png', twin]]) } },
    } as unknown as ReaderResult;
    expect(resultTransferList(rtf)).toEqual([picture.buffer]);
  });
});
