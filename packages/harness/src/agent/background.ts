/**
 * What a background run needs to know about a plan, without a model (agent-harness §2, "Background runs").
 *
 * A plan the writer sends to the background is staged on its own and reviewed later as a turn (`stageOnly` and
 * `submitStaged` in loop.ts). Three questions are answered here, all pure over the plan and the project: whether a plan may
 * run unattended and how many model calls it needs, which documents each step read when it was staged, and which staged
 * steps can no longer be trusted when the writer opens the result.
 */

import { resolveContainer } from '@caotang/dialogue';
import { getRevision, type ProjectState } from '@caotang/store';

import { isToolName } from '../metadata.js';
import type { PlanStep } from '../plan.js';
import { DOCUMENT, descendantsOf, resolveNode } from '../resolve.js';
import { isRecord } from '../util.js';
import { MODEL_BACKED_TOOLS } from './cards.js';
import { asFindingsProposal, asSceneProposal, asSynopsisProposal } from './drafting.js';

/** A plan that needs at least this many model calls is offered the background before it is staged. */
export const BACKGROUND_OFFER_MIN_CALLS = 5;

/** The model calls one step makes when it is staged. A step that drafts nothing makes none. */
export function estimatedStepCalls(step: PlanStep): number {
  switch (step.tool) {
    case 'scene.draft':
    case 'shots.derive':
    case 'dialogue.draft':
    case 'continuity.scan':
    case 'prompt.variant':
      return 1;
    case 'prompt.draft':
      return Array.isArray(step.params['shots']) ? step.params['shots'].length : 0;
    case 'synopsis.fill':
      return Array.isArray(step.params['docs']) ? step.params['docs'].length : 0;
    default:
      return 0;
  }
}

/** The model calls staging a plan makes: what the offer shows, and the cap a background task runs under. */
export function estimatedModelCalls(steps: readonly PlanStep[]): number {
  return steps.reduce((sum, step) => sum + estimatedStepCalls(step), 0);
}

/** Whether a plan may run in the background; `reason` says why not, in words for the writer. */
export type BackgroundEligibility = { readonly eligible: true } | { readonly eligible: false; readonly reason: string };

/**
 * A plan may run in the background when every step is a native tool, none is a coherence review, and at least one step drafts with a
 * model. The run executes nothing but staging, so a step that drafts nothing is fine: it runs at review, under the normal card. An
 * external tool is refused because it could write while nobody watches.
 */
export function backgroundEligibility(steps: readonly PlanStep[]): BackgroundEligibility {
  const external = steps.find((step) => !isToolName(step.tool));
  if (external !== undefined) return { eligible: false, reason: `${external.tool} is an external tool, and external tools do not run unattended.` };
  if (steps.some((step) => step.tool === 'coherence.review')) {
    return { eligible: false, reason: 'A coherence review cannot be queued yet, so this plan runs now.' };
  }
  if (!steps.some((step) => MODEL_BACKED_TOOLS.has(step.tool))) return { eligible: false, reason: 'No step of this plan drafts with a model.' };
  return { eligible: true };
}

/** The revision of each document a step reads, by document id, taken before the step's model calls. */
export type StepRevisions = Readonly<Record<string, number>>;

/** The ids of the documents a step reads when it is staged. A reference that does not resolve is left out: staging refuses it. */
function readsOf(state: ProjectState, step: PlanStep): string[] {
  const ids: string[] = [];
  const doc = (ref: unknown, path: string): void => {
    if (typeof ref !== 'string') return;
    const node = resolveNode(state, ref, DOCUMENT, 'document', path);
    if (node.ok) ids.push(node.value.id);
  };
  switch (step.tool) {
    case 'scene.draft':
    case 'shots.derive':
      doc(step.params['doc'], 'params.doc');
      break;
    case 'dialogue.draft': {
      const container = typeof step.params['doc'] === 'string' ? resolveContainer(state, step.params['doc']) : undefined;
      if (container?.ok === true) ids.push(container.node.id);
      break;
    }
    case 'synopsis.fill':
      if (Array.isArray(step.params['docs'])) for (const ref of step.params['docs']) doc(ref, 'params.docs');
      break;
    case 'continuity.scan':
      if (Array.isArray(step.params['scope'])) for (const ref of step.params['scope']) doc(ref, 'params.scope');
      else ids.push(...descendantsOf(state, 'manuscript').filter(DOCUMENT).map((node) => node.id));
      break;
    case 'prompt.draft':
      if (Array.isArray(step.params['shots'])) for (const id of step.params['shots']) if (typeof id === 'string') ids.push(id);
      break;
    case 'prompt.variant':
      if (typeof step.params['shot'] === 'string') ids.push(step.params['shot']);
      break;
    default:
      break;
  }
  return ids;
}

/** The revisions of what `step` reads now: recorded before the step is staged, compared with the project at review. */
export function revisionsOf(state: ProjectState, step: PlanStep): StepRevisions {
  const revisions: Record<string, number> = {};
  for (const id of readsOf(state, step)) revisions[id] = getRevision(state, id);
  return revisions;
}

/** Whether a staged proposal has the shape its tool's port reads. Stored data is untrusted, so a tampered or damaged one is refused here. */
export function proposalShapeOk(tool: string, proposal: unknown): boolean {
  switch (tool) {
    case 'scene.draft':
      return asSceneProposal(proposal) !== undefined;
    case 'synopsis.fill':
      return asSynopsisProposal(proposal) !== undefined;
    case 'continuity.scan':
      return asFindingsProposal(proposal) !== undefined;
    case 'shots.derive':
      return isRecord(proposal) && Array.isArray(proposal['shots']);
    case 'dialogue.draft':
      return isRecord(proposal) && typeof proposal['ink'] === 'string' && typeof proposal['revision'] === 'number';
    case 'prompt.draft':
      return isRecord(proposal) && typeof proposal['vendor'] === 'string' && Array.isArray(proposal['items']) && Array.isArray(proposal['refusals']);
    case 'prompt.variant':
      return isRecord(proposal) && typeof proposal['shotId'] === 'string' && typeof proposal['base'] === 'string' && Array.isArray(proposal['alternatives']);
    default:
      return false;
  }
}

/**
 * Which staged steps are out of date: a model-backed step with no usable proposal (its staging failed, or the stored proposal fails its
 * shape guard), or one whose recorded revisions no longer match the project. Such a step cannot be approved; the card's own Retry
 * drafts it again in the foreground, or the writer drops it.
 */
export function staleSteps(
  state: ProjectState,
  steps: readonly PlanStep[],
  proposals: readonly unknown[],
  revisions: readonly (StepRevisions | undefined)[],
): boolean[] {
  const present = new Set(state.manifest.tree.map((node) => node.id));
  return steps.map((step, index) => {
    if (!MODEL_BACKED_TOOLS.has(step.tool)) return false;
    if (!proposalShapeOk(step.tool, proposals[index])) return true;
    return Object.entries(revisions[index] ?? {}).some(([id, revision]) => !present.has(id) || getRevision(state, id) !== revision);
  });
}
