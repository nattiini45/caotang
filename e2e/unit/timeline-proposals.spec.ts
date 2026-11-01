import { expect, test } from '@playwright/test';

import { emptyCoherenceFile, type CoherenceFile, type Finding } from '../../packages/coherence/src/index.js';
import { addDocument, addFolder, createEmptyManifest, createProjectState, emptyCoherenceState, type ProjectState } from '../../packages/store/src/index.js';
import type { SceneMetaRecord } from '../../packages/bus/src/index.js';

import {
  altChordOf,
  dayAtX,
  dayFrames,
  daysDragged,
  mirroredX,
  parseDayText,
  planNarrativeMove,
  storyDrop,
  unmirroredLeft,
  xOfDay,
} from '../../apps/desktop/src/app/timeline-edit-model.js';
import {
  EMPTY_PROPOSALS,
  SHIFT_ABOVE,
  buildBatch,
  datedInsideMain,
  deriveSuggestions,
  proposeMeta,
  proposeMove,
  proposeShift,
  rebaseRow,
  removeRow,
  setShiftDelta,
  staleFields,
  syncSuggestions,
  type MetaRow,
  type ProposalSet,
  type ShiftRow,
} from '../../apps/desktop/src/app/timeline-proposals.js';
import { quickActions } from '../../apps/desktop/src/app/timeline-quick-actions.js';
import { baselineKeys, draftsOf, whatIf } from '../../apps/desktop/src/app/timeline-what-if.js';
import { buildTimeline } from '../../packages/timeline/src/index.js';

/**
 * The proposal model of the timeline (timeline.md §4): rows coalesce against the original base, a stale row is found by its base, the
 * selected rows become one batch from the original base, suggestions are one hop, and the what-if delta is found without a write.
 */

const NOW = new Date('2026-10-30T09:00:00.000Z');

interface Spec {
  readonly id: string;
  readonly parent?: string;
  readonly meta?: SceneMetaRecord;
}

function book(scenes: readonly Spec[], folders: readonly string[] = ['ch1', 'ch2']): ProjectState {
  const state = createProjectState(createEmptyManifest('Proposals', NOW, { locale: 'en-US' }), { now: NOW });
  state.coherence = emptyCoherenceState();
  for (const id of folders) addFolder(state, { id, parentId: 'manuscript', title: id, now: NOW });
  for (const scene of scenes) {
    addDocument(state, { id: scene.id, parentId: scene.parent ?? 'ch1', title: scene.id, body: `${scene.id} is here.`, now: NOW });
    if (scene.meta !== undefined) (state.coherence as { sceneMeta: Record<string, SceneMetaRecord> }).sceneMeta[scene.id] = scene.meta;
  }
  return state;
}

const fileOf = (state: ProjectState): CoherenceFile => ({ ...emptyCoherenceFile(), sceneMeta: (state.coherence?.sceneMeta ?? {}) as CoherenceFile['sceneMeta'] });

const meta = (set: ProposalSet, nodeId: string): MetaRow | undefined => set.rows.find((row): row is MetaRow => row.kind === 'meta' && row.nodeId === nodeId);

const SELECT_ALL = (set: ProposalSet): Set<string> => new Set(set.rows.map((row) => row.id));

const BASIC = (): ProjectState =>
  book([
    { id: 'a', meta: { dayOffset: 12 } },
    { id: 'b', meta: { dayOffset: 20, durationDays: 2 } },
    { id: 'c' },
    { id: 'd', parent: 'ch2', meta: { dayOffset: 40 } },
  ]);

