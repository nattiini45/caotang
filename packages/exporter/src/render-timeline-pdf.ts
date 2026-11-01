/**
 * The timeline as a paginated PDF (timeline.md §8, `timeline-pdf`): landscape A4 or US Letter, drawn over pdf-lib,
 * loaded lazily as the DOCX, EPUB, contact-sheet and comic renderers are. It is the print-faithful path: unlike the
 * SVG it embeds the `@caotang/pdf-fonts` fallbacks, so a CJK, Arabic, Hebrew or Devanagari title prints instead of
 * falling back to the viewer's fonts.
 *
 * ## Layout and pagination
 *
 * The axis is laid out in points exactly as `projectTimeline` lays it out in pixels — segments of days at a chosen
 * points-per-day, with fixed-width separators at gap breaks and part folds — and then cut into pages. Page
 * boundaries fall at part folds first (a new part never starts in the middle of a page that already shows another
 * part's days), then at axis breaks, then at the nearest day boundary that does not split a chip. A chip is never
 * cut: a chip wider than a whole page is scaled down to fit it, with a note in the compile log. Every page repeats
 * the lens tick row and the lane gutter; the page order is reading order, and no page is mirrored as a page — the
 * geometry inside a right-to-left book's page is mirrored (timeline.md §3.2, D9), the page sequence is not.
 *
 * ## Thumbnails
 *
 * Only when the recipe asks (`timelinePictures`): a chip carries its scene's pictures at its reading-end, the card first, at most
 * three and a "+N" for the rest, and it gives its title room before a picture takes any. Each picture is read from `assets/`, shrunk
 * to a thumbnail by the host's converter under the same plan the prose figures follow, and embedded once however many chips draw it;
 * one that is gone, unreadable or cannot be shrunk is an empty dashed frame, named in the compile log. Without the option no picture
 * is read and the file is the one this renderer always wrote.
 *
 * ## Footer
 *
 * Every page's footer names the part it shows, its day span, its page number and the lens: `Epilogue · Day 4,380 –
 * Day 4,420 · page 7 of 8 · Day lens`.
 */

import {
  clustersOf,
  devanagariFontPrints,
  emojiStyleOf,
  isBidiControl,
  isRtlMark,
  loadFont,
  rtlFontPrints,
  scriptRuns,
  type FontLoader,
  type RtlScript,
} from '@caotang/pdf-fonts';
import type * as Bidi from '@caotang/pdf-fonts/bidi';
import type { Shape } from '@caotang/pdf-fonts/shaper';
import type * as PdfLib from 'pdf-lib';
import type { ProjectState } from '@caotang/store';
import type { Box, StoryPart, TimelineItem, TimelineModel } from '@caotang/timeline';

import type { FontkitFont } from './cid-embedding.js';
import { CjkEmbedding, CjkFace } from './cjk-font.js';
import { DevanagariEmbedding, DevanagariFace } from './devanagari-font.js';
import { EmojiEmbedding, EmojiFace, type EmojiGlyph } from './emoji-font.js';
import { fallbackNeeds } from './render-contact-sheet.js';
import { RtlEmbedding, RtlFace, type PlacedGlyph } from './rtl-font.js';
import { buildExportModel, type TimelineTableInput } from './render-timeline-csv.js';
import { prepareThumbnail, timelinePicturesOf, type ThumbnailHost, type TimelineScenePicture } from './timeline-pictures.js';

/** The PDF's MIME type, as the other PDF formats carry it. */
export const TIMELINE_PDF_MIME = 'application/pdf';

/** Landscape A4 in points. */
const A4: readonly [number, number] = [841.89, 595.28];
/** Landscape US Letter in points. */
const LETTER: readonly [number, number] = [792, 612];

const MARGIN = 28;
const GUTTER = 84;
const TICK_H = 30;
const FOOTER_H = 20;
const BREAK_W = 14;
const FOLD_W = 22;
const MIN_CHIP_W = 10;
/** The fewest points a page holds before a boundary is pushed to the next candidate, so no sliver pages. */
const MIN_PAGE_FILL = 0.25;
/** The most days one page aims to show, which sets the points-per-day. */
const DAYS_PER_PAGE = 420;
/** The most points one day takes. A short axis fills the page and a one-day chip still holds its own label. */
const MAX_PPD = 140;
const MIN_PPD = 0.08;
/** The lens thins ticks at 40 px; in points the same thinning runs at 30 pt, so the scale passed is scaled up. */
const TICK_PX_TO_PT = 40 / 30;
/** Most pictures one chip carries, and the others as "+N" (timeline.md §9.1). */
const THUMBS_MAX = 3;
/** The smallest picture worth drawing, in points: below it the rows are too thin and the pictures are left out. */
const THUMB_MIN_EDGE = 7;
const THUMB_GAP = 1.5;
/** The room kept for "+N", and the room a chip's title keeps before a picture may take it. */
const THUMB_MORE_W = 14;
const THUMB_TITLE_MIN = 44;
const THUMB_MORE_SIZE = 6.5;

export interface TimelinePdfInput extends TimelineTableInput {
  readonly state: ProjectState;
  /** The document's title, in its metadata. */
  readonly title: string;
  readonly author?: string;
  /** The moment the compile ran: the document's dates, so one compile writes one file. */
  readonly at: Date;
  /** The paper: `A4` or `Letter`. Absent is A4. */
  readonly pageSize?: 'A4' | 'Letter';
  readonly loadFallbackFont?: FontLoader;
  readonly loadEmojiFont?: FontLoader;
  readonly loadArabicFont?: FontLoader;
  readonly loadHebrewFont?: FontLoader;
  readonly loadDevanagariFont?: FontLoader;
  /**
   * Draws the pictures on each scene as small images on its chip (timeline.md §9.1): at most three and a "+N" for the rest, the card
   * first. Absent draws none, so a PDF made without it is the PDF it always was. A picture the host cannot read or shrink is an empty
   * frame in its place, and the compile log says which.
   */
  readonly thumbnails?: ThumbnailHost;
}

export interface TimelinePdf {
  readonly contents: Uint8Array;
  readonly notes: readonly string[];
  readonly pages: number;
}

