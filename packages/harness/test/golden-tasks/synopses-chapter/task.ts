/** A chapter's scenes get one synopsis each, within the word limit, about their own text and no other. */

import { addDocument, setBody } from '@caotang/store';

import { checks } from '../../../src/agent/checks.js';
import { CHAPTER_ONE, LANDING, OPENED, STORM, makeState } from '../../fixtures.js';
import { prose, steps, transcript } from '../../agent/scripts.js';
import type { GoldenTask } from '../types.js';

const INTENT = 'Write synopses for the scenes of Chapter 1.';
const WRECK = 'n_WRECK00001';

export const task: GoldenTask = {
  id: 'synopses-chapter',
  category: 'synopsis',
  intent: INTENT,
  project: () => {
    const state = makeState();
    setBody(state, LANDING, 'The ferry was late, as always. Elena waited on the quay with her map case.');
    setBody(state, STORM, 'Rain.\n\n***\n\nThe lamp failed and Kestrel circled the tower.');
    addDocument(state, { parentId: CHAPTER_ONE, title: 'The Wreck', body: 'Hale rowed out to the wreck at dawn and found the keeper’s boat tied to it.', now: OPENED, id: WRECK });
    return state;
  },
  expect: {
    status: 'applied',
    cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['synopsis.fill'], decision: 'approved' }] },
    trace: { matcher: 'strict', calls: [{ tool: 'synopsis.fill', outcome: 'ok', params: { docs: [LANDING, STORM, WRECK], max_words: 20 } }] },
  },
  checks: [checks.synopsesGrounded(['The Landing', 'The Storm', 'The Wreck'], 20), checks.modelCallsAtMost(4)],
  budgets: { maxModelCalls: 4 },
  script: () => [
    transcript(INTENT, [steps({ tool: 'synopsis.fill', params: { docs: [LANDING, STORM, WRECK], source: 'text', max_words: 20 }, expect: 'each scene of Chapter 1 has a synopsis' })]),
    prose('Document "The Landing":', 'The ferry is late, so Elena waits on the quay with her map case.'),
    prose('Document "The Storm":', 'Rain falls and the lamp fails while Kestrel circles the tower.'),
    prose('Document "The Wreck":', 'At dawn Hale rows to the wreck and finds the keeper’s boat tied to it.'),
  ],
};