test.describe('adding to the tray', () => {
  test('a second change to a scene joins its row: the base is kept and the latest target wins', () => {
    const state = BASIC();
    let set = proposeMeta(EMPTY_PROPOSALS, state, 'a', { day: 13 });
    set = proposeMeta(set, state, 'a', { day: 14 });
    set = proposeMeta(set, state, 'a', { day: 16 });
    expect(set.rows).toHaveLength(1);
    expect(meta(set, 'a')?.day).toEqual({ base: 12, to: 16 });
  });

  test('a field that returns to its base value drops out, and a row left with nothing drops out with it', () => {
    const state = BASIC();
    let set = proposeMeta(EMPTY_PROPOSALS, state, 'a', { day: 14, part: 'epilogue' });
    set = proposeMeta(set, state, 'a', { day: 12 });
    expect(meta(set, 'a')?.day).toBeUndefined();
    expect(meta(set, 'a')?.part).toEqual({ base: null, to: 'epilogue' });
    set = proposeMeta(set, state, 'a', { part: null });
    expect(set.rows).toHaveLength(0);
  });

  test('mode reads linear when absent, so proposing linear for a scene with no mode is not a change', () => {
    const state = BASIC();
    expect(proposeMeta(EMPTY_PROPOSALS, state, 'a', { mode: 'linear' }).rows).toHaveLength(0);
    expect(meta(proposeMeta(EMPTY_PROPOSALS, state, 'a', { mode: 'flashback' }), 'a')?.mode).toEqual({ base: 'linear', to: 'flashback' });
  });

  test('a day given to a scene that had none has a null base', () => {
    const state = BASIC();
    expect(meta(proposeMeta(EMPTY_PROPOSALS, state, 'c', { day: 3 }), 'c')?.day).toEqual({ base: null, to: 3 });
  });

  test('after changes coalesce as additions and removals against the list the row read', () => {
    const state = book([{ id: 'a', meta: { after: ['b'] } }, { id: 'b' }, { id: 'c' }]);
    let set = proposeMeta(EMPTY_PROPOSALS, state, 'a', { afterAdd: ['c'] });
    expect(meta(set, 'a')?.after).toEqual({ base: ['b'], add: ['c'], remove: [] });
    set = proposeMeta(set, state, 'a', { afterRemove: ['c'] });
    expect(set.rows).toHaveLength(0);
    set = proposeMeta(set, state, 'a', { afterRemove: ['b'] });
    expect(meta(set, 'a')?.after).toEqual({ base: ['b'], add: [], remove: ['b'] });
  });

  test('a move keeps the place the scene had in the project, and a move back to it drops out', () => {
    const state = BASIC();
    let set = proposeMove(EMPTY_PROPOSALS, state, 'a', { parentId: 'ch1', anchorId: 'c' });
    set = proposeMove(set, state, 'a', { parentId: 'ch2', anchorId: null });
    expect(set.rows).toHaveLength(1);
    const row = set.rows[0];
    expect(row).toMatchObject({ kind: 'move', base: { parentId: 'ch1', predecessorId: null }, to: { parentId: 'ch2', anchorId: null } });
    set = proposeMove(set, state, 'a', { parentId: 'ch1', anchorId: null });
    expect(set.rows).toHaveLength(0);
  });

  test('a shift on the same scenes adds to its delta, a zero total drops it, and scenes with no day are left out', () => {
    const state = BASIC();
    let set = proposeShift(EMPTY_PROPOSALS, state, 7, ['a', 'b', 'c']);
    expect(set.rows).toHaveLength(1);
    const row = set.rows[0] as ShiftRow;
    expect(row.nodeIds).toEqual(['a', 'b']);
    expect(row.baseDays).toEqual({ a: 12, b: 20 });
    set = proposeShift(set, state, 7, ['b', 'a']);
    expect((set.rows[0] as ShiftRow).delta).toBe(14);
    set = proposeShift(set, state, -14, ['a', 'b']);
    expect(set.rows).toHaveLength(0);
    expect(proposeShift(EMPTY_PROPOSALS, state, 3, ['c']).rows).toHaveLength(0);
    set = proposeShift(EMPTY_PROPOSALS, state, 2, ['a']);
    expect(setShiftDelta(set, set.rows[0]?.id as string, 0).rows).toHaveLength(0);
    expect((setShiftDelta(set, set.rows[0]?.id as string, 5).rows[0] as ShiftRow).delta).toBe(5);
  });

  test('removing a row removes only it', () => {
    const state = BASIC();
    let set = proposeMeta(EMPTY_PROPOSALS, state, 'a', { day: 13 });
    set = proposeMeta(set, state, 'b', { day: 21 });
    expect(removeRow(set, set.rows[0]?.id as string).rows.map((row) => (row as MetaRow).nodeId)).toEqual(['b']);
  });
});

