/** Two jobs over one chapter, planned together: one planner call, one synopsis.fill that names every scene, one meta.set, and no call per scene. */

import { addDocument, setBody } from '@caotang/store';

import { checks } from '../../../src/agent/checks.js';
import { CHAPTER_ONE, LANDING, OPENED, STORM, makeState } from '../../fixtures.js';
import { prose, steps, transcript } from '../../agent/scripts.js';
import type { GoldenTask } from '../types.js';

const INTENT = 'Fill synopses for Chapter 1 and tag each scene with its point of view.';
const WRECK = 'n_WRECK00001';

export const task: GoldenTask = {
  id: 'plan-economy',
  category: 'economy',
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
    cards: { matcher: 'strict', items: [{ kind: 'plan', tools: ['synopsis.fill', 'meta.set'], decision: 'approved' }] },
    // One synopsis.fill that names all three scenes, and one meta.set: never a call per scene.
    trace: {
      matcher: 'strict',
      calls: [
        { tool: 'synopsis.fill', outcome: 'ok', params: { docs: [LANDING, STORM, WRECK] } },
        { tool: 'meta.set', outcome: 'ok', params: { targets: [LANDING, STORM, WRECK] } },
      ],
    },
  },
  // One planner call and one synopsis call per scene.
  checks: [checks.modelCallsAtMost(4), checks.synopsesGrounded(['The Landing', 'The Storm', 'The Wreck'], 20)],
  budgets: { maxModelCalls: 4 },
  script: () => [
    transcript(INTENT, [
      steps(
        { tool: 'synopsis.fill', params: { docs: [LANDING, STORM, WRECK], source: 'text', max_words: 20 }, expect: 'each scene has a synopsis' },
        { tool: 'meta.set', params: { targets: [LANDING, STORM, WRECK], keywords_add: ['pov-checked'] }, expect: 'each scene is tagged' },
      ),
    ]),
    prose('Document "The Landing":', 'The ferry is late, so Elena waits on the quay with her map case.'),
    prose('Document "The Storm":', 'Rain falls and the lamp fails while Kestrel circles the tower.'),
    prose('Document "The Wreck":', 'At dawn Hale rows to the wreck and finds the keeper’s boat tied to it.'),
  ],
};
