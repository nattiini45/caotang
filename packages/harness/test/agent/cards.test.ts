/**
 * The cards as data: the status-card transitions, the consecutive-call grouping, the plan edits
 * (reorder, drop, and a param edit that includes a range anchor's fields), the dependency badge,
 * and the approvability rule that makes a card with a refused step impossible to approve.
 */

import { describe, expect, it } from 'vitest';

import { applyEdit, advance, canAdvance, dependencyBadges, groupCards, planCardOf, RESOLVE_BADGE, type EditableSteps, type StatusCard } from '../../src/index.js';
import type { PlanPreflight, PlanStep } from '../../src/index.js';

const card = (status: StatusCard['status'], id = 'c1', turnId = 'turn-1'): StatusCard => ({ id, turnId, callId: id, tool: 'meta.set', risk: 'write-auto', status, args: {} });

describe('status cards (the §8 lifecycle)', () => {
  it('moves forward along the lifecycle and never back or out of a final state', () => {
    expect(canAdvance('pending-approval', 'running')).toBe(true);
    expect(canAdvance('pending-approval', 'cancelled')).toBe(true);
    expect(canAdvance('running', 'done')).toBe(true);
    expect(canAdvance('running', 'failed')).toBe(true);
    expect(canAdvance('running', 'pending-approval')).toBe(false);
    expect(canAdvance('done', 'running')).toBe(false);
    expect(canAdvance('cancelled', 'running')).toBe(false);
    expect(advance(card('running'), 'done', { summary: 'set the label' })).toMatchObject({ status: 'done', summary: 'set the label' });
  });

  it('refuses an illegal move as a defect, rather than returning a card that skipped a state', () => {
    expect(() => advance(card('pending-approval'), 'done')).toThrow(/cannot move from pending-approval to done/);
  });

  it('groups consecutive calls of one turn, open while any is running, and closes them when they finish', () => {
    const items = groupCards([card('done', 'a'), card('running', 'b'), card('done', 'x', 'turn-2')]);
    expect(items[0]).toMatchObject({ kind: 'group', expanded: true });
    expect(items[1]).toMatchObject({ kind: 'card' });
    expect(groupCards([card('done', 'a'), card('done', 'b')])[0]).toMatchObject({ kind: 'group', expanded: false });
  });
});

const steps: PlanStep[] = [
  { tool: 'doc.import', params: { parent: 'manuscript', title: 'Prologue', body: 'Once.' }, expect: 'a prologue exists' },
  { tool: 'meta.set', params: { targets: ['Prologue'], label: 'act-1' }, expect: 'the prologue is labelled' },
  { tool: 'scene.draft', params: { doc: 'The Storm', instruction: 'Rain.', mode: 'continue' }, expect: 'the storm continues' },
];

function editable(over: Partial<EditableSteps> = {}): EditableSteps {
  return {
    steps,
    origins: steps.map((_, index) => index),
    proposals: steps.map(() => undefined),
    stale: steps.map(() => false),
    superseded: [],
    completed: [],
    ...over,
  };
}