interface Chip {
  readonly key: string;
  readonly part: StoryPart;
  readonly box: Box;
  readonly text: string;
  readonly sub: string;
  /** Set when the chip was wider than a whole page and scaled down to fit it. */
  scaled?: boolean;
  readonly nodeId: string;
  /** The pictures the chip draws and how many more its scene holds; set only when the recipe asks for pictures. */
  thumbs?: { readonly shown: readonly TimelineScenePicture[]; readonly more: number; readonly width: number };
}

/** How many pictures a chip of this width carries, counting the room "+N" takes, so a chip gives its title room first. */
export function thumbsFitPoints(chipWidth: number, total: number, edge: number): number {
  for (let count = Math.min(THUMBS_MAX, total); count >= 1; count -= 1) {
    const taken = count * (edge + THUMB_GAP) + (total > count ? THUMB_MORE_W : 0);
    if (chipWidth - 4 - taken >= THUMB_TITLE_MIN) return count;
  }
  return 0;
}

interface PagePlan {
  /** The page's x range in axis coordinates, `[from, to)`. */
  readonly from: number;
  readonly to: number;
  readonly part: StoryPart;
  readonly dayFrom: number;
  readonly dayTo: number;
}

/** One page's cut positions over the axis, in axis x coordinates. Exported for the pagination tests. */
export function planTimelinePages(input: {
  readonly width: number;
  readonly contentWidth: number;
  readonly chips: readonly { readonly box: Box }[];
  /** Part-fold x positions: each one starts a fresh page. */
  readonly foldCuts: readonly number[];
  /** Every other candidate boundary: break starts and day lines. */
  readonly cuts: readonly number[];
}): readonly number[] {
  const { width, contentWidth, chips, foldCuts, cuts } = input;
  const minFill = contentWidth * MIN_PAGE_FILL;
  /** A cut splits a chip when it falls strictly inside the chip's x range. */
  const splits = (cut: number): boolean => chips.some((chip) => cut > chip.box.x + 0.01 && cut < chip.box.x + chip.box.w - 0.01);
  const out = [0];
  let start = 0;
  while (start < width - 0.01) {
    const limit = start + contentWidth;
    // A part fold is always a page start: a new part never begins in the middle of a page that already shows another
    // part's days (timeline.md §8). A fold sits between segments, so it never splits a chip.
    const folds = foldCuts.filter((cut) => cut > start + 1 && cut <= limit);
    if (folds.length > 0) {
      const cut = Math.min(...folds);
      if (cut >= width - 0.01) {
        out.push(width);
        break;
      }
      out.push(cut);
      start = cut;
      continue;
    }
    if (limit >= width - 0.01) {
      out.push(width);
      break;
    }
    // Otherwise the furthest boundary that fills the page and does not split a chip.
    const fill = cuts.filter((cut) => cut > start + minFill && cut <= limit && !splits(cut));
    if (fill.length > 0) {
      const cut = Math.max(...fill);
      out.push(cut);
      start = cut;
      continue;
    }
    // No clean boundary inside the page: cut at the page edge when no chip crosses it, else just before the first
    // chip that would cross it.
    const crossing = chips.filter((chip) => chip.box.x < limit - 0.01 && chip.box.x + chip.box.w > limit + 0.01);
    if (crossing.length === 0) {
      out.push(limit);
      start = limit;
      continue;
    }
    const first = crossing.reduce((best, chip) => (chip.box.x < best.box.x ? chip : best));
    if (first.box.x > start + 0.01) {
      // The chip starts on this page: end the page at its start, a boundary no chip crosses.
      const cut = Math.min(limit, Math.max(start + minFill, first.box.x));
      out.push(cut);
      start = cut;
    } else {
      // The chip starts at the page's own edge and runs past it: it is wider than a page, so it is drawn scaled,
      // whole, on this page, and the page ends at its edge.
      out.push(limit);
      start = limit;
    }
  }
  return out;
}

/** The days a page's x range covers: the first and last whole day of the segments it overlaps. */
function daysOfSpan(
  segments: readonly { from: number; to: number; daysBefore: number; breaksBefore: number; foldsBefore: number }[],
  ppd: number,
  from: number,
  to: number,
): { readonly from: number; readonly to: number } | undefined {
  const xOf = (segment: (typeof segments)[number]): [number, number] => {
    const start = segment.daysBefore * ppd + segment.breaksBefore * BREAK_W + segment.foldsBefore * FOLD_W;
    return [start, start + (segment.to - segment.from) * ppd];
  };
  const overlapping = segments.filter((segment) => {
    const [start, end] = xOf(segment);
    return end > from + 0.01 && start < to - 0.01;
  });
  const first = overlapping[0];
  const last = overlapping[overlapping.length - 1];
  if (first === undefined || last === undefined) return undefined;
  const [firstStart] = xOf(first);
  const [lastStart, lastEnd] = xOf(last);
  const dayFrom = first.from + Math.min(Math.max(Math.floor((Math.max(from, firstStart) - firstStart) / ppd), 0), first.to - first.from - 1);
  const dayTo = last.from + Math.min(Math.max(Math.ceil((Math.min(to, lastEnd) - lastStart) / ppd) - 1, 0), last.to - last.from - 1);
  return { from: dayFrom, to: Math.max(dayFrom, dayTo) };
}

