import { afterEach, expect, it, vi } from 'vitest';
import { setBody } from '@caotang/store';
import { LANDING, makeState } from '../../../packages/harness/test/fixtures.js';
import type { TextSearchReply, TextSearchRequest } from '../src/app/text-search-protocol.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('keeps the worker index across cloned snapshots and rescans only changed document text', async () => {
  const scope: { onmessage: ((event: MessageEvent<TextSearchRequest>) => void) | null; postMessage: ReturnType<typeof vi.fn> } = { onmessage: null, postMessage: vi.fn() };
  vi.stubGlobal('self', scope);
  await import('../src/app/text-search.worker.js');
  const segment = vi.spyOn(Intl.Segmenter.prototype, 'segment');
  const state = makeState();
  let id = 0;
  const send = (): TextSearchReply => {
    const { project, tree, codex } = state.manifest;
    const request: TextSearchRequest = structuredClone({ id: ++id, params: { query: 'ferry' }, state: { manifest: { project: { language: project.language }, tree, codex }, documents: state.documents } });
    scope.onmessage!(new MessageEvent('message', { data: request }));
    return scope.postMessage.mock.calls.at(-1)![0] as TextSearchReply;
  };
  expect(send().result).toMatchObject({ ok: true, value: { data: { total: 1 } } });
  const original = state.documents.get(LANDING)!.body;
  expect(segment.mock.calls.filter(([text]) => text === original)).toHaveLength(1);
  expect(send().result.ok).toBe(true);
  expect(segment.mock.calls.filter(([text]) => text === original)).toHaveLength(1);
  setBody(state, LANDING, 'The ferry returned.');
  expect(send().result).toMatchObject({ ok: true, value: { data: { hits: [{ snippet: { text: 'The ferry returned.' } }] } } });
  expect(segment.mock.calls.filter(([text]) => text === 'The ferry returned.')).toHaveLength(1);
});
