/**
 * Modern's layout (modern-interface.md §6, §8.4): one pure function, {@link modernLayout}, that says where the page, the two ornaments,
 * the sidebar, the agent window and a docked Scene info sit for a window size and a view, as the concept's `layout()` does. The
 * components only apply what it returns (the page through the stage's custom properties, `StageGeometry`), so the geometry is
 * unit-tested without a browser (apps/desktop/test/modern-layout.test.ts).
 *
 * Coordinates are logical: `start` is the distance from the window's inline-start edge (the left in a left-to-right interface, the
 * right in a right-to-left one) and `top` from its top, in CSS px.
 *
 * Rules:
 * - The page's width follows the view (Write about 780 px, Board about 1,120, Codex about 1,000) and is clamped to the room the
 *   sidebar and the windows leave; its top is 11% of the height and at least 84 px, its bottom leaves the bottom ornament 112 px.
 * - The sidebar (a pinned or open binder) always takes room at the inline-start edge: the page moves over.
 * - Above 1,280 px the agent window takes room at the inline-end edge too, exactly as the window places itself (`companionAreaEnd` in
 *   companion-model.ts, #309): the stage's inline `--area-end` is the one source of the page's room, so it must agree with the window.
 *   From 1,280 px down the window overlaps the page as a sheet with a scrim instead.
 * - A docked Scene info (#308) and the open agent window **stack** at the inline-end edge: the agent window at the edge, Scene info
 *   beside it, never over each other (`geometry.infoEnd` places the panel). Above 1,280 px the docked panel takes room too, unless
 *   the page would then shrink below {@link MIN_PAGE_WIDTH}; then it lies over the page instead (`sheets.info`). The page shrinks
 *   before anything overlaps it, and stops shrinking where it would stop being a page.
 * - Below 960 px (the narrow layout, §13, M11 #312) the page goes full-bleed with an 8 px margin: the compact top capsule (title,
 *   **⋯**) sits above it and the bottom tab bar (Write, Board, Codex, Ask, Search) below it, each in a bar of its own, not over the
 *   page's edge. Nothing sits beside the page: the binder is a drawer from the inline-start edge, Scene info a bottom sheet of at most
 *   80% of the height, and the agent window a full-height sheet ({@link NarrowPanels}), one at a time over a scrim. The bottom safe
 *   area (`env(safe-area-inset-*)`) is the stylesheet's to add: a pure function cannot read it.
 */

import { COMPANION_WIDTH, companionAreaEnd } from './companion-model.js';
import type { StageGeometry } from './geometry.js';

/** The page's views: the three of the bottom ornament, and the two Classic centre views reached from **⋯**. */
export type ModernView = 'write' | 'board' | 'codex' | 'timeline' | 'pictures';

export interface LayoutInput {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly view: ModernView;
  /** Whether the sidebar is beside the page (open or pinned), taking room at the inline-start edge. */
  readonly sidebar: boolean;
  /** Whether the agent window is open. */
  readonly agent: boolean;
  /** Whether Scene info is docked beside the page. */
  readonly info: boolean;
}

