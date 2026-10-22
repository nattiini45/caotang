/**
 * The storyboard and prompt-pack tools the agent drafts (storyboard.md §4, video-prompt-pack.md §6), each as a complete turn against
 * a deterministic mock model: `shots.derive` plans a scene's shots from the model's proposal and writes them once approved,
 * `prompt.variant` offers three alternatives as a read, and `prompt.draft` writes each shot's vendor prompt through shot.setMeta.
 */

import { describe, expect, it } from 'vitest';

import type { ChatRequest } from '@caotang/gateway';
import type { MockScript } from '@caotang/gateway/mock';
import { addDocument, type ProjectState } from '@caotang/store';
import { addShotNode, addStoryboardFolder, isShotNode, setNodeKind, shotFieldOf } from '@caotang/storyboard';
import { VIDEO_TEMPLATE_IDS } from '@caotang/video-prompt-pack';

import { evaluate, type Scenario } from '../../src/agent/eval.js';
import { parseDeriveReply } from '../../src/agent/storyboard-model.js';
import { CHAPTER_ONE, FRIEND, OPENED, makeState } from '../fixtures.js';
import { mockGateway } from '../agent/gateway.js';
import { answer, steps, transcript } from '../agent/scripts.js';

const LAMP = 'n_LAMPSCN001';
const BOARD = 'n_SBOARD0001';
const SHOT = 'n_SHOTONE001';
const VENDOR = VIDEO_TEMPLATE_IDS[0] as string;
const SHOT_FOLDER_TITLE = 'Lamp Scene — Shots';

/** The system message of a request, which names each drafting call's role. */
const systemOf = (req: ChatRequest): string => req.messages[0]?.content ?? '';

/** A model reply that answers the one call whose system message carries the marker. */
function replyTo(marker: string, content: string): MockScript {
  return { match: (req) => systemOf(req).includes(marker), respond: () => ({ content }) };
}

/** A project with a screenplay scene in Chapter 1, which `shots.derive` reads. */
function sceneState(): ProjectState {
  const state = makeState();
  addDocument(state, { parentId: CHAPTER_ONE, title: 'Lamp Scene', body: 'The lamp fails.\n\nThe keeper climbs the stair.', now: OPENED, id: LAMP });
  const scene = state.manifest.tree.find((node) => node.id === LAMP);
  if (scene === undefined) throw new Error('the fixture scene is missing');
  setNodeKind(scene, 'screenplay');
  return state;
}

/** A project with an empty screenplay scene in Chapter 1, which has nothing to derive shots from. */
function emptySceneState(): ProjectState {
  const state = makeState();
  addDocument(state, { parentId: CHAPTER_ONE, title: 'Lamp Scene', body: '', now: OPENED, id: LAMP });
  const scene = state.manifest.tree.find((node) => node.id === LAMP);
  if (scene === undefined) throw new Error('the fixture scene is missing');
  setNodeKind(scene, 'screenplay');
  return state;
}

/** A project with one storyboard folder holding one shot, which `prompt.draft` and `prompt.variant` read. */
function boardState(stored: Record<string, unknown>): ProjectState {
  const state = makeState();
  addStoryboardFolder(state, { parentId: CHAPTER_ONE, title: 'Lamp Shots', now: OPENED, id: BOARD });
  addShotNode(state, { parentId: BOARD, title: 'The lamp fails', stored, now: OPENED, id: SHOT });
  return state;
}

const DERIVE_REPLY = JSON.stringify({
  shots: [
    { action: 'The lamp fails.', durationSec: 4, dialogueQuotes: [] },
    { action: 'The keeper climbs the stair.', durationSec: 3, dialogueQuotes: [] },
  ],
});

