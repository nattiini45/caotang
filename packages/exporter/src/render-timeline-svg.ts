/**
 * The timeline as an SVG image (timeline.md §8, `timeline-svg`): a text format, so it compiles headless and a
 * writer can open it anywhere. It draws what the view draws — part zones, the folds between them with their lens
 * labels, gap breaks, the lens tick row, the lane gutter, scene chips and the `after` / thread / finding
 * connectors — in the project language's direction, which `projectTimeline` applies by mirroring the finished
 * geometry (timeline.md §3.2, D9). The canonical arrays stay logical; only this drawing mirrors.
 *
 * ## Safety and fonts
 *
 * Every text the SVG carries — titles, labels, notes — goes through {@link svgEscape}, so a scene title cannot
 * break out of its element. Fonts are generic families only (`sans-serif`): no font is embedded, and a CJK or
 * right-to-left title falls back to the viewer's own system fonts, which is why the PDF is the print-faithful path.
 *
 * ## Size
 *
 * The day scale is chosen so the whole axis fits a maximum width; the lens thins its own ticks at that scale. Above
 * 2,000 visible items the export switches to chapter blocks (the view's chapter zoom) and says so in a note drawn
 * above the axis and in the compile log — nothing is silently omitted.
 */

import { emptyCoherenceFile, type CoherenceFile } from '@caotang/coherence';
import type { ProjectState } from '@caotang/store';
import {
  buildTimeline,
  ENGLISH_LABELS,
  projectLensOf,
  projectTimeline,
  segmentIndexOf,
  type Box,
  type StoryPart,
  type TimelineItem,
  type TimelineModel,
} from '@caotang/timeline';

import { buildExportModel, type TimelineTableInput } from './render-timeline-csv.js';

/** The SVG's MIME type. */
export const SVG_MIME = 'image/svg+xml';

/** Above this many visible items the export aggregates to chapter blocks, with a note. */
export const SVG_AGGREGATE_ABOVE = 2000;

/** The widest an exported SVG gets, in user units, before the day scale is reduced to fit. */
const DEFAULT_MAX_WIDTH = 8000;

const HEADER_PX = 26;
const ROW_PX = 24;
const LANE_PAD_PX = 8;
const BREAK_PX = 24;
const FOLD_PX = 40;
const SHELF_CHIP_W = 120;
const CHIP_FONT = 11;
const LABEL_FONT = 10;

const INK = '#1a1a1a';
const MUTED = '#666666';
const ZONE_FILL = '#f2f2f2';
const ZONE_LINE = '#c8c8c8';
const FOLD_FILL = '#e2e2e2';
const BREAK_FILL = '#ececec';
const LANE_LINE = '#dddddd';
const CHIP_FILL = '#333333';
const LINE = '#8a8a8a';

/** The five markup characters and the apostrophe, as entities. */
export function svgEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const num = (value: number): string => String(Math.round(value * 100) / 100);

export interface TimelineSvgInput extends TimelineTableInput {
  readonly state: ProjectState;
  /** The widest the SVG gets before the day scale is reduced. Absent is 8000 user units. */
  readonly maxWidth?: number;
}

export interface TimelineSvgOutput {
  readonly svg: string;
  readonly notes: readonly string[];
  /** How many chips the drawing holds. */
  readonly chips: number;
  /** True when the export aggregated above {@link SVG_AGGREGATE_ABOVE} items to chapter blocks. */
  readonly aggregated: boolean;
}

interface DrawnChip {
  readonly key: string;
  readonly box: Box;
  readonly text: string;
  readonly sub: string;
}

/** The model at chapter zoom, for the aggregated export: one block per chapter folder per part. */
function chapterModelOf(input: TimelineSvgInput): TimelineModel {
  const language = input.language ?? input.state.manifest.project.language ?? '';
  const lens = projectLensOf(input.state.manifest.timeline, { locale: language === '' ? 'en' : language }).lens;
  const roots = input.includeRootIds.length === 0 ? ['manuscript'] : input.includeRootIds;
  const scope = roots.length === 1 && roots[0] !== 'manuscript' ? (roots[0] as string) : undefined;
  const file = (input.state.coherence ?? emptyCoherenceFile()) as CoherenceFile;
  return buildTimeline(input.state, file, {
    axis: 'story',
    groupBy: 'none',
    zoom: 'chapter',
    lens,
    labels: ENGLISH_LABELS,
    findings: 'open',
    compressGaps: true,
    ...(scope !== undefined ? { scope } : {}),
  });
}

