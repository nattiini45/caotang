/**
 * Modern's layout (components/shell/modern/layout.ts; modern-interface.md §6, §8.4, §15.1): the page, ornament, sidebar and window
 * rectangles at 960, 1,100, 1,280, 1,440 and 1,920 px, with each combination of the sidebar, the agent window and a docked Scene info,
 * and each view. Also the popover's placement (glass-popover.tsx, §8.2), the view mapping (views.ts) and the morph's arithmetic
 * (morph.ts, §8.3), all pure.
 */
import { describe, expect, it } from 'vitest';

import { placePopover } from '../src/components/shell/modern/glass-popover.js';
import {
  AGENT_WIDTH,
  GUTTER,
  INFO_WIDTH,
  MIN_PAGE_WIDTH,
  NARROW_GUTTER,
  ORNAMENT_HEIGHT,
  SIDEBAR_WIDTH,
  VIEW_WIDTH,
  modernLayout,
  type Box,
  type ModernView,
} from '../src/components/shell/modern/layout.js';
import { companionAreaEnd } from '../src/components/shell/modern/companion-model.js';
import { flipTransform, parseDuration } from '../src/components/shell/modern/morph.js';
import { chooseView, modernViewOf, viewControlId } from '../src/components/shell/modern/views.js';
import type { RailTab } from '../src/components/shell/regions.js';
import type { CenterMode } from '../src/components/Binder.js';

const WIDTHS = [960, 1100, 1280, 1440, 1920] as const;
const HEIGHT = 900;
const VIEWS: readonly ModernView[] = ['write', 'board', 'codex', 'timeline', 'pictures'];
const FLAGS = [false, true] as const;

const end = (box: Box): number => box.start + box.width;
const overlaps = (a: Box, b: Box): boolean => a.start < end(b) && b.start < end(a) && a.top < b.top + b.height && b.top < a.top + a.height;

