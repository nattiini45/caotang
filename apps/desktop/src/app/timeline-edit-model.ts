/**
 * What a gesture on the timeline means ([timeline.md §4.2](docs/architecture/timeline.md)): how a pointer position becomes a day, a
 * part, a lane or a binder place, which keys are the keyboard's alternatives, and where a proposal's ghost is drawn.
 *
 * Pure functions over `@caotang/timeline`'s model and its projected boxes, so every mapping is testable without a page. The axis
 * geometry is laid out left to right and mirrored once for a right-to-left book (`projectTimeline`); the frames below are in the
 * unmirrored space and the helpers mirror at the edge, so a day maps to the same place the drawn chip sits.
 */

import { DAY_OFFSET_LIMIT, type DeclaredStoryPart } from '@caotang/bus';
import type { ProjectState } from '@caotang/store';
import type { StoryPart, TimelineItem, TimelineModel } from '@caotang/timeline';

import { planDrop, planKeyboardMove } from './binder-model.js';
import type { Rect } from './timeline-model.js';
import { moveOfKey } from './timeline-model.js';
import { treeWithMoves, type MetaIntent, type MetaRow, type MoveRow, type MoveTarget, type Row, type ShiftRow } from './timeline-proposals.js';

/** `projectTimeline`'s own defaults for the fixed-width separators; `projectTimeline` is given no other. A test pins them against the drawn boxes. */
export const BREAK_PX = 28;
export const FOLD_PX = 44;

/** The pixels a drag must travel before a bar moves (timeline.md §4.2). */
export const DRAG_THRESHOLD_PX = 4;

/* ------------------------------------------------------------------ *
 * Days and x
 * ------------------------------------------------------------------ */

/** One run of days of one part, where it starts in the unmirrored layout. */
export interface DayFrame {
  readonly part: StoryPart;
  readonly from: number;
  /** Exclusive. */
  readonly to: number;
  /** The unmirrored x of `from`. */
  readonly x: number;
}

export function dayFrames(model: TimelineModel): DayFrame[] {
  const ppd = model.axis.pxPerDay;
  return model.axis.segments.map((segment) => ({
    part: segment.part,
    from: segment.from,
    to: segment.to,
    x: segment.daysBefore * ppd + segment.breaksBefore * BREAK_PX + segment.foldsBefore * FOLD_PX,
  }));
}

const clampDay = (day: number): number => Math.max(-DAY_OFFSET_LIMIT, Math.min(DAY_OFFSET_LIMIT, Math.round(day)));

/**
 * The unmirrored x of a day in a part. A day inside a run is where the run puts it; a day outside every run of the part is placed by
 * extending the nearest run, so a proposal's ghost lands past the last scene or before the first. A part with no run at all is placed
 * after the last run (an epilogue) or before the first (a prologue), and the main story with the nearest run of any part.
 */
export function xOfDay(frames: readonly DayFrame[], part: StoryPart, day: number, ppd: number): number | undefined {
  if (frames.length === 0) return undefined;
  const mine = frames.filter((frame) => frame.part === part);
  const pool = mine.length > 0 ? mine : part === 'prologue' ? [frames[0] as DayFrame] : part === 'epilogue' ? [frames[frames.length - 1] as DayFrame] : frames;
  let best = pool[0] as DayFrame;
  let gap = Number.POSITIVE_INFINITY;
  for (const frame of pool) {
    const distance = day < frame.from ? frame.from - day : day >= frame.to ? day - frame.to + 1 : 0;
    if (distance < gap) {
      gap = distance;
      best = frame;
    }
  }
  return best.x + (day - best.from) * ppd;
}

/**
 * The day under an unmirrored x, within the runs of `part` (or any run when none is named). Between two runs of the part the nearest
 * edge is taken; before the first and after the last the run is extended.
 */
