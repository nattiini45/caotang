import { expect, test } from '@playwright/test';

import { emptyCoherenceFile, type CoherenceFile, type Finding, type SceneMeta } from '../../packages/coherence/src/index.js';
import { addDocument, addFolder, createEmptyManifest, createProjectState, type ProjectState } from '../../packages/store/src/index.js';
import { buildTimeline, projectTimeline, type TimelineItem } from '../../packages/timeline/src/index.js';

import {
  DOM_BUDGET,
  MAX_BANDS,
  MAX_CHIPS,
  MAX_CONNECTORS,
  MAX_ROWS,
  MAX_TICKS,
  agendaOf,
  badgeOf,
  classes,
  drawWindow,
  foldsBetween,
  gridOf,
  initialViewState,
  mediaQuery,
  moveFocus,
  moveOfKey,
  originX,
  pairOverlays,
  pathOf,
  projectionOptionsOf,
  rememberViewState,
  rememberedViewState,
  scopeOptions,
  stepZoom,
  targetForDocs,
  visibleKeys,
  withAxis,
  type Placed,
} from '../../apps/desktop/src/app/timeline-model.js';

/**
 * The view model of the timeline in the desktop app (timeline.md §3.3, §6, §7): the adaptive default axis, the remembered view,
 * the draw window and its DOM budget, the keyboard grid, the findings overlays and the Agenda's data. Nothing here touches a DOM.
 */

const NOW = new Date('2026-10-01T09:00:00.000Z');

interface Scene {
  readonly id: string;
  readonly parent?: string;
  readonly meta?: SceneMeta;
}

function book(scenes: readonly Scene[], folders: readonly string[] = []): ProjectState {
  const state = createProjectState(createEmptyManifest('View model', NOW, { locale: 'en-US' }), { now: NOW });
  for (const id of folders) addFolder(state, { id, parentId: 'manuscript', title: id, now: NOW });
  for (const scene of scenes) addDocument(state, { id: scene.id, parentId: scene.parent ?? 'manuscript', title: scene.id, body: '', now: NOW });
  return state;
}

function fileOf(scenes: readonly Scene[], findings: Finding[] = []): CoherenceFile {
  const sceneMeta: Record<string, SceneMeta> = {};
  for (const scene of scenes) if (scene.meta !== undefined) sceneMeta[scene.id] = scene.meta;
  return { ...emptyCoherenceFile(), sceneMeta, findings };
}

function finding(id: string, checkId: string, docIds: readonly string[], severity: Finding['severity'] = 'warning'): Finding {
  return {
    id,
    runId: 'r_1',
    class: 'deterministic',
    checkId,
    type: checkId.split('.')[1] ?? 'x',
    severity,
    status: 'open',
    factGroup: `${checkId}|${id}`,
    evidence: docIds.map((docId) => ({ docId, quote: '', from: 0, to: 0 })),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    message: id,
  } as Finding;
}

test.describe('the first view of a project', () => {
  test('is the story axis once half the scenes have a day, and reading order below that', () => {
    expect(initialViewState(0.5).axis).toBe('story');
    expect(initialViewState(1).axis).toBe('story');
    expect(initialViewState(0.49).axis).toBe('narrative');
    expect(initialViewState(0).axis).toBe('narrative');
  });

  test('starts at scene or day zoom for its axis, with order links and findings on and the rest off', () => {
    const story = initialViewState(1);
    expect(story.zoom).toBe('day');
    const narrative = initialViewState(0);
    expect(narrative.zoom).toBe('scene');
    expect(narrative.overlays).toEqual({ after: true, thread: false, findings: true, presence: false });
    expect(narrative.groupBy).toBe('none');
    expect(narrative.scope).toBeNull();
    expect(narrative.agenda).toBeNull();
  });

  test('is remembered for the project it was set in and for no other', () => {
    expect(rememberedViewState('p_one')).toBeUndefined();
    const state = { ...initialViewState(0), groupBy: 'pov' as const };
    rememberViewState('p_one', state);
    expect(rememberedViewState('p_one')?.groupBy).toBe('pov');
    expect(rememberedViewState('p_two')).toBeUndefined();
  });

  test('keeps the level of the zoom when the axis changes', () => {
    const story = initialViewState(1);
    const narrative = withAxis(story, 'narrative');
    expect(narrative.axis).toBe('narrative');
    expect(['scene', 'chapter', 'act']).toContain(narrative.zoom);
    expect(stepZoom('story', 'day', 'out')).toBe('week');
    expect(stepZoom('story', 'fit', 'out')).toBe('fit');
    expect(stepZoom('story', 'day', 'in')).toBe('day');
  });
});

