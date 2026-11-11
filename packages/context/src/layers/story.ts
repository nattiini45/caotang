/**
 * L4 — the story so far — [context-assembly.md §2 and §4](../../../../docs/architecture/context-assembly.md).
 *
 * For a scene call, the synopses of the documents that come before the focus in manuscript
 * order: synopsis only, never body text. A synopsis that is blank renders its placeholder
 * (§7), so a missing synopsis is visible, not skipped.
 *
 * Rank is nearest first: the scene just before the focus is rank 1, and a budget drops the
 * far end, which is the spec's "L4 tail". Display is manuscript order, oldest first.
 *
 * Forward outline suppression lives here (§4). Later scenes are not eligible unless the
 * call asks for them. When they are, they rank after every earlier scene, so they are the
 * first to go under pressure. When they are withheld, the preview names how many.
 *
 * For continuity.scan there is no focus, so L4 is what the scan does not send in full. See
 * `scopeStoryBlock`.
 */

import type { TreeNode } from '@caotang/store';

import { newBlock, type Block, type BlockItem } from '../block.js';
import { dropRecord } from '../drops.js';
import { manuscriptDocuments, synopsisOf, type TreeIndex } from '../tree.js';
import { LAYER_NAMES, type DropRecord } from '../types.js';

export interface StoryPlan {
  readonly block: Block;
  readonly notes: readonly string[];
  readonly drops: readonly DropRecord[];
}

export interface StoryOptions {
  /** The call asks for the forward outline (§4). */
  readonly includeForward: boolean;
}

const CUT = '(story so far not sent)';

/** One document's synopsis, as a layer item. */
function synopsisItem(node: TreeNode, reason: string, group: string): BlockItem {
  return {
    ref: { kind: 'doc', id: node.id },
    label: node.title,
    reason,
    body: `## ${node.title} (${node.type})\n${synopsisOf(node)}`,
    protected: false,
    group,
  };
}

/**
 * The story so far for a scene. `focus` is the focus document. Without one, or when it is
 * outside the manuscript, nothing precedes it and the layer says why.
 */
export function storyBlock(tree: TreeIndex, focus: TreeNode | undefined, options: StoryOptions): StoryPlan {
  const sequence = manuscriptDocuments(tree);
  const notes: string[] = [];
  const drops: DropRecord[] = [];

  let position = -1;
  if (focus === undefined) {
    notes.push('There is no focus document, so no earlier scenes are sent.');
  } else {
    position = sequence.findIndex((node) => node.id === focus.id);
    if (position === -1) notes.push('The focus is not a manuscript document, so no earlier scenes are sent.');
  }

  const earlier = position === -1 ? [] : sequence.slice(0, position);
  const later = position === -1 ? [] : sequence.slice(position + 1);
  const nearestEarlier = [...earlier].reverse();

  const items: BlockItem[] = nearestEarlier.map((node) => synopsisItem(node, 'earlier scene', 'prior'));

  if (options.includeForward) {
    for (const node of later) {
      items.push(
        synopsisItem(node, 'later scene, sent because the call asks for the forward outline', 'forward'),
      );
    }
  } else if (later.length > 0) {
    drops.push(
      dropRecord(
        `${later.length} later ${later.length === 1 ? 'document' : 'documents'}`,
        { kind: 'forward-outline' },
        'forward',
      ),
    );
  }

  // Display: earlier scenes in manuscript order (rank runs nearest first, so read it
  // backwards), then the forward outline in manuscript order (rank runs in that order).
  const priorCount = earlier.length;
  const display = [
    ...earlier.map((_, index) => priorCount - 1 - index),
    ...(options.includeForward ? later.map((_, index) => priorCount + index) : []),
  ];

  return {
    block: newBlock({
      id: 'L4',
      header: `# ${LAYER_NAMES.L4}`,
      empty: '(no earlier scenes)',
      cut: CUT,
      items,
      display,
    }),
    notes,
    drops,
  };
}

/**
 * continuity.scan's L4. A scan has no focus, and its scope documents are sent in full only up
 * to `limit` of them (agent-harness row 10). So the story so far is what the scan does not send
 * in full, as synopses:
 *
 * - the scope documents past the first `limit`, whose tails are not sent, and
 * - the manuscript documents that come before the scope's first document, which the scan
 *   reads as the story leading into it.
 *
 * The scope documents rank above the earlier ones, since the scan is about them, and within
 * each group the nearest to the tail window ranks first. Display is manuscript order: the
 * earlier documents, then the scope documents past the window. A scope of `limit` documents or
 * fewer, starting at the first manuscript document, has neither, and the layer is empty.
 */
export function scopeStoryBlock(tree: TreeIndex, scope: readonly TreeNode[], limit: number): StoryPlan {
  const sequence = manuscriptDocuments(tree);
  const inScope = new Set(scope.map((node) => node.id));
  const first = scope[0];
  const position = first === undefined ? -1 : sequence.findIndex((node) => node.id === first.id);
  const earlier = position === -1 ? [] : sequence.slice(0, position).filter((node) => !inScope.has(node.id));
  const beyond = scope.slice(limit);

  const items: BlockItem[] = [
    ...beyond.map((node) => synopsisItem(node, 'scope document past the tail window; synopsis only', 'scope')),
    ...[...earlier].reverse().map((node) => synopsisItem(node, 'earlier scene', 'prior')),
  ];
  // Rank runs beyond-the-window first, then the earlier documents nearest first. Display runs
  // the earlier documents oldest first, then the scope documents past the window.
  const display = [
    ...earlier.map((_, index) => beyond.length + (earlier.length - 1 - index)),
    ...beyond.map((_, index) => index),
  ];

  return {
    block: newBlock({
      id: 'L4',
      header: `# ${LAYER_NAMES.L4}`,
      empty: '(no earlier scenes)',
      cut: CUT,
      items,
      display,
    }),
    notes: [],
    drops: [],
  };
}
