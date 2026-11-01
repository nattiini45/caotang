/**
 * The timeline editor's pure drop geometry (apps/desktop/src/app/timeline-edit-model.ts, timeline.md §3.5): which chip a narrative
 * drop lands beside and on which side, a move plan as a row target, and the lane edits a vertical drag or Alt+Up/Down asks for.
 * The e2e timeline-edit spec drives these through the page; these pin their return values without one.
 */

import { describe, expect, it } from 'vitest';
import type { Lane, TimelineModel } from '@caotang/timeline';

import { adjacentLane, laneIntent, narrativeDrop, targetOfPlan } from '../src/app/timeline-edit-model.js';

const box = (x: number, y: number, w = 20, h = 10): { x: number; y: number; w: number; h: number } => ({ x, y, w, h });

const chips = [
  { nodeId: 'a', box: box(0, 0) },
  { nodeId: 'b', box: box(30, 0) },
  { nodeId: 'c', box: box(0, 40) },
];

describe('narrativeDrop', () => {
  it('lands before a chip on its reading-start half and after it on the other, left to right', () => {
    expect(narrativeDrop(chips, { x: 32, y: 5 }, 'ltr')).toEqual({ nodeId: 'b', zone: 'before' });
    expect(narrativeDrop(chips, { x: 48, y: 5 }, 'ltr')).toEqual({ nodeId: 'b', zone: 'after' });
  });

  it('swaps the halves in a book read right to left', () => {
    expect(narrativeDrop(chips, { x: 32, y: 5 }, 'rtl')).toEqual({ nodeId: 'b', zone: 'after' });
    expect(narrativeDrop(chips, { x: 48, y: 5 }, 'rtl')).toEqual({ nodeId: 'b', zone: 'before' });
  });

  it('takes the nearest chip in the lane when the pointer is between chips, and weighs a lane change above a sideways gap', () => {
    // In the gap between a (ends at 20) and b (starts at 30), nearer to a.
    expect(narrativeDrop(chips, { x: 22, y: 5 }, 'ltr')).toEqual({ nodeId: 'a', zone: 'after' });
    // Before the first chip of the lane.
    expect(narrativeDrop(chips, { x: -15, y: 5 }, 'ltr')).toEqual({ nodeId: 'a', zone: 'before' });
    // 8 px below lane one is nearer than 30 px above lane two once the vertical gap is weighed.
    expect(narrativeDrop(chips, { x: 5, y: 18 }, 'ltr')?.nodeId).toBe('a');
  });

  it('gives nothing when there is no chip', () => {
    expect(narrativeDrop([], { x: 0, y: 0 }, 'ltr')).toBeUndefined();
  });
});

describe('targetOfPlan', () => {
  const tree = [
    { id: 's1', parentId: 'ch', order: 0 },
    { id: 's2', parentId: 'ch', order: 1 },
    { id: 's3', parentId: 'ch', order: 2 },
    { id: 'x', parentId: 'other', order: 0 },
  ];

  it('anchors after the sibling before the index, leaving the moving scene out', () => {
    expect(targetOfPlan(tree, 's1', { newParentId: 'ch', index: 2 })).toEqual({ parentId: 'ch', anchorId: 's3' });
    expect(targetOfPlan(tree, 's3', { newParentId: 'ch', index: 1 })).toEqual({ parentId: 'ch', anchorId: 's1' });
  });

  it('has no anchor at the start, and clamps an index past the end to the last sibling', () => {
    expect(targetOfPlan(tree, 's2', { newParentId: 'ch', index: 0 })).toEqual({ parentId: 'ch', anchorId: null });
    expect(targetOfPlan(tree, 'x', { newParentId: 'ch', index: 99 })).toEqual({ parentId: 'ch', anchorId: 's3' });
  });
});

const lane = (id: string, key: Lane['key'], value?: string): Lane => ({ id, key, label: id, rows: 1, count: 0, ...(value === undefined ? {} : { value }) });
const modelOf = (lanes: Lane[]): TimelineModel => ({ lanes }) as unknown as TimelineModel;

describe('laneIntent and adjacentLane', () => {
  const povs = modelOf([lane('p-ana', 'pov', 'Ana'), lane('p-none', 'pov'), lane('p-ben', 'pov', 'Ben')]);
  const modes = modelOf([lane('m-main', 'mode', 'main'), lane('m-dream', 'mode', 'dream')]);

  it('makes a POV lane the scene POV, and an unnamed lane clears it; the lane it is in asks for nothing', () => {
    expect(laneIntent(povs, 'p-ben', { mode: 'linear', pov: 'Ana' })).toEqual({ pov: 'Ben' });
    expect(laneIntent(povs, 'p-none', { mode: 'linear', pov: 'Ana' })).toEqual({ pov: null });
    expect(laneIntent(povs, 'p-ana', { mode: 'linear', pov: 'Ana' })).toBeUndefined();
    expect(laneIntent(povs, 'p-none', { mode: 'linear', pov: '' })).toBeUndefined();
  });

  it('makes a mode lane the scene mode, and a mode already drawn in that lane asks for nothing', () => {
    expect(laneIntent(modes, 'm-dream', { mode: 'linear' })).toEqual({ mode: 'dream' });
    expect(laneIntent(modes, 'm-main', { mode: 'dream' })).toEqual({ mode: 'linear' });
    // A flashback is drawn in the main lane already, so dropping it there does not rewrite it as linear.
    expect(laneIntent(modes, 'm-main', { mode: 'flashback' })).toBeUndefined();
  });

  it('asks for nothing in an unknown lane or a grouping without a lane edit', () => {
    expect(laneIntent(povs, 'nope', { mode: 'linear' })).toBeUndefined();
    expect(laneIntent(modelOf([lane('t', 'thread', 'x')]), 't', { mode: 'linear' })).toBeUndefined();
  });

  it('steps to the neighbouring lane, and gives nothing past the first or last', () => {
    expect(adjacentLane(povs, 'p-none', -1)).toBe('p-ana');
    expect(adjacentLane(povs, 'p-none', 1)).toBe('p-ben');
    expect(adjacentLane(povs, 'p-ana', -1)).toBeUndefined();
    expect(adjacentLane(povs, 'p-ben', 1)).toBeUndefined();
    expect(adjacentLane(povs, 'nope', 1)).toBeUndefined();
  });
});