test.describe('the draw window and the DOM budget', () => {
  test('snaps outward so a scroll of a few pixels is the same window', () => {
    const a = drawWindow({ x: 10, y: 0, w: 1000, h: 600 });
    const b = drawWindow({ x: 40, y: 12, w: 1000, h: 600 });
    expect(b).toEqual(a);
    expect(Math.abs(a.x % 320)).toBe(0);
    expect(a.x).toBeLessThanOrEqual(10 - 480);
    expect(a.x + a.w).toBeGreaterThanOrEqual(10 + 1000 + 480);
  });

  test('draws no more than the chip budget out of 2,000 boxes in one window, and keeps the pinned one wherever it is', () => {
    const entries: Placed[] = Array.from({ length: 2000 }, (_, i) => ({ key: `k${i}`, box: { x: (i % 100) * 12, y: Math.floor(i / 100) * 30, w: 10, h: 24 } }));
    const window = drawWindow({ x: 0, y: 0, w: 1400, h: 700 });
    const keys = visibleKeys(entries, window, MAX_CHIPS, new Set(['k1999']));
    expect(keys.length).toBeLessThanOrEqual(MAX_CHIPS);
    expect(keys).toContain('k1999');
  });

  test('keeps every box a window holds while the budget allows it', () => {
    const entries: Placed[] = Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, box: { x: i * 40, y: 0, w: 30, h: 24 } }));
    expect(visibleKeys(entries, drawWindow({ x: 0, y: 0, w: 2000, h: 100 }), MAX_CHIPS)).toHaveLength(40);
  });

  test('leaves room for everything else the page draws, at the most the caps allow', () => {
    const nodesPerChip = 4;
    const worst = MAX_CHIPS * nodesPerChip + MAX_ROWS * 2 + MAX_TICKS * 3 + MAX_BANDS * 2 + MAX_CONNECTORS * 3;
    expect(worst).toBeLessThan(DOM_BUDGET);
  });

  test('at day zoom and at fit zoom, 2,000 scenes put at most the chip budget in a window', () => {
    const chapters = Array.from({ length: 40 }, (_, i) => `c${i}`);
    const scenes: Scene[] = Array.from({ length: 2000 }, (_, i) => ({ id: `s${i}`, parent: `c${Math.floor(i / 50)}`, meta: { dayOffset: i } }));
    const state = book(scenes, chapters);
    const file = fileOf(scenes);
    for (const zoom of ['day', 'fit'] as const) {
      const model = buildTimeline(state, file, { axis: 'story', zoom });
      const geometry = projectTimeline(model, projectionOptionsOf(model));
      const ox = originX(model.direction);
      const placed: Placed[] = geometry.items.map((entry) => ({ key: entry.key, box: { x: entry.box.x + ox, y: entry.box.y + 28, w: entry.box.w, h: entry.box.h } }));
      expect(placed.length).toBeGreaterThan(1900);
      const window = drawWindow({ x: 0, y: 0, w: 1400, h: 800 });
      expect(visibleKeys(placed, window, MAX_CHIPS).length).toBeLessThanOrEqual(MAX_CHIPS);
    }
  });
});

