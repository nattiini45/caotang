import { describe, expect, it } from 'vitest';

import {
  GAP_THRESHOLD_DAYS,
  assembleInput,
  effectiveStoryPart,
  effectiveStoryParts,
  emptyCoherenceFile,
  parseCoherenceFile,
  runChecks,
  snapshotManuscript,
  type CoherenceFile,
  type DeterministicCheckId,
  type SceneMeta,
} from '../src/index.js';

import { buildState, detect } from './fixtures.js';

const withMeta = (sceneMeta: Record<string, SceneMeta>): CoherenceFile => ({ ...emptyCoherenceFile(), sceneMeta });

const TIMELINE_CHECKS: readonly DeterministicCheckId[] = ['timeline.order-drift', 'timeline.relation', 'timeline.window', 'timeline.overlap', 'timeline.gap'];

function findings(state: ReturnType<typeof buildState>, file: CoherenceFile, ids: readonly DeterministicCheckId[] = TIMELINE_CHECKS) {
  const { input } = assembleInput(state, file, { detector: detect });
  return runChecks(input, ids).drafts;
}

const LONG_APART = 4000;

describe('effective story parts (§5.2.2)', () => {
  const tree = [
    { id: 'manuscript', parentId: null },
    { id: 'pro', parentId: 'manuscript' },
    { id: 'inner', parentId: 'pro' },
    { id: 'deep', parentId: 'inner' },
    { id: 'plain', parentId: 'manuscript' },
  ];

  it('is main for a node with no declaration anywhere above it', () => {
    expect(effectiveStoryPart(tree, {}, 'deep')).toBe('main');
    expect(effectiveStoryPart(tree, {}, 'unknown-node')).toBe('main');
  });

  it('reads the nearest declaration above a node, through any depth', () => {
    const meta = { pro: { storyPart: 'prologue' as const } };
    expect(effectiveStoryPart(tree, meta, 'deep')).toBe('prologue');
    expect(effectiveStoryPart(tree, meta, 'plain')).toBe('main');
  });

  it('lets an explicit main under a prologue folder override it, while its siblings stay prologue', () => {
    const meta = { pro: { storyPart: 'prologue' as const }, deep: { storyPart: 'main' as const } };
    const parts = effectiveStoryParts(tree, meta);
    expect(parts.get('deep')).toBe('main');
    expect(parts.get('inner')).toBe('prologue');
  });

  it('lets a nested folder override its parent, and a node override both', () => {
    const meta = { pro: { storyPart: 'prologue' as const }, inner: { storyPart: 'epilogue' as const }, deep: { storyPart: 'prologue' as const } };
    const parts = effectiveStoryParts(tree, meta);
    expect(parts.get('inner')).toBe('epilogue');
    expect(parts.get('deep')).toBe('prologue');
    expect(effectiveStoryPart(tree, { ...meta, deep: undefined }, 'deep')).toBe('epilogue');
  });

  it('returns to the inherited part once the explicit declaration is cleared', () => {
    const declared = { pro: { storyPart: 'prologue' as const }, deep: { storyPart: 'main' as const } };
    expect(effectiveStoryPart(tree, declared, 'deep')).toBe('main');
    expect(effectiveStoryPart(tree, { pro: declared.pro, deep: {} }, 'deep')).toBe('prologue');
  });

  it('ignores a value that is not a story part, so the node inherits', () => {
    const meta = { pro: { storyPart: 'prologue' as const }, deep: { storyPart: 'interlude' } };
    expect(effectiveStoryPart(tree, meta, 'deep')).toBe('prologue');
  });

  it('re-parts the children when the declaring folder is moved, deleted to the trash or cleared, with no write of theirs', () => {
    const meta = { pro: { storyPart: 'prologue' as const } };
    const before = effectiveStoryParts(tree, meta);
    expect(before.get('deep')).toBe('prologue');

    const moved = tree.map((node) => (node.id === 'inner' ? { ...node, parentId: 'plain' } : node));
    expect(effectiveStoryPart(moved, meta, 'deep')).toBe('main');

    const trashed = tree.map((node) => (node.id === 'pro' ? { ...node, parentId: 'trash' } : node));
    expect(effectiveStoryPart(trashed, meta, 'pro')).toBe('prologue');
    expect(effectiveStoryPart(trashed, meta, 'plain')).toBe('main');

    expect(effectiveStoryPart(tree, {}, 'deep')).toBe('main');
    expect(meta).toEqual({ pro: { storyPart: 'prologue' } });
  });

  it('terminates on a tree that loops back on itself', () => {
    const loop = [{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }];
    expect(effectiveStoryPart(loop, { a: { storyPart: 'epilogue' } }, 'b')).toBe('epilogue');
  });
});

