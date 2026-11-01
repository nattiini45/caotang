/**
 * The agent's timeline tools (timeline.md §5.1, T7): `timeline.read` answers from the model the view and the MCP resources use, scoped and cut
 * at whole scenes under its cap; `timeline.edit` is `timeline.apply` through `primitiveTool`, so it asks before it writes, shows a diff card with
 * the findings the batch would resolve and raise, refuses a batch whose before-values went stale, and one Undo takes back the whole batch. The modes
 * are checked against the real session: Plan-only refuses, Ask and Accept edits ask, Auto approves.
 */

import {
  COMMAND_REGISTRY,
  DECLARED_PARAMS,
  TIMELINE_META_PATCH_KEYS,
  createActivityLog,
  createIdempotencyCache,
  createUndoStore,
  createViewState,
  execute,
  type BusContext,
  type Command,
  type UndoStore,
} from '@caotang/bus';
import { addDocument, addFolder, emptyCoherenceState, type ProjectState } from '@caotang/store';
import { describe, expect, it } from 'vitest';

import {
  ACCEPT_EDITS_TOOLS,
  PERMISSION_MODES,
  TOOL_METADATA,
  TOOL_NAMES,
  TIMELINE_CARD_FINDINGS_MAX,
  TIMELINE_CARD_ROWS_MAX,
  capOf,
  createAgentPorts,
  createAgentSession,
  createContextPort,
  createHarness,
  modePolicy,
  timelineModelFor,
  timelineReadDataOf,
  type PendingCard,
  type PermissionMode,
} from '../src/index.js';
import { estimateTokens } from '../src/tokens.js';
import { PRIMITIVE_TOOLS } from '../src/tools/primitive-tools.js';
import { mockGateway } from './agent/gateway.js';
import { answer, steps, transcript } from './agent/scripts.js';
import { CHAPTER_ONE, CHAPTER_TWO, FRIEND, LANDING, OPENED, STORM, canonical, makeHarness, makeState, refusalOf, run, snapshotOf, valueOf } from './fixtures.js';

const confirmed = { permission: { confirmed: true } } as const;

/** The fixture project with a coherence file: the Landing on day 0 for a day, the Storm on day 5, and the Friend undated. */
function timelineState(): ProjectState {
  const state = makeState();
  // Pinned: the default language is the machine's, and a day label groups its digits by it.
  state.manifest.project.language = 'en';
  state.coherence = emptyCoherenceState();
  state.coherence.sceneMeta[LANDING] = { dayOffset: 0, durationDays: 1 };
  state.coherence.sceneMeta[STORM] = { dayOffset: 5 };
  return state;
}

/** The manifest, the bodies and the scene declarations: everything a timeline batch may change. */
function everything(state: ProjectState): string {
  return `${snapshotOf(state)}|${canonical(state.coherence?.sceneMeta)}`;
}

function sceneMeta(state: ProjectState, id: string) {
  return state.coherence?.sceneMeta[id];
}

function placeOf(state: ProjectState, id: string): { parentId: string | null; order: number } {
  const node = state.manifest.tree.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`no node ${id}`);
  return { parentId: node.parentId, order: node.order };
}

