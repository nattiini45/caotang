/**
 * `agent.plan` — preflight through the bus's validate path, the one deferral, the
 * approved-plan flag, one undo group across the steps, and the ask-back envelope
 * when a step fails.
 */

import { err } from '@caotang/bus';
import { describe, expect, it } from 'vitest';

import { askBackFor, createHarness, type ToolPort } from '../src/index.js';
import { CHAPTER_ONE, CHAPTER_TWO, LANDING, STORM, makeHarness, makeState, snapshotOf } from './fixtures.js';
import type { CommandError } from '@caotang/bus';

function step(tool: string, params: Record<string, unknown>, expect = `${tool} runs`) {
  return { tool, params, expect };
}

describe('previewPlan', () => {
  it('reports every step ready when every step validates against the project', () => {
    const harness = makeHarness();
    const preflight = harness.previewPlan({ steps: [step('meta.set', { targets: [LANDING], status: 'final' })] });
    expect(preflight.ok && preflight.value.ok).toBe(true);
  });

  it('refuses the plan when a step is refused, and names the refused step by index', () => {
    const harness = makeHarness();
    const result = harness.previewPlan({
      steps: [step('meta.set', { targets: [LANDING], status: 'final' }), step('meta.set', { targets: [LANDING], status: 'bogus' })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ok).toBe(false);
    expect(result.value.steps.map((entry) => entry.status)).toEqual(['ready', 'refused']);
    expect(result.value.steps[1]?.error?.code).toBe('invalid-params');
  });

  it('refuses a step naming a tool that does not exist, even when an earlier step could create something', () => {
    const harness = makeHarness();
    const result = harness.previewPlan({
      steps: [step('doc.import', { parent: CHAPTER_ONE, title: 'Lantern', body: 'x' }), step('book.delete', {}, 'nothing')],
    });
    if (!result.ok) throw new Error('expected a preflight');
    expect(result.value.steps[1]?.status).toBe('refused');
    expect(result.value.steps[1]?.error?.message).toContain('"book.delete" is not a tool in this build');
  });

  it('defers a step that names something an earlier create step makes, so the plan can be approved', () => {
    const harness = makeHarness();
    const result = harness.previewPlan({
      steps: [
        step('doc.import', { parent: CHAPTER_ONE, title: 'Lantern', body: 'x' }),
        step('meta.set', { targets: ['Lantern'], status: 'draft' }),
      ],
    });
    if (!result.ok) throw new Error('expected a preflight');
    expect(result.value.steps.map((entry) => entry.status)).toEqual(['ready', 'deferred']);
    expect(result.value.ok).toBe(true);
    expect(result.value.steps[1]?.reason).toContain('step 1 may create');
  });

  it('does not defer a missing name when no earlier step creates anything', () => {
    const result = makeHarness().previewPlan({ steps: [step('meta.set', { targets: ['Lantern'], status: 'draft' })] });
    if (!result.ok) throw new Error('expected a preflight');
    expect(result.value.steps[0]?.status).toBe('refused');
    expect(result.value.ok).toBe(false);
  });

  it('gives a restructure step its preview lines, from the same validation the step will run', () => {
    const result = makeHarness().previewPlan({
      steps: [step('binder.restructure', { ops: [{ action: 'rename', node: CHAPTER_ONE, title: 'Prologue' }] })],
    });
    if (!result.ok) throw new Error('expected a preflight');
    const preview = result.value.steps[0]?.preview as { lines: string[] } | undefined;
    expect(preview?.lines).toEqual(['rename "Chapter 1" to "Prologue"']);
  });

  it('shows a move in the preview tree with the parent the node leaves and the parent it joins', () => {
    const result = makeHarness().previewPlan({
      steps: [step('binder.restructure', { ops: [{ action: 'move', node: LANDING, newParent: CHAPTER_TWO, index: 0 }] })],
    });
    if (!result.ok) throw new Error('expected a preflight');
    const preview = result.value.steps[0]?.preview as { tree: unknown[] } | undefined;
    expect(preview?.tree).toEqual([
      {
        id: LANDING,
        change: 'moved',
        before: { parentId: CHAPTER_ONE, parentTitle: 'Chapter 1', title: 'The Landing' },
        after: { parentId: CHAPTER_TWO, parentTitle: 'Chapter 2', title: 'The Landing' },
      },
    ]);
  });

  it('shows a created node under its parent, and a rename with the title the node had', () => {
    const result = makeHarness().previewPlan({
      steps: [
        step('binder.restructure', {
          ops: [
            { action: 'create', parent: 'manuscript', type: 'folder', title: 'Act 2' },
            { action: 'rename', node: CHAPTER_TWO, title: 'Chapter Two' },
          ],
        }),
      ],
    });
    if (!result.ok) throw new Error('expected a preflight');
    const preview = result.value.steps[0]?.preview as { tree: unknown[] } | undefined;
    expect(preview?.tree).toEqual([
      {
        id: CHAPTER_TWO,
        change: 'renamed',
        before: { parentId: 'manuscript', parentTitle: 'Manuscript', title: 'Chapter 2' },
        after: { parentId: 'manuscript', parentTitle: 'Manuscript', title: 'Chapter Two' },
      },
      {
        id: null,
        change: 'created',
        type: 'folder',
        after: { parentId: 'manuscript', parentTitle: 'Manuscript', title: 'Act 2' },
      },
    ]);
  });

  it('leaves a node out of the preview tree when the batch ends where it began', () => {
    const result = makeHarness().previewPlan({
      steps: [
        step('binder.restructure', {
          ops: [
            { action: 'rename', node: CHAPTER_ONE, title: 'Scratch' },
            { action: 'rename', node: CHAPTER_ONE, title: 'Chapter 1' },
          ],
        }),
      ],
    });
    if (!result.ok) throw new Error('expected a preflight');
    const preview = result.value.steps[0]?.preview as { tree: unknown[] } | undefined;
    expect(preview?.tree).toEqual([]);
  });

  it('refuses a malformed plan, with the plan schema’s own message', () => {
    const result = makeHarness().previewPlan({ steps: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe('params.steps must have at least 1 entry, got 0');
  });

  it('refuses a step whose params are not an object', () => {
    const result = makeHarness().previewPlan({ steps: [{ tool: 'meta.set', params: 'x', expect: 'e' }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe('params.steps[0].params must be an object, got a string');
  });

  it('refuses a plan that names agent.plan as a step, because a plan does not nest', () => {
    const result = makeHarness().previewPlan({ steps: [step('agent.plan', { steps: [] })] });
    if (!result.ok) throw new Error('expected a preflight');
    expect(result.value.steps[0]?.error?.message).toContain('agent.plan is a plan, not a tool call');
  });

  it('refuses a plan with more steps than the batch surfaces allow, and says how many are allowed', () => {
    const steps = Array.from({ length: 31 }, () => step('meta.set', { targets: [LANDING], status: 'draft' }));
    const result = makeHarness().previewPlan({ steps });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('at most 30');
  });
});

describe('executePlan', () => {
  it('refuses the whole plan, with nothing written, when any step is refused at preflight', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    const before = snapshotOf(state);
    const outcome = harness.executePlan(
      { steps: [step('meta.set', { targets: [LANDING], status: 'final' }), step('meta.set', { targets: [LANDING], status: 'bogus' })] },
      { turnId: 'turn-refused', callId: 'plan-refused' },
    );
    if (!outcome.ok) throw new Error('expected an outcome');
    expect(outcome.value.status).toBe('refused');
    expect(snapshotOf(state)).toBe(before);
    expect(harness.log.length).toBe(0);
  });

  it('runs write-confirm steps without any confirmation, because the approved plan carries it, and puts them in one undo group', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    const before = snapshotOf(state);
    const outcome = harness.executePlan(
      {
        steps: [
          step('meta.set', { targets: [LANDING], status: 'revised' }),
          step('codex.write', { entries: [{ action: 'create', name: 'Mara' }] }),
          step('binder.restructure', { ops: [{ action: 'create', parent: 'manuscript', type: 'folder', title: 'Act 2' }] }),
        ],
      },
      { turnId: 'turn-plan', callId: 'plan-applied' },
    );
    if (!outcome.ok || outcome.value.status !== 'applied') throw new Error(`expected applied, got ${JSON.stringify(outcome)}`);
    expect(outcome.value.steps.map((entry) => entry.index)).toEqual([0, 1, 2]);
    const groups = new Set(outcome.value.steps.map((entry) => entry.value.undoGroupId));
    expect(groups.size).toBe(1);
    expect(outcome.value.undoGroupId).toBe([...groups][0]);
    expect(state.manifest.tree.some((node) => node.title === 'Act 2')).toBe(true);
    harness.undo.undo(outcome.value.undoGroupId ?? '');
    expect(snapshotOf(state)).toBe(before);
  });

  it('runs a deferred step once the step it depends on has created its node', () => {
    const state = makeState();
    const harness = makeHarness({}, state);
    const outcome = harness.executePlan(
      {
        steps: [
          step('doc.import', { parent: CHAPTER_ONE, title: 'Lantern', body: 'The lantern.' }),
          step('meta.set', { targets: ['Lantern'], status: 'final' }),
        ],
      },
      { turnId: 'turn-defer', callId: 'plan-defer' },
    );
    if (!outcome.ok || outcome.value.status !== 'applied') throw new Error(`expected applied, got ${JSON.stringify(outcome)}`);
    expect(state.manifest.tree.find((node) => node.title === 'Lantern')?.status).toBe('final');
  });

  it('stops at a failing step and returns the ask-back, keeping the completed steps and naming their undo group', () => {
    const state = makeState();
    const failing: ToolPort = (): ReturnType<ToolPort> => err({ code: 'internal', message: 'the export service is down', correctiveHint: 'try later' } as CommandError);
    const harness = createHarness({ state, ports: { 'synopsis.fill': failing }, clock: () => 1 });
    const outcome = harness.executePlan(
      {
        steps: [
          step('meta.set', { targets: [LANDING], status: 'final' }),
          step('synopsis.fill', { docs: [LANDING] }),
          step('meta.set', { targets: [STORM], status: 'final' }),
        ],
      },
      { turnId: 'turn-fail', callId: 'plan-fail' },
    );
    if (!outcome.ok || outcome.value.status !== 'failed') throw new Error(`expected failed, got ${JSON.stringify(outcome)}`);
    expect(outcome.value.failedAt).toBe(1);
    expect(outcome.value.completed.map((entry) => entry.index)).toEqual([0]);
    expect(outcome.value.undoGroupId).toBeDefined();
    expect(outcome.value.askBack.code).toBe('verify_failed');
    // The completed step is not undone automatically: the user decides.
    expect(state.manifest.tree.find((node) => node.id === LANDING)?.status).toBe('final');
    expect(state.manifest.tree.find((node) => node.id === STORM)?.status).toBeNull();
  });

  it('ends a plan whose port wrote and then threw with the undo group named, so the whole turn can be reversed', () => {
    const state = makeState();
    const before = snapshotOf(state);
    const writeThenThrow: ToolPort = (_params, context) => {
      context.dispatch('binder.setSynopsis', { nodeId: LANDING, synopsis: 'Written before the throw.' });
      throw new Error('the model connection dropped');
    };
    const harness = createHarness({ state, ports: { 'synopsis.fill': writeThenThrow }, clock: () => 1 });
    const outcome = harness.executePlan(
      { steps: [step('meta.set', { targets: [LANDING], status: 'final' }), step('synopsis.fill', { docs: [LANDING] })] },
      { turnId: 'turn-throw', callId: 'plan-throw' },
    );
    if (!outcome.ok || outcome.value.status !== 'failed') throw new Error(`expected failed, got ${JSON.stringify(outcome)}`);
    expect(outcome.value.failedAt).toBe(1);
    expect(outcome.value.completed.map((entry) => entry.index)).toEqual([0]);
    expect(outcome.value.error.code).toBe('internal');
    expect(outcome.value.undoGroupId).toBeDefined();
    expect(state.manifest.tree.find((node) => node.id === LANDING)?.synopsis).toBe('Written before the throw.');
    expect(harness.undo.undo(outcome.value.undoGroupId ?? '').ok).toBe(true);
    expect(snapshotOf(state)).toBe(before);
  });

  it('answers a replay of the same plan from the cache, and refuses a different plan under the same callId', () => {
    const harness = makeHarness();
    const plan = { steps: [step('meta.set', { targets: [LANDING], status: 'final' })] };
    const first = harness.executePlan(plan, { turnId: 'turn-replay', callId: 'plan-replay' });
    const rows = harness.log.length;
    const replay = harness.executePlan(plan, { turnId: 'turn-replay', callId: 'plan-replay' });
    expect(harness.log.length).toBe(rows);
    expect(replay).toEqual(first);
    const other = harness.executePlan({ steps: [step('meta.set', { targets: [STORM], status: 'final' })] }, { turnId: 'turn-replay', callId: 'plan-replay' });
    expect(other.ok).toBe(false);
    if (other.ok) return;
    expect(other.error.message).toContain('already used by a different plan');
  });

  it('refuses a plan with no steps, and a plan whose turnId is empty', () => {
    const harness = makeHarness();
    expect(harness.executePlan({ steps: [] }, { turnId: 'turn-x', callId: 'p' }).ok).toBe(false);
    const noTurn = harness.executePlan({ steps: [step('meta.set', { targets: [LANDING], status: 'draft' })] }, { turnId: '', callId: 'p' });
    expect(noTurn.ok).toBe(false);
  });
});

describe('askBackFor', () => {
  it('maps a revision conflict to a conflict ask-back, with the drift between the two revisions', () => {
    const askBack = askBackFor({
      code: 'revision-conflict',
      message: 'doc was modified since plan (rev 2 → 5)',
      details: { expectedRevision: 2, actualRevision: 5 },
    });
    expect(askBack.code).toBe('conflict');
    expect(askBack.revisionDrift).toBe(3);
    expect(askBack.options.length).toBeGreaterThanOrEqual(2);
    expect(askBack.options.length).toBeLessThanOrEqual(3);
  });

  it('maps a missing name to needs_input, and a failed check to verify_failed', () => {
    expect(askBackFor({ code: 'not-found', message: 'no node' }).code).toBe('needs_input');
    expect(askBackFor({ code: 'postcondition', message: 'tree invalid' }).code).toBe('verify_failed');
  });
});