/** A colour as red, green and blue from 0 to 1. */
interface Shade {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const INK: Shade = { r: 0.1, g: 0.1, b: 0.1 };
const MUTED: Shade = { r: 0.42, g: 0.42, b: 0.42 };
const ZONE_FILL: Shade = { r: 0.95, g: 0.95, b: 0.95 };
const ZONE_LINE: Shade = { r: 0.78, g: 0.78, b: 0.78 };
const FOLD_FILL: Shade = { r: 0.88, g: 0.88, b: 0.88 };
const BREAK_FILL: Shade = { r: 0.93, g: 0.93, b: 0.93 };
const CHIP_FILL: Shade = { r: 0.2, g: 0.2, b: 0.2 };
const FINDING_LINE: Shade = { r: 0.69, g: 0.28, b: 0.24 };
const THREAD_LINE: Shade = { r: 0.29, g: 0.5, b: 0.71 };
const AXIS_LINE: Shade = { r: 0.54, g: 0.54, b: 0.54 };

/**
 * One grapheme cluster of a line, resolved to the font that draws it. Copied from the contact sheet's emitter
 * (render-contact-sheet.ts), which owns the same routing: Helvetica for what WinAnsi encodes, the CJK fallback for
 * the rest, the emoji font for emoji presentation, Noto Sans Arabic and Hebrew (shaped) before the CJK font, and
 * Noto Sans Devanagari after them.
 */
interface Piece {
  readonly text: string;
  readonly face: 'base' | 'cjk' | 'emoji' | 'devanagari' | RtlScript;
  readonly glyphs?: readonly EmojiGlyph[] | readonly (EmojiGlyph | { readonly glyph: number })[];
  readonly placed?: readonly PlacedGlyph[];
  readonly width?: number;
}

const VS15 = 0xfe0e;

function isJoinerOrSelector(code: number): boolean {
  return code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef);
}

function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code < 0xa0);
}

/**
 * Draws the timeline PDF. The pagination and geometry run first, purely; the drawing then loads the fonts only
 * for the scripts the file actually holds.
 */
