import type { MentionDetector } from '@caotang/coherence';
import { describe, expect, it } from 'vitest';

import { MinHeap, buildTimeline, packRows, type TimelineItem } from '../src/index.js';

import { coherence, entry, project } from './fixtures.js';

const rowsOf = (items: readonly TimelineItem[]): Record<string, number> => Object.fromEntries(items.map((item) => [item.nodeId, item.row]));

describe('packing', () => {
  it('MinHeap pops in order whatever the push order', () => {
    const heap = new MinHeap<number>((a, b) => a < b);
    for (const value of [5, 1, 4, 1, 9, 2, 6, 5, 3]) heap.push(value);
    const out: number[] = [];
    for (let next = heap.pop(); next !== undefined; next = heap.pop()) out.push(next);
    expect(out).toEqual([1, 1, 2, 3, 4, 5, 5, 6, 9]);
  });

  it('packRows reuses a row once the window ends, and half-open windows free it on the end day', () => {
    const packed = packRows([
      { start: 0, end: 1 },
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 1, end: 5 },
      { start: 2, end: 3 },
    ]);
    expect(packed.rows).toEqual([0, 1, 0, 1, 0]);
    expect(packed.rowCount).toBe(2);
  });

  it('stacks same-day scenes by reading index and leaves different days on one row', () => {
    const state = project({ scenes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
    const file = coherence({ a: { dayOffset: 5 }, b: { dayOffset: 5 }, c: { dayOffset: 5 }, d: { dayOffset: 6 } });
    const model = buildTimeline(state, file, { axis: 'story' });
    expect(rowsOf(model.items)).toEqual({ a: 0, b: 1, c: 2, d: 0 });
    expect(model.lanes[0]?.rows).toBe(3);
  });

  it('lets a scene with a duration hold its row for the days it spans', () => {
    const state = project({ scenes: [{ id: 'long' }, { id: 'x' }, { id: 'y' }, { id: 'z' }] });
    const file = coherence({ long: { dayOffset: 0, durationDays: 3 }, x: { dayOffset: 1 }, y: { dayOffset: 2 }, z: { dayOffset: 3 } });
    const model = buildTimeline(state, file, { axis: 'story' });
    expect(rowsOf(model.items)).toEqual({ long: 0, x: 1, y: 1, z: 0 });
  });

  it('packs each part zone on its own, so a prologue scene and a main scene on day 0 share a row', () => {
    const state = project({ scenes: [{ id: 'pro' }, { id: 'm' }] });
    const model = buildTimeline(state, coherence({ pro: { storyPart: 'prologue', dayOffset: 0 }, m: { dayOffset: 0 } }), { axis: 'story' });
    expect(rowsOf(model.items)).toEqual({ pro: 0, m: 0 });
    expect(model.lanes[0]?.rows).toBe(1);
  });
});

describe('lanes', () => {
  const entries = [entry('anna', 'Anna'), entry('ben', 'Ben'), entry('dock', 'The Dock', { type: 'location', attachments: ['s1'] })];
  const state = project({
    entries,
    folders: [{ id: 'ch1', title: 'Chapter 1' }],
    scenes: [
      { id: 's1', parent: 'ch1', body: 'Anna met Ben at the dock.' },
      { id: 's2', parent: 'ch1', body: 'Ben left.' },
      { id: 's3', body: 'Nobody.' },
    ],
  });
  const file = coherence({
    s1: { dayOffset: 1, pov: 'anna', expectedPresent: ['anna', 'ben'], threads: [{ id: 'heist', payoff: 's3' }, { id: 'love', payoff: 's2' }] },
    s2: { dayOffset: 2, pov: 'ben', expectedPresent: ['ben'], timelineMode: 'frame' },
    s3: { dayOffset: 3, timelineMode: 'backstory' },
  });

  it('none: one packed lane', () => {
    const model = buildTimeline(state, file, { axis: 'story' });
    expect(model.lanes.map((lane) => [lane.id, lane.count])).toEqual([['all', 3]]);
  });

  it('pov: a lane per point of view named from the codex, and a "No POV" lane last', () => {
    const model = buildTimeline(state, file, { axis: 'story', groupBy: 'pov' });
    expect(model.lanes.map((lane) => lane.label)).toEqual(['Anna', 'Ben', 'No POV']);
  });

  it('character: a scene appears in every lane it belongs to, with a stable identity per lane', () => {
    const model = buildTimeline(state, file, { axis: 'story', groupBy: 'character' });
    expect(model.lanes.map((lane) => [lane.label, lane.count])).toEqual([['Anna', 1], ['Ben', 2], ['No character', 1]]);
    expect(model.items.filter((item) => item.nodeId === 's1').map((item) => item.key)).toEqual(['s1@character:anna', 's1@character:ben']);
    expect(model.zones[0]?.count).toBe(3);
    expect(model.stats.scenes).toBe(3);
    const again = buildTimeline(state, coherence({ ...file.sceneMeta, s1: { ...file.sceneMeta.s1, expectedPresent: ['ben', 'anna'] } }), { axis: 'story', groupBy: 'character' });
    expect(again.items.map((item) => item.key).sort()).toEqual(model.items.map((item) => item.key).sort());
  });

  it('character: derived appearance spans and one presence polyline per lane, in story order', () => {
    const model = buildTimeline(state, file, { axis: 'story', groupBy: 'character' });
    expect(model.appearances.map((span) => [span.name, span.scenes, span.first.day, span.last.day])).toEqual([['Anna', 1, 1, 1], ['Ben', 2, 1, 2]]);
    const presence = model.connectors.filter((connector) => connector.kind === 'presence');
    expect(presence.map((connector) => [connector.characterId, connector.path])).toEqual([['ben', ['s1@character:ben', 's2@character:ben']]]);
    expect(model.stats).toMatchObject({ characters: 2, presenceDefaultOn: true });
  });

  it('character: detected mentions appear only on request, hollow, and need a detector', () => {
    const detect: MentionDetector = (body, list) => new Map(list.filter((candidate) => body.includes(candidate.name)).map((candidate) => [candidate.id, 1]));
    const off = buildTimeline(state, file, { axis: 'story', groupBy: 'character' });
    expect(off.items.some((item) => item.inferred === true)).toBe(false);
    const noDetector = buildTimeline(state, file, { axis: 'story', groupBy: 'character', includeDetectedMentions: true });
    expect(noDetector.items.some((item) => item.inferred === true)).toBe(false);
    const on = buildTimeline(state, file, { axis: 'story', groupBy: 'character', includeDetectedMentions: true, detector: detect });
    expect(on.items.filter((item) => item.inferred === true)).toEqual([]);
    const loose = buildTimeline(
      project({ entries, scenes: [{ id: 's', body: 'Ben waited.' }] }),
      coherence({ s: { dayOffset: 0, expectedPresent: ['anna'] } }),
      { axis: 'story', groupBy: 'character', includeDetectedMentions: true, detector: detect },
    );
    expect(loose.items.map((item) => [item.key, item.inferred === true])).toEqual([['s@character:anna', false], ['s@character:ben', true]]);
    expect(loose.connectors.filter((connector) => connector.kind === 'presence')).toEqual([]);
  });

  it('mode: Frame on top, then Main, Parallel, Dream and Backstory', () => {
    const model = buildTimeline(state, file, { axis: 'story', groupBy: 'mode' });
    expect(model.lanes.map((lane) => lane.label)).toEqual(['Frame', 'Main', 'Backstory']);
  });

  it('folder: the binder parent, with the manuscript root for a scene outside any folder', () => {
    const model = buildTimeline(state, file, { axis: 'story', groupBy: 'folder' });
    expect(model.lanes.map((lane) => [lane.value, lane.count])).toEqual([['ch1', 2], ['manuscript', 1]]);
  });

  it('location: attached codex locations and an Unplaced lane', () => {
    const model = buildTimeline(state, file, { axis: 'story', groupBy: 'location' });
    expect(model.lanes.map((lane) => [lane.label, lane.count])).toEqual([['The Dock', 1], ['Unplaced', 2]]);
  });

  it('thread: one lane per declared handle in order, and thread arcs to the payoff', () => {
    const model = buildTimeline(state, file, { axis: 'story', groupBy: 'thread' });
    expect(model.lanes.map((lane) => lane.label)).toEqual(['heist', 'love', 'No thread']);
    expect(model.connectors.filter((connector) => connector.kind === 'thread').map((connector) => [connector.threadId, connector.fromNode, connector.toNode])).toEqual([
      ['heist', 's1', 's3'],
      ['love', 's1', 's2'],
    ]);
  });
});
