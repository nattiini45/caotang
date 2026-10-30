/**
 * Writer-declared scene metadata — [coherence.md §5.2 / §5.2.1 / §7.1](../../../docs/architecture/coherence.md).
 *
 * The rule that validates and applies a patch lives in `@caotang/bus` (`coherence.ts`), because the
 * bus's `coherence.setSceneMeta` and the store's apply must run the same rule and the dependency
 * runs coherence → store → bus. This module re-exports that rule under the names the coherence
 * module has always used, so the Inspector and the agent path share one rule set, and keeps the
 * one function that is coherence's own (`effectiveMode`, which reads the model's timeline type).
 */

import type { SceneMeta, StoryPart, TimelineMode } from './model.js';

export {
  applySceneMetaPatch,
  type ScenePatch,
  type SceneMetaContext,
  type ScenePatchResult as PatchResult,
} from '@caotang/bus';

/** A scene's effective mode: absent is `linear` (§5.2.1). */
export function effectiveMode(meta: SceneMeta | undefined): TimelineMode {
  return meta?.timelineMode ?? 'linear';
}

/** §5.2.2: the part a scene is in. `main` is the story between the prologue and the epilogue, stored as absence. */
export type EffectiveStoryPart = StoryPart | 'main';

/**
 * §5.2.2: the part a scene belongs to. The scene's own declaration wins; otherwise the nearest folder above it that declares
 * a part covers it; otherwise it is in the main story. `ancestors` are the declarations of the folders above the scene,
 * nearest last, as `ScannedScene.ancestorIds` orders them. Nothing is inferred from days or binder position.
 */
export function effectiveStoryPart(own: SceneMeta | undefined, ancestors: readonly (SceneMeta | undefined)[]): EffectiveStoryPart {
  if (own?.storyPart !== undefined) return own.storyPart;
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const part = ancestors[i]?.storyPart;
    if (part !== undefined) return part;
  }
  return 'main';
}
