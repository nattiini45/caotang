/** A screenplay scene carried on: valid Fountain with cues and dialogue, no second scene heading, and the scene before it untouched. */

import { addDocument } from '@caotang/store';

import { checks } from '../../../src/agent/checks.js';
import { OPENED, makeState } from '../../fixtures.js';
import { prose, steps, transcript } from '../../agent/scripts.js';
import type { GoldenTask } from '../types.js';

const INTENT = 'Carry on the keeper scene.';
const BRIEF = 'Elena asks Hale to hold the light while the lamp is relit.';
const KEEPER = 'n_KEEP000001';

const FOUNTAIN = ['ELENA', 'Hold the light.', '', 'HALE', '(from the stair)', 'It is out, and I cannot see the wick.', '', 'The lamp catches. Both of them look up.'].join('\n');

export const task: GoldenTask = {
  id: 'fountain-scene',
  category: 'screenplay',
  intent: INTENT,
  project: () => {
    const state = makeState();
    addDocument(state, { id: KEEPER, parentId: 'manuscript', title: 'The Keeper', kind: 'screenplay', body: 'INT. LIGHTHOUSE - NIGHT\n\nThe lamp gutters.', now: OPENED });
    return state;
  },
  expect: {
    status: 'applied',
    cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['scene.draft'], decision: 'approved' }] },
    trace: { matcher: 'strict', calls: [{ tool: 'scene.draft', outcome: 'ok', params: { mode: 'continue' } }] },
    // A continuation is told the scene already has its heading.
    requests: [{ system: 'You are drafting prose for Caotang.', systemIncludes: ['Fountain', 'Do not write a scene heading'] }],
  },
  checks: [
    checks.parsesAsFountain('The Keeper', { heading: 'forbidden', minCues: 2 }),
    checks.prefixUnchanged('The Keeper'),
    checks.noPreamble('The Keeper'),
  ],
  budgets: { maxModelCalls: 2 },
  script: () => [
    transcript(INTENT, [steps({ tool: 'scene.draft', params: { doc: 'The Keeper', instruction: BRIEF, mode: 'continue' }, expect: 'the keeper scene continues' })]),
    prose(`Brief: ${BRIEF}`, FOUNTAIN),
  ],
};
