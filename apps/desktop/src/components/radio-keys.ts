/**
 * The keys of a radio group, by the WAI-ARIA radio pattern: an arrow key moves the choice to the next or the previous item, wrapping at
 * the ends, and Home and End go to the first and the last. The caller moves the focus with the choice (roving tabindex), so the group
 * has one tab stop, on the checked item.
 */

import { inlineKey } from '../i18n/direction.js';
export function radioStep<T>(items: readonly T[], current: T, pressed: string): T | null {
  const at = items.indexOf(current);
  if (at === -1) return null;
  const key = inlineKey(pressed);
  if (key === 'ArrowRight' || key === 'ArrowDown') return items[(at + 1) % items.length] ?? null;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return items[(at - 1 + items.length) % items.length] ?? null;
  if (key === 'Home') return items[0] ?? null;
  if (key === 'End') return items[items.length - 1] ?? null;
  return null;
}
