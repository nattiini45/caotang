/** A scene moved to another chapter and the chapter renamed, in one batch: the tree is as asked, and one undo puts the project back byte for byte. */

import { checks } from '../../../src/agent/checks.js';
import { CHAPTER_TWO, STORM, makeState } from '../../fixtures.js';
import { steps, transcript } from '../../agent/scripts.js';
import type { GoldenTask } from '../types.js';

const INTENT = 'Move The Storm to the end of Chapter 2 and rename Chapter 2 to Act Two.';

export const task: GoldenTask = {
  id: 'restructure-act',
  category: 'structure',
  intent: INTENT,
  project: makeState,
  expect: {
    status: 'applied',
    cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['binder.restructure'], decision: 'approved' }] },
    trace: { matcher: 'strict', calls: [{ tool: 'binder.restructure', outcome: 'ok' }] },
    // The turn is one undo group: reversing it restores the project byte for byte (command-bus §10).
    restores: true,
  },
  checks: [
    checks.treeEquals([
      { parent: 'Manuscript', title: 'Chapter 1' },
      { parent: 'Chapter 1', title: 'The Landing' },
      { parent: 'Manuscript', title: 'Act Two' },
      { parent: 'Act Two', title: 'The Friend' },
      { parent: 'Act Two', title: 'The Storm' },
    ]),
    checks.modelCallsAtMost(1),
  ],
  budgets: { maxModelCalls: 1 },
  script: () => [
    transcript(INTENT, [
      steps({
        tool: 'binder.restructure',
        params: {
          ops: [
            { action: 'move', node: STORM, newParent: CHAPTER_TWO, index: 1 },
            { action: 'rename', node: CHAPTER_TWO, title: 'Act Two' },
          ],
        },
        expect: 'The Storm ends Act Two, which is renamed',
      }),
    ]),
  ],
};
