/**
 * The timeline view's own model ([timeline.md §3, §4.6, §6, §7](docs/architecture/timeline.md)): what the view remembers, how a
 * zoom maps to a level, which boxes are drawn for a scroll position, the grid the keyboard walks, and the findings drawn on it.
 * Pure functions over `@caotang/timeline`'s `TimelineModel` and its projection, so the rules are testable without a page. No
 * React and no message library: every word is supplied by the caller.
 */

import type { FindingSeverity } from '@caotang/coherence';
import {
  PART_ORDER,
  defaultAxisFor,
  type AggregateBlock,
  type AxisFold,
  type Box,
  type FindingRef,
  type LaneKey,
  type StoryPart,
  type TimelineAxis,
  type TimelineGeometry,
  type TimelineItem,
  type TimelineModel,
  type Zoom,
} from '@caotang/timeline';

/* ------------------------------------------------------------------ *
 * View state: remembered per project, in memory, never a command
 * ------------------------------------------------------------------ */

export interface TimelineOverlays {
  /** `after` arrows; a violated one is drawn as an error. */
  readonly after: boolean;
  readonly thread: boolean;
  /** Pair connectors and gap bands of open findings. */
  readonly findings: boolean;
  /** The subway overlay: one polyline per character lane. */
  readonly presence: boolean;
}

export interface TimelineViewState {
  readonly axis: TimelineAxis;
  readonly groupBy: LaneKey;
  readonly zoom: Zoom;
  /** A folder id: only the scenes under it. `null` is the whole manuscript. */
  readonly scope: string | null;
  readonly compressGaps: boolean;
  readonly overlays: TimelineOverlays;
  /** The timeline marks and scrolls to the scene the editor has open (§4.6). */
  readonly followEditor: boolean;
  /** `true` or `false` once the writer has chosen; `null` leaves it to forced colours and reduced motion. */
  readonly agenda: boolean | null;
}

export const STORY_ZOOMS: readonly Zoom[] = ['day', 'week', 'month', 'fit'];
export const NARRATIVE_ZOOMS: readonly Zoom[] = ['scene', 'chapter', 'act'];

export function zoomsOf(axis: TimelineAxis): readonly Zoom[] {
  return axis === 'narrative' ? NARRATIVE_ZOOMS : STORY_ZOOMS;
}

/** What a zoom shows as blocks (timeline.md §3.1): Day and Week keep scenes, Month and Chapter are chapters, Fit and Act are acts. */
export type ZoomLevel = 'scene' | 'chapter' | 'act';

export function levelOfZoom(zoom: Zoom): ZoomLevel {
  switch (zoom) {
    case 'day':
    case 'week':
    case 'scene':
      return 'scene';
    case 'month':
    case 'chapter':
      return 'chapter';
    case 'fit':
    case 'act':
      return 'act';
  }
}

/** The zoom an axis uses to show the same level, so a switch between axes keeps what the writer was looking at. */
export function zoomForAxis(axis: TimelineAxis, zoom: Zoom): Zoom {
  if (zoomsOf(axis).includes(zoom)) return zoom;
  const level = levelOfZoom(zoom);
  if (axis === 'narrative') return level;
  return level === 'scene' ? 'day' : level === 'chapter' ? 'month' : 'fit';
}

export function defaultZoom(axis: TimelineAxis): Zoom {
  return axis === 'narrative' ? 'scene' : 'day';
}

/** One step in or out through the axis's zooms, clamped at the ends. */
export function stepZoom(axis: TimelineAxis, zoom: Zoom, direction: 'in' | 'out'): Zoom {
  const zooms = zoomsOf(axis);
  const at = zooms.indexOf(zoom);
  if (at === -1) return defaultZoom(axis);
  const next = direction === 'in' ? at - 1 : at + 1;
  return zooms[Math.min(zooms.length - 1, Math.max(0, next))] ?? zoom;
}

/** §3.3: the story axis when at least half the scenes have a day, the narrative axis otherwise, decided once per project. */
export function initialViewState(share: number): TimelineViewState {
  const axis = defaultAxisFor({ share });
  return {
    axis,
    groupBy: 'none',
    zoom: defaultZoom(axis),
    scope: null,
    compressGaps: true,
    overlays: { after: true, thread: false, findings: true, presence: false },
    followEditor: true,
    agenda: null,
  };
}

