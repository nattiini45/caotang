/**
 * The bytes of a project, as the bus and the tests compare it (command-bus §10): the manifest, every body, the decline record, and
 * the agent's own files. Kept out of the eval runner so a replay (agent-harness §8.1) can compare two projects without pulling the
 * runner — and everything it imports — into a chunk that has no eval in it.
 */

import { agentFileTexts, type ProjectState } from '@caotang/store';

import { canonicalJson } from '../util.js';

/**
 * The bytes of everything an undo has to restore: the manifest, every body, and the decline record. Two projects with
 * the same bytes are the same project to the bus (command-bus §10). The agent's files are in it (CAOTANG.md and the memory notes), so a
 * restore that leaves a note behind is a failure. A document's revision is left out: it is runtime
 * bookkeeping that is never serialized, and an undo is a write that raises it.
 */
export function projectBytes(state: ProjectState): string {
  const documents = [...state.documents.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, record]) => [id, { id: record.id, body: record.body }] as const);
  return canonicalJson({ manifest: state.manifest, documents, declinedCodexFiles: [...state.declinedCodexFiles].sort(), agentFiles: agentFileTexts(state.agentFiles) });
}
