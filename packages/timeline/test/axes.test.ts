import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildTimeline, defaultAxisFor, projectTimeline, semanticLevelOf, type TimelineItem } from '../src/index.js';

import { coherence, finding, project } from './fixtures.js';

const ids = (items: readonly TimelineItem[]): string[] => items.map((item) => item.nodeId);

describe('the three axes', () => {
  const state = project({
    folders: [{ id: 'one', title: 'Chapter 1' }, { id: 'two', title: 'Chapter 2' }],
    scenes: [
      { id: 'a', parent: 'one', body: 'one two three' },
      { id: 'b', parent: 'one', body: 'one two' },
      { id: 'c', parent: 'two', body: 'one' },
      { id: 'd', parent: 'two' },
    ],
  });
  const file = coherence({ a: { dayOffset: 10 }, b: { dayOffset: 2 }, c: { dayOffset: 11, durationDays: 3 } });

  it('story: x follows the day, undated scenes stay out of the segments, and the reading slot is kept', () => {
    const model = buildTimeline(state, file, { axis: 'story' });
    expect(model.axis.kind).toBe('story');
    expect(ids(model.items)).toEqual(['b', 'a', 'c', 'd']);
    expect(model.items.find((item) => item.nodeId === 'c')).toMatchObject({ start: 11, end: 14, readingIndex: 2, durationDays: 3 });
    expect(model.items.find((item) => item.nodeId === 'd')?.start).toBeUndefined();
    expect(model.stats).toMatchObject({ scenes: 4, scheduled: 3, share: 0.75 });
    expect(defaultAxisFor(model.stats)).toBe('story');
  });

  it('narrative: items stack nowhere, every scene has a slot, and the model keeps the same canonical order', () => {
    const story = buildTimeline(state, file, { axis: 'story' });
    const narrative = buildTimeline(state, file, { axis: 'narrative' });
    expect(narrative.axis.measures).toEqual([3, 2, 1, 0]);
    expect(narrative.axis.segments).toEqual([]);
    expect(narrative.items.every((item) => item.row === 0)).toBe(true);
    expect(ids(narrative.items)).toEqual(ids(story.items));
    const geometry = projectTimeline(narrative, { slotPx: 10 });
    const byId = new Map(geometry.items.map((entry) => [entry.key.split('@')[0], entry.box]));
    expect([...'abcd'].map((id) => byId.get(id)?.x)).toEqual([0, 10, 20, 30]);
  });

  it('narrative proportional slots follow the measure within a clamp', () => {
    const narrative = buildTimeline(state, file, { axis: 'narrative' });
    const geometry = projectTimeline(narrative, { slotPx: 10, proportionalSlots: true });
    const width = (id: string): number => geometry.slots.find((slot) => slot.nodeId === id)?.box.w as number;
    expect(width('a')).toBeGreaterThan(width('b'));
    expect(width('b')).toBeGreaterThan(width('c'));
    expect(width('d')).toBe(5);
  });

  it('braid: carries both strips and a connector from each reading slot to its day', () => {
    const model = buildTimeline(state, file, { axis: 'braid' });
    const slots = model.connectors.filter((connector) => connector.variant === 'slot');
    expect(slots.map((connector) => [connector.from, connector.to])).toEqual([
      ['slot:b', 'b@all'],
      ['slot:a', 'a@all'],
      ['slot:c', 'c@all'],
    ]);
    const geometry = projectTimeline(model);
    expect(geometry.slots).toHaveLength(4);
    expect(geometry.slots[0]?.box.y).toBe(0);
    expect(geometry.items[0]?.box.y).toBeGreaterThan(geometry.slots[0]?.box.y as number);
  });

  it('defaults to the narrative axis when fewer than half the scenes have a day', () => {
    const model = buildTimeline(state, coherence({ a: { dayOffset: 1 } }), { axis: 'story' });
    expect(defaultAxisFor(model.stats)).toBe('narrative');
  });

  it('an empty project builds an empty model on every axis', () => {
    const empty = project({});
    for (const axis of ['story', 'narrative', 'braid'] as const) {
      const model = buildTimeline(empty, coherence({}), { axis, groupBy: 'character' });
      expect(model.items).toEqual([]);
      expect(model.zones).toEqual([]);
      expect(model.lanes).toEqual([]);
      expect(model.connectors).toEqual([]);
      expect(model.unscheduled).toEqual({ sequenced: [], loose: [] });
      expect(model.stats).toMatchObject({ scenes: 0, scheduled: 0, share: 0 });
      expect(projectTimeline(model)).toMatchObject({ width: 0, items: [] });
    }
  });

  it('scopes to a folder, a document and the manuscript, and shows only the zones its scenes fall in', () => {
    const scoped = project({
      folders: [{ id: 'f1' }, { id: 'f2' }],
      scenes: [{ id: 'a', parent: 'f1' }, { id: 'b', parent: 'f2' }, { id: 'c', parent: 'f2' }],
    });
    const meta = coherence({ f2: { storyPart: 'epilogue' }, a: { dayOffset: 0 }, b: { dayOffset: 50 }, c: { dayOffset: 51 } });
    const all = buildTimeline(scoped, meta, { axis: 'story' });
    expect(all.zones.map((zone) => zone.part)).toEqual(['main', 'epilogue']);
    const inF1 = buildTimeline(scoped, meta, { axis: 'story', scope: 'f1' });
    expect(ids(inF1.items)).toEqual(['a']);
    expect(inF1.zones.map((zone) => zone.part)).toEqual(['main']);
    const inF2 = buildTimeline(scoped, meta, { axis: 'story', scope: 'f2' });
    expect(inF2.zones.map((zone) => zone.part)).toEqual(['epilogue']);
    expect(inF2.items.map((item) => item.readingIndex)).toEqual([0, 1]);
    expect(ids(buildTimeline(scoped, meta, { axis: 'story', scope: 'c' }).items)).toEqual(['c']);
    expect(ids(buildTimeline(scoped, meta, { axis: 'story', scope: 'manuscript' }).items)).toEqual(['a', 'b', 'c']);
    expect(buildTimeline(scoped, meta, { axis: 'story', scope: 'nope' }).items).toEqual([]);
  });

  it('leaves research documents and archived scenes out', () => {
    const mixed = project({ scenes: [{ id: 'a' }, { id: 'old', status: 'archived' }], research: [{ id: 'r' }] });
    expect(ids(buildTimeline(mixed, coherence({ r: { dayOffset: 1 } }), { axis: 'narrative' }).items)).toEqual(['a']);
  });
});