const remembered = new Map<string, TimelineViewState>();

export function rememberedViewState(projectId: string): TimelineViewState | undefined {
  return remembered.get(projectId);
}

export function rememberViewState(projectId: string, state: TimelineViewState): void {
  remembered.set(projectId, state);
}

/** Switching axis keeps the zoom's level, drops a group-by the axis cannot show, and keeps scope and overlays. */
export function withAxis(state: TimelineViewState, axis: TimelineAxis): TimelineViewState {
  return { ...state, axis, zoom: zoomForAxis(axis, state.zoom) };
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

export const ROW_PX = 30;
export const HEADER_PX = 28;
export const GUTTER_PX = 148;

const NARRATIVE_SLOT_PX: Readonly<Record<string, number>> = { scene: 120, chapter: 8, act: 1.5 };

export function slotPxOf(zoom: Zoom, pxPerDay: number): number {
  return NARRATIVE_SLOT_PX[zoom] ?? Math.max(1, pxPerDay);
}

/** The options `projectTimeline` takes for a zoom. */
export function projectionOptionsOf(model: TimelineModel): { slotPx: number; rowPx: number } {
  return { slotPx: slotPxOf(model.options.zoom, model.axis.pxPerDay), rowPx: ROW_PX };
}

/** Where x starts: the gutter sits on the reading-start side, which is the left for a left-to-right book and the right for the other. */
export function originX(direction: 'ltr' | 'rtl'): number {
  return direction === 'ltr' ? GUTTER_PX : 0;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** The scroll position and size of the scroller, in canvas pixels. */
export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * The area to draw for a viewport: grown by a margin on every side and snapped outward to multiples of `step`, so a scroll of
 * a few pixels is the same window and does not draw anything again.
 */
export function drawWindow(viewport: Viewport, step = 320, overscan = 480): Rect {
  const x0 = Math.floor((viewport.x - overscan) / step) * step;
  const y0 = Math.floor((viewport.y - overscan) / step) * step;
  const x1 = Math.ceil((viewport.x + viewport.w + overscan) / step) * step;
  const y1 = Math.ceil((viewport.y + viewport.h + overscan) / step) * step;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The DOM budget (timeline.md §7: at most 1,500 live nodes). A chip is a cell, a glyph, a label and a badge: about four elements and
 * two text runs, so the chip budget leaves room for the rows, ticks, breaks, folds, bands and connectors beside it.
 */
export const DOM_BUDGET = 1500;
export const MAX_CHIPS = 180;
export const MAX_TICKS = 70;
export const MAX_BANDS = 60;
export const MAX_CONNECTORS = 50;
export const MAX_ROWS = 60;

export interface Placed {
  readonly key: string;
  readonly box: Rect;
}

/**
 * The keys to draw: the ones that meet the window, plus the pinned ones (the focused chip must stay in the DOM wherever it is
 * scrolled). Over the budget, the ones nearest the window's centre are kept, so a dense window shows its middle and never the
 * whole 2,000.
 */
export function visibleKeys(entries: readonly Placed[], window: Rect, budget: number, pinned: ReadonlySet<string> = new Set()): string[] {
  const inside: Placed[] = [];
  const keep: string[] = [];
  for (const entry of entries) {
    if (pinned.has(entry.key)) keep.push(entry.key);
    else if (intersects(entry.box, window)) inside.push(entry);
  }
  const room = Math.max(0, budget - keep.length);
  if (inside.length > room) {
    const cx = window.x + window.w / 2;
    const cy = window.y + window.h / 2;
    const distance = (box: Rect): number => Math.abs(box.x + box.w / 2 - cx) + Math.abs(box.y + box.h / 2 - cy) * 4;
    inside.sort((a, b) => distance(a.box) - distance(b.box) || (a.key < b.key ? -1 : 1));
    inside.length = room;
  }
  for (const entry of inside) keep.push(entry.key);
  return keep;
}

/** The lanes to draw: the ones that meet the window, plus the pinned one. */
export function visibleLanes<T extends { readonly id: string; readonly box: Rect }>(lanes: readonly T[], window: Rect, pinned: string | undefined, budget = MAX_ROWS): T[] {
  const chosen = lanes.filter((lane) => lane.id === pinned || (lane.box.y < window.y + window.h && lane.box.y + lane.box.h > window.y));
  return chosen.length > budget ? chosen.slice(0, budget) : chosen;
}

/** The scroll offset that brings `box` fully into view with a margin, or `undefined` when it already is. */
export function scrollToReveal(box: Rect, viewport: Viewport, margin: { readonly x: number; readonly y: number } = { x: 24, y: 24 }): { x?: number; y?: number } | undefined {
  const out: { x?: number; y?: number } = {};
  if (box.x < viewport.x + margin.x) out.x = Math.max(0, box.x - margin.x);
  else if (box.x + box.w > viewport.x + viewport.w - margin.x) out.x = Math.max(0, box.x + Math.min(box.w, viewport.w - 2 * margin.x) - viewport.w + margin.x);
  if (box.y < viewport.y + margin.y) out.y = Math.max(0, box.y - margin.y);
  else if (box.y + box.h > viewport.y + viewport.h - margin.y) out.y = Math.max(0, box.y + box.h - viewport.h + margin.y);
  return out.x === undefined && out.y === undefined ? undefined : out;
}

/** The part of the box that is on screen, as a share of the box: how far "off-screen" a scene is. */
export function isOffscreen(box: Rect, viewport: Viewport): boolean {
  return !intersects(box, viewport);
}

/** Where the scene the writer was looking at sat in the viewport, so a change of axis or zoom can put it back. */
export interface ScrollAnchor {
  readonly nodeId: string;
  readonly offsetX: number;
  readonly offsetY: number;
}

export function anchorOf(nodeId: string, box: Rect, viewport: Viewport): ScrollAnchor {
  return { nodeId, offsetX: box.x - viewport.x, offsetY: box.y - viewport.y };
}

export function scrollForAnchor(anchor: ScrollAnchor, box: Rect): { x: number; y: number } {
  return { x: Math.max(0, box.x - anchor.offsetX), y: Math.max(0, box.y - anchor.offsetY) };
}

/** A curve between two boxes, leaving the edge that faces the other: left to right, or right to left once the book is mirrored. */
export function curveBetween(from: Rect, to: Rect): { d: string; mid: { x: number; y: number } } {
  const forward = from.x + from.w / 2 <= to.x + to.w / 2;
  const x1 = forward ? from.x + from.w : from.x;
  const x2 = forward ? to.x : to.x + to.w;
  const y1 = from.y + from.h / 2;
  const y2 = to.y + to.h / 2;
  const dx = (x2 - x1) / 2;
  return { d: pathOf(['M', x1, y1], ['C', x1 + dx, y1, x2 - dx, y2, x2, y2]), mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 } };
}

type PathCommand = readonly [letter: string, ...numbers: number[]];

/** An SVG path from its commands, so no path string is written out as a template. */
export function pathOf(...commands: readonly PathCommand[]): string {
  return commands.map(([letter, ...numbers]) => letter.concat(numbers.join(' '))).join('');
}

/** CSS class names joined, skipping the ones that are off. */
export function classes(...names: readonly (string | false | undefined)[]): string {
  return names.filter((name): name is string => typeof name === 'string' && name !== '').join(' ');
}

/** A media query for one feature, as `matchMedia` takes it. */
export function mediaQuery(...features: readonly (readonly [feature: string, value: string])[]): string {
  return features.map(([feature, value]) => '('.concat(feature, ': ', value, ')')).join(', ');
}

/** The inline style of a box laid out in the canvas: a translation, then the logical size. */
export function boxStyle(x: number, y: number, inlineSize: number, blockSize: number): { transform: string; inlineSize: number; blockSize: number } {
  const px = (value: number): string => `${value}px`;
  return { transform: ['translate(', px(x), ', ', px(y), ')'].join(''), inlineSize, blockSize };
}
/* ------------------------------------------------------------------ *
 * Blocks: what chapter and act zoom draw instead of scenes
 * ------------------------------------------------------------------ */

export interface BlockBox {
  readonly block: AggregateBlock;
  readonly box: Box;
}

/**
 * One box per chapter or act block: the union of the boxes of its scenes, packed into rows so overlapping blocks stack. A block
 * none of whose scenes has a place on the axis (all undated on the story axis) has no box and is left to the shelf.
 */
export function blockBoxes(model: TimelineModel, geometry: TimelineGeometry, rowPx: number = ROW_PX): { blocks: BlockBox[]; rows: number; top: number } {
  const top = geometry.lanes[0]?.box.y ?? 0;
  const byReading = new Map<number, Box>();
  const partOf = new Map<number, StoryPart>();
  const boxOf = new Map<string, Box>();
  for (const placed of geometry.items) boxOf.set(placed.key, placed.box);
  for (const item of model.items) {
    const box = boxOf.get(item.key);
    if (box === undefined || byReading.has(item.readingIndex)) continue;
    byReading.set(item.readingIndex, box);
    partOf.set(item.readingIndex, item.part);
  }
  const found: { block: AggregateBlock; x: number; w: number }[] = [];
  for (const block of model.blocks) {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let at = block.firstReading; at <= block.lastReading; at += 1) {
      if (partOf.get(at) !== block.part) continue;
      const box = byReading.get(at) as Box;
      if (box.x < lo) lo = box.x;
      if (box.x + box.w > hi) hi = box.x + box.w;
    }
    if (hi >= lo) found.push({ block, x: lo, w: Math.max(hi - lo, 2) });
  }
  found.sort((a, b) => a.x - b.x || a.w - b.w);
  const ends: number[] = [];
  const blocks: BlockBox[] = [];
  for (const entry of found) {
    let row = ends.findIndex((end) => end <= entry.x);
    if (row === -1) row = ends.length;
    ends[row] = entry.x + entry.w + 2;
    blocks.push({ block: entry.block, box: { x: entry.x, y: top + row * rowPx, w: entry.w, h: rowPx } });
  }
  return { blocks, rows: Math.max(1, ends.length), top };
}

/* ------------------------------------------------------------------ *
 * The grid the keyboard walks (timeline.md §6)
 * ------------------------------------------------------------------ */

export interface GridRow {
  readonly id: string;
  readonly label: string;
  /** Cell keys in logical order: part, then day, then reading index; reading order on the narrative axis. */
  readonly keys: readonly string[];
}

export interface Grid {
  readonly rows: readonly GridRow[];
  /** Position of a key in the grid, for moving by lane and for the roving tabindex. */
  readonly where: ReadonlyMap<string, { readonly row: number; readonly col: number }>;
  /** A key's place in the logical order, to land on the nearest cell when changing lane. */
  readonly at: ReadonlyMap<string, number>;
}

/** The grid of a model: the placed chips by lane, or the blocks of a chapter or act zoom in one row. */
export function gridOf(model: TimelineModel, blocks: readonly BlockBox[] | undefined, allLabel: string): Grid {
  const rows: GridRow[] = [];
  const where = new Map<string, { row: number; col: number }>();
  const at = new Map<string, number>();
  if (blocks !== undefined) {
    const ordered = [...blocks].sort((a, b) => a.block.firstReading - b.block.firstReading || (a.block.part < b.block.part ? -1 : 1));
    rows.push({ id: 'blocks', label: allLabel, keys: ordered.map((entry) => entry.block.id) });
    ordered.forEach((entry, i) => at.set(entry.block.id, i));
  } else {
    const narrative = model.axis.kind === 'narrative';
    const byLane = new Map<string, TimelineItem[]>();
    model.items.forEach((item, i) => {
      if (!narrative && item.start === undefined) return;
      at.set(item.key, narrative ? item.readingIndex : i);
      const list = byLane.get(item.lane);
      if (list === undefined) byLane.set(item.lane, [item]);
      else list.push(item);
    });
    for (const lane of model.lanes) {
      const items = byLane.get(lane.id);
      if (items === undefined) continue;
      const sorted = narrative ? [...items].sort((a, b) => a.readingIndex - b.readingIndex) : items;
      rows.push({ id: lane.id, label: lane.label, keys: sorted.map((item) => item.key) });
    }
  }
  rows.forEach((row, r) => row.keys.forEach((key, c) => where.set(key, { row: r, col: c })));
  return { rows, where, at };
}

export type FocusMove = 'earlier' | 'later' | 'lane-up' | 'lane-down' | 'first' | 'last' | 'grid-first' | 'grid-last';

/**
 * The key a keyboard key asks for, in the interface's direction (timeline.md §3.2, §6): the arrow that points toward the
 * interface's start goes to the earlier cell, whichever way the book is read. Up and Down change lane.
 */
export function moveOfKey(key: string, ctrl: boolean, rtlUi: boolean): FocusMove | null {
  switch (key) {
    case 'ArrowLeft':
      return rtlUi ? 'later' : 'earlier';
    case 'ArrowRight':
      return rtlUi ? 'earlier' : 'later';
    case 'ArrowUp':
      return 'lane-up';
    case 'ArrowDown':
      return 'lane-down';
    case 'Home':
      return ctrl ? 'grid-first' : 'first';
    case 'End':
      return ctrl ? 'grid-last' : 'last';
    default:
      return null;
  }
}

/** The cell a move lands on from `from`, or `undefined` when the grid is empty. A move past an end stays where it is. */
export function moveFocus(grid: Grid, from: string | undefined, move: FocusMove): string | undefined {
  const first = grid.rows.find((row) => row.keys.length > 0);
  if (first === undefined) return undefined;
  const place = from === undefined ? undefined : grid.where.get(from);
  if (place === undefined) return first.keys[0];
  const row = grid.rows[place.row] as GridRow;
  switch (move) {
    case 'earlier':
      return row.keys[Math.max(0, place.col - 1)];
    case 'later':
      return row.keys[Math.min(row.keys.length - 1, place.col + 1)];
    case 'first':
      return row.keys[0];
    case 'last':
      return row.keys[row.keys.length - 1];
    case 'grid-first':
      return first.keys[0];
    case 'grid-last': {
      const last = [...grid.rows].reverse().find((candidate) => candidate.keys.length > 0) as GridRow;
      return last.keys[last.keys.length - 1];
    }
    case 'lane-up':
    case 'lane-down': {
      const step = move === 'lane-up' ? -1 : 1;
      let r = place.row + step;
      while (r >= 0 && r < grid.rows.length && (grid.rows[r] as GridRow).keys.length === 0) r += step;
      const target = grid.rows[r];
      if (target === undefined) return from;
      const here = grid.at.get(from as string) ?? 0;
      let best = target.keys[0] as string;
      let gap = Number.POSITIVE_INFINITY;
      for (const key of target.keys) {
        const d = Math.abs((grid.at.get(key) ?? 0) - here);
        if (d < gap) {
          gap = d;
          best = key;
        }
      }
      return best;
    }
  }
}

const PART_RANK: Readonly<Record<StoryPart, number>> = { prologue: 0, main: 1, epilogue: 2 };

/**
 * The folds a move crosses from one scene to another, in the order they are crossed. A fold lies between two parts, so moving
 * between scenes of the same part crosses none; the narrative axis has no folds and announces none.
 */
export function foldsBetween(model: TimelineModel, from: TimelineItem | undefined, to: TimelineItem | undefined): AxisFold[] {
  if (from === undefined || to === undefined || from.part === to.part) return [];
  const low = Math.min(PART_RANK[from.part], PART_RANK[to.part]);
  const high = Math.max(PART_RANK[from.part], PART_RANK[to.part]);
  const crossed = model.axis.folds.filter((fold) => PART_RANK[fold.fromPart] >= low && PART_RANK[fold.toPart] <= high);
  return PART_RANK[from.part] <= PART_RANK[to.part] ? crossed : [...crossed].reverse();
}

/* ------------------------------------------------------------------ *
 * Findings on the timeline (timeline.md §5.2)
 * ------------------------------------------------------------------ */

const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = { error: 0, warning: 1, info: 2 };

/** The glyph a severity wears beside its count, so no severity is told by colour alone. */
export const SEVERITY_GLYPH: Readonly<Record<FindingSeverity, string>> = { error: '\u2715', warning: '\u25b2', info: '\u25cf' };

export interface Badge {
  readonly count: number;
  readonly severity: FindingSeverity;
  readonly groups: readonly string[];
}

/** The count and the worst severity of the open findings on one scene, with the fact groups they belong to. */
export function badgeOf(findings: readonly FindingRef[]): Badge | undefined {
  if (findings.length === 0) return undefined;
  let severity: FindingSeverity = 'info';
  const groups: string[] = [];
  for (const finding of findings) {
    if (SEVERITY_RANK[finding.severity] < SEVERITY_RANK[severity]) severity = finding.severity;
    if (!groups.includes(finding.groupKey)) groups.push(finding.groupKey);
  }
  return { count: findings.length, severity, groups };
}

export const PAIR_GLYPH: Readonly<Record<string, string>> = {
  'timeline.order-drift': '\u21c5',
  'timeline.overlap': '\u29c9',
  'timeline.relation': '\u21e5',
  'timeline.gap': '\u2194',
};

export interface PairOverlay {
  readonly id: string;
  readonly findingId: string;
  readonly checkId: string;
  readonly severity: FindingSeverity;
  readonly kind: 'connector' | 'gap-band';
  readonly fromKey: string;
  readonly toKey: string;
  readonly fromNode: string;
  readonly toNode: string;
  /** A connector's end points, or a gap band's rectangle. */
  readonly from: Box;
  readonly to: Box;
  readonly band?: Box;
}

/**
 * The open pair findings drawn on the timeline: a connector between the two scenes, and for a gap a band across the empty days
 * between them. A gap between scenes of different parts has no band and no connector: the check skips pairs across a fold, and a
 * stale one would otherwise draw a line over the fold (timeline.md §2.4, §5.2).
 */
export function pairOverlays(model: TimelineModel, boxes: ReadonlyMap<string, Box>): PairOverlay[] {
  const byKey = new Map<string, TimelineItem>();
  for (const item of model.items) byKey.set(item.key, item);
  const out: PairOverlay[] = [];
  for (const connector of model.connectors) {
    if (connector.kind !== 'finding' || connector.findingId === undefined || connector.checkId === undefined || connector.severity === undefined) continue;
    const a = byKey.get(connector.from);
    const b = byKey.get(connector.to);
    const from = boxes.get(connector.from);
    const to = boxes.get(connector.to);
    if (a === undefined || b === undefined || from === undefined || to === undefined) continue;
    const base = {
      id: connector.id,
      findingId: connector.findingId,
      checkId: connector.checkId,
      severity: connector.severity,
      fromKey: connector.from,
      toKey: connector.to,
      fromNode: connector.fromNode,
      toNode: connector.toNode,
      from,
      to,
    };
    if (connector.checkId === 'timeline.gap') {
      if (a.part !== b.part || model.axis.kind === 'narrative') continue;
      const left = from.x <= to.x ? from : to;
      const right = left === from ? to : from;
      const width = right.x - (left.x + left.w);
      if (width <= 0) continue;
      out.push({ ...base, kind: 'gap-band', band: { x: left.x + left.w, y: Math.min(from.y, to.y), w: width, h: Math.max(from.h, to.h) } });
    } else {
      out.push({ ...base, kind: 'connector' });
    }
  }
  return out;
}

/** The fact group a pair finding opens in the Findings panel, found from the finding id. */
export function groupOfFinding(model: TimelineModel, findingId: string): string | undefined {
  for (const item of model.items) {
    for (const finding of item.findings) if (finding.id === findingId) return finding.groupKey;
  }
  return undefined;
}

/**
 * Where "Show on timeline" goes: the first of the finding's documents that the timeline holds, as an item key, with a placed
 * one before an undated one. `undefined` when none is on the timeline (an archived scene, a research note, a scope that
 * leaves it out), which the caller says in words and answers by widening the scope.
 */
export function targetForDocs(model: TimelineModel, docIds: readonly string[]): TimelineItem | undefined {
  for (const id of docIds) {
    const placed = model.items.find((item) => item.nodeId === id && (item.start !== undefined || model.axis.kind === 'narrative'));
    if (placed !== undefined) return placed;
  }
  for (const id of docIds) {
    const any = model.items.find((item) => item.nodeId === id);
    if (any !== undefined) return any;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * The Agenda: the same items as a table (timeline.md §6)
 * ------------------------------------------------------------------ */

export type AgendaColumn = 'title' | 'day' | 'end' | 'duration' | 'reading' | 'mode' | 'pov' | 'findings';

export interface AgendaSort {
  readonly column: AgendaColumn;
  readonly direction: 'ascending' | 'descending';
}

export interface AgendaRow {
  readonly item: TimelineItem;
  readonly day: number | undefined;
  readonly end: number | undefined;
}

export interface AgendaGroup {
  readonly part: StoryPart;
  readonly rows: readonly AgendaRow[];
}

/**
 * One row per scene, grouped under Prologue, Main story and Epilogue in that order whichever way the book is read: the data is
 * logical. Dated scenes come first in each part, undated ones after; a column sort reorders inside a part.
 */
export function agendaOf(model: TimelineModel, sort: AgendaSort | undefined, povName: (id: string) => string): AgendaGroup[] {
  const seen = new Set<string>();
  const groups = new Map<StoryPart, AgendaRow[]>();
  for (const item of model.items) {
    if (seen.has(item.nodeId)) continue;
    seen.add(item.nodeId);
    const row: AgendaRow = { item, day: item.start, end: item.durationDays !== undefined && item.start !== undefined ? item.start + item.durationDays : item.start };
    const list = groups.get(item.part);
    if (list === undefined) groups.set(item.part, [row]);
    else list.push(row);
  }
  const compare = (a: AgendaRow, b: AgendaRow): number => {
    if (sort === undefined) return 0;
    const sign = sort.direction === 'ascending' ? 1 : -1;
    const number = (x: number | undefined, y: number | undefined): number => (x === undefined ? 1 : y === undefined ? -1 : (x - y) * sign);
    switch (sort.column) {
      case 'title':
        return a.item.title.localeCompare(b.item.title) * sign;
      case 'day':
        return number(a.day, b.day);
      case 'end':
        return number(a.end, b.end);
      case 'duration':
        return number(a.item.durationDays, b.item.durationDays);
      case 'reading':
        return (a.item.readingIndex - b.item.readingIndex) * sign;
      case 'mode':
        return a.item.mode.localeCompare(b.item.mode) * sign;
      case 'pov':
        return povName(a.item.pov ?? '').localeCompare(povName(b.item.pov ?? '')) * sign;
      case 'findings':
        return (a.item.findings.length - b.item.findings.length) * sign;
    }
  };
  return PART_ORDER.filter((part) => groups.has(part)).map((part) => {
    const rows = groups.get(part) as AgendaRow[];
    return { part, rows: sort === undefined ? rows : [...rows].sort((a, b) => compare(a, b) || a.item.readingIndex - b.item.readingIndex) };
  });
}

/* ------------------------------------------------------------------ *
 * Scope, the shelf and the request from the Findings tab
 * ------------------------------------------------------------------ */

export interface ScopeOption {
  readonly id: string;
  readonly title: string;
  readonly depth: number;
}

/** The folders of the manuscript, depth first in binder order, for the scope choice. Documents and the research tree are not scopes. */
export function scopeOptions(tree: readonly { readonly id: string; readonly parentId: string | null; readonly type: string; readonly title: string; readonly order: number }[]): ScopeOption[] {
  const children = new Map<string, typeof tree[number][]>();
  for (const node of tree) {
    if (node.parentId === null) continue;
    const list = children.get(node.parentId);
    if (list === undefined) children.set(node.parentId, [node]);
    else list.push(node);
  }
  const out: ScopeOption[] = [];
  const walk = (parentId: string, depth: number): void => {
    const list = [...(children.get(parentId) ?? [])].sort((a, b) => a.order - b.order);
    for (const node of list) {
      if (node.type !== 'folder') continue;
      out.push({ id: node.id, title: node.title, depth });
      walk(node.id, depth + 1);
    }
  };
  walk('manuscript', 0);
  return out;
}

/** The documents a finding cites, as "Show on timeline" asks for them. `serial` makes a second request for the same finding a new one. */
export interface TimelineFocusRequest {
  readonly docIds: readonly string[];
  readonly findingId: string;
  readonly serial: number;
}

/** The shelf lists at most this many scenes before it offers the rest in the Agenda, to keep the page inside the DOM budget. */
export const SHELF_LIMIT = 60;

/* ------------------------------------------------------------------ *
 * Remaining small rules
 * ------------------------------------------------------------------ */

/** Whether the story axis is drawn as an empty call to action: no scene has a day. */
export function storyAxisIsEmpty(model: TimelineModel): boolean {
  return model.axis.kind !== 'narrative' && model.stats.scheduled === 0;
}

/** The direction both axes run, from the project language alone (timeline.md §3.2, D9). */
export function axisDirection(model: TimelineModel): 'ltr' | 'rtl' {
  return model.direction;
}
