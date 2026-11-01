/**
 * The companion window's pure rules (modern-interface.md §8.3, §8.4, §8.10): where it sits at a width, and the morph's keyframes from
 * the control that opened it. No DOM and no React, so the unit specs read them directly.
 */

/** The window's width beside the page, in CSS px. */
export const COMPANION_WIDTH = 400;
/** The gap between the window and the stage's edge, and between the window and the page. */
export const COMPANION_GUTTER = 32;
/** From this width down (inclusive) the window overlaps the page as a sheet with a scrim, instead of pushing it (§8.4). */
export const COMPANION_SHEET_MAX = 1280;
/** Below this width (`NARROW_QUERY`, 959 px and less) the window is a full-width sheet (§13). */
export const COMPANION_NARROW_BELOW = 960;
/** How far the page recedes while the window is open (§8.10); `1` under reduced motion. */
export const PAGE_RECEDE = 0.985;

/** How the window sits: beside the page (which moves over), over it as a sheet, or as a full-width sheet in a narrow window. */
export type CompanionPlacement = 'beside' | 'sheet' | 'full';

export function companionPlacement(viewportWidth: number): CompanionPlacement {
  if (viewportWidth < COMPANION_NARROW_BELOW) return 'full';
  return viewportWidth <= COMPANION_SHEET_MAX ? 'sheet' : 'beside';
}

/**
 * The room the open window takes from the page at the inline-end edge (`StageGeometry.areaEnd`): the window and a gutter beside the
 * page, nothing as a sheet (it overlaps) or while closed. #306's `modernLayout` reads this for its `agent` input.
 */
export function companionAreaEnd(viewportWidth: number, open: boolean): number {
  return open && companionPlacement(viewportWidth) === 'beside' ? COMPANION_WIDTH + COMPANION_GUTTER : 0;
}

/** A rectangle in viewport px, as `getBoundingClientRect` gives it. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** One keyframe of the morph: a transform from the window's own place, and its opacity. */
export type MorphFrame = {
  readonly transform: string;
  readonly transformOrigin: string;
  readonly opacity: number;
};

/**
 * The FLIP keyframes that grow the window out of its opener (§8.3): the first frame puts the window over the opener's rectangle, the
 * last leaves it where it is. Reversed, they shrink it back. Physical px, because both rectangles are; the origin is the window's
 * physical top-left corner, so the arithmetic holds in a right-to-left interface too. `null` when either box has no size (an opener
 * that is hidden or gone), so the caller fades instead.
 */
export function morphFrames(from: Box, to: Box): readonly [MorphFrame, MorphFrame] | null {
  if (!(from.width > 0 && from.height > 0 && to.width > 0 && to.height > 0)) return null;
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  const dx = round(from.left - to.left);
  const dy = round(from.top - to.top);
  const sx = round(from.width / to.width);
  const sy = round(from.height / to.height);
  return [
    { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, transformOrigin: '0 0', opacity: 0.4 },
    { transform: 'none', transformOrigin: '0 0', opacity: 1 },
  ];
}

/** A CSS time token's value in ms (`'520ms'`, `'0.24s'`, `'0s'`); `0` for anything unreadable. */
export function durationMs(value: string): number {
  const match = /^\s*(-?[\d.]+)(ms|s)\s*$/.exec(value);
  if (match === null) return 0;
  const amount = Number.parseFloat(match[1] ?? '');
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return match[2] === 's' ? amount * 1000 : amount;
}
