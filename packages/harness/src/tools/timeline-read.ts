/**
 * `timeline.read` — [timeline.md §5.1](../../../../docs/architecture/timeline.md): the story timeline as a read, in the projection the desktop view and
 * the MCP resources use. The model is `buildTimeline`'s, built from the state and the coherence file the project holds, so the tool, the view and
 * `caotang://timeline` answer with identical data for one project. A read: it dispatches nothing, saves nothing and logs no row.
 *
 * The answer is capped (the row's `response_token_cap`): the fixed parts (stats, zones, folds) are always whole, then whole scene records in the
 * model's canonical order and the shelf's steps after them, until the budget. The cut is at a record boundary and is counted in `omitted`, never
 * hidden, with the scope to narrow to.
 */

import { ok, type CommandError, type Result } from '@caotang/bus';
import { dayLens, type CalendarLens, type LaneKey, type TimelineAxis, type TimelineItem, type TimelineModel } from '@caotang/timeline';

import { capOf } from '../metadata.js';
import { resolveNode, TARGET } from '../resolve.js';
import { param, type ObjectSpec } from '../schema.js';
import { charBudget } from '../tokens.js';
import type { CallParams, PreparedCall, PrepareContext } from '../types.js';
import { projectLensFor, timelineModelFor, type TimelineReadOptions } from './timeline-model.js';

export { coherenceFileOf, timelineModelFor, type TimelineReadOptions } from './timeline-model.js';

export const TIMELINE_AXES: readonly TimelineAxis[] = ['story', 'narrative', 'braid'];
export const TIMELINE_LANE_KEYS: readonly LaneKey[] = ['none', 'pov', 'character', 'mode', 'folder', 'location', 'thread'];
export const TIMELINE_FINDINGS_MODES = ['open', 'none'] as const;

export const timelineReadParams: ObjectSpec = param.object(
  'Which part of the timeline to read, and how to arrange it. Every parameter is optional.',
  {
    axis: param.choice("The axis to read: 'story' (default), 'narrative' (reading order) or 'braid' (both).", TIMELINE_AXES),
    groupBy: param.choice(
      "The lanes to read: 'none' (default, one row per scene), 'pov', 'character', 'mode', 'folder', 'location' or 'thread'.",
      TIMELINE_LANE_KEYS,
    ),
    scope: param.string('A folder or document: a title, or an id. Only the scenes under it are read. Leave it out for the whole manuscript.', { nonBlank: true }),
    findings: param.choice("'open' (default) attaches the open findings to their scenes; 'none' leaves them out.", TIMELINE_FINDINGS_MODES),
  },
  [],
);

/** One scene's record in the answer: the complete entry of §5.1, whole, never cut in half. */
type SceneRecord = {
  readonly nodeId: string;
  readonly title: string;
  readonly part: string;
  readonly lane: string;
  readonly readingIndex: number;
  readonly day?: number;
  readonly durationDays?: number;
  readonly endDay?: number;
  readonly dayLabel?: string;
  readonly mode: string;
  readonly pov?: string;
  readonly folder: string | null;
  readonly measure: number;
  readonly medium: string;
  readonly findings: readonly { id: string; checkId: string; severity: string }[];
  readonly partNote?: string;
};

function sceneRecordOf(item: TimelineItem, lens: CalendarLens): SceneRecord {
  return {
    nodeId: item.nodeId,
    title: item.title,
    part: item.part,
    lane: item.lane,
    readingIndex: item.readingIndex,
    ...(item.dayOffset === undefined ? {} : { day: item.dayOffset }),
    ...(item.durationDays === undefined ? {} : { durationDays: item.durationDays }),
    ...(item.end === undefined ? {} : { endDay: item.end }),
    ...(item.dayOffset === undefined ? {} : { dayLabel: lens.label(item.dayOffset, 'long') }),
    mode: item.mode,
    ...(item.pov === undefined ? {} : { pov: item.pov }),
    folder: item.folderId,
    measure: item.measure,
    medium: item.medium,
    findings: item.findings.map((finding) => ({ id: finding.id, checkId: finding.checkId, severity: finding.severity })),
    ...(item.partNote === undefined ? {} : { partNote: item.partNote }),
  };
}

