/**
 * Parts (#269, project-format §2): a folder that holds folders is a part, read from the tree and never stored. These tests pin the
 * one reading the binder, the corkboard and the compile share, and that a project with parts (2 parts × 3 chapters × 2 scenes,
 * a prologue and an epilogue beside them) survives a folder save and a `.caotang` bundle unchanged.
 */

import { describe, expect, it } from 'vitest';
import {
  MemoryArtifactFs,
  addDocument,
  addFolder,
  createEmptyManifest,
  createProjectState,
  exportProjectZip,
  folderRole,
  importProjectZip,
  isPartFolder,
  isStructuralFolder,
  moveNode,
  partFolderIds,
  readProject,
  writeProject,
  type ProjectState,
} from '../src/index.js';

const NOW = new Date('2026-10-31T09:00:00.000Z');

function partsProject(): ProjectState {
  const state = createProjectState(createEmptyManifest('The Keeper in Two Parts', NOW));
  const prologue = addFolder(state, { parentId: 'manuscript', title: 'Prologue', now: NOW, id: 'n_PRE0000001' });
  addDocument(state, { parentId: prologue.id, title: 'Before', body: 'Before.', now: NOW });
  for (const [p, part] of ['Part One', 'Part Two'].entries()) {
    const folder = addFolder(state, { parentId: 'manuscript', title: part, now: NOW, id: `n_PART00000${p + 1}` });
    for (let c = 1; c <= 3; c += 1) {
      const chapter = addFolder(state, { parentId: folder.id, title: `Chapter ${p * 3 + c}`, now: NOW, id: `n_CHAPTER0${p}${c}` });
      for (const scene of ['a', 'b']) {
        addDocument(state, { parentId: chapter.id, title: `Scene ${p * 3 + c}${scene}`, body: `Scene ${p * 3 + c}${scene}.`, now: NOW });
      }
    }
  }
  const epilogue = addFolder(state, { parentId: 'manuscript', title: 'Epilogue', now: NOW, id: 'n_P0ST000001' });
  addDocument(state, { parentId: epilogue.id, title: 'After', body: 'After.', now: NOW });
  return state;
}

const shape = (state: ProjectState): string[] =>
  state.manifest.tree
    .map((node) => `${node.parentId ?? '-'}/${node.id}:${node.type}:${node.order}:${node.title}`)
    .sort();

describe('parts and chapters, read from the tree', () => {
  it('reads a folder that holds folders as a part, and every other folder as a chapter', () => {
    const state = partsProject();
    const tree = state.manifest.tree;
    expect([...partFolderIds(tree)].sort()).toEqual(['n_PART000001', 'n_PART000002']);
    expect(isPartFolder(tree, 'n_PART000001')).toBe(true);
    expect(isPartFolder(tree, 'n_CHAPTER011')).toBe(false);
    expect(folderRole(tree, 'n_PART000002')).toBe('part');
    expect(folderRole(tree, 'n_PRE0000001')).toBe('chapter');
  });

  it('never calls a fixed root or a document a part or a chapter', () => {
    const tree = partsProject().manifest.tree;
    expect(isPartFolder(tree, 'manuscript')).toBe(false);
    expect(folderRole(tree, 'manuscript')).toBeUndefined();
    const scene = tree.find((node) => node.type === 'document');
    expect(scene === undefined ? 'missing' : folderRole(tree, scene.id)).toBeUndefined();
  });

  it('does not count a storyboard: a chapter holding a scene and its storyboard is still a chapter', () => {
    const state = partsProject();
    const board = addFolder(state, { parentId: 'n_CHAPTER011', title: 'Scene 1a — Shots', now: NOW });
    board.kind = 'storyboard';
    expect(isStructuralFolder(board)).toBe(false);
    expect(folderRole(state.manifest.tree, 'n_CHAPTER011')).toBe('chapter');
  });

  it('follows the tree: moving the last chapter out makes a part a chapter again', () => {
    const state = partsProject();
    for (const id of ['n_CHAPTER001', 'n_CHAPTER002', 'n_CHAPTER003']) moveNode(state, id, { parentId: 'manuscript' });
    expect(folderRole(state.manifest.tree, 'n_PART000001')).toBe('chapter');
    expect(folderRole(state.manifest.tree, 'n_PART000002')).toBe('part');
  });
});

describe('a project with parts survives a reload and a bundle round trip', () => {
  it('reads back from a folder save with every folder where it was', async () => {
    const state = partsProject();
    const fs = new MemoryArtifactFs();
    await writeProject(fs, state, { now: NOW });
    const { state: reloaded, report } = await readProject(fs);
    expect(report.errors).toEqual([]);
    expect(shape(reloaded)).toEqual(shape(state));
    expect([...partFolderIds(reloaded.manifest.tree)].sort()).toEqual(['n_PART000001', 'n_PART000002']);
  });

  it('reads back from a .caotang bundle with every folder where it was', async () => {
    const state = partsProject();
    const zip = await exportProjectZip(state, { now: NOW });
    const imported = await importProjectZip(zip.bytes);
    const { state: reopened } = await readProject(imported.fs);
    expect(shape(reopened)).toEqual(shape(state));
  });
});