describe('snapshotManuscript carries the effective part, never the declaration', () => {
  const state = (): ReturnType<typeof buildState> =>
    buildState({
      folders: [{ id: 'fPro', title: 'Before' }],
      scenes: [
        { id: 'in', title: 'Inherits', parent: 'fPro', body: 'A.' },
        { id: 'own', title: 'Own main', parent: 'fPro', body: 'B.' },
        { id: 'top', title: 'Top', body: 'C.' },
      ],
    });

  it('names the part of each scene and leaves its own record alone', () => {
    const file = withMeta({ fPro: { storyPart: 'prologue' }, own: { storyPart: 'main' } });
    const snapshot = snapshotManuscript(state(), file);
    const parts = Object.fromEntries(snapshot.scanned.map((scene) => [scene.docId, scene.part]));
    expect(parts).toEqual({ in: 'prologue', own: 'main', top: 'main' });
    expect(snapshot.scanned.find((scene) => scene.docId === 'in')?.meta).toEqual({});
    expect(file.sceneMeta['in']).toBeUndefined();
  });
});

describe('timeline.gap and story parts (§5.2.2)', () => {
  const GAP = ['timeline.gap'] as const;
  const pair = (): ReturnType<typeof buildState> =>
    buildState({
      scenes: [
        { id: 'a', title: 'First', body: 'A.' },
        { id: 'b', title: 'Second', body: 'B.' },
      ],
    });

  it('notes a main to epilogue pair 4,000 days apart with no part declared (negative control)', () => {
    const out = findings(pair(), withMeta({ a: { dayOffset: 0 }, b: { dayOffset: LONG_APART } }), GAP);
    expect(out.map((finding) => finding.message)).toEqual(['"Second" happens 4000 days after "First"']);
  });

  it.each([
    ['main to epilogue', undefined, 'epilogue'],
    ['prologue to main', 'prologue', undefined],
    ['prologue to epilogue', 'prologue', 'epilogue'],
  ] as const)('skips %s', (_name, first, second) => {
    const file = withMeta({
      a: { dayOffset: 0, ...(first === undefined ? {} : { storyPart: first }) },
      b: { dayOffset: LONG_APART, ...(second === undefined ? {} : { storyPart: second }) },
    });
    expect(findings(pair(), file, GAP)).toEqual([]);
  });

  it('still notes two epilogue scenes 30 days apart', () => {
    const file = withMeta({ a: { dayOffset: LONG_APART, storyPart: 'epilogue' }, b: { dayOffset: LONG_APART + 30, storyPart: 'epilogue' } });
    expect(findings(pair(), file, GAP)).toHaveLength(1);
  });

  it('treats an explicit main under a prologue folder as a different part from its prologue sibling', () => {
    const state = buildState({
      folders: [{ id: 'fPro', title: 'Before' }],
      scenes: [
        { id: 'a', title: 'First', parent: 'fPro', body: 'A.' },
        { id: 'b', title: 'Second', parent: 'fPro', body: 'B.' },
      ],
    });
    const same = withMeta({ fPro: { storyPart: 'prologue' }, a: { dayOffset: 0 }, b: { dayOffset: 30 } });
    expect(findings(state, same, GAP)).toHaveLength(1);
    const overridden = withMeta({ fPro: { storyPart: 'prologue' }, a: { dayOffset: 0 }, b: { dayOffset: 30, storyPart: 'main' } });
    expect(findings(state, overridden, GAP)).toEqual([]);
    const cleared = withMeta({ fPro: { storyPart: 'prologue' }, a: { dayOffset: 0 }, b: { dayOffset: 30 } });
    expect(findings(state, cleared, GAP)).toHaveLength(1);
  });

  it('keeps the threshold at seven days for a negative pair in one part', () => {
    const at = (gap: number) => findings(pair(), withMeta({ a: { dayOffset: -3650 }, b: { dayOffset: -3650 + gap } }), GAP);
    expect(at(GAP_THRESHOLD_DAYS - 1)).toEqual([]);
    expect(at(GAP_THRESHOLD_DAYS)).toHaveLength(1);
  });

  it('is the only check that reads a part: the other timeline checks fire the same across a part boundary', () => {
    const state = buildState({
      scenes: [
        { id: 'a', title: 'First', body: 'A.' },
        { id: 'b', title: 'Second', body: 'B.' },
      ],
    });
    const meta: Record<string, SceneMeta> = { a: { dayOffset: 5, durationDays: 3 }, b: { dayOffset: 6, after: ['a'] } };
    const others = TIMELINE_CHECKS.filter((id) => id !== 'timeline.gap');
    const plain = findings(state, withMeta(meta), others);
    expect(plain.length).toBeGreaterThan(0);
    const parted = findings(state, withMeta({ a: { ...meta['a'], storyPart: 'prologue' }, b: { ...meta['b'], storyPart: 'epilogue' } }), others);
    expect(parted).toEqual(plain);
  });
});

