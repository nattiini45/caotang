import { TIMELINE_MODES, type TimelineMode } from '@caotang/coherence';
import { describe, expect, it } from 'vitest';

import { MODE_RENDER, buildTimeline, glyphOf, knownMode, type StoryPart, type TimelineItem } from '../src/index.js';

import { coherence, project } from './fixtures.js';

const PARTS: StoryPart[] = ['prologue', 'main', 'epilogue'];

function one(mode: TimelineMode, extra: { dayOffset?: number; storyPart?: StoryPart } = { dayOffset: 4 }): TimelineItem {
  const state = project({ scenes: [{ id: 's' }] });
  const model = buildTimeline(state, coherence({ s: { timelineMode: mode, ...extra } }), { axis: 'story' });
  return model.items[0] as TimelineItem;
}

describe('the mode table (§3.6)', () => {
  it('has a row for every one of the eleven modes, each with a glyph and a pattern, and no two glyphs alike', () => {
    expect(Object.keys(MODE_RENDER).sort()).toEqual([...TIMELINE_MODES].sort());
    expect(TIMELINE_MODES).toHaveLength(11);
    for (const mode of TIMELINE_MODES) {
      expect(MODE_RENDER[mode].glyph).not.toBe('');
      expect(MODE_RENDER[mode].pattern).not.toBe('');
    }
    expect(new Set(TIMELINE_MODES.map((mode) => MODE_RENDER[mode].glyph)).size).toBe(11);
  });

  it.each(TIMELINE_MODES)('%s: the item carries the row glyph and pattern, and a dashed outline when undated', (mode) => {
    const dated = one(mode);
    expect(dated.mode).toBe(mode);
    expect(dated.glyph).toEqual({ glyph: MODE_RENDER[mode].glyph, pattern: MODE_RENDER[mode].pattern });
    const undated = one(mode, {});
    expect(undated.glyph).toEqual({ glyph: MODE_RENDER[mode].glyph, pattern: 'dashed' });
    expect(undated.start).toBeUndefined();
    expect(glyphOf(mode, false).pattern).toBe('dashed');
  });

  it.each(TIMELINE_MODES.flatMap((mode) => PARTS.map((part) => [mode, part] as const)))('%s in the %s part keeps its part and its glyph', (mode, part) => {
    const item = one(mode, { dayOffset: -2, storyPart: part });
    expect(item).toMatchObject({ part, mode, start: -2 });
    expect(item.glyph.glyph).toBe(MODE_RENDER[mode].glyph);
  });

  it('an unknown mode in a hand-edited file reads as linear', () => {
    expect(knownMode('bogus')).toBe('linear');
    expect(knownMode(undefined)).toBe('linear');
    expect(one('bogus' as TimelineMode).mode).toBe('linear');
  });

  it('names the mode in the accessible label, so the glyph is never the only signal', () => {
    for (const mode of TIMELINE_MODES) expect(one(mode).a11yLabel.toLowerCase()).toContain(mode === 'time-skip' ? 'time skip' : mode === 'parallel' ? 'parallel' : mode);
  });
});

describe('per-mode behaviour', () => {
  const many = (modes: Record<string, TimelineMode>, days: Record<string, number>) => {
    const ids = Object.keys(modes);
    const state = project({ scenes: ids.map((id) => ({ id })) });
    return buildTimeline(state, coherence(Object.fromEntries(ids.map((id) => [id, { timelineMode: modes[id] as TimelineMode, ...(days[id] !== undefined ? { dayOffset: days[id] } : {}) }]))), { axis: 'braid' });
  };

  it('frame: the first and last frame scenes bracket the inner story', () => {
    const model = many({ f1: 'frame', x: 'linear', f2: 'frame', f3: 'frame' }, { f1: 0, x: 1, f2: 2, f3: 3 });
    const caps = Object.fromEntries(model.items.map((item) => [item.nodeId, item.bracket]));
    expect(caps).toEqual({ f1: 'open', x: undefined, f2: undefined, f3: 'close' });
    expect(many({ only: 'frame' }, { only: 0 }).items[0]?.bracket).toBe('both');
  });

  it('dream and mythic: a dotted tether to the day, kept out of overlap visuals; undated ones have none', () => {
    const model = many({ d: 'dream', m: 'mythic', u: 'dream' }, { d: 3, m: 8 });
    expect(Object.fromEntries(model.items.map((item) => [item.nodeId, item.tetherDay]))).toEqual({ d: 3, m: 8, u: undefined });
    expect(MODE_RENDER.dream.overlapHighlight).toBe(false);
    expect(MODE_RENDER.mythic.overlapHighlight).toBe(false);
  });

  it('simultaneous: scenes on one day share a column group, and a lone one has none', () => {
    const model = many({ a: 'simultaneous', b: 'simultaneous', c: 'simultaneous', d: 'linear' }, { a: 5, b: 5, c: 9, d: 5 });
    expect(model.simultaneous).toHaveLength(1);
    expect(model.simultaneous[0]).toMatchObject({ day: 5, keys: ['a@all', 'b@all'] });
    expect(model.items.find((item) => item.nodeId === 'a')?.group).toBe(model.simultaneous[0]?.id);
    expect(model.items.find((item) => item.nodeId === 'c')?.group).toBeUndefined();
    expect(MODE_RENDER.simultaneous.overlapHighlight).toBe(false);
  });

  it('flashback and flash-forward: the braid connector is emphasised, a linear one is not', () => {
    const model = many({ a: 'linear', b: 'flashback', c: 'flash-forward' }, { a: 5, b: 1, c: 9 });
    const emphasised = model.connectors.filter((connector) => connector.variant === 'slot' && connector.emphasised === true).map((connector) => connector.fromNode);
    expect(emphasised.sort()).toEqual(['b', 'c']);
  });

  it('circular: the braid links the scene back to the first scene', () => {
    const model = many({ first: 'linear', mid: 'linear', loop: 'circular' }, { first: 0, mid: 5, loop: 9 });
    expect(model.connectors.filter((connector) => connector.variant === 'return').map((connector) => [connector.fromNode, connector.toNode])).toEqual([['loop', 'first']]);
    const story = buildTimeline(project({ scenes: [{ id: 'a' }, { id: 'b' }] }), coherence({ a: { dayOffset: 0 }, b: { dayOffset: 1, timelineMode: 'circular' } }), { axis: 'story' });
    expect(story.connectors).toEqual([]);
  });

  it('time-skip: the scene is preceded by a labelled break', () => {
    const model = many({ a: 'linear', b: 'time-skip' }, { a: 0, b: 90 });
    expect(model.axis.breaks).toMatchObject([{ kind: 'time-skip', label: 'Time skip (declared)', days: 89 }]);
    expect(MODE_RENDER['time-skip'].precededByBreak).toBe(true);
  });

  it('backstory carries a tag and sits in its own lane under group-by mode; parallel is an own strand lane', () => {
    const state = project({ scenes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
    const model = buildTimeline(
      state,
      coherence({ a: { dayOffset: 1, timelineMode: 'backstory' }, b: { dayOffset: 2, timelineMode: 'parallel' }, c: { dayOffset: 3, timelineMode: 'dream' }, d: { dayOffset: 4, timelineMode: 'flashback' } }),
      { axis: 'story', groupBy: 'mode' },
    );
    expect(model.lanes.map((lane) => lane.label)).toEqual(['Main', 'Parallel strand', 'Dream & mythic', 'Backstory']);
    expect(MODE_RENDER.backstory.pattern).toBe('hatched');
    expect(MODE_RENDER.parallel.pattern).toBe('double-edge');
  });
});
