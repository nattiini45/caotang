/**
 * The paper round trip's numbered photo return — [comics.md §3.4](../../../docs/architecture/comics.md).
 *
 * A printed page is photographed and the photograph comes back as a file named by its page: `0012.jpg` is page 12.
 * The photograph is never read — no OCR, no matching by content — so the file's own name is the only thing that says
 * which page it belongs to. This module is that mapping, pure and refusal-first: a batch with a duplicate number, a
 * number the book has no page for, or a file with no number at all is refused whole, before anything is imported,
 * and the caller says which files and why.
 *
 * The photograph itself stays a page-level source (an `asset` link of role `source` on the page node); the panels
 * that show it name the same picture as their `assetId` with a `crop`, which is the recorded source-to-panel mapping.
 * {@link proposedPanelCrop} is only the proposal the editor shows over the photograph — the writer confirms or
 * adjusts it, and the stored crop is what the writer left.
 */

import { pageGeometry } from './layout.js';
import type { Rect } from './model.js';

/** The page number a file name carries: leading digits followed by an extension, `0012.jpg` → 12. */
const NUMBERED_NAME = /^(\d+)\.[^.]+$/;

/** The page number of a photographed page's file name, or `undefined` when the name carries none. `0000.jpg` is page 0, which no book has. */
export function pageNumberOfFileName(name: string): number | undefined {
  const match = NUMBERED_NAME.exec(name);
  if (match === null) return undefined;
  const value = Number.parseInt(match[1] ?? '0', 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export type PhotoReturnRefusalReason = 'no-number' | 'duplicate-page' | 'no-such-page';

export interface PhotoReturnRefusal {
  readonly name: string;
  readonly reason: PhotoReturnRefusalReason;
  /** The number the file named, when it named one. */
  readonly pageNumber?: number;
}

export interface PhotoReturnAssignment {
  readonly name: string;
  readonly pageNumber: number;
}

export type PhotoReturnPlan =
  | { readonly ok: true; readonly assignments: readonly PhotoReturnAssignment[] }
  | { readonly ok: false; readonly refusals: readonly PhotoReturnRefusal[] };

/**
 * Plans one batch of photographs against a book's page count. All or nothing: any refusal refuses the whole batch,
 * and every refused file is named with its reason, so the writer can rename and drop again. The assignments come
 * back in page order, so one batch lands in one reviewed step.
 */
export function planPhotoReturn(names: readonly string[], pageCount: number): PhotoReturnPlan {
  const refusals: PhotoReturnRefusal[] = [];
  const taken = new Set<number>();
  const assignments: PhotoReturnAssignment[] = [];
  for (const name of names) {
    const number = pageNumberOfFileName(name);
    if (number === undefined) {
      refusals.push({ name, reason: 'no-number' });
      continue;
    }
    if (number < 1 || number > pageCount) {
      refusals.push({ name, reason: 'no-such-page', pageNumber: number });
      continue;
    }
    if (taken.has(number)) {
      refusals.push({ name, reason: 'duplicate-page', pageNumber: number });
      continue;
    }
    taken.add(number);
    assignments.push({ name, pageNumber: number });
  }
  if (refusals.length > 0) return { ok: false, refusals };
  assignments.sort((a, b) => a.pageNumber - b.pageNumber);
  return { ok: true, assignments };
}

const MIN_CROP = 0.02;

/** Clamps a rect into 0..1 of its own space, keeping a minimum size, so a stored crop always validates. */
export function clampUnitRect(rect: readonly number[]): Rect {
  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
  const x = clamp01(rect[0] ?? 0);
  const y = clamp01(rect[1] ?? 0);
  const w = Math.min(Math.max(rect[2] ?? 0, MIN_CROP), 1 - x);
  const h = Math.min(Math.max(rect[3] ?? 0, MIN_CROP), 1 - y);
  return [x, y, Math.max(w, MIN_CROP), Math.max(h, MIN_CROP)];
}

/**
 * The crop a panel proposes over a page photograph: the photograph is framed on the page's trim, so the panel's
 * live-area rectangle maps through the live margin into the picture's own 0..1 space. A proposal only — the writer
 * confirms or adjusts it in the editor, and the stored crop is what they left.
 */
export function proposedPanelCrop(panelRect: Rect, size: string): Rect {
  const geometry = pageGeometry(size);
  const [x, y, w, h] = panelRect;
  return clampUnitRect([
    (geometry.liveMarginMm + x * geometry.liveWidthMm) / geometry.trimWidthMm,
    (geometry.liveMarginMm + y * geometry.liveHeightMm) / geometry.trimHeightMm,
    (w * geometry.liveWidthMm) / geometry.trimWidthMm,
    (h * geometry.liveHeightMm) / geometry.trimHeightMm,
  ]);
}
