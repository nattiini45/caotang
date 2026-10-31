import { describe, expect, it } from 'vitest';

import { buildTimeline, projectTimeline, type TimelineItem } from '../src/index.js';

import { coherence, finding, project } from './fixtures.js';

const byNode = (items: readonly TimelineItem[], id: string): TimelineItem => {
  const found = items.find((item) => item.nodeId === id);
  if (found === undefined) throw new Error(`no item for ${id}`);
  return found;
};

describe('part zones and folds (§3.4)', () => {
  const state = project({
    folders: [{ id: 'pro', title: 'Before' }, { id: 'epi', title: 'After' }, { id: 'body', title: 'Body' }],
    scenes: [
      { id: 'p1', parent: 'pro' },
      { id: 'm1', parent: 'body' },
      { id: 'm2', parent: 'body' },
      { id: 'e1', parent: 'epi' },
    ],
  });
  const file = coherence({
    pro: { storyPart: 'prologue' },
    epi: { storyPart: 'epilogue' },
    p1: { dayOffset: -3650 },
    m1: { dayOffset: 0 },
    m2: { dayOffset: 3 },
    e1: { dayOffset: 4380 },
  });

  it('orders zones prologue, main, epilogue and carries each part from its folder', () => {
    const model = buildTimeline(state, file, { axis: 'story' });
    expect(model.zones.map((zone) => [zone.part, zone.startDay, zone.endDay, zone.count])).toEqual([
      ['prologue', -3650, -3649, 1],
      ['main', 0, 4, 2],
      ['epilogue', 4380, 4381, 1],
    ]);
  });

  it('lists items in the canonical order, part then day, whatever the binder order', () => {
    const model = buildTimeline(state, file, { axis: 'story' });
    expect(model.items.map((item) => item.nodeId)).toEqual(['p1', 'm1', 'm2', 'e1']);
    expect(byNode(model.items, 'p1').part).toBe('prologue');
  });

  it('draws a fold between zones, labelled through the lens and never linked to a gap finding', () => {
    const gap = finding('f_gap', 'timeline.gap', ['m2', 'e1']);
    const model = buildTimeline(state, coherence(file.sceneMeta, [gap]), { axis: 'story' });
    expect(model.axis.folds.map((fold) => [fold.fromPart, fold.toPart, fold.part])).toEqual([
      ['prologue', 'main', 'prologue'],
      ['main', 'epilogue', 'epilogue'],
    ]);
    expect(model.axis.folds[0]?.label).toBe('Prologue \u00b7 about 10 years before Day 0');
    expect(model.axis.folds[1]?.label).toBe('Epilogue \u00b7 about 12 years later');
    expect(model.axis.folds[1]?.a11yLabel).toBe('Fold: epilogue, about 12 years later');
    expect(model.axis.folds.some((fold) => 'findingId' in fold)).toBe(false);
    expect(model.axis.breaks.every((brk) => brk.part !== 'epilogue' || brk.findingId === undefined)).toBe(true);
  });

  it('omits parts with no scene and draws no fold with one zone', () => {
    const only = project({ scenes: [{ id: 'a' }, { id: 'b' }] });
    const model = buildTimeline(only, coherence({ a: { dayOffset: 1 }, b: { dayOffset: 2 } }), { axis: 'story' });
    expect(model.zones.map((zone) => zone.part)).toEqual(['main']);
    expect(model.axis.folds).toEqual([]);
  });

  it('keeps a scene dated before day 0 with no declaration in the main zone at its own day', () => {
    const plain = project({ scenes: [{ id: 'a' }, { id: 'b' }] });
    const model = buildTimeline(plain, coherence({ a: { dayOffset: -14 }, b: { dayOffset: 0 } }), { axis: 'story' });
    expect(model.zones).toHaveLength(1);
    expect(model.zones[0]).toMatchObject({ part: 'main', startDay: -14, endDay: 1 });
    expect(byNode(model.items, 'a')).toMatchObject({ part: 'main', start: -14, end: -13 });
    expect(byNode(model.items, 'a').partNote).toBeUndefined();
  });

  it('never infers a part from a title or binder position', () => {
    const titled = project({ scenes: [{ id: 'a', title: 'Prologue' }, { id: 'b', title: 'Epilogue' }] });
    const model = buildTimeline(titled, coherence({ a: { dayOffset: -100 }, b: { dayOffset: 9000 } }), { axis: 'story' });
    expect(model.zones.map((zone) => zone.part)).toEqual(['main']);
  });

  it('lets an explicit main override an inherited prologue and names it so', () => {
    const nested = project({ folders: [{ id: 'pro' }], scenes: [{ id: 'a', parent: 'pro', title: 'Inside' }, { id: 'b', parent: 'pro', title: 'Out' }] });
    const model = buildTimeline(nested, coherence({ pro: { storyPart: 'prologue' }, a: { dayOffset: -5 }, b: { storyPart: 'main', dayOffset: 0 } }), { axis: 'story' });
    expect(byNode(model.items, 'a').part).toBe('prologue');
    expect(byNode(model.items, 'b')).toMatchObject({ part: 'main', partOverride: true });
    expect(byNode(model.items, 'b').a11yLabel.startsWith('Main story: \u2018Out\u2019')).toBe(true);
    expect(byNode(model.items, 'b').a11yLabel).not.toContain('pro');
    expect(byNode(model.items, 'a').a11yLabel.startsWith('Prologue: \u2018Inside\u2019, Day \u22125')).toBe(true);
  });

  it('notes a prologue dated inside the main story and an epilogue dated before its end, and never moves them', () => {
    const tricky = project({ scenes: [{ id: 'pro' }, { id: 'm1' }, { id: 'm2' }, { id: 'epi' }, { id: 'ok' }] });
    const model = buildTimeline(
      tricky,
      coherence({
        pro: { storyPart: 'prologue', dayOffset: 2 },
        m1: { dayOffset: 0 },
        m2: { dayOffset: 10 },
        epi: { storyPart: 'epilogue', dayOffset: 5 },
        ok: { storyPart: 'epilogue', dayOffset: 11 },
      }),
      { axis: 'story' },
    );
    expect(byNode(model.items, 'pro')).toMatchObject({ part: 'prologue', partNote: 'dated-inside-main', start: 2 });
    expect(byNode(model.items, 'epi')).toMatchObject({ part: 'epilogue', partNote: 'dated-inside-main', start: 5 });
    expect(byNode(model.items, 'ok').partNote).toBeUndefined();
    expect(byNode(model.items, 'pro').a11yLabel).toContain('dated inside the main story');
    expect(model.zones.map((zone) => zone.part)).toEqual(['prologue', 'main', 'epilogue']);
    expect(model.axis.folds[0]?.spanDays).toBeUndefined();
  });

  it('puts undated prologue and epilogue scenes on the shelf ahead of the main ones, and gives them no day', () => {
    const shelf = project({ scenes: [{ id: 'm' }, { id: 'e' }, { id: 'p' }, { id: 'm2' }] });
    const model = buildTimeline(shelf, coherence({ e: { storyPart: 'epilogue' }, p: { storyPart: 'prologue' } }), { axis: 'story' });
    expect(model.unscheduled.loose.map((item) => item.nodeId)).toEqual(['p', 'e', 'm', 'm2']);
    expect(model.unscheduled.loose.every((item) => item.start === undefined && item.glyph.pattern === 'dashed')).toBe(true);
    expect(model.zones.map((zone) => [zone.part, zone.startDay, zone.count])).toEqual([
      ['prologue', undefined, 1],
      ['main', undefined, 2],
      ['epilogue', undefined, 1],
    ]);
    expect(model.axis.segments).toEqual([]);
  });

  it('draws narrative part bands where the declared scenes sit in the binder', () => {
    const mid = project({ scenes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }] });
    const model = buildTimeline(mid, coherence({ b: { storyPart: 'prologue' }, c: { storyPart: 'prologue' }, e: { storyPart: 'epilogue' } }), { axis: 'narrative' });
    expect(model.partRuns).toEqual([
      { part: 'prologue', firstReading: 1, lastReading: 2, count: 2 },
      { part: 'epilogue', firstReading: 4, lastReading: 4, count: 1 },
    ]);
    expect(model.items.map((item) => item.readingIndex)).toEqual([1, 2, 0, 3, 4]);
  });

  it('keeps zones and folds in the braid story strip and crosses them with reading connectors', () => {
    const model = buildTimeline(state, file, { axis: 'braid' });
    expect(model.axis.folds).toHaveLength(2);
    const slots = model.connectors.filter((connector) => connector.kind === 'braid' && connector.variant === 'slot');
    expect(slots.map((connector) => connector.fromNode).sort()).toEqual(['e1', 'm1', 'm2', 'p1']);
  });

  it('keeps the canonical model identical for an RTL project and mirrors only the projected geometry', () => {
    const ltr = buildTimeline(project({ ...{ folders: [{ id: 'pro' }], scenes: [{ id: 'p', parent: 'pro' }, { id: 'm' }] }, language: 'en' }), coherence({ pro: { storyPart: 'prologue' }, p: { dayOffset: -30 }, m: { dayOffset: 0 } }), { axis: 'story' });
    const rtl = buildTimeline(project({ ...{ folders: [{ id: 'pro' }], scenes: [{ id: 'p', parent: 'pro' }, { id: 'm' }] }, language: 'ar' }), coherence({ pro: { storyPart: 'prologue' }, p: { dayOffset: -30 }, m: { dayOffset: 0 } }), { axis: 'story' });
    expect(ltr.direction).toBe('ltr');
    expect(rtl.direction).toBe('rtl');
    expect({ ...rtl, direction: 'ltr' }).toEqual(ltr);
    const a = projectTimeline(ltr);
    const b = projectTimeline(rtl);
    expect(b.width).toBe(a.width);
    for (const [at, entry] of a.items.entries()) {
      const mirrored = b.items[at];
      expect(mirrored?.key).toBe(entry.key);
      expect(mirrored?.box.x).toBeCloseTo(a.width - entry.box.x - entry.box.w);
      expect(mirrored?.box.w).toBe(entry.box.w);
      expect(mirrored?.box.y).toBe(entry.box.y);
    }
    for (const [at, zone] of a.zones.entries()) {
      expect(b.zones[at]?.box.x).toBeCloseTo(a.width - zone.box.x - zone.box.w);
    }
    for (const [at, fold] of a.folds.entries()) {
      expect(b.folds[at]?.box.x).toBeCloseTo(a.width - fold.box.x - fold.box.w);
    }
  });
});
