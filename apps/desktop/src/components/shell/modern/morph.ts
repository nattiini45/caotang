/**
 * Modern's motion (modern-interface.md §5.5, §8.3): the `morph` helper and the page's view change, both through the Web Animations
 * API, so no inline `<style>` and no stylesheet rule is written (§11).
 *
 * - {@link morph} grows a popover, sheet or window out of the control that opened it (FLIP: from the opener's rectangle to the
 *   target's) and shrinks it back on close: `--dur-3` with `--ease-spring` to open, `--dur-2` to close, the content fading in after the
 *   first third. Focus moves when it starts, so the target is interactive at once; nothing waits for `finished`, except a close that
 *   wants to remove the element after it.
 * - {@link morphPage} is a view change: the page's new content fades and scales in while its width follows `--page-w` (a CSS
 *   transition in shell-modern.css, set by modernLayout).
 *
 * The durations are read from the tokens, which are 0 under reduced motion (the system's, or Settings' **Reduce motion**): then
 * nothing moves, a popover appears with the 120 ms fade (`--dur-fade`) and a view changes at once.
 *
 * The dialog morph below ({@link installMorph}; modern-interface.md §8.3; M10, #311): in Modern, a dialog grows out of the control that opened it and, as it
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

/** Milliseconds from a CSS time (`520ms`, `0.24s`, `0s`); 0 for anything unreadable. */
export function parseDuration(value: string): number {
  const text = value.trim();
  const match = /^(-?[\d.]+)(ms|s)$/.exec(text);
  if (match === null) return 0;
  const amount = Number.parseFloat(match[1] ?? '0');
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return match[2] === 's' ? amount * 1000 : amount;
}

export interface Motion {
  readonly open: number;
  readonly close: number;
  readonly fade: number;
  readonly spring: string;
  readonly standard: string;
}

/** The motion tokens in force now, from the root (tokens/modern.css). */
export function currentMotion(root: Element = document.documentElement): Motion {
  const style = getComputedStyle(root);
  const read = (name: string): string => style.getPropertyValue(name).trim();
  return {
    open: parseDuration(read('--dur-3')),
    close: parseDuration(read('--dur-2')),
    fade: parseDuration(read('--dur-fade')),
    spring: read('--ease-spring') || 'ease-out',
    standard: read('--ease-standard') || 'ease',
  };
}

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The FLIP transform that puts `to` where `from` is: a translation between their centres and a scale of their sizes. */
export function flipTransform(from: Rect, to: Rect): string {
  const scaleX = to.width > 0 ? from.width / to.width : 1;
  const scaleY = to.height > 0 ? from.height / to.height : 1;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const r = (n: number): number => Math.round(n * 1000) / 1000;
  const move = `translate(${r(dx)}px,${r(dy)}px)`;
  const size = `scale(${r(scaleX)},${r(scaleY)})`;
  return [move, size].join(' ');
}

function canAnimate(element: Element): element is Element & { animate: Element['animate'] } {
  return typeof (element as Partial<Element>).animate === 'function';
}

/**
 * Grows `target` out of `opener` (`open`) or shrinks it back into it (`close`). Returns the animation, or `null` when there is nothing
 * to animate (no Web Animations, or zero durations and no fade).
 */
export function morph(target: HTMLElement, opener: Element | null, direction: 'open' | 'close', motion: Motion = currentMotion()): Animation | null {
  if (!canAnimate(target)) return null;
  const duration = direction === 'open' ? motion.open : motion.close;
  if (duration === 0 || opener === null) {
    if (motion.fade === 0) return null;
    // Reduced motion: nothing moves, the element fades in or out in place.
    const fade = direction === 'open' ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }];
    return target.animate(fade, { duration: motion.fade, easing: 'linear', fill: direction === 'close' ? 'forwards' : 'none' });
  }
  const from = flipTransform(opener.getBoundingClientRect(), target.getBoundingClientRect());
  const frames: Keyframe[] =
    direction === 'open'
      ? [
          { transform: from, opacity: 0, offset: 0 },
          { opacity: 0, offset: 0.33 },
          { transform: 'none', opacity: 1, offset: 1 },
        ]
      : [
          { transform: 'none', opacity: 1, offset: 0 },
          { transform: from, opacity: 0, offset: 1 },
        ];
  return target.animate(frames, {
    duration,
    easing: direction === 'open' ? motion.spring : motion.standard,
    fill: direction === 'close' ? 'forwards' : 'none',
  });
}

/** The page's view change: its new content fades and scales in. Nothing moves under reduced motion. */
export function morphPage(page: HTMLElement, motion: Motion = currentMotion()): Animation | null {
  if (!canAnimate(page) || motion.open === 0) return null;
  return page.animate(
    [
      { opacity: 0.35, transform: 'scale(0.985)' },
      { opacity: 1, transform: 'none' },
    ],
    { duration: motion.open, easing: motion.spring },
  );
}

/* ---- The dialog morph (#311) ---- */

interface Opened {
  readonly opener: HTMLElement | null;
  readonly rect: DOMRect;
}

/** How long after a press the pressed control still counts as the opener. */
const PRESS_WINDOW_MS = 2000;
/** A dialog with this class brings its own material and entry (the palette, palette.css), so the morph and the sheet glass leave it. */
const OWN_PRESENTATION = 'modern-palette';

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

interface DialogMotion {
  readonly open: number;
  readonly close: number;
  readonly spring: string;
  readonly standard: string;
}

function dialogMotion(): DialogMotion {
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
  const { open: duration, spring } = dialogMotion();
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
  const { close: duration, standard } = dialogMotion();
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
      // The palette (#310) has its own presentation in palette.css: it grows in from just above, not out of an opener.
      if (dialog.classList.contains(OWN_PRESENTATION)) continue;
      if (dialog.open && !open.has(dialog)) {
        if (modern()) opened(dialog);
      } else if (!dialog.open && open.has(dialog)) {
        closed(dialog);
      }
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['open'], subtree: true });
}
