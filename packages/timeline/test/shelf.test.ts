import { describe, expect, it } from 'vitest';

import { buildTimeline, findCycles } from '../src/index.js';

import { coherence, project } from './fixtures.js';

const chainIds = (model: ReturnType<typeof buildTimeline>): string[][] => model.unscheduled.sequenced.map((chain) => chain.steps.map((step) => step.item.nodeId));

describe('the unscheduled shelf (§3.7)', () => {
  it('sorts a chain topologically with binder order as the tie-break, and leaves the rest loose in reading order', () => {
    const state = project({ scenes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id })) });
    const model = buildTimeline(
      state,
      coherence({
        a: { after: ['c'] },
        c: { after: ['d'] },
        e: { after: ['g'] },
        f: { after: ['g'] },
      }),
      { axis: 'story' },
    );
    expect(chainIds(model)).toEqual([['d', 'c', 'a'], ['g', 'e', 'f']]);
    expect(model.unscheduled.loose.map((item) => item.nodeId)).toEqual(['b']);
    expect(model.items.every((item) => item.start === undefined && item.end === undefined && item.dayOffset === undefined)).toBe(true);
  });

  it('puts an undated scene after a dated one in the sequenced group with an "after Day N" hint', () => {
    const state = project({ scenes: [{ id: 'dated' }, { id: 'long' }, { id: 'u1' }, { id: 'u2' }, { id: 'free' }] });
    const model = buildTimeline(
      state,
      coherence({ dated: { dayOffset: 12 }, long: { dayOffset: 20, durationDays: 3 }, u1: { after: ['dated'] }, u2: { after: ['long', 'dated'] } }),
      { axis: 'story' },
    );
    expect(chainIds(model)).toEqual([['u1'], ['u2']]);
    expect(model.unscheduled.sequenced.map((chain) => chain.steps[0]?.anchor)).toEqual([
      { nodeId: 'dated', day: 12, hint: 'after Day 12' },
      { nodeId: 'long', day: 23, hint: 'after Day 23' },
    ]);
    expect(model.unscheduled.loose.map((item) => item.nodeId)).toEqual(['free']);
  });

  it('draws a cycle as a broken chain, marks the scenes, and still lists what the cycle holds back', () => {
    const state = project({ scenes: ['p', 'q', 'r', 's', 'solo'].map((id) => ({ id })) });
    const model = buildTimeline(state, coherence({ p: { after: ['q'] }, q: { after: ['p'] }, r: { after: ['q'] }, s: { after: ['s'] } }), { axis: 'story' });
    const chains = model.unscheduled.sequenced;
    expect(chains.map((chain) => [chain.cycle, chain.steps.map((step) => [step.item.nodeId, step.inCycle])])).toEqual([
      [true, [['p', true], ['q', true], ['r', false]]],
      [true, [['s', true]]],
    ]);
    expect(model.items.filter((item) => item.inCycle === true).map((item) => item.nodeId).sort()).toEqual(['p', 'q', 's']);
    expect(model.unscheduled.loose.map((item) => item.nodeId)).toEqual(['solo']);
  });

  it('marks an after cycle between dated scenes on its connectors', () => {
    const state = project({ scenes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    const model = buildTimeline(state, coherence({ a: { dayOffset: 0, after: ['b'] }, b: { dayOffset: 1, after: ['a'] }, c: { dayOffset: 2, after: ['b'] } }), { axis: 'story' });
    const byId = Object.fromEntries(model.connectors.map((connector) => [connector.id, connector]));
    expect(byId['after:b>a']).toMatchObject({ cycle: true, violation: true });
    expect(byId['after:a>b']).toMatchObject({ cycle: true });
    expect(byId['after:a>b']?.violation).toBeUndefined();
    expect(byId['after:b>c']?.cycle).toBeUndefined();
  });

  it('flags an after link the days contradict, using duration or zero', () => {
    const state = project({ scenes: [{ id: 'storm' }, { id: 'letter' }, { id: 'ok' }] });
    const model = buildTimeline(
      state,
      coherence({ storm: { dayOffset: 10, durationDays: 4 }, letter: { dayOffset: 12, after: ['storm'] }, ok: { dayOffset: 14, after: ['storm'] } }),
      { axis: 'story' },
    );
    expect(model.connectors.map((connector) => [connector.toNode, connector.violation === true])).toEqual([['letter', true], ['ok', false]]);
  });

  it('keeps part groups ahead of the main ones and a chain in the part of its first step', () => {
    const state = project({ scenes: ['m1', 'm2', 'e1', 'p1', 'p2'].map((id) => ({ id })) });
    const model = buildTimeline(
      state,
      coherence({ e1: { storyPart: 'epilogue' }, p1: { storyPart: 'prologue' }, p2: { storyPart: 'prologue', after: ['p1'] }, m2: { after: ['m1'] } }),
      { axis: 'narrative' },
    );
    expect(model.unscheduled.sequenced.map((chain) => [chain.part, chain.steps.map((step) => step.item.nodeId)])).toEqual([
      ['prologue', ['p1', 'p2']],
      ['main', ['m1', 'm2']],
    ]);
    expect(model.unscheduled.loose.map((item) => [item.part, item.nodeId])).toEqual([['epilogue', 'e1']]);
  });

  it('ignores an after target that is not a scene in the manuscript, and lists each scene once however many lanes show it', () => {
    const state = project({ scenes: [{ id: 'a' }], research: [{ id: 'note' }] });
    const model = buildTimeline(state, coherence({ a: { after: ['note', 'missing'], expectedPresent: ['x', 'y'] } }), { axis: 'story', groupBy: 'character' });
    expect(model.items).toHaveLength(2);
    expect(model.unscheduled.loose.map((item) => item.nodeId)).toEqual(['a']);
    expect(model.unscheduled.sequenced).toEqual([]);
  });

  it('findCycles reports numbered cycles and nothing for a chain', () => {
    const cycles = findCycles(new Map([['a', ['b']], ['b', ['c']], ['c', ['a']], ['d', ['a']], ['e', ['e']], ['f', ['g']]]));
    expect([...cycles.keys()].sort()).toEqual(['a', 'b', 'c', 'e']);
    expect(cycles.get('a')).toBe(cycles.get('b'));
    expect(cycles.get('e')).not.toBe(cycles.get('a'));
  });
});