type Chain = TimelineModel['unscheduled']['sequenced'][number];
type ChainStep = Chain['steps'][number];
type LooseItem = TimelineModel['unscheduled']['loose'][number];
type ShelfStep = { nodeId: string; title: string; part: string; afterDayHint?: string };
type ShelfChain = { part: string; cycle: boolean; steps: ShelfStep[] };

/** One shelf record as JSON counts it: a chain step with its "after Day N" hint, or a loose scene. */
function shelfRecordOf(entry: { chain?: Chain; step?: ChainStep; item?: LooseItem }): ShelfStep {
  if (entry.step !== undefined) {
    return {
      nodeId: entry.step.item.nodeId,
      title: entry.step.item.title,
      part: entry.step.item.part,
      ...(entry.step.anchor === undefined ? {} : { afterDayHint: entry.step.anchor.hint }),
    };
  }
  return { nodeId: entry.item?.nodeId ?? '', title: entry.item?.title ?? '', part: entry.item?.part ?? 'main' };
}

/** The answer's data: zones and folds whole, then scene and shelf records until the budget, with the omitted counts. */
export type TimelineReadData = {
  readonly axis: TimelineAxis;
  readonly groupBy: LaneKey;
  readonly scope?: string;
  readonly lens: string;
  readonly stats: { scenes: number; scheduled: number; share: number };
  readonly zones: readonly unknown[];
  readonly folds: readonly unknown[];
  readonly scenes: readonly SceneRecord[];
  readonly unscheduled: {
    readonly sequenced: readonly ShelfChain[];
    readonly loose: readonly { nodeId: string; title: string; part: string }[];
  };
  readonly omitted: { scenes: number; shelfSteps: number } | null;
};

/** Characters the answer's own punctuation takes beyond its records (keys, brackets, the `omitted` field), reserved from the budget. */
const WRAPPER_RESERVE_CHARS = 400;

/**
 * Builds the answer from the model: the fixed parts (stats, zones, folds) always whole, then the scene records in the model's canonical order and
 * the shelf records after them, stopping at the first record that would cross the budget. What was left out is counted and reported.
 */
