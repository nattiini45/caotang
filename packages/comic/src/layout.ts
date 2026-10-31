/**
 * Page layout and balloon geometry as data — comics.md §2 and §4. The page editor's SVG, the comic PDF and the CBZ
 * rasterizer all draw from these numbers, so a balloon looks the same on screen and in print.
 *
 * Coordinates are 0..1 of the page's *live area* (the trim minus a safety margin). The live area is not square, so
 * anything with a round shape takes an `aspect` (live width over live height) and returns its circles as `rx`/`ry`.
 */

import { drawnKind, type Balloon, type BalloonKind, type Panel, type PageSize, type Point, type ReadingDirection, type Rect } from './model.js';

const MM_PER_INCH = 25.4;

export interface PageGeometry {
  trimWidthMm: number;
  trimHeightMm: number;
  /** 3 mm on the metric presets, 0.125 in on the inch presets. */
  bleedMm: number;
  /** Safety margin from the trim edge to the live area. */
  liveMarginMm: number;
  liveWidthMm: number;
  liveHeightMm: number;
  /** Live width over live height. */
  aspect: number;
}

const PRESETS: Record<PageSize, { w: number; h: number; bleed: number; margin: number }> = {
  'us-comic': { w: 6.625 * MM_PER_INCH, h: 10.25 * MM_PER_INCH, bleed: 0.125 * MM_PER_INCH, margin: 0.3125 * MM_PER_INCH },
  'manga-b5': { w: 182, h: 257, bleed: 3, margin: 10 },
  a4: { w: 210, h: 297, bleed: 3, margin: 10 },
  letter: { w: 8.5 * MM_PER_INCH, h: 11 * MM_PER_INCH, bleed: 0.125 * MM_PER_INCH, margin: 0.25 * MM_PER_INCH },
};

/** An unknown size draws as the default, never as a crash. */
export function pageGeometry(size: string): PageGeometry {
  const preset = (PRESETS as Record<string, (typeof PRESETS)[PageSize]>)[size] ?? PRESETS['us-comic'];
  const liveWidthMm = preset.w - 2 * preset.margin;
  const liveHeightMm = preset.h - 2 * preset.margin;
  return {
    trimWidthMm: preset.w,
    trimHeightMm: preset.h,
    bleedMm: preset.bleed,
    liveMarginMm: preset.margin,
    liveWidthMm,
    liveHeightMm,
    aspect: liveWidthMm / liveHeightMm,
  };
}

export const DEFAULT_GUTTER_MM = 4;

export interface Gutter {
  x: number;
  y: number;
}

/** A gutter in millimetres as the fraction of the live area it takes on each axis. */
export function gutterNormalized(gutterMm: number, size: string): Gutter {
  const g = pageGeometry(size);
  return { x: gutterMm / g.liveWidthMm, y: gutterMm / g.liveHeightMm };
}

// ---------------------------------------------------------------- templates

interface TemplateRow {
  /** Relative height. */
  h: number;
  /** Relative widths of the row's panels, left to right. */
  cells: readonly number[];
}

const TEMPLATES = {
  splash: [{ h: 1, cells: [1] }],
  '2-tier': [{ h: 1, cells: [1] }, { h: 1, cells: [1] }],
  '3-tier': [{ h: 1, cells: [1] }, { h: 1, cells: [1] }, { h: 1, cells: [1] }],
  'grid-4': [{ h: 1, cells: [1, 1] }, { h: 1, cells: [1, 1] }],
  'grid-6': [{ h: 1, cells: [1, 1] }, { h: 1, cells: [1, 1] }, { h: 1, cells: [1, 1] }],
  'grid-9': [{ h: 1, cells: [1, 1, 1] }, { h: 1, cells: [1, 1, 1] }, { h: 1, cells: [1, 1, 1] }],
  'tier-1-2': [{ h: 1, cells: [1] }, { h: 1, cells: [1, 1] }],
  'tier-2-1': [{ h: 1, cells: [1, 1] }, { h: 1, cells: [1] }],
} as const satisfies Record<string, readonly TemplateRow[]>;