test.describe('the keyboard grid', () => {
  const scenes: Scene[] = [
    { id: 'a', meta: { dayOffset: 0 } },
    { id: 'b', meta: { dayOffset: 1 } },
    { id: 'c', meta: { dayOffset: 2 } },
    { id: 'd', meta: { dayOffset: 3 } },
  ];

  test('walks the arrows in the direction of the interface, whichever way the book reads', () => {
    expect(moveOfKey('ArrowRight', false, false)).toBe('later');
    expect(moveOfKey('ArrowLeft', false, false)).toBe('earlier');
    expect(moveOfKey('ArrowRight', false, true)).toBe('earlier');
    expect(moveOfKey('ArrowLeft', false, true)).toBe('later');
    expect(moveOfKey('ArrowDown', false, true)).toBe('lane-down');
    expect(moveOfKey('Home', true, false)).toBe('grid-first');
    expect(moveOfKey('End', false, false)).toBe('last');
    expect(moveOfKey('x', false, false)).toBeNull();
  });

  test('moves inside a lane, stays at its ends, and changes lane to the nearest scene', () => {
    const state = book(scenes);
    const file = fileOf(scenes);
    const model = buildTimeline(state, file, { axis: 'narrative', groupBy: 'mode' });
    const grid = gridOf(model, undefined, 'All');
    const keys = grid.rows.flatMap((row) => row.keys);
    expect(keys.length).toBe(4);
    const first = grid.rows[0]?.keys[0] as string;
    expect(moveFocus(grid, first, 'earlier')).toBe(first);
    expect(moveFocus(grid, undefined, 'later')).toBe(first);
    const last = moveFocus(grid, first, 'last') as string;
    expect(moveFocus(grid, last, 'later')).toBe(last);
    expect(moveFocus(grid, first, 'grid-last')).toBeDefined();
  });

  test('announces the fold a move crosses, and none inside a part', () => {
    const prologue: Scene = { id: 'pro', meta: { dayOffset: -400, storyPart: 'prologue' } };
    const main: Scene = { id: 'm1', meta: { dayOffset: 0 } };
    const main2: Scene = { id: 'm2', meta: { dayOffset: 1 } };
    const all = [prologue, main, main2];
    const model = buildTimeline(book(all), fileOf(all), { axis: 'story' });
    const items = new Map(model.items.map((item) => [item.nodeId, item]));
    const crossed = foldsBetween(model, items.get('pro'), items.get('m1'));
    expect(crossed.length).toBe(1);
    expect(foldsBetween(model, items.get('m1'), items.get('m2'))).toEqual([]);
    expect(foldsBetween(model, items.get('m1'), items.get('pro'))).toHaveLength(1);
    expect(foldsBetween(model, undefined, items.get('m1'))).toEqual([]);
  });
});

test.describe('findings on the timeline', () => {
  test('a gap inside a part draws a band between the two scenes, and a count badge says how many', () => {
    const all: Scene[] = [
      { id: 'a', meta: { dayOffset: 0 } },
      { id: 'b', meta: { dayOffset: 30 } },
    ];
    const file = fileOf(all, [finding('f_gap', 'timeline.gap', ['a', 'b'])]);
    const model = buildTimeline(book(all), file, { axis: 'story', compressGaps: false });
    const geometry = projectTimeline(model, projectionOptionsOf(model));
    const boxes = new Map(geometry.items.map((entry) => [entry.key, entry.box]));
    const overlays = pairOverlays(model, boxes);
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.kind).toBe('gap-band');
    expect(overlays[0]?.band?.w).toBeGreaterThan(0);
    const item = model.items.find((candidate) => candidate.nodeId === 'b') as TimelineItem;
    expect(badgeOf(item.findings)).toMatchObject({ count: 1, severity: 'warning' });
  });

  test('draws no band and no connector for a gap that crosses a part fold', () => {
    const all: Scene[] = [
      { id: 'pro', meta: { dayOffset: -2000, storyPart: 'prologue' } },
      { id: 'm', meta: { dayOffset: 0 } },
    ];
    const file = fileOf(all, [finding('f_gap', 'timeline.gap', ['pro', 'm'])]);
    const model = buildTimeline(book(all), file, { axis: 'story' });
    const geometry = projectTimeline(model, projectionOptionsOf(model));
    const boxes = new Map(geometry.items.map((entry) => [entry.key, entry.box]));
    expect(pairOverlays(model, boxes)).toEqual([]);
  });

  test('an order-drift pair is a connector with its finding id, and no badge appears on a scene without findings', () => {
    const all: Scene[] = [
      { id: 'a', meta: { dayOffset: 5 } },
      { id: 'b', meta: { dayOffset: 2 } },
      { id: 'c', meta: { dayOffset: 9 } },
    ];
    const file = fileOf(all, [finding('f_drift', 'timeline.order-drift', ['a', 'b'], 'error')]);
    const model = buildTimeline(book(all), file, { axis: 'braid' });
    const geometry = projectTimeline(model, projectionOptionsOf(model));
    const boxes = new Map(geometry.items.map((entry) => [entry.key, entry.box]));
    const overlays = pairOverlays(model, boxes);
    expect(overlays.map((overlay) => overlay.findingId)).toEqual(['f_drift']);
    expect(overlays[0]?.kind).toBe('connector');
    const clean = model.items.find((candidate) => candidate.nodeId === 'c') as TimelineItem;
    expect(badgeOf(clean.findings)).toBeUndefined();
  });

  test('"Show on timeline" lands on the first cited scene that is placed, and on none that the timeline does not hold', () => {
    const all: Scene[] = [
      { id: 'undated' },
      { id: 'dated', meta: { dayOffset: 4 } },
    ];
    const model = buildTimeline(book(all), fileOf(all), { axis: 'story' });
    expect(targetForDocs(model, ['undated', 'dated'])?.nodeId).toBe('dated');
    expect(targetForDocs(model, ['undated'])?.nodeId).toBe('undated');
    expect(targetForDocs(model, ['gone'])).toBeUndefined();
  });
});