export async function drawTimelinePdf(input: TimelinePdfInput): Promise<TimelinePdf> {
  const lib = await import('pdf-lib');
  const { PDFDocument, StandardFonts, rgb } = lib;
  const color = (c: Shade): PdfLib.RGB => rgb(c.r, c.g, c.b);

  const [pageW, pageH] = input.pageSize === 'Letter' ? LETTER : A4;
  const base = buildExportModel(input);
  const model = base.model;
  const { labels, lens } = base;
  const direction = model.direction;

  // The axis in points. A page aims to show DAYS_PER_PAGE days; a shorter axis fills the page instead, up to MAX_PPD,
  // so a six-day story does not print as a sliver.
  const contentW = pageW - 2 * MARGIN - GUTTER;
  const segmentDays = model.axis.segments.reduce((sum, segment) => sum + (segment.to - segment.from), 0);
  const shownDays = Math.max(Math.min(segmentDays, DAYS_PER_PAGE), 1);
  const ppd = Math.max(MIN_PPD, Math.min(MAX_PPD, contentW / shownDays));
  const segX = (segment: TimelineModel['axis']['segments'][number]): number =>
    segment.daysBefore * ppd + segment.breaksBefore * BREAK_W + segment.foldsBefore * FOLD_W;
  const dayX = (segment: TimelineModel['axis']['segments'][number], day: number): number => segX(segment) + (day - segment.from) * ppd;
  const lastSegment = model.axis.segments[model.axis.segments.length - 1];
  const axisWidth = lastSegment === undefined ? 0 : dayX(lastSegment, lastSegment.to);

  // Lanes and rows. One lane (the export groups nothing), as many rows as the same-day packing needs.
  const laneCount = Math.max(model.lanes.length, 1);
  const shelfCount = model.items.filter((item) => item.kind === 'scene' && item.start === undefined).length;
  const contentH = pageH - 2 * MARGIN - TICK_H - FOOTER_H;
  const rowH = Math.max(2.5, Math.min(16, contentH / Math.max(laneCount * Math.max(...model.lanes.map((lane) => lane.rows), 1) + (shelfCount > 0 ? 1 : 0), 1)));
  const laneY = MARGIN + TICK_H;
  const laneH = rowH * Math.max(...model.lanes.map((lane) => lane.rows), 1);
  const shelfY = laneY + laneH + 4;

  // The chips: a day-proportional bar, widened to hold its own label so a title prints whole rather than as an ellipsis.
  const chips: Chip[] = [];
  for (const item of model.items) {
    if (item.kind !== 'scene') continue;
    if (item.start !== undefined && item.end !== undefined && item.segment !== undefined) {
      const segment = model.axis.segments[item.segment];
      if (segment === undefined) continue;
      const sub = lens.label(item.start, 'short');
      chips.push({
        key: item.key,
        part: item.part,
        box: {
          x: dayX(segment, item.start),
          y: laneY + item.row * rowH,
          w: Math.max((item.end - item.start) * ppd, MIN_CHIP_W),
          h: rowH - 1,
        },
        text: item.title,
        sub,
        nodeId: item.nodeId,
      });
    }
  }
  const undated = model.items.filter((item: TimelineItem) => item.kind === 'scene' && item.start === undefined);
  // The undated shelf sits after the axis, in its own x range, so it lands on the last page(s) rather than over the zones.
  let shelfX = axisWidth;
  for (const item of undated) {
    const w = Math.min(70, contentW);
    chips.push({
      key: item.key,
      part: item.part,
      box: { x: shelfX, y: shelfY, w, h: rowH - 1 },
      text: item.title,
      sub: '',
      nodeId: item.nodeId,
    });
    shelfX += w + 2;
  }
  const shelfWidth = shelfX;
  const width = Math.max(axisWidth, shelfWidth);

  // The page cuts: fold starts are always page starts; break starts and day lines fill pages.
  const foldCuts = model.axis.folds.map((fold) => segX(model.axis.segments[fold.segment] as TimelineModel['axis']['segments'][number]));
  const breakCuts = model.axis.breaks.map((brk) => segX(model.axis.segments[brk.segment] as TimelineModel['axis']['segments'][number]));
  const dayStep = Math.max(1, Math.floor(contentW / ppd / 12));
  const dayCuts: number[] = [];
  for (const segment of model.axis.segments) {
    for (let day = Math.ceil(segment.from / dayStep) * dayStep; day < segment.to; day += dayStep) dayCuts.push(dayX(segment, day));
  }
  const allCuts = [...breakCuts, ...dayCuts].sort((a, b) => a - b);
  const cutXs = planTimelinePages({ width: Math.max(width, 1), contentWidth: contentW, chips, foldCuts, cuts: allCuts });
  // Fold cuts must start pages even when a day line would have filled further: re-cut so every fold cut is a page start.
  const pages: PagePlan[] = [];
  for (let i = 0; i + 1 < cutXs.length; i += 1) {
    const from = cutXs[i] as number;
    const to = cutXs[i + 1] as number;
    const segment = model.axis.segments.find((candidate) => {
      const start = segX(candidate);
      return from >= start - 0.01 && from < start + (candidate.to - candidate.from) * ppd;
    });
    const part: StoryPart = segment?.part ?? model.zones[0]?.part ?? 'main';
    const span = daysOfSpan(model.axis.segments, ppd, from, Math.min(to, Math.max(width, 1)));
    pages.push({
      from,
      to,
      part,
      dayFrom: span?.from ?? segment?.from ?? 0,
      dayTo: span?.to ?? segment?.from ?? 0,
    });
  }

  // A chip wider than a whole page is scaled down to fit it, whole, and the log says so.
  const notes: string[] = [];
  let thumbEdge = 0;
  for (const chip of chips) {
    if (chip.box.w >= contentW - 2) {
      chip.scaled = true;
      chip.box.w = contentW - 2;
      notes.push(`the scene “${chip.text}” is wider than a whole page at this scale, so its chip is scaled down to fit the page instead of being cut`);
    }
  }

  // The pictures each chip draws, when the recipe asks for them: decided here from the geometry, read and embedded once the document exists.
  if (input.thumbnails !== undefined) {
    const held = timelinePicturesOf(input.state, chips.map((chip) => chip.nodeId));
    const edge = Math.min(rowH - 1 - 2, 13);
    const withPictures = chips.filter((chip) => held.of(chip.nodeId).length > 0);
    if (held.unrecorded > 0) {
      notes.push(`${held.unrecorded} picture placement${held.unrecorded === 1 ? '' : 's'} on scenes ${held.unrecorded === 1 ? 'names' : 'name'} a picture the project has no record of, so ${held.unrecorded === 1 ? 'it has' : 'they have'} no thumbnail`);
    }
    if (withPictures.length > 0 && edge < THUMB_MIN_EDGE) {
      notes.push('timeline PDF: the scenes are too close together at this size for thumbnails, so the pictures are left out');
    } else {
      let crowded = 0;
      for (const chip of withPictures) {
        const all = held.of(chip.nodeId);
        const fit = thumbsFitPoints(chip.box.w, all.length, edge);
        if (fit === 0) {
          crowded += 1;
          continue;
        }
        const more = all.length - fit;
        chip.thumbs = { shown: all.slice(0, fit), more, width: fit * (edge + THUMB_GAP) + (more > 0 ? THUMB_MORE_W : 0) };
      }
      if (crowded > 0) {
        notes.push(`timeline PDF: ${crowded} scene${crowded === 1 ? '' : 's'} with pictures ${crowded === 1 ? 'is' : 'are'} too narrow at this scale to show one, so ${crowded === 1 ? 'its' : 'their'} pictures are left out`);
      }
    }
    thumbEdge = edge;
  }

  // Every text the file draws, to decide which fallback fonts to read.
  const texts: string[] = [input.title];
  for (const chip of chips) texts.push(chip.text, chip.sub);
  for (const tick of model.axis.ticks) texts.push(tick.label);
  for (const fold of model.axis.folds) texts.push(fold.label);
  for (const brk of model.axis.breaks) texts.push(brk.label);
  for (const lane of model.lanes) texts.push(lane.label);
  for (const page of pages) texts.push(labels.partName(page.part), lens.label(page.dayFrom, 'long'), lens.label(page.dayTo, 'long'), lens.name);
  texts.push('Undated scenes');

  const pdf = await PDFDocument.create({ updateMetadata: false });
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const builtIn = new Set(regular.getCharacterSet());
  const needs = fallbackNeeds(texts, builtIn);

  // The fallback fonts, read the first time a run needs one, as the contact sheet does.
  let fallback: CjkEmbedding | null | undefined;
  let fallbackError = '';
  const fallbackFont = async (): Promise<CjkEmbedding | null> => {
    if (fallback !== undefined) return fallback;
    fallback = null;
    if (input.loadFallbackFont === undefined) {
      fallbackError = 'this compile has no fallback font';
      return fallback;
    }
    try {
      const { cjkLoaderFor } = await import('@caotang/pdf-fonts/common');
      const load = cjkLoaderFor(input.loadFallbackFont, needs.cjk);
      fallback = new CjkEmbedding(lib, pdf, new CjkFace((await loadFont(load, 'the fallback font')) as unknown as FontkitFont, input.language));
    } catch (error) {
      fallbackError = `the fallback font could not be read (${error instanceof Error ? error.message : String(error)})`;
    }
    return fallback;
  };
  let emoji: EmojiEmbedding | null | undefined;
  let emojiError = '';
  const emojiFont = async (): Promise<EmojiEmbedding | null> => {
    if (emoji !== undefined) return emoji;
    emoji = null;
    if (input.loadEmojiFont === undefined) {
      emojiError = 'this compile has no emoji font';
      return emoji;
    }
    try {
      const { emojiLoaderFor } = await import('@caotang/pdf-fonts/common');
      const load = emojiLoaderFor(input.loadEmojiFont, needs.emoji);
      emoji = new EmojiEmbedding(lib, pdf, new EmojiFace((await loadFont(load, 'the emoji font')) as unknown as FontkitFont));
    } catch (error) {
      emojiError = `the emoji font could not be read (${error instanceof Error ? error.message : String(error)})`;
    }
    return emoji;
  };
  const rtl = new Map<RtlScript, RtlEmbedding | null>();
  const rtlErrors = new Map<RtlScript, string>();
  let tools: { readonly bidi: typeof Bidi; readonly shape: Shape } | undefined;
  const rtlFont = async (script: RtlScript): Promise<RtlEmbedding | null> => {
    const known = rtl.get(script);
    if (known !== undefined) return known;
    rtl.set(script, null);
    const load = script === 'arabic' ? input.loadArabicFont : input.loadHebrewFont;
    const name = script === 'arabic' ? 'Arabic' : 'Hebrew';
    if (load === undefined) {
      rtlErrors.set(script, `this compile has no ${name} font`);
      return null;
    }
    try {
      if (tools === undefined) {
        const shaper = await import('@caotang/pdf-fonts/shaper');
        tools = { bidi: await import('@caotang/pdf-fonts/bidi'), shape: shaper.shapeKeepingMarks(shaper.fontkitShape) };
      }
      const face = new RtlFace(script, (await loadFont(load, `the ${name} font`)) as unknown as FontkitFont, tools.shape);
      const embedding = new RtlEmbedding(lib, pdf, face);
      rtl.set(script, embedding);
      return embedding;
    } catch (error) {
      rtlErrors.set(script, `the ${name} font could not be read (${error instanceof Error ? error.message : String(error)})`);
      return null;
    }
  };
  let devanagari: DevanagariEmbedding | null | undefined;
  let devanagariError = '';
  const devanagariFont = async (): Promise<DevanagariEmbedding | null> => {
    if (devanagari !== undefined) return devanagari;
    devanagari = null;
    if (input.loadDevanagariFont === undefined) {
      devanagariError = 'this compile has no Devanagari font';
      return devanagari;
    }
    try {
      devanagari = new DevanagariEmbedding(lib, pdf, await DevanagariFace.load(input.loadDevanagariFont, input.language));
    } catch (error) {
      devanagariError = `the Devanagari font could not be read (${error instanceof Error ? error.message : String(error)})`;
    }
    return devanagari;
  };
  const missing = new Map<string, number>();
  const neededUnavailable = new Set<string>();

  const piecesOf = async (text: string): Promise<Piece[]> => {
    const pieces: Piece[] = [];
    for (const cluster of clustersOf(text.normalize('NFC'))) {
      const codes = [...cluster].map((char) => char.codePointAt(0) ?? 0);
      if (codes.length === 1 && isControl(codes[0] ?? 0)) {
        pieces.push({ text: ' ', face: 'base' });
        continue;
      }
      if (isBidiControl(cluster)) continue;
      const style = emojiStyleOf(cluster);
      if (style === 'emoji') {
        const loaded = await emojiFont();
        const glyphs = loaded === null ? null : loaded.face.glyphsOf(cluster);
        if (glyphs !== null) pieces.push({ text: cluster, face: 'emoji', glyphs });
        else {
          if (emoji === null) neededUnavailable.add('emoji');
          missing.set(cluster, (missing.get(cluster) ?? 0) + 1);
          pieces.push({ text: '?', face: 'base' });
        }
        continue;
      }
      const textCodes = codes.filter((code) => code !== VS15);
      if (textCodes.length > 0 && textCodes.every((code) => builtIn.has(code))) {
        pieces.push({ text: String.fromCodePoint(...textCodes), face: 'base' });
        continue;
      }
      const script = rtlFontPrints(String.fromCodePoint(codes[0] ?? 0));
      if (script !== undefined) {
        if ((await rtlFont(script)) !== null) {
          pieces.push({ text: cluster, face: script });
          continue;
        }
        neededUnavailable.add(script);
        missing.set(cluster, (missing.get(cluster) ?? 0) + 1);
        pieces.push({ text: '?', face: 'base' });
        continue;
      }
      if (devanagariFontPrints(String.fromCodePoint(codes[0] ?? 0))) {
        if ((await devanagariFont()) !== null) {
          pieces.push({ text: cluster, face: 'devanagari' });
          continue;
        }
        neededUnavailable.add('devanagari');
        missing.set(cluster, (missing.get(cluster) ?? 0) + 1);
        pieces.push({ text: '?', face: 'base' });
        continue;
      }
      const loaded = await fallbackFont();
      if (loaded !== null) {
        const kept = textCodes.filter((code) => loaded.face.covers(code) || !isJoinerOrSelector(code));
        const glyphs =
          kept.length > 0 && kept.every((code) => loaded.face.covers(code)) ? loaded.face.glyphsOf(String.fromCodePoint(...kept)) : null;
        if (glyphs !== null) {
          pieces.push({ text: String.fromCodePoint(...kept), face: 'cjk', glyphs: glyphs as Piece['glyphs'] });
          continue;
        }
      } else {
        neededUnavailable.add('cjk');
      }
      if (style === 'text') {
        const loaded = await emojiFont();
        const glyphs = loaded === null ? null : loaded.face.glyphsOf(String.fromCodePoint(...textCodes));
        if (glyphs !== null) {
          pieces.push({ text: cluster, face: 'emoji', glyphs });
          continue;
        }
        if (emoji === null) neededUnavailable.add('emoji');
      }
      missing.set(cluster, (missing.get(cluster) ?? 0) + 1);
      pieces.push({ text: '?', face: 'base' });
    }
    return pieces;
  };

  const runsOf = (pieces: readonly Piece[]): Piece[][] => {
    const runs: Piece[][] = [];
    for (const piece of pieces) {
      const last = runs[runs.length - 1];
      if (last !== undefined && last[0]?.face === piece.face) last.push(piece);
      else runs.push([piece]);
    }
    return runs;
  };

  const rtlWidth = (script: RtlScript, run: readonly Piece[], size: number): number => {
    const embedding = rtl.get(script);
    if (embedding === null || embedding === undefined) return 0;
    let width = 0;
    let loose: string[] = [];
    const settle = (): void => {
      for (const part of scriptRuns(loose)) {
        const word = embedding.face.shapeRun(part.text, 'rtl');
        if (word !== null) width += embedding.face.widthOf(word, size);
      }
      loose = [];
    };
    for (const piece of run) {
      if (piece.width === undefined) loose.push(piece.text);
      else {
        settle();
        width += piece.width;
      }
    }
    settle();
    return width;
  };

  const devanagariWidth = (run: readonly Piece[], base: PdfLib.PDFFont, size: number): number => {
    if (devanagari === null || devanagari === undefined) return 0;
    const word = devanagari.face.shapeRun(run.map((piece) => piece.text).join(''));
    return word === null ? base.widthOfTextAtSize('?'.repeat(run.length), size) : devanagari.face.widthOf(word, size);
  };

  const visualPieces = (pieces: readonly Piece[], size: number, dir: 'ltr' | 'rtl'): Piece[] => {
    if (tools === undefined || !pieces.some((piece) => piece.face === 'arabic' || piece.face === 'hebrew')) return [...pieces];
    const known = new Map<string, Piece>();
    for (const piece of pieces) if (!known.has(piece.text)) known.set(piece.text, piece);
    const unknown: Piece = { text: '?', face: 'base' };
    const out: Piece[] = [];
    for (const run of tools.bidi.visualRuns(pieces.map((piece) => piece.text).join(''), dir)) {
      const embedding = run.script === undefined ? undefined : rtl.get(run.script);
      if (run.kind === 'other' || run.script === undefined || embedding === null || embedding === undefined) {
        for (const cluster of clustersOf(run.text)) {
          const kept = known.has(cluster) ? undefined : [...cluster].filter((ch) => !isRtlMark(ch));
          if (kept === undefined) out.push(known.get(cluster) as Piece);
          else if (kept.length > 0 && kept.every((ch) => builtIn.has(ch.codePointAt(0) ?? 0))) out.push({ text: kept.join(''), face: 'base' });
          else out.push(unknown);
        }
        continue;
      }
      const word = embedding.face.shapeRun(run.source, run.level % 2 === 1 ? 'rtl' : 'ltr');
      if (word === null) {
        for (const cluster of clustersOf(run.source)) {
          missing.set(cluster, (missing.get(cluster) ?? 0) + 1);
          out.push(unknown);
        }
        continue;
      }
      out.push({ text: run.source, face: run.script, placed: word.glyphs, width: embedding.face.widthOf(word, size) });
    }
    return out;
  };

  const runWidth = (run: readonly Piece[], base: PdfLib.PDFFont, size: number): number => {
    const face = run[0]?.face ?? 'base';
    const glyphs = run.flatMap((piece) => piece.glyphs ?? []);
    if (face === 'emoji') return emoji ? emoji.face.widthOf(glyphs as readonly EmojiGlyph[], size) : 0;
    if (face === 'cjk') return fallback ? fallback.face.widthOf(glyphs as never, size) : 0;
    if (face === 'arabic' || face === 'hebrew') return rtlWidth(face, run, size);
    if (face === 'devanagari') return devanagariWidth(run, base, size);
    return base.widthOfTextAtSize(run.map((piece) => piece.text).join(''), size);
  };

  const drawPieces = (page: PdfLib.PDFPage, pieces: readonly Piece[], x: number, y: number, size: number, base: PdfLib.PDFFont, ink: Shade): void => {
    let at = x;
    for (const run of runsOf(pieces)) {
      const face = run[0]?.face ?? 'base';
      if (face === 'arabic' || face === 'hebrew') {
        const embedding = rtl.get(face);
        let pen = at;
        for (const piece of run) {
          if (embedding && piece.placed !== undefined) embedding.drawPlaced(page, piece.placed, pen, y, size, ink);
          pen += piece.width ?? 0;
        }
        at = pen;
        continue;
      }
      if (face === 'devanagari') {
        const typed = run.map((piece) => piece.text).join('');
        const word = devanagari?.face.shapeRun(typed) ?? null;
        if (devanagari && word !== null) devanagari.drawPlaced(page, word.glyphs, at, y, size, ink, typed);
        else page.drawText('?'.repeat(run.length), { x: at, y, size, font: base, color: color(ink) });
        at += devanagariWidth(run, base, size);
        continue;
      }
      const glyphs = run.flatMap((piece) => piece.glyphs ?? []);
      if (face === 'emoji' && emoji) emoji.draw(page, glyphs as readonly EmojiGlyph[], at, y, size, ink);
      else if (face === 'cjk' && fallback) fallback.draw(page, glyphs as never, at, y, size, ink);
      else page.drawText(run.map((piece) => piece.text).join(''), { x: at, y, size, font: base, color: color(ink) });
      at += runWidth(run, base, size);
    }
  };

  /**
   * Draws one line, cut with an ellipsis to `maxWidth` when it is wider, at `x`/`y` (the baseline). `align` places
   * the line's reading-start edge at `x` for `start`, its reading-end edge for `end`. `dir` is the paragraph
   * direction the bidirectional algorithm resolves the line in: the project language's for the page's own words.
   */
  const drawLine = async (
    page: PdfLib.PDFPage,
    text: string,
    x: number,
    y: number,
    size: number,
    options: { readonly bold?: boolean; readonly ink?: Shade; readonly maxWidth?: number; readonly dir?: 'ltr' | 'rtl'; readonly align?: 'start' | 'end' | 'middle' } = {},
  ): Promise<void> => {
    const dir = options.dir ?? 'ltr';
    const base = options.bold === true ? bold : regular;
    let pieces = visualPieces(await piecesOf(text), size, dir);
    if (options.maxWidth !== undefined) {
      let width = runsOf(pieces).reduce((sum, run) => sum + runWidth(run, base, size), 0);
      if (width > options.maxWidth) {
        const clusters = pieces;
        let keep = clusters.length;
        const cut = (count: number): Piece[] => {
          let end = count;
          while (end > 0 && /^\s+$/.test(clusters[end - 1]?.text ?? '')) end -= 1;
          return [...clusters.slice(0, end), { text: '…', face: 'base' }];
        };
        while (keep > 0) {
          const candidate = cut(keep);
          const w = runsOf(candidate).reduce((sum, run) => sum + runWidth(run, base, size), 0);
          if (w <= (options.maxWidth as number)) {
            pieces = candidate;
            width = w;
            break;
          }
          keep -= 1;
        }
        if (keep === 0) {
          pieces = [{ text: '…', face: 'base' }];
          width = base.widthOfTextAtSize('…', size);
        }
      }
      const align = options.align ?? 'start';
      const startX = align === 'start' ? x : align === 'end' ? x - width : x - width / 2;
      drawPieces(page, pieces, startX, y, size, base, options.ink ?? INK);
      return;
    }
    const width = runsOf(pieces).reduce((sum, run) => sum + runWidth(run, base, size), 0);
    const align = options.align ?? 'start';
    const startX = align === 'start' ? x : align === 'end' ? x - width : x - width / 2;
    drawPieces(page, pieces, startX, y, size, base, options.ink ?? INK);
  };

  pdf.setTitle(input.title);
  if (input.author !== undefined && input.author.trim() !== '') pdf.setAuthor(input.author.trim());
  pdf.setCreator('Caotang');
  pdf.setProducer('Caotang (pdf-lib)');
  pdf.setCreationDate(input.at);
  pdf.setModificationDate(input.at);

  // Each picture is read, shrunk and embedded once, however many chips draw it; one that cannot be is an empty frame and is named once.
  const thumbImages = new Map<string, PdfLib.PDFImage | null>();
  if (input.thumbnails !== undefined) {
    for (const chip of chips) {
      for (const picture of chip.thumbs?.shown ?? []) {
        if (thumbImages.has(picture.assetId)) continue;
        const made = await prepareThumbnail(picture, input.thumbnails);
        let image: PdfLib.PDFImage | null = null;
        let reason = made.ok ? '' : made.reason;
        if (made.ok) {
          try {
            image = made.mime === 'image/png' ? await pdf.embedPng(made.bytes) : await pdf.embedJpg(made.bytes);
          } catch (error) {
            reason = `${picture.file} could not be embedded (${error instanceof Error ? error.message : String(error)})`;
          }
        }
        if (image === null) notes.push(`timeline PDF: ${reason}, so its thumbnail is an empty frame`);
        thumbImages.set(picture.assetId, image);
      }
    }
  }

  // The x of an axis coordinate on a page: the content starts after the gutter on the reading-start side, and a
  // right-to-left book mirrors its geometry inside the page, so the page sequence stays reading order.
  const pageX = (pageFrom: number, x: number, w: number): number => {
    const inner = x - pageFrom;
    const startX = direction === 'ltr' ? MARGIN + GUTTER : MARGIN;
    return direction === 'ltr' ? startX + inner : startX + contentW - inner - w;
  };

  const tickXs: { day: number; label: string; level: 0 | 1 | 2 | 3; x: number; part: StoryPart }[] = [];
  for (const segment of model.axis.segments) {
    for (const tick of lens.ticks([segment.from, segment.to - 1], ppd * TICK_PX_TO_PT)) {
      tickXs.push({ day: tick.day, label: tick.label, level: tick.level, x: dayX(segment, tick.day), part: segment.part });
    }
  }

  for (const [index, pagePlan] of pages.entries()) {
    const page = pdf.addPage([pageW, pageH]);
    const y0 = pageH - MARGIN; // top
    // The tick row, repeated on every page.
    for (const tick of tickXs) {
      if (tick.x < pagePlan.from - 0.01 || tick.x >= pagePlan.to) continue;
      const x = pageX(pagePlan.from, tick.x, 0);
      page.drawLine({ start: { x, y: y0 - TICK_H + 6 }, end: { x, y: y0 - TICK_H + 12 }, thickness: tick.level === 0 ? 0.9 : 0.5, color: color(AXIS_LINE) });
      await drawLine(page, tick.label, x, y0 - 9, 7, { ink: MUTED, align: 'middle' });
    }
    // Part zones and separators.
    for (const segment of model.axis.segments) {
      const start = segX(segment);
      const end = dayX(segment, segment.to);
      if (end <= pagePlan.from || start >= pagePlan.to) continue;
      const x = pageX(pagePlan.from, Math.max(start, pagePlan.from), Math.min(end, pagePlan.to) - Math.max(start, pagePlan.from));
      page.drawRectangle({ x, y: laneY - 2, width: Math.max(pageX(pagePlan.from, Math.min(end, pagePlan.to), 0) - x, 0.1), height: laneH + (shelfCount > 0 ? 4 + rowH : 0), color: color(ZONE_FILL), borderColor: color(ZONE_LINE), borderWidth: 0.5 });
      await drawLine(page, labels.partName(segment.part), pageX(pagePlan.from, Math.max(start, pagePlan.from), 0) + 3, laneY + laneH - 4, 8, { bold: true, ink: MUTED });
    }
    for (const fold of model.axis.folds) {
      const segment = model.axis.segments[fold.segment];
      if (segment === undefined) continue;
      const x = segX(segment) - FOLD_W;
      if (x + FOLD_W <= pagePlan.from || x >= pagePlan.to) continue;
      const px = pageX(pagePlan.from, Math.max(x, pagePlan.from), FOLD_W);
      page.drawRectangle({ x: px, y: laneY - 2, width: FOLD_W, height: laneH + 2, color: color(FOLD_FILL), borderColor: color(ZONE_LINE), borderWidth: 0.5 });
      await drawLine(page, fold.label, px + FOLD_W / 2, laneY + laneH / 2, 7, { ink: INK, align: 'middle' });
    }
    for (const brk of model.axis.breaks) {
      const segment = model.axis.segments[brk.segment];
      if (segment === undefined) continue;
      const x = segX(segment) - BREAK_W;
      if (x + BREAK_W <= pagePlan.from || x >= pagePlan.to) continue;
      const px = pageX(pagePlan.from, Math.max(x, pagePlan.from), BREAK_W);
      page.drawRectangle({ x: px, y: laneY - 2, width: BREAK_W, height: laneH + 2, color: color(BREAK_FILL), borderColor: color(ZONE_LINE), borderWidth: 0.5 });
      await drawLine(page, brk.label, px + BREAK_W / 2, laneY + laneH / 2, 6.5, { ink: MUTED, align: 'middle' });
    }
    // The lane gutter, on the reading-start side.
    const gutterX = direction === 'ltr' ? MARGIN : MARGIN + GUTTER + contentW;
    for (const lane of model.lanes) {
      await drawLine(page, lane.label, gutterX, laneY + laneH / 2, 8, { ink: MUTED, align: direction === 'ltr' ? 'start' : 'end' });
    }
    if (shelfCount > 0) {
      await drawLine(page, 'Undated scenes', gutterX, shelfY + rowH / 2, 8, { ink: MUTED, align: direction === 'ltr' ? 'start' : 'end' });
    }
    // Connectors, clipped to the page's x range.
    const boxOf = new Map(chips.map((chip) => [chip.key, chip.box] as const));
    for (const connector of model.connectors) {
      const from = boxOf.get(connector.from);
      const to = boxOf.get(connector.to);
      if (from === undefined || to === undefined) continue;
      const y1 = from.y + from.h / 2;
      const y2 = to.y + to.h / 2;
      const x1 = direction === 'ltr' ? from.x + from.w : from.x;
      const x2 = direction === 'ltr' ? to.x : to.x + to.w;
      // Clip the segment to [pageFrom, pageTo) in axis x.
      const lo = Math.max(Math.min(x1, x2), pagePlan.from);
      const hi = Math.min(Math.max(x1, x2), pagePlan.to);
      if (hi <= lo) continue;
      const t = (x: number): number => (x2 === x1 ? 0 : (x - x1) / (x2 - x1));
      const cx1 = pageX(pagePlan.from, lo, 0);
      const cx2 = pageX(pagePlan.from, hi, 0);
      const cy1 = y1 + (y2 - y1) * t(lo);
      const cy2 = y2 + (y2 - y1) * t(hi);
      page.drawLine({
        start: { x: cx1, y: cy1 },
        end: { x: cx2, y: cy2 },
        thickness: 0.7,
        color: color(connector.kind === 'finding' ? FINDING_LINE : connector.kind === 'thread' ? THREAD_LINE : AXIS_LINE),
        ...(connector.kind === 'thread' || connector.violation === true || connector.cycle === true ? { dashArray: [3, 2] } : {}),
      });
    }
    // The chips on this page.
    for (const chip of chips) {
      if (chip.box.x + chip.box.w <= pagePlan.from + 0.01 || chip.box.x >= pagePlan.to - 0.01) continue;
      const x = pageX(pagePlan.from, chip.box.x, chip.box.w);
      const onShelf = chip.box.y >= shelfY;
      page.drawRectangle({
        x,
        y: chip.box.y,
        width: chip.box.w,
        height: chip.box.h,
        color: onShelf ? undefined : color(CHIP_FILL),
        borderColor: color(CHIP_FILL),
        borderWidth: 0.7,
        ...(onShelf ? { dashArray: [2, 2] } : {}),
      });
      const label = chip.sub === '' ? chip.text : `${chip.text} · ${chip.sub}`;
      const chipInk: Shade = onShelf ? INK : { r: 1, g: 1, b: 1 };
      const thumbs = chip.thumbs;
      await drawLine(page, label, direction === 'ltr' ? x + 2 : x + chip.box.w - 2, chip.box.y + chip.box.h / 2 - 3, 7, {
        ink: chipInk,
        maxWidth: chip.box.w - 4 - (thumbs?.width ?? 0),
        align: direction === 'ltr' ? 'start' : 'end',
        dir: direction,
      });
      if (thumbs !== undefined) {
        // The pictures sit at the reading-end of the chip, the first nearest the title; "+N" is the last thing in reading order.
        const step = thumbEdge + THUMB_GAP;
        const stripStart = direction === 'ltr' ? x + chip.box.w - 2 - thumbs.width : x + 2;
        const moreW = thumbs.more > 0 ? THUMB_MORE_W : 0;
        const slotX = (at: number): number =>
          direction === 'ltr' ? stripStart + at * step : stripStart + moreW + (thumbs.shown.length - 1 - at) * step;
        const slotY = chip.box.y + (chip.box.h - thumbEdge) / 2;
        for (const [at, picture] of thumbs.shown.entries()) {
          const image = thumbImages.get(picture.assetId) ?? null;
          if (image === null) {
            page.drawRectangle({ x: slotX(at), y: slotY, width: thumbEdge, height: thumbEdge, borderColor: color(chipInk), borderWidth: 0.5, borderDashArray: [1.5, 1.5] });
            continue;
          }
          const scale = Math.min(thumbEdge / image.width, thumbEdge / image.height);
          const w = image.width * scale;
          const h = image.height * scale;
          page.drawImage(image, { x: slotX(at) + (thumbEdge - w) / 2, y: slotY + (thumbEdge - h) / 2, width: w, height: h });
        }
        if (thumbs.more > 0) {
          const moreX = direction === 'ltr' ? stripStart + thumbs.shown.length * step : stripStart;
          await drawLine(page, `+${thumbs.more}`, moreX, chip.box.y + chip.box.h / 2 - 2.5, THUMB_MORE_SIZE, { ink: chipInk });
        }
      }
    }
    // The footer: part, day span, page count, lens. The catalogues group digits ("Day 4,380"), as timeline.md §8's example does.
    const daySpan = pagePlan.dayFrom === pagePlan.dayTo ? lens.label(pagePlan.dayFrom, 'long') : `${lens.label(pagePlan.dayFrom, 'long')}–${lens.label(pagePlan.dayTo, 'long')}`;
    const footer = `${labels.partName(pagePlan.part)} · ${daySpan} · page ${index + 1} of ${pages.length} · ${lens.name} lens`;
    await drawLine(page, footer, direction === 'ltr' ? MARGIN : pageW - MARGIN, MARGIN + 6, 7.5, { ink: MUTED, align: direction === 'ltr' ? 'start' : 'end', dir: direction });
  }

  for (const [cluster, count] of [...missing].sort((a, b) => a[0].localeCompare(b[0]))) {
    notes.push(`the character ${cluster} has no font this compile can read, so it is drawn as “?” (${count} time${count === 1 ? '' : 's'})`);
  }
  for (const font of neededUnavailable) {
    const reason = font === 'cjk' ? fallbackError : font === 'emoji' ? emojiError : font === 'devanagari' ? devanagariError : rtlErrors.get(font as RtlScript);
    notes.push(`the ${font} font is needed but unavailable: ${reason ?? 'no loader'}`);
  }

  // The embedded fonts are written last, as the contact sheet writes them: without this the Type 0 fonts have no
  // subset program and no ToUnicode map, and a reader cannot give the text back.
  if (emoji?.used === true) await emoji.finish();
  if (fallback?.used === true) await fallback.finish();
  for (const embedding of rtl.values()) if (embedding?.used === true) await embedding.finish();
  if (devanagari?.used === true) await devanagari.finish();

  const contents = await pdf.save({ useObjectStreams: false });
  return { contents, notes, pages: pages.length };
}
