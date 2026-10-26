/** A scan of two scenes finds the eye colour that changes between them, and does not bury it among other findings. */

import { isDraftCall, type MockScript } from '@caotang/gateway/mock';
import { setBody } from '@caotang/store';

import { checks } from '../../../src/agent/checks.js';
import { LANDING, STORM, makeState } from '../../fixtures.js';
import { answer, steps, transcript } from '../../agent/scripts.js';
import type { GoldenTask } from '../types.js';

const INTENT = 'Check The Landing and The Storm for continuity problems.';

const FINDINGS = {
  findings: [
    {
      aspect: 'characters',
      severity: 'major',
      docs: ['The Landing', 'The Storm'],
      quote: 'grey eyes',
      note: 'Elena has grey eyes in The Landing and green eyes in The Storm.',
    },
  ],
};

/** The scan's model call: a drafting call that asks for a JSON object, not for text. */
const scan: MockScript = {
  match: (req) => isDraftCall(req) && req.responseFormat !== undefined && typeof req.responseFormat !== 'string',
  respond: () => ({ content: JSON.stringify(FINDINGS) }),
};

export const task: GoldenTask = {
  id: 'continuity-planted',
  category: 'continuity',
  intent: INTENT,
  project: () => {
    const state = makeState();
    setBody(state, LANDING, 'The ferry was late, as always. Elena had grey eyes, and the harbour master never stopped remarking on them.');
    setBody(state, STORM, 'Rain.\n\n***\n\nThe lamp failed, and Elena’s green eyes caught the last of the light.');
    return state;
  },
  expect: {
    status: 'replied',
    cards: { matcher: 'strict', items: [] },
    trace: { matcher: 'strict', calls: [{ tool: 'continuity.scan', outcome: 'ok' }] },
    // Both scenes reach the scan's call in full, so the model can see both colours.
    requests: [{ system: 'You are drafting prose for Caotang.', includes: ['grey eyes', 'green eyes'] }],
  },
  checks: [checks.findsContradiction(['The Landing', 'The Storm'], 'grey eyes', 3), checks.projectUnchanged(), checks.modelCallsAtMost(3)],
  budgets: { maxModelCalls: 3 },
  script: () => [
    transcript(INTENT, [
      steps({ tool: 'continuity.scan', params: { scope: ['The Landing', 'The Storm'], aspects: ['characters'] }, expect: 'the findings are listed' }),
      answer('One problem: Elena has grey eyes in The Landing and green eyes in The Storm.'),
    ]),
    scan,
  ],
};