describe('timeline.read', () => {
  it('words a day label in the project language, as the exports do', () => {
    const state = timelineState();
    state.coherence!.sceneMeta[STORM] = { dayOffset: 4400 };
    state.manifest.project.language = 'de';
    const label = (read: ReturnType<typeof timelineModelFor>): string => read.items.find((item) => item.nodeId === STORM)?.a11yLabel ?? '';
    expect(label(timelineModelFor(state))).toContain('Day 4.400');
    const data = valueOf(run(makeHarness({}, state), 'timeline.read', {})).data as unknown as ReturnType<typeof timelineReadDataOf>;
    expect(data.scenes.find((scene) => scene.nodeId === STORM)?.day).toBe(4400);
    expect(JSON.stringify(data)).toContain('4.400');
  });

  it('is a deferred read with the 8000-token cap, found by the words a writer uses for time', () => {
    const row = TOOL_METADATA.find((meta) => meta.name === 'timeline.read');
    expect(row).toMatchObject({ risk: 'read', undoable: false, response_token_cap: 8000, surface: 'extension', load: 'deferred' });
    expect(row?.keywords).toEqual(expect.arrayContaining(['timeline', 'day', 'chronology', 'schedule', 'prologue', 'epilogue']));
    expect(row?.description).toMatch(/^Read the story's timeline/u);
  });

  it('answers with the projection the view builds: the scenes with their days, the part zones and the unscheduled shelf', () => {
    const state = timelineState();
    state.coherence!.sceneMeta[CHAPTER_TWO] = { storyPart: 'epilogue' };
    const harness = makeHarness({}, state);
    const value = valueOf(run(harness, 'timeline.read', {}));
    const data = value.data as unknown as ReturnType<typeof timelineReadDataOf>;
    expect(JSON.parse(JSON.stringify(data))).toEqual(JSON.parse(JSON.stringify(timelineReadDataOf(timelineModelFor(state)))));
    expect(data.scenes.find((scene) => scene.nodeId === LANDING)).toMatchObject({ title: 'The Landing', part: 'main', day: 0, durationDays: 1 });
    expect(data.scenes.find((scene) => scene.nodeId === STORM)?.day).toBe(5);
    // The epilogue is declared on Chapter 2, so the part has a zone though its only scene is undated.
    expect(data.zones.map((zone) => (zone as { part: string }).part)).toEqual(['main', 'epilogue']);
    expect(data.unscheduled.loose.map((entry) => entry.nodeId)).toEqual([FRIEND]);
    expect(data.omitted).toBeNull();
    expect(value.summary).toContain('The Lighthouse Keeper');
    expect(value.affected).toEqual([]);
  });

  it('reads one folder or document when scoped, by title or id, and takes the axis, the lanes and the findings choice', () => {
    const state = timelineState();
    const harness = makeHarness({}, state);
    const byTitle = valueOf(run(harness, 'timeline.read', { scope: 'Chapter 1' })).data as unknown as ReturnType<typeof timelineReadDataOf>;
    const byId = valueOf(run(harness, 'timeline.read', { scope: CHAPTER_ONE })).data as unknown as ReturnType<typeof timelineReadDataOf>;
    expect(byTitle.scenes.map((scene) => scene.nodeId).sort()).toEqual([LANDING, STORM].sort());
    expect(byId).toEqual(byTitle);
    expect(byId.scope).toBe(CHAPTER_ONE);
    const other = valueOf(run(harness, 'timeline.read', { scope: CHAPTER_TWO, axis: 'narrative', groupBy: 'pov', findings: 'none' })).data as unknown as ReturnType<typeof timelineReadDataOf>;
    expect(other).toMatchObject({ axis: 'narrative', groupBy: 'pov' });
    expect(other.scenes.map((scene) => scene.nodeId)).toEqual([FRIEND]);
  });

  it('refuses a scope that is no node, a choice it does not offer and a parameter it does not have, with a hint', () => {
    const harness = makeHarness({}, timelineState());
    expect(refusalOf(run(harness, 'timeline.read', { scope: 'No Such Chapter' })).code).toBe('not-found');
    expect(refusalOf(run(harness, 'timeline.read', { axis: 'sideways' })).code).toBe('invalid-params');
    const unknown = refusalOf(run(harness, 'timeline.read', { colour: 'red' }));
    expect(unknown.code).toBe('invalid-params');
    expect(unknown.message).toContain('colour');
    expect(unknown.correctiveHint).toBeDefined();
  });

  it('changes nothing, saves nothing and logs no row', () => {
    const state = timelineState();
    const harness = makeHarness({}, state);
    const before = everything(state);
    valueOf(run(harness, 'timeline.read', {}));
    valueOf(run(harness, 'timeline.read', { axis: 'braid', groupBy: 'mode' }));
    expect(everything(state)).toBe(before);
    expect(harness.log.length).toBe(0);
  });

  it('is cut at whole scenes under its cap, says how many were left out, and a narrower scope reads the rest', () => {
    const state = timelineState();
    addFolder(state, { parentId: 'manuscript', title: 'Long Part', now: OPENED, id: 'n_LONGPART01' });
    for (let at = 1; at <= 400; at += 1) addDocument(state, { parentId: 'n_LONGPART01', title: `Scene number ${at} of the long part`, body: 'x', now: OPENED });
    for (const node of state.manifest.tree) {
      if (node.parentId === 'n_LONGPART01') state.coherence!.sceneMeta[node.id] = { dayOffset: 10 + node.order, durationDays: 1 };
    }
    const harness = makeHarness({}, state);

    const value = valueOf(run(harness, 'timeline.read', {}));
    const data = value.data as unknown as ReturnType<typeof timelineReadDataOf>;
    const total = data.stats.scenes;
    expect(total).toBe(403);
    expect(data.omitted).not.toBeNull();
    expect(data.omitted?.scenes).toBeGreaterThan(0);
    // Whole records only: what is kept and what was left out add up to every scene, and the kept ones are the model's first, in its order.
    expect(data.scenes.length + (data.omitted?.scenes ?? 0)).toBe(total);
    const full = timelineReadDataOf(timelineModelFor(state), {}, 10_000_000);
    expect(data.scenes).toEqual(full.scenes.slice(0, data.scenes.length));
    expect(estimateTokens(JSON.stringify(data))).toBeLessThanOrEqual(capOf('timeline.read'));
    expect(value.notes?.join(' ')).toMatch(/left out.*narrow scope/u);

    const narrowed = valueOf(run(harness, 'timeline.read', { scope: 'n_LONGPART01' }));
    const rest = narrowed.data as unknown as ReturnType<typeof timelineReadDataOf>;
    expect(rest.stats.scenes).toBe(400);
    expect(rest.scenes.length).toBeGreaterThan(data.scenes.length - 3);
    expect(estimateTokens(JSON.stringify(rest))).toBeLessThanOrEqual(capOf('timeline.read'));
    const small = valueOf(run(harness, 'timeline.read', { scope: CHAPTER_ONE })).data as unknown as ReturnType<typeof timelineReadDataOf>;
    expect(small.omitted).toBeNull();
  });
});

describe('timeline.edit: what it is', () => {
  const tool = PRIMITIVE_TOOLS.find((candidate) => candidate.meta.name === 'timeline.edit');

  it('is a deferred write-confirm row over timeline.apply, with one compensable undo, and the class sentence of its command', () => {
    expect(tool?.command).toBe('timeline.apply');
    expect(tool?.meta).toMatchObject({ risk: 'write-confirm', undoable: true, surface: 'extension', load: 'deferred' });
    expect(tool?.meta.risk).toBe(COMMAND_REGISTRY['timeline.apply'].descriptor.agentRisk);
    expect(tool?.meta.description.endsWith('Requires user confirmation.')).toBe(true);
    expect(tool?.meta.keywords).toEqual(expect.arrayContaining(['timeline', 'day', 'chronology', 'schedule', 'prologue', 'epilogue']));
  });

  it('exposes no scene-meta tool and no picture op: timing reaches the agent only through timeline.edit', () => {
    expect(TOOL_NAMES.some((name) => name.toLowerCase().includes('scenemeta'))).toBe(false);
    const ops = tool?.params.properties['ops'];
    expect(ops?.kind).toBe('array');
    const items = ops?.kind === 'array' ? ops.items : undefined;
    expect(items?.kind).toBe('tagged');
    expect(items?.kind === 'tagged' ? Object.keys(items.variants).sort() : []).toEqual(['meta', 'move', 'shift']);
  });

  it('maps one-to-one onto the ops of timeline.apply, closed, without the expect values the tool reads itself', () => {
    const ops = tool?.params.properties['ops'];
    const variants = ops?.kind === 'array' && ops.items.kind === 'tagged' ? ops.items.variants : {};
    expect(Object.keys(variants['meta']?.properties ?? {}).sort()).toEqual(['nodeId', 'op', 'patch']);
    expect(Object.keys(variants['move']?.properties ?? {}).sort()).toEqual(['index', 'newParentId', 'nodeId', 'op']);
    expect(Object.keys(variants['shift']?.properties ?? {}).sort()).toEqual(['delta', 'nodeIds', 'op']);
    const patch = variants['meta']?.properties['patch'];
    expect(patch?.kind === 'object' ? Object.keys(patch.properties).sort() : []).toEqual([...TIMELINE_META_PATCH_KEYS, 'clear'].sort());
    expect(Object.keys(tool?.params.properties ?? {}).sort()).toEqual(['label', 'ops']);
    for (const key of ['ops', 'label']) expect(DECLARED_PARAMS['timeline.apply']).toContain(key);
  });

  it('refuses an expect from the model, an op it does not offer and a key it does not declare, and writes nothing', () => {
    const state = timelineState();
    const harness = makeHarness({}, state);
    const before = everything(state);
    for (const ops of [
      [{ op: 'meta', nodeId: LANDING, patch: { dayOffset: 3 }, expect: { dayOffset: 0 } }],
      [{ op: 'picture-when', linkId: 'l_1', when: null }],
      [{ op: 'meta', nodeId: LANDING, patch: { colour: 'red' } }],
    ]) {
      expect(refusalOf(run(harness, 'timeline.edit', { ops }, confirmed)).code).toBe('invalid-params');
    }
    expect(everything(state)).toBe(before);
  });
});

describe('timeline.edit: the card', () => {
  it('shows each change as a row of node, part, field, before and after, and the findings the batch raises, and changes nothing', () => {
    const state = timelineState();
    state.coherence!.sceneMeta[STORM] = { dayOffset: 5, after: [LANDING] };
    const harness = makeHarness({}, state);
    const before = everything(state);
    const params = {
      ops: [
        { op: 'meta', nodeId: 'The Landing', patch: { dayOffset: 3, durationDays: 2 } },
        { op: 'meta', nodeId: CHAPTER_TWO, patch: { storyPart: 'epilogue' } },
        { op: 'move', nodeId: STORM, newParentId: 'Chapter 2', index: 0 },
        { op: 'meta', nodeId: STORM, patch: { dayOffset: 1 } },
      ],
    };
    const preview = harness.previewPlan({ steps: [{ tool: 'timeline.edit', params, expect: 'the landing moves to day 3' }] });
    if (!preview.ok) throw new Error(`expected a preflight: ${preview.error.message}`);
    const card = preview.value.steps[0]?.preview as {
      rows: { node: string; part: string; field: string; before: string; after: string }[];
      findingsDelta: { resolved: unknown[]; added: { checkId: string; message: string }[]; resolvedCount: number; addedCount: number };
    };
    expect(card.rows).toContainEqual({ node: 'The Landing', part: 'main', field: 'day', before: 'day 0', after: 'day 3' });
    expect(card.rows).toContainEqual({ node: 'The Landing', part: 'main', field: 'duration', before: '1 day', after: '2 days' });
    expect(card.rows).toContainEqual({ node: 'Chapter 2', part: 'epilogue', field: 'story part', before: 'inherited', after: 'epilogue' });
    expect(card.rows).toContainEqual({ node: 'The Storm', part: 'epilogue', field: 'day', before: 'day 5', after: 'day 1' });
    expect(card.rows).toContainEqual({
      node: 'The Storm',
      part: 'epilogue',
      field: 'position',
      before: 'position 1 under ‘Chapter 1’',
      after: 'position 0 under ‘Chapter 2’',
    });
    // The Storm is declared to follow the Landing, and now happens on day 1 inside the Landing's two days from day 3.
    expect(card.findingsDelta.addedCount).toBeGreaterThan(0);
    expect(card.findingsDelta.added.every((finding) => finding.checkId.startsWith('timeline.') || finding.checkId.startsWith('knowledge.') || finding.checkId.startsWith('plot.'))).toBe(true);
    expect(card.findingsDelta.resolved).toEqual([]);
    expect(everything(state)).toBe(before);
    expect(harness.log.length).toBe(0);
  });

  it('does not call a problem the project already has new, and cuts a long card at its cap, counting what it left out', () => {
    const state = timelineState();
    state.coherence!.sceneMeta[STORM] = { dayOffset: -4, after: [LANDING] };
    const harness = makeHarness({}, state);
    const unrelated = harness.previewPlan({ steps: [{ tool: 'timeline.edit', params: { ops: [{ op: 'meta', nodeId: FRIEND, patch: { durationDays: 1 } }] }, expect: 'a duration' }] });
    if (!unrelated.ok) throw new Error(unrelated.error.message);
    expect((unrelated.value.steps[0]?.preview as { findingsDelta: { addedCount: number } }).findingsDelta.addedCount).toBe(0);

    const many = timelineState();
    addFolder(many, { parentId: 'manuscript', title: 'Long Part', now: OPENED, id: 'n_LONGPART01' });
    for (let at = 1; at <= TIMELINE_CARD_ROWS_MAX + 20; at += 1) addDocument(many, { parentId: 'n_LONGPART01', title: `Scene ${at}`, body: 'x', now: OPENED });
    const ids = many.manifest.tree.filter((node) => node.parentId === 'n_LONGPART01').map((node) => node.id);
    for (const id of ids) many.coherence!.sceneMeta[id] = { dayOffset: 100 };
    const big = makeHarness({}, many).previewPlan({ steps: [{ tool: 'timeline.edit', params: { ops: [{ op: 'shift', delta: 3, nodeIds: ids }] }, expect: 'a shift' }] });
    if (!big.ok) throw new Error(big.error.message);
    const card = big.value.steps[0]?.preview as { rows: unknown[]; omittedRows?: number; findingsDelta: { resolved: unknown[]; added: unknown[] } };
    expect(card.rows).toHaveLength(TIMELINE_CARD_ROWS_MAX);
    expect(card.omittedRows).toBe(20);
    expect(card.findingsDelta.added.length).toBeLessThanOrEqual(TIMELINE_CARD_FINDINGS_MAX);
  });
});

describe('timeline.edit: applying', () => {
  const batch = {
    label: 'Replan the storm',
    ops: [
      { op: 'meta', nodeId: LANDING, patch: { dayOffset: 10, durationDays: 2 } },
      { op: 'meta', nodeId: STORM, patch: { dayOffset: 12, timelineMode: 'flashback', clear: ['durationDays'] } },
      { op: 'shift', delta: 2, nodeIds: [LANDING, STORM] },
      { op: 'meta', nodeId: FRIEND, patch: { storyPart: 'epilogue', dayOffset: 400 } },
      { op: 'move', nodeId: STORM, newParentId: CHAPTER_TWO, index: 0 },
      { op: 'meta', nodeId: LANDING, patch: { dayOffset: 20 } },
    ],
  };

  it('is refused as a bare call, and nothing changes', () => {
    const state = timelineState();
    const before = everything(state);
    const error = refusalOf(run(makeHarness({}, state), 'timeline.edit', batch));
    expect(error.code).toBe('permission-denied');
    expect(error.risk).toBe('write-confirm');
    expect(everything(state)).toBe(before);
  });

  it('applies a multi-scene batch behind a confirmation, each op read against the ops before it, as one undo group, and one Undo restores everything', () => {
    const state = timelineState();
    const harness = makeHarness({}, state);
    const before = everything(state);
    const placesBefore = [LANDING, STORM, FRIEND, CHAPTER_ONE, CHAPTER_TWO].map((id) => placeOf(state, id));

    const done = valueOf(run(harness, 'timeline.edit', batch, confirmed));
    expect(done.summary).toContain('Replan the storm');
    // Five day edits and a shift, a mode, a cleared duration, a part, a move and the second day on the Landing: the counts are the bus's own.
    expect(done.data).toMatchObject({ changes: 10 });
    expect(done.affected.map((row) => row.nodeId).sort()).toEqual([LANDING, STORM, FRIEND].sort());
    expect(done.undoGroupId).toBeDefined();
    // The shift read the days the first two ops left (10 and 12), and the last op replaced the Landing's again.
    expect(sceneMeta(state, STORM)).toMatchObject({ dayOffset: 14, timelineMode: 'flashback' });
    expect(sceneMeta(state, STORM)?.durationDays).toBeUndefined();
    expect(sceneMeta(state, LANDING)).toMatchObject({ dayOffset: 20, durationDays: 2 });
    expect(sceneMeta(state, FRIEND)).toMatchObject({ storyPart: 'epilogue', dayOffset: 400 });
    expect(placeOf(state, STORM).parentId).toBe(CHAPTER_TWO);
    expect(everything(state)).not.toBe(before);
    expect(harness.log.length).toBe(1);

    const undone = harness.undo.undo(done.undoGroupId ?? '');
    expect(undone.ok).toBe(true);
    expect(everything(state)).toBe(before);
    expect([LANDING, STORM, FRIEND, CHAPTER_ONE, CHAPTER_TWO].map((id) => placeOf(state, id))).toEqual(placesBefore);
  });

  it('clears a field it is told to clear, and refuses to both give a field a value and clear it', () => {
    const state = timelineState();
    const harness = makeHarness({}, state);
    valueOf(run(harness, 'timeline.edit', { ops: [{ op: 'meta', nodeId: STORM, patch: { clear: ['dayOffset'] } }] }, confirmed));
    expect(sceneMeta(state, STORM)?.dayOffset).toBeUndefined();
    const both = refusalOf(run(harness, 'timeline.edit', { ops: [{ op: 'meta', nodeId: LANDING, patch: { dayOffset: 4, clear: ['dayOffset'] } }] }, confirmed));
    expect(both.code).toBe('invalid-params');
    expect(both.message).toContain('dayOffset');
    expect(sceneMeta(state, LANDING)?.dayOffset).toBe(0);
  });

  it('names a scene by title or id, a point of view by codex name, and refuses the whole batch for one bad op, writing nothing', () => {
    const state = timelineState();
    const harness = makeHarness({}, state);
    const before = everything(state);
    valueOf(run(harness, 'timeline.edit', { ops: [{ op: 'meta', nodeId: 'The Landing', patch: { pov: 'Elena', after_add: ['The Storm'] } }] }, confirmed));
    expect(sceneMeta(state, LANDING)).toMatchObject({ pov: 'c_HANNE00001', after: [STORM] });
    harness.undo.undo(harness.log.entries().at(-1)?.undoGroupId ?? '');
    expect(everything(state)).toBe(before);

    for (const ops of [
      [{ op: 'meta', nodeId: LANDING, patch: { dayOffset: 7 } }, { op: 'meta', nodeId: 'No Such Scene', patch: { dayOffset: 1 } }],
      [{ op: 'meta', nodeId: LANDING, patch: { dayOffset: 7 } }, { op: 'meta', nodeId: STORM, patch: { pov: 'Nobody' } }],
      [{ op: 'meta', nodeId: LANDING, patch: { dayOffset: 7 } }, { op: 'shift', delta: 1, nodeIds: [FRIEND] }],
      [{ op: 'meta', nodeId: LANDING, patch: { dayOffset: 7 } }, { op: 'move', nodeId: CHAPTER_ONE, newParentId: LANDING, index: 0 }],
    ]) {
      const error = refusalOf(run(harness, 'timeline.edit', { ops }, confirmed));
      expect(['not-found', 'invalid-params'], JSON.stringify(ops)).toContain(error.code);
      expect(everything(state)).toBe(before);
    }
  });
});

describe('timeline.edit: a before-value that went stale', () => {
  /** The bus as the store's own tests build it, so a prepared command can be dispatched later than it was prepared. */
  function busOver(state: ProjectState, harness: ReturnType<typeof makeHarness>) {
    const handle: { bus: BusContext<ProjectState> } = {} as { bus: BusContext<ProjectState> };
    const undo: UndoStore = createUndoStore({ dispatch: (command) => execute(command, handle.bus, harness.registry) });
    handle.bus = { state, view: createViewState(), read: () => state, undo, log: createActivityLog(), idempotency: createIdempotencyCache(), notify: () => undefined };
    return handle.bus;
  }

  it('is refused by the bus naming the scene and the field, and nothing is changed', () => {
    const state = timelineState();
    const harness = makeHarness({}, state);
    const tool = PRIMITIVE_TOOLS.find((candidate) => candidate.meta.name === 'timeline.edit');
    const prepared = tool?.prepare(
      { ops: [{ op: 'meta', nodeId: LANDING, patch: { dayOffset: 3 } }, { op: 'shift', delta: 1, nodeIds: [STORM] }] },
      { state, registry: harness.registry },
    );
    if (prepared === undefined || !prepared.ok) throw new Error('expected a prepared call');
    const command = prepared.value.commands[0];
    if (command === undefined || typeof command.params === 'function') throw new Error('expected fixed params');
    // The base values rode the command: what the Landing's day was, and the fingerprint of the Storm's.
    expect(command.params['ops']).toMatchObject([
      { op: 'meta', nodeId: LANDING, expect: { dayOffset: 0 } },
      { op: 'shift', delta: 1, nodeIds: [STORM] },
    ]);

    // Between the proposal and the approval, the writer dates the Landing by hand.
    state.coherence!.sceneMeta[LANDING] = { dayOffset: 8, durationDays: 1 };
    const before = everything(state);
    const dispatched: Command = { id: 'cmd_STALE000001', name: 'timeline.apply', params: command.params, issuedBy: 'user', createdAt: 1_000 };
    const result = execute(dispatched, busOver(state, harness), harness.registry);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('revision-conflict');
    expect(result.error.message).toContain('The Landing');
    expect(result.error.message).toContain('day');
    expect(everything(state)).toBe(before);
    expect(state.coherence?.sceneMeta[LANDING]?.dayOffset).toBe(8);

    // The same stale shift is refused the same way when the Storm's day, not the Landing's, moved.
    state.coherence!.sceneMeta[LANDING] = { dayOffset: 0, durationDays: 1 };
    state.coherence!.sceneMeta[STORM] = { dayOffset: 6 };
    const stale = execute({ ...dispatched, id: 'cmd_STALE000002' }, busOver(state, harness), harness.registry);
    expect(stale.ok ? undefined : stale.error.code).toBe('revision-conflict');
    expect(state.coherence?.sceneMeta[STORM]?.dayOffset).toBe(6);
    expect(state.coherence?.sceneMeta[LANDING]?.dayOffset).toBe(0);
  });
});

describe('timeline.edit: the values a card was proposed against are held to at the approval', () => {
  const params = { label: 'Replan', ops: [{ op: 'meta', nodeId: LANDING, patch: { dayOffset: 3 } }, { op: 'shift', delta: 1, nodeIds: [STORM] }] };

  it('stages the ops with the values the project holds, and a call with that proposal refuses the whole batch after a scene changed, writing nothing', () => {
    const state = timelineState();
    const harness = makeHarness({}, state);
    const staged = harness.timelineStage(params);
    if (!staged.ok) throw new Error(staged.error.message);
    expect(staged.value.ops).toMatchObject([
      { op: 'meta', nodeId: LANDING, expect: { dayOffset: 0 } },
      { op: 'shift', delta: 1, nodeIds: [STORM] },
    ]);

    // The scene is dated by hand while the card waits.
    state.coherence!.sceneMeta[LANDING] = { dayOffset: 8, durationDays: 1 };
    const before = everything(state);
    const stale = harness.call({ name: 'timeline.edit', callId: 'call-stale-1', params, proposal: staged.value }, { turnId: 'turn-stale-1', ...confirmed });
    expect(refusalOf(stale).code).toBe('revision-conflict');
    expect(refusalOf(stale).message).toContain('The Landing');
    expect(everything(state)).toBe(before);
    expect(harness.log.length).toBe(0);

    // Without a proposal the same call reads the project as it is and applies: that is the bare call, which has no card to hold it to.
    expect(run(harness, 'timeline.edit', params, confirmed).ok).toBe(true);
    expect(sceneMeta(state, LANDING)?.dayOffset).toBe(3);
  });

  it('refuses the plan at its approval with the conflict named, where a bare preflight of the same plan is ready', () => {
    const state = timelineState();
    const harness = makeHarness({}, state);
    const staged = harness.timelineStage(params);
    if (!staged.ok) throw new Error(staged.error.message);
    const plan = { steps: [{ tool: 'timeline.edit', params, expect: 'replanned' }] };
    const proposals = [staged.value];
    const ready = harness.previewPlan(plan, { proposals });
    if (!ready.ok) throw new Error(ready.error.message);
    expect(ready.value.steps[0]?.status).toBe('ready');

    state.coherence!.sceneMeta[STORM] = { dayOffset: 6 };
    const before = everything(state);
    const refused = harness.previewPlan(plan, { proposals });
    if (!refused.ok) throw new Error(refused.error.message);
    expect(refused.value.steps[0]).toMatchObject({ status: 'refused', error: { code: 'revision-conflict' } });
    const executed = harness.executePlan(plan, { turnId: 'turn-stale-2', callId: 'plan-stale-2' }, { proposals });
    if (!executed.ok) throw new Error(executed.error.message);
    expect(executed.value.status).toBe('refused');
    expect(everything(state)).toBe(before);
  });

  it('refuses a proposal staged for other params, and one that is not a timeline edit, and writes nothing', () => {
    const state = timelineState();
    const harness = makeHarness({}, state);
    const staged = harness.timelineStage(params);
    if (!staged.ok) throw new Error(staged.error.message);
    const before = everything(state);
    const edited = { ...params, ops: [{ op: 'meta', nodeId: LANDING, patch: { dayOffset: 4 } }] };
    const other = harness.call({ name: 'timeline.edit', callId: 'call-other-1', params: edited, proposal: staged.value }, { turnId: 'turn-other-1', ...confirmed });
    expect(refusalOf(other).code).toBe('invalid-params');
    expect(refusalOf(other).message).toContain('different parameters');
    const foreign = harness.call({ name: 'timeline.edit', callId: 'call-other-2', params, proposal: { shots: [] } }, { turnId: 'turn-other-2', ...confirmed });
    expect(refusalOf(foreign).code).toBe('invalid-params');
    expect(everything(state)).toBe(before);
  });

  it('refuses at staging a batch the bus refuses, and one with a parameter it does not declare', () => {
    const harness = makeHarness({}, timelineState());
    const missing = harness.timelineStage({ ops: [{ op: 'meta', nodeId: 'No such scene', patch: { dayOffset: 1 } }] });
    expect(missing.ok ? undefined : missing.error.code).toBe('not-found');
    const open = harness.timelineStage({ ops: [{ op: 'meta', nodeId: LANDING, patch: { dayOffset: 1 } }], extra: true });
    expect(open.ok ? undefined : open.error.code).toBe('invalid-params');
  });
});

describe('timeline.edit: the permission modes, on the real session', () => {
  const intent = 'Replan the storm and the landing.';
  const plan = {
    tool: 'timeline.edit',
    params: {
      ops: [
        { op: 'meta', nodeId: LANDING, patch: { dayOffset: 3 } },
        { op: 'meta', nodeId: STORM, patch: { dayOffset: 9 } },
        { op: 'move', nodeId: STORM, newParentId: CHAPTER_TWO, index: 0 },
      ],
    },
    expect: 'the landing and the storm are replanned',
  };

  async function turn(mode: PermissionMode) {
    const state = timelineState();
    const harness = createHarness({ state, ports: createAgentPorts() });
    const gateway = await mockGateway([transcript(intent, [steps(plan), answer('Replanned.')])]);
    const asked: PendingCard[] = [];
    const session = createAgentSession({
      harness,
      gateway,
      context: createContextPort({ state }),
      decide: async (card) => {
        asked.push(card);
        return { action: 'approve' };
      },
      mode,
      sessionId: `timeline-${mode}`,
    });
    const before = everything(state);
    const report = await session.submit(intent, { preload: ['timeline.edit'] });
    return { state, harness, asked, report, before };
  }

  it('keeps timeline.edit out of Accept edits, so that mode asks, and Auto approves any native card', () => {
    expect(ACCEPT_EDITS_TOOLS.has('timeline.edit')).toBe(false);
    expect(modePolicy('accept-edits').approves({ tools: ['timeline.edit'], external: false })).toBe(false);
    expect(modePolicy('accept-edits').approves({ tools: ['synopsis.set', 'timeline.edit'], external: false })).toBe(false);
    expect(modePolicy('ask').approves({ tools: ['timeline.edit'], external: false })).toBe(false);
    expect(modePolicy('auto').approves({ tools: ['timeline.edit'], external: false })).toBe(true);
  });

  it.each(['ask', 'accept-edits'] as const)('asks the writer in %s, shows the diff card, and applies once approved as one undoable turn', async (mode) => {
    const { state, harness, asked, report, before } = await turn(mode);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.kind).toBe('confirm');
    expect(asked[0]?.card.steps.map((step) => step.tool)).toEqual(['timeline.edit']);
    const shown = JSON.stringify(asked[0]?.card.steps[0]?.preview);
    expect(shown).toContain('findingsDelta');
    expect(shown).toContain('The Landing');
    expect(report.status).toBe('applied');
    expect(sceneMeta(state, STORM)?.dayOffset).toBe(9);
    expect(placeOf(state, STORM).parentId).toBe(CHAPTER_TWO);
    expect(report.undoGroupId).toBeDefined();
    expect(harness.undo.undo(report.undoGroupId ?? '').ok).toBe(true);
    expect(everything(state)).toBe(before);
  });

  it('refuses the whole batch when a scene changed while the card waited, keeps the card for a retry, and the retry is checked against the new values', async () => {
    const state = timelineState();
    const harness = createHarness({ state, ports: createAgentPorts() });
    const gateway = await mockGateway([transcript(intent, [steps(plan), answer('Replanned.')])]);
    const asked: PendingCard[] = [];
    let changed = '';
    const session = createAgentSession({
      harness,
      gateway,
      context: createContextPort({ state }),
      decide: async (card) => {
        asked.push(card);
        if (asked.length === 1) {
          // The writer dates the Landing by hand while the card is open, then approves the card as it was shown.
          state.coherence!.sceneMeta[LANDING] = { dayOffset: 7, durationDays: 1 };
          changed = everything(state);
          return { action: 'approve' };
        }
        return asked.length === 2 ? { action: 'retry' } : { action: 'approve' };
      },
      mode: 'ask',
      sessionId: 'timeline-stale',
    });
    const report = await session.submit(intent, { preload: ['timeline.edit'] });

    // The approval of the first card wrote nothing, and the card came back with the step stale and the conflict named.
    expect(asked).toHaveLength(3);
    expect(asked[1]?.card.steps[0]).toMatchObject({ tool: 'timeline.edit', stale: true, status: 'refused' });
    expect(asked[1]?.card.approvable).toBe(false);
    expect(JSON.stringify(asked[1]?.card.steps[0])).toContain('revision-conflict');
    expect(asked[1]?.card.notice).toContain('retry it to read the timeline again');
    expect(JSON.stringify(asked[0]?.card.steps[0]?.preview)).toContain('day 0');

    // The retry stages the batch again from the project as it is, so its card says day 7 and is approvable, and the approval applies it.
    expect(JSON.stringify(asked[2]?.card.steps[0]?.preview)).toContain('day 7');
    expect(asked[2]?.card.approvable).toBe(true);
    expect(report.status).toBe('applied');
    expect(sceneMeta(state, LANDING)?.dayOffset).toBe(3);
    expect(sceneMeta(state, STORM)?.dayOffset).toBe(9);
    expect(harness.undo.undo(report.undoGroupId ?? '').ok).toBe(true);
    expect(everything(state)).toBe(changed);
  });

  it('writes nothing when the card is cancelled after a scene changed under it', async () => {
    const state = timelineState();
    const harness = createHarness({ state, ports: createAgentPorts() });
    const gateway = await mockGateway([transcript(intent, [steps(plan), answer('Left alone.')])]);
    let calls = 0;
    const session = createAgentSession({
      harness,
      gateway,
      context: createContextPort({ state }),
      decide: async () => {
        calls += 1;
        if (calls === 1) {
          state.coherence!.sceneMeta[STORM] = { dayOffset: 6 };
          return { action: 'approve' as const };
        }
        return { action: 'cancel' as const };
      },
      mode: 'ask',
      sessionId: 'timeline-stale-cancel',
    });
    const report = await session.submit(intent, { preload: ['timeline.edit'] });
    expect(report.status).not.toBe('applied');
    expect(sceneMeta(state, STORM)?.dayOffset).toBe(6);
    expect(sceneMeta(state, LANDING)?.dayOffset).toBe(0);
    expect(placeOf(state, STORM).parentId).toBe(CHAPTER_ONE);
  });
  it('declines, and writes nothing, when the writer says no', async () => {
    const state = timelineState();
    const harness = createHarness({ state, ports: createAgentPorts() });
    const gateway = await mockGateway([transcript(intent, [steps(plan), answer('Left alone.')])]);
    const session = createAgentSession({ harness, gateway, context: createContextPort({ state }), decide: async () => ({ action: 'cancel' as const }), mode: 'accept-edits', sessionId: 'timeline-no' });
    const before = everything(state);
    const report = await session.submit(intent, { preload: ['timeline.edit'] });
    expect(report.status).not.toBe('applied');
    expect(everything(state)).toBe(before);
  });

  it('approves in Auto without asking, as one undoable turn that the checkpoint restores', async () => {
    const { state, harness, asked, report, before } = await turn('auto');
    expect(asked).toHaveLength(0);
    expect(report.status).toBe('applied');
    expect(report.cards.map((card) => [card.kind, card.tools, card.decision])).toEqual([['auto', ['timeline.edit'], 'auto']]);
    expect(sceneMeta(state, LANDING)?.dayOffset).toBe(3);
    expect(harness.undo.undo(report.undoGroupId ?? '').ok).toBe(true);
    expect(everything(state)).toBe(before);
  });

  it('refuses in Plan-only: the step is held as a failed card naming the mode, and nothing is written', async () => {
    const { state, asked, report, before } = await turn('plan-only');
    expect(asked).toHaveLength(0);
    expect(report.mode).toBe('plan-only');
    expect(report.heldSteps?.map((step) => step.tool)).toEqual(['timeline.edit']);
    expect(report.undoGroupId).toBeUndefined();
    expect(everything(state)).toBe(before);
  });

  it('is decided by every mode the policy names, and only Auto approves it unasked', () => {
    const approving = PERMISSION_MODES.filter((mode) => modePolicy(mode).approves({ tools: ['timeline.edit'], external: false }));
    expect(approving).toEqual(['auto']);
  });
});
