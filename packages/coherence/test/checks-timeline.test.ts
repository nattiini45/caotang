import { describe, expect, it } from 'vitest';

import { GAP_THRESHOLD_DAYS, assembleInput, emptyCoherenceFile, runChecks, type CoherenceFile, type DraftFinding, type SceneMeta } from '../src/index.js';

import { buildState, detect } from './fixtures.js';

function withMeta(sceneMeta: Record<string, SceneMeta>): CoherenceFile {
  return { ...emptyCoherenceFile(), sceneMeta };
}

function drafts(state: ReturnType<typeof buildState>, file: CoherenceFile, ids: Parameters<typeof runChecks>[1]): {
  drafts: DraftFinding[];
  notes: string[];
} {
  const { input } = assembleInput(state, file, { detector: detect });
  return runChecks(input, ids);
}

const ORDER = ['timeline.order-drift'] as const;

describe('timeline.order-drift (§5.1)', () => {
  const twoScenes = (): ReturnType<typeof buildState> =>
    buildState({
      scenes: [
        { id: 'opening', title: 'Opening', body: 'The ferry was late.' },
        { id: 'prologue', title: 'Prologue', body: 'Long before, the island sank.' },
      ],
    });

  it('flags an adjacent pair whose binder order disagrees with the day order, citing both scenes in binder order', () => {
    const file = withMeta({ opening: { dayOffset: 5 }, prologue: { dayOffset: 1 } });
    const out = drafts(twoScenes(), file, ORDER);
    expect(out.drafts).toHaveLength(1);
    const [finding] = out.drafts;
    expect(finding).toMatchObject({ checkId: 'timeline.order-drift', type: 'order-drift', severity: 'info' });
    expect(finding?.message).toContain('"Opening" comes before "Prologue" in the binder');
    expect(finding?.evidence.map((passage) => passage.docId)).toEqual(['opening', 'prologue']);
  });

  it('does not drift two scenes on the same day, whatever their binder order', () => {
    const file = withMeta({ opening: { dayOffset: 3 }, prologue: { dayOffset: 3 } });
    expect(drafts(twoScenes(), file, ORDER).drafts).toEqual([]);
  });

  it('counts unscheduled scenes in a note and never treats them as violations', () => {
    const file = withMeta({ opening: { dayOffset: 5 } });
    const out = drafts(twoScenes(), file, ORDER);
    expect(out.drafts).toEqual([]);
    expect(out.notes.some((note) => note.includes('1 scene(s) unscheduled'))).toBe(true);
  });

  it.each(['flashback', 'flash-forward', 'circular'] as const)('exempts a %s scene from the whole-manuscript comparison (positive control)', (mode) => {
    const file = withMeta({ opening: { dayOffset: 5, timelineMode: mode }, prologue: { dayOffset: 1 } });
    expect(drafts(twoScenes(), file, ORDER).drafts).toEqual([]);
  });

  it('keeps the same drift when the scene is declared linear (negative control)', () => {
    const file = withMeta({ opening: { dayOffset: 5, timelineMode: 'linear' }, prologue: { dayOffset: 1 } });
    expect(drafts(twoScenes(), file, ORDER).drafts).toHaveLength(1);
  });

  it('compares parallel scenes only with scenes that share their mode (per-strand)', () => {
    const state = buildState({
      scenes: [
        { id: 'p1', title: 'Parallel one', body: 'A.' },
        { id: 'p2', title: 'Parallel two', body: 'B.' },
        { id: 'lin', title: 'Linear', body: 'C.' },
      ],
    });
    const file = withMeta({
      p1: { dayOffset: 2, timelineMode: 'parallel' },
      p2: { dayOffset: 1, timelineMode: 'parallel' },
      lin: { dayOffset: 0 },
    });
    const out = drafts(state, file, ORDER);
    expect(out.drafts.map((d) => d.type)).toEqual(['strand-order-drift']);
    expect(out.drafts[0]?.message).toContain('within the parallel strand');
  });

  it('is silent for a parallel strand that already runs in day order', () => {
    const state = buildState({
      scenes: [
        { id: 'p1', title: 'Parallel one', body: 'A.' },
        { id: 'p2', title: 'Parallel two', body: 'B.' },
      ],
    });
    const file = withMeta({ p1: { dayOffset: 1, timelineMode: 'parallel' }, p2: { dayOffset: 4, timelineMode: 'parallel' } });
    expect(drafts(state, file, ORDER).drafts).toEqual([]);
  });

  it('a circular scene out of binder order draws no order finding, though its declared relation still does', () => {
    const state = buildState({
      scenes: [
        { id: 'a', title: 'Ring first', body: 'Ring first.' },
        { id: 'b', title: 'Ring second', body: 'Ring second.' },
      ],
    });
    const file = withMeta({
      a: { dayOffset: 9, timelineMode: 'circular' },
      b: { dayOffset: 2, after: ['a'] },
    });
    const out = drafts(state, file, ['timeline.order-drift', 'timeline.relation']);
    expect(out.drafts.map((d) => d.checkId)).toEqual(['timeline.relation']);
    expect(out.drafts[0]?.type).toBe('after-violated');
  });
});

