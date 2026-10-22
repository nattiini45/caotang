import { expect, test } from '@playwright/test';

import { ENUM_OPTIONS, derivableSceneOf, deriveIntentOf, emptyBoardCopyOf, shotCardsOf, shotsFolderOf } from '../../apps/desktop/src/media/storyboard-model.js';
import { missingPictureLabelOf, shownListingOf } from '../../apps/desktop/src/media/shot-image-model.js';
import { addShotNode, addStoryboardFolder, enumLabelOf } from '../../packages/storyboard/src/index.js';
import { addDocument, createEmptyManifest, createProjectState, nodeById, type ProjectState, type TreeNode } from '../../packages/store/src/index.js';

/**
 * The shot board's view model (storyboard.md §2.1, §3.1 and §4): the labels the shot editor shows, the words the picture
 * picker uses while the picture list loads, the status and label a card names, and the storyboard folder a scene's shots live in,
 * which decides whether the scene offers to derive them. Pure over the project state, so no browser is needed.
 */

const NOW = new Date('2026-10-09T09:00:00Z');
const SCENE = 'n_SCENE00001';
const FOLDER = 'n_SBFOLDER01';
const UNDERIVED = 'n_SCENE00002';
const BOARD = 'n_SBBOARD001';
const THIRD = 'n_SCENE00003';

/** Two screenplay scenes, and a storyboard folder named for the first only, beside them. */
function project(): ProjectState {
  const state = createProjectState(createEmptyManifest('Film', NOW));
  addDocument(state, { parentId: 'manuscript', title: 'Scene 1', body: 'INT. HOUSE - DAY\n', kind: 'screenplay', now: NOW, id: SCENE });
  addStoryboardFolder(state, { parentId: 'manuscript', title: 'Scene 1 — Shots', id: FOLDER, now: NOW });
  addDocument(state, { parentId: 'manuscript', title: 'Scene 2', body: 'INT. BARN - NIGHT\n', kind: 'screenplay', now: NOW, id: UNDERIVED });
  return state;
}

function nodeOf(state: ProjectState, id: string): TreeNode {
  const node = nodeById(state, id);
  if (node === undefined) throw new Error(`no node ${id}`);
  return node;
}

test.describe('the labels the shot editor shows', () => {
  test('a value of a list reads as its label, and the stored value is untouched', () => {
    expect(enumLabelOf('cameraAngle', 'birds')).toBe('Bird’s-eye view');
    expect(enumLabelOf('cameraMovement', 'dolly-in')).toBe('Dolly in');
    expect(enumLabelOf('transition', 'match-on-action')).toBe('Match on action');
    expect(enumLabelOf('shotSize', 'MCU')).toBe('Medium close-up (MCU)');
  });

  test('a value the list does not have is shown as it is, so the writer sees what the file holds', () => {
    expect(enumLabelOf('cameraAngle', 'tilted-sideways')).toBe('tilted-sideways');
  });

  test('a name that only the object prototype has is not mistaken for a label', () => {
    expect(enumLabelOf('cameraAngle', 'constructor')).toBe('constructor');
    expect(enumLabelOf('transition', 'toString')).toBe('toString');
  });
});