export function timelineReadDataOf(model: TimelineModel, options: Pick<TimelineReadOptions, 'lens'> = {}, cap: number = capOf('timeline.read')): TimelineReadData {
  const lens = options.lens ?? dayLens;
  const fixed = JSON.stringify({
    axis: model.options.axis,
    groupBy: model.options.groupBy,
    ...(model.options.scope === undefined ? {} : { scope: model.options.scope }),
    lens: lens.id,
    stats: model.stats,
    zones: model.zones,
    folds: model.axis.folds,
  });
  const budget = charBudget(cap) - WRAPPER_RESERVE_CHARS;
  // The comma between records is counted with each, so the sum of what is kept is the length of the array it makes.
  let used = fixed.length;

  const sceneItems = model.items.filter((item) => item.kind === 'scene');
  const scenes: SceneRecord[] = [];
  let omittedScenes = 0;
  for (const [index, item] of sceneItems.entries()) {
    const record = sceneRecordOf(item, lens);
    const size = JSON.stringify(record).length + 1;
    if (scenes.length > 0 && used + size > budget) {
      omittedScenes = sceneItems.length - index;
      break;
    }
    scenes.push(record);
    used += size;
  }

  // One shelf record per step, in the model's own order (chains first, then the loose scenes); each is a record boundary, so the cut never splits a
  // step from its chain's header, and a step that opens a chain is charged for the header too.
  const shelfRecords: { chain?: Chain; step?: ChainStep; item?: LooseItem }[] = [
    ...model.unscheduled.sequenced.flatMap((chain) => chain.steps.map((step) => ({ chain, step }))),
    ...model.unscheduled.loose.map((item) => ({ item })),
  ];
  const sequenced: ShelfChain[] = [];
  const loose: { nodeId: string; title: string; part: string }[] = [];
  let omittedShelf = 0;
  let openChain: Chain | undefined;
  for (const [index, entry] of shelfRecords.entries()) {
    const record = shelfRecordOf(entry);
    const opens = entry.chain !== undefined && entry.chain !== openChain;
    const header = opens && entry.chain !== undefined ? JSON.stringify({ part: entry.chain.part, cycle: entry.chain.cycle, steps: [] }).length + 1 : 0;
    const size = JSON.stringify(record).length + 1 + header;
    if (sequenced.length + loose.length > 0 && used + size > budget) {
      omittedShelf = shelfRecords.length - index;
      break;
    }
    used += size;
    if (entry.chain !== undefined) {
      if (opens) {
        sequenced.push({ part: entry.chain.part, cycle: entry.chain.cycle, steps: [record] });
        openChain = entry.chain;
      } else {
        sequenced[sequenced.length - 1]?.steps.push(record);
      }
    } else if (entry.item !== undefined) {
      loose.push({ nodeId: entry.item.nodeId, title: entry.item.title, part: entry.item.part });
    }
  }

  return {
    axis: model.options.axis,
    groupBy: model.options.groupBy,
    ...(model.options.scope === undefined ? {} : { scope: model.options.scope }),
    lens: lens.id,
    stats: { scenes: model.stats.scenes, scheduled: model.stats.scheduled, share: model.stats.share },
    zones: model.zones,
    folds: model.axis.folds,
    scenes,
    unscheduled: { sequenced, loose },
    omitted: omittedScenes === 0 && omittedShelf === 0 ? null : { scenes: omittedScenes, shelfSteps: omittedShelf },
  };
}

/** The one-line summary a model reads first, in plain words, naming what was left out. */
function summaryOf(project: string, data: TimelineReadData): string {
  const parts = data.zones.length;
  const scheduled = `${data.stats.scheduled} of ${data.stats.scenes} scheduled`;
  return `The timeline of “${project}”: ${data.stats.scenes} scenes (${scheduled}), ${parts} part${parts === 1 ? '' : 's'}, ${data.axis} axis grouped by ${data.groupBy}.`;
}

function omissionNote(data: TimelineReadData, cap: number): string | undefined {
  if (data.omitted === null) return undefined;
  return `${data.omitted.scenes} scenes and ${data.omitted.shelfSteps} shelf steps were left out over the ${cap.toLocaleString('en')}-token cap; narrow scope to a folder or document to read them.`;
}

export function prepareTimelineRead(params: CallParams, context: PrepareContext): Result<PreparedCall, CommandError> {
  const { state } = context;
  let scope: string | undefined;
  const reference = params['scope'];
  if (typeof reference === 'string') {
    const node = resolveNode(state, reference, TARGET, 'folder or document', 'params.scope');
    if (!node.ok) return node;
    scope = node.value.id;
  }
  const options: TimelineReadOptions = {
    ...(params['axis'] === undefined ? {} : { axis: params['axis'] as TimelineAxis }),
    ...(params['groupBy'] === undefined ? {} : { groupBy: params['groupBy'] as LaneKey }),
    ...(params['findings'] === undefined ? {} : { findings: params['findings'] as 'open' | 'none' }),
    ...(scope === undefined ? {} : { scope }),
    lens: projectLensFor(state),
  };
  const cap = capOf('timeline.read');
  const data = timelineReadDataOf(timelineModelFor(state, options), options, cap);
  const note = omissionNote(data, cap);
  return ok({
    commands: [],
    finish: () => ok({ data, summary: summaryOf(state.manifest.project.name, data), affected: [], ...(note === undefined ? {} : { notes: [note] }) }),
  });
}