describe('gap compression and breaks', () => {
  const state = project({ scenes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });

  it('collapses runs of 7 or more empty days into a labelled break and leaves shorter ones', () => {
    const file = coherence({ a: { dayOffset: 0 }, b: { dayOffset: 4 }, c: { dayOffset: 11 }, d: { dayOffset: 30 } });
    const model = buildTimeline(state, file, { axis: 'story' });
    expect(model.axis.segments.map((segment) => [segment.from, segment.to])).toEqual([
      [0, 12],
      [30, 31],
    ]);
    expect(model.axis.breaks).toMatchObject([{ fromDay: 12, toDay: 30, days: 18, kind: 'gap', label: '+18 days' }]);
    const exact = buildTimeline(state, coherence({ a: { dayOffset: 0 }, b: { dayOffset: 7 } }), { axis: 'story' });
    expect(exact.axis.breaks).toEqual([]);
    const seven = buildTimeline(state, coherence({ a: { dayOffset: 0 }, b: { dayOffset: 8 } }), { axis: 'story' });
    expect(seven.axis.breaks).toMatchObject([{ days: 7 }]);
  });

  it('does not collapse anything when compression is off', () => {
    const model = buildTimeline(state, coherence({ a: { dayOffset: 0 }, b: { dayOffset: 100 } }), { axis: 'story', compressGaps: false });
    expect(model.axis.segments).toHaveLength(1);
    expect(model.axis.breaks).toEqual([]);
  });

  it('reads "Time skip (declared)" on a time-skip break and links an open gap finding otherwise', () => {
    const skip = buildTimeline(state, coherence({ a: { dayOffset: 0 }, b: { dayOffset: 40, timelineMode: 'time-skip' } }), { axis: 'story' });
    expect(skip.axis.breaks[0]).toMatchObject({ kind: 'time-skip', label: 'Time skip (declared)' });
    const gap = finding('f_g', 'timeline.gap', ['a', 'b']);
    const linked = buildTimeline(state, coherence({ a: { dayOffset: 0 }, b: { dayOffset: 40 } }, [gap]), { axis: 'story' });
    expect(linked.axis.breaks[0]?.findingId).toBe('f_g');
    const dismissed = buildTimeline(state, coherence({ a: { dayOffset: 0 }, b: { dayOffset: 40 } }, [{ ...gap, status: 'dismissed' }]), { axis: 'story' });
    expect(dismissed.axis.breaks[0]?.findingId).toBeUndefined();
  });

  it('a break narrows the projected axis by its collapsed days', () => {
    const file = coherence({ a: { dayOffset: 0 }, b: { dayOffset: 1000 } });
    const compressed = projectTimeline(buildTimeline(state, file, { axis: 'story' }), { pxPerDay: 10, breakPx: 20 });
    const full = projectTimeline(buildTimeline(state, file, { axis: 'story', compressGaps: false }), { pxPerDay: 10 });
    expect(compressed.width).toBe(2 * 10 + 20);
    expect(full.width).toBe(1001 * 10);
  });
});