describe('plan edits (agent-harness §2)', () => {
  it('attributes a change to the writer when they edit a hook’s replacement', () => {
    const step = { tool: 'notes.append', params: { doc: 'The Storm', text: 'Rain fell.' }, expect: 'Add a note.' };
    const rewrite = { tool: step.tool, field: 'text', before: 'Snow fell.', name: 'Weather check' };
    const changed = applyEdit(editable({ steps: [step], origins: [0], hookRewrites: [rewrite] }), {
      op: 'set', index: 0, path: ['params', 'text'], value: 'Hail fell.',
    });
    expect(changed).toMatchObject({ ok: true, value: {
      steps: [{ params: { text: 'Hail fell.' } }],
      hookRewrites: [{ ...rewrite, edited: true }],
    } });
  });

  it('reorders steps with their origins, proposals and staleness moving together', () => {
    const withDraft = editable({ proposals: [undefined, undefined, { text: 'Rain falls.', words: 2 }] });
    const moved = applyEdit(withDraft, { op: 'reorder', from: 2, to: 0 });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value.steps.map((step) => step.tool)).toEqual(['scene.draft', 'doc.import', 'meta.set']);
    expect(moved.value.origins).toEqual([2, 0, 1]);
    expect(moved.value.proposals[0]).toEqual({ text: 'Rain falls.', words: 2 });
    expect(moved.value.superseded).toEqual([]);
  });

  it('drops a step, and supersedes it, so that its dependents can be flagged', () => {
    const dropped = applyEdit(editable(), { op: 'drop', index: 0 });
    expect(dropped.ok).toBe(true);
    if (!dropped.ok) return;
    expect(dropped.value.steps).toHaveLength(2);
    expect(dropped.value.superseded).toEqual([{ origin: 0, step: steps[0] }]);
  });

  it('refuses to drop the last step, and refuses a step that is not in the plan', () => {
    const one = editable({ steps: [steps[0] as PlanStep], origins: [0], proposals: [undefined], stale: [false] });
    expect(applyEdit(one, { op: 'drop', index: 0 })).toMatchObject({ ok: false });
    expect(applyEdit(editable(), { op: 'drop', index: 9 })).toMatchObject({ ok: false, error: expect.stringContaining('not in the plan') });
  });

  it('edits a param, marking a model-backed step’s draft stale, and edits a range anchor’s fields in place', () => {
    const edited = applyEdit(editable(), { op: 'set', index: 2, path: ['params', 'mode'], value: 'draft' });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.steps[2]?.params['mode']).toBe('draft');
    expect(edited.value.stale[2]).toBe(true);
    expect(edited.value.superseded.map((entry) => entry.origin)).toEqual([2]);

    const anchored: PlanStep = {
      tool: 'scene.draft',
      params: { doc: 'The Storm', instruction: 'Rain.', mode: 'rewrite_selection', selection: { from: 0, to: 4, exact: 'Rain', prefix: '', suffix: '', capturedRevision: 0 } },
      expect: 'the storm is rewritten',
    };
    const moved = applyEdit(editable({ steps: [anchored], origins: [0], proposals: [undefined], stale: [false] }), {
      op: 'set',
      index: 0,
      path: ['params', 'selection', 'to'],
      value: 4,
    });
    expect(moved.ok).toBe(true);
    if (moved.ok) expect((moved.value.steps[0]?.params['selection'] as { to: number }).to).toBe(4);
  });

  it('refuses a path outside tool, expect and params, and an edit that leaves no tool name', () => {
    expect(applyEdit(editable(), { op: 'set', index: 0, path: ['origin'], value: 'x' })).toMatchObject({ ok: false });
    expect(applyEdit(editable(), { op: 'set', index: 0, path: ['tool'], value: 42 })).toMatchObject({ ok: false });
  });
});

describe('the edit-time dependency check', () => {
  it('flags a later step that names something a dropped step created, and only that step', () => {
    const dropped = applyEdit(editable(), { op: 'drop', index: 0 });
    if (!dropped.ok) throw new Error('the drop should apply');
    const badges = dependencyBadges(dropped.value.steps, dropped.value.origins, dropped.value.superseded);
    expect(badges[0]).toEqual([RESOLVE_BADGE]);
    expect(badges[1]).toEqual([]);
  });

  it('does not flag a step that comes before the dropped one, or a step that names nothing it made', () => {
    const dropped = applyEdit(editable(), { op: 'drop', index: 1 });
    if (!dropped.ok) throw new Error('the drop should apply');
    const badges = dependencyBadges(dropped.value.steps, dropped.value.origins, dropped.value.superseded);
    expect(badges.every((entry) => entry.length === 0)).toBe(true);
  });
});

describe('the plan card', () => {
  const ready: PlanPreflight = { ok: true, steps: steps.map((_, index) => ({ index, tool: steps[index]?.tool ?? '', expect: '', status: 'ready' as const })) };
  const refused: PlanPreflight = {
    ok: false,
    steps: [{ index: 0, tool: 'doc.import', expect: '', status: 'refused' as const, error: { code: 'invalid-params', message: 'the title is taken' } }],
  };

  it('is approvable when the latest preview is current and nothing is refused', () => {
    const view = planCardOf({ id: 'card', turnId: 't', kind: 'plan', revision: 0, previewRevision: 0, from: 0, state: editable(), preflight: ready, previews: [], risks: [] });
    expect(view.approvable).toBe(true);
  });

  it('is not approvable while a step is refused, and says which step by its error', () => {
    const view = planCardOf({ id: 'card', turnId: 't', kind: 'plan', revision: 1, previewRevision: 1, from: 0, state: editable(), preflight: refused, previews: [], risks: [] });
    expect(view.approvable).toBe(false);
    expect(view.steps[0]?.status).toBe('refused');
    expect(view.steps[0]?.error?.message).toBe('the title is taken');
  });

  it('is not approvable until the latest edit has been previewed, so an approval always covers the card as it stands', () => {
    const view = planCardOf({ id: 'card', turnId: 't', kind: 'plan', revision: 2, previewRevision: 1, from: 0, state: editable(), preflight: ready, previews: [], risks: [] });
    expect(view.approvable).toBe(false);
  });

  it('shows model-hook estimates only for ready steps that are still to run', () => {
    const estimate = { id: 'hook', name: 'Review point of view', event: 'tool.before' as const, promptTokens: 80, outputTokens: 256 };
    const view = planCardOf({
      id: 'card', turnId: 't', kind: 'plan', revision: 0, previewRevision: 0, from: 1,
      state: editable({ completed: [0] }), previews: [], risks: [],
      preflight: { ok: false, steps: [...ready.steps.slice(0, 2), { ...refused.steps[0]!, index: 2 }] },
      modelHooks: [[estimate], [estimate], [estimate]],
    });
    expect(view.steps.map(step => step.modelHooks)).toEqual([undefined, [estimate], undefined]);
  });

  it('shows the steps a resumed plan will not run again as done, by the origins it has applied', () => {
    const view = planCardOf({
      id: 'card',
      turnId: 't',
      kind: 'plan',
      revision: 0,
      previewRevision: 0,
      from: 2,
      state: editable({ completed: [0, 1] }),
      preflight: { ok: true, steps: [{ index: 2, tool: 'scene.draft', expect: '', status: 'ready' }] },
      previews: [],
      risks: [],
    });
    expect(view.steps.map((step) => step.status)).toEqual(['done', 'done', 'ready']);
  });
});

