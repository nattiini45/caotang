/**
 * Timeline modes and their exemption table — [coherence.md §5.2.1](../../../docs/architecture/coherence.md).
 *
 * The table is data. Each cell is one of three treatments: `checked` (the default),
 * `exempt` (the check skips the scene), or `per-strand` (the scene is compared only
 * with scenes that share its mode). `timeline.relation`, `pov.coverage` and
 * `presence.expected` are checked in every mode, as the spec's table shows, so they
 * never appear here.
 */

import type { TimelineMode } from './model.js';

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
