import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTextSearchWorker } from '../src/app/text-search-worker.js';
import type { TextSearchReply, TextSearchRequest } from '../src/app/text-search-protocol.js';
import { textSearchPort } from '@caotang/harness';
import { CHAPTER_ONE, CHAPTER_TWO, ENTRY_TWO, FRIEND, LANDING, STORM, makeHarness } from '../../../packages/harness/test/fixtures.js';

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

it('omits binder text from an unconfirmed codex-only worker request under a scoped read-ask', async () => {
  const search = createTextSearchWorker();
  const harness = makeHarness({ asyncPorts: { 'text.search': search.port }, rules: () => ({ rules: [{ source: 'app', tool: 'text.search', effect: 'ask', access: 'read', scope: { subtree: CHAPTER_ONE } }] }) });
  harness.state.manifest.codex![0]!.sources = [{ docId: LANDING, quote: 'The ferry was late, as always.' }];
  const first = harness.callAsync({ callId: 'codex-only', name: 'text.search', params: { query: 'keeper', fields: ['codex'] } }, { turnId: 'search' });
  const worker = HeldWorker.instances[0]!;
  const request = worker.messages[0]!;
  expect(request.state.documents.size).toBe(0);
  expect(request.state.manifest.tree.every((node) => node.synopsis === '' && node.notes === '')).toBe(true);
  expect(Object.keys(request.state.manifest.codex![0]!)).toEqual(['id', 'name', 'aliases', 'description', 'includePolicy']);
  worker.answer();
  expect(await first).toMatchObject({ ok: true, value: { data: { total: 1, hits: [{ field: 'codex' }] } } });
  expect(await harness.callAsync({ callId: 'binder', name: 'text.search', params: { query: 'ferry' } }, { turnId: 'search' })).toMatchObject({ ok: false, error: { code: 'permission-denied' } });
  expect(worker.messages).toHaveLength(1);
  search.dispose();
});

it.each([
  { params: { scope: [CHAPTER_TWO] }, denied: false, ids: [FRIEND] },
  { params: { excludeAfter: LANDING }, denied: false, ids: [LANDING] },
  { params: {}, denied: true, ids: [FRIEND] },
])('transfers only eligible binder text for $params with deny $denied', async ({ params, denied, ids }) => {
  const search = createTextSearchWorker();
  const harness = makeHarness({ asyncPorts: { 'text.search': search.port }, ...(denied ? { rules: () => ({ rules: [{ source: 'app' as const, tool: 'doc.read', effect: 'deny' as const, access: 'read' as const, scope: { subtree: CHAPTER_ONE } }] }) } : {}) });
  harness.state.manifest.codex!.find((entry) => entry.id === ENTRY_TWO)!.includePolicy = 'never';
  const call = harness.callAsync({ callId: 'scoped', name: 'text.search', params: { query: 'keeper', ...params } }, { turnId: 'search' });
  const worker = HeldWorker.instances[0]!;
  const snapshot = worker.messages[0]!.state;
  expect([...snapshot.documents.keys()]).toEqual(ids);
  expect(snapshot.manifest.codex?.some((entry) => entry.id === ENTRY_TWO)).toBe(false);
  for (const id of [LANDING, STORM, FRIEND].filter((id) => !ids.includes(id))) expect(snapshot.manifest.tree.find((node) => node.id === id)).toMatchObject({ synopsis: '', notes: '' });
  expect(Object.keys(snapshot.manifest.tree[0]!)).toEqual(['id', 'parentId', 'type', 'title', 'order', 'synopsis', 'notes']);
  worker.answer();
  expect((await call).ok).toBe(true);
  search.dispose();
});

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

it.each(['error', 'messageerror', 'close', 'postMessage', 'search'] as const)('settles every pending request on %s without a synchronous fallback', async (kind) => {
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
  if (kind === 'search') for (const request of worker.messages) worker.onmessage?.(new MessageEvent('message', { data: { id: request.id, result: null } }));
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