test.describe('stale rows', () => {
  test('a row is stale when a field it read has changed, and only the changed field is named', () => {
    const state = BASIC();
    const set = proposeMeta(EMPTY_PROPOSALS, state, 'a', { day: 14, duration: 3 });
    expect(staleFields(state, set.rows[0]!)).toEqual([]);
    (state.coherence as { sceneMeta: Record<string, SceneMetaRecord> }).sceneMeta['a'] = { dayOffset: 13 };
    expect(staleFields(state, set.rows[0]!)).toEqual(['day']);
  });

  test('a move is stale when the scene is somewhere else, and a shift when a day under it changed', () => {
    const state = BASIC();
    const move = proposeMove(EMPTY_PROPOSALS, state, 'a', { parentId: 'ch2', anchorId: null });
    const shift = proposeShift(EMPTY_PROPOSALS, state, 3, ['a', 'b']);
    expect(staleFields(state, move.rows[0]!)).toEqual([]);
    expect(staleFields(state, shift.rows[0]!)).toEqual([]);
    (state.coherence as { sceneMeta: Record<string, SceneMetaRecord> }).sceneMeta['b'] = { dayOffset: 21, durationDays: 2 };
    expect(staleFields(state, shift.rows[0]!)).toBe('days');
    const other = BASIC();
    const node = other.manifest.tree.find((entry) => entry.id === 'a')!;
    node.parentId = 'ch2';
    expect(staleFields(other, move.rows[0]!)).toBe('place');
  });

  test('re-basing reads the project again, keeps the target, and drops a field the project already holds', () => {
    const state = BASIC();
    let set = proposeMeta(EMPTY_PROPOSALS, state, 'a', { day: 14, duration: 3 });
    (state.coherence as { sceneMeta: Record<string, SceneMetaRecord> }).sceneMeta['a'] = { dayOffset: 13, durationDays: 3 };
    const id = set.rows[0]?.id as string;
    set = rebaseRow(set, state, id);
    expect(meta(set, 'a')?.day).toEqual({ base: 13, to: 14 });
    expect(meta(set, 'a')?.duration).toBeUndefined();
    expect(staleFields(state, set.rows[0]!)).toEqual([]);
    (state.coherence as { sceneMeta: Record<string, SceneMetaRecord> }).sceneMeta['a'] = { dayOffset: 14, durationDays: 3 };
    expect(rebaseRow(set, state, id).rows).toHaveLength(0);
  });
});