export function dayAtX(frames: readonly DayFrame[], x: number, ppd: number, part?: StoryPart): number | undefined {
  const pool = part === undefined ? frames : frames.filter((frame) => frame.part === part);
  const use = pool.length > 0 ? pool : frames;
  if (use.length === 0) return undefined;
  let best = use[0] as DayFrame;
  let gap = Number.POSITIVE_INFINITY;
  for (const frame of use) {
    const end = frame.x + (frame.to - frame.from) * ppd;
    const distance = x < frame.x ? frame.x - x : x > end ? x - end : 0;
    if (distance < gap) {
      gap = distance;
      best = frame;
    }
  }
  const index = use.indexOf(best);
  const raw = best.from + (x - best.x) / ppd;
  if (raw < best.from && index > 0) return clampDay(best.from);
  if (raw > best.to && index < use.length - 1) return clampDay(best.to);
  return clampDay(raw);
}

/** A box's left edge in the unmirrored layout, from its drawn box (geometry coordinates, so without the gutter offset). */
export function unmirroredLeft(box: Pick<Rect, 'x' | 'w'>, width: number, direction: 'ltr' | 'rtl'): number {
  return direction === 'ltr' ? box.x : width - box.x - box.w;
}

/** The drawn x (geometry coordinates) of a box of width `w` whose unmirrored left edge is `left`. */
export function mirroredX(left: number, w: number, width: number, direction: 'ltr' | 'rtl'): number {
  return direction === 'ltr' ? left : width - left - w;
}

/* ------------------------------------------------------------------ *
 * Drops
 * ------------------------------------------------------------------ */

export interface DropArea {
  readonly part: StoryPart;
  readonly box: Rect;
}

export interface StoryDrop {
  /** The day the bar's left edge lands on. Absent when the drop is on a fold's label, which sets the part only. */
  readonly day?: number;
  readonly part: StoryPart;
  readonly region: 'zone' | 'fold' | 'none';
  readonly laneId?: string;
}

export interface StoryDropInput {
  readonly frames: readonly DayFrame[];
  readonly ppd: number;
  /** The drawn width of the story strip, for the mirror. */
  readonly width: number;
  readonly direction: 'ltr' | 'rtl';
  readonly zones: readonly DropArea[];
  /** A fold, with the part it is named for. */
  readonly folds: readonly DropArea[];
  readonly lanes: readonly { readonly id: string; readonly box: Rect }[];
  /** The bar being dragged, in geometry coordinates; `undefined` for a scene dragged from the shelf. */
  readonly origin: Pick<Rect, 'x' | 'w'> | undefined;
  /** How far the pointer moved, in drawn coordinates. */
  readonly dx: number;
  /** The pointer in geometry coordinates. */
  readonly pointer: { readonly x: number; readonly y: number };
  /** The part the scene is in now. */
  readonly part: StoryPart;
}

const within = (box: Rect, x: number): boolean => x >= box.x && x < box.x + box.w;

/**
 * Where a dropped bar lands. The pointer chooses the region: over a fold's label the part alone, over a zone the day in that zone's own
 * runs, over neither (an empty story axis) the day in the runs there are. The bar keeps its grab point, so a small drag moves it by
 * the pixels dragged and never jumps to the pointer.
 */
export function storyDrop(input: StoryDropInput): StoryDrop {
  const { pointer } = input;
  const width = Math.max(1, input.zones.reduce((end, zone) => Math.max(end, zone.box.x + zone.box.w), 0));
  void width;
  const laneId = input.lanes.find((lane) => pointer.y >= lane.box.y && pointer.y < lane.box.y + lane.box.h)?.id;
  const lane = laneId === undefined ? {} : { laneId };
  const fold = input.folds.find((entry) => within(entry.box, pointer.x));
  if (fold !== undefined) return { part: fold.part, region: 'fold', ...lane };
  const zone = input.zones.find((entry) => within(entry.box, pointer.x)) ?? nearest(input.zones, pointer.x);
  const part = zone?.part ?? input.part;
  const gx = input.origin === undefined ? pointer.x : input.origin.x + input.dx;
  const w = input.origin?.w ?? 0;
  const left = unmirroredLeft({ x: gx, w }, input.width, input.direction);
  const day = dayAtX(input.frames, left, input.ppd, zone?.part);
  return { part, region: zone === undefined ? 'none' : 'zone', ...(day === undefined ? {} : { day }), ...lane };
}

