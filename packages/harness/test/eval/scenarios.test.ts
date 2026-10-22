/**
 * The v0.1 scenario suite — agent-harness.md §9's categories, each scenario a complete turn against
 * deterministic mock scripts. Every scenario states its response shape, its cards and its trace in
 * the matcher the case calls for (strict for a single op, unordered where a plan's steps commute),
 * the project it leaves, and the tokens it may spend.
 */

import { describe, expect, it } from 'vitest';

import { setBody, type ProjectState } from '@caotang/store';

import { evaluate, type Scenario } from '../../src/agent/eval.js';
import { CHAPTER_ONE, FRIEND, LANDING, LANDING_BODY, STORM, makeState } from '../fixtures.js';
import { mockGateway } from '../agent/gateway.js';
import { answer, prose, steps, transcript } from '../agent/scripts.js';
import type { MockScript } from '@caotang/gateway/mock';

const quote = (ref: string): string => `“${ref}”`;
const storm = (state: ReturnType<typeof makeState>) => state.documents.get(STORM)?.body ?? '';
const scriptsFor = (...scripts: MockScript[]) => () => mockGateway(scripts);
/** The Landing's project for the anchor scenario, so its decision can edit the document the card is about. */
let landingState: ProjectState | undefined;

const scenarios: Scenario[] = [
  {
    name: 'single op: a label change applies at once, behind no card',
    category: 'single-op',
    intent: 'Move The Friend into Act 2.',
    project: makeState,
    gateway: scriptsFor(
      transcript('Move The Friend into Act 2.', [
        steps({ tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled act-2' }),
      ]),
    ),
    expect: {
      status: 'applied',
      cards: { matcher: 'strict', items: [{ kind: 'auto', tools: ['meta.set'], decision: 'auto' }] },
      trace: { matcher: 'strict', calls: [{ tool: 'meta.set', outcome: 'ok', params: { label: 'act-2' } }] },
      tasks: [
        { content: 'Plan', state: 'done' },
        { content: `Update ${quote(FRIEND)}`, state: 'done' },
      ],
      // The planner lists every wired tool's description and schema on each call, so the ceiling tracks the wired set:
      // tool.search and shots.annotate (about 550 tokens), dialogue.table (about 200), the three drafting tools
      // shots.derive, prompt.draft and prompt.variant (about 810), dialogue.draft wired to the agent ports (about 350),
      // codex.write's `visualRefs` (video-prompt-pack §3, about 70), and export.compile's description with its recipeName
      // parameter (a saved recipe, with the selection optional when one names the nodes) and the prompt pack's template
      // text. Measured at 7952 with all of them, so the ceiling is 8000.
      maxTokens: 8000,
      state: (state) => (state.manifest.tree.find((node) => node.id === FRIEND)?.label === 'act-2' ? [] : ['The Friend is not labelled act-2']),
    },
  },
  {
    name: 'single op: a read answers the question and changes nothing',
    category: 'single-op',
    intent: 'What is in Chapter 1?',
    project: makeState,
    gateway: scriptsFor(
      transcript('What is in Chapter 1?', [
        steps({ tool: 'binder.read_tree', params: { root: CHAPTER_ONE }, expect: 'Chapter 1 is read' }),
        answer('Chapter 1 holds two scenes.'),
      ]),
    ),
    expect: {
      status: 'replied',
      summaryIncludes: ['Chapter 1 holds two scenes'],
      cards: { matcher: 'strict', items: [] },
      trace: { matcher: 'strict', calls: [{ tool: 'binder.read_tree', outcome: 'ok', params: { root: CHAPTER_ONE } }] },
      maxModelCalls: 2,
    },
  },
  {
    name: 'single op: a bad label is refused, the model corrects it, and the corrected call runs',
    category: 'single-op',
    intent: 'Label The Friend as final.',
    project: makeState,
    gateway: scriptsFor(
      transcript('Label The Friend as final.', [
        steps({ tool: 'meta.set', params: { targets: [FRIEND], label: 'final' }, expect: 'The Friend is labelled final' }),
        steps({ tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled act-2' }),
      ]),
    ),
    expect: {
      status: 'applied',
      cards: { matcher: 'strict', items: [{ kind: 'auto', tools: ['meta.set'], decision: 'auto' }] },
      trace: { matcher: 'strict', calls: [{ tool: 'meta.set', outcome: 'ok', params: { label: 'act-2' } }] },
    },
  },
  {
    name: 'multi-step: a read, then a plan that batches a tag and a synopsis, applies once',
    category: 'multi-step',
    intent: 'Tag The Storm and give it a synopsis.',
    project: makeState,
    gateway: scriptsFor(
      transcript('Tag The Storm and give it a synopsis.', [
        steps({ tool: 'notes.read', params: { doc: STORM }, expect: 'the notes are read' }),
        steps(
          { tool: 'meta.set', params: { targets: [STORM], keywords_add: ['storm'] }, expect: 'The Storm is tagged storm' },
          { tool: 'synopsis.fill', params: { docs: [STORM], source: 'text', max_words: 20 }, expect: 'The Storm has a synopsis' },
        ),
      ]),
      prose('Document "The Storm":', 'A storm takes the lamp, and the keeper must choose.'),
    ),
    expect: {
      status: 'applied',
      cards: { matcher: 'strict', items: [{ kind: 'plan', tools: ['meta.set', 'synopsis.fill'], decision: 'approved' }] },
      trace: {
        matcher: 'strict',
        calls: [
          { tool: 'notes.read', outcome: 'ok' },
          { tool: 'meta.set', outcome: 'ok' },
          { tool: 'synopsis.fill', outcome: 'ok' },
        ],
      },
      tasks: [
        { content: 'Plan', state: 'done' },
        { content: 'Read the project', state: 'done' },
        { content: `Update ${quote(STORM)}`, state: 'done' },
        { content: `Fill the synopsis of ${quote(STORM)}`, state: 'done' },
      ],
      // Three model calls (a read's planner, a plan's planner, a synopsis), each carrying the tool schemas. Each wired tool
      // adds its description and schema to both planner calls: tool.search and shots.annotate, dialogue.table, the three
      // drafting tools (about 810 tokens a planner call), the longer export.compile, project.overview and coherence
      // descriptions, dialogue.draft (about 290 tokens a planner call), export.compile's recipeName parameter, and
      // codex.write's `visualRefs`. Measured at 16223 with all of them, so the ceiling is 16300.
      maxTokens: 16300,
      maxModelCalls: 3,
      state: (state) => {
        const node = state.manifest.tree.find((candidate) => candidate.id === STORM);
        const failures: string[] = [];
        if (!node?.keywords.includes('storm')) failures.push('The Storm is not tagged storm');
        if (node?.synopsis !== 'A storm takes the lamp, and the keeper must choose.') failures.push(`The Storm synopsis is ${JSON.stringify(node?.synopsis)}`);
        return failures;
      },
    },
  },
  {
    name: 'plan edit: a dropped step is removed, the card is shown again, and only the rest runs',
    category: 'plan-edit',
    intent: 'Tag The Storm and move The Landing to Act 2.',
    project: makeState,
    gateway: scriptsFor(
      transcript('Tag The Storm and move The Landing to Act 2.', [
        steps(
          { tool: 'meta.set', params: { targets: [STORM], keywords_add: ['storm'] }, expect: 'The Storm is tagged' },
          { tool: 'meta.set', params: { targets: [LANDING], label: 'act-2' }, expect: 'The Landing is labelled act-2' },
        ),
      ]),
    ),
    decisions: [{ action: 'edit', edits: [{ op: 'drop', index: 1 }] }, { action: 'approve' }],
    expect: {
      status: 'applied',
      cards: { matcher: 'strict', items: [{ kind: 'plan', tools: ['meta.set'], decision: 'approved' }] },
      trace: { matcher: 'strict', calls: [{ tool: 'meta.set', outcome: 'ok', params: { targets: [STORM] } }] },
      // The dropped step stays on the list, skipped, after the step that ran.
      tasks: [
        { content: 'Plan', state: 'done' },
        { content: `Update ${quote(STORM)}`, state: 'done' },
        { content: `Update ${quote(LANDING)}`, state: 'skipped' },
      ],
      state: (state) => {
        const landing = state.manifest.tree.find((node) => node.id === LANDING);
        return landing?.label === 'act-1' ? [] : ['The Landing was labelled although its step was dropped'];
      },
    },
  },
  {
    name: 'plan edit: a reordered plan runs in the order the user set',
    category: 'plan-edit',
    intent: 'Label The Friend, then tag The Storm.',
    project: makeState,
    gateway: scriptsFor(
      transcript('Label The Friend, then tag The Storm.', [
        steps(
          { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled' },
          { tool: 'meta.set', params: { targets: [STORM], keywords_add: ['storm'] }, expect: 'The Storm is tagged' },
        ),
      ]),
    ),
    decisions: [{ action: 'edit', edits: [{ op: 'reorder', from: 0, to: 1 }] }, { action: 'approve' }],
    expect: {
      status: 'applied',
      cards: { matcher: 'strict', items: [{ kind: 'plan', tools: ['meta.set', 'meta.set'], decision: 'approved' }] },
      trace: {
        matcher: 'strict',
        calls: [
          { tool: 'meta.set', outcome: 'ok', params: { targets: [STORM] } },
          { tool: 'meta.set', outcome: 'ok', params: { targets: [FRIEND] } },
        ],
      },
      // The list follows the order the writer set, not the order the model proposed.
      tasks: [
        { content: 'Plan', state: 'done' },
        { content: `Update ${quote(STORM)}`, state: 'done' },
        { content: `Update ${quote(FRIEND)}`, state: 'done' },
      ],
    },
  },
  {
    name: 'verify recovery: a draft refused before its card is adjusted by the model and approved again',
    category: 'verify-recovery',
    intent: 'Draft the storm again.',
    project: makeState,
    gateway: scriptsFor(
      transcript('Draft the storm again.', [
        // The storm already has a body, so mode draft is refused before its draft is asked for and before any card is shown:
        // the planner is told why and asked again.
        steps({ tool: 'scene.draft', params: { doc: 'The Storm', instruction: 'The lamp fails and the keeper rows out to the wreck.', mode: 'draft' }, expect: 'The Storm is drafted' }),
        steps({ tool: 'scene.draft', params: { doc: 'The Storm', instruction: 'The lamp fails and the keeper rows out to the wreck.', mode: 'continue' }, expect: 'The Storm continues' }),
      ]),
      prose('Brief: The lamp fails', 'The keeper rows out to the wreck.'),
    ),
    expect: {
      status: 'applied',
      cards: {
        matcher: 'strict',
        items: [{ kind: 'confirm', tools: ['scene.draft'], decision: 'approved' }],
      },
      trace: {
        matcher: 'strict',
        calls: [{ tool: 'scene.draft', outcome: 'ok', params: { mode: 'continue' } }],
      },
      state: (state) => (storm(state).endsWith('The keeper rows out to the wreck.') ? [] : [`The Storm ends with ${JSON.stringify(storm(state).slice(-40))}`]),
    },
  },
  {
    name: 'verify recovery: a draft the planner keeps sending is refused before any card, stops at the call bound, and writes nothing',
    category: 'verify-recovery',
    intent: 'Draft the storm the same way again.',
    project: makeState,
    gateway: scriptsFor(
      transcript('Draft the storm the same way again.', [
        steps({ tool: 'scene.draft', params: { doc: 'The Storm', instruction: 'The lamp fails.', mode: 'draft' }, expect: 'The Storm is drafted' }),
      ]),
      prose('Brief: The lamp fails.', 'The keeper rows out.'),
    ),
    expect: {
      status: 'failed',
      askBack: 'needs_input',
      // Each refused draft goes back to the planner before any card is shown, so no card waits and no call runs. The planner's
      // calls are bounded (agent-harness §7), so the turn stops there, with the structured ask-back.
      cards: { matcher: 'strict', items: [] },
      trace: { matcher: 'strict', calls: [] },
      state: (state) => (storm(state) === 'Rain.\n\n***\n\nThe lamp failed.' ? [] : ['The Storm changed although every attempt was refused']),
    },
  },
  {
    // The captured text "as" appears twice in the body, and the document was edited after the selection was captured.
    name: 'anchor: a selection that moved since it was captured is reported with its candidates, not guessed',
    category: 'anchor',
    intent: 'Tighten the first line of The Landing.',
    project: () => (landingState = makeState()),
    gateway: scriptsFor(
      transcript('Tighten the first line of The Landing.', [
        steps({
          tool: 'scene.draft',
          params: {
            doc: 'The Landing',
            instruction: 'Tighten it.',
            mode: 'rewrite_selection',
            selection: { from: 0, to: 2, exact: 'as', prefix: '', suffix: '', capturedRevision: 0 },
          },
          expect: 'the first line is tightened',
        }),
      ]),
      prose('Brief: Tighten it.', 'Tighter.'),
    ),
    // The user edits the document while the card is open, so the apply-time revision is one past the captured one.
    decisions: [
      () => {
        setBody(landingState as ProjectState, LANDING, `${LANDING_BODY} Moved.`);
        return { action: 'approve' };
      },
    ],
    expect: {
      status: 'failed',
      askBack: 'anchor_unresolvable',
      candidates: 2,
      revisionDrift: 1,
      cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['scene.draft'], decision: 'approved' }] },
      trace: { matcher: 'strict', calls: [{ tool: 'scene.draft', outcome: 'refused' }] },
      state: (state) => (state.documents.get(LANDING)?.body === `${LANDING_BODY} Moved.` ? [] : ['The Landing changed although its anchor did not resolve']),
    },
  },
  {
    name: 'undo: a multi-step turn is restored, and the project is byte-equal to what it was before the turn',
    category: 'undo',
    intent: 'Label The Friend and give The Storm a synopsis.',
    project: makeState,
    gateway: scriptsFor(
      transcript('Label The Friend and give The Storm a synopsis.', [
        steps(
          { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled act-2' },
          { tool: 'synopsis.fill', params: { docs: [STORM], source: 'text', max_words: 20 }, expect: 'The Storm has a synopsis' },
        ),
      ]),
      prose('Document "The Storm":', 'A storm takes the lamp.'),
    ),
    expect: {
      status: 'applied',
      restores: true,
      trace: {
        matcher: 'strict',
        calls: [
          { tool: 'meta.set', outcome: 'ok' },
          { tool: 'synopsis.fill', outcome: 'ok' },
        ],
      },
      state: (state) => ((state.manifest.tree.find((node) => node.id === FRIEND)?.label ?? null) === null ? [] : ['The Friend kept its label after the restore']),
    },
  },
  {
    name: 'permission: a plan card cancelled at the card, as a batch, writes nothing',
    category: 'permission',
    intent: 'Label The Friend and The Landing.',
    project: makeState,
    gateway: scriptsFor(
      transcript('Label The Friend and The Landing.', [
        steps(
          { tool: 'meta.set', params: { targets: [FRIEND], label: 'act-2' }, expect: 'The Friend is labelled act-2' },
          { tool: 'meta.set', params: { targets: [LANDING], label: 'act-2' }, expect: 'The Landing is labelled act-2' },
        ),
      ]),
    ),
    decisions: [{ action: 'cancel' }],
    expect: {
      status: 'cancelled',
      cards: { matcher: 'strict', items: [{ kind: 'plan', tools: ['meta.set', 'meta.set'], decision: 'cancelled' }] },
      trace: { matcher: 'strict', calls: [] },
      state: (state) => {
        const failures: string[] = [];
        if ((state.manifest.tree.find((node) => node.id === FRIEND)?.label ?? null) !== null) failures.push('The Friend was labelled after the batch was cancelled');
        if (state.manifest.tree.find((node) => node.id === LANDING)?.label !== 'act-1') failures.push('The Landing was labelled after the batch was cancelled');
        return failures;
      },
    },
  },
  {
    name: 'plan edit: a step that has applied cannot be reordered after a ladder retry, and no step runs twice',
    category: 'plan-edit',
    intent: 'Note the wreck, then draft the friend twice.',
    project: makeState,
    gateway: scriptsFor(
      transcript('Note the wreck, then draft the friend twice.', [
        steps(
          { tool: 'notes.append', params: { doc: FRIEND, text: 'Note one.' }, expect: 'a note is appended' },
          { tool: 'scene.draft', params: { doc: FRIEND, instruction: 'The lamp fails.', mode: 'draft' }, expect: 'The Friend is drafted' },
          // The Friend is empty when the plan is checked, so this step passes. The step before fills it, and the apply refuses this one.
          { tool: 'scene.draft', params: { doc: FRIEND, instruction: 'The lamp fails.', mode: 'draft' }, expect: 'The Friend is drafted again' },
        ),
        // The adjusted step the model sends after the refusal.
        steps({ tool: 'scene.draft', params: { doc: FRIEND, instruction: 'The lamp fails.', mode: 'continue' }, expect: 'The Friend continues' }),
      ]),
      prose('Brief: The lamp fails.', 'The keeper rows out.'),
    ),
    // Card 2 asks to move the appended note after the draft. The note has run, so the edit is refused and card 3 is the same card.
    decisions: [{ action: 'approve' }, { action: 'edit', edits: [{ op: 'reorder', from: 0, to: 1 }] }, { action: 'approve' }],
    expect: {
      status: 'applied',
      cards: {
        matcher: 'strict',
        items: [
          { kind: 'plan', tools: ['notes.append', 'scene.draft', 'scene.draft'], decision: 'approved' },
          { kind: 'plan', tools: ['scene.draft'], decision: 'approved' },
        ],
      },
      trace: {
        matcher: 'strict',
        calls: [
          { tool: 'notes.append', outcome: 'ok', params: { text: 'Note one.' } },
          { tool: 'scene.draft', outcome: 'ok' },
          { tool: 'scene.draft', outcome: 'refused' },
          { tool: 'scene.draft', outcome: 'ok', params: { mode: 'continue' } },
        ],
      },
      state: (state) => {
        const failures: string[] = [];
        const notes = state.manifest.tree.find((node) => node.id === FRIEND)?.notes ?? '';
        if (notes.split('Note one.').length - 1 !== 1) failures.push(`the note was appended ${notes.split('Note one.').length - 1} times, not once`);
        const body = state.documents.get(FRIEND)?.body ?? '';
        if (!body.endsWith('The keeper rows out.')) failures.push(`The Friend ends with ${JSON.stringify(body.slice(-40))}`);
        return failures;
      },
    },
  },
  {
    name: 'plan edit: a pending step can be dropped after a ladder retry, and it is never run',
    category: 'plan-edit',
    intent: 'Note the wreck, draft the friend twice, then label the landing.',
    project: makeState,
    gateway: scriptsFor(
      transcript('Note the wreck, draft the friend twice, then label the landing.', [
        steps(
          { tool: 'notes.append', params: { doc: FRIEND, text: 'Note one.' }, expect: 'a note is appended' },
          { tool: 'scene.draft', params: { doc: FRIEND, instruction: 'The lamp fails.', mode: 'draft' }, expect: 'The Friend is drafted' },
          { tool: 'scene.draft', params: { doc: FRIEND, instruction: 'The lamp fails.', mode: 'draft' }, expect: 'The Friend is drafted again' },
          { tool: 'meta.set', params: { targets: [LANDING], label: 'act-2' }, expect: 'The Landing is labelled act-2' },
        ),
        steps({ tool: 'scene.draft', params: { doc: FRIEND, instruction: 'The lamp fails.', mode: 'continue' }, expect: 'The Friend continues' }),
      ]),
      prose('Brief: The lamp fails.', 'The keeper rows out.'),
    ),
    // Card 2 drops the labelling, which has not run. Card 3 shows the two steps that are left, and they run once.
    decisions: [{ action: 'approve' }, { action: 'edit', edits: [{ op: 'drop', index: 3 }] }, { action: 'approve' }],
    expect: {
      status: 'applied',
      trace: {
        matcher: 'strict',
        calls: [
          { tool: 'notes.append', outcome: 'ok' },
          { tool: 'scene.draft', outcome: 'ok' },
          { tool: 'scene.draft', outcome: 'refused' },
          { tool: 'meta.set', outcome: 'not-run' },
          { tool: 'scene.draft', outcome: 'ok', params: { mode: 'continue' } },
        ],
      },
      state: (state) => {
        const failures: string[] = [];
        if ((state.manifest.tree.find((node) => node.id === LANDING)?.label ?? null) === 'act-2') failures.push('The Landing was labelled although its step was dropped');
        const body = state.documents.get(FRIEND)?.body ?? '';
        if (!body.endsWith('The keeper rows out.')) failures.push(`The Friend ends with ${JSON.stringify(body.slice(-40))}`);
        return failures;
      },
    },
  },
  {
    name: 'plan edit: a step that has not run can be moved after a ladder retry, and it runs once in its new place',
    category: 'plan-edit',
    intent: 'Note the wreck, draft the friend twice, then label the landing.',
    project: makeState,
    gateway: scriptsFor(
      transcript('Note the wreck, draft the friend twice, then label the landing.', [
        steps(
          { tool: 'notes.append', params: { doc: FRIEND, text: 'Note one.' }, expect: 'a note is appended' },
          { tool: 'scene.draft', params: { doc: FRIEND, instruction: 'The lamp fails.', mode: 'draft' }, expect: 'The Friend is drafted' },
          { tool: 'scene.draft', params: { doc: FRIEND, instruction: 'The lamp fails.', mode: 'draft' }, expect: 'The Friend is drafted again' },
          { tool: 'meta.set', params: { targets: [LANDING], label: 'act-2' }, expect: 'The Landing is labelled act-2' },
        ),
        steps({ tool: 'scene.draft', params: { doc: FRIEND, instruction: 'The lamp fails.', mode: 'continue' }, expect: 'The Friend continues' }),
      ]),
      prose('Brief: The lamp fails.', 'The keeper rows out.'),
    ),
    // Card 2 moves the labelling in front of the pending continue, which is allowed: neither of the two has run.
    decisions: [{ action: 'approve' }, { action: 'edit', edits: [{ op: 'reorder', from: 2, to: 3 }] }, { action: 'approve' }],
    expect: {
      status: 'applied',
      trace: {
        matcher: 'strict',
        calls: [
          { tool: 'notes.append', outcome: 'ok' },
          { tool: 'scene.draft', outcome: 'ok' },
          { tool: 'scene.draft', outcome: 'refused' },
          { tool: 'meta.set', outcome: 'not-run' },
          { tool: 'meta.set', outcome: 'ok', params: { targets: [LANDING] } },
          { tool: 'scene.draft', outcome: 'ok', params: { mode: 'continue' } },
        ],
      },
      state: (state) => {
        const failures: string[] = [];
        if (state.manifest.tree.find((node) => node.id === LANDING)?.label !== 'act-2') failures.push('The Landing is not labelled act-2');
        const body = state.documents.get(FRIEND)?.body ?? '';
        if (!body.endsWith('The keeper rows out.')) failures.push(`The Friend ends with ${JSON.stringify(body.slice(-40))}`);
        return failures;
      },
    },
  },
  {
    name: 'permission: a write-confirm draft the user cancels writes nothing',
    category: 'permission',
    intent: 'Draft a new opening for The Friend.',
    project: makeState,
    gateway: scriptsFor(
      transcript('Draft a new opening for The Friend.', [
        steps({ tool: 'scene.draft', params: { doc: 'The Friend', instruction: 'A new opening.', mode: 'draft' }, expect: 'The Friend is drafted' }),
      ]),
      prose('Brief: A new opening.', 'The keeper wakes early.'),
    ),
    decisions: [{ action: 'cancel' }],
    expect: {
      status: 'cancelled',
      cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['scene.draft'], decision: 'cancelled' }] },
      trace: { matcher: 'strict', calls: [] },
      state: (state) => (state.documents.get(FRIEND)?.body === '' ? [] : ['The Friend was written after the user cancelled']),
    },
  },
];

describe('the v0.1 scenario suite (agent-harness §9)', () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const result = await evaluate(scenario);
      expect(result.failures).toEqual([]);
    });
  }

  it('covers every §9 category it names, with at least ten scenarios across them', () => {
    const categories = new Set(scenarios.map((scenario) => scenario.category));
    expect(scenarios.length).toBeGreaterThanOrEqual(10);
    for (const category of ['single-op', 'multi-step', 'plan-edit', 'verify-recovery', 'permission', 'anchor', 'undo']) {
      expect(categories.has(category as Scenario['category'])).toBe(true);
    }
  });
});