export type TemplateId = keyof typeof TEMPLATES;
export const TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[];

export const isTemplateId = (value: unknown): value is TemplateId =>
  typeof value === 'string' && Object.hasOwn(TEMPLATES, value);

export function templatePanelCount(id: TemplateId): number {
  return (TEMPLATES[id] as readonly TemplateRow[]).reduce((n, row) => n + row.cells.length, 0);
}

export interface TemplateOptions {
  size?: string;
  gutterMm?: number;
  direction?: ReadingDirection;
}

/**
 * The panel rectangles of a template, in the book's reading order: left to right and top to bottom for LTR, and the
 * mirror image (first panel top right) for RTL. A starting point only — the page keeps whatever the writer drags to.
 */
export function templateRects(id: TemplateId, options: TemplateOptions = {}): Rect[] {
  return rowRects(TEMPLATES[id] as readonly TemplateRow[], options);
}

function rowRects(rows: readonly TemplateRow[], options: TemplateOptions): Rect[] {
  const gutter = gutterNormalized(options.gutterMm ?? DEFAULT_GUTTER_MM, options.size ?? 'us-comic');
  const heightShare = (1 - (rows.length - 1) * gutter.y) / rows.reduce((n, r) => n + r.h, 0);
  const out: Rect[] = [];
  let y = 0;
  for (const row of rows) {
    const h = row.h * heightShare;
    const widthShare = (1 - (row.cells.length - 1) * gutter.x) / row.cells.reduce((n, c) => n + c, 0);
    let x = 0;
    for (const cell of row.cells) {
      const w = cell * widthShare;
      out.push(options.direction === 'rtl' ? [1 - x - w, y, w, h] : [x, y, w, h]);
      x += w + gutter.x;
    }
    y += h + gutter.y;
  }
  return out;
}

/**
 * The template a panel count is the same as, when one is: a page derived from a script starts from it and keeps its id as
 * `layout`. Other counts have no template and no `layout`.
 */
export function templateForPanelCount(count: number): TemplateId | undefined {
  return TEMPLATE_IDS.find((id) => ['splash', '2-tier', '3-tier', 'grid-4', 'grid-6', 'grid-9'].includes(id) && templatePanelCount(id) === count);
}

/**
 * Panel rectangles for any panel count, in the book's reading order: one column up to three panels, two columns up to eight,
 * three beyond, the last row holding what is left. The counts a template covers come out as that template. A starting point
 * only, like the templates.
 */
export function panelRectsFor(count: number, options: TemplateOptions = {}): Rect[] {
  if (count < 1) return [];
  const columns = count <= 3 ? 1 : count <= 8 ? 2 : 3;
  const rows: TemplateRow[] = [];
  for (let left = count; left > 0; left -= columns) rows.push({ h: 1, cells: Array.from({ length: Math.min(columns, left) }, () => 1) });
  return rowRects(rows, options);
}

// ---------------------------------------------------------------- reading order

/**
 * The indices of `items` in reading order: rows from the top, each row left to right (right to left for RTL).
 * An item joins the current row when its vertical centre falls inside the row's extent, so a tall panel beside two
 * short ones reads first, then the short ones top to bottom. The page's stored order is authoritative; this is how a
 * template, a drag or a "sort by position" action proposes one.
 */