describe('zoom, blocks and findings on items', () => {
  const state = project({
    folders: [{ id: 'act1', title: 'Act 1' }, { id: 'ch1', title: 'Chapter 1', parent: 'act1' }, { id: 'ch2', title: 'Chapter 2', parent: 'act1' }],
    scenes: [{ id: 'a', parent: 'ch1' }, { id: 'b', parent: 'ch1' }, { id: 'c', parent: 'ch2' }],
  });
  const file = coherence({ a: { dayOffset: 0 }, b: { dayOffset: 1 }, c: { dayOffset: 2 } }, [finding('f1', 'timeline.overlap', ['a', 'b'])]);

  it('maps zoom to semantic levels and aggregates chapters and acts with an open-findings count', () => {
    expect(['day', 'week', 'month', 'fit', 'scene', 'chapter', 'act'].map((zoom) => semanticLevelOf(zoom as 'day'))).toEqual(['scene', 'scene', 'chapter', 'act', 'scene', 'chapter', 'act']);
    expect(buildTimeline(state, file, { axis: 'narrative' }).blocks).toEqual([]);
    const chapters = buildTimeline(state, file, { axis: 'narrative', zoom: 'chapter' }).blocks;
    expect(chapters.map((block) => [block.label, block.count, block.openFindings])).toEqual([
      ['Chapter 1', 2, 1],
      ['Chapter 2', 1, 0],
    ]);
    const acts = buildTimeline(state, file, { axis: 'narrative', zoom: 'act' }).blocks;
    expect(acts).toMatchObject([{ label: 'Act 1', count: 3, start: 0, end: 3, openFindings: 1 }]);
  });

  it('puts open findings on items and draws pair findings as connectors, never dismissed ones', () => {
    const model = buildTimeline(state, file, { axis: 'story' });
    expect(model.items[0]?.findings.map((ref) => ref.id)).toEqual(['f1']);
    expect(model.connectors.filter((connector) => connector.kind === 'finding')).toMatchObject([{ checkId: 'timeline.overlap', findingId: 'f1' }]);
    expect(model.items[0]?.a11yLabel).toContain('overlaps \u2018b\u2019');
    const none = buildTimeline(state, file, { axis: 'story', findings: 'none' });
    expect(none.items.every((item) => item.findings.length === 0)).toBe(true);
    const dismissed = buildTimeline(state, coherence(file.sceneMeta, [{ ...(file.findings[0] as (typeof file.findings)[number]), status: 'dismissed' }]), { axis: 'story' });
    expect(dismissed.items.every((item) => item.findings.length === 0)).toBe(true);
  });

  it('bands each folder that holds scenes with its reading range', () => {
    const model = buildTimeline(state, file, { axis: 'narrative' });
    expect(model.bands.map((band) => [band.nodeId, band.depth, band.firstReading, band.lastReading, band.count])).toEqual([
      ['act1', 0, 0, 2, 3],
      ['ch1', 1, 0, 1, 2],
      ['ch2', 1, 2, 2, 1],
    ]);
  });
});

describe('purity', () => {
  it('imports no DOM, React or message library, and touches no browser global', () => {
    const dir = join(import.meta.dirname, '..', 'src');
    for (const name of readdirSync(dir)) {
      const source = readFileSync(join(dir, name), 'utf8');
      expect(source, name).not.toMatch(/from '(react|react-dom|@lingui\/[^']*)'/u);
      expect(source, name).not.toMatch(/\b(document|window|localStorage|indexedDB)\.[a-z]/u);
    }
  });
});