/** A rectangle in logical coordinates. */
export interface Box {
  readonly start: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Where an ornament sits: centred on `centre` (from the inline-start edge), its top at `top`, `height` tall. Its width is its content's. */
export interface OrnamentPlace {
  readonly centre: number;
  readonly top: number;
  readonly height: number;
}

export interface ModernLayout {
  /** Below 960 px. */
  readonly narrow: boolean;
  readonly page: Box;
  readonly topOrnament: OrnamentPlace;
  readonly bottomOrnament: OrnamentPlace;
  readonly sidebar: Box | null;
  readonly agent: Box | null;
  readonly info: Box | null;
  /** The agent window or Scene info lies over the page as a sheet rather than beside it (either of `sheets`). */
  readonly overlay: boolean;
  /** Which window lies over the page: the agent window from 1,280 px down; Scene info then too, or where docking it would leave the page too narrow. */
  readonly sheets: { readonly agent: boolean; readonly info: boolean };
  /** Below 960 px: where the narrow layout's panels open (§13); `null` in a wide window. */
  readonly narrowPanels: NarrowPanels | null;
  /** What the stage needs to place the page (ModernShell's `geometry`). */
  readonly geometry: StageGeometry;
}

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

/** The width each view asks for. */
export const VIEW_WIDTH: Readonly<Record<ModernView, number>> = {
  write: 780,
  board: 1120,
  codex: 1000,
  timeline: 1120,
  pictures: 1120,
};

export const NARROW_BELOW = 960;
/** From this width down the windows overlap the page. */
export const OVERLAY_AT = 1280;
export const MIN_PAGE_WIDTH = 480;
export const GUTTER = 32;
export const NARROW_GUTTER = 8;
export const SIDEBAR_WIDTH = 300;
/** The agent window's width: companion-model.ts's (#309). */
export const AGENT_WIDTH = COMPANION_WIDTH;
/** A docked Scene info's width: scene-info.css's `--scene-info-w` (#308), so the page moves over exactly as far as the panel is wide. */
export const INFO_WIDTH = 380;
export const PAGE_TOP_MIN = 84;
export const PAGE_TOP_SHARE = 0.11;
export const PAGE_BOTTOM = 112;
/** Narrow: the top bar (the binder's button, the compact capsule) is this tall at the gutter, and the page starts a gutter below it. */
export const NARROW_TOP_BAR = 56;
export const NARROW_PAGE_TOP = NARROW_GUTTER + NARROW_TOP_BAR + NARROW_GUTTER;
/** Narrow: the bottom tab bar's height; it sits a gutter above the bottom safe area, and the page ends two gutters above it. */
export const NARROW_TAB_BAR = 64;
export const NARROW_PAGE_BOTTOM = NARROW_GUTTER + NARROW_TAB_BAR + 2 * NARROW_GUTTER;
/** Narrow: the drawer's width, at most, leaving at least this much of the page in sight beside it. */
export const DRAWER_WIDTH = 360;
export const DRAWER_LEAVES = 48;
/** Narrow: Scene info's bottom sheet is at most this share of the window's height (§13). */
export const SHEET_MAX_SHARE = 0.8;
/** An ornament's height: twice its radius (`--radius-ornament`, 30 px), so it floats half over the page's edge. */
export const ORNAMENT_HEIGHT = 60;

const round = (value: number): number => Math.round(value);

export function modernLayout({ viewport, view, sidebar, agent, info }: LayoutInput): ModernLayout {
  const width = Math.max(0, viewport.width);
  const height = Math.max(0, viewport.height);
  const narrow = width < NARROW_BELOW;
  const gutter = narrow ? NARROW_GUTTER : GUTTER;
  const pageTop = narrow ? NARROW_PAGE_TOP : Math.max(PAGE_TOP_MIN, round(height * PAGE_TOP_SHARE));
  const pageBottom = narrow ? NARROW_PAGE_BOTTOM : PAGE_BOTTOM;
  const columnHeight = Math.max(0, height - pageTop - pageBottom);

  // Room at the inline-start edge: the sidebar at the gutter, then the page area after it.
  const hasSidebar = sidebar && !narrow;
  const areaStart = hasSidebar ? SIDEBAR_WIDTH + gutter : 0;

  // Room at the inline-end edge: the agent window at the edge (the window's own rule, so the page and the window always agree), then a
  // docked Scene info beside it, if the page keeps its minimum width.
  const agentRoom = narrow ? 0 : companionAreaEnd(width, agent);
  const infoFits = width - areaStart - agentRoom - (INFO_WIDTH + gutter) - 2 * gutter >= MIN_PAGE_WIDTH;
  const infoRoom = info && !narrow && width > OVERLAY_AT && infoFits ? INFO_WIDTH + gutter : 0;
  const sheets = { agent: agent && agentRoom === 0, info: info && infoRoom === 0 };
  const overlay = sheets.agent || sheets.info;
  const areaEnd = agentRoom + infoRoom;

  const areaWidth = Math.max(0, width - areaStart - areaEnd);
  // Narrow: full-bleed with the small margin, whatever width the view would ask for.
  const pageWidth = Math.max(0, narrow ? areaWidth - 2 * gutter : Math.min(VIEW_WIDTH[view], areaWidth - 2 * gutter));
  const pageStart = areaStart + (areaWidth - pageWidth) / 2;
  const centre = pageStart + pageWidth / 2;

  const sheet = (size: number, end: number): Box => {
    const w = Math.max(0, Math.min(size, width - 2 * gutter));
    return { start: round(end - w), top: pageTop, width: round(w), height: columnHeight };
  };
  const agentBox = agent ? sheet(AGENT_WIDTH, width - gutter) : null;
  // Stacked: Scene info sits beside the agent window, never under it. In a narrow window both are sheets over the whole page (#312).
  const infoBox = info ? sheet(INFO_WIDTH, agentBox === null || narrow ? width - gutter : agentBox.start - gutter) : null;
  const infoEnd = infoBox === null ? gutter : width - (infoBox.start + infoBox.width);

  return {
    narrow,
    narrowPanels: narrow ? narrowPanels(width, height) : null,
    page: { start: round(pageStart), top: pageTop, width: round(pageWidth), height: columnHeight },
    // Narrow: the compact capsule in the top bar and the tab bar at the bottom, each in its own bar, clear of the page's edges.
    topOrnament: narrow
      ? { centre: round(centre), top: NARROW_GUTTER, height: NARROW_TOP_BAR }
      : { centre: round(centre), top: pageTop - ORNAMENT_HEIGHT / 2, height: ORNAMENT_HEIGHT },
    bottomOrnament: narrow
      ? { centre: round(width / 2), top: Math.max(0, height - NARROW_GUTTER - NARROW_TAB_BAR), height: NARROW_TAB_BAR }
      : { centre: round(centre), top: pageTop + columnHeight - ORNAMENT_HEIGHT / 2, height: ORNAMENT_HEIGHT },
    sidebar: hasSidebar ? { start: gutter, top: pageTop, width: SIDEBAR_WIDTH, height: columnHeight } : null,
    agent: agentBox,
    info: infoBox,
    overlay,
    sheets,
    geometry: { pageWidth: round(pageWidth), pageTop, pageBottom, areaStart, areaEnd, infoEnd },
  };
}

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
