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

  it('resolves a read with the Worker’s reply', async () => {
    const host = new ReaderHost(5_000);
    const pending = host.read(readRtf);
    FakeWorker.last?.reply({ id: 1, ok: true, result: { kind: 'opened' } });
    await expect(pending).resolves.toEqual({ kind: 'opened' });
    expect(FakeWorker.last?.terminated).toBe(false);
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
});
