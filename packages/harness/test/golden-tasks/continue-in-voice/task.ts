/** A scene continued from its end: what the writer had stays byte for byte, and the new text is the writing alone, at the length asked. */

import { setBody } from '@caotang/store';

import { checks } from '../../../src/agent/checks.js';
import { STORM, makeState } from '../../fixtures.js';
import { prose, steps, transcript } from '../../agent/scripts.js';
import type { GoldenTask } from '../types.js';

const INTENT = 'Carry on The Storm in the same voice.';
const BRIEF = 'The narrator reaches the wreck and finds the keeper’s boat tied to it.';

const BODY =
  'I rowed out before the light failed. The sea was flat and the oars were loud, and I kept thinking of my father, who had never once rowed after dark.';

const CONTINUATION =
  'The wreck came up out of the dusk like a tooth. I shipped the oars and let the boat drift against it, and there, tied to a rusted ring, rode the keeper’s skiff, empty, its painter still wet.';

export const task: GoldenTask = {
  id: 'continue-in-voice',
  category: 'continue',
  intent: INTENT,
  project: () => {
    const state = makeState();
    setBody(state, STORM, BODY);
    return state;
  },
  expect: {
    status: 'applied',
    cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['scene.draft'], decision: 'approved' }] },
    trace: { matcher: 'strict', calls: [{ tool: 'scene.draft', outcome: 'ok', params: { mode: 'continue' } }] },
    // The draft call carries the scene's own tail, so the model can hear the voice it is to carry on.
    requests: [{ system: 'You are drafting prose for Caotang.', includes: ['I rowed out before the light failed.'] }],
  },
  checks: [checks.prefixUnchanged('The Storm'), checks.noPreamble('The Storm'), checks.wordCountWithin('The Storm', 40, 0.25), checks.mentionsAll('The Storm', ['wreck'])],
  budgets: { maxModelCalls: 2 },
  script: () => [
    transcript(INTENT, [steps({ tool: 'scene.draft', params: { doc: 'The Storm', instruction: BRIEF, mode: 'continue', target_words: 40 }, expect: 'The Storm continues' })]),
    prose(`Brief: ${BRIEF}`, CONTINUATION),
  ],
};