describe('timeline.relation (§5.1, Finish-to-Start)', () => {
  const state = (): ReturnType<typeof buildState> =>
    buildState({
      scenes: [
        { id: 'summons', title: 'Summons', body: 'A letter arrives.' },
        { id: 'ritual', title: 'Ritual', body: 'The bell rings.' },
      ],
    });

  it('requires the dependent day to clear the dependency day plus its duration', () => {
    const file = withMeta({ summons: { dayOffset: 3, durationDays: 2 }, ritual: { dayOffset: 4, after: ['summons'] } });
    const out = drafts(state(), file, ['timeline.relation']);
    expect(out.drafts).toHaveLength(1);
    const [finding] = out.drafts;
    expect(finding).toMatchObject({ checkId: 'timeline.relation', type: 'after-violated', severity: 'error', expected: 'day 5 or later' });
    expect(finding?.evidence.map((passage) => passage.docId)).toEqual(['ritual', 'summons']);
    expect(finding?.factGroup).toBe('ritual|after:summons');
  });

  it('is satisfied on the boundary day', () => {
    const file = withMeta({ summons: { dayOffset: 3, durationDays: 2 }, ritual: { dayOffset: 5, after: ['summons'] } });
    expect(drafts(state(), file, ['timeline.relation']).drafts).toEqual([]);
  });

  it('still fires for a flashback, since a flashback happens after what it refers to', () => {
    const file = withMeta({ summons: { dayOffset: 3, durationDays: 2 }, ritual: { dayOffset: 4, after: ['summons'], timelineMode: 'flashback' } });
    expect(drafts(state(), file, ['timeline.relation']).drafts).toHaveLength(1);
  });

  it('names an unscheduled dependency in a note and does not invent a violation', () => {
    const file = withMeta({ ritual: { dayOffset: 4, after: ['summons'] } });
    const out = drafts(state(), file, ['timeline.relation']);
    expect(out.drafts).toEqual([]);
    expect(out.notes.some((note) => note.includes('one of them has no day offset'))).toBe(true);
  });

  it('checks a cycle edge by edge: equal days with no duration hold, and a duration breaks both edges', () => {
    const cycle = buildState({
      scenes: [
        { id: 'a', title: 'Alpha', body: 'Alpha text.' },
        { id: 'b', title: 'Beta', body: 'Beta text.' },
      ],
    });
    const zero = withMeta({ a: { dayOffset: 2, after: ['b'] }, b: { dayOffset: 2, after: ['a'] } });
    expect(drafts(cycle, zero, ['timeline.relation']).drafts).toEqual([]);

    const timed = withMeta({
      a: { dayOffset: 2, durationDays: 1, after: ['b'] },
      b: { dayOffset: 2, durationDays: 1, after: ['a'] },
    });
    const out = drafts(cycle, timed, ['timeline.relation']);
    expect(out.drafts.map((d) => d.factGroup).sort()).toEqual(['a|after:b', 'b|after:a']);
  });
});

describe('timeline.window (§5.1)', () => {
  const state = (): ReturnType<typeof buildState> =>
    buildState({
      folders: [
        { id: 'act1', title: 'Act One' },
        { id: 'act2', title: 'Act Two' },
      ],
      scenes: [
        { id: 'inside', title: 'Inside', parent: 'act1', body: 'Inside.' },
        { id: 'outside', title: 'Outside', parent: 'act1', body: 'Outside.' },
        { id: 'dreamt', title: 'Dreamt', parent: 'act1', body: 'Dreamt.' },
        { id: 'loose', title: 'Loose', parent: 'act2', body: 'Loose.' },
      ],
    });

  it('flags a scene whose window falls outside its folder span, and exempts a dream', () => {
    const file = withMeta({
      act1: { dayOffset: 10, durationDays: 5 },
      inside: { dayOffset: 12 },
      outside: { dayOffset: 15 },
      dreamt: { dayOffset: 30, timelineMode: 'dream' },
    });
    const out = drafts(state(), file, ['timeline.window']);
    expect(out.drafts).toHaveLength(1);
    const [finding] = out.drafts;
    expect(finding).toMatchObject({ checkId: 'timeline.window', type: 'outside-span', severity: 'warning' });
    expect(finding?.message).toBe('"Outside" falls outside "Act One", which spans days 10 to 14');
  });

  it('checks nothing for a folder that declares no duration', () => {
    const file = withMeta({ act2: { dayOffset: 0 }, loose: { dayOffset: 99 } });
    expect(drafts(state(), file, ['timeline.window']).drafts).toEqual([]);
  });
});