export function readingOrder<T>(items: readonly T[], rectOf: (item: T) => Rect, direction: ReadingDirection): number[] {
  const indices = items.map((_, i) => i);
  const rect = (i: number): Rect => rectOf(items[i] as T);
  indices.sort((a, b) => rect(a)[1] - rect(b)[1] || rect(a)[0] - rect(b)[0] || a - b);
  const rows: { top: number; bottom: number; members: number[] }[] = [];
  for (const i of indices) {
    const [, y, , h] = rect(i);
    const centre = y + h / 2;
    const row = rows[rows.length - 1];
    if (row !== undefined && centre >= row.top && centre <= row.bottom) {
      row.members.push(i);
      row.bottom = Math.max(row.bottom, y + h);
    } else rows.push({ top: y, bottom: y + h, members: [i] });
  }
  const out: number[] = [];
  for (const row of rows) {
    row.members.sort((a, b) => {
      const ra = rect(a);
      const rb = rect(b);
      const across = direction === 'rtl' ? rb[0] + rb[2] - (ra[0] + ra[2]) : ra[0] - rb[0];
      return across || ra[1] - rb[1] || a - b;
    });
    out.push(...row.members);
  }
  return out;
}

export const panelReadingOrder = (panels: readonly Panel[], direction: ReadingDirection): number[] =>
  readingOrder(panels, (p) => p.rect, direction);

export const balloonReadingOrder = (balloons: readonly Balloon[], direction: ReadingDirection): number[] =>
  readingOrder(balloons, (b) => b.rect, direction);

// ---------------------------------------------------------------- gutter snapping

