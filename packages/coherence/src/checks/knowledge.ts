/**
 * Knowledge — [coherence.md §4.4](../../../../docs/architecture/coherence.md): `knowledge.leak`.
 *
 * The check fires only on a `knows` pair the writer declared, and it judges one thing: whether a scene at or before the
 * knowing scene, in the story order the writer declared, teaches the same character the same fact. What a character says is
 * not read from the prose.
 */

import { leakVerdict } from '../knowledge.js';
import { headEvidence } from '../scope.js';
import { groupKey, labelOf, type CheckInput, type CheckOutput, type DraftFinding } from './common.js';

export function checkKnowledgeLeak(input: CheckInput): CheckOutput {
  const drafts: DraftFinding[] = [];
  const notes: string[] = [];
  const facts = new Map((input.knowledge ?? []).map((fact) => [fact.id, fact] as const));
  let declaring = 0;
  let gone = 0;
  let unordered = 0;
  for (const scene of input.scenes) {
    const knows = scene.meta.knows ?? [];
    if (knows.length > 0) declaring += 1;
    for (const link of knows) {
      const entry = input.entries.find((candidate) => candidate.id === link.entryId);
      const fact = facts.get(link.factId);
      if (entry === undefined || fact === undefined) {
        gone += 1;
        continue;
      }
      const verdict = leakVerdict(link.entryId, link.factId, scene, input.scenes);
      if (verdict.kind === 'fine') continue;
      if (verdict.kind === 'unordered') {
        unordered += 1;
        continue;
      }
      const knowing = `${labelOf(entry)} knows that "${fact.text}" in "${scene.title}"`;
      const later = verdict.kind === 'learns-later' ? verdict.scene : undefined;
      drafts.push({
        checkId: 'knowledge.leak',
        type: later === undefined ? 'never-learns' : 'knows-before-learns',
        severity: 'error',
        factGroup: groupKey(entry.id, `knows:${fact.id}`),
        evidence: later === undefined ? [headEvidence(scene)] : [headEvidence(scene), headEvidence(later)],
        message: later === undefined ? `${knowing}, but never learns it` : `${knowing}, but learns it only in "${later.title}"`,
        expected: `${labelOf(entry)} taught the fact in a scene at or before "${scene.title}"`,
      });
    }
  }
  if (declaring > 0 || facts.size > 0) {
    notes.push(`${declaring} of ${input.scenes.length} scene(s) declare what a character knows; the rest are not compared`);
  }
  if (unordered > 0) {
    notes.push(`${unordered} declaration(s) of what a character knows not compared: the scenes that teach it cannot be ordered against the scene that uses it`);
  }
  if (gone > 0) notes.push(`${gone} declaration(s) of what a character knows name a character or fact that is gone; not compared`);
  return { drafts, notes };
}
