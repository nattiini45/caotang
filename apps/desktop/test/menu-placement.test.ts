/**
 * A menu placed twice (React's strict mode runs its effect again) lands where it landed the first time. The menu is measured from its
 * anchor, not from its own last move, so a second placement cannot push it off the screen. The suite runs in Node, so the menu is a
 * fixed box whose drawn rect follows its style, offset by a filtered ancestor that is its containing block.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { placeMenu } from '../src/components/shared.js';

const VIEW = { innerWidth: 800, innerHeight: 600 };
const OFFSET = { x: 30, y: 20 };
const SIZE = { width: 200, height: 260 };

function fakeMenu(): HTMLElement & { rect: () => DOMRect } {
  const style = { top: '0px', left: '0px' };
  const rect = (): DOMRect => {
    const top = Number.parseFloat(style.top) + OFFSET.y;
    const left = Number.parseFloat(style.left) + OFFSET.x;
    return { top, left, width: SIZE.width, height: SIZE.height, right: left + SIZE.width, bottom: top + SIZE.height, x: left, y: top, toJSON: () => ({}) };
  };
  return { style, getBoundingClientRect: rect, rect } as unknown as HTMLElement & { rect: () => DOMRect };
}

describe('placeMenu', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gives the same place when it runs twice, and keeps the menu on screen', () => {
    vi.stubGlobal('window', VIEW);
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    for (const anchor of [
      { x: 700, y: 500 },
      { x: 100, y: 100 },
      { x: 790, y: 80 },
    ]) {
      const menu = fakeMenu();
      placeMenu(menu, anchor);
      const once = { top: menu.style.top, left: menu.style.left };
      placeMenu(menu, anchor);
      expect({ top: menu.style.top, left: menu.style.left }).toEqual(once);
      const drawn = menu.rect();
      expect(drawn.top).toBeGreaterThanOrEqual(4);
      expect(drawn.left).toBeGreaterThanOrEqual(4);
      expect(drawn.bottom).toBeLessThanOrEqual(VIEW.innerHeight);
      expect(drawn.right).toBeLessThanOrEqual(VIEW.innerWidth);
    }
  });
});
