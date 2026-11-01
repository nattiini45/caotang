/**
 * The pictures the timeline shows ([timeline.md §9.1](docs/architecture/timeline.md), [pictures.md §9](docs/architecture/pictures.md)):
 * the pictures placed on a scene (thumbnails on its bar, at most three and a count of the rest), the day pins (`AssetLink.when`) with
 * the zone each belongs to and where its marker stands, the keys and the drag that move a pin, and the portrait a codex character
 * keeps (`visualRefs`) for its lane.
 *
 * Pure reads of the project and of the timeline model, no React and no writes. Moving a pin is a row in the tray (`proposePin` in
 * `timeline-proposals.ts`), applied as a `picture-when` op of `timeline.apply`, never from here.
 */

import { linksOf, type ReadAssetLink, type ReadAssetRecord } from '@caotang/pictures';
import type { ProjectState } from '@caotang/store';
import type { StoryPart, TimelineModel } from '@caotang/timeline';

import { altOf, pictureLabelOf } from '../media/picture-board-model.js';

import { dayAtX, mirroredX, xOfDay, type DayFrame } from './timeline-edit-model.js';
import { moveOfKey, type Rect } from './timeline-model.js';

/** The most thumbnails one bar carries; the rest are counted as "+N" (timeline.md §9.1). */
export const BAR_PICTURES_MAX = 3;

/** The width of one thumbnail on a bar, and the gap after it. */
export const THUMB_PX = 20;
const THUMB_STEP_PX = THUMB_PX + 2;

/** The width kept for the count of the pictures that did not fit. */
const MORE_PX = 22;

/** The width the scene's title keeps before a thumbnail may take the room. */
export const BAR_TITLE_MIN_PX = 56;

/** A pin marker's edge, and the most rows of markers above the axis. */
export const PIN_PX = 22;
export const PIN_ROWS_MAX = 2;

/** The space above the first pin row, and below the last. */
const PIN_TOP_PX = 3;

type AnyLink = ReadAssetLink;

/** One picture placed on a scene, with the words it is shown with. */
export interface ScenePicture {
  readonly linkId: string;
  readonly assetId: string;
  readonly role: string;
  /** The name the picture goes by: its caption, else its alt text, else its file. */
  readonly label: string;
  /** The alt text to show it with: empty for a decorative picture. */
  readonly alt: string;
  readonly record: ReadAssetRecord;
}

/** A placement and the record of its picture, or `undefined` when the registry has no record for it. */
function pictureOfLink(link: AnyLink, records: ReadonlyMap<string, ReadAssetRecord>): ScenePicture | undefined {
  const record = records.get(link.assetId);
  if (record === undefined) return undefined;
  return { linkId: link.id, assetId: link.assetId, role: String(link.role), label: pictureLabelOf(record), alt: altOf(record), record };
}

export interface PictureIndex {
  /** The pictures on a scene: its card first, then the references, each in the order the writer gave them. A transcription's source page is not one. */
  readonly of: (nodeId: string) => readonly ScenePicture[];
  readonly record: (assetId: string) => ReadAssetRecord | undefined;
}

/**
 * The project's pictures read once, so a view can ask for each visible bar without scanning the registry again. Links whose picture
 * has no record are left out: there is nothing to show, and the Picture board is where that is mended.
 */
export function pictureIndex(state: Pick<ProjectState, 'manifest'>): PictureIndex {
  const records = new Map<string, ReadAssetRecord>((state.manifest.assets ?? []).map((record) => [record.id, record]));
  const links = (state.manifest.assetLinks ?? []) as readonly AnyLink[];
  const cache = new Map<string, readonly ScenePicture[]>();
  return {
    record: (assetId) => records.get(assetId),
    of: (nodeId) => {
      const held = cache.get(nodeId);
      if (held !== undefined) return held;
      const own = linksOf(links, { kind: 'node', nodeId }).filter((link) => link.role === 'card' || link.role === 'reference');
      const ordered = [...own.filter((link) => link.role === 'card'), ...own.filter((link) => link.role !== 'card')];
      const pictures = ordered.flatMap((link) => pictureOfLink(link, records) ?? []);
      cache.set(nodeId, pictures);
      return pictures;
    },
  };
}