test.describe('the card row and the editor speak one language', () => {
  test('a card’s row is the words the editor’s dropdown shows for the stored values, lens and transition included', () => {
    const state = project();
    addShotNode(state, {
      parentId: FOLDER,
      title: 'One',
      stored: { shotSize: 'MCU', cameraAngle: 'birds', cameraMovement: 'dolly-in', durationSec: 4, lens: '35mm', transition: 'dissolve' },
      now: NOW,
      id: 'n_SHOTONE001',
    });
    const [card] = shotCardsOf(state, FOLDER);
    expect(card?.spec).toBe('Medium close-up (MCU) · Bird’s-eye view · Dolly in · 4 s · 35mm · Dissolve');
    expect(card?.spec).toBe(
      [enumLabelOf('shotSize', 'MCU'), enumLabelOf('cameraAngle', 'birds'), enumLabelOf('cameraMovement', 'dolly-in'), '4 s', '35mm', enumLabelOf('transition', 'dissolve')].join(' · '),
    );
    // The stored shape keeps the tokens: a label is only what the writer reads.
    expect(card?.meta).toMatchObject({ shotSize: 'MCU', cameraAngle: 'birds', cameraMovement: 'dolly-in', transition: 'dissolve' });
  });

  test('every value of every list reads on a card as the label the dropdown offers for it', () => {
    for (const [field, options] of Object.entries(ENUM_OPTIONS) as [keyof typeof ENUM_OPTIONS, readonly string[]][]) {
      for (const option of options) {
        const state = project();
        addShotNode(state, { parentId: FOLDER, title: 'One', stored: { [field]: option }, now: NOW, id: 'n_SHOTONE001' });
        expect(shotCardsOf(state, FOLDER)[0]?.spec).toBe(enumLabelOf(field, option));
      }
    }
  });

  test('a value outside its list is shown as stored, in the row as in the dropdown', () => {
    const state = project();
    addShotNode(state, { parentId: FOLDER, title: 'One', stored: { cameraAngle: 'tilted-sideways', transition: 'iris' }, now: NOW, id: 'n_SHOTONE001' });
    expect(shotCardsOf(state, FOLDER)[0]?.spec).toBe('tilted-sideways · iris');
  });
});

test.describe('the derive action’s storyboard', () => {
  test('a scene whose storyboard folder exists has that folder, so the scene offers no second derive', () => {
    const state = project();
    expect(shotsFolderOf(state, nodeOf(state, SCENE))?.id).toBe(FOLDER);
  });

  test('a scene with no storyboard folder yet has none, so the scene offers to derive its shots', () => {
    const state = project();
    expect(shotsFolderOf(state, nodeOf(state, UNDERIVED))).toBeUndefined();
  });

  test('the request names the scene it derives the shots from', () => {
    const state = project();
    expect(deriveIntentOf(nodeOf(state, SCENE))).toBe('Derive the shots for the scene "Scene 1" from its script.');
  });

  test('an empty board beside the one scene with no shots folder offers to derive that scene', () => {
    const state = project();
    addStoryboardFolder(state, { parentId: 'manuscript', title: 'Storyboard', id: BOARD, now: NOW });
    expect(derivableSceneOf(state, nodeOf(state, BOARD))?.id).toBe(UNDERIVED);
  });

  test('a board that is a scene’s shots folder offers no derive, because derive would make a second folder for that scene', () => {
    const state = project();
    expect(derivableSceneOf(state, nodeOf(state, FOLDER))).toBeUndefined();
  });

  test('a board beside two scenes with no shots folder offers no derive, so the writer chooses the scene in its own view', () => {
    const state = project();
    addDocument(state, { parentId: 'manuscript', title: 'Scene 3', body: 'INT. PIER - DAWN\n', kind: 'screenplay', now: NOW, id: THIRD });
    addStoryboardFolder(state, { parentId: 'manuscript', title: 'Storyboard', id: BOARD, now: NOW });
    expect(derivableSceneOf(state, nodeOf(state, BOARD))).toBeUndefined();
  });
});

test.describe('the card’s status, label and picture note', () => {
  test('a card names its status through the project vocabulary, and says so when the status is missing or unknown', () => {
    const state = project();
    state.manifest.vocabulary.statuses.push({ id: 'st_DRAFT00001', name: 'Draft', color: '#c44' });
    addShotNode(state, { parentId: FOLDER, title: 'One', stored: null, now: NOW, id: 'n_SHOTONE001' });
    addShotNode(state, { parentId: FOLDER, title: 'Two', stored: null, now: NOW, id: 'n_SHOTTWO001' });
    addShotNode(state, { parentId: FOLDER, title: 'Three', stored: null, now: NOW, id: 'n_SHOTTHR001' });
    nodeOf(state, 'n_SHOTONE001').status = 'st_DRAFT00001';
    nodeOf(state, 'n_SHOTTWO001').status = 'st_GONE000001';
    const [first, second, third] = shotCardsOf(state, FOLDER);
    expect(first?.status).toEqual({ name: 'Draft', color: '#c44' });
    expect(second?.status).toEqual({ name: 'Unknown status', color: null });
    expect(third?.status).toEqual({ name: 'No status', color: null });
  });

  test('a card names its label through the vocabulary, and has none when the node has none', () => {
    const state = project();
    state.manifest.vocabulary.labels.push({ id: 'lb_MAIN000001', name: 'Main unit', color: '#48c' });
    addShotNode(state, { parentId: FOLDER, title: 'One', stored: null, now: NOW, id: 'n_SHOTONE001' });
    addShotNode(state, { parentId: FOLDER, title: 'Two', stored: null, now: NOW, id: 'n_SHOTTWO001' });
    nodeOf(state, 'n_SHOTONE001').label = 'lb_MAIN000001';
    const [first, second] = shotCardsOf(state, FOLDER);
    expect(first?.label).toBe('Main unit');
    expect(second?.label).toBeNull();
  });

  test('the picker says a picture is gone only once the list has come back without it, and never while it loads', () => {
    expect(missingPictureLabelOf('pending')).toBe('Checking the project’s pictures');
    expect(missingPictureLabelOf('failed')).toBe('This picture could not be checked');
    expect(missingPictureLabelOf('listed')).toBe('This picture is no longer in the project');
  });
});

