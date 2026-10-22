/**
 * Causality — [coherence.md §5.5](../../../../docs/architecture/coherence.md): `plot.unresolved-thread`.
 *
 * The check fires only on a thread the writer declared on a scene, and it judges one thing: whether the document the
 * writer named as the payoff is there. Whether the payoff pays the thread off is the writer's, or the model review's.
 */

import { headEvidence } from '../scope.js';
import { groupKey, type CheckInput, type CheckOutput, type DraftFinding } from './common.js';

export function checkUnresolvedThread(input: CheckInput): CheckOutput {
  const drafts: DraftFinding[] = [];
  const notes: string[] = [];
  const documents = input.treeDocuments;
  if (documents === undefined) {
    return { drafts, notes: ['thread payoffs not checked: the project’s document list was not supplied'] };
  }
  const scanned = new Set(input.scenes.map((scene) => scene.docId));
  let declaring = 0;
  for (const scene of input.scenes) {
    const threads = (scene.meta.threads ?? []).filter((thread) => thread.id.trim() !== '');
    if (threads.length > 0) declaring += 1;
    for (const thread of threads) {
      if (scanned.has(thread.payoff)) continue;
      const title = documents.get(thread.payoff);
      const declares = `"${scene.title}" declares the thread "${thread.id}"`;
      drafts.push({
        checkId: 'plot.unresolved-thread',
        type: title === undefined ? 'payoff-unresolved' : 'payoff-not-read',
        severity: title === undefined ? 'warning' : 'info',
        factGroup: groupKey(scene.docId, `thread:${thread.id}`),
        evidence: [headEvidence(scene)],
        message:
          title === undefined
            ? `${declares} with its payoff in ${thread.payoff}, which is not a document in the project`
            : `${declares} with its payoff in "${title}", which this scan did not read`,
        expected: title === undefined ? 'a document for the payoff' : 'the payoff in a scanned scene',
      });
    }
  }
  if (input.scenes.length > 0) {
    notes.push(`${declaring} of ${input.scenes.length} scene(s) declare a thread; ${input.scenes.length - declaring} not compared`);
  }
  return { drafts, notes };
}
