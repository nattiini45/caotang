/** A draft aimed at a document that already has text is refused before any card or model call, and nothing is written. */

import { checks } from '../../../src/agent/checks.js';
import { makeState } from '../../fixtures.js';
import { answer, steps, transcript } from '../../agent/scripts.js';
import type { GoldenTask } from '../types.js';

const INTENT = 'Draft a fresh opening for The Storm.';

export const task: GoldenTask = {
  id: 'refuse-overwrite',
  category: 'refusal',
  intent: INTENT,
  project: makeState,
  expect: {
    status: 'replied',
    summaryIncludes: ['continue'],
    cards: { matcher: 'strict', items: [] },
    // The planner is told why in the refusal's two sentences: the rule, then what to do instead.
    requests: [{ includes: ['Mode draft needs an empty document', 'so nothing was written. Set mode to continue to add to the end'] }],
  },
  checks: [checks.projectUnchanged(), checks.modelCallsAtMost(2)],
  budgets: { maxModelCalls: 2 },
  script: () => [
    transcript(INTENT, [
      steps({ tool: 'scene.draft', params: { doc: 'The Storm', instruction: 'A fresh opening.', mode: 'draft' }, expect: 'The Storm is drafted' }),
      answer('The Storm already has text, so I did not overwrite it. I can continue it from the end instead.'),
    ]),
  ],
};