describe('modernLayout', () => {
  for (const width of WIDTHS) {
    for (const sidebar of FLAGS) {
      for (const agent of FLAGS) {
        for (const info of FLAGS) {
          for (const view of VIEWS) {
            const label = `${width} px, ${view}, sidebar ${sidebar ? 'on' : 'off'}, agent ${agent ? 'on' : 'off'}, info ${info ? 'docked' : 'off'}`;
            it(label, () => {
              const layout = modernLayout({ viewport: { width, height: HEIGHT }, view, sidebar, agent, info });
              const { page, geometry } = layout;

              // Wide from 960 px: no narrow layout.
              expect(layout.narrow).toBe(false);

              // The page never asks for more than its view, never leaves the window, and keeps a gutter on both sides of its area.
              expect(page.width).toBeLessThanOrEqual(VIEW_WIDTH[view]);
              expect(page.start).toBeGreaterThanOrEqual(GUTTER);
              expect(end(page)).toBeLessThanOrEqual(width - GUTTER);
              expect(page.width).toBeGreaterThan(0);

              // Top: 11% of the height, at least 84 px; bottom: 112 px for the bottom ornament.
              expect(page.top).toBe(Math.max(84, Math.round(HEIGHT * 0.11)));
              expect(page.top + page.height).toBe(HEIGHT - 112);

              // The ornaments: centred on the page, half over its top and bottom edges.
              expect(layout.topOrnament.centre).toBe(Math.round(page.start + page.width / 2));
              expect(layout.bottomOrnament.centre).toBe(layout.topOrnament.centre);
              expect(layout.topOrnament.top + ORNAMENT_HEIGHT / 2).toBe(page.top);
              expect(layout.bottomOrnament.top + ORNAMENT_HEIGHT / 2).toBe(page.top + page.height);

              // The sidebar pushes: it is beside the page, never over it.
              if (sidebar) {
                expect(layout.sidebar).toEqual({ start: GUTTER, top: page.top, width: SIDEBAR_WIDTH, height: page.height });
                expect(overlaps(layout.sidebar as Box, page)).toBe(false);
                expect(geometry.areaStart).toBe(SIDEBAR_WIDTH + GUTTER);
              } else {
                expect(layout.sidebar).toBeNull();
                expect(geometry.areaStart).toBe(0);
              }

              // The windows sit at the inline-end edge: the agent at the edge, Scene info inside it, never over each other.
              expect(layout.agent === null).toBe(!agent);
              expect(layout.info === null).toBe(!info);
              if (layout.agent !== null) expect(end(layout.agent)).toBe(width - GUTTER);
              if (layout.info !== null) {
                expect(layout.info.width).toBe(INFO_WIDTH);
                if (layout.agent !== null) expect(end(layout.info)).toBe(layout.agent.start - GUTTER);
              }
              if (layout.agent !== null && layout.info !== null) expect(overlaps(layout.agent, layout.info)).toBe(false);

              // The agent window follows its own rule (companionAreaEnd, #309): beside the page above 1,280 px, a sheet from there down.
              // A docked Scene info also pushes above 1,280 px unless the page would drop below its minimum; then it lies over it.
              expect(layout.sheets.agent).toBe(agent && width <= 1280);
              if (info && width <= 1280) expect(layout.sheets.info).toBe(true);
              expect(layout.overlay).toBe(layout.sheets.agent || layout.sheets.info);
              if (layout.agent !== null) expect(overlaps(layout.agent, page)).toBe(layout.sheets.agent);
              if (layout.info !== null) expect(overlaps(layout.info, page)).toBe(layout.sheets.info);
              expect(geometry.areaEnd).toBe(companionAreaEnd(width, agent) + (info && !layout.sheets.info ? INFO_WIDTH + GUTTER : 0));
              if (info && !layout.sheets.info) expect(page.width).toBeGreaterThanOrEqual(Math.min(VIEW_WIDTH[view], MIN_PAGE_WIDTH));
              // A docked Scene info is placed past the open agent window (stacked), at the gutter otherwise.
              expect(geometry.infoEnd).toBe(layout.info === null ? GUTTER : width - end(layout.info));
              if (info) expect(geometry.infoEnd).toBe(agent ? GUTTER + AGENT_WIDTH + GUTTER : GUTTER);

              // What the stage is given matches the rectangles.
              expect(geometry).toEqual({ pageWidth: page.width, pageTop: page.top, pageBottom: 112, areaStart: geometry.areaStart, areaEnd: geometry.areaEnd, infoEnd: geometry.infoEnd });
              const areaWidth = width - (geometry.areaStart ?? 0) - (geometry.areaEnd ?? 0);
              expect(page.width).toBe(Math.min(VIEW_WIDTH[view], areaWidth - 2 * GUTTER));
            });
          }
        }
      }
    }
  }

  it('gives each view its own width where there is room, and shrinks the page before anything overlaps it', () => {
    const at = (width: number, view: ModernView, sidebar = false) =>
      modernLayout({ viewport: { width, height: HEIGHT }, view, sidebar, agent: false, info: false }).page.width;
    expect(at(1920, 'write')).toBe(780);
    expect(at(1920, 'board')).toBe(1120);
    expect(at(1920, 'codex')).toBe(1000);
    expect(at(1100, 'board')).toBe(1100 - 2 * GUTTER);
    expect(at(960, 'write', true)).toBe(960 - SIDEBAR_WIDTH - GUTTER - 2 * GUTTER);
  });

  it('pushes the page over at 1,440 px and overlaps it at 1,280 px when the agent opens', () => {
    const wide = modernLayout({ viewport: { width: 1440, height: HEIGHT }, view: 'write', sidebar: false, agent: true, info: false });
    expect(wide.overlay).toBe(false);
    expect(end(wide.page)).toBeLessThanOrEqual((wide.agent as Box).start);
    const tight = modernLayout({ viewport: { width: 1280, height: HEIGHT }, view: 'write', sidebar: false, agent: true, info: false });
    expect(tight.overlay).toBe(true);
    expect(tight.page.width).toBe(780);
  });

  it('takes the agent window’s room from the window’s own rule, so the page and the window agree at every width', () => {
    for (const width of [1100, 1280, 1281, 1300, 1440, 1920]) {
      for (const sidebar of FLAGS) {
        const layout = modernLayout({ viewport: { width, height: HEIGHT }, view: 'write', sidebar, agent: true, info: false });
        expect(layout.geometry.areaEnd).toBe(companionAreaEnd(width, true));
      }
    }
  });

  it('stacks a docked Scene info beside the open agent window above 1,280 px, both pushing the page', () => {
    const layout = modernLayout({ viewport: { width: 1920, height: HEIGHT }, view: 'write', sidebar: false, agent: true, info: true });
    expect(layout.overlay).toBe(false);
    const agentBox = layout.agent as Box;
    const infoBox = layout.info as Box;
    expect(overlaps(agentBox, infoBox)).toBe(false);
    expect(end(infoBox)).toBe(agentBox.start - GUTTER);
    expect(end(layout.page)).toBeLessThanOrEqual(infoBox.start - GUTTER);
    expect(layout.geometry.areaEnd).toBe(AGENT_WIDTH + GUTTER + INFO_WIDTH + GUTTER);
    expect(layout.geometry.infoEnd).toBe(1920 - end(infoBox));
  });

  it('lets a docked Scene info lie over the page, still beside the agent window, where pushing would leave the page too narrow', () => {
    const layout = modernLayout({ viewport: { width: 1440, height: HEIGHT }, view: 'board', sidebar: true, agent: true, info: true });
    expect(layout.sheets).toEqual({ agent: false, info: true });
    expect(layout.geometry.areaEnd).toBe(AGENT_WIDTH + GUTTER);
    expect(overlaps(layout.agent as Box, layout.info as Box)).toBe(false);
    expect(layout.page.width).toBe(1440 - SIDEBAR_WIDTH - GUTTER - AGENT_WIDTH - GUTTER - 2 * GUTTER);
  });

  it('keeps the page top at 84 px in a short window', () => {
    expect(modernLayout({ viewport: { width: 1440, height: 600 }, view: 'write', sidebar: false, agent: false, info: false }).page.top).toBe(84);
  });

  it('below 960 px takes nearly the whole width, with no sidebar beside the page and windows as sheets', () => {
    const layout = modernLayout({ viewport: { width: 700, height: 800 }, view: 'board', sidebar: true, agent: true, info: false });
    expect(layout.narrow).toBe(true);
    expect(layout.sidebar).toBeNull();
    expect(layout.overlay).toBe(true);
    expect(layout.page.width).toBe(700 - 2 * NARROW_GUTTER);
    expect(layout.geometry).toEqual({ pageWidth: 684, pageTop: 72, pageBottom: 88, areaStart: 0, areaEnd: 0, infoEnd: NARROW_GUTTER });
  });

  it('never returns a negative size', () => {
    const layout = modernLayout({ viewport: { width: 0, height: 0 }, view: 'write', sidebar: true, agent: true, info: true });
    for (const box of [layout.page, layout.agent, layout.info]) {
      if (box === null) continue;
      expect(box.width).toBeGreaterThanOrEqual(0);
      expect(box.height).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('placePopover', () => {
  const viewport = { width: 1440, height: 900 };
  const anchor = { left: 900, top: 70, width: 44, height: 44 };

  it('opens below its opener, its inline-end edge on the opener’s', () => {
    const placed = placePopover({ anchor, size: { width: 280, height: 500 }, viewport, prefer: 'below', align: 'end', rtl: false });
    expect(placed).toEqual({ x: 900 + 44 - 280, y: 70 + 44 + 8, side: 'below', maxHeight: 900 - 114 - 16 });
  });

  it('lines up with the left edge in a right-to-left interface', () => {
    expect(placePopover({ anchor, size: { width: 280, height: 300 }, viewport, prefer: 'below', align: 'end', rtl: true }).x).toBe(900);
  });

  it('flips above when it does not fit below, and clamps into the window', () => {
    const low = { left: 1400, top: 800, width: 44, height: 44 };
    const placed = placePopover({ anchor: low, size: { width: 280, height: 300 }, viewport, prefer: 'below', align: 'start', rtl: false });
    expect(placed.side).toBe('above');
    expect(placed.y).toBe(800 - 8 - 300);
    expect(placed.x).toBe(1440 - 280 - 8);
  });

  it('keeps the preferred side, with a smaller height, when neither side fits and it has more room', () => {
    const placed = placePopover({ anchor, size: { width: 280, height: 2000 }, viewport, prefer: 'below', align: 'center', rtl: false });
    expect(placed.side).toBe('below');
    expect(placed.maxHeight).toBe(900 - 114 - 16);
    expect(placed.x).toBe(Math.round(922 - 140));
  });
});

describe('views', () => {
  const cases: [RailTab, CenterMode, ModernView][] = [
    ['binder', 'editor', 'write'],
    ['findings', 'corkboard', 'board'],
    ['codex', 'editor', 'codex'],
    ['codex', 'corkboard', 'codex'],
    ['binder', 'timeline', 'timeline'],
    ['activity', 'pictures', 'pictures'],
  ];
  for (const [rail, center, view] of cases) {
    it(`rail ${rail} and centre ${center} show ${view}`, () => expect(modernViewOf(rail, center)).toBe(view));
  }

  it('keeps Classic’s ids for Write and Board', () => {
    expect(viewControlId('write')).toBe('center-editor');
    expect(viewControlId('board')).toBe('center-corkboard');
    expect(viewControlId('codex')).toBe('center-codex');
  });

  it('chooses a view through the workspace’s own setters', () => {
    const calls: string[] = [];
    const view = (rail: RailTab) => ({
      rail,
      setRail: (tab: RailTab) => calls.push(`rail:${tab}`),
      setCenter: (mode: CenterMode) => calls.push(`center:${mode}`),
    });
    chooseView(view('binder'), 'codex');
    chooseView(view('codex'), 'board');
    chooseView(view('findings'), 'write');
    chooseView(view('codex'), 'codex');
    expect(calls).toEqual(['rail:codex', 'rail:binder', 'center:corkboard', 'center:editor']);
  });
});

describe('morph', () => {
  it('reads CSS durations', () => {
    expect(parseDuration('520ms')).toBe(520);
    expect(parseDuration(' 0.24s ')).toBe(240);
    expect(parseDuration('0s')).toBe(0);
    expect(parseDuration('')).toBe(0);
  });

  it('puts the target where the opener is', () => {
    const from = { left: 100, top: 100, width: 40, height: 40 };
    const to = { left: 60, top: 160, width: 200, height: 400 };
    expect(flipTransform(from, to)).toBe('translate(-40px,-240px) scale(0.2,0.1)');
    expect(flipTransform(to, to)).toBe('translate(0px,0px) scale(1,1)');
  });
});
