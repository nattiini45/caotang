/**
 * Scene info's pure rules (modern-interface.md §7.5, §8.2, §8.3): where the popover goes beside its opener, how it enters, and the
 * **Keep open** preference. No DOM here, so the rules are unit-tested (apps/desktop/test/scene-info-model.test.ts); scene-info.tsx
 * applies them.
 */

/** Scene info's element id, for an opener's `aria-controls`. */
export const SCENE_INFO_ID = 'modern-scene-info';

/** Where **Keep open** is kept: `'docked'`, or no key (a popover). A view preference of this browser, like the binder's pin. */
export const SCENE_INFO_DOCKED_KEY = 'caotang.modern.sceneInfoDocked';

/** The popover's width, its distance from the opener, and the room it keeps from the window's edges, in CSS px. */
export const POPOVER_WIDTH = 400;
export const POPOVER_GAP = 12;
export const VIEWPORT_MARGIN = 16;
/** Below this much room under the opener, the popover opens above it when there is more room there. */
export const POPOVER_MIN_ROOM = 280;

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** The popover's place, in viewport px: `top` when it opens below the opener, `bottom` (from the window's foot) when above. */
export interface Placement {
  readonly side: 'below' | 'above';
  readonly left: number;
  readonly top: number | null;
  readonly bottom: number | null;
  readonly width: number;
  readonly maxHeight: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/**
 * The popover anchored to its opener, flipped and clamped into the viewport (§8.2): centred under the opener, above it when the room
 * below is short and the room above is larger, never past a window edge. With no opener (a route opened it and no opener is drawn) it
 * sits at the top centre, where the title capsule is.
 */
export function placePopover(anchor: Box | null, viewport: Viewport): Placement {
  const width = Math.max(0, Math.min(POPOVER_WIDTH, viewport.width - 2 * VIEWPORT_MARGIN));
  if (anchor === null) {
    const top = Math.max(84, Math.round(viewport.height * 0.11));
    return {
      side: 'below',
      left: Math.round((viewport.width - width) / 2),
      top,
      bottom: null,
      width,
      maxHeight: Math.max(0, viewport.height - top - VIEWPORT_MARGIN),
    };
  }
  const centre = anchor.left + anchor.width / 2;
  const left = Math.round(clamp(centre - width / 2, VIEWPORT_MARGIN, viewport.width - VIEWPORT_MARGIN - width));
  const below = viewport.height - (anchor.top + anchor.height) - POPOVER_GAP - VIEWPORT_MARGIN;
  const above = anchor.top - POPOVER_GAP - VIEWPORT_MARGIN;
  if (below < POPOVER_MIN_ROOM && above > below) {
    return { side: 'above', left, top: null, bottom: Math.round(viewport.height - anchor.top + POPOVER_GAP), width, maxHeight: Math.max(0, above) };
  }
  return { side: 'below', left, top: Math.round(anchor.top + anchor.height + POPOVER_GAP), bottom: null, width, maxHeight: Math.max(0, below) };
}

/** A CSS time (`520ms`, `0.52s`, `0s`) in milliseconds; 0 for anything unreadable. */
export function durationMs(value: string): number {
  const match = /^\s*(-?[\d.]+)\s*(ms|s)\s*$/.exec(value);
  if (match === null) return 0;
  const amount = Number.parseFloat(match[1] ?? '0');
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return match[2] === 's' ? amount * 1000 : amount;
}

/**
 * How Scene info enters (§8.3): a morph out of its opener while `--dur-3` is above zero, a fade in place otherwise. Reduced motion,
 * from the system or the Appearance switch, sets every duration to 0 (tokens/modern.css), so the fade is what it gets; with no
 * opener to grow from it fades too.
 */
export function entranceOf(openMs: number, hasAnchor: boolean): 'morph' | 'fade' {
  return openMs > 0 && hasAnchor ? 'morph' : 'fade';
}

/**
 * The first frame of the morph: the transform that puts the popover over its opener's box (FLIP). The popover's transform origin is
 * its top-left corner (scene-info.css), so the translation is between top-left corners and the scale is the boxes' ratio.
 */
export function morphFrom(anchor: Box, target: Box): string {
  const sx = target.width === 0 ? 1 : anchor.width / target.width;
  const sy = target.height === 0 ? 1 : anchor.height / target.height;
  const dx = anchor.left - target.left;
  const dy = anchor.top - target.top;
  const translate = `translate(${round(dx)}px,${round(dy)}px)`;
  const scale = `scale(${round(sx, 4)},${round(sy, 4)})`;
  return [translate, scale].join(' ');
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** The part of `Storage` the preference uses. */
export type DockStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function local(): DockStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Whether **Keep open** is on; off when nothing is kept or the store cannot be read. */
export function readDocked(store: DockStore | null = local()): boolean {
  try {
    return store?.getItem(SCENE_INFO_DOCKED_KEY) === 'docked';
  } catch {
    return false;
  }
}

/** Keeps **Keep open**; a store that refuses only loses the memory, not the switch. */
export function writeDocked(on: boolean, store: DockStore | null = local()): void {
  try {
    if (on) store?.setItem(SCENE_INFO_DOCKED_KEY, 'docked');
    else store?.removeItem(SCENE_INFO_DOCKED_KEY);
  } catch {
    // Not kept: the switch applies to this visit only.
  }
}
