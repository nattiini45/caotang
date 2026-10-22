/**
 * The dialogue module's facts for a coherence scan (dialogue-narrative.md §5, coherence.md §5.1).
 *
 * The branch checks cannot be computed inside the coherence module: the dialogue package depends on it, so the dependency
 * runs the other way. The harness depends on both, so it runs the dialogue validation over each container
 * the scan reads and hands the findings in, for the app and for the SDK alike (`createProductHarness`). Each finding is already in
 * the coherence finding's shape, with its check id and its group key, so the scan takes it as it is.
 *
 * Only containers that sit under the manuscript and are not archived are read, the same rule the documents follow (coherence.md
 * §5.1). A container with no body yields no findings, because there is no Ink for the compiler to report on.
 */

import type { DialogueFacts } from '@caotang/coherence';
import { speakersOf, validateContainer } from '@caotang/dialogue';
import { getBody, type ProjectState, type TreeNode } from '@caotang/store';

/** The binder node type a dialogue container carries (dialogue-narrative.md §2.1). */
export const DIALOGUE_CONTAINER_TYPE = 'dialogue';

const MANUSCRIPT_ROOT = 'manuscript';

/** Whether a node sits under the manuscript root, at any depth. A node that is the root itself counts. */
function inManuscript(byId: ReadonlyMap<string, TreeNode>, node: TreeNode): boolean {
  let current: TreeNode | undefined = node;
  for (let hops = 0; current !== undefined && hops < 1000; hops += 1) {
    if (current.id === MANUSCRIPT_ROOT) return true;
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return false;
}

/** The containers the scan reads: under the manuscript, not archived, in tree order. */
export function containersOf(state: ProjectState): TreeNode[] {
  const byId = new Map(state.manifest.tree.map((node) => [node.id, node] as const));
  return state.manifest.tree.filter(
    (node) => node.type === DIALOGUE_CONTAINER_TYPE && node.status !== 'archived' && inManuscript(byId, node),
  );
}

/**
 * The dialogue findings for every container the scan reads, with the container ids they were computed for. A container's
 * findings name the container as their document, so the scan keeps them exactly when it reads that container. The speakers
 * of each container ride along for `medium.speaker-parity`.
 */
export function dialogueFactsOf(state: ProjectState): DialogueFacts {
  const entries = state.manifest.codex ?? [];
  const containers = containersOf(state);
  const findings = containers.flatMap((node) => validateContainer(node.id, getBody(state, node.id), { entries }).findings);
  const speakersByContainer = new Map(containers.map((node) => [node.id, speakersOf(getBody(state, node.id), entries)] as const));
  return { findings, containerIds: containers.map((node) => node.id), speakersByContainer };
}
