/**
 * Which deferred rows a planner turn starts with, by what the writer has open (agent-harness §3). A turn about a dialogue
 * container or a storyboard is very likely to call that module's tools, so they are loaded before the first request instead of
 * costing a `tool.search` round trip. Deterministic: it reads the node, and no model is called.
 */

import type { TreeNode } from '@caotang/store';

import type { ToolName } from '../metadata.js';

/** The kinds of active document that preload a module's rows. */
export type PreloadContext = 'dialogue' | 'storyboard';

export const PRELOAD_BY_CONTEXT: Readonly<Record<PreloadContext, readonly ToolName[]>> = {
  dialogue: ['dialogue.draft', 'dialogue.table'],
  storyboard: ['shots.derive', 'shots.annotate'],
};

/**
 * The context a node is in, or undefined for a plain document. A dialogue container is its own context; a storyboard folder,
 * a shot in one, and a screenplay (the scene shots are derived from) are the storyboard's.
 */
export function preloadContextOf(node: Pick<TreeNode, 'type' | 'kind'> | undefined): PreloadContext | undefined {
  if (node === undefined) return undefined;
  if (node.type === 'dialogue') return 'dialogue';
  if (node.type === 'shot' || node.kind === 'storyboard' || node.kind === 'screenplay') return 'storyboard';
  return undefined;
}

/** The rows to preload when `node` is the active document: `submit(intent, { preload })`'s argument. */
export function preloadFor(node: Pick<TreeNode, 'type' | 'kind'> | undefined): readonly ToolName[] {
  const context = preloadContextOf(node);
  return context === undefined ? [] : PRELOAD_BY_CONTEXT[context];
}