test.describe('where the picture listing stands', () => {
  const FOLDER_A = { name: 'a' };
  const FOLDER_B = { name: 'b' };
  const RECORDS = new Map([['a_ONE', { id: 'a_ONE', fileName: 'a_ONE.png' }]]);

  test('before the first listing comes back, the listing is pending and holds no records', () => {
    const shown = shownListingOf(FOLDER_A, 3, { source: undefined, version: null, map: new Map(), listing: 'pending' });
    expect(shown.listing).toBe('pending');
    expect(shown.records.size).toBe(0);
  });

  test('a listing taken at an earlier session version is shown but reads as pending, so a new picture is not called missing', () => {
    const shown = shownListingOf(FOLDER_A, 4, { source: FOLDER_A, version: 3, map: RECORDS, listing: 'listed' });
    expect(shown.listing).toBe('pending');
    expect(shown.records).toBe(RECORDS);
  });

  test('a listing taken at the current version is listed', () => {
    expect(shownListingOf(FOLDER_A, 3, { source: FOLDER_A, version: 3, map: RECORDS, listing: 'listed' }).listing).toBe('listed');
  });

  test('a listing of another folder is not shown, and reads as pending', () => {
    const shown = shownListingOf(FOLDER_B, 3, { source: FOLDER_A, version: 3, map: RECORDS, listing: 'listed' });
    expect(shown.listing).toBe('pending');
    expect(shown.records.size).toBe(0);
  });

  test('with no folder nothing can be listed, so the listing has failed', () => {
    const shown = shownListingOf(undefined, 3, { source: FOLDER_A, version: 3, map: RECORDS, listing: 'listed' });
    expect(shown.listing).toBe('failed');
    expect(shown.records.size).toBe(0);
  });
});

test.describe('the empty board’s words', () => {
  test('an editable board carries storyboard.md §3.1’s title as written', () => {
    const copy = emptyBoardCopyOf({ editable: true, canDerive: true, scene: undefined });
    expect(copy.title).toBe("No shots — derive from the scene's script, or draw/import a frame.");
  });

  test('a read-only board, which offers no derive and no new shot, has a neutral title', () => {
    const copy = emptyBoardCopyOf({ editable: false, canDerive: true, scene: undefined });
    expect(copy.title).toBe('No shots in this storyboard yet');
    expect(copy.body).not.toContain('derive');
  });

  test('a board that offers a derive says the shots go in a new folder named for the scene, not on this board', () => {
    const state = project();
    const copy = emptyBoardCopyOf({ editable: true, canDerive: true, scene: nodeOf(state, UNDERIVED) });
    expect(copy.body).toContain('Derived shots go in a new folder, “Scene 2 — Shots”, not on this board.');
    expect(copy.body).not.toContain('open the scene');
  });

  test('a board that can derive but names no scene points the writer to the scene', () => {
    expect(emptyBoardCopyOf({ editable: true, canDerive: true, scene: undefined }).body).toContain('To derive a scene’s shots, open the scene.');
    expect(emptyBoardCopyOf({ editable: true, canDerive: false, scene: undefined }).body).not.toContain('open the scene');
  });
});
