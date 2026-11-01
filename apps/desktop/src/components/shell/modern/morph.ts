/**
 * The dialog morph (modern-interface.md §8.3; M10, #311): in Modern, a dialog grows out of the control that opened it and, as it
 * closes, a glass ghost of it shrinks back into that control. Every dialog is Classic's own component, opened and closed by its own
 * code (a native `<dialog>` and `showModal()`), with focus handled by dialog-focus.ts as before; this module only watches and animates.
 *
 * - The opener is the control the writer last pressed (within a moment), or failing that the last control that had focus outside the
 *   dialog: the chip, button or tree row that asked for it. A menu item that opened a dialog has gone by then, and its menu has handed
 *   focus back to the button it opened from, which is what the dialog grows out of.
 * - It is a FLIP through the Web Animations API, from the opener's rectangle to the dialog's: `--dur-3` with `--ease-spring` to open,
 *   `--dur-2` with `--ease-standard` to close, the content fading in after the first third. Focus is not touched: the dialog has it
 *   from the moment it opens and is interactive at once.
 * - Reduced motion (the system's, or Settings › Appearance) makes every duration 0 in tokens/modern.css: the dialog then appears with
 *   a 120 ms fade, and nothing moves.
 * - Only while `data-shell="modern"` is on `<html>`; in Classic it does nothing. No inline style attribute is written (§11): positions
 *   go through the CSSOM and the animation API.
 *
 * Installed once, when the `modern-shell` chunk loads (modern-shell.tsx), so it works on the projects screen as in a project.
 */

interface Opened {
  readonly opener: HTMLElement | null;
  readonly rect: DOMRect;
}

/** How long after a press the pressed control still counts as the opener. */
const PRESS_WINDOW_MS = 2000;
/** The fade a dialog appears with when nothing may move (§5.5). */
const FADE_MS = 120;

const CONTROL = 'button, a[href], [role="menuitem"], [role="menuitemradio"], [role="tab"], [role="treeitem"], [tabindex]';

let installed = false;
let pressed: { readonly element: HTMLElement; readonly at: number } | null = null;
/** The last few elements that took focus, newest last. */
let focusTrail: HTMLElement[] = [];
const open = new Map<HTMLDialogElement, Opened>();
let removals: MutationObserver | null = null;

function modern(): boolean {
  return document.documentElement.dataset['shell'] === 'modern';
}

function controlOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(CONTROL) : null;
}

/** Milliseconds from a CSS time (`520ms`, `0.24s`, `0s`); `null` when the token is missing. */
export function cssTime(value: string): number | null {
  const text = value.trim();
  const match = /^(-?[\d.]+)(ms|s)$/.exec(text);
  if (match === null) return null;
  const amount = Number.parseFloat(match[1] ?? '');
  if (!Number.isFinite(amount)) return null;
  return match[2] === 's' ? amount * 1000 : amount;
}

interface Motion {
  readonly open: number;
  readonly close: number;
  readonly spring: string;
  readonly standard: string;
}

function motion(): Motion {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  return {
    open: cssTime(read('--dur-3', '520ms')) ?? 520,
    close: cssTime(read('--dur-2', '240ms')) ?? 240,
    spring: read('--ease-spring', 'ease-out'),
    standard: read('--ease-standard', 'ease'),
  };
}

/** The transform that puts a box drawn at `to` over the rectangle `from` (both viewport rectangles), scaling about its centre. */
export function flip(from: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, to: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>): string {
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const sx = to.width > 0 ? Math.max(from.width / to.width, 0.05) : 1;
  const sy = to.height > 0 ? Math.max(from.height / to.height, 0.05) : 1;
  return [translate(dx, dy), scale(sx, sy)].join(' ');
}

function translate(x: number, y: number): string {
  return `translate(${round(x)}px,${round(y)}px)`;
}

function scale(x: number, y: number): string {
  return `scale(${round(x, 3)},${round(y, 3)})`;
}