export interface SnapOptions {
  gutter: Gutter;
  /** How close an edge must come to a candidate to snap, as a fraction of the live area. */
  threshold: number;
  /** Smallest size a resize may produce. Default 0.02. */
  minSize?: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

const at = (rect: Rect, i: number): number => rect[i] ?? 0;

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** The candidates a moving left or top edge may snap to on one axis, and likewise for a right or bottom edge. */
function axisCandidates(
  rect: Rect,
  others: readonly Rect[],
  axis: 0 | 1,
  gutter: number,
): { start: number[]; end: number[] } {
  const cross = (axis === 0 ? 1 : 0) as 0 | 1;
  const start = [0];
  const end = [1];
  for (const o of others) {
    start.push(at(o, axis));
    end.push(at(o, axis) + at(o, axis + 2));
    if (overlaps(at(rect, cross), at(rect, cross) + at(rect, cross + 2), at(o, cross), at(o, cross) + at(o, cross + 2))) {
      start.push(at(o, axis) + at(o, axis + 2) + gutter);
      end.push(at(o, axis) - gutter);
    }
  }
  return { start, end };
}

function nearest(value: number, candidates: readonly number[], threshold: number): number | undefined {
  let best: number | undefined;
  for (const c of candidates) {
    if (Math.abs(c - value) <= threshold && (best === undefined || Math.abs(c - value) < Math.abs(best - value))) best = c;
  }
  return best;
}

/** Moves `rect` as one piece so an edge lands a gutter away from a neighbour, flush with its edge, or on the live area. */
export function snapMove(rect: Rect, others: readonly Rect[], options: SnapOptions): Rect {
  const out: [number, number, number, number] = [rect[0], rect[1], rect[2], rect[3]];
  for (const axis of [0, 1] as const) {
    const size = at(rect, axis + 2);
    const { start, end } = axisCandidates(rect, others, axis, axis === 0 ? options.gutter.x : options.gutter.y);
    const a = nearest(at(rect, axis), start, options.threshold);
    const b = nearest(at(rect, axis) + size, end, options.threshold);
    const deltaA = a === undefined ? Infinity : a - at(rect, axis);
    const deltaB = b === undefined ? Infinity : b - (at(rect, axis) + size);
    const delta = Math.abs(deltaA) <= Math.abs(deltaB) ? deltaA : deltaB;
    out[axis] = clamp(at(rect, axis) + (Number.isFinite(delta) ? delta : 0), 0, 1 - size);
  }
  return out;
}

export interface ResizeEdges {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
}

/** Resizes by the edges being dragged; each snaps like {@link snapMove}, and the rect never falls below `minSize`. */
export function snapResize(rect: Rect, edges: ResizeEdges, others: readonly Rect[], options: SnapOptions): Rect {
  const min = options.minSize ?? 0.02;
  const lo: [number, number] = [rect[0], rect[1]];
  const hi: [number, number] = [rect[0] + rect[2], rect[1] + rect[3]];
  for (const axis of [0, 1] as const) {
    const { start, end } = axisCandidates(rect, others, axis, axis === 0 ? options.gutter.x : options.gutter.y);
    const startEdge = axis === 0 ? edges.left : edges.top;
    const endEdge = axis === 0 ? edges.right : edges.bottom;
    if (startEdge === true) lo[axis] = clamp(nearest(lo[axis], start, options.threshold) ?? lo[axis], 0, hi[axis] - min);
    if (endEdge === true) hi[axis] = clamp(nearest(hi[axis], end, options.threshold) ?? hi[axis], lo[axis] + min, 1);
  }
  return [lo[0], lo[1], hi[0] - lo[0], hi[1] - lo[1]];
}

// ---------------------------------------------------------------- balloon geometry

/** Tails end at this fraction of the distance from the balloon's edge to the speaker (comics.md §4). */
export const DEFAULT_TAIL_RATIO = 0.55;

export type OutlineShape = 'ellipse' | 'rect' | 'cloud' | 'burst' | 'spiky' | 'none';

export interface BalloonStyleData {
  outline: OutlineShape;
  /** Dash and gap, in stroke widths; absent for a solid line. */
  dash?: readonly [number, number];
  stroke: 'none' | 'normal' | 'bold';
  italic: boolean;
  tail: 'pointer' | 'circles' | 'none';
  fontRole: 'lettering' | 'sfx';
}

const STYLES: Record<BalloonKind, BalloonStyleData> = {
  speech: { outline: 'ellipse', stroke: 'normal', italic: false, tail: 'pointer', fontRole: 'lettering' },
  thought: { outline: 'cloud', stroke: 'normal', italic: false, tail: 'circles', fontRole: 'lettering' },
  caption: { outline: 'rect', stroke: 'normal', italic: false, tail: 'none', fontRole: 'lettering' },
  sfx: { outline: 'none', stroke: 'none', italic: false, tail: 'none', fontRole: 'sfx' },
  whisper: { outline: 'ellipse', dash: [4, 3], stroke: 'normal', italic: false, tail: 'pointer', fontRole: 'lettering' },
  shout: { outline: 'burst', stroke: 'bold', italic: false, tail: 'pointer', fontRole: 'lettering' },
  radio: { outline: 'spiky', stroke: 'normal', italic: true, tail: 'pointer', fontRole: 'lettering' },
};

export function balloonStyleData(kind: string): BalloonStyleData {
  return STYLES[drawnKind(kind)];
}

export interface TailGeometry {
  /** The two points where the tail leaves the outline. */
  base: readonly [Point, Point];
  tip: Point;
}

export interface CircleGeometry {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface BalloonGeometry {
  kind: BalloonKind;
  style: BalloonStyleData;
  outline: { shape: OutlineShape; points?: Point[]; lobes?: number };
  tail?: TailGeometry;
  /** The three thought circles, largest nearest the balloon. */
  circles?: CircleGeometry[];
  /** Where the text may be set. */
  textBox: Rect;
}

export interface GeometryOptions {
  aspect: number;
  /** The panel the balloon belongs to; an on-panel tail is kept inside it. */
  panelRect?: Rect;
  tailRatio?: number;
}

export function starPoints(rect: Rect, spikes: number, depth: number): Point[] {
  const [x, y, w, h] = rect;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const points: Point[] = [];
  for (let i = 0; i < spikes * 2; i += 1) {
    const angle = (i * Math.PI) / spikes - Math.PI / 2;
    const f = i % 2 === 0 ? 1 : 1 - depth;
    points.push([cx + Math.cos(angle) * (w / 2) * f, cy + Math.sin(angle) * (h / 2) * f]);
  }
  return points;
}

/** The tail target for a balloon: where it points, kept inside the panel unless the speaker is off panel. */
export function resolveTailTarget(balloon: Balloon, panelRect?: Rect): Point | undefined {
  if (balloon.tail === undefined) return undefined;
  if (balloon.offPanel === true || panelRect === undefined) return balloon.tail;
  const [x, y, w, h] = panelRect;
  return [clamp(balloon.tail[0], x, x + w), clamp(balloon.tail[1], y, y + h)];
}

interface TailParts {
  edge: [number, number];
  tip: [number, number];
  base: readonly [Point, Point];
  /** The smaller semi-axis in the square working space, for sizing the thought circles. */
  scale: number;
}

function tailParts(rect: Rect, target: Point, aspect: number, ratio: number): TailParts | undefined {
  // Work in a space where a unit is square, so the ellipse and the tail angles are not stretched by the page.
  const a = (rect[2] / 2) * aspect;
  const b = rect[3] / 2;
  const cx = (rect[0] + rect[2] / 2) * aspect;
  const cy = rect[1] + rect[3] / 2;
  const dx = target[0] * aspect - cx;
  const dy = target[1] - cy;
  const k = Math.hypot(dx / a, dy / b);
  if (!(k > 1)) return undefined;
  const ex = cx + dx / k;
  const ey = cy + dy / k;
  const theta = Math.atan2(dy / b, dx / a);
  const half = 0.28;
  const at = (t: number): Point => [(cx + a * Math.cos(t)) / aspect, cy + b * Math.sin(t)];
  return {
    edge: [ex, ey],
    tip: [ex + (target[0] * aspect - ex) * ratio, ey + (target[1] - ey) * ratio],
    base: [at(theta - half), at(theta + half)],
    scale: Math.min(a, b),
  };
}

/** Everything a renderer needs to draw one balloon. Pure: the balloon is never changed. */
export function balloonGeometry(balloon: Balloon, options: GeometryOptions): BalloonGeometry {
  const kind = drawnKind(balloon.kind);
  const style = STYLES[kind];
  const rect = balloon.rect;
  const [x, y, w, h] = rect;
  const outline: BalloonGeometry['outline'] = { shape: style.outline };
  if (style.outline === 'burst') outline.points = starPoints(rect, 12, 0.22);
  if (style.outline === 'spiky') outline.points = starPoints(rect, 18, 0.07);
  if (style.outline === 'cloud') {
    const perimeter = Math.PI * ((w * options.aspect) + h);
    outline.lobes = clamp(Math.round(perimeter / (Math.min(w * options.aspect, h) * 0.55)), 8, 28);
  }
  const textBox: Rect =
    style.outline === 'rect'
      ? [x + w * 0.03, y + h * 0.05, w * 0.94, h * 0.9]
      : style.outline === 'none'
        ? rect
        : [x + w * 0.14, y + h * 0.14, w * 0.72, h * 0.72];
  const geometry: BalloonGeometry = { kind, style, outline, textBox };

  const target = style.tail === 'none' ? undefined : resolveTailTarget(balloon, options.panelRect);
  if (target === undefined) return geometry;
  const parts = tailParts(rect, target, options.aspect, options.tailRatio ?? DEFAULT_TAIL_RATIO);
  if (parts === undefined) return geometry;
  if (style.tail === 'pointer') {
    geometry.tail = { base: parts.base, tip: [parts.tip[0] / options.aspect, parts.tip[1]] };
  } else {
    const fractions = [0.18, 0.55, 0.92] as const;
    const radii = [0.16, 0.11, 0.07] as const;
    geometry.circles = fractions.map((f, i) => {
      const px = parts.edge[0] + (parts.tip[0] - parts.edge[0]) * f;
      const py = parts.edge[1] + (parts.tip[1] - parts.edge[1]) * f;
      const r = parts.scale * (radii[i] ?? 0.07);
      return { cx: px / options.aspect, cy: py, rx: r / options.aspect, ry: r };
    });
  }
  return geometry;
}
