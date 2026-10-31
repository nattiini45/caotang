/**
 * The timeline batch's pure half ([timeline.md §4.3](docs/architecture/timeline.md)): the shape check, the sequential projection, the stale guards, the
 * shift fingerprint, and the sibling-order algorithm the store's `siblingOrderAt` delegates to. The store's apply and its undo are
 * `packages/store/test/timeline-batch.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  COMMAND_REGISTRY,
  RENORMALIZE_THRESHOLD,
  TIMELINE_OPS_MAX,
  TIMELINE_SHIFT_NODES_MAX,
  parseTimelineOps,
  projectTimelineBatch,
  projectedSceneMeta,
  shiftFingerprint,
  siblingOrderInTree,
  timelineBatchSummary,
} from '../src/index.js';
import type { SceneMetaRecord, TimelineOp, ValidationNode, ValidationSnapshot } from '../src/index.js';

function node(id: string, parentId: string | null, type: string, order: number, title = id): ValidationNode {
  return { id, parentId, type, order, title, status: null, label: null, keywords: [], synopsis: '', notes: '' };
}

const CH1 = 'n_CH1';
const CH2 = 'n_CH2';
const [A, B, C, D] = ['n_A', 'n_B', 'n_C', 'n_D'];

function snapshot(sceneMeta: Record<string, SceneMetaRecord> = {}, tree?: ValidationNode[]): ValidationSnapshot {
  return {
    manifest: {
      tree: tree ?? [
        node('root', null, 'root', 10, 'Book'),
        node('manuscript', 'root', 'folder', 10, 'Manuscript'),
        node('research', 'root', 'folder', 20, 'Research'),
        node(CH1, 'manuscript', 'folder', 10, 'Chapter 1'),
        node(CH2, 'manuscript', 'folder', 20, 'Chapter 2'),
        node(A, CH1, 'document', 10, 'Ferry'),
        node(B, CH1, 'document', 20, 'Storm'),
        node(C, CH1, 'document', 30, 'Letter'),
        node(D, CH2, 'document', 10, 'Coda'),
      ],
      vocabulary: { statuses: [], labels: [] },
      codex: [{ id: 'c_ANNA', name: 'Anna', type: 'character' }],
    },
    documents: new Map(),
    coherence: { findings: [], sceneMeta },
  };
}

const meta = (nodeId: string, patch: object, expect: object): TimelineOp => ({ op: 'meta', nodeId, patch, expect }) as TimelineOp;
const move = (nodeId: string, newParentId: string, index: number, expectParent: string, expectIndex: number): TimelineOp => ({
  op: 'move',
  nodeId,
  newParentId,
  index,
  expect: { parentId: expectParent, index: expectIndex },
});

function project(snap: ValidationSnapshot, ops: readonly TimelineOp[]) {
  const parsed = parseTimelineOps(ops);
  if (!parsed.ok) throw new Error(`shape refused: ${parsed.error.message}`);
  return projectTimelineBatch(snap, parsed.value);
}

function orders(tree: readonly { id: string; parentId: string | null; order: number }[], parent: string): [string, number][] {
  return tree.filter((n) => n.parentId === parent).sort((a, b) => a.order - b.order).map((n) => [n.id, n.order]);
}

describe('timeline.apply: the shape check', () => {
  it('takes 1 to 200 ops and refuses none or too many', () => {
    expect(parseTimelineOps([]).ok).toBe(false);
    expect(parseTimelineOps('x').ok).toBe(false);
    const op = meta(A, { dayOffset: 1 }, { dayOffset: null });
    expect(parseTimelineOps(Array.from({ length: TIMELINE_OPS_MAX }, () => op)).ok).toBe(true);
    const over = parseTimelineOps(Array.from({ length: TIMELINE_OPS_MAX + 1 }, () => op));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe('limit-exceeded');
  });

  it('closes the keys of an op, its patch and its expect', () => {
    for (const bad of [
      { ...meta(A, { dayOffset: 1 }, { dayOffset: null }), extra: 1 },
      meta(A, { dayOffset: 1, expectedPresent_add: ['c_ANNA'] }, { dayOffset: null }),
      meta(A, { dayOffset: 1 }, { dayOffset: null, threads: [] }),
      { op: 'shift', delta: 1, nodeIds: [A], expect: { fingerprint: 'x', more: 1 } },
      { op: 'nudge' },
    ]) {
      expect(parseTimelineOps([bad]).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses a patch whose expect lacks a field it changes, and an empty patch', () => {
    const missing = parseTimelineOps([meta(A, { dayOffset: 2, durationDays: 1 }, { dayOffset: null })]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toContain('expect.durationDays is missing');
    const list = parseTimelineOps([meta(A, { after_add: [B] }, {})]);
    expect(list.ok).toBe(false);
    if (!list.ok) expect(list.error.correctiveHint).toContain('complete array');
    expect(parseTimelineOps([meta(A, {}, {})]).ok).toBe(false);
    expect(parseTimelineOps([meta(A, { after_remove: [B] }, { after: [B, C] })]).ok).toBe(true);
    expect(parseTimelineOps([meta(A, { storyPart: null }, { storyPart: 'prologue' })]).ok).toBe(true);
  });

  it('checks a move and a shift: whole index, nonzero delta, 1 to 5000 unique ids', () => {
    expect(parseTimelineOps([move(A, CH2, -1, CH1, 0)]).ok).toBe(false);
    expect(parseTimelineOps([move(A, CH2, 1.5, CH1, 0)]).ok).toBe(false);
    const shift = (delta: number, nodeIds: string[]): TimelineOp => ({ op: 'shift', delta, nodeIds, expect: { fingerprint: 'tl1-0-0' } });
    expect(parseTimelineOps([shift(0, [A])]).ok).toBe(false);
    expect(parseTimelineOps([shift(1.5, [A])]).ok).toBe(false);
    expect(parseTimelineOps([shift(1, [])]).ok).toBe(false);
    expect(parseTimelineOps([shift(1, [A, A])]).ok).toBe(false);
    const ids = Array.from({ length: TIMELINE_SHIFT_NODES_MAX }, (_, i) => `n_${i}`);
    expect(parseTimelineOps([shift(1, ids)]).ok).toBe(true);
    const tooMany = parseTimelineOps([shift(1, [...ids, 'n_extra'])]);
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error.code).toBe('limit-exceeded');
  });

  it('moves a picture’s day pin on its placement, guarded by the pin the plan read', () => {
    // A pin belongs to the placement, not the scene (timeline.md §9.1), so no scene declaration is read or written for it.
    const initial = snapshot();
    const base = {
      ...initial,
      manifest: {
        ...initial.manifest,
        assetLinks: [{ id: 'l_1', assetId: 'a_7K2QX9M4A1', target: { kind: 'node' as const, nodeId: A }, role: 'reference' as const, order: 10, when: { dayOffset: 2 } }],
      },
    };
    const op: TimelineOp = { op: 'picture-when', linkId: 'l_1', when: { dayOffset: -4, label: 'the funeral' }, expect: { when: { dayOffset: 2 } } };
    expect(parseTimelineOps([op]).ok).toBe(true);
    const moved = project(base, [op]);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value.linkChanges).toEqual([{ linkId: 'l_1', before: { dayOffset: 2 }, after: { dayOffset: -4, label: 'the funeral' } }]);
    expect(moved.value.counts).toMatchObject({ total: 1, pins: 1 });

    // The pin the plan read is not the pin on the project: nothing is proposed.
    const stale: TimelineOp = { ...op, expect: { when: { dayOffset: 3 } } };
    const conflict = project(base, [stale]);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe('revision-conflict');
      expect(conflict.error.message).toContain('day 3');
    }

    // A pin the value already holds changes nothing, so the batch does not count it.
    const same = project(base, [{ ...op, when: { dayOffset: 2 }, expect: { when: { dayOffset: 2 } } }]);
    expect(same.ok && same.value.counts.pins).toBe(0);

    // Clearing it is a change of its own, and an unknown placement is not-found rather than a silent no-op.
    const cleared = project(base, [{ op: 'picture-when', linkId: 'l_1', when: null, expect: { when: { dayOffset: 2 } } }]);
    expect(cleared.ok && cleared.value.linkChanges[0]?.after).toBe(null);
    const missing = project(base, [{ op: 'picture-when', linkId: 'l_9', when: null, expect: { when: null } }]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('not-found');
    expect(parseTimelineOps([{ ...op, when: { dayOffset: 1.5 } }]).ok).toBe(false);
  });
});

describe('timeline.apply: the projection of scene declarations', () => {
  it('applies a signed day, a duration, a part, a mode and a POV, and counts them', () => {
    const result = project(snapshot(), [
      meta(A, { dayOffset: -3650, durationDays: 2, storyPart: 'prologue', timelineMode: 'backstory', pov: 'c_ANNA' }, { dayOffset: null, durationDays: null, storyPart: null, timelineMode: null, pov: null }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sceneMeta.get(A)).toEqual({ dayOffset: -3650, durationDays: 2, storyPart: 'prologue', timelineMode: 'backstory', pov: 'c_ANNA' });
    expect(result.value.counts).toMatchObject({ total: 5, days: 1, durations: 1, parts: 1, modes: 1, povs: 1 });
  });

  it('clears a part with null and keeps an explicit main as a declaration', () => {
    const base = snapshot({ [A]: { storyPart: 'prologue', dayOffset: 4 }, [B]: { storyPart: 'prologue' } });
    const result = project(base, [meta(A, { storyPart: null }, { storyPart: 'prologue' }), meta(B, { storyPart: 'main' }, { storyPart: 'prologue' })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sceneMeta.get(A)).toEqual({ dayOffset: 4 });
    expect(result.value.sceneMeta.get(B)).toEqual({ storyPart: 'main' });
  });

  it('validates op N against ops 1 to N-1: repeated edits of one scene chain their expects', () => {
    const chained = project(snapshot({ [A]: { dayOffset: 12 } }), [
      meta(A, { dayOffset: 14 }, { dayOffset: 12 }),
      meta(A, { dayOffset: 20, durationDays: 3 }, { dayOffset: 14, durationDays: null }),
      meta(A, { dayOffset: null }, { dayOffset: 20 }),
    ]);
    expect(chained.ok).toBe(true);
    if (!chained.ok) return;
    expect(chained.value.sceneMeta.get(A)).toEqual({ durationDays: 3 });
    expect(chained.value.metaChanges).toHaveLength(1);
    expect(chained.value.metaChanges[0]).toMatchObject({ nodeId: A, before: { dayOffset: 12 }, after: { durationDays: 3 } });

    const stale = project(snapshot({ [A]: { dayOffset: 12 } }), [meta(A, { dayOffset: 14 }, { dayOffset: 12 }), meta(A, { dayOffset: 16 }, { dayOffset: 12 })]);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.target).toBe('ops[1].expect.dayOffset');
  });

  it('refuses a stale field naming the scene, the field and both values', () => {
    const result = project(snapshot({ [A]: { dayOffset: 13 } }), [meta(A, { dayOffset: 14 }, { dayOffset: 12 })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('revision-conflict');
    expect(result.error.message).toBe('ops[0]: ‘Ferry’ changed since this was proposed: its day was 12 and is now 13');
    expect(result.error.details).toMatchObject({ opIndex: 0, nodeId: A, field: 'dayOffset', expected: 12, actual: 13 });
  });

  it('reads null as absent, in both directions', () => {
    expect(project(snapshot({ [A]: { dayOffset: 0 } }), [meta(A, { dayOffset: 1 }, { dayOffset: null })]).ok).toBe(false);
    expect(project(snapshot(), [meta(A, { dayOffset: 1 }, { dayOffset: 0 })]).ok).toBe(false);
    expect(project(snapshot(), [meta(A, { dayOffset: 1 }, { dayOffset: null })]).ok).toBe(true);
    // `linear` is stored as absence, so an expect of either spelling matches an absent mode.
    expect(project(snapshot(), [meta(A, { timelineMode: 'flashback' }, { timelineMode: 'linear' })]).ok).toBe(true);
    expect(project(snapshot({ [A]: { timelineMode: 'flashback' } }), [meta(A, { timelineMode: 'linear' }, { timelineMode: null })]).ok).toBe(false);
  });

  it('keeps after in order, and guards the complete before-array', () => {
    const base = snapshot({ [C]: { after: [B, A] } });
    const result = project(base, [meta(C, { after_add: [D], after_remove: [B] }, { after: [B, A] })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sceneMeta.get(C)?.after).toEqual([A, D]);

    const reordered = project(base, [meta(C, { after_add: [D] }, { after: [A, B] })]);
    expect(reordered.ok).toBe(false);
    if (!reordered.ok) expect(reordered.error.message).toContain('order links');
    const subset = project(base, [meta(C, { after_add: [D] }, { after: [B] })]);
    expect(subset.ok).toBe(false);
    expect(project(snapshot(), [meta(C, { after_add: [A] }, { after: [A] })]).ok).toBe(false);
    expect(project(snapshot(), [meta(C, { after_add: [A] }, { after: null })]).ok).toBe(true);
  });

  it('refuses what the scene patch refuses: a scene after itself, an unknown POV, an out-of-range day', () => {
    expect(project(snapshot(), [meta(A, { after_add: [A] }, { after: null })]).ok).toBe(false);
    expect(project(snapshot(), [meta(A, { pov: 'c_NOBODY' }, { pov: null })]).ok).toBe(false);
    expect(project(snapshot(), [meta(A, { dayOffset: 10_000_001 }, { dayOffset: null })]).ok).toBe(false);
    expect(project(snapshot(), [meta(A, { dayOffset: -10_000_000 }, { dayOffset: null })]).ok).toBe(true);
    expect(project(snapshot(), [meta(A, { durationDays: -1 }, { durationDays: null })]).ok).toBe(false);
    expect(project(snapshot(), [meta('n_GONE', { dayOffset: 1 }, { dayOffset: null })]).ok).toBe(false);
  });

  it('refuses scene edits when no coherence file is open', () => {
    const without = { ...snapshot() } as { coherence?: unknown };
    delete without.coherence;
    const result = project(without as ValidationSnapshot, [meta(A, { dayOffset: 1 }, { dayOffset: null })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });

  it('never mutates the snapshot it reads', () => {
    const base = snapshot({ [A]: { dayOffset: 1, after: [B] } });
    const frozen = JSON.stringify([base.manifest.tree, base.coherence]);
    const result = project(base, [meta(A, { dayOffset: 2, after_add: [C] }, { dayOffset: 1, after: [B] }), move(B, CH2, 0, CH1, 1)]);
    expect(result.ok).toBe(true);
    expect(JSON.stringify([base.manifest.tree, base.coherence])).toBe(frozen);
    if (result.ok) expect(projectedSceneMeta(base.coherence!.sceneMeta, result.value)[A]).toEqual({ dayOffset: 2, after: [B, C] });
  });
});

describe('timeline.apply: shift', () => {
  const dated = { [A]: { dayOffset: -2 }, [B]: { dayOffset: 0 }, [C]: { dayOffset: 5, durationDays: 1 } };
  const fingerprintOf = (...ids: string[]): string => shiftFingerprint(ids.map((id) => ({ nodeId: id, dayOffset: (dated as Record<string, { dayOffset: number }>)[id]!.dayOffset })));
  const shift = (delta: number, ids: string[], fingerprint = fingerprintOf(...ids)): TimelineOp => ({ op: 'shift', delta, nodeIds: ids, expect: { fingerprint } });

  it('moves a dated set across zero as one op and keeps the rest of each record', () => {
    const result = project(snapshot(dated), [shift(3, [A, B, C])]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sceneMeta.get(A)).toEqual({ dayOffset: 1 });
    expect(result.value.sceneMeta.get(B)).toEqual({ dayOffset: 3 });
    expect(result.value.sceneMeta.get(C)).toEqual({ dayOffset: 8, durationDays: 1 });
    expect(result.value.counts).toMatchObject({ shifts: 1, shiftedScenes: 3, total: 1 });
    expect(timelineBatchSummary(result.value, (id) => id)).toBe('Timeline: shifted 3 scenes by +3 days');
  });

  it('computes the fingerprint from the sorted pairs, whatever order they arrive in', () => {
    const pairs = [{ nodeId: 'n_b', dayOffset: 2 }, { nodeId: 'n_a', dayOffset: -1 }];
    expect(shiftFingerprint(pairs)).toBe(shiftFingerprint([...pairs].reverse()));
    expect(shiftFingerprint(pairs)).not.toBe(shiftFingerprint([{ nodeId: 'n_b', dayOffset: 2 }, { nodeId: 'n_a', dayOffset: 0 }]));
    expect(shiftFingerprint(pairs)).not.toBe(shiftFingerprint([{ nodeId: 'n_b', dayOffset: 2 }]));
    expect(shiftFingerprint(pairs)).not.toBe(shiftFingerprint([{ nodeId: 'n_a', dayOffset: 2 }, { nodeId: 'n_b', dayOffset: -1 }]));
  });

  it('refuses a drifted fingerprint as a conflict, an undated or unknown node, and a result out of range', () => {
    const drifted = project(snapshot({ ...dated, [B]: { dayOffset: 1 } }), [shift(1, [A, B, C], fingerprintOf(A, B, C))]);
    expect(drifted.ok).toBe(false);
    if (!drifted.ok) {
      expect(drifted.error.code).toBe('revision-conflict');
      expect(drifted.error.message).toContain('the days of the 3 scenes in this shift changed');
    }
    const undated = project(snapshot(dated), [shift(1, [A, D], fingerprintOf(A))]);
    expect(undated.ok).toBe(false);
    if (!undated.ok) expect(undated.error.message).toContain('‘Coda’ has no day');
    expect(project(snapshot(dated), [shift(1, ['n_GONE'], 'x')]).ok).toBe(false);
    const edge = { [A]: { dayOffset: 10_000_000 } };
    expect(project(snapshot(edge), [shift(1, [A], shiftFingerprint([{ nodeId: A, dayOffset: 10_000_000 }]))]).ok).toBe(false);
    expect(project(snapshot(edge), [shift(-1, [A], shiftFingerprint([{ nodeId: A, dayOffset: 10_000_000 }]))]).ok).toBe(true);
  });

  it('reads the days an earlier op of the batch left', () => {
    const result = project(snapshot(dated), [meta(A, { dayOffset: 100 }, { dayOffset: -2 }), shift(1, [A], shiftFingerprint([{ nodeId: A, dayOffset: 100 }]))]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.sceneMeta.get(A)).toEqual({ dayOffset: 101 });
    expect(project(snapshot(dated), [meta(A, { dayOffset: 100 }, { dayOffset: -2 }), shift(1, [A])]).ok).toBe(false);
  });

  it('shifts 5,000 dated scenes across day 0 in one op', () => {
    const count = TIMELINE_SHIFT_NODES_MAX;
    const ids = Array.from({ length: count }, (_, i) => `n_S${String(i).padStart(4, '0')}`);
    const tree = [
      node('root', null, 'root', 10),
      node('manuscript', 'root', 'folder', 10),
      node(CH1, 'manuscript', 'folder', 10),
      ...ids.map((id, i) => node(id, CH1, 'document', (i + 1) * 10)),
    ];
    const sceneMeta = Object.fromEntries(ids.map((id, i) => [id, { dayOffset: i - 2500 }]));
    const fingerprint = shiftFingerprint(ids.map((id, i) => ({ nodeId: id, dayOffset: i - 2500 })));
    const result = project(snapshot(sceneMeta, tree), [{ op: 'shift', delta: 2500, nodeIds: ids, expect: { fingerprint } }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.metaChanges).toHaveLength(count);
    expect(result.value.sceneMeta.get(ids[0]!)).toEqual({ dayOffset: 0 });
    expect(result.value.sceneMeta.get(ids[count - 1]!)).toEqual({ dayOffset: count - 1 });
    expect(result.value.counts.shiftedScenes).toBe(count);
  });
});

describe('timeline.apply: moves against the projected tree', () => {
  it('places a node by index among the new parent’s children without it, clamping a long index', () => {
    const result = project(snapshot(), [move(C, CH1, 0, CH1, 2), move(A, CH2, 99, CH1, 1)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(orders(result.value.tree, CH1).map(([id]) => id)).toEqual([C, B]);
    expect(orders(result.value.tree, CH2).map(([id]) => id)).toEqual([D, A]);
    expect(result.value.counts.moves).toBe(2);
  });

  it('validates a later op against the parents and indices an earlier one left', () => {
    // Moving Letter to the front makes Ferry's position 1, so the second op's expect must say 1.
    const ok = project(snapshot(), [move(C, CH1, 0, CH1, 2), move(A, CH1, 2, CH1, 1)]);
    expect(ok.ok).toBe(true);
    const stale = project(snapshot(), [move(C, CH1, 0, CH1, 2), move(A, CH1, 2, CH1, 0)]);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe('revision-conflict');
      expect(stale.error.message).toContain('‘Ferry’ moved since this was proposed');
      expect(stale.error.details?.['opIndex']).toBe(1);
    }
    // A node moved into another chapter is no longer a child of the first one.
    const crossed = project(snapshot(), [move(A, CH2, 0, CH1, 0), move(B, CH2, 1, CH1, 0)]);
    expect(crossed.ok).toBe(true);
    expect(project(snapshot(), [move(A, CH2, 0, CH1, 0), move(A, CH1, 0, CH1, 0)]).ok).toBe(false);
  });

  it('renormalises a crowded sibling set exactly as the store does, and the next op sees it', () => {
    const crowded = [
      node('root', null, 'root', 10),
      node('manuscript', 'root', 'folder', 10),
      node(CH1, 'manuscript', 'folder', 10),
      node(CH2, 'manuscript', 'folder', 20),
      node(A, CH1, 'document', 10),
      node(B, CH1, 'document', 11),
      node(C, CH1, 'document', 12),
      node(D, CH2, 'document', 10),
    ];
    // Between B (11) and C (12) there is no integer, so the set is compacted to 10, 20, 30 before the midpoint is taken.
    const result = project(snapshot({}, crowded), [move(D, CH1, 2, CH2, 0)]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(orders(result.value.tree, CH1)).toEqual([[A, 10], [B, 20], [D, 25], [C, 30]]);
    // Ferry kept order 10, so only the moved node and the siblings the renormalisation rewrote are changes.
    expect(result.value.nodeChanges.map((c) => c.nodeId).sort()).toEqual([B, C, D].sort());
    expect(result.value.nodeChanges.find((c) => c.nodeId === B)).toMatchObject({ before: { parentId: CH1, order: 11 }, after: { parentId: CH1, order: 20 } });

    // The second op reads the renormalised set: Storm is at index 1 with order 20, not 11.
    const chained = project(snapshot({}, crowded), [move(D, CH1, 2, CH2, 0), move(B, CH2, 0, CH1, 1)]);
    expect(chained.ok).toBe(true);
    if (chained.ok) expect(orders(chained.value.tree, CH1)).toEqual([[A, 10], [D, 25], [C, 30]]);
  });

  it('renormalises past the threshold when appending', () => {
    const tall = [
      node('root', null, 'root', 10),
      node('manuscript', 'root', 'folder', 10),
      node(CH1, 'manuscript', 'folder', 10),
      node(A, CH1, 'document', 10),
      node(B, CH1, 'document', RENORMALIZE_THRESHOLD),
      node(C, 'manuscript', 'document', 30),
    ];
    const result = project(snapshot({}, tall), [move(C, CH1, 9, 'manuscript', 1)]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(orders(result.value.tree, CH1)).toEqual([[A, 10], [B, 20], [C, 30]]);
  });

  it('refuses what binder.move refuses: fixed roots, the project root, a document as parent, a cycle, a shot outside a board', () => {
    expect(project(snapshot(), [move('manuscript', CH1, 0, 'root', 0)]).ok).toBe(false);
    expect(project(snapshot(), [move(A, 'root', 0, CH1, 0)]).ok).toBe(false);
    expect(project(snapshot(), [move(A, B, 0, CH1, 0)]).ok).toBe(false);
    expect(project(snapshot(), [move(A, 'n_GONE', 0, CH1, 0)]).ok).toBe(false);
    const cycle = project(snapshot(), [move(CH1, CH1, 0, 'manuscript', 0)]);
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.error.code).toBe('cycle');
    const board = [
      node('root', null, 'root', 10),
      node('manuscript', 'root', 'folder', 10),
      { ...node('n_BOARD', 'manuscript', 'folder', 10), kind: 'storyboard' },
      node('n_SHOT', 'n_BOARD', 'shot', 10),
      node(A, 'manuscript', 'document', 20),
    ];
    expect(project(snapshot({}, board), [move('n_SHOT', 'manuscript', 0, 'n_BOARD', 0)]).ok).toBe(false);
    expect(project(snapshot({}, board), [move(A, 'n_BOARD', 0, 'manuscript', 1)]).ok).toBe(false);
  });

  it('reports a moved node whose expect names another place as a conflict', () => {
    const result = project(snapshot(), [move(A, CH2, 0, CH2, 0)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('it was at position 0 under ‘Chapter 2’ and is now at position 0 under ‘Chapter 1’');
  });

  it('reads a snapshot that carries no orders in tree order', () => {
    const unordered = (id: string, parentId: string | null, type: string): ValidationNode => {
      const copy = node(id, parentId, type, 0);
      Reflect.deleteProperty(copy, 'order');
      return copy;
    };
    const bare = snapshot({}, [
      unordered('root', null, 'root'),
      unordered('manuscript', 'root', 'folder'),
      unordered(CH1, 'manuscript', 'folder'),
      unordered(A, CH1, 'document'),
      unordered(B, CH1, 'document'),
    ]);
    const result = project(bare, [move(B, CH1, 0, CH1, 1)]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(orders(result.value.tree, CH1).map(([id]) => id)).toEqual([B, A]);
  });
});

describe('timeline.apply: a mixed batch and its words', () => {
  it('projects scene declarations and moves together and names the counts', () => {
    const result = project(snapshot({ [A]: { dayOffset: 12 } }), [
      meta(A, { dayOffset: 14 }, { dayOffset: 12 }),
      meta(B, { dayOffset: -5, storyPart: 'prologue' }, { dayOffset: null, storyPart: null }),
      meta(C, { durationDays: 2 }, { durationDays: null }),
      move(C, CH2, 0, CH1, 2),
      meta(D, { dayOffset: 400, storyPart: 'epilogue' }, { dayOffset: null, storyPart: null }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.counts).toMatchObject({ total: 7, days: 3, durations: 1, parts: 2, moves: 1 });
    expect(timelineBatchSummary(result.value, (id) => id)).toBe('Timeline: 7 changes (3 days, 1 duration, 2 parts, 1 move)');
    expect(result.value.touchedIds).toEqual([A, B, C, D]);
  });

  it('words one part change and a labelled batch', () => {
    const one = project(snapshot(), [meta(D, { storyPart: 'epilogue' }, { storyPart: null })]);
    expect(one.ok && timelineBatchSummary(one.value, () => 'Coda')).toBe('Timeline: ‘Coda’ is now the epilogue');
    expect(one.ok && timelineBatchSummary(one.value, () => 'Coda', 'Make Coda the epilogue')).toBe('Timeline: Make Coda the epilogue');
  });
});

describe('timeline.apply: the descriptor', () => {
  const descriptor = COMMAND_REGISTRY['timeline.apply'].descriptor;

  it('is write-confirm and compensable, and validates through the same projection', () => {
    expect(descriptor.agentRisk).toBe('write-confirm');
    expect(descriptor.undo).toBe('compensable');
    expect(descriptor.mutates).toBe('project');
    const ops = [meta(A, { dayOffset: 3 }, { dayOffset: null })];
    const accepted = descriptor.validate({ ops, label: 'Day 3' }, snapshot());
    expect(accepted.ok).toBe(true);
    const stale = descriptor.validate({ ops }, snapshot({ [A]: { dayOffset: 9 } }));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('revision-conflict');
  });

  it('refuses an unknown param and a label that is not text or too long', () => {
    const ops = [meta(A, { dayOffset: 3 }, { dayOffset: null })];
    expect(descriptor.validate({ ops, extra: 1 }, snapshot()).ok).toBe(false);
    expect(descriptor.validate({ ops, label: 4 }, snapshot()).ok).toBe(false);
    expect(descriptor.validate({ ops, label: 'x'.repeat(201) }, snapshot()).ok).toBe(false);
    expect(descriptor.validate({}, snapshot()).ok).toBe(false);
  });
});

describe('the sibling-order algorithm', () => {
  const set = (...orderList: number[]) => orderList.map((order, i) => ({ id: `s${i}`, parentId: 'p', order }));

  it('answers 10 for an empty set, max + 10 at the end, and the midpoint between', () => {
    expect(siblingOrderInTree([], 'p', 0)).toBe(10);
    expect(siblingOrderInTree(set(10, 20), 'p', 2)).toBe(30);
    expect(siblingOrderInTree(set(10, 20), 'p', 0)).toBe(5);
    expect(siblingOrderInTree(set(10, 30), 'p', 1)).toBe(20);
  });

  it('leaves the moving node out of the set it moves into', () => {
    expect(siblingOrderInTree(set(10, 20, 30), 'p', 2, 's1')).toBe(40);
  });
});
