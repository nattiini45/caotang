/**
 * Axes ([timeline.md §3.2 and §3.4](../../../docs/architecture/timeline.md)): the story axis with its part zones, gap
 * breaks and folds, the zoom levels, and the projection from the canonical model to coordinates.
 *
 * The story axis is stored as zoom-independent runs of days plus counts of fixed-width separators, so one model draws at
 * any zoom. The project language's direction is applied only in `projectTimeline`, by mirroring finished boxes.
 */

import { GAP_THRESHOLD_DAYS } from '@caotang/coherence';

import type { CalendarLens } from './calendar.js';
import type { TimelineLabels } from './labels.js';
import {
  PART_ORDER,
  type AxisBreak,
  type AxisFold,
  type AxisSegment,
  type AxisTick,
  type SemanticLevel,
  type StoryPart,
  type TimelineMode,
  type TimelineModel,
  type Zoom,
} from './model.js';

/** Runs of empty days at least this long collapse into a break (the `timeline.gap` threshold). */
export const GAP_COMPRESSION_DAYS = GAP_THRESHOLD_DAYS;

const PX_PER_DAY: Readonly<Record<Zoom, number>> = { day: 48, week: 8, month: 1.5, fit: 0.1, scene: 48, chapter: 8, act: 1.5 };

export function pxPerDayOf(zoom: Zoom): number {
  return PX_PER_DAY[zoom];
}

const LEVEL_OF: Readonly<Record<Zoom, SemanticLevel>> = {
  day: 'scene',
  week: 'scene',
  month: 'chapter',
  fit: 'act',
  scene: 'scene',
  chapter: 'chapter',
  act: 'act',
};

/** Semantic zoom: what a zoom aggregates into blocks. Day and Week keep scenes, Month is chapters, Fit and Act are acts. */
export function semanticLevelOf(zoom: Zoom): SemanticLevel {
  return LEVEL_OF[zoom];
}

export interface AxisScene {
  nodeId: string;
  part: StoryPart;
  start: number;
  end: number;
  mode: TimelineMode;
  readingIndex: number;
}

export interface StoryAxisInput {
  scenes: readonly AxisScene[];
  compress: boolean;
  lens: CalendarLens;
  labels: TimelineLabels;
  pxPerDay: number;
  /** Scene id to the open `timeline.gap` finding on it, to link a break to. */
  gapFindings: ReadonlyMap<string, string>;
}

export interface StoryAxisParts {
  segments: AxisSegment[];
  breaks: AxisBreak[];
  folds: AxisFold[];
  ticks: AxisTick[];
}

export function buildStoryAxis(input: StoryAxisInput): StoryAxisParts {
  const { lens, labels } = input;
  const byPart = new Map<StoryPart, AxisScene[]>();
  for (const scene of input.scenes) {
    const list = byPart.get(scene.part);
    if (list === undefined) byPart.set(scene.part, [scene]);
    else list.push(scene);
  }

  const segments: AxisSegment[] = [];
  const breaks: AxisBreak[] = [];
  const folds: AxisFold[] = [];
  let days = 0;
  let breakCount = 0;
  let foldCount = 0;
  let previous: StoryPart | undefined;

  for (const part of PART_ORDER) {
    const scenes = byPart.get(part);
    if (scenes === undefined) continue;
    scenes.sort((a, b) => a.start - b.start || a.readingIndex - b.readingIndex);
    const runs: { from: number; to: number; lead: number }[] = [];
    for (let i = 0; i < scenes.length; i += 1) {
      const scene = scenes[i] as AxisScene;
      const run = runs[runs.length - 1];
      if (run !== undefined && (!input.compress || scene.start - run.to < GAP_COMPRESSION_DAYS)) {
        if (scene.end > run.to) run.to = scene.end;
      } else {
        runs.push({ from: scene.start, to: scene.end, lead: i });
      }
    }

    runs.forEach((run, at) => {
      const index = segments.length;
      if (at > 0) {
        const before = runs[at - 1] as { from: number; to: number };
        const gap = run.from - before.to;
        let skip = false;
        let findingId: string | undefined;
        for (let j = run.lead; j < scenes.length && (scenes[j] as AxisScene).start === run.from; j += 1) {
          const scene = scenes[j] as AxisScene;
          if (scene.mode === 'time-skip') skip = true;
          findingId ??= input.gapFindings.get(scene.nodeId);
        }
        breakCount += 1;
        breaks.push({
          part,
          segment: index,
          fromDay: before.to,
          toDay: run.from,
          days: gap,
          kind: skip ? 'time-skip' : 'gap',
          label: skip ? labels.timeSkipBreak : labels.gapBreak(gap),
          ...(!skip && findingId !== undefined ? { findingId } : {}),
        });
      } else if (previous !== undefined) {
        foldCount += 1;
        const earlier = segments[segments.length - 1] as AxisSegment;
        const named: StoryPart = previous === 'prologue' && part === 'main' ? 'prologue' : 'epilogue';
        const spanDays = run.from - earlier.to;
        const span = spanDays > 0 ? lens.span(earlier.to, run.from) : undefined;
        const label = labels.foldLabel(named, span, spanDays > 0 ? lens.label(run.from, 'short') : undefined);
        folds.push({
          fromPart: previous,
          toPart: part,
          part: named,
          segment: index,
          ...(spanDays > 0 ? { spanDays } : {}),
          label,
          a11yLabel: labels.foldAnnounce(named, label),
        });
      }
      segments.push({ part, from: run.from, to: run.to, daysBefore: days, breaksBefore: breakCount, foldsBefore: foldCount });
      days += run.to - run.from;
    });
    previous = part;
  }

  const ticks: AxisTick[] = [];
  segments.forEach((segment, index) => {
    for (const tick of lens.ticks([segment.from, segment.to - 1], input.pxPerDay)) {
      ticks.push({ day: tick.day, level: tick.level, label: tick.label, segment: index, part: segment.part });
    }
  });
  return { segments, breaks, folds, ticks };
}

