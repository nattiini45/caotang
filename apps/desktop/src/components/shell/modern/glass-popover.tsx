/**
 * `GlassPopover` (modern-interface.md §8.2, §8.3): a thick-glass surface anchored to the control that opened it. It is placed by
 * script, through the CSSOM (§11; CSS anchor positioning is not in every engine the suite runs): below its opener, or above it when it
 * does not fit there (flip), and clamped into the window. It grows out of its opener and shrinks back into it (`morph`).
 *
 * One at a time, and closed by a click outside, by Escape, or by its opener (which toggles it); focus goes back to the opener as it
 * closes (decisions.md, "Panels return focus to their opener"), unless the writer has already put it somewhere else. What it holds
 * (a menu, a dialog) decides its own role and moves focus in.
 */

import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';

import { uiIsRtl } from '../../../i18n/direction.js';
import { morph } from './morph.js';

export interface Placement {
  /** From the window's left edge (physical: it is written as `left`, which the CSSOM sets for this one element). */
  readonly x: number;
  readonly y: number;
  readonly side: 'below' | 'above';
  /** The height left for the popover, so a long one scrolls inside the window rather than past it. */
  readonly maxHeight: number;
}

export interface PlaceInput {
  readonly anchor: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
  readonly size: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
  /** Where it prefers to open. */
  readonly prefer: 'below' | 'above';
  /** Which of the opener's inline edges it lines up with. */
  readonly align: 'start' | 'end' | 'center';
  readonly rtl: boolean;
  /** Gap to the opener and to the window's edges. */
  readonly gap?: number;
}

/** Where a popover goes: the preferred side if it fits, else the other if that fits better; then clamped into the window. Pure. */
export function placePopover({ anchor, size, viewport, prefer, align, rtl, gap = 8 }: PlaceInput): Placement {
  const below = viewport.height - (anchor.top + anchor.height) - 2 * gap;
  const above = anchor.top - 2 * gap;
  const fits = (side: 'below' | 'above'): boolean => (side === 'below' ? below : above) >= size.height;
  const other = prefer === 'below' ? 'above' : 'below';
  const side = fits(prefer) || (!fits(other) && (prefer === 'below' ? below >= above : above >= below)) ? prefer : other;
  const room = Math.max(0, side === 'below' ? below : above);
  const height = Math.min(size.height, room);
  const y = side === 'below' ? anchor.top + anchor.height + gap : anchor.top - gap - height;

  // The physical edge the inline-start or inline-end of the opener is on.
  const edge = align === 'center' ? 'center' : (align === 'end') !== rtl ? 'right' : 'left';
  const wanted =
    edge === 'center' ? anchor.left + anchor.width / 2 - size.width / 2 : edge === 'right' ? anchor.left + anchor.width - size.width : anchor.left;
  const x = Math.min(Math.max(gap, wanted), Math.max(gap, viewport.width - size.width - gap));
  return { x: Math.round(x), y: Math.round(Math.max(gap, y)), side, maxHeight: Math.round(room) };
}

export function GlassPopover({
  opener,
  prefer = 'below',
  align = 'end',
  className,
  closing,
  onClosed,
  onDismiss,
  children,
  testId,
}: {
  /** The control that opened it: its anchor, where it morphs from, and where focus returns. */
  opener: RefObject<HTMLElement | null>;
  prefer?: 'below' | 'above';
  align?: 'start' | 'end' | 'center';
  className?: string;
  /** Set when the owner asked it to close: it shrinks back into its opener, then calls `onClosed`. */
  closing: boolean;
  onClosed: () => void;
  /** A click outside it (and outside its opener) or Escape. */
  onDismiss: () => void;
  children: ReactNode;
  testId?: string;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);
  const closedRef = useRef(onClosed);
  useEffect(() => {
    dismissRef.current = onDismiss;
    closedRef.current = onClosed;
  });

  // Place it before the first paint, then grow it out of the opener.
  useLayoutEffect(() => {
    const element = ref.current;
    const anchor = opener.current;
    if (element === null || anchor === null) return;
    const place = (): void => {
      const box = anchor.getBoundingClientRect();
      const placed = placePopover({
        anchor: box,
        size: { width: element.offsetWidth, height: element.scrollHeight },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        prefer,
        align,
        rtl: uiIsRtl(),
      });
      element.style.left = `${placed.x}px`;
      element.style.top = `${placed.y}px`;
      element.style.maxHeight = `${placed.maxHeight}px`;
      element.dataset['side'] = placed.side;
    };
    place();
    morph(element, anchor, 'open');
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [opener, prefer, align]);

  // A click outside, or Escape from anywhere, dismisses it; the opener's own click toggles it, so it is not "outside".
  useEffect(() => {
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (ref.current?.contains(target) === true || opener.current?.contains(target) === true) return;
      dismissRef.current();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        dismissRef.current();
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [opener]);

  // Closing: focus goes back to the opener at once (if it was inside), then the popover shrinks into it and is removed.
  useEffect(() => {
    if (!closing) return;
    const element = ref.current;
    const anchor = opener.current;
    const active = document.activeElement;
    if (anchor !== null && (active === null || active === document.body || element?.contains(active) === true)) anchor.focus();
    const animation = element === null ? null : morph(element, anchor, 'close');
    if (animation === null) {
      closedRef.current();
      return;
    }
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      closedRef.current();
    };
    animation.finished.then(finish, finish);
    return () => {
      // Unmounted or reopened before it finished: stop the shrink without reporting it closed.
      if (done) return;
      done = true;
      animation.cancel();
    };
  }, [closing, opener]);

  return (
    <div ref={ref} className={`modern-popover mat-thick${className === undefined ? '' : ` ${className}`}`} data-testid={testId} inert={closing}>
      {children}
    </div>
  );
}
