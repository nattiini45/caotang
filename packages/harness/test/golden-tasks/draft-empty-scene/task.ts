/** A scene drafted from a brief into an empty document: the length asked for, the writing alone, the codex's always-entry named, a never-entry kept out. */

import { prose, steps, transcript } from '../../agent/scripts.js';
import { checks } from '../../../src/agent/checks.js';
import { FRIEND } from '../../fixtures.js';
import { codexEntry, withCodex } from '../support.js';
import type { GoldenTask } from '../types.js';

const INTENT = 'Draft the scene where Elena meets Captain Hale at the quay.';
const BRIEF = 'Elena misses the last ferry and Captain Hale is waiting at the quay.';

const HALE = codexEntry({ id: 'c_CAPTHALE01', name: 'Captain Hale', type: 'character', description: 'The harbour master, a gruff man who trusts nobody who draws maps.', includePolicy: 'always' });
const FERRYMAN = codexEntry({ id: 'c_FERRYMN001', name: 'Ferryman', type: 'character', description: 'The ferryman keeps a secret he has not told Elena.', includePolicy: 'never' });

const SCENE =
  'Elena reached the quay as the last ferry pulled away, its lamps smearing yellow across the black water. Captain Hale stood at the bollard with his arms folded, watching her come. "You missed it," he said. "I know," said Elena. She set her map case down between them, and neither of them looked at it again.';

export const task: GoldenTask = {
  id: 'draft-empty-scene',
  category: 'draft',
  intent: INTENT,
  project: withCodex(HALE, FERRYMAN),
  expect: {
    status: 'applied',
    cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['scene.draft'], decision: 'approved' }] },
    trace: { matcher: 'strict', calls: [{ tool: 'scene.draft', outcome: 'ok', params: { mode: 'draft' } }] },
    // The always-entry reaches the draft call without a mention in the brief, the never-entry does not reach it.
    requests: [{ system: 'You are drafting prose for Caotang.', includes: ['## Captain Hale (character)'], excludes: ['## Ferryman'] }],
  },
  checks: [
    checks.wordCountWithin(FRIEND, 60, 0.25),
    checks.noPreamble(FRIEND),
    checks.mentionsAll(FRIEND, ['Captain Hale']),
    checks.absentEverywhere(['Ferryman'], ['outputs']),
    checks.absentEverywhere(['keeps a secret he has not told']),
  ],
  budgets: { maxModelCalls: 2 },
  script: () => [
    transcript(INTENT, [steps({ tool: 'scene.draft', params: { doc: 'The Friend', instruction: BRIEF, mode: 'draft', target_words: 60 }, expect: 'The Friend is drafted' })]),
    prose(`Brief: ${BRIEF}`, SCENE),
  ],
};