/** The segment of `part` holding `day`, by binary search over the part's runs. */
export function segmentIndexOf(segments: readonly AxisSegment[], part: StoryPart, day: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const segment = segments[mid] as AxisSegment;
    if (segment.part !== part) {
      if (PART_ORDER.indexOf(segment.part) < PART_ORDER.indexOf(part)) lo = mid + 1;
      else hi = mid - 1;
    } else if (day < segment.from) hi = mid - 1;
    else if (day >= segment.to) lo = mid + 1;
    else {
      found = mid;
      break;
    }
  }
  return found;
}

export interface ProjectionOptions {
  /** Defaults to the model's zoom. */
  pxPerDay?: number;
  slotPx?: number;
  /** Narrative slots as wide as their scene is long (words or pages), within a clamp. */
  proportionalSlots?: boolean;
  rowPx?: number;
  lanePadPx?: number;
  breakPx?: number;
  foldPx?: number;
  /** Height of the narrative strip above the story strip on the braid axis, and the gap under it. */
  stripPx?: number;
  /** Defaults to the model's direction. Passing the other one mirrors every x about the width. */
  direction?: 'ltr' | 'rtl';
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TimelineGeometry {
  direction: 'ltr' | 'rtl';
  width: number;
  height: number;
  items: { key: string; box: Box }[];
  lanes: { id: string; box: Box }[];
  zones: { part: StoryPart; box: Box }[];
  breaks: { index: number; box: Box }[];
  folds: { index: number; box: Box }[];
  ticks: { index: number; x: number }[];
  /** The braid axis's narrative strip, and the narrative axis's slots. */
  slots: { nodeId: string; box: Box }[];
  bands: { nodeId: string; box: Box }[];
  partRuns: { part: StoryPart; box: Box }[];
}

const SLOT_CLAMP: readonly [number, number] = [0.5, 3];

/** Turns the canonical model into boxes. Everything is laid out left to right, then mirrored once if the book reads right to left. */
export function projectTimeline(model: TimelineModel, options: ProjectionOptions = {}): TimelineGeometry {
  const ppd = options.pxPerDay ?? model.axis.pxPerDay;
  const slotPx = options.slotPx ?? 48;
  const rowPx = options.rowPx ?? 28;
  const lanePad = options.lanePadPx ?? 10;
  const breakPx = options.breakPx ?? 28;
  const foldPx = options.foldPx ?? 44;
  const stripPx = options.stripPx ?? 32;
  const direction = options.direction ?? model.direction;
  const kind = model.axis.kind;
  const { segments } = model.axis;

  const segmentX = (segment: AxisSegment): number => segment.daysBefore * ppd + segment.breaksBefore * breakPx + segment.foldsBefore * foldPx;
  const dayX = (segment: AxisSegment, day: number): number => segmentX(segment) + (day - segment.from) * ppd;

  const measures = model.axis.measures;
  const slotX: number[] = new Array<number>(measures.length);
  const slotW: number[] = new Array<number>(measures.length);
  let slotsEnd = 0;
  if (options.proportionalSlots === true && measures.length > 0) {
    const mean = measures.reduce((sum, value) => sum + value, 0) / measures.length || 1;
    measures.forEach((measure, i) => {
      slotX[i] = slotsEnd;
      slotW[i] = slotPx * Math.min(SLOT_CLAMP[1], Math.max(SLOT_CLAMP[0], measure / mean));
      slotsEnd += slotW[i] as number;
    });
  } else {
    measures.forEach((_, i) => {
      slotX[i] = i * slotPx;
      slotW[i] = slotPx;
    });
    slotsEnd = measures.length * slotPx;
  }

  let storyEnd = 0;
  const last = segments[segments.length - 1];
  if (last !== undefined) storyEnd = dayX(last, last.to);
  const width = kind === 'narrative' ? slotsEnd : kind === 'story' ? storyEnd : Math.max(storyEnd, slotsEnd);

  const braid = kind === 'braid';
  const laneTop = braid ? stripPx * 2 : 0;
  const laneBoxes = new Map<string, Box>();
  let y = laneTop;
  for (const lane of model.lanes) {
    const rows = kind === 'narrative' ? 1 : lane.rows;
    const h = rows * rowPx;
    laneBoxes.set(lane.id, { x: 0, y, w: width, h });
    y += h + lanePad;
  }
  const height = Math.max(y - (model.lanes.length > 0 ? lanePad : 0), laneTop);

  const boxes: Box[] = [];
  const push = (box: Box): Box => {
    boxes.push(box);
    return box;
  };

  const items: TimelineGeometry['items'] = [];
  for (const item of model.items) {
    const lane = laneBoxes.get(item.lane) as Box;
    const slot = item.readingIndex;
    if (kind === 'narrative') {
      items.push({ key: item.key, box: push({ x: slotX[slot] as number, y: lane.y, w: slotW[slot] as number, h: rowPx }) });
    } else if (item.start !== undefined && item.end !== undefined && item.segment !== undefined) {
      const segment = segments[item.segment] as AxisSegment;
      items.push({
        key: item.key,
        box: push({ x: dayX(segment, item.start), y: lane.y + item.row * rowPx, w: (item.end - item.start) * ppd, h: rowPx }),
      });
    }
  }

  const slots: TimelineGeometry['slots'] = [];
  if (kind !== 'story') {
    const seen = new Set<number>();
    for (const item of model.items) {
      if (seen.has(item.readingIndex)) continue;
      seen.add(item.readingIndex);
      slots.push({ nodeId: item.nodeId, box: push({ x: slotX[item.readingIndex] as number, y: 0, w: slotW[item.readingIndex] as number, h: stripPx }) });
    }
  }

  const zones: TimelineGeometry['zones'] = [];
  if (kind !== 'narrative') {
    for (const zone of model.zones) {
      const mine = segments.filter((segment) => segment.part === zone.part);
      const first = mine[0];
      const tail = mine[mine.length - 1];
      if (first === undefined || tail === undefined) continue;
      zones.push({ part: zone.part, box: push({ x: dayX(first, first.from), y: laneTop, w: dayX(tail, tail.to) - dayX(first, first.from), h: height - laneTop }) });
    }
  }

  const separator = (segmentIndex: number, px: number): Box => {
    const segment = segments[segmentIndex] as AxisSegment;
    return push({ x: segmentX(segment) - px, y: laneTop, w: px, h: height - laneTop });
  };
  const breaks = kind === 'narrative' ? [] : model.axis.breaks.map((b, index) => ({ index, box: separator(b.segment, breakPx) }));
  const folds = kind === 'narrative' ? [] : model.axis.folds.map((f, index) => ({ index, box: separator(f.segment, foldPx) }));
  const tickXs: TimelineGeometry['ticks'] = [];
  if (kind !== 'narrative') {
    model.axis.ticks.forEach((tick, index) => {
      tickXs.push({ index, x: dayX(segments[tick.segment] as AxisSegment, tick.day) });
    });
  }

  const slotSpan = (first: number, lastSlot: number): { x: number; w: number } => ({
    x: slotX[first] as number,
    w: (slotX[lastSlot] as number) + (slotW[lastSlot] as number) - (slotX[first] as number),
  });
  const bands: TimelineGeometry['bands'] = [];
  const partRuns: TimelineGeometry['partRuns'] = [];
  if (kind !== 'story') {
    for (const band of model.bands) {
      const span = slotSpan(band.firstReading, band.lastReading);
      bands.push({ nodeId: band.nodeId, box: push({ x: span.x, y: braid ? stripPx : 0, w: span.w, h: stripPx }) });
    }
    for (const run of model.partRuns) {
      const span = slotSpan(run.firstReading, run.lastReading);
      partRuns.push({ part: run.part, box: push({ x: span.x, y: 0, w: span.w, h: braid ? stripPx : height }) });
    }
  }

  const lanes: TimelineGeometry['lanes'] = model.lanes.map((lane) => ({ id: lane.id, box: push(laneBoxes.get(lane.id) as Box) }));

  if (direction === 'rtl') {
    for (const box of boxes) box.x = width - box.x - box.w;
    for (const tick of tickXs) tick.x = width - tick.x;
  }
  return { direction, width, height, items, lanes, zones, breaks, folds, ticks: tickXs, slots, bands, partRuns };
}
