/**
 * The narrow layout's panel boxes below 960 px (modern-interface.md §13, M11 #312), pure and unit-tested
 * (apps/desktop/test/modern-layout.test.ts). narrow-modern.css places the panels itself (it alone can add the safe areas), so nothing
 * at run time reads these boxes: they are the stylesheet's sizes written down where a test can hold them to the layout's bars, and
 * they live outside layout.ts so the `modern-shell` chunk (and Modern's first load, §12) carries none of it.
 */

import {
  DRAWER_LEAVES,
  DRAWER_WIDTH,
  NARROW_GUTTER,
  NARROW_TAB_BAR,
  NARROW_TOP_BAR,
  SHEET_MAX_SHARE,
  type Box,
} from './layout.js';

/**
 * The narrow layout's panels (§13), each the box it takes while open: the binder **drawer** from the inline-start edge, Scene info's
 * bottom **sheet** (its height a maximum: it is as tall as its content, up to 80% of the window) and the **agent** sheet, the window's
 * full height. The binder's button and the compact top capsule share the top bar; the tab bar is the bottom one.
 */
export interface NarrowPanels {
  readonly drawer: Box;
  readonly sheet: Box;
  readonly agent: Box;
  /** The binder's button at the top bar's inline-start end. */
  readonly binderButton: Box;
  /** The bottom tab bar, the page's width. */
  readonly tabBar: Box;
}

const round = (value: number): number => Math.round(value);

/** The narrow layout's panel boxes for a window below 960 px (§13). */
export function narrowPanels(width: number, height: number): NarrowPanels {
  const g = NARROW_GUTTER;
  const inner = Math.max(0, width - 2 * g);
  const tall = Math.max(0, height - 2 * g);
  const drawerWidth = Math.max(0, Math.min(DRAWER_WIDTH, width - DRAWER_LEAVES - g));
  const sheetHeight = Math.min(tall, round(height * SHEET_MAX_SHARE));
  return {
    drawer: { start: g, top: g, width: round(drawerWidth), height: tall },
    sheet: { start: g, top: round(height - g - sheetHeight), width: inner, height: sheetHeight },
    agent: { start: g, top: g, width: inner, height: tall },
    binderButton: { start: g, top: g, width: NARROW_TOP_BAR, height: NARROW_TOP_BAR },
    tabBar: { start: g, top: Math.max(0, height - g - NARROW_TAB_BAR), width: inner, height: NARROW_TAB_BAR },
  };
}