describe('a uniform shift of every day (§5.2.2)', () => {
  const state = (): ReturnType<typeof buildState> =>
    buildState({
      folders: [{ id: 'f', title: 'Week one' }],
      scenes: [
        { id: 'a', title: 'Alpha', parent: 'f', body: 'A.' },
        { id: 'b', title: 'Beta', parent: 'f', body: 'B.' },
        { id: 'c', title: 'Gamma', body: 'C.' },
        { id: 'd', title: 'Delta', body: 'D.' },
        { id: 'e', title: 'Epsilon', body: 'E.' },
      ],
    });
  const base: Record<string, SceneMeta> = {
    f: { dayOffset: 0, durationDays: 3 },
    a: { dayOffset: 1, durationDays: 2 },
    b: { dayOffset: 9, after: ['a'] },
    c: { dayOffset: 9, durationDays: 2 },
    d: { dayOffset: 8 },
    e: { dayOffset: 40, storyPart: 'epilogue' },
  };
  const shifted = (delta: number): CoherenceFile =>
    withMeta(Object.fromEntries(Object.entries(base).map(([id, meta]) => [id, meta.dayOffset === undefined ? meta : { ...meta, dayOffset: meta.dayOffset + delta }])));

  /** What a finding says about the story apart from the absolute day numbers it quotes. */
  const shape = (list: ReturnType<typeof findings>): string[] =>
    list
      .map((finding) => [
        finding.checkId,
        finding.type,
        finding.severity,
        finding.factGroup,
        finding.evidence.map((passage) => passage.docId).join(','),
        finding.message.replace(/ ?\(day -?\d+ against day -?\d+\)/, '').replace(/day(s?) -?\d+( to -?\d+)?/g, 'day$1 N'),
      ].join('|'))
      .sort();

  it.each([-3650, -20, -1, 100])('keeps the same findings when every day moves by %i', (delta) => {
    const original = findings(state(), shifted(0));
    expect(original.length).toBeGreaterThan(0);
    expect(shape(findings(state(), shifted(delta)))).toEqual(shape(original));
  });
});

describe('loading a story part from coherence.json (§5.2.2)', () => {
  const load = (sceneMeta: Record<string, unknown>) =>
    parseCoherenceFile(JSON.stringify({ formatVersion: 1, findings: [], runs: [], sceneMeta, worldRules: [], reviewState: {} }));

  it('keeps a declared part and a negative day, and says nothing', () => {
    const outcome = load({ sA: { dayOffset: -3650, storyPart: 'prologue' }, sB: { dayOffset: 10_000_000 }, sC: { dayOffset: -10_000_000, storyPart: 'main' } });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.file.sceneMeta['sA']).toEqual({ dayOffset: -3650, storyPart: 'prologue' });
    expect(outcome.file.sceneMeta['sC']).toEqual({ dayOffset: -10_000_000, storyPart: 'main' });
    expect(outcome.notices).toEqual([]);
  });

  it('drops a day past the limit or not whole, keeping the rest of the declaration', () => {
    for (const day of [10_000_001, -10_000_001, 1.5, '3']) {
      const outcome = load({ sA: { dayOffset: day, durationDays: 2 } });
      expect(outcome.kind === 'ok' && outcome.file.sceneMeta['sA'], String(day)).toEqual({ durationDays: 2 });
      expect(outcome.kind === 'ok' && outcome.notices.map((notice) => notice.code)).toEqual(['dropped-scene-meta']);
    }
  });

  it('reads an unknown part as inherit and says so once, however many scenes carry it', () => {
    const outcome = load({ sA: { storyPart: 'interlude', dayOffset: 2 }, sB: { storyPart: 'interlude' }, sC: { storyPart: 7 } });
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.file.sceneMeta['sA']).toEqual({ dayOffset: 2 });
    const notices = outcome.notices.filter((notice) => notice.code === 'unknown-story-part');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain('"interlude"');
    expect(notices[0]?.message).toContain('"7"');
  });

  it('loads a file written before parts existed unchanged', () => {
    const outcome = load({ sA: { dayOffset: 3, durationDays: 1, timelineMode: 'flashback' } });
    expect(outcome.kind === 'ok' && outcome.file.sceneMeta['sA']).toEqual({ dayOffset: 3, durationDays: 1, timelineMode: 'flashback' });
    expect(outcome.kind === 'ok' && outcome.notices).toEqual([]);
  });
});