test.describe('the Agenda', () => {
  test('groups by part in story order and puts dated scenes before undated ones inside a part', () => {
    const all: Scene[] = [
      { id: 'late', meta: { dayOffset: 90, storyPart: 'epilogue' } },
      { id: 'undated' },
      { id: 'dated', meta: { dayOffset: 3 } },
      { id: 'early', meta: { dayOffset: -50, storyPart: 'prologue' } },
    ];
    const model = buildTimeline(book(all), fileOf(all), { axis: 'braid' });
    const groups = agendaOf(model, undefined, (id) => id);
    expect(groups.map((group) => group.part)).toEqual(['prologue', 'main', 'epilogue']);
    const main = groups.find((group) => group.part === 'main');
    expect(main?.rows.map((row) => row.item.nodeId).sort()).toEqual(['dated', 'undated']);
  });

  test('sorts a column inside each part and keeps the part order', () => {
    const all: Scene[] = [
      { id: 'one', meta: { dayOffset: 1 } },
      { id: 'two', meta: { dayOffset: 2 } },
      { id: 'three', meta: { dayOffset: 3 } },
    ];
    const model = buildTimeline(book(all), fileOf(all), { axis: 'story' });
    const down = agendaOf(model, { column: 'day', direction: 'descending' }, (id) => id);
    expect(down[0]?.rows.map((row) => row.item.nodeId)).toEqual(['three', 'two', 'one']);
    const up = agendaOf(model, { column: 'day', direction: 'ascending' }, (id) => id);
    expect(up[0]?.rows.map((row) => row.item.nodeId)).toEqual(['one', 'two', 'three']);
  });
});

test.describe('scope and small helpers', () => {
  test('lists the manuscript folders depth first, with their depth', () => {
    const state = book([], ['act1', 'act2']);
    addFolder(state, { id: 'ch1', parentId: 'act1', title: 'ch1', now: NOW });
    const options = scopeOptions(state.manifest.tree);
    expect(options.map((option) => [option.id, option.depth])).toEqual([
      ['act1', 0],
      ['ch1', 1],
      ['act2', 0],
    ]);
  });

  test('builds paths, class lists and media queries without writing them out as prose', () => {
    expect(pathOf(['M', 1, 2], ['L', 3, 4])).toBe('M1 2L3 4');
    expect(classes('a', false, undefined, 'b')).toBe('a b');
    expect(mediaQuery(['forced-colors', 'active'], ['prefers-reduced-motion', 'reduce'])).toBe('(forced-colors: active), (prefers-reduced-motion: reduce)');
  });
});