/** The x of a day inside its segment, at the projection's own scale and separator widths. */
function dayXOf(model: TimelineModel, ppd: number, part: StoryPart, day: number): number {
  const segment = model.axis.segments[segmentIndexOf(model.axis.segments, part, day)];
  if (segment === undefined) return 0;
  return segment.daysBefore * ppd + segment.breaksBefore * BREAK_PX + segment.foldsBefore * FOLD_PX + (day - segment.from) * ppd;
}

/** The boxes of the chapter blocks, at the same scale as the projected items. */
function blockChips(model: TimelineModel, ppd: number, y: number): DrawnChip[] {
  return model.blocks
    .filter((block) => block.start !== undefined && block.end !== undefined)
    .map((block) => ({
      key: block.id,
      box: {
        x: dayXOf(model, ppd, block.part, block.start as number),
        y,
        w: Math.max((block.end as number) - (block.start as number), 1) * ppd,
        h: ROW_PX,
      },
      text: block.label,
      sub: `${block.count}`,
    }));
}

/**
 * Renders the timeline as one standalone SVG document. The model is built as the table builds it; the projection
 * applies the project language's direction, so a right-to-left book's SVG is the mirror of the same book's
 * left-to-right one, with the reading order unchanged in the data.
 */
export function renderTimelineSvg(input: TimelineSvgInput): TimelineSvgOutput {
  const maxWidth = input.maxWidth ?? DEFAULT_MAX_WIDTH;
  const base = buildExportModel(input);
  const visible = base.model.items.filter((item) => item.kind === 'scene').length;
  const aggregated = visible > SVG_AGGREGATE_ABOVE;
  const model = aggregated ? chapterModelOf(input) : base.model;
  const { labels, lens } = base;

  // The day scale: the view's day zoom unless the whole axis would run past the maximum width.
  const totalDays = model.axis.segments.reduce((sum, segment) => sum + (segment.to - segment.from), 0);
  const separators = model.axis.breaks.length * BREAK_PX + model.axis.folds.length * FOLD_PX;
  const ppd = Math.max(0.02, Math.min(48, (maxWidth - separators) / Math.max(totalDays, 1)));

  const geometry = projectTimeline(model, {
    pxPerDay: ppd,
    rowPx: ROW_PX,
    lanePadPx: LANE_PAD_PX,
    breakPx: BREAK_PX,
    foldPx: FOLD_PX,
  });
  const direction = geometry.direction;

  const laneTop = HEADER_PX;
  const shelfTop = laneTop + geometry.height + LANE_PAD_PX;
  const chips: DrawnChip[] = aggregated
    ? blockChips(model, ppd, laneTop + 2)
    : model.items
        .filter((item: TimelineItem) => item.kind === 'scene')
        .map((item: TimelineItem) => {
          const box = geometry.items.find((entry) => entry.key === item.key)?.box;
          return box === undefined
            ? undefined
            : {
                key: item.key,
                box: { ...box, y: box.y + laneTop },
                text: item.title,
                sub: item.dayOffset === undefined ? '' : lens.label(item.dayOffset, 'short'),
              };
        })
        .filter((chip): chip is DrawnChip => chip !== undefined);
  // Undated scenes: a shelf strip under the lanes, in reading order, in the project direction.
  const undated = aggregated ? [] : model.items.filter((item: TimelineItem) => item.kind === 'scene' && item.start === undefined);
  const shelfChips: DrawnChip[] = undated.map((item, at) => ({
    key: item.key,
    box: { x: at * (SHELF_CHIP_W + 4), y: shelfTop, w: SHELF_CHIP_W, h: ROW_PX },
    text: item.title,
    sub: '',
  }));
  const shelfWidth = shelfChips.length > 0 ? shelfChips.length * (SHELF_CHIP_W + 4) : 0;
  const width = Math.max(geometry.width, shelfWidth, 320);
  // The axis chips already come from `projectTimeline`, which mirrored them for a right-to-left book. Only the shelf
  // strip, laid out here, still needs mirroring; mirroring the chips again would put them back where they started.
  if (direction === 'rtl') {
    for (const chip of shelfChips) chip.box.x = width - chip.box.x - chip.box.w;
  }

  const height = shelfTop + (shelfChips.length > 0 ? ROW_PX + 14 : 0) + 8;
  /** A label at a page edge: on the reading-start side, which is the left for a left-to-right book. */
  const edge = (at: number): { x: number; anchor: 'start' | 'end' } =>
    direction === 'ltr' ? { x: at, anchor: 'start' } : { x: width - at, anchor: 'end' };
  /** A label at a chip's reading-start edge (the box is already mirrored for a right-to-left book). */
  const chipEdge = (box: Box): { x: number; anchor: 'start' | 'end' } =>
    direction === 'ltr' ? { x: box.x + 4, anchor: 'start' } : { x: box.x + box.w - 4, anchor: 'end' };

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="0 0 ${num(width)} ${num(height)}" role="img" font-family="sans-serif">`,
  );
  parts.push(`<title>${svgEscape(input.state.manifest.project.name)} — timeline</title>`);
  parts.push(`<rect x="0" y="0" width="${num(width)}" height="${num(height)}" fill="#ffffff"/>`);

  // Part zones, behind everything else.
  for (const zone of geometry.zones) {
    parts.push(
      `<rect x="${num(zone.box.x)}" y="${num(laneTop)}" width="${num(zone.box.w)}" height="${num(zone.box.h)}" fill="${ZONE_FILL}" stroke="${ZONE_LINE}"/>`,
    );
    const at = chipEdge(zone.box);
    parts.push(
      `<text x="${num(at.x)}" y="${num(laneTop + 12)}" font-size="${LABEL_FONT}" fill="${MUTED}" text-anchor="${at.anchor}">${svgEscape(labels.partName(zone.part))}</text>`,
    );
  }
  // Folds and gap breaks: fixed-width separators with their labels.
  model.axis.folds.forEach((fold, index) => {
    const box = geometry.folds[index]?.box;
    if (box === undefined) return;
    parts.push(
      `<rect x="${num(box.x)}" y="${num(laneTop)}" width="${num(box.w)}" height="${num(box.h)}" fill="${FOLD_FILL}" stroke="${ZONE_LINE}"/>`,
    );
    const cx = box.x + box.w / 2;
    const cy = laneTop + box.h / 2;
    parts.push(
      `<text x="${num(cx)}" y="${num(cy)}" font-size="${LABEL_FONT}" fill="${INK}" text-anchor="middle" transform="rotate(-90 ${num(cx)} ${num(cy)})">${svgEscape(fold.label)}</text>`,
    );
  });
  model.axis.breaks.forEach((brk, index) => {
    const box = geometry.breaks[index]?.box;
    if (box === undefined) return;
    parts.push(
      `<rect x="${num(box.x)}" y="${num(laneTop)}" width="${num(box.w)}" height="${num(box.h)}" fill="${BREAK_FILL}" stroke="${ZONE_LINE}"/>`,
    );
    const cx = box.x + box.w / 2;
    const cy = laneTop + box.h / 2;
    parts.push(
      `<text x="${num(cx)}" y="${num(cy)}" font-size="${LABEL_FONT}" fill="${MUTED}" text-anchor="middle" transform="rotate(-90 ${num(cx)} ${num(cy)})">${svgEscape(brk.label)}</text>`,
    );
  });

  // The lens tick row, above the lanes.
  for (const tick of geometry.ticks) {
    const modelTick = model.axis.ticks[tick.index];
    if (modelTick === undefined) continue;
    parts.push(
      `<line x1="${num(tick.x)}" y1="${num(laneTop - 8)}" x2="${num(tick.x)}" y2="${num(laneTop)}" stroke="${LINE}" stroke-width="${modelTick.level === 0 ? 1.4 : 0.8}"/>`,
    );
    parts.push(
      `<text x="${num(tick.x)}" y="${num(laneTop - 11)}" font-size="${LABEL_FONT}" fill="${MUTED}" text-anchor="middle">${svgEscape(modelTick.label)}</text>`,
    );
  }

  // Lanes: a full-width band per lane, with the gutter label on the reading-start side.
  for (const lane of geometry.lanes) {
    const modelLane = model.lanes.find((candidate) => candidate.id === lane.id);
    parts.push(
      `<rect x="${num(lane.box.x)}" y="${num(lane.box.y + laneTop)}" width="${num(lane.box.w)}" height="${num(lane.box.h)}" fill="none" stroke="${LANE_LINE}"/>`,
    );
    const at = edge(4);
    parts.push(
      `<text x="${num(at.x)}" y="${num(lane.box.y + laneTop + lane.box.h / 2 + 4)}" font-size="${LABEL_FONT}" fill="${MUTED}" text-anchor="${at.anchor}">${svgEscape(modelLane?.label ?? lane.id)}</text>`,
    );
  }

  // Connectors under the chips: after-links, threads and finding pairs, from one chip's reading-end edge to the
  // other's reading-start edge.
  const boxOf = new Map([...chips, ...shelfChips].map((chip) => [chip.key, chip.box] as const));
  for (const connector of model.connectors) {
    const from = boxOf.get(connector.from);
    const to = boxOf.get(connector.to);
    if (from === undefined || to === undefined) continue;
    const fromY = from.y + from.h / 2;
    const toY = to.y + to.h / 2;
    const fromX = direction === 'ltr' ? from.x + from.w : from.x;
    const toX = direction === 'ltr' ? to.x : to.x + to.w;
    const stroke = connector.kind === 'finding' ? '#b0483e' : connector.kind === 'thread' ? '#4a7fb5' : LINE;
    const dash =
      connector.kind === 'thread'
        ? ' stroke-dasharray="4 3"'
        : connector.violation === true || connector.cycle === true
          ? ' stroke-dasharray="2 3"'
          : '';
    parts.push(
      `<line x1="${num(fromX)}" y1="${num(fromY)}" x2="${num(toX)}" y2="${num(toY)}" stroke="${stroke}" stroke-width="1"${dash}/>`,
    );
  }

  // The chips themselves, each clipped to its own box so a long title cannot spill into its neighbour.
  const drawChip = (chip: DrawnChip, id: string, filled: boolean): void => {
    parts.push(
      `<clipPath id="${id}"><rect x="${num(chip.box.x)}" y="${num(chip.box.y)}" width="${num(chip.box.w)}" height="${num(chip.box.h)}"/></clipPath>`,
    );
    const rect = filled
      ? `<rect x="${num(chip.box.x)}" y="${num(chip.box.y)}" width="${num(chip.box.w)}" height="${num(chip.box.h)}" rx="3" fill="${CHIP_FILL}"/>`
      : `<rect x="${num(chip.box.x)}" y="${num(chip.box.y)}" width="${num(chip.box.w)}" height="${num(chip.box.h)}" rx="3" fill="none" stroke="${CHIP_FILL}" stroke-dasharray="3 2"/>`;
    parts.push(rect);
    const at = chipEdge(chip.box);
    const label = chip.sub === '' ? chip.text : `${chip.text} · ${chip.sub}`;
    parts.push(
      `<text x="${num(at.x)}" y="${num(chip.box.y + chip.box.h / 2 + 4)}" font-size="${CHIP_FONT}" fill="${filled ? '#ffffff' : INK}" text-anchor="${at.anchor}" clip-path="url(#${id})">${svgEscape(label)}</text>`,
    );
  };
  chips.forEach((chip, index) => drawChip(chip, `clip-${index}`, true));

  // The undated shelf.
  if (shelfChips.length > 0) {
    const at = edge(4);
    parts.push(
      `<text x="${num(at.x)}" y="${num(shelfTop - 4)}" font-size="${LABEL_FONT}" fill="${MUTED}" text-anchor="${at.anchor}">${svgEscape('Undated scenes')}</text>`,
    );
    shelfChips.forEach((chip, index) => drawChip(chip, `shelf-${index}`, false));
  }

  const notes: string[] = [];
  if (aggregated) {
    const note = `${visible.toLocaleString('en-US')} scenes are more than the ${SVG_AGGREGATE_ABOVE.toLocaleString('en-US')} an SVG draws one chip per scene for, so this file shows them as ${model.blocks.length.toLocaleString('en-US')} chapter blocks`;
    notes.push(note);
    const at = edge(4);
    parts.push(
      `<text x="${num(at.x)}" y="${num(12)}" font-size="${LABEL_FONT}" fill="${MUTED}" text-anchor="${at.anchor}">${svgEscape(note)}</text>`,
    );
  }
  parts.push('</svg>');
  return { svg: parts.join('\n'), notes, chips: chips.length + shelfChips.length, aggregated };
}
