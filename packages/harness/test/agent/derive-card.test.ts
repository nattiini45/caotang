/**
 * `shots.derive` as a plan card shows it and checks it (storyboard.md §4, agent-harness §2): the shot list and the target tree the approved
 * derive would create, and a proposal the storyboard module refuses, which the card's preflight refuses too, so the card cannot approve
 * a derive that its apply would refuse. Each case goes through the real harness on the real bus.
 */

import { describe, expect, it } from 'vitest';

import { addDocument, type ProjectState } from '@caotang/store';
import { setNodeKind } from '@caotang/storyboard';

import { createAgentPorts, createHarness, previewFor, type Harness } from '../../src/index.js';
import { CHAPTER_ONE, FRIEND, OPENED, makeState, snapshotOf } from '../fixtures.js';

const SCENE = 'n_DERIVSCN01';
const SCENE_TITLE = 'The Lamp Scene';
const FOLDER_TITLE = `${SCENE_TITLE} — Shots`;

/** A project with a screenplay scene in Chapter 1, which `shots.derive` reads. */
function sceneState(): ProjectState {
  const state = makeState();
  addDocument(state, { parentId: CHAPTER_ONE, title: SCENE_TITLE, body: 'The lamp fails.\n\nThe keeper climbs the stair.', now: OPENED, id: SCENE });
  const scene = state.manifest.tree.find((node) => node.id === SCENE);
  if (scene === undefined) throw new Error('the fixture scene is missing');
  setNodeKind(scene, 'screenplay');
  return state;
}

/** Two shots: the first covers one line of the scene, the second has no camera spec at all. */
const PROPOSAL = {
  shots: [
    { shotSize: 'WS', cameraAngle: 'eye', action: 'The lamp fails.', durationSec: 4, dialogueQuotes: ['The lamp fails.'] },
    { action: 'The keeper climbs the stair.' },
  ],
};

function harnessFor(state: ProjectState): Harness {
  return createHarness({ state, ports: createAgentPorts(), clock: () => 1 });
}

describe('the preview a derive card shows (storyboard.md §4 row 18)', () => {
  it('names the new folder, each proposed shot with its number, title and spec row, and the target tree diff', () => {
    const preview = previewFor(sceneState(), 'shots.derive', { doc: SCENE }, PROPOSAL) as {
      folder: string;
      shots: { number: number; title: string; spec: string }[];
      lines: string[];
      notes: string[];
    };
    expect(preview.folder).toBe(FOLDER_TITLE);
    expect(preview.shots.map((shot) => shot.number)).toEqual([1, 2]);
    expect(preview.shots.map((shot) => shot.title)).toEqual(['The lamp fails.', 'The keeper climbs the stair.']);
    expect(preview.shots[0]?.spec).toBe('Wide shot (WS) · Eye level · 4 s');
    expect(preview.lines.find((line) => line.includes('+ shot 1'))).toContain('Wide shot (WS) · Eye level · 4 s');
    expect(preview.shots[1]?.spec).toBe('');
    // The tree diff is the folder the apply creates, then one line per shot, in the order the cards take in it.
    expect(preview.lines[0]).toContain(`+ folder "${FOLDER_TITLE}"`);
    expect(preview.lines.filter((line) => line.includes('+ shot'))).toHaveLength(2);
    expect(preview.notes).toEqual([]);
  });

  it('shows nothing before a proposal is staged, and for a scene the name does not resolve', () => {
    expect(previewFor(sceneState(), 'shots.derive', { doc: SCENE }, undefined)).toBeUndefined();
    expect(previewFor(sceneState(), 'shots.derive', { doc: 'The Missing Scene' }, PROPOSAL)).toBeUndefined();
  });

  it('shows no list for a proposal the storyboard module refuses, since the step is refused and the preflight says why', () => {
    // A prose document is not a screenplay scene, so there is no list to show for it.
    expect(previewFor(makeState(), 'shots.derive', { doc: FRIEND }, PROPOSAL)).toBeUndefined();
  });
});

describe('the preflight of a derive step (agent-harness §2)', () => {
  it('refuses a derive of a prose document, so a plan card containing it is not approvable', () => {
    const state = makeState();
    const checked = harnessFor(state).previewPlan({ steps: [{ tool: 'shots.derive', params: { doc: FRIEND }, expect: 'the friend has shots' }] }, {
      from: 0,
      proposals: [PROPOSAL],
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const step = checked.value.steps[0];
    expect(checked.value.ok).toBe(false);
    expect(step?.status).toBe('refused');
    expect(step?.error?.message).toContain('derive works on screenplay scenes');
  });

  it('refuses an empty proposal, and says that no shots were proposed', () => {
    const checked = harnessFor(sceneState()).previewPlan({ steps: [{ tool: 'shots.derive', params: { doc: SCENE }, expect: 'the scene has shots' }] }, {
      from: 0,
      proposals: [{ shots: [] }],
    });
    expect(checked.ok && checked.value.ok).toBe(false);
    if (checked.ok) expect(checked.value.steps[0]?.error?.message).toContain('no shots were proposed');
  });

  it('passes a valid derive, and a step staged with no proposal is left to the port', () => {
    const valid = harnessFor(sceneState()).previewPlan({ steps: [{ tool: 'shots.derive', params: { doc: SCENE }, expect: 'the scene has shots' }] }, {
      from: 0,
      proposals: [PROPOSAL],
    });
    expect(valid.ok && valid.value.ok).toBe(true);
    const unstaged = harnessFor(sceneState()).previewPlan({ steps: [{ tool: 'shots.derive', params: { doc: SCENE }, expect: 'the scene has shots' }] });
    expect(unstaged.ok && unstaged.value.ok).toBe(true);
  });

  it('refuses the same derive when it is called, and writes nothing, as the plan preflight refused it', () => {
    const state = makeState();
    const harness = harnessFor(state);
    const before = snapshotOf(state);
    const outcome = harness.call(
      { name: 'shots.derive', callId: 'derive-refused-1', params: { doc: FRIEND }, proposal: PROPOSAL },
      { turnId: 'derive-refused', permission: { confirmed: true } },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toContain('derive works on screenplay scenes');
    expect(snapshotOf(state)).toBe(before);
  });

  it('applies a valid derive through the same check, and creates the folder and its shots', () => {
    const state = sceneState();
    const harness = harnessFor(state);
    const outcome = harness.call(
      { name: 'shots.derive', callId: 'derive-valid-1', params: { doc: SCENE }, proposal: PROPOSAL },
      { turnId: 'derive-valid', permission: { confirmed: true } },
    );
    expect(outcome.ok).toBe(true);
    const folder = state.manifest.tree.find((node) => node.type === 'folder' && node.title === FOLDER_TITLE);
    expect(folder).toBeDefined();
    expect(state.manifest.tree.filter((node) => node.parentId === folder?.id)).toHaveLength(2);
  });
});