test.describe('the batch from the selected rows', () => {
  test('selected rows become one batch in tray order, with the counts the Apply button names', () => {
    const state = BASIC();
    let set = proposeMeta(EMPTY_PROPOSALS, state, 'a', { day: 13, part: 'prologue' });
    set = proposeMeta(set, state, 'b', { duration: 4 });
    set = proposeMove(set, state, 'c', { parentId: 'ch2', anchorId: null });
    const built = buildBatch(state, set.rows, SELECT_ALL(set));
    expect(built.ops.map((op) => op.op)).toEqual(['meta', 'meta', 'move']);
    expect(built.projection?.counts).toMatchObject({ days: 1, parts: 1, durations: 1, moves: 1, total: 4 });
    expect([...built.status.values()].map((status) => status.state)).toEqual(['ok', 'ok', 'ok']);
  });

  test('a row is validated against the selected rows before it, never an unselected one', () => {
    const state = BASIC();
    let set = proposeMove(EMPTY_PROPOSALS, state, 'a', { parentId: 'ch2', anchorId: null });
    set = proposeMove(set, state, 'd', { parentId: 'ch2', anchorId: 'a' });
    const [first, second] = set.rows;
    const both = buildBatch(state, set.rows, SELECT_ALL(set));
    expect(both.accepted).toEqual([first!.id, second!.id]);
    const onlySecond = buildBatch(state, set.rows, new Set([second!.id]));
    expect(onlySecond.accepted).toEqual([]);
    expect(onlySecond.status.get(second!.id)?.state).toBe('invalid');
    expect(onlySecond.status.get(second!.id)?.message).toMatch(/not there any more/);
    expect(onlySecond.status.get(first!.id)?.state).toBe('skipped');
  });

  test('a stale row is not built and the rows around it still are', () => {
    const state = BASIC();
    let set = proposeMeta(EMPTY_PROPOSALS, state, 'a', { day: 14 });
    set = proposeMeta(set, state, 'b', { day: 22 });
    (state.coherence as { sceneMeta: Record<string, SceneMetaRecord> }).sceneMeta['a'] = { dayOffset: 99 };
    const built = buildBatch(state, set.rows, SELECT_ALL(set));
    expect(built.status.get(set.rows[0]!.id)?.state).toBe('stale');
    expect(built.accepted).toEqual([set.rows[1]!.id]);
    expect(built.ops).toHaveLength(1);
  });

  test('a row the bus refuses is marked with its reason and does not stop the others', () => {
    const state = BASIC();
    let set = proposeMeta(EMPTY_PROPOSALS, state, 'a', { day: 10_000_001 });
    set = proposeMeta(set, state, 'b', { day: 21 });
    const built = buildBatch(state, set.rows, SELECT_ALL(set));
    expect(built.status.get(set.rows[0]!.id)?.state).toBe('invalid');
    expect(built.accepted).toEqual([set.rows[1]!.id]);
  });

  test('a shift above the nudge limit is one op', () => {
    const scenes: Spec[] = Array.from({ length: SHIFT_ABOVE + 5 }, (_, at) => ({ id: `s${at}`, meta: { dayOffset: at } }));
    const state = book(scenes);
    const set = proposeShift(EMPTY_PROPOSALS, state, 14, scenes.map((scene) => scene.id));
    const built = buildBatch(state, set.rows, SELECT_ALL(set));
    expect(built.ops).toHaveLength(1);
    expect(built.projection?.shifts[0]).toMatchObject({ delta: 14, count: SHIFT_ABOVE + 5 });
  });

  test('nothing selected builds nothing', () => {
    const state = BASIC();
    const set = proposeMeta(EMPTY_PROPOSALS, state, 'a', { day: 14 });
    const built = buildBatch(state, set.rows, new Set());
    expect(built.ops).toEqual([]);
    expect(built.projection).toBeUndefined();
  });

  test('building does not touch the project', () => {
    const state = BASIC();
    const before = JSON.stringify([state.manifest.tree, state.coherence]);
    const set = proposeMeta(proposeMove(EMPTY_PROPOSALS, state, 'a', { parentId: 'ch2', anchorId: null }), state, 'b', { day: 30 });
    buildBatch(state, set.rows, SELECT_ALL(set));
    expect(JSON.stringify([state.manifest.tree, state.coherence])).toBe(before);
  });
});

