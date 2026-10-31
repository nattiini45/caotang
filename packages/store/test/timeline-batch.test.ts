/**
 * `timeline.apply` through the shipped bus ([timeline.md §4.3](docs/architecture/timeline.md)): a batch of scene declarations, moves and shifts is one
 * command, one activity row and one undo group; a rejected batch changes nothing; and one undo writes back exactly what the batch changed.
 */

import { describe, expect, it } from 'vitest';
import {
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  shiftFingerprint,
  type ActivityLog,
  type BusContext,
  type Command,
  type CommandName,
  type ExecutionOutcome,
  type SceneMetaRecord,
  type UndoStore,
} from '@caotang/bus';
import {
  addDocument,
  addNode,
  createEmptyManifest,
  createProjectCommandRegistry,
  createProjectState,
  emptyCoherenceState,
  getBody,
  getRevision,
  nodeById,
  setBody,
  type ProjectState,
} from '../src/index.js';

const NOW = new Date('2026-10-30T09:00:00.000Z');
const clock = { now: () => 1_000 };

const CH1 = 'n_CHAPTER001';
const CH2 = 'n_CHAPTER002';
const [S1, S2, S3, S4] = ['n_SCENE00001', 'n_SCENE00002', 'n_SCENE00003', 'n_SCENE00004'];

/** Two chapters: S1, S2, S3 in the first (orders 10, 20, 30) and S4 in the second. */
function project(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Lighthouse Keeper', NOW, { uuid: () => '3f2a9c1e-8b4d-4a5e-9c7f-2d1e0a9b8c7d', locale: 'en-US' }));
  state.coherence = emptyCoherenceState();
  addNode(state, { parentId: 'manuscript', title: 'Chapter 1', now: NOW, id: CH1 });
  addNode(state, { parentId: 'manuscript', title: 'Chapter 2', now: NOW, id: CH2 });
  addDocument(state, { parentId: CH1, title: 'The Ferry', body: 'The ferry was late.', now: NOW, id: S1 });
  addDocument(state, { parentId: CH1, title: 'The Storm', body: 'It broke at noon.', now: NOW, id: S2 });
  addDocument(state, { parentId: CH1, title: 'The Letter', body: 'She opened it.', now: NOW, id: S3 });
  addDocument(state, { parentId: CH2, title: 'The Coda', body: 'Years later.', now: NOW, id: S4 });
  return state;
}

interface Bus {
  readonly state: ProjectState;
  readonly undo: UndoStore;
  readonly log: ActivityLog;
  readonly bus: BusContext<ProjectState>;
  readonly registry: ReturnType<typeof createProjectCommandRegistry>;
}

function bus(state: ProjectState = project()): Bus {
  const registry = createProjectCommandRegistry({ clock });
  const log = createActivityLog();
  const undo: UndoStore = createUndoStore({ dispatch: (command) => execute(command, handle.bus, registry) });
  const handle: { bus: BusContext<ProjectState> } = {
    bus: { state, view: createViewState(), read: () => state, undo, log, idempotency: createIdempotencyCache(), notify: () => undefined },
  };
  return { state, undo, log, bus: handle.bus, registry };
}

let ordinal = 0;
function command(name: CommandName, params: Record<string, unknown>): Command {
  ordinal += 1;
  return { id: `cmd_TIMELINE${String(ordinal).padStart(4, '0')}`, name, params, issuedBy: 'user', createdAt: 1_000 };
}

const apply = (b: Bus, ops: unknown[], label?: string) =>
  execute(command('timeline.apply', { ops, ...(label === undefined ? {} : { label }) }), b.bus, b.registry);

const meta = (nodeId: string, patch: object, expect: object) => ({ op: 'meta', nodeId, patch, expect });
const move = (nodeId: string, newParentId: string, index: number, expectParent: string, expectIndex: number) => ({
  op: 'move',
  nodeId,
  newParentId,
  index,
  expect: { parentId: expectParent, index: expectIndex },
});

