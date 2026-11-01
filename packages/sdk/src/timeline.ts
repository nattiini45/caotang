/**
 * The story timeline as a Node host reads it — [timeline.md §3, §8, §9.2](../../../docs/architecture/timeline.md).
 *
 * One canonical path for every host: `timelineModelOf` builds the pure model with the same `buildTimeline` the desktop view
 * and the exporter call, from the state and the `coherence.json` the session holds in memory, so a Node caller, the MCP
 * server and the browser see identical data from the same project. `timelineCsvOf` hands the project to the exporter's
 * own table and CSV writer (§8), so the MCP resource and the compiled `timeline-csv` file are one implementation, in the
 * canonical logical order, which never depends on any reading direction.
 *
 * Both are pure reads: neither writes the folder, and neither logs a row.
 */

import { emptyCoherenceFile, type CoherenceFile } from '@caotang/coherence';
import { timelineCsv, timelineTable } from '@caotang/exporter';
import {
  buildTimeline,
  projectLensOf,
  type CalendarLens,
  type LaneKey,
  type TimelineAxis,
  type TimelineModel,
  type Zoom,
} from '@caotang/timeline';
import type { ProjectState, TreeNode } from '@caotang/store';

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
 * The coherence file as the state holds it, or the empty file when the project was opened without one. The store's
 * structural type carries a whole `CoherenceFile` (every value in it came through the coherence module), so this is the
 * same checked downcast the app's session makes.
 */
export function coherenceFileOf(state: ProjectState): CoherenceFile {
  return (state.coherence as CoherenceFile | undefined) ?? emptyCoherenceFile();
}

/** The project language the exports word a day label in, so a read here agrees with the compiled `timeline-csv`. */
function projectLocaleOf(state: ProjectState): string {
  const language = state.manifest.project.language ?? '';
  return language === '' ? 'en' : language;
}

/** Whether `id` names a node of the project that a scope may name: a folder or a document, not a fixed root. */
export function scopeNodeOf(state: ProjectState, id: string): TreeNode | undefined {
  return state.manifest.tree.find((node) => node.id === id && node.type !== 'root');
}

/**
 * The pure timeline model of the project as it is now, built exactly as the desktop view builds it. Read-only: nothing is
 * written and nothing is logged.
 */
export function timelineModelOf(state: ProjectState, options: TimelineReadOptions = {}): TimelineModel {
  return buildTimeline(state, coherenceFileOf(state), {
    axis: options.axis ?? 'story',
    groupBy: options.groupBy ?? 'none',
    zoom: options.zoom,
    lens: options.lens ?? projectLensOf(state.manifest.timeline, { locale: projectLocaleOf(state) }).lens,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    findings: options.findings ?? 'open',
  });
}

/**
 * The timeline as CSV text (timeline.md §8): the exporter's own `timelineTable` and `timelineCsv`, the code that writes
 * the compiled `timeline-csv` file, so the resource and the file are the same bytes for the same project and cannot
 * drift. One row per scene in canonical order (part, then day, then reading index, undated last per part), days as
 * signed decimals with the formula guard, CRLF records, the exporter's column names.
 *
 * What the table does not carry is the zone summary (the parts' day spans and fold labels); that lives in the JSON
 * resource and in `timeline.read`, because the compiled file has no place for it either. The table's axis, lanes and
 * lens are the exporter's fixed ones (story axis, no lanes, the project language's day lens, open findings), so only
 * `scope` narrows it. Read-only.
 */
export function timelineCsvOf(state: ProjectState, options: Pick<TimelineReadOptions, 'scope'> = {}): string {
  return timelineCsv(timelineTable({ state, includeRootIds: [options.scope ?? 'manuscript'] }));
}