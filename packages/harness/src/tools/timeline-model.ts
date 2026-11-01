/**
 * The timeline model as the harness builds it — one path for `timeline.read`, the card of `timeline.edit`, the SDK and the MCP resources
 * ([timeline.md §3, §9.2](../../../../docs/architecture/timeline.md)): `buildTimeline`, the desktop view's own, over the state and the coherence file the
 * project holds. Read-only. This file imports no tool metadata, so the primitive allowlist (which the metadata table imports) can use it without a cycle.
 */

import { emptyCoherenceFile, type CoherenceFile } from '@caotang/coherence';
import type { ProjectState } from '@caotang/store';
import { buildTimeline, projectLensOf, type CalendarLens, type LaneKey, type TimelineAxis, type TimelineModel, type Zoom } from '@caotang/timeline';

/** What a timeline read asks for. Every field is optional; the defaults are the view's own first-open defaults (§3.3). */
export interface TimelineReadOptions {
  /** Default `'story'`. */
  readonly axis?: TimelineAxis;
  /** Default `'none'`. */
  readonly groupBy?: LaneKey;
  /** Default `'day'` on the story and braid axes, `'scene'` on the narrative axis. */
  readonly zoom?: Zoom;
  /** A folder or document id: only the scenes under it. Absent is the whole manuscript. */
  readonly scope?: string;
  /** Default `'open'`: open findings only, never dismissed ones. */
  readonly findings?: 'open' | 'none';
  /** Default: the project's own calendar when it chose one and the definition is usable, else the built-in day lens. */
  readonly lens?: CalendarLens;
}

/**
 * The coherence file as the state holds it, or the empty file when the project was opened without one. Everything in
 * `state.coherence` came through the coherence module, so the downcast is the same checked one the app's session makes.
 */
export function coherenceFileOf(state: ProjectState): CoherenceFile {
  return (state.coherence as CoherenceFile | undefined) ?? emptyCoherenceFile();
}

/**
 * The lens the project's exports draw its days with: its own calendar or the day lens, worded in the project language, so a
 * day label read here is the label the compiled `timeline-csv` and the other exports write.
 */
export function projectLensFor(state: ProjectState): CalendarLens {
  const language = state.manifest.project.language ?? '';
  return projectLensOf(state.manifest.timeline, { locale: language === '' ? 'en' : language }).lens;
}

/** The pure timeline model of the project as it is now, built exactly as the desktop view builds it. Read-only: nothing is written or logged. */
export function timelineModelFor(state: ProjectState, options: TimelineReadOptions = {}): TimelineModel {
  return buildTimeline(state, coherenceFileOf(state), {
    axis: options.axis ?? 'story',
    groupBy: options.groupBy ?? 'none',
    zoom: options.zoom,
    lens: options.lens ?? projectLensFor(state),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    findings: options.findings ?? 'open',
  });
}