test.describe('dependant suggestions', () => {
  const linked = (): ProjectState =>
    book([
      { id: 'b', meta: { dayOffset: 5, durationDays: 1 } },
      { id: 'a', meta: { dayOffset: 6, after: ['b'] } },
      { id: 'z', meta: { dayOffset: 7, after: ['a'] } },
    ]);

  test('moving B later suggests the scenes that follow it, one hop and never a cascade', () => {
    const state = linked();
    const set = proposeMeta(EMPTY_PROPOSALS, state, 'b', { day: 10 });
    const suggestions = deriveSuggestions(state, set.rows);
    expect(suggestions).toEqual([{ nodeId: 'a', because: ['b'], day: 11, base: 6 }]);
  });

  test('suggested rows start unchecked in the set, are brought in line with the rows, and are removed when the move is', () => {
    const state = linked();
    let set = syncSuggestions(proposeMeta(EMPTY_PROPOSALS, state, 'b', { day: 10 }), state, true);
    expect(set.rows.map((row) => row.origin)).toEqual(['gesture', 'suggestion']);
    set = syncSuggestions(proposeMeta(set, state, 'b', { day: 12 }), state, true);
    expect((meta(set, 'a')?.day)).toEqual({ base: 6, to: 13 });
    set = syncSuggestions(proposeMeta(set, state, 'b', { day: 5 }), state, true);
    expect(set.rows).toHaveLength(0);
    expect(syncSuggestions(proposeMeta(EMPTY_PROPOSALS, state, 'b', { day: 10 }), state, false).rows).toHaveLength(1);
  });

  test('a scene already broken before the move is not suggested, and a shift suggests nothing inside its own set', () => {
    const state = book([
      { id: 'b', meta: { dayOffset: 5, durationDays: 1 } },
      { id: 'a', meta: { dayOffset: 4, after: ['b'] } },
      { id: 'q', meta: { dayOffset: 20 } },
      { id: 'r', meta: { dayOffset: 21, after: ['q'] } },
    ]);
    expect(deriveSuggestions(state, proposeMeta(EMPTY_PROPOSALS, state, 'b', { day: 10 }).rows)).toEqual([]);
    const shift = proposeShift(EMPTY_PROPOSALS, state, 5, ['q', 'r']);
    expect(deriveSuggestions(state, shift.rows)).toEqual([]);
  });
});

test.describe('the what-if delta', () => {
  const relation = (): { state: ProjectState; file: CoherenceFile } => {
    const state = book([
      { id: 'b', meta: { dayOffset: 5, durationDays: 2 } },
      { id: 'a', meta: { dayOffset: 6, after: ['b'] } },
    ]);
    return { state, file: fileOf(state) };
  };

  const asFinding = (state: ProjectState, file: CoherenceFile): Finding => {
    const draft = draftsOf(state, file).find((entry) => entry.checkId === 'timeline.relation');
    if (draft === undefined) throw new Error('the project should have a relation problem');
    return {
      id: 'f_AAAAAAAAAA',
      runId: 'r_AAAAAAAAAA',
      class: 'deterministic',
      checkId: draft.checkId,
      type: draft.type,
      severity: draft.severity,
      status: 'open',
      factGroup: draft.factGroup,
      evidence: [],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      message: draft.message,
    } as Finding;
  };

  test('a day that fixes an open relation finding resolves it, and nothing is written', () => {
    const { state, file } = relation();
    const open = asFinding(state, file);
    const withFinding: CoherenceFile = { ...file, findings: [open] };
    const set = proposeMeta(EMPTY_PROPOSALS, state, 'a', { day: 7 });
    const built = buildBatch(state, set.rows, SELECT_ALL(set));
    const before = JSON.stringify(withFinding);
    const delta = whatIf(state, withFinding, built.projection!, baselineKeys(state, withFinding));
    expect(delta.resolved.map((finding) => finding.checkId)).toEqual(['timeline.relation']);
    expect(delta.added).toEqual([]);
    expect(JSON.stringify(withFinding)).toBe(before);
    expect(state.coherence?.sceneMeta['a']).toEqual({ dayOffset: 6, after: ['b'] });
  });

  test('a day that breaks a link raises a new finding; a finding the proposal leaves alone is neither resolved nor new', () => {
    const state = book([
      { id: 'b', meta: { dayOffset: 5, durationDays: 2 } },
      { id: 'a', meta: { dayOffset: 9, after: ['b'] } },
    ]);
    const file = fileOf(state);
    const set = proposeMeta(EMPTY_PROPOSALS, state, 'b', { day: 12 });
    const built = buildBatch(state, set.rows, SELECT_ALL(set));
    const delta = whatIf(state, file, built.projection!, baselineKeys(state, file));
    expect(delta.added.map((finding) => finding.checkId)).toContain('timeline.relation');
    expect(delta.resolved).toEqual([]);
  });

  test('a finding the last scan left open but the project no longer produces is not called resolved by a proposal', () => {
    const { state, file } = relation();
    const stale = asFinding(state, file);
    const fixed = book([
      { id: 'b', meta: { dayOffset: 5, durationDays: 2 } },
      { id: 'a', meta: { dayOffset: 8, after: ['b'] } },
    ]);
    const withStale: CoherenceFile = { ...fileOf(fixed), findings: [stale] };
    const set = proposeMeta(EMPTY_PROPOSALS, fixed, 'a', { day: 9 });
    const built = buildBatch(fixed, set.rows, SELECT_ALL(set));
    expect(whatIf(fixed, withStale, built.projection!, baselineKeys(fixed, withStale)).resolved).toEqual([]);
  });

  test('2,000 scenes: the run is measured and stays far under a second', () => {
    const scenes: Spec[] = Array.from({ length: 2000 }, (_, at) => ({ id: `s${at}`, parent: at < 1000 ? 'ch1' : 'ch2', meta: { dayOffset: at * 2, durationDays: 1, ...(at > 0 ? { after: [`s${at - 1}`] } : {}) } }));
    const state = book(scenes);
    const file = fileOf(state);
    const set = proposeMeta(EMPTY_PROPOSALS, state, 's10', { day: 500 });
    const built = buildBatch(state, set.rows, SELECT_ALL(set));
    const keys = baselineKeys(state, file);
    whatIf(state, file, built.projection!, keys);
    const started = performance.now();
    const runs = 5;
    for (let at = 0; at < runs; at += 1) whatIf(state, file, built.projection!, keys);
    const each = (performance.now() - started) / runs;
    test.info().annotations.push({ type: 'what-if at 2,000 scenes (ms)', description: each.toFixed(1) });
    console.log(`what-if at 2,000 scenes: ${each.toFixed(1)} ms per run`);
    expect(each).toBeLessThan(1000);
  });
});