const scenarios: Scenario[] = [
  {
    name: 'shots.derive: the scene’s shots are proposed by the model, approved on one card, and written as a storyboard folder',
    category: 'single-op',
    intent: 'Derive the shots of the lamp scene.',
    preload: ['shots.derive'],
    project: sceneState,
    gateway: () =>
      mockGateway([
        transcript('Derive the shots of the lamp scene.', [
          steps({ tool: 'shots.derive', params: { doc: LAMP, granularity: 'key-shots' }, expect: 'the lamp scene has its shots' }),
        ]),
        replyTo('Plan the shots of the screenplay scene below', DERIVE_REPLY),
      ]),
    expect: {
      status: 'applied',
      cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['shots.derive'], decision: 'approved' }] },
      trace: { matcher: 'strict', calls: [{ tool: 'shots.derive', outcome: 'ok' }] },
      // A storyboard scene is open, so the app preloads the module's rows (PRELOAD_BY_CONTEXT).
      reached: { 'shots.derive': 'preload' },
      state: (state) => {
        const folder = state.manifest.tree.find((node) => node.type === 'folder' && node.title === SHOT_FOLDER_TITLE);
        if (folder === undefined) return [`no folder "${SHOT_FOLDER_TITLE}" was written`];
        const shots = state.manifest.tree.filter((node) => isShotNode(node) && node.parentId === folder.id);
        return shots.length === 2 ? [] : [`the folder holds ${shots.length} shots, not 2`];
      },
    },
  },
  {
    name: 'prompt.variant: three alternatives come back to the model as a read, and nothing is written',
    category: 'single-op',
    intent: 'Offer three camera alternatives for the lamp shot.',
    project: () => boardState({ action: 'The lamp fails.', vendorRefs: [{ vendor: VENDOR, mode: 't2v', prompt: { camera: 'Slow dolly in.', subject: 'The lamp', action: 'Flickers out.' } }] }),
    gateway: () =>
      mockGateway([
        transcript('Offer three camera alternatives for the lamp shot.', [
          steps({ tool: 'prompt.variant', params: { shot: SHOT, vendor: VENDOR, variation: 'camera' }, expect: 'three camera alternatives are offered' }),
          answer('Three camera alternatives are above.'),
        ]),
        replyTo('You offer alternatives for one part of an AI-video shot prompt', JSON.stringify({ alternatives: ['Hand-held drift.', 'Locked off, wide.', 'Crane up slowly.'] })),
      ]),
    expect: {
      status: 'replied',
      trace: { matcher: 'strict', calls: [{ tool: 'prompt.variant', outcome: 'ok' }] },
      reached: { 'prompt.variant': 'preflight' },
      requests: [{ includes: ['Hand-held drift.', 'Crane up slowly.'] }],
      // The fixture holds one vendor record, and a read leaves it as it was.
      state: (state) => {
        const node = state.manifest.tree.find((candidate) => candidate.id === SHOT);
        const refs = node === undefined ? [] : ((shotFieldOf(node) as { vendorRefs?: unknown[] } | undefined)?.vendorRefs ?? []);
        return refs.length === 1 ? [] : ['the variant read wrote to the shot'];
      },
    },
  },
  {
    name: 'prompt.draft: each shot’s vendor prompt is drafted and written through shot.setMeta once the card is approved',
    category: 'single-op',
    intent: 'Draft the prompt for the lamp shot.',
    project: () => boardState({ action: 'The lamp fails.' }),
    gateway: () =>
      mockGateway([
        transcript('Draft the prompt for the lamp shot.', [
          steps({ tool: 'prompt.draft', params: { shots: [SHOT], vendor: VENDOR, instruction: 'Keep it moody.' }, expect: 'the lamp shot has its prompt' }),
        ]),
        replyTo('You draft the video prompt for one shot of an AI-video project', JSON.stringify({ camera: 'Slow dolly in.', subject: 'The lamp', action: 'The lamp fails.' })),
      ]),
    expect: {
      status: 'applied',
      cards: { matcher: 'strict', items: [{ kind: 'confirm', tools: ['prompt.draft'], decision: 'approved' }] },
      trace: { matcher: 'strict', calls: [{ tool: 'prompt.draft', outcome: 'ok' }] },
      reached: { 'prompt.draft': 'preflight' },
      state: (state) => {
        const node = state.manifest.tree.find((candidate) => candidate.id === SHOT);
        const refs = (node === undefined ? undefined : (shotFieldOf(node) as { vendorRefs?: { vendor?: unknown }[] } | undefined)?.vendorRefs) ?? [];
        return refs.some((ref) => ref.vendor === VENDOR) ? [] : [`the shot holds no ${VENDOR} prompt after the draft was approved`];
      },
    },
  },
];

describe('the storyboard and prompt-pack tools the agent drafts (storyboard.md §4, video-prompt-pack.md §6)', () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const result = await evaluate(scenario);
      expect(result.failures).toEqual([]);
    });
  }

  // The scene checks of a derive need no proposal, so a prose scene or an empty one is refused before the derive's model call, in the
  // storyboard's words, and the planner is told them. A derive call made before the refusal would count one.
  for (const [what, project, words] of [
    ['a prose scene', makeState, 'Derive works on screenplay scenes'],
    ['an empty screenplay scene', emptySceneState, 'The scene is empty, so there is nothing to derive shots from'],
  ] as const) {
    it(`a derive of ${what} is refused before its model call, in the storyboard's words`, async () => {
      let derived = 0;
      const doc = project === makeState ? FRIEND : LAMP;
      const result = await evaluate({
        name: `shots.derive: ${what} is refused before the derive is asked for`,
        category: 'single-op',
        intent: 'Derive the shots of the scene.',
        project,
        gateway: () =>
          mockGateway([
            transcript('Derive the shots of the scene.', [
              steps({ tool: 'shots.derive', params: { doc, granularity: 'key-shots' }, expect: 'the scene has its shots' }),
              answer('That scene cannot be derived yet.'),
            ]),
            {
              match: (req) => systemOf(req).includes('Plan the shots of the screenplay scene below'),
              respond: () => {
                derived += 1;
                return { content: DERIVE_REPLY };
              },
            },
          ]),
        expect: { status: 'replied', requests: [{ includes: [words] }] },
      });
      expect(result.failures).toEqual([]);
      expect(derived).toBe(0);
    });
  }

  it('a derive reply is read as its shot list, fenced or bare, and a reply with no shot list is refused by name', () => {
    expect(parseDeriveReply(DERIVE_REPLY)).toEqual({ ok: true, value: JSON.parse(DERIVE_REPLY) });
    expect(parseDeriveReply('```json\n{"shots": []}\n```')).toEqual({ ok: true, value: { shots: [] } });
    const notJson = parseDeriveReply('Here are the shots.');
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) expect(notJson.message).toContain('not JSON');
    const noList = parseDeriveReply('{"scenes": []}');
    expect(noList.ok).toBe(false);
    if (!noList.ok) expect(noList.message).toContain('"shots" list');
  });
});
