/** Scenes labelled with the point of view their text is written in, by two grouped edits, and no scene left with the wrong one. */

import { addDocument, setBody } from '@caotang/store';

import { checks } from '../../../src/agent/checks.js';
import { CHAPTER_TWO, FRIEND, LANDING, OPENED, STORM, makeState } from '../../fixtures.js';
import { steps, transcript } from '../../agent/scripts.js';
import type { GoldenTask } from '../types.js';

const INTENT = 'Label each scene with whose point of view it is in.';
const WRECK = 'n_WRECK00001';

export const task: GoldenTask = {
  id: 'tag-pov',
  category: 'metadata',
  intent: INTENT,
  project: () => {
    const state = makeState();
    state.manifest.vocabulary.labels = [
      ...state.manifest.vocabulary.labels,
      { id: 'pov-elena', name: 'POV Elena', color: '#c0504d' },
      { id: 'pov-hale', name: 'POV Hale', color: '#4f81bd' },
    ];
    setBody(state, LANDING, 'Elena counted the lamps along the breakwater and wondered who had lit them.');
    setBody(state, STORM, 'Hale watched the lamp fail from the harbour wall and swore at the weather.');
    setBody(state, FRIEND, 'Elena asked her friend whether the channel would be passable by noon.');
    addDocument(state, { parentId: CHAPTER_TWO, title: 'The Wreck', body: 'Hale rowed out to the wreck at dawn and found the keeper’s boat tied to it.', now: OPENED, id: WRECK });
    return state;
  },
  expect: {
    status: 'applied',
    cards: { matcher: 'strict', items: [{ kind: 'plan', tools: ['meta.set', 'meta.set'], decision: 'approved' }] },
    trace: {
      matcher: 'unordered',
      calls: [
        { tool: 'meta.set', outcome: 'ok', params: { label: 'pov-elena' } },
        { tool: 'meta.set', outcome: 'ok', params: { label: 'pov-hale' } },
      ],
    },
  },
  checks: [
    checks.labelsMatch({ 'The Landing': 'pov-elena', 'The Storm': 'pov-hale', 'The Friend': 'pov-elena', 'The Wreck': 'pov-hale' }, 0.9),
    checks.modelCallsAtMost(1),
  ],
  budgets: { maxModelCalls: 1 },
  script: () => [
    transcript(INTENT, [
      steps(
        { tool: 'meta.set', params: { targets: [LANDING, FRIEND], label: 'pov-elena' }, expect: 'the Elena scenes are labelled' },
        { tool: 'meta.set', params: { targets: [STORM, WRECK], label: 'pov-hale' }, expect: 'the Hale scenes are labelled' },
      ),
    ]),
  ],
};
