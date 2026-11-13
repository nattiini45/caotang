import { err, refusal } from '@caotang/bus';
import { textSearchPort } from '@caotang/harness/text-search';
import type { SearchState } from '@caotang/retrieval';
import type { TextSearchReply, TextSearchRequest } from './text-search-protocol.js';

let state: SearchState | undefined;
self.onmessage = ({ data }: MessageEvent<TextSearchRequest>) => {
  state ??= data.state;
  Object.assign(state, data.state);
  let result: TextSearchReply['result'];
  try {
    result = textSearchPort(data.params, { state, withheld: data.withheld });
  } catch {
    result = err(refusal('io-error', 'Local passage search could not finish.', { target: 'text.search', correctiveHint: 'retry the search, or read a document directly' }));
  }
  self.postMessage({ id: data.id, result } satisfies TextSearchReply);
};