function nearest(zones: readonly DropArea[], x: number): DropArea | undefined {
  let best: DropArea | undefined;
  let gap = Number.POSITIVE_INFINITY;
  for (const zone of zones) {
    const distance = x < zone.box.x ? zone.box.x - x : x > zone.box.x + zone.box.w ? x - (zone.box.x + zone.box.w) : 0;
    if (distance < gap) {
      gap = distance;
      best = zone;
    }
  }
  return best;
}

/** Whole days a bar moved by `dx` drawn pixels along the reading direction of the story axis: right is later in a left-to-right book, earlier in the other. */
export function daysDragged(dx: number, ppd: number, direction: 'ltr' | 'rtl'): number {
  const days = Math.round((direction === 'ltr' ? dx : -dx) / ppd);
  return days === 0 ? 0 : days;
}

/** The lane a vertical drag lands in becomes the scene's POV or mode (timeline.md §3.5); other groupings have no lane edit. */
export function laneIntent(model: TimelineModel, laneId: string, item: Pick<TimelineItem, 'mode' | 'pov'>): MetaIntent | undefined {
  const lane = model.lanes.find((candidate) => candidate.id === laneId);
  if (lane === undefined) return undefined;
  if (lane.key === 'pov') {
    const pov = lane.value ?? null;
    return pov === (item.pov === undefined || item.pov === '' ? null : item.pov) ? undefined : { pov };
  }
  if (lane.key === 'mode') {
    const mode = MODE_OF_LANE[lane.value ?? ''];
    if (mode === undefined || LANE_OF_MODE[item.mode] === lane.value) return undefined;
    return { mode };
  }
  return undefined;
}

const MODE_OF_LANE: Readonly<Record<string, string>> = { main: 'linear', parallel: 'parallel', frame: 'frame', dream: 'dream', backstory: 'backstory' };
const LANE_OF_MODE: Readonly<Record<string, string>> = {
  linear: 'main',
  flashback: 'main',
  'flash-forward': 'main',
  simultaneous: 'main',
  circular: 'main',
  'time-skip': 'main',
  parallel: 'parallel',
  frame: 'frame',
  dream: 'dream',
  mythic: 'dream',
  backstory: 'backstory',
};

/** The adjacent lane for Alt+Up and Alt+Down, in the order the lanes are drawn. `undefined` at the first or last lane. */
export function adjacentLane(model: TimelineModel, laneId: string, step: -1 | 1): string | undefined {
  const at = model.lanes.findIndex((lane) => lane.id === laneId);
  if (at === -1) return undefined;
  return model.lanes[at + step]?.id;
}

/* ------------------------------------------------------------------ *
 * Narrative drops
 * ------------------------------------------------------------------ */

export interface NarrativeDrop {
  readonly nodeId: string;
  readonly zone: 'before' | 'after';
}

/**
 * The scene a narrative drop lands beside and the side: the chip under the pointer (or the nearest in the lane), and "before" when the
 * pointer is on the half toward the reading start. In a book read right to left that half is the drawn right.
 */
export function narrativeDrop(
  chips: readonly { readonly nodeId: string; readonly box: Rect }[],
  pointer: { readonly x: number; readonly y: number },
  direction: 'ltr' | 'rtl',
): NarrativeDrop | undefined {
  let best: { nodeId: string; box: Rect } | undefined;
  let gap = Number.POSITIVE_INFINITY;
  for (const chip of chips) {
    const dy = pointer.y < chip.box.y ? chip.box.y - pointer.y : pointer.y > chip.box.y + chip.box.h ? pointer.y - (chip.box.y + chip.box.h) : 0;
    const dx = pointer.x < chip.box.x ? chip.box.x - pointer.x : pointer.x > chip.box.x + chip.box.w ? pointer.x - (chip.box.x + chip.box.w) : 0;
    const distance = dx + dy * 4;
    if (distance < gap) {
      gap = distance;
      best = chip;
    }
  }
  if (best === undefined) return undefined;
  const middle = best.box.x + best.box.w / 2;
  const early = direction === 'ltr' ? pointer.x < middle : pointer.x >= middle;
  return { nodeId: best.nodeId, zone: early ? 'before' : 'after' };
}

