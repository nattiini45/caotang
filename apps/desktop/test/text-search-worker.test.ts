import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTextSearchWorker } from '../src/app/text-search-worker.js';
import type { TextSearchReply, TextSearchRequest } from '../src/app/text-search-protocol.js';
import { textSearchPort } from '@caotang/harness';
import { makeHarness } from '../../../packages/harness/test/fixtures.js';

class HeldWorker {
  static instances: HeldWorker[] = [];
  readonly messages: TextSearchRequest[] = [];
  readonly terminate = vi.fn();
  onmessage: ((event: MessageEvent<TextSearchReply>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor(readonly url: URL, readonly options: WorkerOptions) { HeldWorker.instances.push(this); }
  postMessage(message: TextSearchRequest): void { this.messages.push(structuredClone(message)); }
  answer(index = 0): void {
    const request = this.messages[index]!;
    this.onmessage?.(new MessageEvent('message', { data: { id: request.id, result: textSearchPort(request.params, request) } }));
  }
}

beforeEach(() => { HeldWorker.instances = []; vi.stubGlobal('Worker', HeldWorker); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('creates a same-origin module worker lazily, reuses it and sends only search projections', async () => {
  const search = createTextSearchWorker();
  const harness = makeHarness({ asyncPorts: { 'text.search': search.port } });
  expect(HeldWorker.instances).toHaveLength(0);
  expect(harness.tools().find((tool) => tool.name === 'text.search')).toMatchObject({ async: true });
  const call = (callId: string) => harness.callAsync({ callId, name: 'text.search', params: { query: 'ferry' } }, { turnId: 'search' });
  const first = call('first');
  const worker = HeldWorker.instances[0]!;
  expect(worker.url.pathname).toMatch(/text-search\.worker\.ts$/);
  expect(worker.options).toEqual({ type: 'module' });
  expect(Object.keys(worker.messages[0]!.state)).toEqual(['manifest', 'documents']);
  expect(Object.keys(worker.messages[0]!.state.manifest)).toEqual(['project', 'tree', 'codex']);
  expect(Object.keys(worker.messages[0]!.state.manifest.project)).toEqual(['language']);
  worker.answer();
  expect(await first).toMatchObject({ ok: true, value: { data: { total: 1 } } });
  const second = call('second');
  expect(HeldWorker.instances).toHaveLength(1);
  worker.answer(1);
  expect(await second).toEqual(await first);
  search.dispose();
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(await call('closed')).toMatchObject({ ok: false, error: { code: 'io-error' } });
  expect(HeldWorker.instances).toHaveLength(1);
});

it('cancels one waiting call without losing another, then terminates an abandoned cold build', async () => {
  const search = createTextSearchWorker();
  const harness = makeHarness({ asyncPorts: { 'text.search': search.port } });
  const a = new AbortController();
  const b = new AbortController();
  const call = (callId: string, signal: AbortSignal) => harness.callAsync({ callId, name: 'text.search', params: { query: 'ferry' } }, { turnId: 'search', signal });
  const first = call('first', a.signal);
  const second = call('second', b.signal);
  const worker = HeldWorker.instances[0]!;
  a.abort();
  expect((await first).ok).toBe(false);
  expect(worker.terminate).not.toHaveBeenCalled();
  worker.answer(0);
  worker.answer(1);
  expect((await second).ok).toBe(true);
  const third = call('third', b.signal);
  b.abort();
  expect((await third).ok).toBe(false);
  expect(worker.terminate).toHaveBeenCalledOnce();
  search.dispose();
});

it.each(['error', 'messageerror', 'close', 'postMessage'] as const)('settles every pending request on %s without a synchronous fallback', async (kind) => {
  const search = createTextSearchWorker();
  const harness = makeHarness({ asyncPorts: { 'text.search': search.port } });
  if (kind === 'postMessage') vi.spyOn(HeldWorker.prototype, 'postMessage').mockImplementation(() => { throw new Error('clone failed'); });
  const call = (callId: string) => harness.callAsync({ callId, name: 'text.search', params: { query: 'ferry' } }, { turnId: 'search' });
  const first = call('first');
  const second = call('second');
  const worker = HeldWorker.instances[0]!;
  if (kind === 'error') worker.onerror?.();
  if (kind === 'messageerror') worker.onmessageerror?.();
  if (kind === 'close') search.dispose();
  expect((await first).ok).toBe(false);
  expect((await second).ok).toBe(false);
  expect(worker.terminate).toHaveBeenCalledOnce();
  search.dispose();
});

it('refuses missing worker support and an already-aborted call before doing any indexing', async () => {
  vi.stubGlobal('Worker', undefined);
  const search = createTextSearchWorker();
  const harness = makeHarness({ asyncPorts: { 'text.search': search.port } });
  const controller = new AbortController();
  controller.abort();
  for (const signal of [undefined, controller.signal]) {
    const result = await harness.callAsync({ callId: String(signal), name: 'text.search', params: { query: 'ferry' } }, { turnId: 'search', signal });
    expect(result).toMatchObject({ ok: false, error: { code: 'io-error', target: 'text.search' } });
  }
  expect(HeldWorker.instances).toHaveLength(0);
  search.dispose();
});