test.describe('quick actions', () => {
  test('a relation finding offers the day the later scene must reach, and a gap offers a time skip', () => {
    const state = book([
      { id: 'b', meta: { dayOffset: 5, durationDays: 2 } },
      { id: 'a', meta: { dayOffset: 6, after: ['b'] } },
    ]);
    const draft = draftsOf(state, fileOf(state)).find((entry) => entry.checkId === 'timeline.relation')!;
    const open = { id: 'f_AAAAAAAAAA', runId: 'r_1', class: 'deterministic', checkId: draft.checkId, type: draft.type, severity: draft.severity, status: 'open', factGroup: draft.factGroup, evidence: draft.evidence, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), message: draft.message } as Finding;
    const file: CoherenceFile = { ...fileOf(state), findings: [open] };
    const model = buildTimeline(state, file, { axis: 'story', findings: 'open' });
    const item = model.items.find((entry) => entry.nodeId === 'a')!;
    const actions = quickActions(state, model, item);
    expect(actions.map((action) => [action.kind, action.nodeId, action.intent?.day])).toEqual([['relation-day', 'a', 7]]);
  });
});

test.describe('gestures', () => {
  test('a drop keeps the grab point: a small drag moves the bar by the pixels dragged, in either direction of the book', () => {
    const state = BASIC();
    const model = buildTimeline(state, fileOf(state), { axis: 'story', compressGaps: false });
    const frames = dayFrames(model);
    const ppd = model.axis.pxPerDay;
    const base = xOfDay(frames, 'main', 12, ppd) as number;
    expect(dayAtX(frames, base, ppd, 'main')).toBe(12);
    expect(dayAtX(frames, base + 2 * ppd, ppd, 'main')).toBe(14);
    expect(daysDragged(2 * ppd, ppd, 'ltr')).toBe(2);
    expect(daysDragged(2 * ppd, ppd, 'rtl')).toBe(-2);
    expect(mirroredX(unmirroredLeft({ x: 100, w: 30 }, 1000, 'rtl'), 30, 1000, 'rtl')).toBe(100);
    const zones = [{ part: 'main' as const, box: { x: 0, y: 0, w: 4000, h: 100 } }];
    const drop = storyDrop({
      frames,
      ppd,
      width: 4000,
      direction: 'ltr',
      zones,
      folds: [],
      lanes: [{ id: 'all', box: { x: 0, y: 0, w: 4000, h: 30 } }],
      origin: { x: base, w: ppd },
      dx: 3 * ppd,
      pointer: { x: base + 3 * ppd + 4, y: 10 },
      part: 'main',
    });
    expect(drop).toMatchObject({ day: 15, part: 'main', region: 'zone' });
  });

  test('Alt+arrows follow the interface direction, Shift makes it a week, and AltGraph is never a chord', () => {
    const facts = (key: string, extra: Partial<Parameters<typeof altChordOf>[0]> = {}): Parameters<typeof altChordOf>[0] => ({ key, code: key, shift: false, ctrl: false, meta: false, altGraph: false, ...extra });
    expect(altChordOf(facts('ArrowRight'), 'story', false)).toEqual({ kind: 'day', delta: 1 });
    expect(altChordOf(facts('ArrowLeft', { shift: true }), 'story', false)).toEqual({ kind: 'day', delta: -7 });
    expect(altChordOf(facts('ArrowRight'), 'story', true)).toEqual({ kind: 'day', delta: -1 });
    expect(altChordOf(facts('ArrowRight'), 'narrative', false)).toEqual({ kind: 'narrative', step: 'down' });
    expect(altChordOf(facts('ArrowUp'), 'story', false)).toEqual({ kind: 'lane', step: -1 });
    expect(altChordOf(facts(']', { code: 'BracketRight' }), 'story', false)).toEqual({ kind: 'duration', delta: 1 });
    expect(altChordOf(facts('r', { code: 'KeyR' }), 'story', false)).toEqual({ kind: 'place' });
    expect(altChordOf(facts('ArrowRight', { altGraph: true }), 'story', false)).toBeNull();
  });

  test('a narrative move is planned like a binder move and composes with the rows before it', () => {
    const state = book([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    const first = planNarrativeMove(state, [], 'a', { drop: { nodeId: 'c', zone: 'after' } });
    expect(first).toEqual({ parentId: 'ch1', anchorId: 'c' });
    const set = proposeMove(EMPTY_PROPOSALS, state, 'a', first as { parentId: string; anchorId: string | null });
    expect(planNarrativeMove(state, set.rows, 'a', { step: 'up' })).toEqual({ parentId: 'ch1', anchorId: 'b' });
    expect(planNarrativeMove(state, [], 'a', { drop: { nodeId: 'b', zone: 'before' } })).toBe('same-place');
  });

  test('day text accepts the real minus sign and thousands separators, and refuses what is not a whole number', () => {
    expect(parseDayText('\u221214')).toBe(-14);
    expect(parseDayText('1,200')).toBe(1200);
    expect(parseDayText('  +7 ')).toBe(7);
    expect(parseDayText('1.5')).toBeNull();
    expect(parseDayText('')).toBeNull();
    expect(parseDayText('day 3')).toBeNull();
  });

  test('a prologue dated inside the main story, or an epilogue before its end, is noted', () => {
    expect(datedInsideMain('prologue', 5, { start: 0, end: 30 })).toBe(true);
    expect(datedInsideMain('prologue', -5, { start: 0, end: 30 })).toBe(false);
    expect(datedInsideMain('epilogue', 10, { start: 0, end: 30 })).toBe(true);
    expect(datedInsideMain('epilogue', 40, { start: 0, end: 30 })).toBe(false);
    expect(datedInsideMain('main', 10, { start: 0, end: 30 })).toBe(false);
  });
});
