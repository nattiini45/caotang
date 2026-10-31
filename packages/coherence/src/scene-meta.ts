/**
 * Writer-declared scene metadata — [coherence.md §5.2 / §5.2.1 / §7.1](../../../docs/architecture/coherence.md).
 *
 * The rule that validates and applies a patch lives in `@caotang/bus` (`coherence.ts`), because the
 * bus's `coherence.setSceneMeta` and the store's apply must run the same rule and the dependency
 * runs coherence → store → bus. This module re-exports that rule under the names the coherence
 * module has always used, so the Inspector and the agent path share one rule set, and keeps the
 * one function that is coherence's own (`effectiveMode`, which reads the model's timeline type).
 */

import type { SceneMeta, TimelineMode } from './model.js';

export {
  DAY_OFFSET_LIMIT,
  STORY_PARTS,
  isDayOffset,
  type DeclaredStoryPart,
  applySceneMetaPatch,
  type ScenePatch,
  type SceneMetaContext,
  type ScenePatchResult as PatchResult,
} from '@caotang/bus';

/** A scene's effective mode: absent is `linear` (§5.2.1). */
export function effectiveMode(meta: SceneMeta | undefined): TimelineMode {
  return meta?.timelineMode ?? 'linear';
}
