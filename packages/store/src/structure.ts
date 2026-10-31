/**
 * Parts and chapters — project-format §2, `tree[].type`.
 *
 * The binder nests folders: a manuscript holds chapters, and it may hold **parts**, folders that hold chapters (Part → Chapter →
 * Scene, the shape of Scrivener's Novel template, yWriter's parts and many Word manuscripts). Nothing in the manifest says which
 * folder is a part: the role is read from the tree, so moving a chapter into a folder makes that folder a part, and moving the last
 * chapter out makes it a chapter again. One reading of it lives here, so the binder, the corkboard and the compile agree.
 *
 * A **part** is a folder, not a fixed root, with at least one child that is itself a plain folder. A storyboard folder does not
 * count: it holds a scene's shots and sits beside the scene, inside its chapter (storyboard.md §2.1), so a chapter with a storyboard
 * is still a chapter. Any other folder is a **chapter**. Depth is not capped: a part may hold parts (Book → Part → Chapter), and
 * every folder that holds folders is a part.
 */

import { FIXED_ROOT_IDS, type TreeNode } from './manifest.js';

const FIXED = new Set<string>(FIXED_ROOT_IDS);

/** A folder that counts toward making its parent a part: a folder that is not a storyboard. */
export function isStructuralFolder(node: TreeNode): boolean {
  return node.type === 'folder' && !FIXED.has(node.id) && node.kind !== 'storyboard';
}

/**
 * The ids of every part in the tree: a structural folder with a structural folder among its children. One pass over the tree,
 * so a caller that asks about many folders (a compile, the binder's rows) builds it once.
 */
export function partFolderIds(tree: readonly TreeNode[]): Set<string> {
  const structural = new Map<string, TreeNode>();
  for (const node of tree) if (isStructuralFolder(node)) structural.set(node.id, node);
  const parts = new Set<string>();
  for (const node of structural.values()) {
    if (node.parentId !== null && structural.has(node.parentId)) parts.add(node.parentId);
  }
  return parts;
}

/** Whether one node is a part (see the module comment). */
export function isPartFolder(tree: readonly TreeNode[], nodeId: string): boolean {
  const node = tree.find((candidate) => candidate.id === nodeId);
  if (node === undefined || !isStructuralFolder(node)) return false;
  return tree.some((child) => child.parentId === nodeId && isStructuralFolder(child));
}

/** A structural folder's role: `part` when it holds folders, `chapter` otherwise. Anything else has none. */
export function folderRole(tree: readonly TreeNode[], nodeId: string): 'part' | 'chapter' | undefined {
  const node = tree.find((candidate) => candidate.id === nodeId);
  if (node === undefined || !isStructuralFolder(node)) return undefined;
  return isPartFolder(tree, nodeId) ? 'part' : 'chapter';
}
