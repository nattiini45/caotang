/**
 * The closed registry of deterministic checks — [coherence.md §5.4](../../../../docs/architecture/coherence.md).
 * Adding a check is a spec change with fixtures, never a runtime plugin.
 */

import { cueFactsOfScenes } from '../cues.js';
import { DETERMINISTIC_CHECK_IDS, type DeterministicCheckId } from '../model.js';

import type { CheckInput, CheckOutput, DraftFinding } from './common.js';
import { checkAliasCollisions, checkNeverMentioned } from './codex.js';
import { checkPovCoverage, checkPresenceExpected } from './presence.js';
import { checkGap, checkOrderDrift, checkOverlap, checkRelation, checkWindow } from './timeline.js';
import { checkCueCollision, checkCueConsistency, checkShotCoverage } from './script.js';
import { checkBranch } from './branch.js';
import { checkUnresolvedThread } from './plot.js';
import { checkKnowledgeLeak } from './knowledge.js';

export type { CheckInput, CheckOutput, DialogueFacts, DialogueSpeaker, DraftFinding } from './common.js';
export { groupKey, pairKey, termsOf, resolveEntry, modeOf } from './common.js';

export const DETERMINISTIC_CHECKS: Readonly<Record<DeterministicCheckId, (input: CheckInput) => CheckOutput>> = {
  'codex.alias-collisions': checkAliasCollisions,
  'codex.never-mentioned': checkNeverMentioned,
  'timeline.order-drift': checkOrderDrift,
  'timeline.relation': checkRelation,
  'timeline.window': checkWindow,
  'timeline.overlap': checkOverlap,
  'pov.coverage': checkPovCoverage,
  'presence.expected': checkPresenceExpected,
  'script.cue-collision': checkCueCollision,
  'script.cue-consistency': checkCueConsistency,
  'script.shot-coverage': checkShotCoverage,
  'branch.loose-end': checkBranch('branch.loose-end'),
  'branch.dead-end': checkBranch('branch.dead-end'),
  'dialogue.speaker-unknown': checkBranch('dialogue.speaker-unknown'),
  'timeline.gap': checkGap,
  'plot.unresolved-thread': checkUnresolvedThread,
  'knowledge.leak': checkKnowledgeLeak,
};

/**
 * Runs the named checks, in registry order, so the same selection always yields
 * the same draft order. An unknown id is a caller bug and throws.
 *
 * The script checks read the same screenplay bodies, so a run that asks for one of them parses each body once and
 * shares the read between them.
 */
export function runChecks(input: CheckInput, ids: readonly DeterministicCheckId[]): CheckOutput {
  const wanted = new Set<string>(ids);
  for (const id of wanted) {
    if (!(DETERMINISTIC_CHECK_IDS as readonly string[]).includes(id)) {
      throw new Error(`unknown deterministic check "${id}"`);
    }
  }
  const shared: CheckInput =
    input.cueFacts === undefined && ids.some((id) => id.startsWith('script.'))
      ? { ...input, cueFacts: cueFactsOfScenes(input.scenes) }
      : input;
  const drafts: DraftFinding[] = [];
  const notes: string[] = [];
  for (const id of DETERMINISTIC_CHECK_IDS) {
    if (!wanted.has(id)) continue;
    const output = DETERMINISTIC_CHECKS[id](shared);
    drafts.push(...output.drafts);
    // Two timeline checks count the same unscheduled scenes; a note a run already holds is not said twice.
    for (const note of output.notes) if (!notes.includes(note)) notes.push(note);
  }
  return { drafts, notes };
}