/** How many thumbnails a bar of this width carries, counting the room "+N" takes when some are left out. */
export function thumbsFit(widthPx: number, total: number): number {
  for (let count = Math.min(BAR_PICTURES_MAX, total); count >= 1; count -= 1) {
    const taken = count * THUMB_STEP_PX + (total > count ? MORE_PX : 0);
    if (widthPx - taken >= BAR_TITLE_MIN_PX) return count;
  }
  return 0;
}

export interface BarPictures {
  readonly shown: readonly ScenePicture[];
  /** The pictures not shown, said as "+N". Zero when none is shown at all: a bar too narrow for a thumbnail names none. */
  readonly more: number;
}

/** The thumbnails a bar of this width carries: at most {@link BAR_PICTURES_MAX}, and "+N" for the rest. */
export function barPictures(pictures: readonly ScenePicture[], widthPx: number): BarPictures {
  const fit = thumbsFit(widthPx, pictures.length);
  if (fit === 0) return { shown: [], more: 0 };
  return { shown: pictures.slice(0, fit), more: pictures.length - fit };
}

/* ------------------------------------------------------------------ *
 * Day pins
 * ------------------------------------------------------------------ */

/** A picture that marks a day: a placement whose `when` has one. */
export interface PicturePin {
  readonly linkId: string;
  readonly assetId: string;
  readonly day: number;
  /** The pin's own label, which a move keeps. */
  readonly label?: string;
  /** The zone the pin stands in: the part of the nearest scene, or the main story when no scene has a day. */
  readonly part: StoryPart;
  /** The binder item the picture is placed on, when it is placed on one. */
  readonly nodeId?: string;
  readonly name: string;
  readonly alt: string;
  readonly record: ReadAssetRecord;
}

const PART_RANK: Readonly<Record<StoryPart, number>> = { prologue: 0, main: 1, epilogue: 2 };

/**
 * The part whose zone a pin at `day` stands in: the part of the scene whose days are nearest (a day inside a scene's window is at
 * distance zero), the scene the picture is placed on winning a tie, then the earlier part. The main story when no scene has a day, so
 * a pin is never left without a zone.
 */
export function partForDay(model: Pick<TimelineModel, 'items'>, day: number, preferNodeId?: string): StoryPart {
  let best: { part: StoryPart; distance: number; preferred: boolean } | undefined;
  for (const item of model.items) {
    if (item.start === undefined || item.end === undefined) continue;
    const distance = day < item.start ? item.start - day : day >= item.end ? day - item.end + 1 : 0;
    const preferred = item.nodeId === preferNodeId;
    const better =
      best === undefined ||
      distance < best.distance ||
      (distance === best.distance && ((preferred && !best.preferred) || (preferred === best.preferred && PART_RANK[item.part] < PART_RANK[best.part])));
    if (better) best = { part: item.part, distance, preferred };
  }
  return best?.part ?? 'main';
}

/** The pins of the project, earliest day first. A pin that holds a label and no day is not a place on the axis and is left out. */
export function picturePins(state: Pick<ProjectState, 'manifest'>, model: Pick<TimelineModel, 'items'>): PicturePin[] {
  const index = pictureIndex(state);
  const pins: PicturePin[] = [];
  for (const link of (state.manifest.assetLinks ?? []) as readonly AnyLink[]) {
    const day = link.when?.dayOffset;
    if (day === undefined || !Number.isSafeInteger(day)) continue;
    const record = index.record(link.assetId);
    if (record === undefined) continue;
    const target = link.target as { readonly kind: string; readonly nodeId?: unknown };
    const nodeId = typeof target.nodeId === 'string' && (target.kind === 'node' || target.kind === 'paragraph') ? target.nodeId : undefined;
    pins.push({
      linkId: link.id,
      assetId: link.assetId,
      day,
      ...(link.when?.label === undefined ? {} : { label: link.when.label }),
      part: partForDay(model, day, nodeId),
      ...(nodeId === undefined ? {} : { nodeId }),
      name: pictureLabelOf(record),
      alt: altOf(record),
      record,
    });
  }
  return pins.sort((a, b) => a.day - b.day || (a.linkId < b.linkId ? -1 : a.linkId > b.linkId ? 1 : 0));
}

/** The name a pin or a tray row calls a picture: its caption, else its alt text, else its file; the asset id when the registry has none. */
export function pictureNameOf(state: Pick<ProjectState, 'manifest'>, assetId: string): string {
  const record = (state.manifest.assets ?? []).find((candidate) => candidate.id === assetId);
  return record === undefined ? assetId : pictureLabelOf(record);
}

