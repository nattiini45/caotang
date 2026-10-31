/** A dialogue container drafted as Ink: it compiles, offers real choices, and arrives as Ink alone with no code fence. */

import { addDocument } from '@caotang/store';

import { checks } from '../../../src/agent/checks.js';
import { OPENED, makeState } from '../../fixtures.js';
import { prose, steps, transcript } from '../../agent/scripts.js';
import type { GoldenTask } from '../types.js';

const INTENT = 'Write the stranger’s reply at the tavern.';
const BRIEF = 'A stranger thanks Elena for the drink, and she may ask who he is or say nothing.';
const TAVERN = 'n_TAVERN0001';

const INK = [
  '=== reply ===',
  '"Thanks for the drink," the stranger says.',
  '* [Ask who he is]',
  '  "Who are you?" -> name',
  '* [Say nothing]',
  '  You nod. -> END',
  '',
  '=== name ===',
  '"A friend of the keeper." -> END',
].join('\n');

export const task: GoldenTask = {
  id: 'ink-dialogue',
  category: 'dialogue',
  intent: INTENT,
  project: () => {
    const state = makeState();
    addDocument(state, { id: TAVERN, parentId: 'manuscript', title: 'Tavern', type: 'dialogue', body: '', now: OPENED });
    return state;
  },
  expect: {
    status: 'applied',
    cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['dialogue.draft'], decision: 'approved' }] },
    trace: { matcher: 'strict', calls: [{ tool: 'dialogue.draft', outcome: 'ok' }] },
    reached: { 'dialogue.draft': 'preflight' },
    // The role asks for Ink alone.
    requests: [{ system: 'You are drafting prose for Caotang.', systemIncludes: ['as Ink', 'no code fence'] }],
  },
  // The container is read as written: the dialogue module has stamped its line ids on the model's Ink, which still compiles.
  checks: [checks.compilesAsInk('Tavern', { minChoices: 2 })],
  budgets: { maxModelCalls: 2 },
  script: () => [
    transcript(INTENT, [steps({ tool: 'dialogue.draft', params: { doc: 'Tavern', instruction: BRIEF }, expect: 'the reply is drafted' })]),
    prose(`Brief: ${BRIEF}`, INK),
  ],
};