function okValue(result: ReturnType<typeof execute>): ExecutionOutcome {
  if (!result.ok) throw new Error(`refused: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function undoLast(b: Bus): void {
  const last = b.undo.groups().at(-1);
  if (last === undefined) throw new Error('nothing to undo');
  const result = b.undo.undo(last.id);
  if (!result.ok) throw new Error(`undo refused: ${result.error.message}`);
}

/** Everything a batch may change, and the documents it may not. */
function snapshotOf(state: ProjectState) {
  return {
    places: state.manifest.tree.map((node) => [node.id, node.parentId, node.order]),
    sceneMeta: structuredClone(state.coherence?.sceneMeta),
    bodies: [...state.documents.values()].map((doc) => [doc.id, doc.body, doc.revision]),
  };
}

function childrenOf(state: ProjectState, parentId: string): string[] {
  return state.manifest.tree
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => a.order - b.order)
    .map((node) => node.id);
}

const sceneMetaOf = (state: ProjectState, id: string): SceneMetaRecord | undefined => state.coherence?.sceneMeta[id];

describe('timeline.apply: one batch, one report, one undo group', () => {
  it('applies declarations (a negative day, a duration, a part) and several moves as one command', () => {
    const b = bus();
    b.state.coherence!.sceneMeta[S2] = { dayOffset: 4 };
    const outcome = okValue(
      apply(
        b,
        [
          meta(S1, { dayOffset: -3, durationDays: 2, storyPart: 'prologue' }, { dayOffset: null, durationDays: null, storyPart: null }),
          meta(S2, { dayOffset: null, durationDays: 6 }, { dayOffset: 4, durationDays: null }),
          move(S3, CH1, 0, CH1, 2),
          move(S1, CH2, 1, CH1, 1),
        ],
        'Reorder the storm',
      ),
    );

    expect(sceneMetaOf(b.state, S1)).toEqual({ dayOffset: -3, durationDays: 2, storyPart: 'prologue' });
    expect(sceneMetaOf(b.state, S2)).toEqual({ durationDays: 6 });
    expect(childrenOf(b.state, CH1)).toEqual([S3, S2]);
    expect(childrenOf(b.state, CH2)).toEqual([S4, S1]);
    expect(nodeById(b.state, S1)?.parentId).toBe(CH2);

    const result = outcome.result as { changes: number; moved: string[]; declarations: string[] };
    expect(result.moved).toEqual(expect.arrayContaining([S3, S1]));
    expect(result.declarations).toEqual([S1, S2]);
    expect(b.undo.groups()).toHaveLength(1);
    expect(b.log.entries()).toHaveLength(1);
    expect(b.log.entries()[0]?.summary).toContain('Reorder the storm');
  });

  it('lets a later op see what an earlier op left, including repeated edits of one scene', () => {
    const b = bus();
    okValue(
      apply(b, [
        meta(S1, { dayOffset: 5 }, { dayOffset: null }),
        meta(S1, { dayOffset: 9, durationDays: 1 }, { dayOffset: 5, durationDays: null }),
        move(S2, CH1, 0, CH1, 1),
        move(S2, CH1, 2, CH1, 0),
      ]),
    );
    expect(sceneMetaOf(b.state, S1)).toEqual({ dayOffset: 9, durationDays: 1 });
    expect(childrenOf(b.state, CH1)).toEqual([S1, S3, S2]);
  });

  it('keeps the order of an after list: added ids go last, removed ids leave the rest where they were', () => {
    const b = bus();
    b.state.coherence!.sceneMeta[S3] = { after: [S2, S1] };
    okValue(apply(b, [meta(S3, { after_add: [S4], after_remove: [S2] }, { after: [S2, S1] })]));
    expect(sceneMetaOf(b.state, S3)?.after).toEqual([S1, S4]);
  });

  it('renormalises a crowded sibling set exactly as the same moves made one at a time would', () => {
    const crowded = (): Bus => {
      const b = bus();
      for (const [id, order] of [[S1, 10], [S2, 11], [S3, 12]] as const) nodeById(b.state, id)!.order = order;
      return b;
    };
    const batch = crowded();
    okValue(apply(batch, [move(S3, CH1, 1, CH1, 2)]));
    const single = crowded();
    const one = execute(command('binder.move', { nodeId: S3, newParentId: CH1, index: 1 }), single.bus, single.registry);
    expect(one.ok).toBe(true);

    expect(childrenOf(batch.state, CH1)).toEqual([S1, S3, S2]);
    expect(snapshotOf(batch.state).places).toEqual(snapshotOf(single.state).places);
  });

  it('shifts 5,000 dated scenes across day zero as one op and restores them in one undo', () => {
    const b = bus();
    const ids: string[] = [];
    for (let i = 0; i < 5000; i += 1) {
      const id = `n_SHIFT${String(i).padStart(5, '0')}`;
      addDocument(b.state, { parentId: CH2, title: `Scene ${i}`, now: NOW, id });
      b.state.coherence!.sceneMeta[id] = { dayOffset: i - 2500 };
      ids.push(id);
    }
    const before = snapshotOf(b.state);
    const fingerprint = shiftFingerprint(ids.map((nodeId, i) => ({ nodeId, dayOffset: i - 2500 })));

    okValue(apply(b, [{ op: 'shift', delta: -3000, nodeIds: ids, expect: { fingerprint } }]));
    expect(sceneMetaOf(b.state, ids[0]!)?.dayOffset).toBe(-5500);
    expect(sceneMetaOf(b.state, ids[4999]!)?.dayOffset).toBe(2499 - 3000);
    expect(b.undo.groups()).toHaveLength(1);

    undoLast(b);
    expect(snapshotOf(b.state)).toEqual(before);
  });
});

describe('timeline.apply: a rejected batch changes nothing', () => {
  it('refuses the whole batch when the last op is malformed, writing no declaration, no order and no undo group', () => {
    const b = bus();
    const before = snapshotOf(b.state);
    const result = apply(b, [meta(S1, { dayOffset: 3 }, { dayOffset: null }), move(S3, CH1, 0, CH1, 2), { op: 'nudge', nodeId: S2 }]);
    expect(result.ok).toBe(false);
    expect(snapshotOf(b.state)).toEqual(before);
    expect(b.undo.groups()).toHaveLength(0);
    expect(b.log.entries()).toHaveLength(0);
  });

  it('refuses a stale field guard by naming the scene and both values, and writes nothing from the ops before it', () => {
    const b = bus();
    b.state.coherence!.sceneMeta[S2] = { dayOffset: 7 };
    const before = snapshotOf(b.state);
    const result = apply(b, [meta(S1, { dayOffset: 1 }, { dayOffset: null }), meta(S2, { dayOffset: 8 }, { dayOffset: 6 })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('revision-conflict');
    expect(result.error.message).toContain('The Storm');
    expect(result.error.message).toContain('was 6 and is now 7');
    expect(snapshotOf(b.state)).toEqual(before);
    expect(b.undo.groups()).toHaveLength(0);
  });

  it('refuses a shift whose fingerprint no longer matches', () => {
    const b = bus();
    b.state.coherence!.sceneMeta[S1] = { dayOffset: 1 };
    b.state.coherence!.sceneMeta[S2] = { dayOffset: 2 };
    const stale = shiftFingerprint([{ nodeId: S1, dayOffset: 1 }, { nodeId: S2, dayOffset: 3 }]);
    const before = snapshotOf(b.state);
    const result = apply(b, [{ op: 'shift', delta: 5, nodeIds: [S1, S2], expect: { fingerprint: stale } }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('revision-conflict');
    expect(snapshotOf(b.state)).toEqual(before);
  });

  it('refuses a shift that would leave the allowed range', () => {
    const b = bus();
    b.state.coherence!.sceneMeta[S1] = { dayOffset: 9_999_999 };
    const fingerprint = shiftFingerprint([{ nodeId: S1, dayOffset: 9_999_999 }]);
    expect(apply(b, [{ op: 'shift', delta: 2, nodeIds: [S1], expect: { fingerprint } }]).ok).toBe(false);
    expect(sceneMetaOf(b.state, S1)).toEqual({ dayOffset: 9_999_999 });
  });

  it('pins a picture to a day, and one undo puts the pin back without touching the rest of the placement', () => {
    const b = bus();
    b.state.manifest.assetLinks = [
      { id: 'l_AAAAAAAAAA', assetId: 'a_7K2QX9M4A1', target: { kind: 'node', nodeId: S1 }, role: 'reference', order: 10, note: 'kept' },
    ];
    expect(apply(b, [{ op: 'picture-when', linkId: 'l_AAAAAAAAAA', when: { dayOffset: -3 }, expect: { when: null } }]).ok).toBe(true);
    expect(b.state.manifest.assetLinks?.[0]?.when).toEqual({ dayOffset: -3 });

    // A later command changes the note; the undo of the pin must put the pin back and leave that note alone.
    b.state.manifest.assetLinks![0]!.note = 'edited after the pin';
    const last = b.undo.groups().at(-1)!;
    b.undo.undo(last.id);
    const restored = b.state.manifest.assetLinks?.[0];
    expect(restored).toMatchObject({ note: 'edited after the pin' });
    expect(restored?.when).toBeUndefined();

    // A pin the project does not hold is refused with nothing changed, and the batch leaves no undo group.
    const groups = b.undo.groups().length;
    expect(apply(b, [{ op: 'picture-when', linkId: 'l_BBBBBBBBBB', when: { dayOffset: 1 }, expect: { when: null } }]).ok).toBe(false);
    expect(b.undo.groups()).toHaveLength(groups);
  });

  it('refuses declarations when no coherence file is open', () => {
    const state = project();
    delete state.coherence;
    const b = bus(state);
    expect(apply(b, [meta(S1, { dayOffset: 1 }, { dayOffset: null })]).ok).toBe(false);
    expect(b.undo.groups()).toHaveLength(0);
  });
});

describe('timeline.apply: undo', () => {
  it('captures one before-image: one group holding one compensable entry, however many ops ran', () => {
    const b = bus();
    okValue(apply(b, [meta(S1, { dayOffset: 1 }, { dayOffset: null }), meta(S2, { dayOffset: 2 }, { dayOffset: null }), move(S3, CH1, 0, CH1, 2)]));
    const groups = b.undo.groups();
    expect(groups).toHaveLength(1);
    expect(groups[0]?.entries).toHaveLength(1);
    expect(groups[0]?.entries[0]?.kind).toBe('compensable');
  });

  it('restores declarations, parents and sibling orders exactly, including a renormalised set and an after list', () => {
    const b = bus();
    for (const [id, order] of [[S1, 10], [S2, 11], [S3, 12]] as const) nodeById(b.state, id)!.order = order;
    b.state.coherence!.sceneMeta[S3] = { after: [S2, S1], dayOffset: 3, threads: [{ id: 't_x', payoff: 'the key' }] };
    const before = snapshotOf(b.state);

    okValue(
      apply(b, [
        meta(S3, { after_remove: [S2], after_add: [S4], dayOffset: null }, { after: [S2, S1], dayOffset: 3 }),
        meta(S4, { storyPart: 'epilogue' }, { storyPart: null }),
        move(S3, CH1, 1, CH1, 2),
        move(S1, CH2, 0, CH1, 0),
      ]),
    );
    expect(snapshotOf(b.state)).not.toEqual(before);
    expect(sceneMetaOf(b.state, S3)?.threads).toEqual([{ id: 't_x', payoff: 'the key' }]);

    undoLast(b);
    expect(snapshotOf(b.state)).toEqual(before);
    expect(sceneMetaOf(b.state, S4)).toBeUndefined();
  });

  it('keeps unrelated changes made after the batch, and never lowers a body revision', () => {
    const b = bus();
    okValue(apply(b, [meta(S1, { dayOffset: 1 }, { dayOffset: null }), move(S3, CH1, 0, CH1, 2)]));

    setBody(b.state, S2, 'It broke at dusk.');
    const revisionAfterEdit = getRevision(b.state, S2);
    b.state.coherence!.sceneMeta[S4] = { dayOffset: 40 };
    nodeById(b.state, S4)!.title = 'The Long Coda';

    undoLast(b);

    expect(sceneMetaOf(b.state, S1)).toBeUndefined();
    expect(childrenOf(b.state, CH1)).toEqual([S1, S2, S3]);
    expect(getBody(b.state, S2)).toBe('It broke at dusk.');
    expect(getRevision(b.state, S2)).toBe(revisionAfterEdit);
    expect(sceneMetaOf(b.state, S4)).toEqual({ dayOffset: 40 });
    expect(nodeById(b.state, S4)?.title).toBe('The Long Coda');
  });

  it('skips a node deleted after the batch rather than failing the undo', () => {
    const b = bus();
    okValue(apply(b, [meta(S1, { dayOffset: 1 }, { dayOffset: null }), meta(S2, { dayOffset: 2 }, { dayOffset: null })]));
    b.state.manifest.tree = b.state.manifest.tree.filter((node) => node.id !== S1);
    undoLast(b);
    expect(sceneMetaOf(b.state, S2)).toBeUndefined();
  });

  it('leaves body revisions untouched by the apply itself', () => {
    const b = bus();
    const revisions = [S1, S2, S3, S4].map((id) => getRevision(b.state, id));
    okValue(apply(b, [meta(S1, { dayOffset: 1 }, { dayOffset: null }), move(S2, CH2, 0, CH1, 1)]));
    expect([S1, S2, S3, S4].map((id) => getRevision(b.state, id))).toEqual(revisions);
  });
});
