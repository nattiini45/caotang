/** An entry the writer marked never-include stays out of the model's context even when the brief names it, and its facts do not come back in the writing. */

import { checks } from '../../../src/agent/checks.js';
import { prose, steps, transcript } from '../../agent/scripts.js';
import { codexEntry, withCodex } from '../support.js';
import type { GoldenTask } from '../types.js';

const INTENT = 'Draft the meeting at the wreck.';
const BRIEF = 'Elena meets the Ferryman at the wreck.';

const FERRYMAN = codexEntry({
  id: 'c_FERRYMN001',
  name: 'Ferryman',
  aliases: ['the old boatman'],
  type: 'character',
  description: 'The ferryman sold the salvage ledger to the ferry company and has told nobody.',
  includePolicy: 'never',
});

export const task: GoldenTask = {
  id: 'codex-never',
  category: 'codex',
  intent: INTENT,
  project: withCodex(FERRYMAN),
  expect: {
    status: 'applied',
    cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['scene.draft'], decision: 'approved' }] },
    trace: { matcher: 'strict', calls: [{ tool: 'scene.draft', outcome: 'ok', params: { mode: 'continue' } }] },
    // The brief is the writer's own words and names him; the entry itself is not sent, and the assembly says why.
    requests: [{ system: 'You are drafting prose for Caotang.', includes: [`Brief: ${BRIEF}`, '## Elena (character)'], excludes: ['## Ferryman'] }],
    dropped: ['Ferryman: disabled by include policy (never)'],
  },
  checks: [
    // The entry's facts, in no request and not in the writing. Its name may appear in the brief and so in the draft: the writer asked for him.
    checks.absentEverywhere(['salvage ledger', 'ferry company']),
    checks.noPreamble('The Storm'),
    checks.prefixUnchanged('The Storm'),
  ],
  budgets: { maxModelCalls: 2 },
  script: () => [
    transcript(INTENT, [steps({ tool: 'scene.draft', params: { doc: 'The Storm', instruction: BRIEF, mode: 'continue' }, expect: 'The Storm continues' })]),
    prose(`Brief: ${BRIEF}`, 'The Ferryman was waiting on the wreck with his lantern lit. He said nothing about the night, and Elena asked nothing.'),
  ],
};
