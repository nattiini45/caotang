/**
 * The binder minimap's dots (modern-interface.md §6, §8.5): the manuscript's scenes in binder order, each with its status colour, for
 * the decorative minimap on Modern's binder tab bar. Pure, so it is unit-tested without React; `Workspace` computes it with the other
 * regions, and Classic never draws it.
 */

import type { ProjectState, TreeNode } from '@caotang/store';

/** One scene on the minimap. */
export interface MinimapDot {
  readonly id: string;
  /** The status's colour from the project's vocabulary, or `null` for a scene without a status (the empty dot). */
  readonly color: string | null;
  /** The scene open in the editor. */
  readonly current: boolean;
}

/** The most dots the tab bar draws: past this the minimap would be taller than the bar, and it says nothing a writer reads anyway. */
export const MINIMAP_MAX = 24;

/** The manuscript's documents, depth first in sibling order, at most `max`, with their status colours. */
export function minimapDots(state: ProjectState, currentId: string | null, max: number = MINIMAP_MAX): MinimapDot[] {
  const children = new Map<string, TreeNode[]>();
  for (const node of state.manifest.tree) {
    if (node.parentId === null) continue;
    const list = children.get(node.parentId);
    if (list === undefined) children.set(node.parentId, [node]);
    else list.push(node);
  }
  for (const list of children.values()) list.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const colours = new Map<string, string>();
  for (const status of state.manifest.vocabulary.statuses) colours.set(status.id, status.color);

  const dots: MinimapDot[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string): void => {
    for (const node of children.get(parentId) ?? []) {
      if (dots.length >= max || seen.has(node.id)) return;
      seen.add(node.id);
      if (node.type === 'document') {
        dots.push({ id: node.id, color: node.status === null ? null : (colours.get(node.status) ?? null), current: node.id === currentId });
      }
      walk(node.id);
    }
  };
  walk('manuscript');
  return dots;
}