/** A move plan's place as a row's target: right after the sibling before `index`, with the moving scene left out. */
export function targetOfPlan(
  tree: readonly { readonly id: string; readonly parentId: string | null; readonly order: number }[],
  nodeId: string,
  plan: { readonly newParentId: string; readonly index: number },
): { parentId: string; anchorId: string | null } {
  const siblings = tree
    .filter((node) => node.parentId === plan.newParentId && node.id !== nodeId)
    .sort((a, b) => a.order - b.order)
    .map((node) => node.id);
  return { parentId: plan.newParentId, anchorId: plan.index <= 0 ? null : (siblings[Math.min(plan.index, siblings.length) - 1] ?? null) };
}

/**
 * The binder place a narrative gesture asks for, planned the way the binder plans its own drops and keyboard moves
 * (`planDrop`, `planKeyboardMove`) against the tree **as the rows before it leave it**, so a second nudge starts where the first left off.
 * `same-place` is the scene already being there; `refused` is a drop the binder's own rules do not allow.
 */
export function planNarrativeMove(
  state: ProjectState,
  rows: readonly Row[],
  nodeId: string,
  how: { readonly drop: NarrativeDrop } | { readonly step: 'up' | 'down' },
): MoveTarget | 'same-place' | 'refused' {
  const tree = treeWithMoves(state, rows);
  const planned: ProjectState = { ...state, manifest: { ...state.manifest, tree } };
  const plan = 'drop' in how ? planDrop(planned, nodeId, { nodeId: how.drop.nodeId, zone: how.drop.zone }) : planKeyboardMove(planned, nodeId, how.step);
  if (!plan.ok) return plan.reason === 'same-place' ? 'same-place' : 'refused';
  return targetOfPlan(tree, nodeId, plan);
}

/* ------------------------------------------------------------------ *
 * The keyboard's alternatives
 * ------------------------------------------------------------------ */

export type AltChord =
  | { readonly kind: 'day'; readonly delta: number }
  | { readonly kind: 'duration'; readonly delta: number }
  | { readonly kind: 'lane'; readonly step: -1 | 1 }
  | { readonly kind: 'narrative'; readonly step: 'up' | 'down' }
  | { readonly kind: 'place' };

export interface ChordFacts {
  readonly key: string;
  readonly code: string;
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly altGraph: boolean;
}

/**
 * Alt+arrow and its relatives on a focused scene (timeline.md §4.2). On the story and braid axes Alt+Left and Alt+Right change the day by
 * one, Alt+Shift by seven, **toward the interface's start for the earlier day** (in a right-to-left interface the right arrow is earlier);
 * on the narrative axis the same keys move the scene one place in the binder. Alt+Up and Alt+Down change lane, Alt+[ and Alt+] shorten
 * and lengthen by a day, and Alt+R asks for a relative placement. AltGraph types a character and is never a chord.
 */
export function altChordOf(facts: ChordFacts, axis: 'story' | 'narrative' | 'braid', rtlUi: boolean): AltChord | null {
  if (facts.altGraph || facts.ctrl || facts.meta) return null;
  if (facts.code === 'BracketLeft') return { kind: 'duration', delta: facts.shift ? -7 : -1 };
  if (facts.code === 'BracketRight') return { kind: 'duration', delta: facts.shift ? 7 : 1 };
  if (facts.code === 'KeyR' && !facts.shift) return { kind: 'place' };
  const move = moveOfKey(facts.key, false, rtlUi);
  if (move === 'lane-up') return { kind: 'lane', step: -1 };
  if (move === 'lane-down') return { kind: 'lane', step: 1 };
  if (move !== 'earlier' && move !== 'later') return null;
  if (axis === 'narrative') return facts.shift ? null : { kind: 'narrative', step: move === 'earlier' ? 'up' : 'down' };
  const size = facts.shift ? 7 : 1;
  return { kind: 'day', delta: move === 'earlier' ? -size : size };
}

/* ------------------------------------------------------------------ *
 * Ghosts
 * ------------------------------------------------------------------ */

export interface GhostContext {
  readonly model: TimelineModel;
  readonly frames: readonly DayFrame[];
  readonly width: number;
  readonly direction: 'ltr' | 'rtl';
  readonly ox: number;
  /** The canvas box of each drawn item. */
  readonly boxOf: (key: string) => Rect | undefined;
  /** The canvas box of the lane's top, to place a ghost in a lane the row moved it to. */
  readonly laneTop: (laneId: string) => number | undefined;
  readonly rowPx: number;
}

