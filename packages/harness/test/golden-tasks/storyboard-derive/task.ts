/** A screenplay scene derived into a storyboard folder and its shots: the model proposes them, one card approves them, and the folder and shots are what was proposed. */

import type { ChatRequest } from '@caotang/gateway';
import type { MockScript } from '@caotang/gateway/mock';
import { addDocument, type ProjectState } from '@caotang/store';
import { isShotNode, setNodeKind, shotFieldOf } from '@caotang/storyboard';

import { checks, type Check } from '../../../src/agent/checks.js';
import { CHAPTER_ONE, OPENED, makeState } from '../../fixtures.js';
import { steps, transcript } from '../../agent/scripts.js';
import type { GoldenTask } from '../types.js';

const INTENT = 'Derive the shots of the lamp scene.';
const LAMP = 'n_LAMPSCN001';
const FOLDER_TITLE = 'Lamp Scene — Shots';

const DERIVE_REPLY = JSON.stringify({
  shots: [
    { action: 'The lamp fails.', durationSec: 4, dialogueQuotes: [] },
    { action: 'The keeper climbs the stair.', durationSec: 3, dialogueQuotes: [] },
  ],
});

/** The derive call: the drafting call whose role asks for a shot plan. */
const derive: MockScript = {
  match: (req: ChatRequest) => (req.messages[0]?.content ?? '').includes('Plan the shots of the screenplay scene below'),
  respond: () => ({ content: DERIVE_REPLY }),
};

function sceneState(): ProjectState {
  const state = makeState();
  addDocument(state, { parentId: CHAPTER_ONE, title: 'Lamp Scene', body: 'The lamp fails.\n\nThe keeper climbs the stair.', now: OPENED, id: LAMP });
  const scene = state.manifest.tree.find((node) => node.id === LAMP);
  if (scene === undefined) throw new Error('the fixture scene is missing');
  setNodeKind(scene, 'screenplay');
  return state;
}

/** The applied result is what was proposed: a folder named for the scene, holding its two shots in order. */
const appliedShots: Check = {
  id: 'appliedShots',
  run: ({ after }) => {
    const folder = after.manifest.tree.find((node) => node.type === 'folder' && node.title === FOLDER_TITLE);
    if (folder === undefined) return { id: 'appliedShots', pass: false, detail: `no folder "${FOLDER_TITLE}" was written` };
    const actions = after.manifest.tree.filter((node) => isShotNode(node) && node.parentId === folder.id).map((node) => (shotFieldOf(node) as { action?: unknown } | undefined)?.action);
    const pass = JSON.stringify(actions) === JSON.stringify(['The lamp fails.', 'The keeper climbs the stair.']);
    return { id: 'appliedShots', pass, detail: `the folder holds shots ${JSON.stringify(actions)}` };
  },
};

export const task: GoldenTask = {
  id: 'storyboard-derive',
  category: 'storyboard',
  intent: INTENT,
  project: sceneState,
  preload: ['shots.derive'],
  expect: {
    status: 'applied',
    cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['shots.derive'], decision: 'approved' }] },
    trace: { matcher: 'strict', calls: [{ tool: 'shots.derive', outcome: 'ok', params: { doc: LAMP } }] },
    reached: { 'shots.derive': 'preload' },
    // The scene reaches the derive call, so the model proposes shots for the text it has.
    requests: [{ system: 'You are drafting prose for Caotang.', includes: ['The keeper climbs the stair.'] }],
    // One undo removes the folder and its shots.
    restores: true,
  },
  checks: [appliedShots, checks.modelCallsAtMost(2)],
  budgets: { maxModelCalls: 2 },
  script: () => [
    transcript(INTENT, [steps({ tool: 'shots.derive', params: { doc: LAMP, granularity: 'key-shots' }, expect: 'the lamp scene has its shots' })]),
    derive,
  ],
};
