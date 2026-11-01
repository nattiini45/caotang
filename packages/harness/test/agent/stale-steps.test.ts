/**
 * Which steps an edit marks stale (agent-harness §2, §8). Only a model-backed step has a draft that an edit can make
 * out of date, so only its params mark it. A step with no draft is checked again by its preflight when the card is shown,
 * so an edit to it must leave its flag clear, or the card could never be approved. The card's approvability is checked
 * here through the same planCardOf the loop uses.
 */

import { describe, expect, it } from 'vitest';

import { applyEdit, MODEL_BACKED_TOOLS, planCardOf, type EditableSteps } from '../../src/index.js';
import type { PlanStep } from '../../src/index.js';

const steps: PlanStep[] = [
  { tool: 'meta.set', params: { targets: ['n_BRAVE00001'], label: 'act-2' }, expect: 'The Friend is labelled act-2' },
  { tool: 'meta.set', params: { targets: ['n_TEMPEST001'], keywords_add: ['storm'] }, expect: 'The Storm is tagged' },
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

/** A card over the state, with a clean preflight, as the loop shows it once every step checks. */
function cardOver(state: EditableSteps) {
  return planCardOf({
    id: 'turn-1:card',
    turnId: 'turn-1',
    kind: 'plan',
    revision: 1,
    previewRevision: 1,
    from: 0,
    state,
    preflight: { ok: true, steps: state.steps.map((step, index) => ({ index, tool: step.tool, expect: step.expect, status: 'ready' as const })) },
    previews: state.steps.map(() => undefined),
    risks: state.steps.map((step) => (step.tool === 'scene.draft' ? 'write-confirm' : 'write-auto')),
  });
}

describe('stale flags after an edit (agent-harness §2, §8)', () => {
  it('names the model-backed tools, which are the only ones whose drafts an edit can make stale', () => {
    // coherence.review and pictures.transcribe join the set: their plans are staged before their cards, so an edit re-plans them.
    // dialogue.draft joins too: its Ink is drafted before its card. timeline.edit is the last: its ops and the values they are checked against are staged before its card. Six drafted tools, two staged plans, the Ink and the timeline batch, ten in all.
    expect([...MODEL_BACKED_TOOLS].sort()).toEqual([
      'coherence.review',
      'continuity.scan',
      'dialogue.draft',
      'pictures.transcribe',
      'prompt.draft',
      'prompt.variant',
      'scene.draft',
      'shots.derive',
      'synopsis.fill',
      'timeline.edit',
    ]);
  });

  it('marks a timeline.edit step stale when its params are edited, because the values it was staged against belong to the old ones', () => {
    const state = {
      steps: [{ tool: 'timeline.edit', params: { ops: [{ op: 'meta', nodeId: 'Arrival', patch: { dayOffset: 3 } }] }, expect: 'a day' }],
      origins: [0],
      proposals: [{ kind: 'timeline.edit', key: '{}', ops: [] }],
      stale: [false],
      superseded: [],
      completed: [],
    };
    const edited = applyEdit(state, { op: 'set', index: 0, path: ['params', 'ops', '0', 'patch', 'dayOffset'], value: 4 });
    if (!edited.ok) throw new Error(edited.error);
    expect(edited.value.stale).toEqual([true]);
  });

  it('leaves the flag clear on a param edit to a step with no draft, so the card stays approvable', () => {
    const edited = applyEdit(editable(), { op: 'set', index: 0, path: ['params', 'label'], value: 'act-1' });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.stale).toEqual([false, false, false]);
    expect(cardOver(edited.value).approvable).toBe(true);
  });

  it('leaves the flag clear on an expectation edit to any step, since no draft reads the expectation', () => {
    const edited = applyEdit(editable(), { op: 'set', index: 0, path: ['expect'], value: 'The Friend is labelled, as asked' });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.stale).toEqual([false, false, false]);
    const drafted = applyEdit(editable(), { op: 'set', index: 2, path: ['expect'], value: 'the storm goes on' });
    expect(drafted.ok && drafted.value.stale[2]).toBe(false);
  });

  it('marks the flag on a param edit to a model-backed step, which the loop drafts again before the card is shown', () => {
    const edited = applyEdit(editable(), { op: 'set', index: 2, path: ['params', 'instruction'], value: 'The lamp fails.' });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.stale).toEqual([false, false, true]);
    expect(cardOver(edited.value).approvable).toBe(false);
  });

  it('drops the proposal a step staged for its old tool when the tool changes, and marks the step only if the new tool is drafted', () => {
    const withDraft = editable({ proposals: [undefined, undefined, { text: 'Rain falls.', words: 2 }] });
    const toMeta = applyEdit(withDraft, { op: 'set', index: 2, path: ['tool'], value: 'meta.set' });
    expect(toMeta.ok).toBe(true);
    if (!toMeta.ok) return;
    expect(toMeta.value.proposals[2]).toBeUndefined();
    expect(toMeta.value.stale[2]).toBe(false);
    const toDraft = applyEdit(editable(), { op: 'set', index: 0, path: ['tool'], value: 'synopsis.fill' });
    expect(toDraft.ok && toDraft.value.stale[0]).toBe(true);
  });
});
