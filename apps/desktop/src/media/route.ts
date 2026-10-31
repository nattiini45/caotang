/**
 * Which media view a binder node gets — pure, so the routing is tested without a renderer.
 *
 * The three routes follow the spec each one comes from. A document marked `kind: 'screenplay'` is a scene
 * (screenplay.md §2.1). A folder marked `kind: 'storyboard'` holds shots (storyboard.md §2.1). A node of type
 * `dialogue` is a dialogue container (dialogue-narrative.md §2.1); a `beat` is a leaf inside one, and the
 * containers own the view, so a beat gets none. A node of type `comic-page` is a page of a comic book (comics.md §3.1) and shows its panels.
 * A comic book itself is a folder, so it keeps the corkboard of its pages. A node with no route gets `null`, and the caller shows what it
 * showed before.
 */

import type { TreeNode } from '@caotang/store';

import { isScreenplayKind, isStoryboardFolder } from './engines.js';

export type MediaKind = 'screenplay' | 'storyboard' | 'dialogue' | 'comic-page';

/** The `kind` marker on a node, when it is a string. The store's `TreeNode` does not declare it (storyboard model.ts). */
export function kindOfNode(node: TreeNode): string | undefined {
  const kind = (node as TreeNode & { readonly kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : undefined;
}

export function mediaKindOf(node: TreeNode): MediaKind | null {
  if (node.type === 'document' && isScreenplayKind(kindOfNode(node))) return 'screenplay';
  if (isStoryboardFolder(node)) return 'storyboard';
  if (node.type === 'dialogue') return 'dialogue';
  if (node.type === 'comic-page') return 'comic-page';
  return null;
}
