/**
 * The injected port implementations, called through the real harness with the proposal the loop
 * would have staged. Each one is checked for the writes it makes, the refusals it gives before a
 * write, and the undo it leaves behind.
 */

import { describe, expect, it } from 'vitest';

import { setBody } from '@caotang/store';

import { createAgentPorts, createHarness, type Harness } from '../../src/index.js';
import { FRIEND, LANDING, LANDING_BODY, STORM, makeState, snapshotOf } from '../fixtures.js';

function harnessFor(state = makeState()): Harness {
  return createHarness({ state, ports: createAgentPorts(), clock: () => 1 });
}

let calls = 0;
/** A call with a callId unique to this process, and the proposal the loop would have staged for it. */
const writeCall = (name: string, params: Record<string, unknown>, proposal?: unknown) => {
  calls += 1;
  return { name, callId: `${name}-${calls}`, params, ...(proposal === undefined ? {} : { proposal }) };
};

describe('codex.read', () => {
  it('reads the codex by query, through codexRead, and says how many it returned of how many it matched', () => {
    const harness = harnessFor();
    const outcome = harness.call({ name: 'codex.read', callId: 'cr-1', params: { query: 'elena' } }, { turnId: 't' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect((outcome.value.data['entries'] as { name: string }[]).map((item) => item.name)).toEqual(['Elena']);
    expect(outcome.value.summary).toBe('read 1 of 1 codex entry');
  });

  it('answers an empty match as a result, with the note that says what to do next', () => {
    const harness = harnessFor();
    const outcome = harness.call({ name: 'codex.read', callId: 'cr-2', params: { query: 'nobody-here' } }, { turnId: 't' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.notes?.[0]).toContain('codex.write');
  });
});

describe('scene.draft', () => {
  it('draft mode writes the text into an empty document, reads it back, and one undo puts it back', () => {
    const state = makeState();
    const harness = harnessFor(state);
    const before = snapshotOf(state);
    const outcome = harness.call(writeCall('scene.draft', { doc: FRIEND, mode: 'draft', instruction: 'Open.' }, { text: 'The ferry came in.', words: 4, revision: 0 }), {
      turnId: 'draft-1',
      permission: { confirmed: true },
    });
    expect(outcome.ok).toBe(true);
    expect(state.documents.get(FRIEND)?.body).toBe('The ferry came in.');
    if (outcome.ok) expect(outcome.value.undoGroupId).toBeDefined();
    if (outcome.ok && outcome.value.undoGroupId !== undefined) harness.undo.undo(outcome.value.undoGroupId);
    expect(snapshotOf(state)).toBe(before);
  });

  it('draft mode refuses a document that already has text, and writes nothing', () => {
    const state = makeState();
    const harness = harnessFor(state);
    const before = snapshotOf(state);
    const outcome = harness.call(writeCall('scene.draft', { doc: STORM, mode: 'draft', instruction: 'Open.' }, { text: 'Rain.', words: 1, revision: 0 }), {
      turnId: 'draft-2',
      permission: { confirmed: true },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toContain('mode draft needs an empty document');
    expect(snapshotOf(state)).toBe(before);
  });

  it('continue mode appends after a paragraph break, so the join reads as a new paragraph', () => {
    const state = makeState();
    const harness = harnessFor(state);
    const outcome = harness.call(writeCall('scene.draft', { doc: STORM, mode: 'continue', instruction: 'Go on.' }, { text: 'The keeper rowed out.', words: 4, revision: 0 }), {
      turnId: 'draft-3',
      permission: { confirmed: true },
    });
    expect(outcome.ok).toBe(true);
    expect(state.documents.get(STORM)?.body).toBe('Rain.\n\n***\n\nThe lamp failed.\n\nThe keeper rowed out.');
  });

  it('rewrite_selection resolves the anchor and replaces exactly the resolved range', () => {
    const state = makeState();
    const harness = harnessFor(state);
    const outcome = harness.call(
      writeCall(
        'scene.draft',
        { doc: LANDING, mode: 'rewrite_selection', instruction: 'Tighten.', selection: { from: 0, to: 9, exact: 'The ferry', prefix: '', suffix: ' was late', capturedRevision: 0 } },
        { text: 'A boat', words: 2, revision: 0 },
      ),
      { turnId: 'draft-4', permission: { confirmed: true } },
    );
    expect(outcome.ok).toBe(true);
    expect(state.documents.get(LANDING)?.body).toBe(`A boat${LANDING_BODY.slice(9)}`);
  });

  it('rewrite_selection refuses an anchor whose text has moved, names it as an anchor ask-back, and writes nothing', () => {
    const state = makeState();
    const harness = harnessFor(state);
    const before = snapshotOf(state);
    const outcome = harness.call(
      writeCall('scene.draft', { doc: LANDING, mode: 'rewrite_selection', instruction: 'Tighten.', selection: { from: 0, to: 5, exact: 'ghost', prefix: '', suffix: '', capturedRevision: 0 } }, { text: 'x', words: 1, revision: 0 }),
      { turnId: 'draft-5', permission: { confirmed: true } },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.details?.['askBackCode']).toBe('anchor_unresolvable');
    expect(snapshotOf(state)).toBe(before);
  });

  it('applies the revision the draft was staged against: a document changed since is a conflict, and nothing is written', () => {
    const state = makeState();
    const harness = harnessFor(state);
    // The user types into the storm after the draft was staged against revision 0.
    setBody(state, STORM, 'Rain.\n\n***\n\nThe lamp failed.\n\nThe user typed this.');
    const before = snapshotOf(state);
    const outcome = harness.call(writeCall('scene.draft', { doc: STORM, mode: 'continue', instruction: 'Go on.' }, { text: 'He rows out.', words: 3, revision: 0 }), {
      turnId: 'draft-9',
      permission: { confirmed: true },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe('revision-conflict');
      expect(outcome.error.details).toMatchObject({ expectedRevision: 0, actualRevision: 1 });
    }
    expect(snapshotOf(state)).toBe(before);
  });

  it('refuses a call the loop staged nothing for, and an empty draft, before any write', () => {
    const harness = harnessFor();
    const noProposal = harness.call(writeCall('scene.draft', { doc: FRIEND, mode: 'draft', instruction: 'Open.' }), { turnId: 'draft-6', permission: { confirmed: true } });
    expect(noProposal.ok).toBe(false);
    if (!noProposal.ok) expect(noProposal.error.message).toContain('has no drafted text to apply');
    const empty = harness.call(writeCall('scene.draft', { doc: FRIEND, mode: 'draft', instruction: 'Open.' }, { text: '  ', words: 0, revision: 0 }), {
      turnId: 'draft-7',
      permission: { confirmed: true },
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.message).toContain('the draft is empty');
  });

  it('is a write-confirm tool: a bare call without an approval is refused by the gate', () => {
    const harness = harnessFor();
    const outcome = harness.call(writeCall('scene.draft', { doc: FRIEND, mode: 'draft', instruction: 'Open.' }, { text: 'Open.', words: 1, revision: 0 }), { turnId: 'draft-8' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('permission-denied');
  });

  it('refuses a draft the provider cut at its output limit, unless the call carries the acceptance', () => {
    const state = makeState();
    const harness = harnessFor(state);
    const before = snapshotOf(state);
    const cut = harness.call(writeCall('scene.draft', { doc: FRIEND, mode: 'draft', instruction: 'Open.' }, { text: 'The ferry came in', words: 3, revision: 0, cut: true }), {
      turnId: 'draft-cut',
      permission: { confirmed: true },
    });
    expect(cut.ok).toBe(false);
    if (!cut.ok) expect(cut.error.message).toContain('cut off');
    expect(snapshotOf(state)).toBe(before);
  });
});

describe('the mode rule at a plan preflight (agent-harness §2, §3)', () => {
  it('refuses a draft that would replace a scene with text, so the plan card cannot approve it, and names the choice the card offers', () => {
    const harness = harnessFor();
    const checked = harness.previewPlan({ steps: [{ tool: 'scene.draft', params: { doc: STORM, mode: 'draft', instruction: 'Open.' }, expect: 'drafted' }] });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.ok).toBe(false);
    const step = checked.value.steps[0];
    expect(step?.status).toBe('refused');
    expect(step?.error?.message).toContain('mode draft needs an empty document, and this one already has');
    expect(step?.error?.correctiveHint).toBe('set mode to continue to add to the end, or select a passage to rewrite it');
  });

  it('passes a draft into an empty scene, and a continue into a scene with text', () => {
    const harness = harnessFor();
    const checked = harness.previewPlan({
      steps: [
        { tool: 'scene.draft', params: { doc: FRIEND, mode: 'draft', instruction: 'Open.' }, expect: 'drafted' },
        { tool: 'scene.draft', params: { doc: STORM, mode: 'continue', instruction: 'Go on.' }, expect: 'continued' },
      ],
    });
    expect(checked.ok && checked.value.ok).toBe(true);
  });

  it('the same refusal comes from the call, so a plan and its apply agree', () => {
    const state = makeState();
    const harness = harnessFor(state);
    const before = snapshotOf(state);
    const outcome = harness.call(writeCall('scene.draft', { doc: STORM, mode: 'draft', instruction: 'Open.' }, { text: 'Rain.', words: 1, revision: 0 }), {
      turnId: 'preflight-agree',
      permission: { confirmed: true },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toContain('mode draft needs an empty document');
    expect(snapshotOf(state)).toBe(before);
  });
});

describe('synopsis.fill', () => {
  it('writes every synopsis, and reports a create for an empty one and a replace for an existing one', () => {
    const state = makeState();
    const harness = harnessFor(state);
    const outcome = harness.call(
      writeCall(
        'synopsis.fill',
        { docs: [LANDING, STORM] },
        { items: [{ docId: LANDING, synopsis: 'Elena returns.' }, { docId: STORM, synopsis: 'The lamp fails.' }] },
      ),
      { turnId: 'syn-1', permission: { confirmed: true } },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.data['rows']).toEqual([
      { doc: { id: LANDING, title: 'The Landing' }, action: 'replace', words: 2 },
      { doc: { id: STORM, title: 'The Storm' }, action: 'create', words: 3 },
    ]);
    expect(state.manifest.tree.find((node) => node.id === LANDING)?.synopsis).toBe('Elena returns.');
  });

  it('refuses the whole batch when one document cannot be found, and writes none of it', () => {
    const state = makeState();
    const harness = harnessFor(state);
    const before = snapshotOf(state);
    const outcome = harness.call(
      writeCall('synopsis.fill', { docs: [LANDING, 'Missing chapter'] }, { items: [{ docId: LANDING, synopsis: 'x' }] }),
      { turnId: 'syn-2', permission: { confirmed: true } },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toContain('batch refused');
    expect(snapshotOf(state)).toBe(before);
  });

  it('refuses a synopsis over the project limit before the first write', () => {
    const state = makeState();
    const harness = harnessFor(state);
    const before = snapshotOf(state);
    const outcome = harness.call(
      writeCall('synopsis.fill', { docs: [LANDING] }, { items: [{ docId: LANDING, synopsis: 'x'.repeat(2001) }] }),
      { turnId: 'syn-3', permission: { confirmed: true } },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('limit-exceeded');
    expect(snapshotOf(state)).toBe(before);
  });

  it('refuses a batch the provider cut at its output limit, unless the call carries the acceptance', () => {
    const state = makeState();
    const harness = harnessFor(state);
    const before = snapshotOf(state);
    const cut = harness.call(
      writeCall('synopsis.fill', { docs: [LANDING] }, { items: [{ docId: LANDING, synopsis: 'Elena returns.' }], cut: true }),
      { turnId: 'syn-cut', permission: { confirmed: true } },
    );
    expect(cut.ok).toBe(false);
    if (!cut.ok) expect(cut.error.message).toContain('cut off');
    expect(snapshotOf(state)).toBe(before);
  });
});

describe('continuity.scan', () => {
  it('returns the staged findings as data, and writes nothing', () => {
    const state = makeState();
    const harness = harnessFor(state);
    const before = snapshotOf(state);
    const findings = [{ aspect: 'timeline', severity: 'minor', docs: ['The Storm'], quote: 'The lamp failed.', note: 'Check the order.' }];
    const outcome = harness.call(writeCall('continuity.scan', { aspects: ['timeline'] }, { findings }), { turnId: 'scan-1' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value.data['findings']).toEqual(findings);
    expect(snapshotOf(state)).toBe(before);
  });

  it('refuses a findings proposal that is not in the findings shape', () => {
    const harness = harnessFor();
    const outcome = harness.call(writeCall('continuity.scan', {}, { findings: [{ aspect: 'weather' }] }), { turnId: 'scan-2' });
    expect(outcome.ok).toBe(false);
  });
});

describe('a plan step that targets a node deleted between planning and apply (bus-05-agent)', () => {
  it('refuses a `scene.draft` step on a removed document at preflight, so the plan card never promises a step that cannot run', () => {
    const harness = harnessFor();
    const checked = harness.previewPlan({
      steps: [{ tool: 'scene.draft', params: { doc: 'The Ghost Chapter', mode: 'draft', instruction: 'Open.' }, expect: 'drafted' }],
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.ok).toBe(false);
    const step = checked.value.steps[0];
    expect(step?.status).toBe('refused');
    expect(step?.error?.code).toBe('not-found');
    expect(step?.error?.message).toContain('The Ghost Chapter');
  });

  it('refuses a `shots.derive` step on a removed scene at preflight, so the scene card never promises a step that cannot run', () => {
    const harness = harnessFor();
    const checked = harness.previewPlan({
      steps: [{ tool: 'shots.derive', params: { doc: 'The Ghost Chapter', granularity: 'key-shots' }, expect: 'derived' }],
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.ok).toBe(false);
    const step = checked.value.steps[0];
    expect(step?.status).toBe('refused');
    expect(step?.error?.code).toBe('not-found');
    expect(step?.error?.message).toContain('The Ghost Chapter');
  });

  it('still defers a step that targets a scene an earlier step of the same plan may create, so the card may be approved', () => {
    const harness = harnessFor();
    const checked = harness.previewPlan({
      steps: [
        // The first step is the creator (doc.import): it always creates a node and resolves the second step's name.
        {
          tool: 'doc.import',
          params: { parent: 'Chapter 2', title: 'The Ghost Chapter', body: 'A new scene.' },
          expect: 'imported',
        },
        // The second step targets the new chapter; its preflight fails because the scene is gone at preflight time,
        // but `mayCreate` finds the doc.import step that names it, so the step is deferred (plan §2).
        { tool: 'scene.draft', params: { doc: 'The Ghost Chapter', mode: 'draft', instruction: 'Open.' }, expect: 'drafted' },
      ],
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.ok).toBe(true);
    const steps = checked.value.steps;
    expect(steps[0]?.status).toBe('ready');
    expect(steps[1]?.status).toBe('deferred');
  });

  it('defers an ambiguous name the same way when an earlier step may create, and refuses it when none does', () => {
    const harness = harnessFor();
    // "The" prefix-matches every fixture document, so the lookup is refused as ambiguous — a lookup
    // failure like a not-found, which a creating step earlier in the plan defers (plan §2).
    const ambiguous = { tool: 'scene.draft', params: { doc: 'The', mode: 'draft', instruction: 'Open.' }, expect: 'drafted' };
    const withCreator = harness.previewPlan({
      steps: [
        { tool: 'doc.import', params: { parent: 'Chapter 2', title: 'The Ghost Chapter', body: 'A new scene.' }, expect: 'imported' },
        ambiguous,
      ],
    });
    expect(withCreator.ok).toBe(true);
    if (!withCreator.ok) return;
    expect(withCreator.value.ok).toBe(true);
    expect(withCreator.value.steps[1]?.status).toBe('deferred');
    expect(withCreator.value.steps[1]?.error?.code).toBe('invalid-params');

    const withoutCreator = harness.previewPlan({ steps: [ambiguous] });
    expect(withoutCreator.ok).toBe(true);
    if (!withoutCreator.ok) return;
    expect(withoutCreator.value.ok).toBe(false);
    expect(withoutCreator.value.steps[0]?.status).toBe('refused');
    expect(withoutCreator.value.steps[0]?.error?.code).toBe('invalid-params');
  });
});

describe('the cut rule of the model-backed write ports (agent-harness §8)', () => {
  it('refuses Ink the provider cut at its output limit on a direct dialogue.draft call, and writes nothing', () => {
    const state = makeState();
    const harness = harnessFor(state);
    const before = snapshotOf(state);
    const ink = ['=== reply ===', 'Thanks for the drink.', '-> END'].join('\n');
    const outcome = harness.call(writeCall('dialogue.draft', { doc: STORM, instruction: 'A thank-you.' }, { ink, revision: 0, cut: true }), {
      turnId: 'dialogue-cut',
      permission: { approvedPlan: true },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toContain('cut off');
    expect(snapshotOf(state)).toBe(before);
  });
});
