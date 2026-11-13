import { err, refusal } from '@caotang/bus';
import { t } from '@lingui/core/macro';
import { searchCandidates, type SearchState, type UnitField } from '@caotang/retrieval';
import type { AsyncToolPort } from '@caotang/harness';
import type { TextSearchReply, TextSearchRequest } from './text-search-protocol.js';

export function createTextSearchWorker(): { readonly port: AsyncToolPort; dispose(): void } {
  let worker: Worker | undefined;
  let closed = false;
  let nextId = 0;
  const pending = new Map<number, (result: NonNullable<TextSearchReply['result']>) => void>();
  const unavailable = () => err(refusal('io-error', t`Local passage search is unavailable. Nothing was written.`, { target: 'text.search', correctiveHint: t`Retry the search, or reopen the project in a browser with worker support.` }));
  const terminate = () => {
    if (worker === undefined) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
    worker = undefined;
  };
  const fail = () => {
    terminate();
    for (const finish of [...pending.values()]) finish(unavailable());
  };
  const port: AsyncToolPort = (params, context) => {
    if (closed || context.signal?.aborted) return Promise.resolve(unavailable());
    try {
      if (worker === undefined) {
        worker = new Worker(new URL('./text-search.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }: MessageEvent<TextSearchReply>) => {
          if (data.result === null) { fail(); return; }
          pending.get(data.id)?.(data.result);
        };
        worker.onerror = fail;
        worker.onmessageerror = fail;
      }
    } catch {
      return Promise.resolve(unavailable());
    }
    return new Promise((resolve) => {
      const id = ++nextId;
      const finish = (result: NonNullable<TextSearchReply['result']>) => {
        pending.delete(id);
        context.signal?.removeEventListener('abort', abort);
        resolve(result);
      };
      const abort = () => {
        finish(unavailable());
        if (pending.size === 0) terminate();
      };
      pending.set(id, finish);
      context.signal?.addEventListener('abort', abort, { once: true });
      const { project, tree, codex } = context.state.manifest;
      try {
        const eligible = new Set(searchCandidates(context.state, { fields: params['fields'] as readonly UnitField[] | undefined, scope: params['scope'] as readonly string[] | undefined, excludeAfter: params['excludeAfter'] as string | undefined, excluded: context.withheld }).eligible.map((node) => node.id));
        const documents: SearchState['documents'] = new Map();
        for (const nodeId of eligible) {
          const document = context.state.documents.get(nodeId);
          if (document !== undefined) documents.set(nodeId, document);
        }
        const snapshot: SearchState = { manifest: {
          project: { language: project.language },
          tree: tree.map((node) => ({ id: node.id, parentId: node.parentId, type: node.type, title: node.title, order: node.order, synopsis: eligible.has(node.id) ? node.synopsis : '', notes: eligible.has(node.id) ? node.notes : '' })),
          codex: codex?.filter((entry) => entry.includePolicy !== 'never' && !context.withheld?.has(entry.id)),
        }, documents };
        worker!.postMessage({ id, state: snapshot, params, withheld: context.withheld } satisfies TextSearchRequest);
      } catch {
        fail();
      }
    });
  };
  return { port, dispose: () => { closed = true; fail(); } };
}