/** The lane a scene's POV or mode change puts it in, under the grouping drawn. */
function targetLane(ctx: GhostContext, item: TimelineItem, row: MetaRow): string | undefined {
  const key = ctx.model.options.groupBy;
  if (key === 'pov' && row.pov !== undefined) {
    const noneLane = ctx.model.lanes.find((lane) => lane.key === 'pov' && lane.value === undefined);
    return ctx.model.lanes.find((lane) => lane.key === 'pov' && (lane.value ?? null) === row.pov?.to)?.id ?? (row.pov.to === null ? noneLane?.id : undefined);
  }
  if (key === 'mode' && row.mode !== undefined) {
    const group = LANE_OF_MODE[row.mode.to ?? 'linear'];
    return ctx.model.lanes.find((lane) => lane.key === 'mode' && lane.value === group)?.id;
  }
  void item;
  return undefined;
}

/** Where a row would put a scene's bar, in canvas coordinates; `undefined` when it has no place on the story axis (it goes to the shelf, or has no day). */
export function ghostOfScene(ctx: GhostContext, item: TimelineItem, change: { day?: number | null; duration?: number | null; part?: DeclaredStoryPart | null }, row?: MetaRow): Rect | undefined {
  const origin = ctx.boxOf(item.key);
  if (origin === undefined && item.start === undefined && change.day === undefined) return undefined;
  const day = change.day !== undefined ? change.day : (item.dayOffset ?? null);
  if (day === null) return undefined;
  const duration = change.duration !== undefined ? (change.duration ?? 0) : (item.durationDays ?? 0);
  const part = change.part !== undefined && change.part !== null ? change.part : item.part;
  const ppd = ctx.model.axis.pxPerDay;
  const left = xOfDay(ctx.frames, part, day, ppd);
  if (left === undefined) return undefined;
  const w = Math.max(duration, 1) * ppd;
  const laneId = row === undefined ? undefined : targetLane(ctx, item, row);
  const top = laneId === undefined ? undefined : ctx.laneTop(laneId);
  const y = top !== undefined ? top + item.row * ctx.rowPx : (origin?.y ?? 0);
  return { x: ctx.ox + mirroredX(left, w, ctx.width, ctx.direction), y, w, h: origin?.h ?? ctx.rowPx };
}

/** The marker of a narrative move: a thin box just after the scene the row places it behind. */
export function ghostOfMove(ctx: GhostContext, row: MoveRow, items: readonly TimelineItem[]): Rect | undefined {
  const anchor = row.to.anchorId === null ? undefined : items.find((item) => item.nodeId === row.to.anchorId);
  const first = items.find((item) => ctx.boxOf(item.key) !== undefined);
  const box = anchor === undefined ? undefined : ctx.boxOf(anchor.key);
  if (box !== undefined) return { x: ctx.direction === 'ltr' ? box.x + box.w - 2 : box.x - 2, y: box.y, w: 4, h: box.h };
  const start = first === undefined ? undefined : ctx.boxOf(first.key);
  if (start === undefined || row.to.anchorId !== null) return undefined;
  return { x: ctx.direction === 'ltr' ? start.x - 2 : start.x + start.w - 2, y: start.y, w: 4, h: start.h };
}

export function ghostOfShift(ctx: GhostContext, row: ShiftRow, item: TimelineItem): Rect | undefined {
  const base = row.baseDays[item.nodeId];
  if (base === undefined) return undefined;
  return ghostOfScene(ctx, item, { day: base + row.delta });
}

/* ------------------------------------------------------------------ *
 * Text the forms read
 * ------------------------------------------------------------------ */

/** A whole number of days from what a person types: the minus sign may be the real one, and thousands separators are ignored. */
export function parseDayText(text: string): number | null {
  const cleaned = text.trim().replace(/[\u2212\u2012\u2013]/gu, '-').replace(/[\s,\u00a0\u202f]/gu, '');
  if (!/^[+-]?\d+$/u.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isSafeInteger(value) ? value + 0 : null;
}