describe('steps that have applied are pinned (agent-harness §7)', () => {
  const ran = (over: Partial<EditableSteps> = {}): EditableSteps => editable({ completed: [0], ...over });

  it('refuses to drop, change or reorder a step that has applied, and says it has run', () => {
    expect(applyEdit(ran(), { op: 'drop', index: 0 })).toMatchObject({ ok: false, error: expect.stringContaining('has already run') });
    expect(applyEdit(ran(), { op: 'set', index: 0, path: ['params', 'label'], value: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('has already run') });
    expect(applyEdit(ran(), { op: 'reorder', from: 0, to: 2 })).toMatchObject({ ok: false, error: expect.stringContaining('has already run') });
    expect(applyEdit(ran(), { op: 'reorder', from: 2, to: 0 })).toMatchObject({ ok: false, error: expect.stringContaining('has already run') });
  });

  it('allows a move among the pending steps, and keeps the applied step at the front', () => {
    const among = applyEdit(ran(), { op: 'reorder', from: 1, to: 2 });
    expect(among.ok).toBe(true);
    if (among.ok) {
      expect(among.value.steps.map((step) => step.tool)).toEqual(['doc.import', 'scene.draft', 'meta.set']);
      expect(among.value.completed).toEqual([0]);
    }
  });

  it('keeps the applied set through every edit, so a later edit still refuses to touch what has run', () => {
    const dropped = applyEdit(ran(), { op: 'drop', index: 2 });
    expect(dropped.ok).toBe(true);
    if (!dropped.ok) return;
    expect(dropped.value.completed).toEqual([0]);
    expect(applyEdit(dropped.value, { op: 'drop', index: 0 })).toMatchObject({ ok: false });
  });

  it('derives done from the origins that have applied, not from a position', () => {
    // The step at position 0 now came from origin 2, which has not run, and origin 0 (now at position 2) has.
    const moved = editable({ origins: [2, 1, 0], completed: [0] });
    const view = planCardOf({ id: 'card', turnId: 't', kind: 'plan', revision: 0, previewRevision: 0, from: 0, state: moved, preflight: { ok: true, steps: [] }, previews: [], risks: [] });
    expect(view.steps.map((step) => step.status)).toEqual(['ready', 'ready', 'done']);
  });
});

describe('a draft that is stale or cut cannot be approved as it stands', () => {
  const preflight: PlanPreflight = { ok: true, steps: steps.map((_, index) => ({ index, tool: steps[index]?.tool ?? '', expect: '', status: 'ready' as const })) };
  const view = (over: Partial<EditableSteps>, staged: { cut?: boolean; stale?: boolean }[] = []) =>
    planCardOf({
      id: 'card',
      turnId: 't',
      kind: 'plan',
      revision: 0,
      previewRevision: 0,
      from: 0,
      state: editable({ ...over, stale: steps.map((_, index) => staged[index]?.stale === true) }),
      preflight,
      previews: [],
      risks: [],
      staged: steps.map((_, index) => ({ cut: staged[index]?.cut === true })),
    });

  it('a cut draft is not approvable, but the card can be approved with the cut text accepted', () => {
    const cut = view({}, [{}, {}, { cut: true }]);
    expect(cut.approvable).toBe(false);
    expect(cut.canAcceptCut).toBe(true);
    expect(cut.cut).toBe(true);
    expect(cut.steps[2]).toMatchObject({ cut: true });
  });

  it('a stale draft is not approvable, and cannot be accepted as it stands: it must be drafted again', () => {
    const stale = view({}, [{}, {}, { stale: true }]);
    expect(stale.approvable).toBe(false);
    expect(stale.canAcceptCut).toBe(false);
    expect(stale.steps[2]).toMatchObject({ stale: true });
  });

  it('a cut draft that has already applied does not hold the card back', () => {
    const done = view({ completed: [2] }, [{}, {}, { cut: true }]);
    expect(done.cut).toBe(false);
    expect(done.approvable).toBe(true);
  });
});
