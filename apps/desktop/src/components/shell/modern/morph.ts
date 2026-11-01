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