function round(value: number, places = 1): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function visible(element: HTMLElement): DOMRect | null {
  if (!element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) return null;
  return rect;
}

function openerFor(dialog: HTMLDialogElement): HTMLElement | null {
  const outside = (element: HTMLElement | null | undefined): element is HTMLElement =>
    element !== null && element !== undefined && element.isConnected && !dialog.contains(element) && visible(element) !== null;
  if (pressed !== null && performance.now() - pressed.at < PRESS_WINDOW_MS && outside(pressed.element)) return pressed.element;
  for (let at = focusTrail.length - 1; at >= 0; at -= 1) {
    const element = focusTrail[at];
    if (outside(element)) return element;
  }
  return null;
}

function opened(dialog: HTMLDialogElement): void {
  const rect = dialog.getBoundingClientRect();
  const opener = openerFor(dialog);
  open.set(dialog, { opener, rect });
  watchRemovals();
  if (typeof dialog.animate !== 'function') return;
  const { open: duration, spring } = motion();
  const from = opener === null ? null : visible(opener);
  if (duration <= 0 || from === null) {
    // Nothing may move, or nothing to grow out of: the dialog appears in place with a short fade.
    dialog.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'linear' });
    return;
  }
  dialog.animate([{ transform: flip(from, rect), opacity: 0.5 }, { transform: 'none', opacity: 1 }], { duration, easing: spring });
  for (const child of Array.from(dialog.children)) {
    child.animate([{ opacity: 0 }, { opacity: 0, offset: 0.33 }, { opacity: 1 }], { duration, easing: 'linear' });
  }
}

function closed(dialog: HTMLDialogElement): void {
  const entry = open.get(dialog);
  open.delete(dialog);
  if (open.size === 0) {
    removals?.disconnect();
    removals = null;
  }
  if (entry === undefined || entry.opener === null || !modern()) return;
  const { close: duration, standard } = motion();
  const to = visible(entry.opener);
  const from = entry.rect;
  if (duration <= 0 || to === null || from.width <= 0 || from.height <= 0 || typeof document.body.animate !== 'function') return;
  const ghost = document.createElement('div');
  ghost.className = 'modern-morph-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.setProperty('inline-size', `${from.width}px`);
  ghost.style.setProperty('block-size', `${from.height}px`);
  document.body.append(ghost);
  const start = translate(from.left, from.top);
  const end = [translate(to.left, to.top), scale(to.width / from.width, to.height / from.height)].join(' ');
  const animation = ghost.animate(
    [
      { transform: start, opacity: 0.9 },
      { transform: end, opacity: 0 },
    ],
    { duration, easing: standard, fill: 'forwards' },
  );
  const remove = (): void => ghost.remove();
  animation.addEventListener('finish', remove);
  animation.addEventListener('cancel', remove);
}

/** A dialog React unmounts while open never loses its `open` attribute; while one is open, removals are watched too. */
function watchRemovals(): void {
  if (removals !== null) return;
  removals = new MutationObserver(() => {
    for (const dialog of Array.from(open.keys())) if (!dialog.isConnected) closed(dialog);
  });
  removals.observe(document.body, { childList: true, subtree: true });
}

/** Starts watching dialogs. Idempotent; a host without the DOM APIs it needs gets no morph and nothing else changes. */
export function installMorph(): void {
  if (installed || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  installed = true;
  document.addEventListener(
    'pointerdown',
    (event) => {
      const element = controlOf(event.target);
      if (element !== null) pressed = { element, at: performance.now() };
    },
    true,
  );
  document.addEventListener('focusin', (event) => {
    if (event.target instanceof HTMLElement) focusTrail = [...focusTrail.slice(-3), event.target];
  });
  new MutationObserver((records) => {
    for (const record of records) {
      const dialog = record.target;
      if (!(dialog instanceof HTMLDialogElement)) continue;
      if (dialog.open && !open.has(dialog)) {
        if (modern()) opened(dialog);
      } else if (!dialog.open && open.has(dialog)) {
        closed(dialog);
      }
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['open'], subtree: true });
}
