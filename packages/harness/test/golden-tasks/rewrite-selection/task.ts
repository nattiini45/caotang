/** One sentence rewritten shorter: the replacement fits the cut asked for, and every character outside the selection stays byte for byte. */

import { setBody } from '@caotang/store';

import { checks } from '../../../src/agent/checks.js';
import { LANDING, makeState } from '../../fixtures.js';
import { prose, steps, transcript } from '../../agent/scripts.js';
import type { GoldenTask } from '../types.js';

const INTENT = 'Cut the second sentence of The Landing by about a third.';
const BRIEF = 'Cut it by about a third and keep what happens.';

const FIRST = 'The ferry was late, as always. ';
const SELECTED = 'Elena waited on the quay with her map case, counting the lamps along the breakwater.';
const LAST = ' Nobody came to meet her.';
const BODY = `${FIRST}${SELECTED}${LAST}`;
const ANCHOR = { from: FIRST.length, to: FIRST.length + SELECTED.length };

/** Fifteen words cut by a third, within a quarter either way: 8 to 13 words. */
const REPLACEMENT = 'Elena waited on the quay, counting the lamps along the breakwater.';

export const task: GoldenTask = {
  id: 'rewrite-selection',
  category: 'rewrite',
  intent: INTENT,
  project: () => {
    const state = makeState();
    setBody(state, LANDING, BODY);
    return state;
  },
  expect: {
    status: 'applied',
    cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['scene.draft'], decision: 'approved' }] },
    trace: { matcher: 'strict', calls: [{ tool: 'scene.draft', outcome: 'ok', params: { mode: 'rewrite_selection' } }] },
  },
  checks: [
    checks.outsideAnchorUnchanged('The Landing', ANCHOR),
    checks.noPreamble('The Landing'),
    checks.wordCountWithin('The Landing', 10, 0.3),
    checks.mentionsAll('The Landing', ['Elena', 'quay']),
  ],
  budgets: { maxModelCalls: 2 },
  script: () => [
    transcript(INTENT, [
      steps({
        tool: 'scene.draft',
        params: { doc: 'The Landing', instruction: BRIEF, mode: 'rewrite_selection', selection: { from: ANCHOR.from, to: ANCHOR.to, exact: SELECTED, prefix: FIRST, suffix: LAST, capturedRevision: 1 } },
        expect: 'the second sentence is cut',
      }),
    ]),
    prose(`Brief: ${BRIEF}`, REPLACEMENT),
  ],
};
