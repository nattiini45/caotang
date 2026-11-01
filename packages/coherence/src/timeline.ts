/**
 * Timeline modes and their exemption table — [coherence.md §5.2.1](../../../docs/architecture/coherence.md).
 *
 * The table is data. Each cell is one of three treatments: `checked` (the default),
 * `exempt` (the check skips the scene), or `per-strand` (the scene is compared only
 * with scenes that share its mode). `timeline.relation`, `pov.coverage` and
 * `presence.expected` are checked in every mode, as the spec's table shows, so they
 * never appear here.
 */

import { STORY_PARTS, type DeclaredStoryPart } from '@caotang/bus';

import type { SceneMeta, TimelineMode } from './model.js';
import { effectiveStoryPart, type EffectiveStoryPart } from './scene-meta.js';

/** The four timeline checks a mode can exempt. */
export type TimelineCheck = 'timeline.order-drift' | 'timeline.window' | 'timeline.overlap' | 'timeline.gap';

/** Story days between two consecutive scenes, start to start, at which `timeline.gap` speaks (StoryLine's threshold, §5.2.1). */
export const GAP_THRESHOLD_DAYS = 7;

export type ModeTreatment = 'checked' | 'exempt' | 'per-strand';

const EXEMPTIONS: Readonly<Record<TimelineMode, Partial<Record<TimelineCheck, ModeTreatment>>>> = {
  linear: {},
  flashback: { 'timeline.order-drift': 'exempt' },
  'flash-forward': { 'timeline.order-drift': 'exempt' },
  dream: { 'timeline.order-drift': 'exempt', 'timeline.window': 'exempt', 'timeline.gap': 'exempt' },
  mythic: { 'timeline.order-drift': 'exempt', 'timeline.window': 'exempt', 'timeline.gap': 'exempt' },
  backstory: { 'timeline.order-drift': 'exempt', 'timeline.window': 'exempt' },
  parallel: { 'timeline.order-drift': 'per-strand' },
  frame: { 'timeline.order-drift': 'per-strand' },
  simultaneous: { 'timeline.overlap': 'exempt' },
  circular: { 'timeline.order-drift': 'exempt' },
  // A gap legitimizer, not a date-order exemption: the scene stays in the main order group (§5.2.1).
  'time-skip': { 'timeline.gap': 'exempt' },
};

/** The treatment a scene's mode gives one timeline check. Unlisted cells are `checked`. */
export function treatmentOf(mode: TimelineMode, check: TimelineCheck): ModeTreatment {
  return EXEMPTIONS[mode][check] ?? 'checked';
}

/**
 * A half-open day window `[start, end)`. A scene with no declared duration still
 * occupies its day, so a moment is `[d, d + 1)`. Two same-day scenes therefore
 * overlap, and day-granular containment works without a special case for zero.
 */
export interface DayWindow {
  readonly start: number;
  readonly end: number;
}

export function windowOf(dayOffset: number, durationDays: number | undefined): DayWindow {
  const duration = Math.max(durationDays ?? 0, 1);
  return { start: dayOffset, end: dayOffset + duration };
}

export function windowsOverlap(a: DayWindow, b: DayWindow): boolean {
  return a.start < b.end && b.start < a.end;
}

/** True when `inner` lies entirely inside `outer` (§5.1 `timeline.window`). */
export function windowInside(inner: DayWindow, outer: DayWindow): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}


/** The tree as the part rule reads it: ids and parents only, so a `TreeNode[]` and a test fixture both fit. */
export interface PartTreeNode {
  readonly id: string;
  readonly parentId: string | null;
}

function declaredPart(meta: { readonly storyPart?: unknown } | undefined): DeclaredStoryPart | undefined {
  const part = meta?.storyPart;
  return typeof part === 'string' && (STORY_PARTS as readonly string[]).includes(part) ? (part as DeclaredStoryPart) : undefined;
}

/**
 * The effective story part of every node ([timeline.md §2.3](../../../docs/architecture/timeline.md), coherence.md §5.2.2), by the
 * one inheritance rule (`effectiveStoryPart` in `scene-meta.ts`): the node's own declaration, else the nearest ancestor's, else
 * `main`. Pure and computed on read: nothing is written into a child, a part is never inferred from days, binder position, title or
 * content, and a folder's change re-parts its children for free. A cycle in a damaged tree stops the walk.
 */
export function effectiveStoryParts(
  tree: readonly PartTreeNode[],
  sceneMeta: Readonly<Record<string, { readonly storyPart?: unknown; readonly mainStory?: unknown } | undefined>>,
): Map<string, EffectiveStoryPart> {
  const parents = new Map<string, string | null>();
  for (const node of tree) parents.set(node.id, node.parentId);
  const metaOf = (id: string): SceneMeta | undefined => {
    const part = declaredPart(sceneMeta[id]);
    if (part !== undefined) return { storyPart: part };
    // timeline.md §2.3: the additive main-story mark, read only where no part is declared.
    return (sceneMeta[id] as { readonly mainStory?: unknown } | undefined)?.mainStory === true ? { mainStory: true } : undefined;
  };
  const resolved = new Map<string, EffectiveStoryPart>();
  for (const node of tree) {
    // The ancestors, nearest last, as `effectiveStoryPart` reads them.
    const ancestors: (SceneMeta | undefined)[] = [];
    const seen = new Set<string>([node.id]);
    let cursor = parents.get(node.id);
    while (cursor !== null && cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      ancestors.unshift(metaOf(cursor));
      cursor = parents.get(cursor);
    }
    resolved.set(node.id, effectiveStoryPart(metaOf(node.id), ancestors));
  }
  return resolved;
}

/** One node's effective part. For many nodes, {@link effectiveStoryParts} walks the tree once. */
export function storyPartOf(
  tree: readonly PartTreeNode[],
  sceneMeta: Readonly<Record<string, { readonly storyPart?: unknown; readonly mainStory?: unknown } | undefined>>,
  nodeId: string,
): EffectiveStoryPart {
  return effectiveStoryParts(tree, sceneMeta).get(nodeId) ?? declaredPart(sceneMeta[nodeId]) ?? 'main';
}

/** The meta a scene carries, for callers that hold a `SceneMeta` and want its own declaration (not the effective part). */
export function declaredStoryPart(meta: SceneMeta | undefined): DeclaredStoryPart | undefined {
  return declaredPart(meta);
}
