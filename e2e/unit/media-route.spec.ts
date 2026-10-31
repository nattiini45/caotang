import { expect, test } from '@playwright/test';

import { mediaKindOf } from '../../apps/desktop/src/media/route.js';
import { addShotNode, addStoryboardFolder } from '../../packages/storyboard/src/index.js';
import { addDocument, addFolder, createEmptyManifest, createProjectState, nodeById, type ProjectState, type TreeNode } from '../../packages/store/src/index.js';

const NOW = new Date('2026-10-08T09:00:00Z');

/** One node of every kind the routing has to tell apart, each under the manuscript. */
function project(): ProjectState {
  const state = createProjectState(createEmptyManifest('Film', NOW, { locale: 'en-US' }));
  addDocument(state, { parentId: 'manuscript', title: 'Prose scene', id: 'n_PROSE00001', body: 'Once upon a time.', now: NOW });
  addDocument(state, { parentId: 'manuscript', title: 'Kitchen', id: 'n_SCENE00001', body: 'INT. KITCHEN - NIGHT', now: NOW });
  Object.assign(nodeById(state, 'n_SCENE00001') as TreeNode, { kind: 'screenplay' });
  addDocument(state, { parentId: 'manuscript', title: 'Empty scene', id: 'n_EMPTY00001', body: '', now: NOW });
  Object.assign(nodeById(state, 'n_EMPTY00001') as TreeNode, { kind: 'screenplay' });
  addDocument(state, { parentId: 'manuscript', title: 'Ink', id: 'n_DIALOG0001', body: '-> END', now: NOW });
  Object.assign(nodeById(state, 'n_DIALOG0001') as TreeNode, { type: 'dialogue', kind: 'branching' });
  addDocument(state, { parentId: 'manuscript', title: 'A line', id: 'n_BEAT000001', body: 'Hi.', now: NOW });
  Object.assign(nodeById(state, 'n_BEAT000001') as TreeNode, { type: 'beat' });
  addFolder(state, { parentId: 'manuscript', title: 'Plain folder', id: 'n_PLAIN00001', now: NOW });
  addStoryboardFolder(state, { parentId: 'manuscript', title: 'Shots', id: 'n_BOARD00001', now: NOW });
  addShotNode(state, { parentId: 'n_BOARD00001', id: 'n_SHOTA00001', title: 'Wide', stored: {}, now: NOW });
  // A board marker on a document, and a scene marker on a folder: neither is the node type the kind belongs to.
  addDocument(state, { parentId: 'manuscript', title: 'Not a board', id: 'n_DOCBOARD01', body: '', now: NOW });
  Object.assign(nodeById(state, 'n_DOCBOARD01') as TreeNode, { kind: 'storyboard' });
  addFolder(state, { parentId: 'manuscript', title: 'Not a scene', id: 'n_FOLDSCRN01', now: NOW });
  Object.assign(nodeById(state, 'n_FOLDSCRN01') as TreeNode, { kind: 'screenplay' });
  return state;
}

function nodeOf(state: ProjectState, id: string): TreeNode {
  const node = nodeById(state, id);
  if (node === undefined) throw new Error(`no node ${id}`);
  return node;
}

test.describe('which view a node gets', () => {
  test('a screenplay scene gets the screenplay view, empty or not', () => {
    const state = project();
    expect(mediaKindOf(nodeOf(state, 'n_SCENE00001'))).toBe('screenplay');
    expect(mediaKindOf(nodeOf(state, 'n_EMPTY00001'))).toBe('screenplay');
  });

  test('a storyboard folder gets the storyboard view', () => {
    expect(mediaKindOf(nodeOf(project(), 'n_BOARD00001'))).toBe('storyboard');
  });

  test('a dialogue container gets the dialogue view', () => {
    expect(mediaKindOf(nodeOf(project(), 'n_DIALOG0001'))).toBe('dialogue');
  });

  test('a prose document, a plain folder, a beat and a shot get no media view', () => {
    const state = project();
    expect(mediaKindOf(nodeOf(state, 'n_PROSE00001'))).toBeNull();
    expect(mediaKindOf(nodeOf(state, 'n_PLAIN00001'))).toBeNull();
    expect(mediaKindOf(nodeOf(state, 'n_BEAT000001'))).toBeNull();
    expect(mediaKindOf(nodeOf(state, 'n_SHOTA00001'))).toBeNull();
  });

  test('a kind marker counts only on the node type it belongs to: a document is not a board, and a folder is not a scene', () => {
    const state = project();
    expect(mediaKindOf(nodeOf(state, 'n_DOCBOARD01'))).toBeNull();
    expect(mediaKindOf(nodeOf(state, 'n_FOLDSCRN01'))).toBeNull();
  });
});