/** The unmirrored x of the middle of a pin's day, or `undefined` when the axis has no run to put it on. */
export function pinCenter(frames: readonly DayFrame[], pin: Pick<PicturePin, 'day' | 'part'>, pxPerDay: number): number | undefined {
  const left = xOfDay(frames, pin.part, pin.day, pxPerDay);
  return left === undefined ? undefined : left + pxPerDay / 2;
}

export interface PinSlots {
  /** The marker row of each pin, from zero. */
  readonly rowOf: ReadonlyMap<string, number>;
  /** The rows used, at most `rowsMax`. */
  readonly rows: number;
}

/**
 * Puts markers in as few rows as keep them apart: each takes the first row whose last marker ends before it begins, and the last row
 * takes the overlap when every row is full, so a crowded day still shows each pin. The centres are in one direction only, so the
 * same packing serves a right-to-left axis once its boxes are mirrored.
 */
export function packPins(centers: readonly { readonly key: string; readonly center: number }[], size: number = PIN_PX, rowsMax: number = PIN_ROWS_MAX): PinSlots {
  const ends: number[] = [];
  const rowOf = new Map<string, number>();
  for (const entry of [...centers].sort((a, b) => a.center - b.center || (a.key < b.key ? -1 : 1))) {
    const left = entry.center - size / 2;
    let row = ends.findIndex((end) => end <= left);
    if (row === -1) row = ends.length < rowsMax ? ends.length : rowsMax - 1;
    ends[row] = left + size;
    rowOf.set(entry.key, row);
  }
  return { rowOf, rows: Math.max(1, ends.length) };
}

/**
 * The box of a pin marker in canvas coordinates: centred on the day's middle, in its row above the axis. `center` is the unmirrored
 * x of {@link pinCenter}; the layout is mirrored once for a right-to-left book, like every other box (timeline.md §3.2).
 */
export function pinRect(center: number, row: number, geometryWidth: number, direction: 'ltr' | 'rtl', ox: number): Rect {
  return { x: ox + mirroredX(center - PIN_PX / 2, PIN_PX, geometryWidth, direction), y: PIN_TOP_PX + row * PIN_PX, w: PIN_PX, h: PIN_PX };
}

/** The height the pin rows add above the axis's header, or zero when there are no pins. */
export function pinBandPx(rows: number): number {
  return rows <= 0 ? 0 : rows * PIN_PX + PIN_TOP_PX * 2;
}

/* ------------------------------------------------------------------ *
 * Moving a pin
 * ------------------------------------------------------------------ */

export interface PinKeyFacts {
  readonly key: string;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  /** The pin is marked (Space), so the plain arrows move it. */
  readonly selected: boolean;
}

/**
 * The days a key moves a pin: one, seven with Shift, toward the **interface's** start for the earlier day (timeline.md §3.2). A marked
 * pin moves on the plain arrows; an unmarked one only on Alt and an arrow, so passing over a pin with the arrows moves nothing.
 */
export function pinKeyDelta(facts: PinKeyFacts, rtlUi: boolean): number | null {
  if (facts.ctrl || facts.meta || (!facts.selected && !facts.alt)) return null;
  const move = moveOfKey(facts.key, false, rtlUi);
  if (move !== 'earlier' && move !== 'later') return null;
  const size = facts.shift ? 7 : 1;
  return move === 'earlier' ? -size : size;
}

/**
 * The day a pin dragged to an unmirrored x lands on, within its own part's runs; `undefined` when the axis has no run. A marker is
 * centred on its day, so the pointer picks the day whose middle is nearest, not the day whose left edge is.
 */
export function pinDragDay(frames: readonly DayFrame[], pxPerDay: number, pin: Pick<PicturePin, 'part'>, x: number): number | undefined {
  return dayAtX(frames, x - pxPerDay / 2, pxPerDay, pin.part);
}

/* ------------------------------------------------------------------ *
 * Character portraits
 * ------------------------------------------------------------------ */

/** The picture a codex entry keeps as its portrait: its first visual reference that the registry has a record for. */
export function portraitOf(state: Pick<ProjectState, 'manifest'>, codexId: string): ReadAssetRecord | undefined {
  const entry = (state.manifest.codex ?? []).find((candidate) => candidate.id === codexId);
  const records = state.manifest.assets ?? [];
  for (const ref of entry?.visualRefs ?? []) {
    const record = records.find((candidate) => candidate.id === ref);
    if (record !== undefined) return record;
  }
  return undefined;
}