describe('timeline.overlap (§5.1)', () => {
  const state = (): ReturnType<typeof buildState> =>
    buildState({
      scenes: [
        { id: 'x', title: 'Ex', body: 'X.' },
        { id: 'y', title: 'Why', body: 'Y.' },
      ],
    });

  it('reports sibling scenes whose windows share a day, as information', () => {
    const file = withMeta({ x: { dayOffset: 3, durationDays: 2 }, y: { dayOffset: 4 } });
    const out = drafts(state(), file, ['timeline.overlap']);
    expect(out.drafts).toHaveLength(1);
    expect(out.drafts[0]).toMatchObject({ checkId: 'timeline.overlap', severity: 'info' });
    expect(out.drafts[0]?.message).toBe('"Ex" and "Why" share day 4');
  });

  it('exempts a simultaneous scene, since declaring simultaneity is the intent this check asks about', () => {
    const file = withMeta({ x: { dayOffset: 3, durationDays: 2, timelineMode: 'simultaneous' }, y: { dayOffset: 4 } });
    expect(drafts(state(), file, ['timeline.overlap']).drafts).toEqual([]);
  });
});

describe('timeline.gap (§5.1)', () => {
  const GAP = ['timeline.gap'] as const;
  const twoScenes = (): ReturnType<typeof buildState> =>
    buildState({
      scenes: [
        { id: 'before', title: 'Before', body: 'The ferry left.' },
        { id: 'after', title: 'After', body: 'The ferry came back.' },
      ],
    });

  it('names both scenes and the day count when a scene comes 7 days after the one before it, as information', () => {
    const file = withMeta({ before: { dayOffset: 2 }, after: { dayOffset: 2 + GAP_THRESHOLD_DAYS } });
    const out = drafts(twoScenes(), file, GAP);
    expect(out.drafts).toHaveLength(1);
    const [finding] = out.drafts;
    expect(finding).toMatchObject({ checkId: 'timeline.gap', type: 'time-gap', severity: 'info' });
    expect(finding?.message).toBe('"After" happens 7 days after "Before"');
    expect(finding?.expected).toContain('time skip');
    expect(finding?.evidence.map((passage) => passage.docId)).toEqual(['before', 'after']);
  });

  it('is silent for 6 days, and for two scenes on the same day', () => {
    expect(drafts(twoScenes(), withMeta({ before: { dayOffset: 2 }, after: { dayOffset: 8 } }), GAP).drafts).toEqual([]);
    expect(drafts(twoScenes(), withMeta({ before: { dayOffset: 2 }, after: { dayOffset: 2 } }), GAP).drafts).toEqual([]);
  });

  it('measures start to start, whatever the earlier scene’s duration', () => {
    const file = withMeta({ before: { dayOffset: 0, durationDays: 30 }, after: { dayOffset: 7 } });
    expect(drafts(twoScenes(), file, GAP).drafts).toHaveLength(1);
  });

  it('compares scenes in day order, not binder order', () => {
    const state = buildState({
      scenes: [
        { id: 'a', title: 'Alpha', body: 'A.' },
        { id: 'b', title: 'Beta', body: 'B.' },
        { id: 'c', title: 'Gamma', body: 'C.' },
      ],
    });
    // Binder order a, b, c; day order a (0), c (3), b (20): only c -> b is a gap.
    const out = drafts(state, withMeta({ a: { dayOffset: 0 }, b: { dayOffset: 20 }, c: { dayOffset: 3 } }), GAP);
    expect(out.drafts.map((d) => d.message)).toEqual(['"Beta" happens 17 days after "Gamma"']);
  });

  it.each(['time-skip', 'dream', 'mythic'] as const)('raises nothing when either side is %s (positive control)', (mode) => {
    const later = withMeta({ before: { dayOffset: 0 }, after: { dayOffset: 40, timelineMode: mode } });
    expect(drafts(twoScenes(), later, GAP).drafts).toEqual([]);
    const earlier = withMeta({ before: { dayOffset: 0, timelineMode: mode }, after: { dayOffset: 40 } });
    expect(drafts(twoScenes(), earlier, GAP).drafts).toEqual([]);
  });

  it('raises the finding for the same pair when both sides are linear (negative control)', () => {
    const file = withMeta({ before: { dayOffset: 0, timelineMode: 'linear' }, after: { dayOffset: 40, timelineMode: 'linear' } });
    expect(drafts(twoScenes(), file, GAP).drafts).toHaveLength(1);
  });

  it.each(['backstory', 'flashback'] as const)('does not exempt a %s scene', (mode) => {
    const file = withMeta({ before: { dayOffset: 0 }, after: { dayOffset: 40, timelineMode: mode } });
    expect(drafts(twoScenes(), file, GAP).drafts).toHaveLength(1);
  });

  it('counts unscheduled scenes in a note and never treats them as violations', () => {
    const out = drafts(twoScenes(), withMeta({ before: { dayOffset: 0 } }), GAP);
    expect(out.drafts).toEqual([]);
    expect(out.notes.some((note) => note.includes('1 scene(s) unscheduled'))).toBe(true);
  });

  it('says the unscheduled count once when order-drift and gap both run', () => {
    const out = drafts(twoScenes(), withMeta({ before: { dayOffset: 0 } }), ['timeline.order-drift', 'timeline.gap']);
    expect(out.notes.filter((note) => note.includes('unscheduled'))).toHaveLength(1);
  });

  it('compares parallel scenes within their strand, not against the main sequence', () => {
    const state = buildState({
      scenes: [
        { id: 'm1', title: 'Main one', body: 'A.' },
        { id: 'p1', title: 'Parallel one', body: 'B.' },
        { id: 'm2', title: 'Main two', body: 'C.' },
        { id: 'p2', title: 'Parallel two', body: 'D.' },
      ],
    });
    // Across strands every neighbour is 30 or more days away, within each strand the pair is 2 days apart.
    const file = withMeta({
      m1: { dayOffset: 0 },
      p1: { dayOffset: 30, timelineMode: 'parallel' },
      m2: { dayOffset: 2 },
      p2: { dayOffset: 32, timelineMode: 'parallel' },
    });
    expect(drafts(state, file, GAP).drafts).toEqual([]);
    const far = withMeta({
      m1: { dayOffset: 0 },
      p1: { dayOffset: 30, timelineMode: 'parallel' },
      m2: { dayOffset: 2 },
      p2: { dayOffset: 50, timelineMode: 'parallel' },
    });
    const out = drafts(state, far, GAP);
    expect(out.drafts).toHaveLength(1);
    expect(out.drafts[0]?.message).toBe('"Parallel two" happens 20 days after "Parallel one", within the parallel strand');
  });

  it('keeps a time-skip scene in the date-order group: out of binder order it still raises order-drift', () => {
    const file = withMeta({ before: { dayOffset: 5, timelineMode: 'time-skip' }, after: { dayOffset: 1 } });
    const out = drafts(twoScenes(), file, ['timeline.order-drift', 'timeline.gap']);
    expect(out.drafts.map((d) => d.checkId)).toEqual(['timeline.order-drift']);
  });

  it('leaves a binder-reversed pair under 7 days to order-drift alone', () => {
    const file = withMeta({ before: { dayOffset: 5 }, after: { dayOffset: 1 } });
    const out = drafts(twoScenes(), file, ['timeline.order-drift', 'timeline.gap']);
    expect(out.drafts.map((d) => d.checkId)).toEqual(['timeline.order-drift']);
  });

  it('reports a binder-reversed pair 7 or more days apart twice, once for the order and once for the size, under separate fact groups', () => {
    const file = withMeta({ before: { dayOffset: 20 }, after: { dayOffset: 1 } });
    const out = drafts(twoScenes(), file, ['timeline.order-drift', 'timeline.gap']);
    expect(out.drafts.map((d) => d.checkId)).toEqual(['timeline.order-drift', 'timeline.gap']);
    const [drift, gap] = out.drafts;
    expect(drift?.factGroup).not.toBe(gap?.factGroup);
    expect(gap?.message).toBe('"Before" happens 19 days after "After"');
  });

  it('keys the finding on the pair, so an unrelated edit leaves the dismissal in place', () => {
    const file = withMeta({ before: { dayOffset: 0 }, after: { dayOffset: 9 } });
    expect(drafts(twoScenes(), file, GAP).drafts[0]?.factGroup).toBe('after+before|gap');
    const edited = withMeta({ before: { dayOffset: 0 }, after: { dayOffset: 12 } });
    expect(drafts(twoScenes(), edited, GAP).drafts[0]?.factGroup).toBe('after+before|gap');
  });
});
