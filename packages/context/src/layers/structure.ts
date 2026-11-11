/**
 * L3 — structural synopses — [context-assembly.md §2](../../../../docs/architecture/context-assembly.md).
 *
 * "Where am I in the book": the folders that enclose the focus, up to the manuscript, and
 * the earlier siblings of the focus. This is structure, not story. The story so far is L4.
 *
 * Rank is nearest first across both parts: the enclosing folders from the parent upward,
 * then the earlier siblings from the one just before the focus backwards. So an overflow
 * drops the farthest sibling first, which is the spec's "L3 tail". Display is the reading
 * order: the manuscript at the top, the siblings oldest first.
 */

import type { TreeNode } from '@caotang/store';

import { newBlock, type Block, type BlockItem } from '../block.js';
import { earlierSiblings, enclosingFolders, synopsisOf, type TreeIndex } from '../tree.js';
import { LAYER_NAMES } from '../types.js';

export function structureBlock(tree: TreeIndex, focus: TreeNode | undefined): Block {
  const folders = focus === undefined ? [] : enclosingFolders(tree, focus);
  const siblings = focus === undefined ? [] : earlierSiblings(tree, focus);

  const items: BlockItem[] = [
    ...folders.map(
      (node): BlockItem => ({
        label: node.title,
        reason: 'enclosing folder',
        body: `## ${node.title} (${node.type})\n${synopsisOf(node)}`,
        protected: false,
        group: 'folder',
      }),
    ),
    ...siblings.map(
      (node): BlockItem => ({
        ...(node.type === 'document' ? { ref: { kind: 'doc' as const, id: node.id } } : {}),
        label: node.title,
        reason: 'earlier sibling',
        body: `## ${node.title} (${node.type})\n${synopsisOf(node)}`,
        protected: false,
        group: 'sibling',
      }),
    ),
  ];

  // Display: the folders root first (their rank runs nearest first, so read it backwards),
  // then the siblings oldest first (their rank runs nearest first, so read it backwards).
  const count = folders.length;
  const display = [
    ...folders.map((_, index) => count - 1 - index),
    ...siblings.map((_, index) => count + siblings.length - 1 - index),
  ];

  return newBlock({
    id: 'L3',
    header: `# ${LAYER_NAMES.L3}`,
    empty: '(no enclosing folders or earlier siblings)',
    cut: '(structure not sent)',
    items,
    display,
  });
}
